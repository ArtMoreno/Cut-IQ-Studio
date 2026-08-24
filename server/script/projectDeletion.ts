import { existsSync } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { inArray } from "drizzle-orm";
import {
  assembleProjects,
  clipCandidates,
  clipJobs,
  clipPackageEditVersions,
  findJobs,
  findSources,
  scriptBeats,
  scriptProjects,
  scriptRevisions,
  transcriptStudioExports,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { clipConfig } from "../clip/engine";

const ACTIVE_FIND_STATUSES = new Set(["queued", "running", "cancelling"]);
const ACTIVE_CLIP_STATUSES = new Set(["queued", "downloading", "uploading"]);

type ProjectRow = typeof scriptProjects.$inferSelect;
type ClipJobRow = typeof clipJobs.$inferSelect;
type EditVersionRow = typeof clipPackageEditVersions.$inferSelect;
type StudioExportRow = typeof transcriptStudioExports.$inferSelect;

function normalizeIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

export function parseStudioOutputPaths(row: Pick<StudioExportRow, "outputPath" | "outputPaths">): string[] {
  const paths = new Set<string>();
  if (row.outputPath) paths.add(row.outputPath);
  if (row.outputPaths) {
    try {
      const parsed = JSON.parse(row.outputPaths);
      if (Array.isArray(parsed)) {
        for (const value of parsed) if (typeof value === "string" && value.trim()) paths.add(value);
      }
    } catch {
      // A malformed historic value must not broaden deletion scope.
    }
  }
  return [...paths];
}

export function pathIsInside(root: string, candidate: string): boolean {
  const canonicalRoot = resolve(root);
  const canonicalCandidate = resolve(candidate);
  const fromRoot = relative(canonicalRoot, canonicalCandidate);
  return !!fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

type LoadedDeletion = {
  ids: number[];
  projects: ProjectRow[];
  allClipJobs: ClipJobRow[];
  selectedClipJobs: ClipJobRow[];
  allVersions: EditVersionRow[];
  selectedVersions: EditVersionRow[];
  selectedStudioExports: StudioExportRow[];
  exclusiveStudioExportIds: number[];
  activeProjectNames: string[];
};

async function loadDeletion(idsInput: number[]): Promise<LoadedDeletion> {
  const ids = normalizeIds(idsInput);
  if (!ids.length) throw new Error("Select at least one project.");
  const db = getDb();
  const [projects, allClipJobs, allVersions, allStudioExports, selectedFindJobs] = await Promise.all([
    db.select().from(scriptProjects).where(inArray(scriptProjects.id, ids)),
    db.select().from(clipJobs),
    db.select().from(clipPackageEditVersions),
    db.select().from(transcriptStudioExports),
    db.select().from(findJobs).where(inArray(findJobs.projectFk, ids)),
  ]);
  if (projects.length !== ids.length) throw new Error("One or more selected projects no longer exist. Refresh and try again.");
  const selected = new Set(ids);
  const selectedClipJobs = allClipJobs.filter((row) => row.projectFk != null && selected.has(Number(row.projectFk)));
  const selectedVersions = allVersions.filter((row) => selected.has(Number(row.projectFk)));
  const unselectedStudioIds = new Set(
    allVersions
      .filter((row) => !selected.has(Number(row.projectFk)) && row.studioExportFk != null)
      .map((row) => Number(row.studioExportFk)),
  );
  const exclusiveStudioExportIds = [...new Set(
    selectedVersions
      .filter((row) => row.studioExportFk != null && !unselectedStudioIds.has(Number(row.studioExportFk)))
      .map((row) => Number(row.studioExportFk)),
  )];
  const exclusiveStudioSet = new Set(exclusiveStudioExportIds);
  const selectedStudioExports = allStudioExports.filter((row) => exclusiveStudioSet.has(Number(row.id)));
  const activeIds = new Set<number>();
  for (const row of selectedFindJobs) if (ACTIVE_FIND_STATUSES.has(row.status)) activeIds.add(Number(row.projectFk));
  for (const row of selectedClipJobs) if (ACTIVE_CLIP_STATUSES.has(row.status) && row.projectFk != null) activeIds.add(Number(row.projectFk));
  return {
    ids,
    projects,
    allClipJobs,
    selectedClipJobs,
    allVersions,
    selectedVersions,
    selectedStudioExports,
    exclusiveStudioExportIds,
    activeProjectNames: projects.filter((row) => activeIds.has(Number(row.id))).map((row) => row.name),
  };
}

type PhysicalTarget = { path: string; kind: "local" | "drive" };

function physicalTargets(loaded: LoadedDeletion): PhysicalTarget[] {
  const selected = new Set(loaded.ids);
  const referencedElsewhere = new Set<string>();
  const remember = (value: string | null) => {
    if (value && isAbsolute(value)) referencedElsewhere.add(resolve(value).toLowerCase());
  };
  for (const row of loaded.allClipJobs) {
    if (row.projectFk == null || !selected.has(Number(row.projectFk))) {
      remember(row.outputPath);
      remember(row.drivePath);
    }
  }
  for (const row of loaded.allVersions) {
    if (!selected.has(Number(row.projectFk))) remember(row.drivePath);
  }

  const targets = new Map<string, PhysicalTarget>();
  const add = (value: string | null) => {
    if (!value || !isAbsolute(value)) return;
    const absolute = resolve(value);
    const key = absolute.toLowerCase();
    if (referencedElsewhere.has(key)) return;
    const kind = clipConfig.LOCAL_GOOGLE_DRIVE_ROOT && pathIsInside(clipConfig.LOCAL_GOOGLE_DRIVE_ROOT, absolute)
      ? "drive"
      : pathIsInside(clipConfig.CLIPS_DIR, absolute)
        ? "local"
        : null;
    if (!kind) throw new Error(`Refusing to delete a clip outside Cut IQ's managed folders: ${absolute}`);
    targets.set(key, { path: absolute, kind });
  };
  for (const row of loaded.selectedClipJobs) {
    add(row.outputPath);
    add(row.drivePath);
  }
  for (const row of loaded.selectedVersions) add(row.drivePath);
  for (const row of loaded.selectedStudioExports) for (const path of parseStudioOutputPaths(row)) add(path);
  return [...targets.values()];
}

function remoteProjectIds(loaded: LoadedDeletion): number[] {
  const remote = new Set<number>();
  for (const row of loaded.selectedClipJobs) {
    if (row.projectFk == null) continue;
    if (row.uploadToDrive || (row.drivePath && !isAbsolute(row.drivePath))) remote.add(Number(row.projectFk));
  }
  return [...remote];
}

export function rclonePurgeTargetIsAlreadyAbsent(stderr: string): boolean {
  return /(?:directory|path|object) not found/i.test(stderr);
}

function rcloneCleanupFailureMessage(): string {
  return "Google Drive cleanup could not complete. Check that Google Drive is connected, then try again.";
}

async function runRclone(args: string[]): Promise<void> {
  if (!clipConfig.RCLONE) {
    throw new Error("Google Drive cleanup needs rclone, but no rclone executable is configured.");
  }
  if (isAbsolute(clipConfig.RCLONE) && !existsSync(clipConfig.RCLONE)) {
    throw new Error("Google Drive cleanup needs rclone, but Cut IQ's configured rclone executable is unavailable.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(clipConfig.RCLONE, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", () => reject(new Error(rcloneCleanupFailureMessage())));
    child.once("close", (code) => {
      if (code === 0 || rclonePurgeTargetIsAlreadyAbsent(stderr)) {
        resolvePromise();
        return;
      }
      reject(new Error(rcloneCleanupFailureMessage()));
    });
  });
}

async function deletePhysicalFile(target: PhysicalTarget): Promise<boolean> {
  try {
    const info = await lstat(target.path);
    if (!info.isFile()) throw new Error(`Refusing to delete a non-file clip target: ${target.path}`);
    await unlink(target.path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

export async function getProjectDeletionPreview(ids: number[]) {
  const loaded = await loadDeletion(ids);
  const physical = physicalTargets(loaded);
  return {
    projectCount: loaded.projects.length,
    projectNames: loaded.projects.map((row) => row.name),
    localFileCount: physical.filter((row) => row.kind === "local").length,
    driveFileCount: physical.filter((row) => row.kind === "drive").length,
    remoteFolderCount: remoteProjectIds(loaded).length,
    activeProjectNames: loaded.activeProjectNames,
  };
}

export async function deleteProjectsAndClips(ids: number[]) {
  const loaded = await loadDeletion(ids);
  if (loaded.activeProjectNames.length) {
    throw new Error(`Stop or cancel active work before deleting: ${loaded.activeProjectNames.join(", ")}`);
  }
  const physical = physicalTargets(loaded);
  const remoteIds = remoteProjectIds(loaded);

  // Project IDs make these remote folders collision-safe. Database rows stay
  // intact if Drive or physical cleanup fails, so the operation can be retried.
  for (const id of remoteIds) {
    await runRclone(["purge", `gdrive:${clipConfig.DRIVE_ROOT}/project-${id}`]);
  }

  let deletedLocalFiles = 0;
  let deletedDriveFiles = 0;
  for (const target of physical) {
    if (!(await deletePhysicalFile(target))) continue;
    if (target.kind === "drive") deletedDriveFiles += 1;
    else deletedLocalFiles += 1;
  }

  const db = getDb();
  await db.transaction(async (tx) => {
    if (loaded.exclusiveStudioExportIds.length) {
      await tx.delete(transcriptStudioExports).where(inArray(transcriptStudioExports.id, loaded.exclusiveStudioExportIds));
    }
    await tx.delete(clipPackageEditVersions).where(inArray(clipPackageEditVersions.projectFk, loaded.ids));
    await tx.delete(clipJobs).where(inArray(clipJobs.projectFk, loaded.ids));
    await tx.delete(findSources).where(inArray(findSources.projectFk, loaded.ids));
    await tx.delete(findJobs).where(inArray(findJobs.projectFk, loaded.ids));
    await tx.delete(clipCandidates).where(inArray(clipCandidates.projectFk, loaded.ids));
    await tx.delete(scriptBeats).where(inArray(scriptBeats.projectFk, loaded.ids));
    await tx.delete(scriptRevisions).where(inArray(scriptRevisions.projectFk, loaded.ids));
    await tx.update(assembleProjects).set({ sourceProjectFk: null }).where(inArray(assembleProjects.sourceProjectFk, loaded.ids));
    await tx.delete(scriptProjects).where(inArray(scriptProjects.id, loaded.ids));
  });

  return {
    projectCount: loaded.projects.length,
    deletedLocalFiles,
    deletedDriveFiles,
    deletedRemoteFolders: remoteIds.length,
  };
}
