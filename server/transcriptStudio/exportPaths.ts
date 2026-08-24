import { existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, extname, win32 } from "node:path";

const DEVICE_NAMESPACE = /^\\\\[?.]\\/;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

/** Resolve a user-selected Windows folder without routing it through a shell. */
export function canonicalWindowsDirectory(rawPath: string, create = false): string {
  const value = rawPath.trim().replace(/^"|"$/g, "");
  if (!value || hasControlCharacter(value) || DEVICE_NAMESPACE.test(value)) {
    throw new Error("Choose a normal local or network folder for this export.");
  }
  if (!win32.isAbsolute(value)) {
    throw new Error("Choose an absolute Windows folder, such as D:\\Clips or E:\\Exports.");
  }
  const resolved = win32.resolve(value);
  if (create) mkdirSync(resolved, { recursive: true });
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new Error("The selected export destination is not a folder.");
  }
  return resolved;
}

/** Accept only an existing regular local video selected by the user. */
export function canonicalLocalVideoPath(rawPath: string): string {
  const value = rawPath.trim().replace(/^"|"$/g, "");
  if (!value || hasControlCharacter(value) || DEVICE_NAMESPACE.test(value) || !win32.isAbsolute(value)) {
    throw new Error("Choose an existing video using its absolute Windows path.");
  }
  const resolved = win32.resolve(value);
  if (!VIDEO_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    throw new Error("Choose an MP4, MOV, MKV, WebM, M4V, or AVI video file.");
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("The selected local video could not be found.");
  }
  return resolved;
}

export function localVideoPathFromUrl(sourceUrl: string): string | null {
  if (!sourceUrl.startsWith("file:")) return null;
  try {
    return canonicalLocalVideoPath(fileURLToPath(sourceUrl));
  } catch {
    throw new Error("The registered local source is no longer available.");
  }
}

export function safeStudioFileStem(value: string): string {
  const text = [...value]
    .map((character) => character.charCodeAt(0) <= 31 ? " " : character)
    .join("")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "Clip").slice(0, 140);
}

/** Return a non-clobbering MP4 path. Existing user files are never replaced. */
export function uniqueMp4Path(outputDir: string, requestedStem: string): string {
  const directory = canonicalWindowsDirectory(outputDir, true);
  const stem = safeStudioFileStem(requestedStem);
  let candidate = win32.join(directory, `${stem}.mp4`);
  for (let suffix = 2; existsSync(candidate) && suffix < 10_000; suffix += 1) {
    candidate = win32.join(directory, `${stem}-${suffix}.mp4`);
  }
  if (existsSync(candidate)) throw new Error("Cut IQ could not reserve a unique export filename in this folder.");
  return candidate;
}

export function localSourceTitle(filePath: string): string {
  return safeStudioFileStem(basename(filePath, extname(filePath)));
}

export const LOCAL_VIDEO_FILE_FILTER = "Video files (*.mp4;*.mov;*.mkv;*.webm;*.m4v;*.avi)|*.mp4;*.mov;*.mkv;*.webm;*.m4v;*.avi";

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= 31);
}
