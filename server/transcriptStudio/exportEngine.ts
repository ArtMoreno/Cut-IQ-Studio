import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { transcriptStudioExports, videos } from "@db/schema";
import { getDb } from "../queries/connection";
import { extractVideoId } from "../clipsift";
import { FFMPEG_DIR, FFMPEG_PATH, YTDLP_PATH } from "../runtimePaths";
import { probeMedia } from "../clip/mediaProbe";
import { canonicalWindowsDirectory, localVideoPathFromUrl, safeStudioFileStem, uniqueMp4Path } from "./exportPaths";

const STUDIO_TEMP_ROOT = resolve(process.env.CLIPSIFT_STUDIO_TEMP_ROOT || "D:/Clips/.clipsift-studio-tmp");
const STUDIO_SOURCE_CACHE = resolve(process.env.CLIPSIFT_STUDIO_SOURCE_CACHE || "D:/Clips/.clipsift-studio-source-cache");

export type StudioExportItem = {
  draftId: string;
  label: string;
  inPoint: number;
  outPoint: number;
};

export type StudioExportMode = "separate" | "joined";

let running = false;
let wakeRequested = false;
const activeChildren = new Map<number, ChildProcess>();
const cancellations = new Set<number>();
const cancellationEpochs = new Map<number, number>();

function isCancelled(exportId: number, attemptEpoch: number): boolean {
  return cancellations.has(exportId) || (cancellationEpochs.get(exportId) ?? 0) !== attemptEpoch;
}

function exportItems(raw: string): StudioExportItem[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("The saved export selection is unreadable."); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100) {
    throw new Error("Choose between 1 and 100 clips to export.");
  }
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Clip ${index + 1} is invalid.`);
    const value = item as Partial<StudioExportItem>;
    const inPoint = Number(value.inPoint);
    const outPoint = Number(value.outPoint);
    if (!Number.isFinite(inPoint) || !Number.isFinite(outPoint) || inPoint < 0 || outPoint <= inPoint + 0.05) {
      throw new Error(`Clip ${index + 1} needs an Out point after its In point.`);
    }
    return {
      draftId: String(value.draftId ?? `clip-${index + 1}`).slice(0, 120),
      label: safeStudioFileStem(String(value.label ?? `Clip ${index + 1}`)),
      inPoint,
      outPoint,
    };
  });
}

async function mark(id: number, patch: Partial<typeof transcriptStudioExports.$inferInsert>): Promise<void> {
  await getDb().update(transcriptStudioExports).set(patch).where(eq(transcriptStudioExports.id, id));
}

type ProcessResult = { code: number; stdout: string; stderr: string };

function runProcess(
  exportId: number,
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; onLine?: (line: string) => void },
): Promise<ProcessResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.set(exportId, child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeChildren.get(exportId) === child) activeChildren.delete(exportId);
      done({ code, stdout, stderr });
    };
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout = `${stdout}${text}`.slice(-16_000);
      else stderr = `${stderr}${text}`.slice(-16_000);
      text.split(/\r?\n/).forEach((line) => options.onLine?.(line));
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-16_000);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timeout = setTimeout(() => {
      terminate(child);
      finish(1);
    }, options.timeoutMs);
  });
}

function terminate(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill();
}

function studioJobDirectory(id: number): string {
  return join(STUDIO_TEMP_ROOT, `export-${id}-${randomUUID()}`);
}

function cachedYouTubeSource(videoId: string): string | null {
  if (!existsSync(STUDIO_SOURCE_CACHE)) return null;
  const entry = readdirSync(STUDIO_SOURCE_CACHE)
    .filter((name) => name.startsWith(`${videoId}.`) && !name.endsWith(".part") && !name.endsWith(".ytdl"))
    .sort()[0];
  return entry ? join(STUDIO_SOURCE_CACHE, entry) : null;
}

function parseDownloadPercent(line: string): number | null {
  const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  return match ? Math.min(100, Number(match[1])) : null;
}

async function prepareSource(exportId: number, sourceUrl: string, jobDir: string, attemptEpoch: number): Promise<string> {
  const localPath = localVideoPathFromUrl(sourceUrl);
  if (localPath) return localPath;

  const videoId = extractVideoId(sourceUrl);
  if (!videoId) throw new Error("Manual Clip Studio supports registered local videos and public YouTube videos.");
  await mkdir(STUDIO_SOURCE_CACHE, { recursive: true });
  const cached = cachedYouTubeSource(videoId);
  if (cached) {
    await mark(exportId, { progress: 20, stage: "Using Clip Studio source cache" });
    return cached;
  }

  await mark(exportId, { progress: 3, stage: "Downloading source with Cut IQ yt-dlp" });
  const outputTemplate = join(STUDIO_SOURCE_CACHE, `${videoId}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const runDownload = (useEmbeddedClient: boolean) => runProcess(exportId, YTDLP_PATH, buildStudioSourceDownloadArgs({
    jobDir,
    outputTemplate,
    url,
    useEmbeddedClient,
  }), {
    cwd: jobDir,
    timeoutMs: 45 * 60_000,
    onLine: (line) => {
      const percent = parseDownloadPercent(line);
      if (percent != null) void mark(exportId, { progress: Math.min(20, 3 + percent * 0.17), stage: "Downloading source with Cut IQ yt-dlp" });
    },
  });
  let result = await runDownload(true);
  let source = cachedYouTubeSource(videoId);
  // Embedded playback is the proven first choice for section/CDN refusals.
  // A small set of videos forbids embeds, so retry once with yt-dlp's native
  // client before reporting a source failure.
  if ((result.code !== 0 || !source) && !isCancelled(exportId, attemptEpoch)) {
    await mark(exportId, { progress: 3, stage: "Retrying source with Cut IQ native downloader" });
    result = await runDownload(false);
    source = cachedYouTubeSource(videoId);
  }
  if (result.code !== 0 || !source) throw new Error(`SOURCE_DOWNLOAD:${result.stderr}`);
  return source;
}

