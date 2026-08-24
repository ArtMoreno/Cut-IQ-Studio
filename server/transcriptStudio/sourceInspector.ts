import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { extractVideoId } from "../clipsift";
import { normalizeYouTubeUrl } from "@/lib/transcriptStudio";
import { YTDLP_PATH as YTDLP } from "../runtimePaths";

export type SourceInspection = {
  videoId: string;
  canonicalUrl: string;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  durationSec: number | null;
  sourceHeight: number | null;
  availableHeights: number[];
  recommendedHeight: 720 | 1080 | null;
  isLive: boolean;
};

export type SourceInspectionCode =
  | "BAD_URL"
  | "UNAVAILABLE"
  | "PRIVATE"
  | "REGION"
  | "LOGIN_REQUIRED"
  | "LIVESTREAM"
  | "NO_MEDIA"
  | "NETWORK"
  | "CANCELLED"
  | "TOOLING"
  | "UNKNOWN";

export class SourceInspectionError extends Error {
  readonly code: SourceInspectionCode;

  constructor(
    code: SourceInspectionCode,
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

type YtDlpFormat = {
  height?: number | null;
  vcodec?: string | null;
};

type YtDlpInfo = {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  thumbnail?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  formats?: YtDlpFormat[];
};

const activeInspections = new Map<string, ChildProcess>();

/**
 * Inspect a public YouTube source using structured argv. No user-controlled
 * value is ever passed through a shell command string.
 */
export async function inspectYouTubeSource(rawUrl: string, jobId: string): Promise<SourceInspection> {
  const normalized = normalizeYouTubeUrl(rawUrl);
  if (!normalized.ok) {
    throw new SourceInspectionError(
      "BAD_URL",
      normalized.message,
    );
  }
  const videoId = extractVideoId(normalized.canonicalUrl);
  if (!videoId) throw new SourceInspectionError("BAD_URL", "Paste a valid YouTube watch, youtu.be, Shorts, or live URL.");
  if (!existsSync(YTDLP)) {
    throw new SourceInspectionError("TOOLING", "Cut IQ's YouTube source tool is unavailable. Check the local yt-dlp installation.");
  }

  const canonicalUrl = normalized.canonicalUrl;
  const stdout = await runInspector(canonicalUrl, jobId);
  let info: YtDlpInfo;
  try {
    info = JSON.parse(stdout) as YtDlpInfo;
  } catch {
    throw new SourceInspectionError("UNKNOWN", "YouTube returned source information that Cut IQ could not read. Retry the load.");
  }

  if (info.is_live && info.live_status !== "was_live" && info.live_status !== "post_live") {
    throw new SourceInspectionError("LIVESTREAM", "This livestream is not available for clipping yet. Try again after it becomes a replay.");
  }

  const availableHeights = [...new Set(
    (info.formats ?? [])
      .filter((format) => format.vcodec && format.vcodec !== "none" && Number.isFinite(format.height))
      .map((format) => Math.floor(format.height!)),
  )].sort((a, b) => b - a);
  const sourceHeight = availableHeights[0] ?? null;
  if (!sourceHeight) {
    throw new SourceInspectionError("NO_MEDIA", "No playable video format is available for this source.");
  }

  return {
    videoId: info.id && /^[\w-]{11}$/.test(info.id) ? info.id : videoId,
    canonicalUrl,
    title: cleanText(info.title),
    channel: cleanText(info.channel ?? info.uploader),
    thumbnail: cleanText(info.thumbnail) ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSec: Number.isFinite(info.duration) && info.duration! > 0 ? info.duration! : null,
    sourceHeight,
    availableHeights,
    recommendedHeight: sourceHeight >= 1080 ? 1080 : sourceHeight >= 720 ? 720 : null,
    isLive: Boolean(info.is_live),
  };
}

/** Stop an in-flight source-inspection process, if it is still running. */
export function cancelSourceInspection(jobId: string): boolean {
  const child = activeInspections.get(jobId);
  if (!child) return false;
  terminateProcessTree(child);
  return true;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function runInspector(canonicalUrl: string, jobId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = execFile(
      YTDLP,
      ["--js-runtimes", "node", "--no-playlist", "--skip-download", "--dump-single-json", canonicalUrl],
      { windowsHide: true, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, childStderr) => {
        activeInspections.delete(jobId);
        stderr = `${stderr}${String(childStderr ?? "")}`;
        if (error) {
          reject(classifyInspectionFailure(stderr || error.message, error.killed));
          return;
        }
        resolve(String(stdout));
      },
    );
    activeInspections.set(jobId, child);
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      activeInspections.delete(jobId);
      reject(classifyInspectionFailure(error.message, false));
    });
  });
}

/** Kill exactly the tracked source-inspection tree without invoking a shell. */
function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.unref();
      return;
    } catch {
      // Direct kill below is a safe fallback when taskkill cannot launch.
    }
  }
  try { child.kill(); } catch { /* process may already be gone */ }
}

function classifyInspectionFailure(raw: string, killed: boolean | undefined): SourceInspectionError {
  if (killed) return new SourceInspectionError("CANCELLED", "Source inspection was cancelled.");
  const text = raw.toLowerCase();
  if (/private video|this video is private/.test(text)) return new SourceInspectionError("PRIVATE", "This video is private and cannot be loaded.");
  if (/sign in|login required|confirm your age|members-only/.test(text)) return new SourceInspectionError("LOGIN_REQUIRED", "This video requires a YouTube login and cannot be processed by Cut IQ.");
  if (/not available in your country|not available in this country|geo.?restricted/.test(text)) return new SourceInspectionError("REGION", "This video is region-restricted and cannot be processed here.");
  if (/video unavailable|has been removed|does not exist/.test(text)) return new SourceInspectionError("UNAVAILABLE", "This video is unavailable or has been deleted.");
  if (/no video formats|requested format is not available|no supported formats/.test(text)) return new SourceInspectionError("NO_MEDIA", "No acceptable downloadable video format is available.");
  if (/timed out|network|connection|http error|unable to download/.test(text)) return new SourceInspectionError("NETWORK", "Cut IQ could not reach YouTube. Check your connection and retry.");
  if (/enoent|not found/.test(text)) return new SourceInspectionError("TOOLING", "Cut IQ's YouTube source tool could not be started.");
  return new SourceInspectionError("UNKNOWN", "Cut IQ could not inspect this YouTube source. Retry the load or use another video.");
}
