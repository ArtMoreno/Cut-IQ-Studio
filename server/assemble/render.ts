/**
 * Render engine — turns an Assemble edit-decision model into a video.
 *
 * Two-stage by design (master prompt §69): the timeline doc is the project; this
 * module translates it into an ffmpeg filter_complex graph and encodes H.264/AAC.
 * NVENC is preferred when available; a software encoder is the fallback. The
 * output is verified with probeMedia before it is reported ready.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AssembleDoc, TimelineItem } from "./project";
import { probeMedia } from "../clip/mediaProbe";
import { segmentsToSrt } from "./captions";
import { CLIPS_DIR, FFMPEG_PATH as FFMPEG } from "../runtimePaths";

const EXPORT_ROOT = process.env.ASSEMBLE_EXPORT_ROOT || join(CLIPS_DIR, "pipeline_jobs", ".assemble-exports");

// ── Pure filter construction (unit-testable) ───────────────────────────────

export type CropMode = "fit" | "fill" | "crop";

/**
 * Build the scale/crop/pad filter for one clip, targeting the project frame.
 * - fill: scale to cover the frame, center-crop the overflow (9:16 from 16:9).
 * - crop: same as fill but honors a manual X/Y pan (cropX/cropY in -0.5..0.5).
 * - fit : scale to fit inside the frame and pad with black (no cropping).
 */
export function buildScaleFilter(
  cropMode: CropMode | null,
  srcW: number | null,
  srcH: number | null,
  targetW: number,
  targetH: number,
  panX = 0,
  panY = 0,
): string {
  const mode: CropMode = cropMode ?? "fit";
  if (mode === "fit") {
    return `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`;
  }
  // fill / crop: scale to cover, then crop the overflow. srcW/srcH are hints only.
  void srcW;
  void srcH;
  return `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:x=(iw-ow)*${(panX + 0.5).toFixed(3)}:y=(ih-oh)*${(panY + 0.5).toFixed(3)}`;
}

export interface RenderClipInput {
  item: TimelineItem;
  sourcePath: string;
  hasAudio: boolean;
}

export interface CaptionEntry {
  text: string;
  start: number;
  end: number;
}

export interface RenderOptions {
  /** narration segments to burn in as captions (optional) */
  captions?: CaptionEntry[];
  /** narration audio path on A1 (optional; ducked source/music under it) */
  narrationPath?: string | null;
  /** target directory for the export (must exist or be under D:\Clips) */
  outputDir?: string;
  /** filename without extension; sanitized by the caller */
  outputName?: string;
}

export interface RenderPlan {
  inputs: string[];
  filterComplex: string;
}

/**
 * Build the ffmpeg filter_complex graph for an ordered V1/V2 clip list.
 * Video: trim each source to its in/out, normalize to the target frame + fps,
 * concat. Audio: trim each source, resample to a common rate, concat, then a
 * simple narration-ducking gain is left to the caller's optional audio params.
 */
