import type { RawSegment } from "./provider";

// Parse .srt, .vtt, and plain timestamped text into segments.

function toSeconds(ts: string): number | null {
  const m = ts.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
  return h * 3600 + min * 60 + s + ms / 1000;
}

export function parseSrt(content: string): RawSegment[] {
  const blocks = content.replace(/\r/g, "").split(/\n\s*\n/);
  const out: RawSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx === -1) continue;
    const [a, b] = lines[timeIdx].split("-->");
    const start = toSeconds(a);
    const end = toSeconds(b ?? "");
    const text = lines.slice(timeIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (start != null && text) out.push({ text, start, end: end ?? start + 2 });
  }
  return out;
}

export function parseVtt(content: string): RawSegment[] {
  return parseSrt(
    content.replace(/^WEBVTT[^\n]*\n/i, "").replace(/^NOTE[\s\S]*?(?=\n\s*\n)/gm, ""),
  );
}

// Plain text with timestamps: "12:34 some words" or "[00:12:34] words" per line
export function parseTimestampedText(content: string): RawSegment[] {
  const out: RawSegment[] = [];
  const lines = content.replace(/\r/g, "").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.+)$/);
    if (!m) continue;
    const start = toSeconds(m[1]);
    if (start != null) out.push({ text: m[2].trim(), start, end: start });
  }
  for (let i = 0; i < out.length; i++) {
    out[i].end = i < out.length - 1 ? out[i + 1].start : out[i].start + 4;
  }
  return out;
}

export function parseImportedTranscript(
  format: "srt" | "vtt" | "text",
  content: string,
): RawSegment[] {
  const segs =
    format === "srt" ? parseSrt(content) : format === "vtt" ? parseVtt(content) : parseTimestampedText(content);
  if (!segs.length) {
    throw new Error(
      "No timestamped lines found. Check the file format — .srt, .vtt, or lines like '12:34 text'.",
    );
  }
  return segs;
}
