/**
 * Voiceover ingestion — transcribe a LOCAL narration file (WAV/MP3/M4A/AAC)
 * through the cached local faster-whisper model, then align beats to real
 * narration timing. Reuses the whisper helper + provider safety fences; no
 * YouTube download, no paid API.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { parseLocalWhisperResult, resolveLocalWhisperJobDirectory } from "../transcript/localWhisperProvider";
import { FFMPEG_PATH as FFMPEG, WHISPER_MODEL_PATH as WHISPER_MODEL, WHISPER_PYTHON_PATH as WHISPER_PYTHON } from "../runtimePaths";

const TRANSCRIBE_SCRIPT = process.env.CLIPSIFT_WHISPER_SCRIPT || resolve(process.cwd(), "server", "transcript", "localWhisper.py");
const VO_TEMP_ROOT = process.env.CLIPSIFT_VO_TEMP_ROOT || "D:/Clips/.clipsift-vo-tmp";

const LOCAL_MEDIA_EXT_RE = /\.(wav|mp3|m4a|aac|flac|ogg|mp4|mov|mkv|webm|m4v|avi)$/i;

export interface VoiceoverResult {
  segments: Array<{ text: string; start: number; end: number }>;
  lang: string;
  duration: number;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel);
}

function requiredPath(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is not installed on this Cut IQ PC.`);
}

/** Resolve the cached model cache root to the snapshot dir that holds model.bin. */
async function resolveWhisperModel(configuredPath: string): Promise<string> {
  const root = resolve(configuredPath);
  if (existsSync(join(root, "model.bin"))) return root;
  const snapshotsRoot = resolve(root, "snapshots");
  if (!existsSync(snapshotsRoot)) throw new Error("The cached local Whisper model is incomplete on this Cut IQ PC.");
  const entries = await readdir(snapshotsRoot, { withFileTypes: true });
  const snapshots = entries
    .filter((e) => e.isDirectory() && /^[a-f0-9]{7,64}$/i.test(e.name))
    .map((e) => resolve(snapshotsRoot, e.name))
    .filter((s) => existsSync(join(s, "model.bin")));
  if (snapshots.length === 1) return snapshots[0];
  throw new Error("The cached local Whisper model is incomplete on this Cut IQ PC.");
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((res, rej) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      rej(new Error("A media tool could not be started on this Cut IQ PC."));
      return;
    }
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on("error", () => rej(new Error("A media tool failed to start.")));
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`Voiceover processing could not complete.${stderr ? ` (${stderr.trim().slice(-300)})` : ""}`))));
  });
}

/**
 * Transcribe a local narration file. Converts to WAV in a contained temp dir,
 * runs the cached whisper model, then removes all intermediates.
 */
export async function transcribeVoiceover(audioPath: string): Promise<VoiceoverResult> {
  if (!audioPath || !LOCAL_MEDIA_EXT_RE.test(audioPath)) {
    throw new Error("Import a supported local audio or video file.");
  }
  if (!existsSync(audioPath)) throw new Error("The narration file is missing.");

  requiredPath(FFMPEG, "ffmpeg");
  requiredPath(WHISPER_PYTHON, "The local Whisper Python runtime");
  requiredPath(WHISPER_MODEL, "The cached local Whisper model");
  requiredPath(TRANSCRIBE_SCRIPT, "The local Whisper helper");
  const whisperModel = await resolveWhisperModel(WHISPER_MODEL);

  const root = resolve(VO_TEMP_ROOT);
  await mkdir(root, { recursive: true });
  const jobDir = resolveLocalWhisperJobDirectory(root, `job-${randomUUID()}`);
  await mkdir(jobDir, { recursive: false });
  const wavPath = join(jobDir, "vo.wav");
  const outPath = join(jobDir, "transcript.json");

  try {
    await runProcess(FFMPEG, ["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", wavPath]);
    await runProcess(WHISPER_PYTHON, [TRANSCRIBE_SCRIPT, wavPath, whisperModel, outPath, ""]);
    const raw = await readFile(outPath, "utf8");
    const result = parseLocalWhisperResult(JSON.parse(raw), "");
    const duration = result.segments.length ? result.segments[result.segments.length - 1].end : 0;
    return { segments: result.segments, lang: result.lang, duration };
  } finally {
    if (isContained(root, jobDir)) {
      await rm(jobDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
    }
  }
}
