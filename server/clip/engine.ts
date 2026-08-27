/**
 * Clip render engine — turns a candidate or moment into an mp4 on D:\Clips
 * (and optionally uploads it to Google Drive).
 *
 * Jobs are rows in `clip_jobs`; a single sequential worker drains the queue
 * so yt-dlp is never hammered. Progress is parsed from yt-dlp output and
 * persisted, so the UI can poll job status.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { extractVideoId } from "../clipsift";
import { clipJobs } from "@db/schema";
import { assertVerifiedClip, probeMedia } from "./mediaProbe";
import { LOCAL_GOOGLE_DRIVE_ROOT, syncFinishedFindClip } from "./localDriveSync";
import { CLIPS_DIR, FFMPEG_DIR, FFMPEG_PATH, YTDLP_PATH as YTDLP } from "../runtimePaths";
import { localVideoPathFromUrl } from "../transcriptStudio/exportPaths";
import { isPro } from "../license";

/** Free installs cap rendered clips at 720p; Pro renders up to the source. */
export const FREE_MAX_HEIGHT = 720;

// ── Toolchain (Cut IQ-owned defaults; env-overridable) ───────────────────
const RCLONE = process.env.RCLONE_PATH || "";
const DRIVE_ROOT = process.env.DRIVE_FOLDER || "ClipSift";
const TEMP_ROOT = join(CLIPS_DIR, ".clipsift-render-tmp");
const SOURCE_CACHE_ROOT = join(CLIPS_DIR, ".clipsift-source-cache");
// Optional shell command run when a batch of jobs finishes (message on stdin).
// This is an operator-configured integration, not a production dependency.
const NOTIFY_CMD = process.env.CLIPSIFT_NOTIFY_CMD || "";

export const clipConfig = { YTDLP, RCLONE, CLIPS_DIR, DRIVE_ROOT, LOCAL_GOOGLE_DRIVE_ROOT };

export function sanitize(name: string): string {
  return (
    name
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 120) || "clip"
  );
}

export function fmtClock(sec: number): string {
  // Transcript selections routinely contain fractional seconds.  Flooring here
  // makes yt-dlp render a longer section than the range we later verify.
  const totalMilliseconds = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1_000));
  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ms = totalMilliseconds % 1_000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Escape for a YouTube watch URL (validate + normalize). */
export function extractYouTubeUrl(sourceUrl: string): string {
  const videoId = extractVideoId(sourceUrl);
  if (!videoId) throw new Error("Only valid YouTube URLs can be clipped.");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Output folder for a project/moment clip batch. */
export function outputDirFor(project: string): string {
  const dir = join(CLIPS_DIR, sanitize(project));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A unique, contained scratch directory for one render job. */
function temporaryDirFor(jobId: number): string {
  const root = resolve(TEMP_ROOT);
  const dir = resolve(root, `job-${jobId}`);
  const pathFromRoot = relative(root, dir);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Could not resolve a safe temporary render directory.");
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Cleanup is deliberately constrained to one verified job directory. */
function cleanupTemporaryDir(dir: string): void {
  const root = resolve(TEMP_ROOT);
  const target = resolve(dir);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return;
  try { rmSync(target, { recursive: true, force: true }); } catch { /* a stale scratch file never fails the job */ }
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a binary, streaming stdout lines to onLine; resolves with exit info. */
function spawnStream(
  bin: string,
  args: string[],
  opts: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number; jobId?: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = execFile(bin, args, { cwd: opts.cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (opts.jobId != null) runningChildren.set(opts.jobId, child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      for (const line of d.toString().split("\n")) opts.onLine?.(line);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      for (const line of d.toString().split("\n")) opts.onLine?.(line);
    });
    child.on("error", (err) => {
      stderr += String(err);
      done(1);
    });
    child.on("close", (code) => {
      if (opts.jobId != null && runningChildren.get(opts.jobId) === child) runningChildren.delete(opts.jobId);
      done(code ?? 1);
    });
    if (opts.timeoutMs) setTimeout(() => terminateProcessTree(child), opts.timeoutMs);
  });
}

/** Terminate only a tracked render process tree; never constructs a shell command. */
function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.unref();
      return;
    } catch {
      // Fall through to Node's direct child handle if taskkill cannot start.
    }
  }
  try { child.kill(); } catch { /* process may already be gone */ }
}

