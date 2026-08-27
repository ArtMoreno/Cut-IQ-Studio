import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  videos,
  transcriptSegments,
  moments,
  projects,
  searchHistory,
} from "@db/schema";
import { extractVideoId, fetchVideoMeta } from "./clipsift";
import { getTranscriptProvider } from "./transcript/youtubeProvider";
import { TranscriptError, type RawSegment, type TranscriptResult } from "./transcript/provider";
import { fetchLocalWhisperTranscript } from "./transcript/localWhisperProvider";
import { parseImportedTranscript } from "./transcript/importParsers";
import { isRetryableYouTubeStreamFailure } from "./clip/engine";
import { execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CLIPS_DIR, FFMPEG_DIR, YTDLP_PATH as YTDLP } from "./runtimePaths";

// ── Clip export toolchain (local PC; override via env) ──────────────
const RCLONE = process.env.RCLONE_PATH || "";
const DRIVE_ROOT = process.env.DRIVE_FOLDER || "ClipSift";

function sanitize(name: string): string {
  return (
    name
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 60) || "clip"
  );
}

/** seconds → "HH:MM:SS.mmm" for yt-dlp --download-sections */
function fmtClock(sec: number): string {
  const totalMilliseconds = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1_000));
  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ms = totalMilliseconds % 1_000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 10 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function replaceSegments(videoFk: number, segs: RawSegment[]) {
  const db = getDb();
  await db.delete(transcriptSegments).where(eq(transcriptSegments.videoFk, videoFk));
  if (segs.length) {
    await db.insert(transcriptSegments).values(
      segs.map((s, i) => ({ videoFk, idx: i, text: s.text, start: s.start, end: s.end })),
    );
  }
}

async function getSegments(videoFk: number) {
  return getDb()
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.videoFk, videoFk))
    .orderBy(transcriptSegments.idx);
}

function normalizeTerm(s: string) {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type TranscriptAcquisitionDeps = {
  captions: (videoId: string, lang?: string) => Promise<TranscriptResult>;
  local: (videoId: string, lang?: string, jobId?: string) => Promise<TranscriptResult>;
};

const defaultTranscriptAcquisitionDeps: TranscriptAcquisitionDeps = {
  captions: (videoId, lang) => getTranscriptProvider().fetchTranscript(videoId, lang),
  local: fetchLocalWhisperTranscript,
};

/**
 * Prefer captions and invoke the device-local transcription fallback only
 * after the provider has positively reported that captions do not exist.
 * Network, privacy, and rate-limit conditions stay visible instead of turning
 * into an unnecessary media download.
 */
export async function acquireTranscript(
  videoId: string,
  language?: string,
  jobId?: string,
  deps: TranscriptAcquisitionDeps = defaultTranscriptAcquisitionDeps,
): Promise<TranscriptResult> {
  try {
    return await deps.captions(videoId, language);
  } catch (captionError) {
    const typedCaptionError =
      captionError instanceof TranscriptError
        ? captionError
        : new TranscriptError("PROVIDER", "YouTube captions could not be retrieved.");
    if (typedCaptionError.code !== "NO_TRANSCRIPT") throw typedCaptionError;
  }

  try {
    return await deps.local(videoId, language, jobId);
  } catch (localError) {
    const typedLocalError =
      localError instanceof TranscriptError
        ? localError
        : new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "Local transcription failed.");
    if (typedLocalError.code === "LOCAL_TRANSCRIPTION_CANCELLED") throw typedLocalError;
    const message = typedLocalError.code === "LOCAL_TRANSCRIPTION_UNAVAILABLE"
      ? "No YouTube captions are available, and the local Whisper fallback is unavailable on this PC. Import a timestamped transcript instead."
      : "No YouTube captions are available, and the local Whisper fallback could not finish. Retry or import a timestamped transcript instead.";
    throw new TranscriptError("NO_TRANSCRIPT", message);
  }
}

