import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { TranscriptError, type TranscriptResult } from "./provider";
import {
  FFMPEG_DIR,
  WHISPER_MODEL_PATH as WHISPER_MODEL,
  WHISPER_PYTHON_PATH as WHISPER_PYTHON,
  YTDLP_PATH as YTDLP,
} from "../runtimePaths";

const TRANSCRIPT_TEMP_ROOT =
  process.env.CLIPSIFT_TRANSCRIPT_TEMP_ROOT || "D:/Clips/.clipsift-transcript-tmp";
// Cut IQ's production boot process keeps `server/` beside `dist/` and runs
// with the app root as its working directory.  Resolve there deliberately so
// bundling `boot.ts` does not point this helper at a non-existent dist file.
const TRANSCRIBE_SCRIPT =
  process.env.CLIPSIFT_WHISPER_SCRIPT || resolve(process.cwd(), "server", "transcript", "localWhisper.py");

const MAX_CAPTURED_OUTPUT = 16_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;

type WhisperPayload = {
  language?: unknown;
  segments?: unknown;
};

type WhisperSegment = {
  text?: unknown;
  start?: unknown;
  end?: unknown;
};

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;
type LocalWhisperJob = { children: Set<SpawnedProcess>; cancelled: boolean };

// The Studio's client load id is used only as an in-memory cancellation key.
// It never participates in a filesystem path or a command string.
const activeLocalWhisperJobs = new Map<string, LocalWhisperJob>();

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** Kept public for the focused safety tests. */
export function isSafeYouTubeVideoId(videoId: string): boolean {
  return /^[\w-]{11}$/.test(videoId);
}

/**
 * Resolve a generated job directory without allowing traversal out of the
 * dedicated transcript-temp root.  `jobName` is generated internally, and is
 * validated again so future callers cannot accidentally broaden the scope.
 */
export function resolveLocalWhisperJobDirectory(tempRoot: string, jobName: string): string {
  if (!/^job-[a-f0-9-]{36}$/i.test(jobName)) {
    throw new Error("Invalid local-transcription job identifier.");
  }
  const root = resolve(tempRoot);
  const jobDir = resolve(root, jobName);
  if (!isContained(root, jobDir)) {
    throw new Error("Local-transcription temp directory escaped its root.");
  }
  return jobDir;
}

function requiredPath(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new TranscriptError(
      "LOCAL_TRANSCRIPTION_UNAVAILABLE",
      `${label} is not installed on this Cut IQ PC. Import a timestamped transcript instead.`,
    );
  }
}

/**
 * Hugging Face stores a cached model below `snapshots/<revision>`, while a
 * user may reasonably configure either that snapshot or the cache root.  Find
 * a present model.bin only; this never accepts a model name or invokes a
 * downloader.
 */
