import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Cut IQ owns its production runtime under the installation root. Operators
 * may override individual paths, but defaults never point into another app or
 * agent installation.
 */
export const CLIPSIFT_APP_ROOT = resolve(process.env.CLIPSIFT_APP_ROOT || process.cwd());
export const CLIPSIFT_INSTALL_ROOT = resolve(process.env.CLIPSIFT_INSTALL_ROOT || join(CLIPSIFT_APP_ROOT, ".."));
export const CLIPSIFT_RUNTIME_ROOT = resolve(process.env.CLIPSIFT_RUNTIME_DIR || join(CLIPSIFT_INSTALL_ROOT, "runtime"));
export const CLIPS_DIR = resolve(process.env.CLIPS_DIR || join(homedir(), "Videos", "Cut IQ Studio", "Clips"));

export const YTDLP_PATH = resolve(process.env.YTDLP_PATH || join(CLIPSIFT_RUNTIME_ROOT, "yt-dlp", "yt-dlp.exe"));
export const FFMPEG_DIR = resolve(process.env.FFMPEG_DIR || join(CLIPSIFT_RUNTIME_ROOT, "ffmpeg"));
export const FFMPEG_PATH = resolve(process.env.FFMPEG_PATH || join(FFMPEG_DIR, "ffmpeg.exe"));
export const FFPROBE_PATH = resolve(process.env.FFPROBE_PATH || join(FFMPEG_DIR, "ffprobe.exe"));
export const WHISPER_PYTHON_PATH = resolve(process.env.CLIPSIFT_WHISPER_PYTHON || join(CLIPSIFT_RUNTIME_ROOT, "python", "python.exe"));
export const WHISPER_MODEL_PATH = resolve(process.env.CLIPSIFT_WHISPER_MODEL || join(CLIPSIFT_RUNTIME_ROOT, "models", "faster-whisper-base"));

export const CLIPSIFT_RUNTIME_PATHS = {
  runtimeRoot: CLIPSIFT_RUNTIME_ROOT,
  ytDlp: YTDLP_PATH,
  ffmpeg: FFMPEG_PATH,
  ffprobe: FFPROBE_PATH,
  whisperPython: WHISPER_PYTHON_PATH,
  whisperModel: WHISPER_MODEL_PATH,
} as const;
