import { constants } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { findJobs, scriptProjects } from "@db/schema";
import { getDb } from "../queries/connection";

export const LOCAL_GOOGLE_DRIVE_ROOT = process.env.CLIPSIFT_LOCAL_GOOGLE_DRIVE_ROOT
  ? resolve(process.env.CLIPSIFT_LOCAL_GOOGLE_DRIVE_ROOT)
  : "";

function replaceInvalidWindowsCharacters(value: string): string {
  return [...value]
    .map((character) => character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .replace(/[<>:"/\\|?*]/g, "-");
}

export function safeDriveProjectName(value: string): string {
  return replaceInvalidWindowsCharacters(value)
    .replace(/[•·]+/g, " - ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 140) || "Cut IQ Project";
}

export function safeDriveFileName(value: string): string {
  const extension = ".mp4";
  const stem = replaceInvalidWindowsCharacters(basename(value, extname(value)))
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180) || "clip";
  return `${stem}${extension}`;
}

export function localDriveProjectFolder(root: string, projectName: string): string {
  const canonicalRoot = resolve(root);
  const folder = resolve(canonicalRoot, safeDriveProjectName(projectName));
  const fromRoot = relative(canonicalRoot, folder);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Could not resolve a safe Google Drive project folder.");
  }
  return folder;
}

export function localDriveRootAvailable(root = LOCAL_GOOGLE_DRIVE_ROOT): boolean {
  if (!root) return false;
  try {
    return existsSync(root) && statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function uniqueTarget(folder: string, fileName: string, sourceSize: number): string {
  const safeName = safeDriveFileName(fileName);
  const direct = join(folder, safeName);
  if (!existsSync(direct)) return direct;
  try {
    if (statSync(direct).isFile() && statSync(direct).size === sourceSize) return direct;
  } catch {
    // Google Drive may be refreshing the directory; try a collision-safe name.
  }
  const extension = extname(safeName);
  const stem = basename(safeName, extension);
  for (let index = 2; index < 1_000; index++) {
    const candidate = join(folder, `${stem}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
    try {
      if (statSync(candidate).isFile() && statSync(candidate).size === sourceSize) return candidate;
    } catch {
      // Continue to the next collision-safe name.
    }
  }
  throw new Error("The Google Drive project folder has too many files with the same name.");
}

export async function copyMp4ToLocalGoogleDrive(input: {
  sourcePath: string;
  projectName: string;
  root?: string;
}): Promise<string> {
  const configuredRoot = input.root || LOCAL_GOOGLE_DRIVE_ROOT;
  if (!configuredRoot) throw new Error("Google Drive for desktop is not configured.");
  const root = resolve(configuredRoot);
  if (!localDriveRootAvailable(root)) {
    throw new Error(`Google Drive for desktop is not available at ${root}.`);
  }
  const source = resolve(input.sourcePath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile() || sourceStat.size <= 0 || extname(source).toLowerCase() !== ".mp4") {
    throw new Error("Only a finished MP4 can be copied to Google Drive.");
  }
  const folder = localDriveProjectFolder(root, input.projectName);
  await mkdir(folder, { recursive: true });
  const target = uniqueTarget(folder, basename(source), sourceStat.size);
  if (!existsSync(target)) await copyFile(source, target, constants.COPYFILE_EXCL);
  const targetStat = await stat(target);
  if (!targetStat.isFile() || targetStat.size !== sourceStat.size) {
    throw new Error("The Google Drive copy could not be verified.");
  }
  return target;
}

export async function localDriveProjectInfo(projectId: number) {
  const db = getDb();
  const [findJob] = await db.select().from(findJobs).where(eq(findJobs.projectFk, projectId)).limit(1);
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId)).limit(1);
  if (!findJob || !project || !LOCAL_GOOGLE_DRIVE_ROOT) return null;
  return {
    projectName: project.name,
    root: LOCAL_GOOGLE_DRIVE_ROOT,
    folderPath: localDriveProjectFolder(LOCAL_GOOGLE_DRIVE_ROOT, project.name),
    available: localDriveRootAvailable(),
  };
}

export async function syncFinishedFindClip(input: {
  projectId: number;
  sourcePath: string;
}): Promise<string | null> {
  const info = await localDriveProjectInfo(input.projectId);
  if (!info) return null;
  return copyMp4ToLocalGoogleDrive({
    sourcePath: input.sourcePath,
    projectName: info.projectName,
    root: info.root,
  });
}

export async function syncProjectFilesToLocalDrive(input: {
  projectId: number;
  files: string[];
}) {
  const info = await localDriveProjectInfo(input.projectId);
  if (!info) throw new Error("This is not a Find Clips project.");
  if (!info.available) throw new Error(`Google Drive for desktop is not available at ${info.root}.`);
  const outputPaths: string[] = [];
  for (const sourcePath of [...new Set(input.files)]) {
    outputPaths.push(await copyMp4ToLocalGoogleDrive({
      sourcePath,
      projectName: info.projectName,
      root: info.root,
    }));
  }
  return { ...info, outputPaths };
}

export async function openLocalDriveProjectFolder(projectId: number): Promise<boolean> {
  const info = await localDriveProjectInfo(projectId);
  if (!info || !existsSync(info.folderPath)) return false;
  const child = spawn("explorer.exe", [info.folderPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return true;
}
