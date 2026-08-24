import { fmtTime } from "./youtube";

export interface ExportMoment {
  title: string;
  note: string | null;
  start: number;
  end: number | null;
  excerpt: string | null;
  color: string;
  status: string;
}

export interface ExportVideo {
  title: string | null;
  url: string;
}

function rows(video: ExportVideo, list: ExportMoment[]) {
  return list.map((m) => {
    const end = m.end ?? m.start;
    return {
      videoTitle: video.title ?? "",
      sourceUrl: video.url,
      start: fmtTime(m.start),
      end: m.end != null ? fmtTime(m.end) : "",
      duration: fmtTime(Math.max(0, end - m.start)),
      excerpt: m.excerpt ?? "",
      note: m.note ?? "",
      label: m.color,
      status: m.status,
      title: m.title,
    };
  });
}

export function toCSV(video: ExportVideo, list: ExportMoment[]): string {
  const r = rows(video, list);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ["Video", "Source URL", "Start", "End", "Duration", "Moment Title", "Transcript Excerpt", "Note", "Label", "Status"];
  return [head.join(","), ...r.map((x) =>
    [x.videoTitle, x.sourceUrl, x.start, x.end, x.duration, x.title, x.excerpt, x.note, x.label, x.status].map(esc).join(","),
  )].join("\n");
}

export function toPremiereCSV(video: ExportVideo, list: ExportMoment[]): string {
  // Premiere-friendly marker CSV: Name, Description, In, Out, Duration, Marker Type
  const r = rows(video, list);
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ["Name", "Description", "In", "Out", "Duration", "Marker Type", "Source"];
  return [head.join(","), ...r.map((x) =>
    [x.title, x.note || x.excerpt, x.start, x.end, x.duration, "Comment", `${x.videoTitle} ${x.sourceUrl}`].map(esc).join(","),
  )].join("\n");
}

export function toJSON(video: ExportVideo, list: ExportMoment[]): string {
  return JSON.stringify({ video: { title: video.title, sourceUrl: video.url }, moments: rows(video, list) }, null, 2);
}

export function toMarkdown(video: ExportVideo, list: ExportMoment[]): string {
  const r = rows(video, list);
  const lines = [
    `# Clip list — ${video.title ?? "Untitled video"}`,
    ``,
    `Source: ${video.url}`,
    ``,
    `| # | In | Out | Duration | Title | Note | Status |`,
    `|---|----|-----|----------|-------|------|--------|`,
    ...r.map((x, i) => `| ${i + 1} | ${x.start} | ${x.end || "—"} | ${x.duration} | ${x.title} | ${x.note.replace(/\|/g, "\\|")} | ${x.status} |`),
  ];
  return lines.join("\n");
}

export function toPlainText(video: ExportVideo, list: ExportMoment[]): string {
  const r = rows(video, list);
  return [
    `Clip list — ${video.title ?? "Untitled video"}`,
    `Source: ${video.url}`,
    ``,
    ...r.map((x, i) => `${i + 1}. [${x.start}${x.end ? ` – ${x.end}` : ""}] ${x.title}${x.note ? ` — ${x.note}` : ""} (${x.status})`),
  ].join("\n");
}

export function downloadFile(name: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
