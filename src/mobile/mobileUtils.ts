export const ACTIVE_JOB_STATUSES = ["queued", "running", "cancelling"];
export const COMPLETE_JOB_STATUSES = ["completed", "completed_with_warnings"];

export function fmtDuration(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, "0")}`;
}

export function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: "Waiting to start",
    analyzing: "Analyzing coverage",
    discovering: "Discovering sources",
    transcripts: "Getting transcripts",
    ranking: "Ranking moments",
    extracting: "Queueing clips",
    verifying: "Downloading and verifying",
    complete: "Complete",
    failed: "Needs attention",
    cancelled: "Cancelled",
  };
  return labels[stage] ?? stage.replaceAll("_", " ");
}

export function videoIdFromUrl(url: string) {
  return (
    url.match(/[?&]v=([\w-]{11})/)?.[1] ??
    url.match(/youtu\.be\/([\w-]{11})/)?.[1] ??
    null
  );
}

export function downloadHref(url: string) {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("download", "1");
  return `${parsed.pathname}${parsed.search}`;
}

export function mobileClipFileName(title: string | null | undefined, candidateId: number) {
  const stem = (title ?? "Cut IQ clip")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Cut IQ clip";
  return `${stem} - clip ${candidateId}.mp4`;
}