/** Parse yt-dlp download progress line → percent (0..100) or null. */
export function parseYtDlpPercent(line: string): number | null {
  const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (!m) return null;
  return Math.min(100, Number(m[1]));
}

/**
 * Keep implementation diagnostics (including expiring signed URLs) out of the
 * persisted job error and therefore out of the Studio UI. The worker still
 * retains the original error in its process output while handling the job.
 */
export function publicRenderError(error: unknown): string {
  const diagnostic = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/\b403\b|forbidden|access denied|signature|expired/.test(diagnostic)) {
    return "YouTube rejected both Cut IQ download strategies. Open technical details for the client and HTTP failure, then retry.";
  }
  if (/private|unavailable|not found|login|required|region/.test(diagnostic)) {
    return "The source is no longer available for export. Confirm it is public and retry.";
  }
  if (/timeout|took too long/.test(diagnostic)) {
    return "The export took too long. Retry the clip when the connection is stable.";
  }
  if (/verification|ffprobe|audio|duration|resolution|empty/.test(diagnostic)) {
    return "The rendered file did not pass Cut IQ's local media verification. Retry the export.";
  }
  return "Cut IQ could not render this clip. Retry the export, or confirm the source is still available.";
}

/**
 * A newly extracted YouTube stream URL can occasionally be rejected by the
 * section-cutter before any media is written. A fresh yt-dlp process gets a
 * new stream URL, so one bounded retry is useful; other render errors should
 * remain visible instead of being retried blindly.
 */
export function isRetryableYouTubeStreamFailure(result: Pick<SpawnResult, "code" | "stdout" | "stderr">): boolean {
  if (result.code === 0) return false;
  return /\b403\b|forbidden|access denied|signature|expired/i.test(`${result.stdout}\n${result.stderr}`);
}

export function shouldUseLocalCutFallback(result: Pick<SpawnResult, "code">, outputExists: boolean): boolean {
  return result.code !== 0 || !outputExists;
}

export function sanitizedRenderDiagnostic(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error);
  return raw
    .replace(/https?:\/\/\S+/gi, "[signed media URL removed]")
    .replace(/[?&](?:sig|lsig|spc|pot|po_token)=[^\s&]+/gi, "$1=[removed]")
    .slice(0, 4_000);
}

export function buildSectionDownloadArgs(input: {
  temporaryDir: string;
  finalFile: string;
  url: string;
  format: string;
  editIn: number;
  editOut: number;
}): string[] {
  return [
    "--js-runtimes", "node",
    "--extractor-args", "youtube:player_client=web_embedded",
    "--ffmpeg-location", FFMPEG_DIR,
    "--force-keyframes-at-cuts",
    "--paths", `temp:${input.temporaryDir}`,
    "--download-sections", `*${fmtClock(input.editIn)}-${fmtClock(input.editOut)}`,
    "-f", input.format,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--newline",
    "--progress",
    "-o", input.finalFile,
    input.url,
  ];
}

export function buildFullSourceDownloadArgs(input: {
  temporaryDir: string;
  outputTemplate: string;
  url: string;
  format: string;
}): string[] {
  return [
    "--continue",
    "--force-ipv4",
    "--http-chunk-size", "5M",
    "--retries", "20",
    "--retry-sleep", "http:linear=2::10",
    "--js-runtimes", "node",
    "--extractor-args", "youtube:player_client=web_embedded",
    "--ffmpeg-location", FFMPEG_DIR,
    "--paths", `temp:${input.temporaryDir}`,
    "-f", input.format,
    "--merge-output-format", "mkv",
    "--no-playlist",
    "--newline",
    "--progress",
    "-o", input.outputTemplate,
    input.url,
  ];
}

// ── Queue ───────────────────────────────────────────────────────────────────

let running = false;
const runningChildren = new Map<number, ChildProcess>();
const cancellationRequested = new Set<number>();

async function mark(id: number, patch: Partial<typeof clipJobs.$inferInsert>): Promise<void> {
  try {
    const db = getDb();
    await db.update(clipJobs).set(patch as never).where(eq(clipJobs.id, id));
  } catch (err) {
    console.error("[clip-engine] mark failed:", err);
  }
}

