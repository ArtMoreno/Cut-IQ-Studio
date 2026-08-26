/**
 * Clip router — render candidates/moments to mp4 (D:\Clips, optional Drive),
 * list jobs with live progress, retry/cancel.
 */
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { createRouter, proProcedure, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { clipCandidates, clipJobs, findJobs, moments, scriptBeats, videos } from "@db/schema";
import { cancelRunningJob, enqueueClip, clipConfig, recoverStaleJobs, wake } from "./clip/engine";
import { playerHighlightCandidateIsCanonical } from "./findClips/engine";

export const clipRouter = createRouter({
  // Render one script-project candidate to mp4.
  renderCandidate: publicQuery
    .input(
      z.object({
        candidateId: z.number(),
        uploadToDrive: z.boolean().default(false),
        height: z.number().int().min(0).max(2160).default(720), // 0 = best
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [cand] = await db.select().from(clipCandidates).where(eq(clipCandidates.id, input.candidateId));
      if (!cand) throw new Error("Candidate not found.");
      if (cand.editIn == null || cand.editOut == null) {
        throw new Error("This candidate has no edit range (editIn/editOut) — review it first.");
      }
      const [video] = cand.videoFk ? await db.select().from(videos).where(eq(videos.id, cand.videoFk)) : [];
      const sourceUrl = video?.url ?? cand.sourceUrl;
      const job = await enqueueClip({
        kind: "candidate",
        projectFk: cand.projectFk,
        candidateFk: cand.id,
        videoFk: cand.videoFk ?? null,
        sourceUrl,
        title: candidateClipName(cand.title ?? cand.sourceUrl, cand.editIn),
        editIn: cand.editIn,
        editOut: cand.editOut,
        height: input.height,
        uploadToDrive: input.uploadToDrive,
      });
      return { ok: true, jobId: job.id };
    }),

  // Render one single-video moment to mp4.
  renderMoment: publicQuery
    .input(
      z.object({
        momentId: z.number(),
        uploadToDrive: z.boolean().default(false),
        height: z.number().int().min(0).max(2160).default(720),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [mom] = await db.select().from(moments).where(eq(moments.id, input.momentId));
      if (!mom) throw new Error("Moment not found.");
      const [video] = await db.select().from(videos).where(eq(videos.id, mom.videoFk));
      if (!video) throw new Error("Moment's video is missing from the library.");
      const start = Math.max(0, mom.start);
      const end = mom.end != null && mom.end > start ? mom.end : start + 3;
      const job = await enqueueClip({
        kind: "moment",
        momentFk: mom.id,
        videoFk: video.id,
        sourceUrl: video.url,
        title: momentClipName(mom.title, start),
        editIn: start,
        editOut: end,
        height: input.height,
        uploadToDrive: input.uploadToDrive,
      });
      return { ok: true, jobId: job.id };
    }),

  // Render every eligible candidate of a project (all, or only approved).
  // Pro: renders every candidate in a project in one pass. Single-clip renders
  // stay free, so the free tier is a working tool rather than a demo.
  renderProject: proProcedure
    .input(
      z.object({
        projectId: z.number(),
        onlyApproved: z.boolean().default(false),
        uploadToDrive: z.boolean().default(false),
        height: z.number().int().min(0).max(2160).default(720),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const cands = await db.select().from(clipCandidates).where(eq(clipCandidates.projectFk, input.projectId));
      const [findJob] = await db.select().from(findJobs).where(eq(findJobs.projectFk, input.projectId)).limit(1);
      const playerPlays = findJob
        ? cands.filter((candidate) => playerHighlightCandidateIsCanonical(candidate, findJob.player))
        : cands.filter((candidate) => candidate.reason?.startsWith("Player-action play sequence"));
      const canonicalCandidates = playerPlays.length ? playerPlays : cands;
      const eligible = canonicalCandidates.filter(
        (c) =>
          c.editIn != null &&
          c.editOut != null &&
          (input.onlyApproved ? c.state === "approved" : true),
      );
      const jobs = [];
      for (const cand of eligible) {
        const [video] = cand.videoFk ? await db.select().from(videos).where(eq(videos.id, cand.videoFk)) : [];
        const job = await enqueueClip({
          kind: "candidate",
          projectFk: cand.projectFk,
          candidateFk: cand.id,
          videoFk: cand.videoFk ?? null,
          sourceUrl: video?.url ?? cand.sourceUrl,
          title: candidateClipName(cand.title ?? cand.sourceUrl, cand.editIn!),
          editIn: cand.editIn!,
          editOut: cand.editOut!,
          height: input.height,
          uploadToDrive: input.uploadToDrive,
        });
        jobs.push(job.id);
      }
      return { ok: true, total: eligible.length, jobIds: jobs };
    }),

  // Render every moment of a video (used by Single Video mode export-all).
  // Pro: batch-renders every saved moment on a video.
  renderVideoMoments: proProcedure
    .input(
      z.object({
        videoDbId: z.number(),
        momentIds: z.array(z.number()).optional(),
        uploadToDrive: z.boolean().default(false),
        height: z.number().int().min(0).max(2160).default(720),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [video] = await db.select().from(videos).where(eq(videos.id, input.videoDbId));
      if (!video) throw new Error("Video not found.");
      let list = await db.select().from(moments).where(eq(moments.videoFk, input.videoDbId)).orderBy(moments.start);
      if (input.momentIds?.length) list = list.filter((m) => input.momentIds!.includes(m.id));
      const jobs = [];
      for (const mom of list) {
        const start = Math.max(0, mom.start);
        const end = mom.end != null && mom.end > start ? mom.end : start + 3;
        const job = await enqueueClip({
          kind: "moment",
          momentFk: mom.id,
          videoFk: video.id,
          sourceUrl: video.url,
          title: momentClipName(mom.title, start),
          editIn: start,
          editOut: end,
          height: input.height,
          uploadToDrive: input.uploadToDrive,
        });
        jobs.push(job.id);
      }
      return { ok: true, total: list.length, jobIds: jobs };
    }),

  listJobs: publicQuery
    .input(
      z
        .object({
          projectFk: z.number().optional(),
          videoFk: z.number().optional(),
          candidateFk: z.number().optional(),
          momentFk: z.number().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const [projectFindJob] = input?.projectFk
        ? await db.select().from(findJobs).where(eq(findJobs.projectFk, input.projectFk)).limit(1)
        : [];
      const q = db.select().from(clipJobs).orderBy(desc(clipJobs.id)).limit(input?.limit ?? 50);
      // drizzle where with optional filters
      const conds = [];
      if (input?.projectFk) conds.push(eq(clipJobs.projectFk, input.projectFk));
      if (input?.videoFk) conds.push(eq(clipJobs.videoFk, input.videoFk));
      if (input?.candidateFk) conds.push(eq(clipJobs.candidateFk, input.candidateFk));
      if (input?.momentFk) conds.push(eq(clipJobs.momentFk, input.momentFk));
      const rows = conds.length ? await db.select().from(clipJobs).where(conds[0]!).orderBy(desc(clipJobs.id)).limit(input?.limit ?? 50) : await q;
      const candidateIds = rows.map((row) => Number(row.candidateFk)).filter(Boolean);
      const candidates = candidateIds.length
        ? await db.select().from(clipCandidates).where(inArray(clipCandidates.id, candidateIds))
        : [];
      const beatIds = [...new Set(candidates.map((candidate) => Number(candidate.beatFk)).filter(Boolean))];
      const beats = beatIds.length
        ? await db.select().from(scriptBeats).where(inArray(scriptBeats.id, beatIds))
        : [];
      const candidatesById = new Map(candidates.map((candidate) => [Number(candidate.id), candidate]));
      const beatsById = new Map(beats.map((beat) => [Number(beat.id), beat]));
      return rows.map((job) => {
        const candidate = job.candidateFk ? candidatesById.get(Number(job.candidateFk)) : null;
        const beat = candidate ? beatsById.get(Number(candidate.beatFk)) : null;
        return {
          ...jobView(job),
          contextLabel: beat ? `Beat ${beat.ord + 1}: ${beat.text}` : null,
          sourceTitle: candidate?.title ?? job.title,
          selectionKind: candidate?.reason?.startsWith("Player-action play sequence")
            ? (projectFindJob && playerHighlightCandidateIsCanonical(candidate, projectFindJob.player) ? "player_play" as const : "mention_match" as const)
            : candidate?.reason?.startsWith("Caption-first transcript match")
              ? "mention_match" as const
              : null,
        };
      });
    }),

  job: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const [job] = await db.select().from(clipJobs).where(eq(clipJobs.id, input.id));
    return job ? jobView(job) : null;
  }),

  retry: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const [job] = await db.select().from(clipJobs).where(eq(clipJobs.id, input.id));
    if (!job) throw new Error("Job not found.");
    if (job.status === "queued") throw new Error("Job is already queued.");
    if (job.status === "downloading" || job.status === "uploading") throw new Error("Job is still running.");
    await db
      .update(clipJobs)
      .set({
        status: "queued", progress: 0, stage: "queued", error: null, diagnosticError: null,
        fileName: null, outputPath: null, drivePath: null, fileSizeBytes: null,
        outputWidth: null, outputHeight: null, outputDurationSec: null, outputHasAudio: null,
      })
      .where(eq(clipJobs.id, input.id));
    wake();
    return { ok: true };
  }),

  cancel: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const [job] = await db.select().from(clipJobs).where(eq(clipJobs.id, input.id));
    if (!job) throw new Error("Job not found.");
    if (job.status === "queued") {
      await db
        .update(clipJobs)
        .set({ status: "cancelled", stage: "Cancelled" })
        .where(eq(clipJobs.id, input.id));
      return { ok: true, running: false };
    }
    if (job.status === "downloading" || job.status === "uploading") {
      const running = await cancelRunningJob(input.id);
      return { ok: true, running };
    }
    throw new Error("Only queued or running jobs can be cancelled.");
  }),

  requeueWithRange: publicQuery
    .input(
      z.object({
        id: z.number(),
        editIn: z.number().min(0).max(6 * 60 * 60),
        editOut: z.number().min(0).max(6 * 60 * 60),
      }).refine((value) => value.editOut > value.editIn + 0.05, {
        message: "Out must be after In.",
        path: ["editOut"],
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [job] = await db.select().from(clipJobs).where(eq(clipJobs.id, input.id));
      if (!job) throw new Error("Clip job not found.");
      if (job.status === "downloading" || job.status === "uploading") {
        throw new Error("Wait for the active export to finish or cancel it before changing its range.");
      }

      let title = job.title;
      if (job.candidateFk) {
        const [candidate] = await db.select().from(clipCandidates).where(eq(clipCandidates.id, job.candidateFk));
        if (!candidate) throw new Error("The source project clip is missing.");
        await db.update(clipCandidates).set({ editIn: input.editIn, editOut: input.editOut }).where(eq(clipCandidates.id, candidate.id));
        title = candidateClipName(candidate.title ?? candidate.sourceUrl, input.editIn);
      } else if (job.momentFk) {
        const [moment] = await db.select().from(moments).where(eq(moments.id, job.momentFk));
        if (!moment) throw new Error("The source saved clip is missing.");
        await db.update(moments).set({ start: input.editIn, end: input.editOut }).where(eq(moments.id, moment.id));
        title = momentClipName(moment.title, input.editIn);
      }

      if (job.status === "queued") {
        await db.update(clipJobs).set({ status: "cancelled", stage: "Replaced by edited range" }).where(eq(clipJobs.id, job.id));
      }
      const replacement = await enqueueClip({
        kind: job.kind,
        projectFk: job.projectFk,
        candidateFk: job.candidateFk,
        momentFk: job.momentFk,
        videoFk: job.videoFk,
        sourceUrl: job.sourceUrl,
        title,
        editIn: input.editIn,
        editOut: input.editOut,
        height: job.height,
        uploadToDrive: job.uploadToDrive,
      });
      return { ok: true, jobId: Number(replacement.id) };
    }),

  config: publicQuery.query(async () => {
    await recoverStaleJobs().catch(() => undefined);
    return {
      clipsDir: clipConfig.CLIPS_DIR,
      driveRoot: clipConfig.DRIVE_ROOT,
      localGoogleDriveRoot: clipConfig.LOCAL_GOOGLE_DRIVE_ROOT,
      ytdlp: clipConfig.YTDLP,
      rclone: clipConfig.RCLONE,
    };
  }),
});

// ── helpers ──────────────────────────────────────────────────────────────────

function candidateClipName(title: string | null, editIn: number): string {
  const base = sanitizeTitle(title ?? "clip");
  return `${base}-${clock(editIn)}`;
}

function momentClipName(title: string, start: number): string {
  return `${sanitizeTitle(title)}-${clock(start)}`;
}

function sanitizeTitle(t: string): string {
  return (
    t
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "clip"
  );
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}${String(r).padStart(2, "0")}`;
}

export type JobView = ReturnType<typeof jobView>;

function jobView(j: typeof clipJobs.$inferSelect) {
  return {
    id: Number(j.id),
    kind: j.kind,
    projectFk: j.projectFk ? Number(j.projectFk) : null,
    candidateFk: j.candidateFk ? Number(j.candidateFk) : null,
    momentFk: j.momentFk ? Number(j.momentFk) : null,
    videoFk: j.videoFk ? Number(j.videoFk) : null,
    sourceUrl: j.sourceUrl,
    title: j.title,
    fileName: j.fileName,
    editIn: j.editIn,
    editOut: j.editOut,
    height: j.height,
    uploadToDrive: j.uploadToDrive,
    status: j.status,
    progress: j.progress,
    stage: j.stage,
    outputPath: j.outputPath,
    fileSizeBytes: j.fileSizeBytes,
    outputWidth: j.outputWidth,
    outputHeight: j.outputHeight,
    outputDurationSec: j.outputDurationSec,
    outputHasAudio: j.outputHasAudio,
    drivePath: j.drivePath,
    error: j.error,
    diagnosticError: j.diagnosticError,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    // download URL for the finished clip (works on desktop AND phone via tailnet).
    // Files live in subfolders under CLIPS_DIR (project-<id> / video-<id> / single-video),
    // so the URL must carry the relative path — a bare fileName 404s.
    downloadUrl: j.outputPath
      ? `/api/clips/${encodeURIComponent(relativeTo(j.outputPath, clipConfig.CLIPS_DIR))}`
      : j.fileName
        ? `/api/clips/${encodeURIComponent(j.fileName)}`
        : null,
    // human file size
    sizeLabel: j.fileSizeBytes != null ? fmtSize(j.fileSizeBytes) : null,
  };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Relative path of an output file under CLIPS_DIR, for /api/clips/* URLs. */
function relativeTo(fullPath: string, root: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(fullPath);
  const r = norm(root);
  if (f.startsWith(`${r}/`)) return f.slice(r.length + 1);
  // Fallback: last two segments (folder/file) so old backslash rows still resolve.
  const parts = f.split("/");
  return parts.slice(-2).join("/");
}
