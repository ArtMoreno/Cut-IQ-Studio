import { basename } from "node:path";

export function packageVersionDownloadName(file: string): string {
  return basename(file).replace(/[\u0000-\u001f\u007f"\\]/g, " ").trim() || "Cut IQ-revised-clip.mp4";
}

export function packageVersionContentDisposition(file: string, download: boolean): string {
  if (!download) return "inline";
  return `attachment; filename*=UTF-8''${encodeURIComponent(packageVersionDownloadName(file))}`;
}