export const clipsiftRouter = createRouter({
  loadVideo: publicQuery
    .input(
      z.object({
        url: z.string().min(1),
        lang: z.string().optional(),
        refresh: z.boolean().optional(),
        jobId: z.string().min(8).max(128).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const videoId = extractVideoId(input.url);
      if (!videoId) {
        return { ok: false as const, code: "BAD_URL", message: "That doesn't look like a YouTube URL. Paste a watch, Shorts, live, or youtu.be link." };
      }
      const canonical = `https://www.youtube.com/watch?v=${videoId}`;
      let [video] = await db.select().from(videos).where(eq(videos.videoId, videoId));

      const needTranscript = input.refresh || !video || video.transcriptKind === "none" || !!input.lang;

      if (!video) {
        const meta = await fetchVideoMeta(videoId);
        const [inserted] = await db
          .insert(videos)
          .values({ videoId, url: canonical, title: meta.title, channel: meta.channel, thumbnail: meta.thumbnail, status: "ok" })
          .returning({ id: videos.id });
        [video] = await db.select().from(videos).where(eq(videos.id, inserted.id));
      } else {
        await db.update(videos).set({ lastOpenedAt: new Date() }).where(eq(videos.id, video.id));
        if (!video.title) {
          const meta = await fetchVideoMeta(videoId);
          if (meta.title) {
            await db.update(videos).set(meta).where(eq(videos.id, video.id));
            video = { ...video, ...meta };
          }
        }
      }

      let transcriptError: { code: string; message: string } | null = null;
      if (needTranscript) {
        try {
          const result = await acquireTranscript(videoId, input.lang, input.jobId);
          await replaceSegments(video.id, result.segments);
          await db
            .update(videos)
            .set({
              transcriptLang: result.lang,
              transcriptKind: result.kind,
              status: "ok",
              errorMessage: null,
              retrievedAt: new Date(),
            })
            .where(eq(videos.id, video.id));
          video = { ...video, transcriptLang: result.lang, transcriptKind: result.kind, status: "ok", errorMessage: null };
        } catch (err) {
          const te =
            err instanceof TranscriptError
              ? err
              : new TranscriptError("PROVIDER", err instanceof Error ? err.message : String(err));
          const status = te.code === "NO_TRANSCRIPT" ? "no_transcript" : "error";
          await db.update(videos).set({ status, errorMessage: te.message }).where(eq(videos.id, video.id));
          video = { ...video, status, errorMessage: te.message };
          transcriptError = { code: te.code, message: te.message };
        }
      }

      const segments = await getSegments(video.id);
      return { ok: true as const, video, segments, transcriptError };
    }),

  importTranscript: publicQuery
    .input(
      z.object({
        videoDbId: z.number(),
        format: z.enum(["srt", "vtt", "text"]),
        content: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [video] = await db.select().from(videos).where(eq(videos.id, input.videoDbId));
      if (!video) throw new Error("Video not found.");
      const segs = parseImportedTranscript(input.format, input.content);
      await replaceSegments(video.id, segs);
      await db
        .update(videos)
        .set({ transcriptKind: "imported", transcriptLang: "import", status: "ok", errorMessage: null, retrievedAt: new Date() })
        .where(eq(videos.id, video.id));
      return { ok: true as const, count: segs.length, segments: await getSegments(video.id) };
    }),

  search: publicQuery
    .input(z.object({ videoDbId: z.number(), query: z.string().min(1) }))
    .query(async ({ input }) => {
      const segs = await getSegments(input.videoDbId);
      const q = input.query.trim();
      const phraseMatch = q.match(/^"([^"]+)"$/);
      const terms: string[] = phraseMatch
        ? [normalizeTerm(phraseMatch[1])]
        : normalizeTerm(q).split(" ").filter(Boolean);
      const isPhrase = !!phraseMatch;

      const matches = segs.filter((s) => {
        const norm = normalizeTerm(s.text);
        if (isPhrase) return norm.includes(terms[0]);
        return terms.every((t) => norm.includes(t));
      });

      // Suggestions: frequent words in transcript (3+ chars, not stopwords)
      return {
        count: matches.length,
        matches: matches.map((m, i) => {
          const prev = segs.find((s) => s.idx === m.idx - 1);
          const next = segs.find((s) => s.idx === m.idx + 1);
          return {
            resultIdx: i,
            segmentId: m.id,
            idx: m.idx,
            text: m.text,
            start: m.start,
            end: m.end,
            context: [prev?.text, next?.text].filter(Boolean).join(" … "),
          };
        }),
      };
    }),

  suggestions: publicQuery
    .input(z.object({ videoDbId: z.number(), prefix: z.string().min(1) }))
    .query(async ({ input }) => {
      const segs = await getSegments(input.videoDbId);
      const freq = new Map<string, number>();
      for (const s of segs) {
        for (const w of normalizeTerm(s.text).split(" ")) {
          if (w.length >= 3) freq.set(w, (freq.get(w) ?? 0) + 1);
        }
      }
      const p = normalizeTerm(input.prefix);
      return [...freq.entries()]
        .filter(([w]) => w.startsWith(p))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([w]) => w);
    }),

  recordSearch: publicQuery
    .input(z.object({ videoDbId: z.number(), query: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(searchHistory).values({ videoFk: input.videoDbId, query: input.query });
      return { ok: true };
    }),

  recentSearches: publicQuery
    .input(z.object({ videoDbId: z.number() }))
    .query(async ({ input }) => {
      const rows = await getDb()
        .select()
        .from(searchHistory)
        .where(eq(searchHistory.videoFk, input.videoDbId))
        .orderBy(desc(searchHistory.id))
        .limit(10);
      return [...new Set(rows.map((r) => r.query))];
    }),

  // ---- Moments ----
  listMoments: publicQuery
    .input(z.object({ videoDbId: z.number() }))
    .query(({ input }) =>
      getDb().select().from(moments).where(eq(moments.videoFk, input.videoDbId)).orderBy(moments.start),
    ),

  saveMoment: publicQuery
    .input(
      z.object({
        videoDbId: z.number(),
        title: z.string().min(1),
        start: z.number(),
        end: z.number().optional(),
        note: z.string().optional(),
        excerpt: z.string().optional(),
        color: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [r] = await db
        .insert(moments)
        .values({
          videoFk: input.videoDbId,
          title: input.title,
          start: input.start,
          end: input.end ?? null,
          note: input.note ?? null,
          excerpt: input.excerpt ?? null,
          color: input.color ?? "amber",
        })
        .returning({ id: moments.id });
      const [row] = await db.select().from(moments).where(eq(moments.id, r.id));
      return row;
    }),

  updateMoment: publicQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().optional(),
        note: z.string().optional(),
        color: z.string().optional(),
        status: z.enum(["candidate", "selected", "used"]).optional(),
        start: z.number().optional(),
        end: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      await getDb().update(moments).set(patch).where(eq(moments.id, id));
      return { ok: true };
    }),

  deleteMoment: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await getDb().delete(moments).where(eq(moments.id, input.id));
      return { ok: true };
    }),

  // ---- Library ----
  library: publicQuery
    .input(
      z.object({
        filter: z.enum(["all", "recent", "favorites", "archived"]).default("all"),
        projectId: z.number().optional(),
        sort: z.enum(["recent", "added", "title"]).default("recent"),
      })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(videos).orderBy(desc(videos.lastOpenedAt));
      let out = rows;
      const f = input?.filter ?? "all";
      if (f === "favorites") out = out.filter((v) => v.favorite && !v.archived);
      else if (f === "archived") out = out.filter((v) => v.archived);
      else if (f === "recent") out = out.filter((v) => !v.archived).slice(0, 20);
      else out = out.filter((v) => !v.archived);
      if (input?.projectId) out = out.filter((v) => v.projectId === input.projectId);
      if (input?.sort === "title") out = [...out].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
      if (input?.sort === "added") out = [...out].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      return out;
    }),

  openVideo: publicQuery
    .input(z.object({ videoDbId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(videos).set({ lastOpenedAt: new Date(), archived: false }).where(eq(videos.id, input.videoDbId));
      const [video] = await db.select().from(videos).where(eq(videos.id, input.videoDbId));
      return { video, segments: await getSegments(input.videoDbId) };
    }),

  updateVideo: publicQuery
    .input(
      z.object({
        id: z.number(),
        favorite: z.boolean().optional(),
        archived: z.boolean().optional(),
        projectId: z.number().nullable().optional(),
        lastPosition: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      await getDb().update(videos).set(patch).where(eq(videos.id, id));
      return { ok: true };
    }),

  deleteVideo: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(transcriptSegments).where(eq(transcriptSegments.videoFk, input.id));
      await db.delete(moments).where(eq(moments.videoFk, input.id));
      await db.delete(searchHistory).where(eq(searchHistory.videoFk, input.id));
      await db.delete(videos).where(eq(videos.id, input.id));
      return { ok: true };
    }),

  // ---- Projects ----
  listProjects: publicQuery.query(() => getDb().select().from(projects).orderBy(projects.name)),
  createProject: publicQuery
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const [r] = await getDb().insert(projects).values({ name: input.name }).returning({ id: projects.id });
      const [row] = await getDb().select().from(projects).where(eq(projects.id, r.id));
      return row;
    }),
  renameProject: publicQuery
    .input(z.object({ id: z.number(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await getDb().update(projects).set({ name: input.name }).where(eq(projects.id, input.id));
      return { ok: true };
    }),
  deleteProject: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(videos).set({ projectId: null }).where(eq(videos.projectId, input.id));
      await db.delete(projects).where(eq(projects.id, input.id));
      return { ok: true };
    }),

  // ---- Clip export (yt-dlp cut → D:\Clips → optional Google Drive) ----
  exportClips: publicQuery
    .input(
      z.object({
        videoDbId: z.number(),
        momentIds: z.array(z.number()).optional(), // default: all moments for the video
        upload: z.boolean().default(false), // Google Drive is always explicit opt-in
        project: z.string().optional(), // subfolder under D:\Clips and gdrive:ClipSift/
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [video] = await db.select().from(videos).where(eq(videos.id, input.videoDbId));
      if (!video) throw new Error("Video not found.");

      let list = await db
        .select()
        .from(moments)
        .where(eq(moments.videoFk, input.videoDbId))
        .orderBy(moments.start);
      const wantIds = input.momentIds;
      if (wantIds?.length) list = list.filter((m) => wantIds.includes(m.id));
      if (!list.length) return { ok: false as const, message: "No moments to export.", results: [] };

      if (!existsSync(YTDLP)) {
        return { ok: false as const, message: `yt-dlp not found at ${YTDLP}`, results: [] };
      }
      if (input.upload && (!RCLONE || !existsSync(RCLONE))) {
        return { ok: false as const, message: "Google Drive export is not configured.", results: [] };
      }

      const project = sanitize(input.project ?? video.title ?? "clips");
      const outDir = join(CLIPS_DIR, project);
      mkdirSync(outDir, { recursive: true });

      const results: Array<{
        ok: boolean;
        name: string;
        error?: string | null;
        localPath?: string;
        drivePath?: string | null;
        seconds?: number;
      }> = [];

      for (const [i, m] of list.entries()) {
        const start = Math.max(0, m.start);
        const end = m.end != null && m.end > start ? m.end : start + 3;
        const name = `${String(i + 1).padStart(2, "0")}_${sanitize(m.title)}`;
        const outFile = join(outDir, `${name}.mp4`);

        const downloadArgs = [
            "--js-runtimes", "node",
            "--extractor-args", "youtube:player_client=web_embedded",
            "--ffmpeg-location", FFMPEG_DIR,
            "--force-keyframes-at-cuts",
            "--download-sections", `*${fmtClock(start)}-${fmtClock(end)}`,
            "-f", "bv*[height<=720]+ba/b[height<=720]",
            "--merge-output-format", "mp4",
            "--no-playlist",
            "--no-progress",
            "--quiet",
            "-o", outFile,
            video.url,
          ];
        let dl = await run(YTDLP, downloadArgs, { cwd: outDir });
        // This legacy export endpoint has no job UI, but it deserves the same
        // one-time fresh-stream recovery as the queued renderer.
        if (isRetryableYouTubeStreamFailure(dl) && !existsSync(outFile)) {
          await waitFor(2_000);
          dl = await run(YTDLP, downloadArgs, { cwd: outDir });
        }
        if (dl.code !== 0 || !existsSync(outFile)) {
          results.push({ ok: false, name: `${name}.mp4`, error: (dl.stderr.trim() || `yt-dlp exit ${dl.code}`).slice(0, 300) });
          continue;
        }

        let drivePath: string | null = null;
        if (input.upload) {
          const driveDir = `${DRIVE_ROOT}/${project}`;
          await run(RCLONE, ["mkdir", `gdrive:${driveDir}`], { cwd: outDir, timeout: 60_000 });
          const cp = await run(RCLONE, ["copy", outFile, `gdrive:${driveDir}/`], { cwd: outDir, timeout: 5 * 60_000 });
          if (cp.code !== 0) {
            results.push({ ok: false, name: `${name}.mp4`, error: `rclone: ${(cp.stderr.trim() || `exit ${cp.code}`).slice(0, 300)}` });
            continue;
          }
          drivePath = `${driveDir}/${name}.mp4`;
        }

        results.push({ ok: true, name: `${name}.mp4`, localPath: outFile, drivePath, seconds: Math.round(end - start) });
      }

      const failed = results.filter((r) => !r.ok).length;
      return { ok: failed === 0, failed, total: results.length, outDir, project, results };
    }),
});