export function buildStudioSourceDownloadArgs(input: {
  jobDir: string;
  outputTemplate: string;
  url: string;
  useEmbeddedClient?: boolean;
}): string[] {
  return [
    "--no-playlist",
    "--js-runtimes", "node",
    ...(input.useEmbeddedClient === false ? [] : ["--extractor-args", "youtube:player_client=web_embedded"]),
    "--ffmpeg-location", FFMPEG_DIR,
    "--paths", `temp:${input.jobDir}`,
    "--newline",
    "--progress",
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/best",
    "--merge-output-format", "mp4",
    "-o", input.outputTemplate,
    input.url,
  ];
}

/**
 * Build against the H.264 encoder that ships in Cut IQ's owned FFmpeg.
 * The bundled n7.1.5 runtime includes libopenh264 but not libx264, so using
 * libx264 would make every Studio export fail before a frame is written.
 */
export function buildStudioClipArguments(sourcePath: string, outputPath: string, item: StudioExportItem): string[] {
  return [
    "-hide_banner", "-y",
    "-ss", item.inPoint.toFixed(3),
    "-i", sourcePath,
    "-t", (item.outPoint - item.inPoint).toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libopenh264",
    "-profile:v", "high",
    "-rc_mode", "quality",
    "-q:v", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ];
}

async function verifyStudioOutput(path: string, expectedDuration: number): Promise<void> {
  if (!existsSync(path) || statSync(path).size <= 0) throw new Error("MEDIA_VERIFY:Cut IQ did not produce an MP4 file.");
  const probe = await probeMedia(path);
  if (!probe.width || !probe.height || !Number.isFinite(probe.durationSec) || probe.durationSec <= 0) {
    throw new Error("MEDIA_VERIFY:The MP4 did not contain a usable video stream.");
  }
  const tolerance = Math.max(1.5, expectedDuration * 0.08);
  if (Math.abs(probe.durationSec - expectedDuration) > tolerance) {
    throw new Error("MEDIA_VERIFY:The MP4 duration did not match the selected range.");
  }
}

