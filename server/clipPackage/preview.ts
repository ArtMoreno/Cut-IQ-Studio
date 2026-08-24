import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { clipJobs } from "@db/schema";
import { getDb } from "../queries/connection";
import { FFMPEG_PATH, FFPROBE_PATH } from "../runtimePaths";
import { probeMedia } from "../clip/mediaProbe";

const PREVIEW_ROOT = resolve(process.env.CLIPSIFT_PACKAGE_PREVIEW_CACHE || "D:/Clips/.clipsift-package-previews");
const pending = new Map<string, Promise<string>>();

async function videoCodec(file: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      FFPROBE_PATH,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", file],
      { windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 },
      (error, stdout) => done(error ? null : String(stdout).trim().toLowerCase() || null),
    );
  });
}

function transcode(file: string, target: string, encoder: "h264_nvenc" | "libopenh264"): Promise<boolean> {
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    encoder,
    ...(encoder === "h264_nvenc"
      ? ["-preset", "p5", "-cq", "21", "-b:v", "0"]
      : ["-profile:v", "high", "-rc_mode", "quality", "-q:v", "18"]),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    target,
  ];
  return new Promise((done) => {
    execFile(FFMPEG_PATH, args, { windowsHide: true, timeout: 60 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error) => {
      done(!error && existsSync(target));
    });
  });
}

async function buildCompatiblePreview(source: string): Promise<string> {
  const codec = await videoCodec(source);
  if (codec === "h264" || codec === "avc1") return source;
  const stat = statSync(source);
  const fingerprint = createHash("sha256")
    .update(`${source.toLowerCase()}\n${stat.size}\n${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 32);
  const target = join(PREVIEW_ROOT, `${fingerprint}.mp4`);
  if (existsSync(target) && statSync(target).size > 0) return target;
  await mkdir(PREVIEW_ROOT, { recursive: true });
  let ok = await transcode(source, target, "h264_nvenc");
  if (!ok) {
    await rm(target, { force: true }).catch(() => undefined);
    ok = await transcode(source, target, "libopenh264");
  }
  if (!ok) {
    await rm(target, { force: true }).catch(() => undefined);
    throw new Error("Cut IQ could not prepare this finished clip for browser playback.");
  }
  await probeMedia(target);
  return target;
}

export async function clipPackagePreviewPath(candidateId: number): Promise<string> {
  const rows = await getDb()
    .select()
    .from(clipJobs)
    .where(and(eq(clipJobs.candidateFk, candidateId), eq(clipJobs.status, "ready")))
    .orderBy(desc(clipJobs.id));
  const source = rows.find((row) => row.outputPath && existsSync(row.outputPath))?.outputPath ?? null;
  if (!source) throw new Error("The finished clip is offline or missing.");
  const key = source.toLowerCase();
  const existing = pending.get(key);
  if (existing) return existing;
  const work = buildCompatiblePreview(source).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
