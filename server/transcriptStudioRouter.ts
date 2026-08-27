import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  transcriptSegments,
  transcriptStudioExports,
  transcriptStudioSegmentEdits,
  transcriptStudioSessions,
  videos,
} from "@db/schema";
import {
  cancelSourceInspection,
  inspectYouTubeSource,
} from "./transcriptStudio/sourceInspector";
import { cancelLocalWhisperTranscript } from "./transcript/localWhisperProvider";
import { probeMedia } from "./clip/mediaProbe";
import { transcribeVoiceover } from "./assemble/voiceover";
import { canonicalLocalVideoPath, canonicalWindowsDirectory, localSourceTitle } from "./transcriptStudio/exportPaths";
import { pickLocalVideo, pickOutputDirectory } from "./transcriptStudio/desktopPicker";
import {
  cancelStudioExport,
  clearStudioExportCancellation,
  studioExportFingerprint,
  studioExportView,
  wakeStudioExportWorker,
  type StudioExportItem,
} from "./transcriptStudio/exportEngine";
import { CLIPS_DIR } from "./runtimePaths";

const DEFAULT_STUDIO_OUTPUT_DIR = join(CLIPS_DIR, "Manual Clip Studio");

const sessionInput = z.object({
  videoDbId: z.number().int().positive(),
  searchQuery: z.string().max(512).optional(),
  inPoint: z.number().finite().min(0).nullable().optional(),
  outPoint: z.number().finite().min(0).nullable().optional(),
  clipQueue: z.unknown().optional(),
  sourceHeight: z.number().int().min(1).max(4320).nullable().optional(),
  sourceDurationSec: z.number().finite().min(0).max(24 * 60 * 60).nullable().optional(),
});