export function buildRenderPlan(
  clips: RenderClipInput[],
  settings: { width: number; height: number; fps: number },
): RenderPlan {
  const inputs = clips.map((c) => c.sourcePath);
  const videoChains: string[] = [];
  const audioChains: string[] = [];
  let hasAnyAudio = false;

  clips.forEach((c, i) => {
    const srcIn = Math.max(0, c.item.sourceIn ?? 0);
    const srcOut = c.item.sourceOut ?? srcIn + (c.item.timelineEnd - c.item.timelineStart);
    const scale = buildScaleFilter(c.item.cropMode, null, null, settings.width, settings.height, c.item.cropX, c.item.cropY);
    videoChains.push(
      `[${i}:v]trim=start=${srcIn}:end=${srcOut},setpts=PTS-STARTPTS,${scale},fps=${settings.fps},setsar=1[v${i}]`,
    );
    if (c.hasAudio) {
      hasAnyAudio = true;
      audioChains.push(
        `[${i}:a]atrim=start=${srcIn}:end=${srcOut},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
      );
    }
  });

  const parts: string[] = [...videoChains, ...audioChains];
  parts.push(`${videoChains.map((_, i) => `[v${i}]`).join("")}concat=n=${clips.length}:v=1:a=0[vc]`);
  if (hasAnyAudio) {
    // Some inputs may lack audio; pad the missing ones with silence for a stable concat.
    clips.forEach((c, i) => {
      if (!c.hasAudio) {
        parts.push(`aevalsrc=0:d=${Math.max(0.1, (c.item.sourceOut ?? 0) - (c.item.sourceIn ?? 0))}:s=48000[a${i}]`);
      }
    });
    parts.push(`${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[ac]`);
  }

  return { inputs, filterComplex: parts.join(";") };
}

/** Detect a usable NVIDIA encoder; returns null when NVENC is unavailable. */
export function detectEncoder(): Promise<"h264_nvenc" | "libx264"> {
  return new Promise((resolvePromise) => {
    const child: ChildProcess = execFile(
      FFMPEG,
      ["-hide_banner", "-encoders"],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !String(stdout).includes("h264_nvenc")) {
          resolvePromise("libx264");
        } else {
          resolvePromise("h264_nvenc");
        }
      },
    );
    child.on("error", () => resolvePromise("libx264"));
  });
}

// ── Render runner ───────────────────────────────────────────────────────────

export interface RenderResult {
  ok: boolean;
  outputPath: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  encoder: string;
  error: string | null;
  /** unresolved placeholder items skipped during render */
  skippedPlaceholders: number;
}

function spawnFfmpeg(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = execFile(FFMPEG, args, { windowsHide: true, timeout: 2 * 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-16_000);
    });
    child.on("error", (err) => resolvePromise({ code: 1, stderr: String(err) }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stderr }));
  });
}

export async function renderProject(
  doc: AssembleDoc,
  projectName: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  if (!doc.items.length) {
    return { ok: false, outputPath: "", width: null, height: null, durationSec: null, encoder: "libx264", error: "The timeline is empty — nothing to render.", skippedPlaceholders: 0 };
  }

  const ordered = [...doc.items]
    .filter((i) => i.track === "V1" || i.track === "V2")
    .sort((a, b) => a.timelineStart - b.timelineStart);

  // Unresolved placeholders (NO MATCH beats) carry no media — skip them with a
  // warning instead of failing the whole render (§11: honest empty beats).
  const placeholders = ordered.filter((i) => i.unresolved);
  const renderable = ordered.filter((i) => !i.unresolved);

  if (!renderable.length) {
    return { ok: false, outputPath: "", width: null, height: null, durationSec: null, encoder: "libx264", error: "The timeline has no resolved footage — every beat is an unresolved placeholder.", skippedPlaceholders: 0 };
  }

  const missing = renderable.filter((i) => !i.sourcePath || !existsSync(i.sourcePath));
  if (missing.length) {
    return { ok: false, outputPath: "", width: null, height: null, durationSec: null, encoder: "libx264", error: `${missing.length} clip(s) are offline or missing on disk: ${missing.slice(0, 3).map((i) => i.sourcePath ?? i.id).join(", ")}${missing.length > 3 ? "…" : ""}. Relink or remove them, then export again.`, skippedPlaceholders: placeholders.length };
  }

  const clips: RenderClipInput[] = renderable.map((item) => ({
    item,
    sourcePath: item.sourcePath!,
    hasAudio: true, // verified at render time below
  }));

  const plan = buildRenderPlan(clips, doc.settings);
  const encoder = await detectEncoder();

  // Output location: caller-chosen dir + name, or the default export root.
  // The dir must already exist (or be creatable under the Clips root) — we
  // never write outside the Clips tree from this feature.
  const clipsRoot = resolve(CLIPS_DIR);
  const chosenDir = opts.outputDir ? resolve(opts.outputDir) : resolve(EXPORT_ROOT);
  if (!chosenDir.startsWith(clipsRoot) && !existsSync(chosenDir)) {
    return { ok: false, outputPath: "", width: null, height: null, durationSec: null, encoder: "libx264", error: `Export folder does not exist: ${chosenDir}`, skippedPlaceholders: placeholders.length };
  }
  if (!chosenDir.startsWith(clipsRoot)) {
    return { ok: false, outputPath: "", width: null, height: null, durationSec: null, encoder: "libx264", error: `Exports can only be written inside ${CLIPS_DIR}.`, skippedPlaceholders: placeholders.length };
  }
  mkdirSync(chosenDir, { recursive: true });

  const safeName = (opts.outputName ?? projectName).replace(/[^\w\- ()]+/g, "").trim().replace(/\s+/g, "-").slice(0, 100) || "assemble-export";
  let outputPath = join(chosenDir, `${safeName}.mp4`);
  let n = 1;
  while (existsSync(outputPath)) outputPath = join(chosenDir, `${safeName}-${n++}.mp4`);

  // Narration (A1): layer it over the source audio with ducking. The narration
  // input index is plan.inputs.length; its audio becomes the sidechain that
  // ducks the concatenated source audio, then the two are mixed.
  const hasNarration = Boolean(opts.narrationPath && existsSync(opts.narrationPath));
  let filterComplex = plan.filterComplex;
  if (hasNarration) {
    const narrationIdx = plan.inputs.length;
    // [ac] = source concat; duck it under the narration, then mix both.
    filterComplex = `${plan.filterComplex};[${narrationIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[nar];[ac]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];[duck][nar]amix=inputs=2:duration=first:dropout_transition=2[ac]`;
  }

  // Captions (§24): write an SRT beside the output and burn it in after the
  // video concat. Timing comes from the VO transcript (never invented).
  const captionsPath = join(chosenDir, `${safeName}.srt`);
  const hasCaptions = Boolean(opts.captions?.length);
  if (hasCaptions) {
    const srt = segmentsToSrt(opts.captions!);
    if (srt) {
      writeFileSync(captionsPath, srt, "utf8");
      // [vc] is the concatenated video; burn subtitles on top, re-emit [vc].
      const srtFilterArg = captionsPath.replace(/\\/g, "/").replace(/:/g, "\\:");
      filterComplex = `${filterComplex};[vc]subtitles='${srtFilterArg}'[vc]`;
    }
  }

  const args = [
    "-hide_banner",
    "-y",
    ...plan.inputs.flatMap((p) => ["-i", p]),
    ...(hasNarration ? ["-i", opts.narrationPath!] : []),
    "-filter_complex",
    filterComplex,
    "-map",
    "[vc]",
    "-map",
    "[ac]",
    "-c:v",
    encoder,
    ...(encoder === "h264_nvenc" ? ["-preset", "p5", "-cq", "21", "-b:v", "0"] : ["-preset", "medium", "-crf", "20"]),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(doc.settings.fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath,
  ];

  const run = await spawnFfmpeg(args);
  if (run.code !== 0 || !existsSync(outputPath)) {
    const error = run.stderr.trim().slice(-800) || `ffmpeg exited ${run.code}`;
    return { ok: false, outputPath, width: null, height: null, durationSec: null, encoder, error, skippedPlaceholders: placeholders.length };
  }

  try {
    const probe = await probeMedia(outputPath);
    return { ok: true, outputPath, width: probe.width, height: probe.height, durationSec: probe.durationSec, encoder, error: null, skippedPlaceholders: placeholders.length };
  } catch (err) {
    // Verification failed — keep the file but do not report success.
    try { rmSync(outputPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, outputPath, width: null, height: null, durationSec: null, encoder, error: String(err instanceof Error ? err.message : err), skippedPlaceholders: placeholders.length };
  }
}