async function resolveCachedWhisperModel(configuredPath: string): Promise<string> {
  const root = resolve(configuredPath);
  if (existsSync(join(root, "model.bin"))) return root;

  let preferredRevision = "";
  try {
    preferredRevision = (await readFile(join(root, "refs", "main"), "utf8")).trim();
  } catch {
    // A cache created without refs can still have one complete snapshot.
  }
  if (/^[a-f0-9]{7,64}$/i.test(preferredRevision)) {
    const preferred = resolve(root, "snapshots", preferredRevision);
    if (isContained(root, preferred) && existsSync(join(preferred, "model.bin"))) return preferred;
  }

  try {
    const snapshotsRoot = resolve(root, "snapshots");
    if (!isContained(root, snapshotsRoot)) throw new Error("Unsafe cache snapshots path.");
    const snapshots = (await readdir(snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{7,64}$/i.test(entry.name))
      .map((entry) => resolve(snapshotsRoot, entry.name))
      .filter((snapshot) => isContained(root, snapshot) && existsSync(join(snapshot, "model.bin")));
    if (snapshots.length === 1) return snapshots[0];
  } catch {
    // Fall through to the user-safe unavailable error below.
  }

  throw new TranscriptError(
    "LOCAL_TRANSCRIPTION_UNAVAILABLE",
    "The cached local Whisper model is incomplete on this Cut IQ PC. Import a timestamped transcript instead.",
  );
}

function canonicalUrl(videoId: string): string {
  if (!isSafeYouTubeVideoId(videoId)) {
    throw new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "The source video ID is invalid.");
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Use the same tested YouTube client as Cut IQ's playable clip downloader.
 * The default web client can expose captions while refusing the audio stream,
 * which previously left captionless games permanently unsearchable.
 */
export function buildLocalWhisperAudioDownloadArgs(jobDir: string, sourceUrl: string): string[] {
  return [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--js-runtimes",
    "node",
    "--extractor-args",
    "youtube:player_client=web_embedded",
    "--socket-timeout",
    "30",
    "--ffmpeg-location",
    FFMPEG_DIR,
    "--paths",
    `home:${jobDir}`,
    "--paths",
    `temp:${jobDir}`,
    "-f",
    "bestaudio/best",
    "-x",
    "--audio-format",
    "wav",
    "-o",
    "audio.%(ext)s",
    sourceUrl,
  ];
}

function appendOutput(current: string, chunk: Buffer): string {
  const next = `${current}${chunk.toString("utf8")}`;
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

function terminateProcessTree(child: SpawnedProcess): void {
  if (child.pid && process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    return;
  }
  child.kill();
}

/** Stop only the structured child processes associated with this Studio load. */
export function cancelLocalWhisperTranscript(jobId: string): boolean {
  const job = activeLocalWhisperJobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  for (const child of job.children) terminateProcessTree(child);
  return true;
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
  jobId?: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const job = jobId ? activeLocalWhisperJobs.get(jobId) : undefined;
    if (job?.cancelled) {
      rejectPromise(new TranscriptError("LOCAL_TRANSCRIPTION_CANCELLED", "Local transcription was cancelled."));
      return;
    }
    let child: SpawnedProcess;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      rejectPromise(
        new TranscriptError(
          "LOCAL_TRANSCRIPTION_UNAVAILABLE",
          `${label} could not be started on this Cut IQ PC. Import a timestamped transcript instead.`,
        ),
      );
      return;
    }
    job?.children.add(child);

    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      job?.children.delete(child);
      callback();
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(() =>
        rejectPromise(
          new TranscriptError(
            "LOCAL_TRANSCRIPTION_FAILED",
            `${label} took too long. Retry or import a timestamped transcript instead.`,
          ),
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", () => {
      finish(() =>
        rejectPromise(
          new TranscriptError(
            "LOCAL_TRANSCRIPTION_UNAVAILABLE",
            `${label} could not be started on this Cut IQ PC. Import a timestamped transcript instead.`,
          ),
        ),
      );
    });
    child.on("close", (code) => {
      if (job?.cancelled) {
        finish(() => rejectPromise(new TranscriptError("LOCAL_TRANSCRIPTION_CANCELLED", "Local transcription was cancelled.")));
        return;
      }
      if (code === 0) {
        finish(resolvePromise);
        return;
      }
      // The diagnostics remain process-local.  Provider errors deliberately do
      // not leak raw downloader paths, URLs, or implementation details into UI.
      void stdout;
      void stderr;
      finish(() =>
        rejectPromise(
          new TranscriptError(
            "LOCAL_TRANSCRIPTION_FAILED",
            `${label} could not complete. Retry or import a timestamped transcript instead.`,
          ),
        ),
      );
    });
  });
}

async function findDownloadedAudio(tempRoot: string, jobDir: string): Promise<string> {
  const entries = await readdir(jobDir, { withFileTypes: true });
  const wavFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"));
  if (wavFiles.length !== 1) {
    throw new TranscriptError(
      "LOCAL_TRANSCRIPTION_FAILED",
      "Local audio preparation did not produce one usable WAV file. Retry or import a timestamped transcript instead.",
    );
  }
  const audioPath = resolve(jobDir, wavFiles[0].name);
  if (!isContained(resolve(tempRoot), audioPath)) {
    throw new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "Local audio preparation returned an unsafe file path.");
  }
  return audioPath;
}