/** Request cooperative termination of a currently running yt-dlp or rclone job. */
export async function cancelRunningJob(jobId: number): Promise<boolean> {
  cancellationRequested.add(jobId);
  const child = runningChildren.get(jobId);
  if (child) {
    terminateProcessTree(child);
  }
  await mark(jobId, { status: "cancelled", stage: "Cancelled", error: null });
  return Boolean(child);
}

/**
 * Enqueue a clip job. Accepts a full row shape minus status/progress fields.
 * Returns the created row.
 */
export async function enqueueClip(
  input: {
    kind: "candidate" | "moment";
    projectFk?: number | null;
    candidateFk?: number | null;
    momentFk?: number | null;
    videoFk?: number | null;
    sourceUrl: string;
    title: string;
    editIn: number;
    editOut: number;
    height?: number;
    minimumHeight?: number;
    uploadToDrive?: boolean;
  },
): Promise<typeof clipJobs.$inferSelect> {
  const db = getDb();
  // Free installs render up to 720p. Enforced here rather than at the router so
  // every path that queues a clip is covered, including the batch mutations.
  const requestedHeight = input.height ?? FREE_MAX_HEIGHT;
  const height = isPro() ? requestedHeight : Math.min(requestedHeight, FREE_MAX_HEIGHT);
  const [row] = await db
    .insert(clipJobs)
    .values({
      kind: input.kind,
      projectFk: input.projectFk ?? null,
      candidateFk: input.candidateFk ?? null,
      momentFk: input.momentFk ?? null,
      videoFk: input.videoFk ?? null,
      sourceUrl: input.sourceUrl,
      title: input.title,
      fileName: null,
      editIn: Math.max(0, input.editIn),
      editOut: Math.max(input.editIn + 0.5, input.editOut),
      height,
      minimumHeight: Math.min(input.minimumHeight ?? FREE_MAX_HEIGHT, height),
      uploadToDrive: input.uploadToDrive ?? false,
      status: "queued",
      progress: 0,
      stage: "queued",
    })
    .returning({ id: clipJobs.id });
  const id = Number(row.id);
  const [created] = await db.select().from(clipJobs).where(eq(clipJobs.id, id));
  void pump(); // kick the worker (non-blocking)
  return created!;
}

/** Drain the queue: one job at a time, oldest first. */
async function pump(): Promise<void> {
  if (running) return;
  running = true;
  // `batchStart` marks the lowest job id we began draining this cycle — used
  // to collect every job that finished as part of this batch for a single
  // "clips ready" notification.
  let batchStart = 0;
  try {
    const db = getDb();
    for (;;) {
      const [job] = await db
        .select()
        .from(clipJobs)
        .where(eq(clipJobs.status, "queued"))
        .orderBy(clipJobs.id)
        .limit(1);
      if (!job) break;
      if (!batchStart) batchStart = job.id;
      await renderJob(job.id);
    }
  } catch (err) {
    console.error("[clip-engine] pump error:", err);
  } finally {
    running = false;
    if (batchStart) await notifyBatchDone(batchStart);
  }
}

/**
 * When a batch of queued jobs finishes, fire the optional notify command
 * (for example, a locally configured notification command) so Art knows the
 * clips are ready to review / verify. Reads the finished jobs and hands a
 * summary to the command on stdin.
 */