export const transcriptStudioRouter = createRouter({
  /** Validate and inspect the actual source before caption retrieval begins. */
  inspectSource: publicQuery
    .input(z.object({ url: z.string().min(1).max(4096), jobId: z.string().min(8).max(128) }))
    .mutation(({ input }) => inspectYouTubeSource(input.url, input.jobId)),

  cancelSourceJob: publicQuery
    .input(z.object({ jobId: z.string().min(8).max(128) }))
    .mutation(({ input }) => {
      const inspectionCancelled = cancelSourceInspection(input.jobId);
      const transcriptionCancelled = cancelLocalWhisperTranscript(input.jobId);
      return { ok: inspectionCancelled || transcriptionCancelled };
    }),

  getSession: publicQuery
    .input(z.object({ videoDbId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const [session] = await getDb()
        .select()
        .from(transcriptStudioSessions)
        .where(eq(transcriptStudioSessions.videoFk, input.videoDbId));
      return { session: session ? sessionView(session) : null };
    }),

  saveSession: publicQuery.input(sessionInput).mutation(async ({ input }) => {
    const db = getDb();
    const [video] = await db.select().from(videos).where(eq(videos.id, input.videoDbId));
    if (!video) throw new Error("The loaded video is no longer in the Cut IQ library.");

    const [previous] = await db
      .select()
      .from(transcriptStudioSessions)
      .where(eq(transcriptStudioSessions.videoFk, input.videoDbId));
    const queue = input.clipQueue === undefined ? previous?.clipQueue ?? null : serializeQueue(input.clipQueue);
    const nextIn = input.inPoint === undefined ? previous?.inPoint ?? null : input.inPoint;
    const nextOut = input.outPoint === undefined ? previous?.outPoint ?? null : input.outPoint;
    const nextDuration = input.sourceDurationSec === undefined
      ? previous?.sourceDurationSec ?? video.durationSec ?? null
      : input.sourceDurationSec;
    assertValidStoredRange(nextIn, nextOut, nextDuration);

    const transcriptProviderVersion = video.transcriptKind === "local-whisper"
      ? "local-whisper-base:v1"
      : video.transcriptKind === "imported"
        ? "imported:v1"
        : "youtube-captions:v1";
    const cacheKey = `${video.videoId}:${video.transcriptLang ?? "und"}:${transcriptProviderVersion}`;
    const values = {
      searchQuery: input.searchQuery === undefined ? previous?.searchQuery ?? "" : input.searchQuery.trim(),
      inPoint: nextIn,
      outPoint: nextOut,
      clipQueue: queue,
      sourceHeight: input.sourceHeight === undefined ? previous?.sourceHeight ?? null : input.sourceHeight,
      sourceDurationSec: nextDuration,
      transcriptCacheKey: cacheKey,
    };
    if (previous) {
      await db.update(transcriptStudioSessions).set(values).where(eq(transcriptStudioSessions.videoFk, input.videoDbId));
    } else {
      await db.insert(transcriptStudioSessions).values({ videoFk: input.videoDbId, ...values });
    }
    if (input.sourceDurationSec != null && (!video.durationSec || video.durationSec !== input.sourceDurationSec)) {
      await db.update(videos).set({ durationSec: Math.round(input.sourceDurationSec) }).where(eq(videos.id, input.videoDbId));
    }
    const [saved] = await db.select().from(transcriptStudioSessions).where(eq(transcriptStudioSessions.videoFk, input.videoDbId));
    return { ok: true, session: saved ? sessionView(saved) : null };
  }),

  listEdits: publicQuery
    .input(z.object({ videoDbId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const edits = await getDb()
        .select()
        .from(transcriptStudioSegmentEdits)
        .where(eq(transcriptStudioSegmentEdits.videoFk, input.videoDbId))
        .orderBy(transcriptStudioSegmentEdits.segmentIdx);
      return edits.map((edit) => ({
        id: Number(edit.id),
        segmentIdx: edit.segmentIdx,
        originalText: edit.originalText,
        displayText: edit.displayText,
        updatedAt: edit.updatedAt,
      }));
    }),

  saveSegmentEdit: publicQuery
    .input(z.object({
      videoDbId: z.number().int().positive(),
      segmentIdx: z.number().int().min(0),
      originalText: z.string().min(1).max(20_000),
      displayText: z.string().max(20_000),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const [source] = await db
        .select()
        .from(transcriptSegments)
        .where(and(eq(transcriptSegments.videoFk, input.videoDbId), eq(transcriptSegments.idx, input.segmentIdx)));
      if (!source) throw new Error("That transcript segment no longer exists. Refresh the video before editing it.");
      if (source.text !== input.originalText) {
        throw new Error("The source transcript changed. Refresh Transcript Studio before saving this edit.");
      }
      const displayText = input.displayText.replace(/\s+/g, " ").trim();
      const [existing] = await db
        .select()
        .from(transcriptStudioSegmentEdits)
        .where(and(
          eq(transcriptStudioSegmentEdits.videoFk, input.videoDbId),
          eq(transcriptStudioSegmentEdits.segmentIdx, input.segmentIdx),
        ));
      if (displayText === input.originalText) {
        if (existing) await db.delete(transcriptStudioSegmentEdits).where(eq(transcriptStudioSegmentEdits.id, existing.id));
        return { ok: true, edit: null };
      }
      if (existing) {
        await db
          .update(transcriptStudioSegmentEdits)
          .set({ displayText })
          .where(eq(transcriptStudioSegmentEdits.id, existing.id));
      } else {
        await db.insert(transcriptStudioSegmentEdits).values({
          videoFk: input.videoDbId,
          segmentIdx: input.segmentIdx,
          originalText: input.originalText,
          displayText,
        });
      }
      const [saved] = await db
        .select()
        .from(transcriptStudioSegmentEdits)
        .where(and(
          eq(transcriptStudioSegmentEdits.videoFk, input.videoDbId),
          eq(transcriptStudioSegmentEdits.segmentIdx, input.segmentIdx),
        ));
      return { ok: true, edit: saved ? { id: Number(saved.id), segmentIdx: saved.segmentIdx, originalText: saved.originalText, displayText: saved.displayText } : null };
    }),

  resetSegment: publicQuery
    .input(z.object({ videoDbId: z.number().int().positive(), segmentIdx: z.number().int().min(0) }))
    .mutation(async ({ input }) => {
      await getDb()
        .delete(transcriptStudioSegmentEdits)
        .where(and(
          eq(transcriptStudioSegmentEdits.videoFk, input.videoDbId),
          eq(transcriptStudioSegmentEdits.segmentIdx, input.segmentIdx),
        ));
      return { ok: true };
    }),

  /**
   * Create one durable Studio-owned export. This legacy-shaped mutation stays
   * available to older clients but never writes moments or shared clip_jobs.
   */
  queueClip: publicQuery
    .input(z.object({
      videoDbId: z.number().int().positive(),
      label: z.string().min(1).max(255),
      inPoint: z.number().finite().min(0),
      outPoint: z.number().finite().min(0),
      outputDir: z.string().min(3).max(2048).optional(),
      uploadToDrive: z.boolean().default(false), // accepted for old clients; manual exports are local paths
    }))
    .mutation(async ({ input }) => {
      void input.uploadToDrive;
      const item = {
        draftId: studioExportFingerprint(input.videoDbId, [{ draftId: "single", label: input.label, inPoint: input.inPoint, outPoint: input.outPoint }]),
        label: input.label,
        inPoint: input.inPoint,
        outPoint: input.outPoint,
      };
      const queued = await queueStudioExport({
        videoDbId: input.videoDbId,
        title: input.label,
        mode: "separate",
        outputDir: input.outputDir,
        items: [item],
      });
      return { ok: true, exportId: queued.id, jobId: queued.id, outputDir: queued.outputDir };
    }),

  /** Queue selected drafts as separate MP4s or one joined MP4, preserving input order. */
  queueExport: publicQuery
    .input(z.object({
      videoDbId: z.number().int().positive(),
      mode: z.enum(["separate", "joined"]),
      title: z.string().min(1).max(255),
      outputDir: z.string().min(3).max(2048).optional(),
      items: z.array(z.object({
        draftId: z.string().min(1).max(120),
        label: z.string().min(1).max(255),
        inPoint: z.number().finite().min(0),
        outPoint: z.number().finite().min(0),
      })).min(1).max(100),
    }))
    .mutation(async ({ input }) => {
      const record = await queueStudioExport(input);
      return { ok: true, export: studioExportView(record) };
    }),

  listExports: publicQuery
    .input(z.object({ videoDbId: z.number().int().positive(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ input }) => {
      const rows = await getDb()
        .select()
        .from(transcriptStudioExports)
        .where(eq(transcriptStudioExports.videoFk, input.videoDbId))
        .orderBy(desc(transcriptStudioExports.id))
        .limit(input.limit);
      return rows.map(studioExportView);
    }),

  exportJob: publicQuery
    .input(z.object({ exportId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const [record] = await getDb().select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, input.exportId));
      return record ? studioExportView(record) : null;
    }),

  cancelExport: publicQuery
    .input(z.object({ exportId: z.number().int().positive() }))
    .mutation(async ({ input }) => ({ ok: await cancelStudioExport(input.exportId) })),

  retryExport: publicQuery
    .input(z.object({ exportId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const [record] = await db.select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, input.exportId));
      if (!record) throw new Error("Manual export not found.");
      if (!["failed", "cancelled"].includes(record.status)) throw new Error("Only failed or cancelled exports can be retried.");
      await db.update(transcriptStudioExports).set({
        status: "queued", progress: 0, stage: "Queued", outputPaths: null, outputPath: null, error: null,
      }).where(eq(transcriptStudioExports.id, record.id));
      clearStudioExportCancellation(Number(record.id));
      wakeStudioExportWorker();
      return { ok: true };
    }),

  /** Open only a completed Studio export or its containing folder. */
  openOutput: publicQuery
    .input(z.object({
      exportId: z.number().int().positive(),
      target: z.enum(["file", "folder"]),
      draftId: z.string().min(1).max(120).optional(),
      outputIndex: z.number().int().min(0).max(99).optional(),
    }))
    .mutation(async ({ input }) => {
      const [record] = await getDb().select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, input.exportId));
      if (!record || record.status !== "ready") {
        throw new Error("This export is not available locally yet.");
      }
      const view = studioExportView(record);
      let output = view.outputPath ?? view.outputPaths[0];
      if (record.mode === "separate" && (input.draftId != null || input.outputIndex != null)) {
        const index = input.draftId != null
          ? view.items.findIndex((item) => item.draftId === input.draftId)
          : input.outputIndex!;
        if (index < 0 || index >= view.outputPaths.length) throw new Error("That clip is not part of this completed export.");
        output = view.outputPaths[index];
      }
      if (!output || !existsSync(output)) throw new Error("This exported file has been moved or deleted.");
      // `rundll32` asks Windows to open the actual local file with the user's
      // associated player without routing user-controlled text through a shell.
      const opened = input.target === "file"
        ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", pathToFileURL(output).href], { detached: true, stdio: "ignore", windowsHide: true })
        : spawn("explorer.exe", [dirname(output)], { detached: true, stdio: "ignore", windowsHide: true });
      opened.unref();
      return { ok: true };
    }),

  chooseLocalVideo: publicQuery.mutation(async () => ({ path: await pickLocalVideo() })),

  chooseOutputDirectory: publicQuery.mutation(async () => ({ path: await pickOutputDirectory() })),

  registerLocalSource: publicQuery
    .input(z.object({
      path: z.string().min(3).max(4096),
      transcribe: z.boolean().default(true),
      refreshTranscript: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => registerLocalSource(input)),

  outputConfig: publicQuery.query(() => {
    return { outputDir: canonicalWindowsDirectory(DEFAULT_STUDIO_OUTPUT_DIR, true), supportsArbitraryWindowsPath: true };
  }),
});

function sessionView(session: typeof transcriptStudioSessions.$inferSelect) {
  return {
    videoFk: session.videoFk,
    searchQuery: session.searchQuery,
    inPoint: session.inPoint,
    outPoint: session.outPoint,
    clipQueue: parseQueue(session.clipQueue),
    sourceHeight: session.sourceHeight,
    sourceDurationSec: session.sourceDurationSec,
    updatedAt: session.updatedAt,
  };
}

function serializeQueue(value: unknown): string | null {
  if (value == null) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("The clip queue could not be saved.");
  }
  if (encoded.length > 120_000) throw new Error("The clip queue is too large to save.");
  return encoded;
}

function parseQueue(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assertValidStoredRange(inPoint: number | null, outPoint: number | null, duration: number | null): void {
  if (inPoint == null || outPoint == null) return;
  assertExportRange(inPoint, outPoint, duration);
}

function assertExportRange(inPoint: number, outPoint: number, duration: number | null): void {
  if (!(inPoint >= 0 && outPoint > inPoint)) throw new Error("Set an Out point after the In point before exporting.");
  if (duration != null && duration > 0 && outPoint > duration + 0.05) {
    throw new Error("The Out point is beyond the source duration.");
  }
}

function cleanLabel(label: string): string {
  const withoutControls = [...label].map((character) => character.charCodeAt(0) <= 31 ? " " : character).join("");
  const text = withoutControls.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 180) || "Clip";
}

async function queueStudioExport(input: {
  videoDbId: number;
  mode: "separate" | "joined";
  title: string;
  outputDir?: string;
  items: StudioExportItem[];
}) {
  const db = getDb();
  const [video] = await db.select().from(videos).where(eq(videos.id, input.videoDbId));
  if (!video) throw new Error("The loaded Studio video no longer exists.");
  if (!input.items.length || input.items.length > 100) throw new Error("Choose between 1 and 100 clips to export.");

  let duration = video.durationSec;
  if ((!duration || duration <= 0) && !video.url.startsWith("file:")) {
    const inspected = await inspectYouTubeSource(video.url, `studio-${Date.now()}`);
    duration = inspected.durationSec ? Math.round(inspected.durationSec) : null;
    if (duration) await db.update(videos).set({ durationSec: duration }).where(eq(videos.id, video.id));
  }
  const items = input.items.map((item, index) => {
    assertExportRange(item.inPoint, item.outPoint, duration);
    return {
      draftId: String(item.draftId || `clip-${index + 1}`).slice(0, 120),
      label: cleanLabel(item.label),
      inPoint: item.inPoint,
      outPoint: item.outPoint,
    };
  });
  const outputDir = canonicalWindowsDirectory(input.outputDir || DEFAULT_STUDIO_OUTPUT_DIR, true);
  const title = cleanLabel(input.title || `${video.title ?? "Video"} clips`);
  const [inserted] = await db.insert(transcriptStudioExports).values({
    videoFk: video.id,
    mode: input.mode,
    title,
    items: JSON.stringify(items),
    outputDir,
    status: "queued",
    progress: 0,
    stage: "Queued",
  }).returning({ id: transcriptStudioExports.id });
  const [record] = await db.select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, inserted.id));
  if (!record) throw new Error("Cut IQ could not create the manual export.");
  wakeStudioExportWorker();
  return record;
}

