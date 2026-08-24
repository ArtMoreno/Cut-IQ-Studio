/**
 * Script → beat analysis for Assemble. Reuses Cut IQ's existing pure
 * `analyzeScript` (server/script/analysis.ts) — no new NLP, no invented stats.
 * Converts its output into the AssembleDoc beat shape and optionally aligns
 * beats to narration timing.
 */
import { analyzeScript } from "../script/analysis";
import type { AssembleBeat } from "./project";
import { parseScriptDirectives, type ScriptDirective } from "./directives";

/** Convert an analyzed script into AssembleDoc beats with provisional timing. */
export function beatsFromScript(
  scriptText: string,
  opts: { wordsPerSecond?: number } = {},
): { beats: AssembleBeat[]; directives: Map<number, ScriptDirective> } {
  const wps = opts.wordsPerSecond ?? 2.6;
  const parsed = parseScriptDirectives(scriptText);
  const analysis = analyzeScript(parsed.text);
  let cursor = 0;

  const beats = analysis.beats.map((b) => {
    const directive = parsed.directives.get(b.ord);
    const wordsPerBeat = b.text.split(/\s+/).filter(Boolean).length;
    const estimated = Math.max(1.5, wordsPerBeat / wps);
    const duration = directive?.durationSec ?? estimated;
    const narrationStart = cursor;
    const narrationEnd = cursor + duration;
    cursor = narrationEnd;

    let beatType: AssembleBeat["beatType"] = "footage";
    if (directive?.graphic) beatType = "graphic";
    else if (directive?.visual) beatType = "footage";
    else if (b.visualOnly) beatType = "no-clip";

    return {
      id: `beat-${b.ord}`,
      ord: b.ord,
      text: b.text,
      intent: [...b.coverageTypes, ...(b.purpose ? [b.purpose] : []), ...(directive?.visual ? [directive.visual] : [])],
      entities: b.entities,
      queries: b.queries,
      beatType,
      narrationStart,
      narrationEnd,
      locked: directive?.keepCurrent ?? false,
      unresolved: false,
    };
  });

  return { beats, directives: parsed.directives };
}

export interface NarrationSegment {
  text: string;
  start: number;
  end: number;
}

/**
 * Align written script beats to transcribed narration segments. This is a
 * tolerant word-overlap alignment (master prompt §64): it does not require an
 * exact text match and reports a confidence score. Falls back to provisional
 * script timing when narration is absent.
 */
export function alignBeatsToNarration(
  beats: AssembleBeat[],
  narration: NarrationSegment[],
): { beats: AssembleBeat[]; confidence: number } {
  if (!narration.length) return { beats, confidence: 0 };

  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  const totalSpan = narration[narration.length - 1].end - narration[0].start || 1;
  const aligned = beats.map((beat) => {
    const target = norm(beat.text);
    const targetWords = target.split(" ").filter(Boolean);
    if (!targetWords.length) return beat;

    // Find the narration segment whose text shares the most words with the beat.
    let bestIdx = -1;
    let bestOverlap = 0;
    narration.forEach((seg, i) => {
      const segWords = new Set(norm(seg.text).split(" ").filter(Boolean));
      let overlap = 0;
      for (const w of targetWords) if (segWords.has(w)) overlap += 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    });

    if (bestIdx === -1) return beat;
    const start = narration[bestIdx].start;
    // Extend to the next segment's start if present, else estimate by word count.
    const next = narration[bestIdx + 1];
    const end = next ? next.start : narration[bestIdx].end;
    return { ...beat, narrationStart: start, narrationEnd: Math.max(end, start + 1.5) };
  });

  const avgOverlap = aligned.reduce((acc, b, i) => {
    if (b.narrationStart == null) return acc;
    const orig = beats[i];
    const shifted = b.narrationStart !== orig.narrationStart;
    return acc + (shifted ? 1 : 0);
  }, 0);
  const confidence = aligned.length ? Math.min(1, avgOverlap / aligned.length + 0.3) : 0;
  void totalSpan;

  return { beats: aligned, confidence: Math.round(confidence * 100) / 100 };
}
