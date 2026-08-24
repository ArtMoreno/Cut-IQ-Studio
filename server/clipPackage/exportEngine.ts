import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { clipJobs, findJobs } from "@db/schema";
import type { ManifestClip } from "../assemble/manifest";
import { buildProjectManifest } from "../assemble/manifest";
import { probeMedia } from "../clip/mediaProbe";
import { playerHighlightCandidateIsCanonical } from "../findClips/engine";
import { getDb } from "../queries/connection";
import { CLIPS_DIR, FFMPEG_PATH } from "../runtimePaths";
import { broadcastSoundbiteStatus } from "./soundbites";
import {
  localDriveProjectInfo,
  openLocalDriveProjectFolder,
  syncProjectFilesToLocalDrive,
} from "../clip/localDriveSync";
import {
  canonicalWindowsDirectory,
  safeStudioFileStem,
  uniqueMp4Path,
} from "../transcriptStudio/exportPaths";
import {
  listPackageEditedVersions,
  setEditedVersionDrivePath,
  type PackageEditedVersionView,
} from "./studioBridge";

export type ClipPackageExportMode = "separate" | "joined";
export type ClipPackageExportStatus = "queued" | "preparing" | "exporting" | "ready" | "failed" | "cancelled";

export interface ClipPackageExportView {
  id: string;
  projectId: number;
  mode: ClipPackageExportMode;
  title: string;
  candidateIds: number[];
  assetIds: string[];
  outputDir: string;
  status: ClipPackageExportStatus;
  progress: number;
  stage: string;
  outputPaths: string[];
  downloadUrls: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type PackageJob = ClipPackageExportView & {
  cancelled: boolean;
  child: ChildProcess | null;
};

const DEFAULT_OUTPUT_DIR = resolve(CLIPS_DIR, "Clip Packages");
const jobs = new Map<string, PackageJob>();

function touch(job: PackageJob, patch: Partial<PackageJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function view(job: PackageJob): ClipPackageExportView {
  return {
    id: job.id,
    projectId: job.projectId,
    mode: job.mode,
    title: job.title,
    candidateIds: [...job.candidateIds],
    assetIds: [...job.assetIds],
    outputDir: job.outputDir,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    outputPaths: [...job.outputPaths],
    downloadUrls: job.status === "ready"
      ? job.outputPaths.map((_, index) => `/api/package-export/${encodeURIComponent(job.id)}/${index}?download=1`)
      : [],
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function clipPackageExportOutput(id: string, index: number): string | null {
  const job = jobs.get(id);
  if (!job || job.status !== "ready" || !Number.isSafeInteger(index) || index < 0) return null;
  const output = job.outputPaths[index];
  return output && existsSync(output) && statSync(output).isFile() ? output : null;
}

function normalizedFileKey(clip: ManifestClip): string {
  return (clip.localPath ?? clip.downloadUrl ?? clip.clipId).replace(/\\/g, "/").toLowerCase();
}

/** Collapse repeated candidate rows that point at the same finished MP4. */
export function uniqueFinishedClips(clips: ManifestClip[]): ManifestClip[] {
  const seen = new Set<string>();
  return clips.filter((clip) => {
    if (!clip.localPath || !clip.downloadUrl) return false;
    const key = normalizedFileKey(clip);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceTerms(text: string | null): Set<string> {
  return new Set((text?.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((term) => term.length >= 4));
}

function transcriptContainment(left: string | null, right: string | null): number {
  const leftTerms = evidenceTerms(left);
  const rightTerms = evidenceTerms(right);
  const denominator = Math.min(leftTerms.size, rightTerms.size);
  if (denominator < 8) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared++;
  return shared / denominator;
}

/** Collapse the same play harvested from alternate full-game uploads. */
export function uniquePlayerEvidenceClips(clips: ManifestClip[]): ManifestClip[] {
  const kept: ManifestClip[] = [];
  for (const clip of clips) {
    if (kept.some((prior) => transcriptContainment(prior.transcript.text, clip.transcript.text) >= 0.78)) continue;
    kept.push(clip);
  }
  return kept;
}

export function defaultClipPackageOutputDir(): string {
  return canonicalWindowsDirectory(process.env.CLIPSIFT_PACKAGE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR, true);
}

export type PackageClipAsset = ManifestClip & {
  packageAssetId: string;
  previewUrl: string | null;
  originalAsset: {
    packageAssetId: string;
    localPath: string | null;
    downloadUrl: string | null;
    previewUrl: string;
    drivePath: string | null;
    sourceStartSeconds: number | null;
    sourceEndSeconds: number | null;
    clipDurationSeconds: number | null;
  };
  activeVersion: PackageEditedVersionView | null;
  editedVersion: PackageEditedVersionView | null;
  editedVersions: PackageEditedVersionView[];
};

/** Pure package model: one logical clip per candidate plus independent saved copies. */
export function buildPackageAssetModel(
  uniqueClips: ManifestClip[],
  editedVersions: PackageEditedVersionView[],
): { clips: PackageClipAsset[]; savedCopies: PackageClipAsset[]; recoverableOriginals: PackageClipAsset[]; allAssets: PackageClipAsset[] } {
  const versionsByCandidate = new Map<number, PackageEditedVersionView[]>();
  for (const version of editedVersions) {
    const current = versionsByCandidate.get(version.candidateId) ?? [];
    current.push(version);
    versionsByCandidate.set(version.candidateId, current);
  }
  const clips: PackageClipAsset[] = [];
  const savedCopies: PackageClipAsset[] = [];
  const recoverableOriginals: PackageClipAsset[] = [];
  for (const clip of uniqueClips) {
    const versions = versionsByCandidate.get(clip.candidateId) ?? [];
    const activeVersion = versions.find((version) => version.activeReplacement && version.status === "ready") ?? null;
    const originalAsset = {
      packageAssetId: `candidate:${clip.candidateId}:original`,
      localPath: clip.localPath,
      downloadUrl: clip.downloadUrl,
      previewUrl: `/api/clip-preview/${clip.candidateId}`,
      drivePath: clip.drivePath,
      sourceStartSeconds: clip.sourceStartSeconds,
      sourceEndSeconds: clip.sourceEndSeconds,
      clipDurationSeconds: clip.clipDurationSeconds,
    };
    const logical: PackageClipAsset = activeVersion
      ? {
          ...clip,
          packageAssetId: `candidate:${clip.candidateId}`,
          localPath: activeVersion.outputPath,
          downloadUrl: activeVersion.downloadUrl,
          previewUrl: activeVersion.previewUrl,
          drivePath: activeVersion.drivePath,
          sourceStartSeconds: activeVersion.editIn,
          sourceEndSeconds: activeVersion.editOut,
          clipDurationSeconds: activeVersion.editOut - activeVersion.editIn,
          originalAsset,
          activeVersion,
          editedVersion: activeVersion,
          editedVersions: versions,
        }
      : {
          ...clip,
          packageAssetId: `candidate:${clip.candidateId}`,
          previewUrl: `/api/clip-preview/${clip.candidateId}`,
          originalAsset,
          activeVersion: null,
          editedVersion: null,
          editedVersions: versions,
        };
    clips.push(logical);
    if (activeVersion) {
      recoverableOriginals.push({
        ...clip,
        packageAssetId: originalAsset.packageAssetId,
        previewUrl: originalAsset.previewUrl,
        originalAsset,
        activeVersion: null,
        editedVersion: null,
        editedVersions: versions,
      });
    }
    for (const version of versions) {
      if (version.status !== "ready" || !version.outputPath || version.activeReplacement) continue;
      savedCopies.push({
        ...clip,
        clipId: `version-${version.id}`,
        packageAssetId: version.packageAssetId,
        localPath: version.outputPath,
        downloadUrl: version.downloadUrl,
        previewUrl: version.previewUrl,
        drivePath: version.drivePath,
        sourceStartSeconds: version.editIn,
        sourceEndSeconds: version.editOut,
        clipDurationSeconds: version.editOut - version.editIn,
        originalAsset,
        activeVersion: null,
        editedVersion: version,
        editedVersions: versions,
      });
    }
  }
  return {
    clips,
    savedCopies,
    recoverableOriginals,
    allAssets: [...clips, ...savedCopies, ...recoverableOriginals],
  };
}

export async function openClipPackage(projectId: number) {
  const manifest = await buildProjectManifest(projectId, { renderedOnly: true });
  const allUniqueClips = uniqueFinishedClips(manifest.clips);
  const actionClips = allUniqueClips.filter((clip) => clip.selectionKind === "player_play");
  const soundbiteClips = allUniqueClips.filter((clip) => clip.selectionKind === "broadcast_soundbite");
  const [findJob] = await getDb().select().from(findJobs).where(eq(findJobs.projectFk, projectId)).limit(1);
  const playerPlays = uniquePlayerEvidenceClips(findJob
    ? actionClips.filter((clip) => playerHighlightCandidateIsCanonical({
        reason: clip.verification.reason,
        transcriptExcerpt: clip.transcript.text,
      }, findJob.player))
    : actionClips);
  const uniqueClips = actionClips.length ? [...playerPlays, ...soundbiteClips] : allUniqueClips;
  const editedVersions = await listPackageEditedVersions(projectId);
  const packageModel = buildPackageAssetModel(uniqueClips, editedVersions);
  const packageClips = packageModel.clips;
  const canonicalCandidateIds = new Set(uniqueClips.map((clip) => clip.candidateId));
  const readyMatchCount = manifest.clips.filter((clip) => canonicalCandidateIds.has(clip.candidateId)).length;
  const soundbites = await broadcastSoundbiteStatus(projectId);
  const localDrive = await localDriveProjectInfo(projectId);
  const driveFolderKey = localDrive ? `${resolve(localDrive.folderPath).toLowerCase()}${sep}` : null;
  const syncedClipCount = localDrive
    ? packageModel.allAssets.filter((clip) => {
        if (!clip.drivePath || !existsSync(clip.drivePath)) return false;
        return `${resolve(clip.drivePath).toLowerCase()}`.startsWith(driveFolderKey!);
      }).length
    : 0;
  return {
    ...manifest,
    clips: packageClips,
    savedCopies: packageModel.savedCopies,
    recoverableOriginals: packageModel.recoverableOriginals,
    allAssets: packageModel.allAssets,
    readyMatchCount,
    uniqueClipCount: uniqueClips.length,
    savedCopyCount: packageModel.savedCopies.length,
    packageAssetCount: packageModel.allAssets.length,
    playClipCount: playerPlays.length,
    soundbiteClipCount: soundbiteClips.length,
    soundbites,
    driveSync: localDrive
      ? {
          available: localDrive.available,
          root: localDrive.root,
          folderPath: localDrive.folderPath,
          syncedClipCount,
          pendingClipCount: Math.max(0, packageModel.allAssets.length - syncedClipCount),
        }
      : null,
    preservedMentionClipCount: actionClips.length
      ? allUniqueClips.length - uniqueClips.length
      : 0,
  };
}

export async function syncClipPackageToLocalDrive(projectId: number) {
  const manifest = await openClipPackage(projectId);
  const clips = manifest.allAssets.filter((clip) => clip.localPath && existsSync(clip.localPath));
  if (!clips.length) throw new Error("This project has no finished MP4 files to sync.");
  const files = [...new Set(clips.map((clip) => clip.localPath!))];
  const result = await syncProjectFilesToLocalDrive({ projectId, files });
  const targetBySource = new Map(files.map((source, index) => [source, result.outputPaths[index]!]));
  for (const clip of clips) {
    const target = targetBySource.get(clip.localPath!);
    if (!target) continue;
    if (clip.editedVersion) {
      await setEditedVersionDrivePath(clip.editedVersion.id, target);
    } else {
      await getDb()
        .update(clipJobs)
        .set({ drivePath: target })
        .where(and(eq(clipJobs.candidateFk, clip.candidateId), eq(clipJobs.status, "ready")));
    }
  }
  const refreshed = await openClipPackage(projectId);
  return {
    ok: true as const,
    copied: result.outputPaths.length,
    folderPath: result.folderPath,
    driveSync: refreshed.driveSync,
  };
}

export async function openClipPackageDriveFolder(projectId: number): Promise<boolean> {
  return openLocalDriveProjectFolder(projectId);
}

export async function queueClipPackageExport(input: {
  projectId: number;
  mode: ClipPackageExportMode;
  candidateIds?: number[];
  assetIds?: string[];
  outputDir?: string;
  title?: string;
}): Promise<ClipPackageExportView> {
  const manifest = await openClipPackage(input.projectId);
  const requestedAssetIds = input.assetIds?.length
    ? input.assetIds
    : (input.candidateIds ?? []).map((id) => `candidate:${id}`);
  const selected = selectPackageAssets(manifest.allAssets, requestedAssetIds);
  const now = new Date().toISOString();
  const job: PackageJob = {
    id: randomUUID(),
    projectId: input.projectId,
    mode: input.mode,
    title: safeStudioFileStem(input.title || `${manifest.projectName} clip package`),
    candidateIds: [...new Set(selected.map((clip) => clip.candidateId))],
    assetIds: selected.map((clip) => clip.packageAssetId),
    outputDir: canonicalWindowsDirectory(input.outputDir || defaultClipPackageOutputDir(), true),
    status: "queued",
    progress: 0,
    stage: "Queued",
    outputPaths: [],
    downloadUrls: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    cancelled: false,
    child: null,
  };
  jobs.set(job.id, job);
  queueMicrotask(() => void runExport(job.id));
  return view(job);
}

export function getClipPackageExport(id: string): ClipPackageExportView | null {
  const job = jobs.get(id);
  return job ? view(job) : null;
}

export function cancelClipPackageExport(id: string): boolean {
  const job = jobs.get(id);
  if (!job || !["queued", "preparing", "exporting"].includes(job.status)) return false;
  job.cancelled = true;
  if (job.child?.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(job.child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => job.child?.kill());
  }
  touch(job, { status: "cancelled", stage: "Cancelled", error: null });
  return true;
}

export function selectPackageAssets(clips: PackageClipAsset[], assetIds: string[]): PackageClipAsset[] {
  const requested = [...new Set(assetIds)];
  if (!requested.length || requested.length > 100) throw new Error("Choose between 1 and 100 finished clips.");
  const byId = new Map(clips.map((clip) => [clip.packageAssetId, clip]));
  const selected = requested.map((id) => byId.get(id)).filter((clip): clip is PackageClipAsset => Boolean(clip));
  if (selected.length !== requested.length) {
    throw new Error("One or more selected clips are no longer available. Refresh the package and try again.");
  }
  for (const clip of selected) {
    if (!clip.localPath || !existsSync(clip.localPath) || !statSync(clip.localPath).isFile()) {
      throw new Error(`The finished file for ${clip.game ?? clip.clipId} is offline or missing.`);
    }
  }
  return selected;
}

async function runExport(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job || job.status !== "queued") return;
  try {
    touch(job, { status: "preparing", progress: 3, stage: "Preparing finished clips", error: null });
    const manifest = await openClipPackage(job.projectId);
    const selected = selectPackageAssets(manifest.allAssets, job.assetIds);
    if (job.cancelled) return;
    await mkdir(job.outputDir, { recursive: true });
    if (job.mode === "separate") await exportSeparate(job, selected);
    else await exportJoined(job, selected);
    if (job.cancelled) return;
    touch(job, {
      status: "ready",
      progress: 100,
      stage: job.outputPaths.length === 1 ? "MP4 ready" : `${job.outputPaths.length} MP4 files ready`,
      error: null,
    });
  } catch (error) {
    if (job.cancelled) return;
    touch(job, {
      status: "failed",
      stage: "Export failed",
      error: publicPackageError(error),
    });
  } finally {
    job.child = null;
  }
}

async function exportSeparate(job: PackageJob, clips: ManifestClip[]): Promise<void> {
  const outputPaths: string[] = [];
  for (let index = 0; index < clips.length; index += 1) {
    if (job.cancelled) return;
    const clip = clips[index]!;
    const label = clip.game || `Clip ${index + 1}`;
    touch(job, {
      status: "exporting",
      progress: 8 + (index / clips.length) * 88,
      stage: `Saving clip ${index + 1} of ${clips.length}`,
    });
    const target = uniqueMp4Path(job.outputDir, `${String(index + 1).padStart(2, "0")} ${label}`);
    await copyFile(clip.localPath!, target);
    if (!existsSync(target) || statSync(target).size <= 0) throw new Error("A copied MP4 could not be verified.");
    outputPaths.push(target);
    touch(job, { outputPaths: [...outputPaths] });
  }
}

async function exportJoined(job: PackageJob, clips: ManifestClip[]): Promise<void> {
  touch(job, { status: "preparing", progress: 5, stage: "Checking clip media" });
  const probes = await Promise.all(clips.map((clip) => probeMedia(clip.localPath!)));
  if (job.cancelled) return;
  const targetWidth = even(Math.min(1920, Math.max(640, ...probes.map((probe) => probe.width || 0))));
  const targetHeight = even(Math.min(1080, Math.max(360, ...probes.map((probe) => probe.height || 0))));
  const totalDuration = probes.reduce((sum, probe, index) => sum + positiveDuration(probe.durationSec, clips[index]!.clipDurationSeconds), 0);
  const outputPath = uniqueMp4Path(job.outputDir, job.title);
  touch(job, { status: "exporting", progress: 10, stage: `Combining ${clips.length} clips into one MP4` });

  let run = await runJoinedFfmpeg(job, clips, probes, outputPath, targetWidth, targetHeight, totalDuration, "h264_nvenc");
  if (run.code !== 0 && !job.cancelled) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    touch(job, { progress: 12, stage: "Using Cut IQ software encoder" });
    run = await runJoinedFfmpeg(job, clips, probes, outputPath, targetWidth, targetHeight, totalDuration, "libopenh264");
  }
  if (job.cancelled) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    return;
  }
  if (run.code !== 0 || !existsSync(outputPath) || statSync(outputPath).size <= 0) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw new Error(run.stderr || "Cut IQ could not create the combined MP4.");
  }
  touch(job, { progress: 97, stage: "Verifying combined MP4" });
  const outputProbe = await probeMedia(outputPath);
  if (!outputProbe.width || !outputProbe.height || outputProbe.durationSec <= 0) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw new Error("The combined MP4 did not contain usable video.");
  }
  const tolerance = Math.max(2, totalDuration * 0.04);
  if (Math.abs(outputProbe.durationSec - totalDuration) > tolerance) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw new Error("The combined MP4 duration did not match the selected clips.");
  }
  touch(job, { outputPaths: [outputPath] });
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function positiveDuration(probed: number, fallback: number | null): number {
  if (Number.isFinite(probed) && probed > 0) return probed;
  if (fallback != null && Number.isFinite(fallback) && fallback > 0) return fallback;
  return 1;
}

function buildJoinedArgs(
  clips: ManifestClip[],
  probes: Awaited<ReturnType<typeof probeMedia>>[],
  outputPath: string,
  width: number,
  height: number,
  encoder: "h264_nvenc" | "libopenh264",
): string[] {
  const filters: string[] = [];
  clips.forEach((clip, index) => {
    filters.push(
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v${index}]`,
    );
    if (probes[index]!.hasAudio) {
      filters.push(`[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`);
    } else {
      const duration = positiveDuration(probes[index]!.durationSec, clip.clipDurationSeconds);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`);
    }
  });
  filters.push(`${clips.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
  return [
    "-hide_banner",
    "-y",
    ...clips.flatMap((clip) => ["-i", clip.localPath!]),
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
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
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath,
  ];
}

function runJoinedFfmpeg(
  job: PackageJob,
  clips: ManifestClip[],
  probes: Awaited<ReturnType<typeof probeMedia>>[],
  outputPath: string,
  width: number,
  height: number,
  totalDuration: number,
  encoder: "h264_nvenc" | "libopenh264",
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_PATH, buildJoinedArgs(clips, probes, outputPath, width, height, encoder), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.child = child;
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (job.child === child) job.child = null;
      resolve({ code, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line.trim());
        if (!match || totalDuration <= 0) continue;
        const seconds = Number(match[1]) / 1_000_000;
        const progress = Math.min(95, 10 + (seconds / totalDuration) * 85);
        touch(job, { progress, stage: `Combining ${clips.length} clips · ${Math.round(progress)}%` });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    child.on("error", (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-20_000);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timeout = setTimeout(() => {
      if (child.pid) {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
      finish(1);
    }, 2 * 60 * 60_000);
  });
}

function publicPackageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/space|enospc/i.test(message)) return "The selected drive does not have enough free space.";
  if (/offline|missing|not found|enoent/i.test(message)) return message;
  if (/permission|access is denied|eperm|eacces/i.test(message)) return "Cut IQ cannot write to that folder. Choose another destination.";
  return message.length <= 300 ? message : "Cut IQ could not finish this package export. Choose another destination and try again.";
}

export function openClipPackageOutput(id: string, target: "file" | "folder"): boolean {
  const job = jobs.get(id);
  const output = job?.outputPaths[0];
  if (!job || job.status !== "ready" || !output || !existsSync(output) || extname(output).toLowerCase() !== ".mp4") {
    return false;
  }
  const child = target === "file"
    ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", pathToFileURL(output).href], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn("explorer.exe", [dirname(output)], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return true;
}