function validLanguage(value: unknown, fallback?: string): string {
  if (typeof value === "string" && /^[a-z]{2,3}$/i.test(value)) return value.toLowerCase();
  if (fallback && /^[a-z]{2,3}$/i.test(fallback)) return fallback.toLowerCase();
  return "und";
}

/**
 * Accept only timings emitted by faster-whisper.  This does not generate or
 * interpolate word offsets, preserving the transcript reader's segment-level
 * timing disclosure.
 */
export function parseLocalWhisperResult(payload: unknown, languageHint?: string): TranscriptResult {
  if (!payload || typeof payload !== "object") {
    throw new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "The local transcript result was invalid.");
  }
  const result = payload as WhisperPayload;
  if (!Array.isArray(result.segments)) {
    throw new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "The local transcript result had no segments.");
  }

  const segments = result.segments.map((candidate) => {
    const segment = candidate as WhisperSegment;
    const text = typeof segment.text === "string" ? segment.text.replace(/\s+/g, " ").trim() : "";
    const start = typeof segment.start === "number" ? segment.start : Number.NaN;
    const end = typeof segment.end === "number" ? segment.end : Number.NaN;
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "The local transcript contained an invalid timed segment.");
    }
    return { text, start, end };
  });

  if (!segments.length) {
    throw new TranscriptError("LOCAL_TRANSCRIPTION_FAILED", "The local transcription produced no usable timed segments.");
  }
  return { lang: validLanguage(result.language, languageHint), kind: "local-whisper", segments };
}

async function cleanupJobDirectory(tempRoot: string, jobDir: string): Promise<void> {
  const root = resolve(tempRoot);
  const resolvedJobDir = resolve(jobDir);
  if (!isContained(root, resolvedJobDir)) return;
  await rm(resolvedJobDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

/**
 * Download audio only into an isolated job directory, run the cached local
 * faster-whisper model, and always remove all downloaded media afterward.
 */
export async function fetchLocalWhisperTranscript(
  videoId: string,
  languageHint?: string,
  jobId?: string,
): Promise<TranscriptResult> {
  const sourceUrl = canonicalUrl(videoId);
  requiredPath(YTDLP, "yt-dlp");
  requiredPath(FFMPEG_DIR, "FFmpeg");
  requiredPath(WHISPER_PYTHON, "The local Whisper Python runtime");
  requiredPath(WHISPER_MODEL, "The cached local Whisper model");
  requiredPath(TRANSCRIBE_SCRIPT, "The local Whisper helper");
  const whisperModel = await resolveCachedWhisperModel(WHISPER_MODEL);

  const root = resolve(TRANSCRIPT_TEMP_ROOT);
  await mkdir(root, { recursive: true });
  const jobDir = resolveLocalWhisperJobDirectory(root, `job-${randomUUID()}`);
  await mkdir(jobDir, { recursive: false });
  const outputPath = join(jobDir, "transcript.json");
  if (jobId) activeLocalWhisperJobs.set(jobId, { children: new Set(), cancelled: false });

  try {
    await runProcess(
      YTDLP,
      buildLocalWhisperAudioDownloadArgs(jobDir, sourceUrl),
      DOWNLOAD_TIMEOUT_MS,
      "Local audio preparation",
      jobId,
    );
    const audioPath = await findDownloadedAudio(root, jobDir);
    const language = languageHint && /^[a-z]{2,3}$/i.test(languageHint) ? languageHint.toLowerCase() : "";
    await runProcess(
      WHISPER_PYTHON,
      [TRANSCRIBE_SCRIPT, audioPath, whisperModel, outputPath, language],
      TRANSCRIBE_TIMEOUT_MS,
      "Local Whisper transcription",
      jobId,
    );
    const raw = await readFile(outputPath, "utf8");
    return parseLocalWhisperResult(JSON.parse(raw) as unknown, language);
  } catch (error) {
    if (error instanceof TranscriptError) throw error;
    throw new TranscriptError(
      "LOCAL_TRANSCRIPTION_FAILED",
      "Cut IQ could not create a local transcript. Retry or import a timestamped transcript instead.",
    );
  } finally {
    await cleanupJobDirectory(root, jobDir);
    if (jobId) activeLocalWhisperJobs.delete(jobId);
  }
}