async function notifyBatchDone(batchStart: number): Promise<void> {
  if (!NOTIFY_CMD.trim()) return;
  try {
    const db = getDb();
    const done = await db
      .select()
      .from(clipJobs)
      .where(gt(clipJobs.id, batchStart - 1))
      .orderBy(desc(clipJobs.id));
    // Only notify if at least one job in this batch actually completed
    // (ready / failed), so an empty / cancelled-only batch stays silent.
    const finished = done.filter((j) => j.status === "ready" || j.status === "failed");
    if (!finished.length) return;
    const ready = finished.filter((j) => j.status === "ready");
    const failed = finished.filter((j) => j.status === "failed");
    const lines = [
      `🎬 Cut IQ finished rendering ${finished.length} clip(s).`,
      `✅ Ready${ready.length ? ` (${ready.length})` : ""}:`,
      ...ready.map((j) => `   • ${j.title}  →  ${j.fileName ?? j.outputPath ?? "(local)"}`),
      ...(failed.length ? [`❌ Failed (${failed.length}):`, ...failed.map((j) => `   • ${j.title} — ${j.error?.slice(0, 120) ?? "unknown error"}`)] : []),
      `Review / export: http://localhost:3000/`,
    ];
    const msg = lines.join("\n");

    // Split the command into argv. Supports a simple shell-ish split.
    const argv = NOTIFY_CMD.trim().split(/\s+/);
    console.log("[clip-engine] notifying:", NOTIFY_CMD);
    const child = spawn(argv[0]!, argv.slice(1), { windowsHide: true });
    child.stdin?.write(msg);
    child.stdin?.end();
    child.on("error", (e) => console.error("[clip-engine] notify failed:", e.message));
    child.on("close", (code) => {
      if (code && code !== 0) console.error(`[clip-engine] notify exited ${code}`);
    });
  } catch (err) {
    console.error("[clip-engine] notifyBatchDone error:", err);
  }
}

/** Wake the worker if a job was re-queued externally (retry). */
export function wake(): void {
  void pump();
}

export function isCanonicalCachedSourceName(videoId: string, entry: string): boolean {
  const exactSource = new RegExp(`^${videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(mkv|mp4|webm)$`, "i");
  return exactSource.test(entry);
}

