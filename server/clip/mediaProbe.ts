import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { FFPROBE_PATH as FFPROBE } from "../runtimePaths";

export type MediaProbe = {
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
};

/** Probe one output file through structured argv before declaring a render done. */
export async function probeMedia(file: string): Promise<MediaProbe> {
  if (!existsSync(file)) throw new Error("The exported file is missing.");
  if (!existsSync(FFPROBE)) throw new Error("ffprobe is unavailable, so Cut IQ cannot verify the completed export.");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file],
      { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((String(stderr).trim() || error.message).slice(0, 400)));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
  let parsed: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    throw new Error("ffprobe returned unreadable output for this export.");
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const durationSec = Number(parsed.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("The exported file is not a playable video with a measurable duration.");
  }
  return {
    width: video.width,
    height: video.height,
    durationSec,
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio")),
  };
}

export function assertVerifiedClip(probe: MediaProbe, expectedDurationSec: number, minimumHeight: number): void {
  if (!probe.hasAudio) throw new Error("The exported clip has no audio stream.");
  if (probe.height < minimumHeight) {
    throw new Error(`The exported clip is ${probe.height}p, below the requested ${minimumHeight}p source quality.`);
  }
  // `--force-keyframes-at-cuts` permits a tight but realistic container-level tolerance.
  const tolerance = Math.max(0.4, expectedDurationSec * 0.03);
  if (Math.abs(probe.durationSec - expectedDurationSec) > tolerance) {
    throw new Error(`The exported duration (${probe.durationSec.toFixed(2)}s) does not match the selected range (${expectedDurationSec.toFixed(2)}s).`);
  }
}