async function registerLocalSource(input: { path: string; transcribe: boolean; refreshTranscript: boolean }) {
  const db = getDb();
  const path = canonicalLocalVideoPath(input.path);
  const file = statSync(path);
  const probe = await probeMedia(path);
  const fingerprint = createHash("sha256")
    .update(`${path.toLowerCase()}\n${file.size}\n${file.mtimeMs}`)
    .digest("hex");
  const videoId = `local-${fingerprint.slice(0, 26)}`;
  const sourceUrl = pathToFileURL(path).href;
  let [video] = await db.select().from(videos).where(eq(videos.videoId, videoId));
  if (!video) {
    const [inserted] = await db.insert(videos).values({
      videoId,
      url: sourceUrl,
      title: localSourceTitle(path),
      channel: "Local file",
      durationSec: Math.round(probe.durationSec),
      transcriptKind: "none",
      status: "ok",
    }).returning({ id: videos.id });
    [video] = await db.select().from(videos).where(eq(videos.id, inserted.id));
  } else {
    await db.update(videos).set({
      url: sourceUrl,
      title: localSourceTitle(path),
      durationSec: Math.round(probe.durationSec),
      lastOpenedAt: new Date(),
    }).where(eq(videos.id, video.id));
  }
  if (!video) throw new Error("Cut IQ could not register the local video.");

  let transcriptError: { code: string; message: string } | null = null;
  const existingSegments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.videoFk, video.id));
  if (input.transcribe && (input.refreshTranscript || !existingSegments.length)) {
    try {
      const result = await transcribeVoiceover(path);
      await db.delete(transcriptSegments).where(eq(transcriptSegments.videoFk, video.id));
      await db.insert(transcriptSegments).values(result.segments.map((segment, idx) => ({
        videoFk: video!.id,
        idx,
        text: segment.text,
        start: segment.start,
        end: segment.end,
      })));
      await db.update(videos).set({
        transcriptLang: result.lang,
        transcriptKind: "local-whisper",
        status: "ok",
        errorMessage: null,
        retrievedAt: new Date(),
      }).where(eq(videos.id, video.id));
    } catch (error) {
      console.error("[studio-local-source] transcription failed:", error);
      const message = "Cut IQ could not transcribe this local video. You can still clip it manually or retry transcription.";
      transcriptError = { code: "LOCAL_TRANSCRIPTION_FAILED", message };
      await db.update(videos).set({ status: "no_transcript", errorMessage: message }).where(eq(videos.id, video.id));
    }
  }

  const [freshVideo] = await db.select().from(videos).where(eq(videos.id, video.id));
  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.videoFk, video.id))
    .orderBy(transcriptSegments.idx);
  const mediaUrl = `/api/studio-media/${video.id}`;
  return {
    ok: true as const,
    video: freshVideo ?? video,
    segments,
    transcriptError,
    sourceKind: "local" as const,
    mediaUrl,
    source: {
      videoId,
      canonicalUrl: sourceUrl,
      title: freshVideo?.title ?? video.title,
      channel: "Local file",
      thumbnail: null,
      durationSec: probe.durationSec,
      sourceHeight: probe.height,
      availableHeights: [probe.height],
      recommendedHeight: probe.height >= 1080 ? 1080 : probe.height >= 720 ? 720 : null,
      isLive: false,
      mediaUrl,
    },
    probe,
  };
}