function joinedListLine(path: string): string {
  return `file '${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

export function publicStudioExportError(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error);
  if (text.startsWith("SOURCE_DOWNLOAD:")) return "Cut IQ could not download this source. Confirm it is still public, then retry.";
  if (text.startsWith("MEDIA_VERIFY:")) return text.slice("MEDIA_VERIFY:".length);
  if (/cancel/i.test(text)) return "The export was cancelled.";
  if (/enoent|not found|could not be found/i.test(text)) return "The source or export destination is no longer available.";
  if (/space|enospc/i.test(text)) return "The selected drive does not have enough free space for this export.";
  return "Cut IQ could not finish this manual export. Retry it or choose another destination.";
}

async function renderExport(exportId: number): Promise<void> {
  const db = getDb();
  const [record] = await db.select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, exportId));
  if (!record || record.status !== "queued") return;
  // Cancellation can race with the worker after it selects a queued row but
  // before it creates a child process. Keep the in-memory marker authoritative
  // across that window so a stale selected row cannot overwrite `cancelled`.
  if (cancellations.has(exportId)) return;
  const attemptEpoch = cancellationEpochs.get(exportId) ?? 0;
  const [video] = await db.select().from(videos).where(eq(videos.id, record.videoFk));
  if (!video) {
    await mark(exportId, { status: "failed", stage: "Failed", error: "The loaded Studio video no longer exists." });
    return;
  }

  const jobDir = studioJobDirectory(exportId);
  const outputPaths: string[] = [];
  let joinedOutput: string | null = null;
  try {
    const items = exportItems(record.items);
    const outputDir = canonicalWindowsDirectory(record.outputDir, true);
    await mkdir(jobDir, { recursive: true });
    await mark(exportId, { status: "preparing", progress: 2, stage: "Preparing manual export", error: null });
    const sourcePath = await prepareSource(exportId, video.url, jobDir, attemptEpoch);

    for (let index = 0; index < items.length; index += 1) {
      if (isCancelled(exportId, attemptEpoch)) throw new Error("cancelled");
      const item = items[index]!;
      const target = record.mode === "joined"
        ? join(jobDir, `part-${String(index + 1).padStart(3, "0")}.mp4`)
        : uniqueMp4Path(outputDir, item.label);
      const startProgress = 22 + (index / items.length) * 66;
      await mark(exportId, {
        status: "rendering",
        progress: startProgress,
        stage: `Rendering clip ${index + 1} of ${items.length}: ${item.label}`,
      });
      try {
        const cut = await runProcess(exportId, FFMPEG_PATH, buildStudioClipArguments(sourcePath, target, item), {
          cwd: jobDir,
          timeoutMs: 30 * 60_000,
        });
        if (cut.code !== 0 || !existsSync(target)) throw new Error(`MEDIA_RENDER:${cut.stderr}`);
        await verifyStudioOutput(target, item.outPoint - item.inPoint);
      } catch (error) {
        await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
      outputPaths.push(target);
      if (record.mode === "separate") {
        await mark(exportId, { outputPaths: JSON.stringify(outputPaths), outputPath: items.length === 1 ? target : null });
      }
    }

    if (record.mode === "joined") {
      if (isCancelled(exportId, attemptEpoch)) throw new Error("cancelled");
      await mark(exportId, { status: "joining", progress: 90, stage: `Joining ${items.length} clips in queue order` });
      joinedOutput = uniqueMp4Path(outputDir, record.title);
      const listPath = join(jobDir, "join.ffconcat");
      await writeFile(listPath, `ffconcat version 1.0\n${outputPaths.map(joinedListLine).join("\n")}\n`, "utf8");
      const joined = await runProcess(exportId, FFMPEG_PATH, [
        "-hide_banner", "-y", "-safe", "0", "-f", "concat", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", joinedOutput,
      ], { cwd: jobDir, timeoutMs: 30 * 60_000 });
      if (joined.code !== 0 || !existsSync(joinedOutput)) throw new Error(`MEDIA_RENDER:${joined.stderr}`);
      await mark(exportId, { progress: 97, stage: "Verifying joined MP4" });
      await verifyStudioOutput(joinedOutput, items.reduce((sum, item) => sum + item.outPoint - item.inPoint, 0));
    }

    const finalPaths = record.mode === "joined" && joinedOutput ? [joinedOutput] : outputPaths;
    await mark(exportId, {
      status: "ready",
      progress: 100,
      stage: finalPaths.length === 1 ? "MP4 ready" : `${finalPaths.length} MP4 files ready`,
      outputPaths: JSON.stringify(finalPaths),
      outputPath: finalPaths.length === 1 ? finalPaths[0] : null,
      error: null,
    });
  } catch (error) {
    const cancelled = isCancelled(exportId, attemptEpoch) || /cancel/i.test(String(error));
    if (joinedOutput && record.mode === "joined") {
      await rm(joinedOutput, { force: true }).catch(() => undefined);
    }
    await mark(exportId, {
      status: cancelled ? "cancelled" : "failed",
      stage: cancelled ? "Cancelled" : "Failed",
      error: cancelled ? null : publicStudioExportError(error),
      outputPaths: record.mode === "separate" && outputPaths.length
        ? JSON.stringify(outputPaths.filter(existsSync))
        : null,
    });
  } finally {
    activeChildren.delete(exportId);
    cancellations.delete(exportId);
    await rm(jobDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
  }
}

async function pump(): Promise<void> {
  if (running) {
    wakeRequested = true;
    return;
  }
  running = true;
  try {
    do {
      wakeRequested = false;
      for (;;) {
        const [next] = await getDb()
          .select({ id: transcriptStudioExports.id })
          .from(transcriptStudioExports)
          .where(eq(transcriptStudioExports.status, "queued"))
          .orderBy(transcriptStudioExports.id)
          .limit(1);
        if (!next) break;
        await renderExport(Number(next.id));
      }
    } while (wakeRequested);
  } finally {
    running = false;
    // A wake can arrive while the active pump is between its last query and
    // teardown. Schedule one more pass so a newly queued retry cannot strand.
    if (wakeRequested) queueMicrotask(() => void pump());
  }
}

export function wakeStudioExportWorker(): void {
  wakeRequested = true;
  void pump();
}

export function clearStudioExportCancellation(exportId: number): void {
  cancellations.delete(exportId);
}

export async function recoverStudioExports(): Promise<void> {
  await getDb().update(transcriptStudioExports).set({
    status: "queued",
    progress: 0,
    stage: "Recovered after restart - queued",
    error: null,
  }).where(inArray(transcriptStudioExports.status, ["preparing", "rendering", "joining"]));
  wakeStudioExportWorker();
}

export async function cancelStudioExport(exportId: number): Promise<boolean> {
  const [record] = await getDb().select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, exportId));
  if (!record || !["queued", "preparing", "rendering", "joining"].includes(record.status)) return false;
  cancellationEpochs.set(exportId, (cancellationEpochs.get(exportId) ?? 0) + 1);
  cancellations.add(exportId);
  const child = activeChildren.get(exportId);
  if (child) terminate(child);
  if (record.status === "queued") {
    await mark(exportId, { status: "cancelled", stage: "Cancelled", error: null });
    // Do not clear immediately: renderExport may already hold the previously
    // queued row. It clears the marker in its finally block; this fallback only
    // handles work that was never selected by the worker.
    setTimeout(() => {
      if (!activeChildren.has(exportId)) cancellations.delete(exportId);
    }, 60_000).unref();
  }
  return true;
}

export function studioExportFingerprint(videoFk: number, items: StudioExportItem[]): string {
  return createHash("sha256").update(JSON.stringify({ videoFk, items })).digest("hex").slice(0, 16);
}

export function studioExportView(record: typeof transcriptStudioExports.$inferSelect) {
  const items = exportItems(record.items);
  const paths = (() => {
    try {
      const parsed = record.outputPaths ? JSON.parse(record.outputPaths) : [];
      return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : [];
    } catch { return []; }
  })();
  return {
    id: Number(record.id),
    videoDbId: Number(record.videoFk),
    mode: record.mode,
    title: record.title,
    items,
    outputDir: record.outputDir,
    status: record.status,
    progress: record.progress,
    stage: record.stage,
    outputPaths: paths,
    outputs: record.mode === "separate"
      ? items.map((item, index) => ({ draftId: item.draftId, label: item.label, path: paths[index] ?? null }))
      : [{ draftId: null, label: record.title, path: paths[0] ?? null }],
    outputPath: record.outputPath,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
