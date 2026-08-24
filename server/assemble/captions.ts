/**
 * Caption generation (§24) — narration is already transcribed, so captions are
 * a pure formatting concern: timed segments → SRT. Timing comes from the VO
 * transcript; text is editable by the user but we never invent words.
 */

export interface CaptionCue {
  text: string;
  start: number;
  end: number;
}

function srtTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Convert timed narration segments into SRT subtitle text. */
export function segmentsToSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, i) => {
      const text = (cue.text ?? "").trim();
      if (!text || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return null;
      return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${text}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Chunk long narration into readable caption cues (max ~3 lines) while
 * preserving segment timing. Long segments are split at word boundaries and
 * their time window is distributed evenly across the resulting chunks.
 */
export function segmentsToCaptionCues(
  segments: Array<{ text: string; start: number; end: number }>,
  maxChars = 126,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const chunks: string[] = [];
    let current = "";
    for (const word of words) {
      if (current && (current + " " + word).length > maxChars) {
        chunks.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) chunks.push(current);

    const span = (seg.end - seg.start) / chunks.length;
    chunks.forEach((text, i) => {
      cues.push({ text, start: seg.start + i * span, end: seg.start + (i + 1) * span });
    });
  }
  return cues;
}