function cachedSourceFor(videoId: string): string | null {
  mkdirSync(SOURCE_CACHE_ROOT, { recursive: true });
  const name = readdirSync(SOURCE_CACHE_ROOT)
    .filter((entry) => {
      if (!isCanonicalCachedSourceName(videoId, entry)) return false;
      try {
        const file = statSync(join(SOURCE_CACHE_ROOT, entry));
        return file.isFile() && file.size > 0;
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const preferred = (value: string) => /\.mkv$/i.test(value) ? 3 : /\.mp4$/i.test(value) ? 2 : /\.webm$/i.test(value) ? 1 : 0;
      return preferred(b) - preferred(a);
    })[0];
  return name ? join(SOURCE_CACHE_ROOT, name) : null;
}

async function downloadSourceThenCut(input: {
  jobId: number;
  temporaryDir: string;
  finalFile: string;
  url: string;
  format: string;
  editIn: number;
  editOut: number;
  outDir: string;
}): Promise<SpawnResult> {
  const videoId = extractVideoId(input.url);
  if (!videoId) return { code: 1, stdout: "", stderr: "Could not resolve a canonical video id for the local-cut fallback." };
  let sourceFile = cachedSourceFor(videoId);
  let downloadDiagnostic = "";
  if (!sourceFile) {
    await mark(input.jobId, { progress: 3, stage: "Direct section stream refused; downloading reusable source" });
    const sourceTemplate = join(SOURCE_CACHE_ROOT, `${videoId}.%(ext)s`);
    const sourceDownload = await spawnStream(
      YTDLP,
      buildFullSourceDownloadArgs({ temporaryDir: input.temporaryDir, outputTemplate: sourceTemplate, url: input.url, format: input.format }),
      {
        cwd: input.outDir,
        onLine: (line) => {
          const pct = parseYtDlpPercent(line);
          if (pct != null) void mark(input.jobId, { progress: Math.max(3, Math.min(52, 3 + pct * 0.49)), stage: "Downloading reusable source with yt-dlp" });
          else if (/Merging formats/i.test(line)) void mark(input.jobId, { stage: "Merging reusable source" });
        },
        timeoutMs: 40 * 60_000,
        jobId: input.jobId,
      },
    );
    downloadDiagnostic = sourceDownload.stderr;
    if (sourceDownload.code !== 0) return sourceDownload;
    sourceFile = cachedSourceFor(videoId);
  }
  if (!sourceFile || !existsSync(sourceFile)) {
    return { code: 1, stdout: "", stderr: `${downloadDiagnostic}\nNative yt-dlp completed without a reusable source file.`.trim() };
  }

  return cutSourceFile({
    jobId: input.jobId,
    sourceFile,
    finalFile: input.finalFile,
    editIn: input.editIn,
    editOut: input.editOut,
    outDir: input.outDir,
  });
}

async function cutSourceFile(input: {
  jobId: number;
  sourceFile: string;
  finalFile: string;
  editIn: number;
  editOut: number;
  outDir: string;
}): Promise<SpawnResult> {
  await mark(input.jobId, { progress: 55, stage: "Cutting cached source locally with Cut IQ FFmpeg" });
  const duration = Math.max(0.1, input.editOut - input.editIn);
  return spawnStream(
    FFMPEG_PATH,
    [
      "-y",
      "-ss", fmtClock(input.editIn),
      "-i", input.sourceFile,
      "-t", duration.toFixed(3),
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "mpeg4",
      "-q:v", "2",
      "-c:a", "aac",
      "-movflags", "+faststart",
      input.finalFile,
    ],
    { cwd: input.outDir, timeoutMs: 20 * 60_000, jobId: input.jobId },
  );
}

async function renderJob(jobId: number): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(clipJobs).where(eq(clipJobs.id, jobId));
  if (!job || job.status !== "queued") return;

  let temporaryDir: string | null = null;
  try {
    const localSource = localVideoPathFromUrl(job.sourceUrl);
    const url = localSource ? job.sourceUrl : extractYouTubeUrl(job.sourceUrl);
    const reuseScope = job.projectFk != null
      ? eq(clipJobs.projectFk, job.projectFk)
      : job.videoFk != null
        ? eq(clipJobs.videoFk, job.videoFk)
        : eq(clipJobs.id, -1);
    const [reusable] = await db
      .select()
      .from(clipJobs)
      .where(and(
        reuseScope,
        eq(clipJobs.sourceUrl, job.sourceUrl),
        eq(clipJobs.editIn, job.editIn),
        eq(clipJobs.editOut, job.editOut),
        eq(clipJobs.status, "ready"),
      ))
      .orderBy(asc(clipJobs.id))
      .limit(1);
    if (reusable?.outputPath && existsSync(reusable.outputPath) && (!job.uploadToDrive || reusable.drivePath)) {
      const probe = await probeMedia(reusable.outputPath);
      assertVerifiedClip(probe, job.editOut - job.editIn, job.minimumHeight ?? 720);
      let drivePath = job.uploadToDrive ? reusable.drivePath : null;
      let stage = `Reused verified source range from clip #${reusable.id}`;
      if (job.uploadToDrive && job.kind === "candidate" && job.projectFk != null) {
        try {
          const synced = await syncFinishedFindClip({ projectId: Number(job.projectFk), sourcePath: reusable.outputPath });
          if (synced) {
            drivePath = synced;
            stage = `${stage} • synced to My Drive`;
          }
        } catch (syncError) {
          console.error(`[clip-engine] job ${jobId} local Drive sync failed:`, syncError);
          stage = `${stage} • My Drive sync needs attention`;
        }
      }
      await mark(jobId, {
        status: "ready",
        progress: 100,
        stage,
        fileName: reusable.fileName,
        outputPath: reusable.outputPath,
        fileSizeBytes: statSync(reusable.outputPath).size,
        outputWidth: probe.width,
        outputHeight: probe.height,
        outputDurationSec: probe.durationSec,
        outputHasAudio: probe.hasAudio,
        drivePath,
        error: null,
        diagnosticError: null,
      });
      return;
    }
    const outDir = outputDirFor(job.projectFk ? `project-${job.projectFk}` : job.videoFk ? `video-${job.videoFk}` : "single-video");
    temporaryDir = temporaryDirFor(jobId);
    const outFile = join(outDir, `${sanitize(job.title)}.mp4`);
    // avoid clobbering: append -2, -3…
    let finalFile = outFile;
    for (let i = 2; existsSync(finalFile) && i < 100; i++) finalFile = join(outDir, `${sanitize(job.title)}-${i}.mp4`);

    const fmt = job.height > 0 ? `bv*[height<=${job.height}]+ba/b[height<=${job.height}]` : "bv*+ba/b";
    const videoId = localSource ? null : extractVideoId(url);
    const reusableSource = localSource ?? (videoId ? cachedSourceFor(videoId) : null);
    await mark(jobId, {
      status: "downloading",
      progress: 2,
      stage: reusableSource
        ? "Using reusable local source"
        : "Requesting YouTube section with web-embedded client",
      diagnosticError: null,
    });

    const localCut = () => localSource
      ? cutSourceFile({ jobId, sourceFile: localSource, finalFile, editIn: job.editIn, editOut: job.editOut, outDir })
      : downloadSourceThenCut({
          jobId,
          temporaryDir: temporaryDir!,
          finalFile,
          url,
          format: fmt,
          editIn: job.editIn,
          editOut: job.editOut,
          outDir,
        });
    const directSection = () => spawnStream(YTDLP, buildSectionDownloadArgs({
      temporaryDir: temporaryDir!,
      finalFile,
      url,
      format: fmt,
      editIn: job.editIn,
      editOut: job.editOut,
    }), {
      cwd: outDir,
      onLine: (line) => {
        const pct = parseYtDlpPercent(line);
        if (pct != null) void mark(jobId, { progress: Math.max(2, Math.min(70, 2 + pct * 0.68)), stage: "Downloading and cutting with web-embedded client" });
        else if (/Merging formats/i.test(line)) void mark(jobId, { stage: "Merging audio + video" });
      },
      timeoutMs: 20 * 60_000,
      jobId,
    });
    // A verified full-game download is a reusable pipeline asset. Cut it
    // locally before asking YouTube for another expiring section URL.
    let direct = reusableSource
      ? null
      : await directSection();
    let dl = reusableSource
      ? await localCut()
      : direct!;

    // A corrupt or incompatible YouTube cache entry must not strand the job.
    // Registered file: sources are intentionally local-only, but cached
    // YouTube sources retain the normal online section fallback.
    if (reusableSource && !localSource && shouldUseLocalCutFallback(dl, existsSync(finalFile)) && !cancellationRequested.has(jobId)) {
      try { rmSync(finalFile, { force: true }); } catch { /* failed output may not exist */ }
      await mark(jobId, { progress: 2, stage: "Local source was unusable; retrying YouTube section" });
      direct = await directSection();
      dl = direct;
    }

    // Some videos prohibit embedded playback, and YouTube can reject a direct
    // FFmpeg CDN section URL even though yt-dlp's native downloader is allowed.
    // In either case, download one reusable source through yt-dlp and cut it
    // locally. This also becomes the shared media cache for later jobs.
    if (!reusableSource && direct && shouldUseLocalCutFallback(direct, existsSync(finalFile)) && !cancellationRequested.has(jobId)) {
      const fallback = await localCut();
      dl = fallback.code === 0 && existsSync(finalFile)
        ? fallback
        : {
            code: fallback.code || direct.code || 1,
            stdout: `${direct.stdout}\n${fallback.stdout}`,
            stderr: `web-embedded section attempt:\n${direct.stderr}\n\nnative download/local-cut fallback:\n${fallback.stderr}`,
          };
    }

    if (cancellationRequested.has(jobId)) {
      await mark(jobId, { status: "cancelled", stage: "Cancelled", error: null });
      return;
    }

    if (dl.code !== 0 || !existsSync(finalFile)) {
      throw new Error((dl.stderr.trim() || `media pipeline exit ${dl.code}`).slice(0, 4_000));
    }

    const size = statSync(finalFile).size;
    if (size <= 0) throw new Error("The exported file is empty.");
    await mark(jobId, { progress: 73, stage: "Verifying exported media" });
    let probe = await probeMedia(finalFile);
    try {
      assertVerifiedClip(probe, job.editOut - job.editIn, job.minimumHeight ?? 720);
    } catch (cacheVerificationError) {
      if (!reusableSource || localSource || direct || cancellationRequested.has(jobId)) throw cacheVerificationError;
      try { rmSync(finalFile, { force: true }); } catch { /* constrained to the new job output */ }
      await mark(jobId, { progress: 2, stage: "Cached cut failed verification; retrying YouTube section" });
      direct = await directSection();
      if (direct.code !== 0 || !existsSync(finalFile)) {
        throw new Error((direct.stderr.trim() || `media pipeline exit ${direct.code}`).slice(0, 4_000));
      }
      probe = await probeMedia(finalFile);
      assertVerifiedClip(probe, job.editOut - job.editIn, job.minimumHeight ?? 720);
    }
    if (cancellationRequested.has(jobId)) {
      await mark(jobId, { status: "cancelled", stage: "Cancelled", error: null });
      return;
    }
    await mark(jobId, {
      progress: 75,
      stage: "Verified local export",
      fileSizeBytes: size,
      fileName: finalFile.split(/[\\/]/).pop() ?? null,
      outputPath: finalFile,
      outputWidth: probe.width,
      outputHeight: probe.height,
      outputDurationSec: probe.durationSec,
      outputHasAudio: probe.hasAudio,
    });

    let localDrivePath: string | null = null;
    let localDriveSyncFailed = false;
    if (job.uploadToDrive && job.kind === "candidate" && job.projectFk != null) {
      await mark(jobId, { progress: 78, stage: "Copying finished MP4 to Google Drive desktop" });
      try {
        localDrivePath = await syncFinishedFindClip({
          projectId: Number(job.projectFk),
          sourcePath: finalFile,
        });
        if (localDrivePath) await mark(jobId, { progress: 82, stage: "Synced finished MP4 to My Drive", drivePath: localDrivePath });
      } catch (syncError) {
        localDriveSyncFailed = true;
        console.error(`[clip-engine] job ${jobId} local Drive sync failed:`, syncError);
      }
    }

    if (job.uploadToDrive) {
      await mark(jobId, { status: "uploading", progress: 80, stage: "Uploading to Google Drive" });
      const driveDir = `${DRIVE_ROOT}/${job.projectFk ? `project-${job.projectFk}` : job.videoFk ? `video-${job.videoFk}` : "single-video"}`;
      const mk = await spawnStream(RCLONE, ["mkdir", `gdrive:${driveDir}`], { cwd: outDir, timeoutMs: 60_000, jobId });
      if (mk.code !== 0) {
        await mark(jobId, {
          status: "ready",
          progress: 100,
          stage: "Saved locally; Drive upload failed",
          error: "The local export is saved, but Google Drive upload failed. You can retry the job when Drive is available.",
        });
        return;
      }
      const cp = await spawnStream(RCLONE, ["copy", finalFile, `gdrive:${driveDir}/`], { cwd: outDir, timeoutMs: 10 * 60_000, jobId });
      if (cancellationRequested.has(jobId)) {
        await mark(jobId, { status: "cancelled", stage: "Cancelled", error: null });
        return;
      }
      if (cp.code !== 0) {
        await mark(jobId, {
          status: "ready",
          progress: 100,
          stage: "Saved locally; Drive upload failed",
          error: "The local export is saved, but Google Drive upload failed. You can retry the job when Drive is available.",
        });
        return;
      }
      await mark(jobId, { progress: 95, stage: "Uploaded to Google Drive", drivePath: `${driveDir}/${finalFile.split(/[\\/]/).pop()}` });
    }

    await mark(jobId, {
      status: "ready",
      progress: 100,
      stage: localDrivePath
        ? "Done • synced to My Drive"
        : localDriveSyncFailed
          ? "Done • My Drive sync needs attention"
          : "Done",
      drivePath: localDrivePath ?? undefined,
    });
  } catch (err) {
    if (cancellationRequested.has(jobId)) {
      await mark(jobId, { status: "cancelled", stage: "Cancelled", error: null });
    } else {
      const diagnosticError = sanitizedRenderDiagnostic(err);
      console.error(`[clip-engine] job ${jobId} failed:`, diagnosticError);
      await mark(jobId, { status: "failed", error: publicRenderError(err), diagnosticError, stage: "Failed" });
    }
  } finally {
    runningChildren.delete(jobId);
    cancellationRequested.delete(jobId);
    if (temporaryDir) cleanupTemporaryDir(temporaryDir);
  }
}

/**
 * Recover interrupted work on server start. A restart is not a media failure:
 * active jobs return to the durable queue and the existing queued work remains
 * queued. renderJob always uses an isolated scratch directory and a new output
 * name, so replaying the operation is safe.
 */
export async function recoverStaleJobs(): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(clipJobs)
      .set({ status: "queued", progress: 0, error: null, stage: "Recovered after restart — queued" })
      .where(inArray(clipJobs.status, ["downloading", "uploading"]));
    wake();
  } catch (err) {
    console.error("[clip-engine] recoverStaleJobs:", err);
  }
}
