/**
 * Optional script directives (§29) — lightweight non-spoken markers the creator
 * can add for explicit control. Normal prose works without them; these only
 * nudge the assembler. Directives are stripped from narration/caption text.
 *
 * Supported:
 *   [visual: broken tackle]   prefer clips matching this visual concept
 *   [prefer: Louisville]      prefer clips from this game/team
 *   [duration: 7s]            target beat length (seconds)
 *   [use-two-clips]           allow splitting this beat across two clips
 *   [graphic]                 this beat is a title/stat card, not footage
 *   [keep-current]            don't replace this beat on reassembly
 */

export interface ScriptDirective {
  visual?: string;
  prefer?: string;
  durationSec?: number;
  useTwoClips?: boolean;
  graphic?: boolean;
  keepCurrent?: boolean;
}

export interface ParsedScript {
  /** script text with all directive lines removed */
  text: string;
  /** directives keyed by the beat index they precede (0-based, in original order) */
  directives: Map<number, ScriptDirective>;
}

const DIRECTIVE_LINE = /^\s*\[(visual|prefer|duration|use-two-clips|graphic|keep-current)\s*:?\s*([^\]]*)\]\s*$/i;

function parseDuration(value: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)/.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Strip directive lines from a script and return the clean text + directives
 * mapped to their preceding beat position. A directive applies to the next
 * non-directive content that follows it.
 */
export function parseScriptDirectives(script: string): ParsedScript {
  const directives = new Map<number, ScriptDirective>();
  const kept: string[] = [];
  let beatIndex = -1;
  let pending: ScriptDirective | null = null;

  const lines = script.replace(/\r/g, "").split("\n");
  for (const raw of lines) {
    const line = raw.trimEnd();
    const directiveMatch = DIRECTIVE_LINE.exec(line);
    if (directiveMatch) {
      const key = directiveMatch[1].toLowerCase();
      const value = directiveMatch[2].trim();
      pending = pending ?? {};
      if (key === "visual") pending.visual = value || undefined;
      else if (key === "prefer") pending.prefer = value || undefined;
      else if (key === "duration") pending.durationSec = parseDuration(value);
      else if (key === "use-two-clips") pending.useTwoClips = true;
      else if (key === "graphic") pending.graphic = true;
      else if (key === "keep-current") pending.keepCurrent = true;
      continue;
    }
    kept.push(raw);
    const trimmed = line.trim();
    if (!trimmed) {
      // a blank line ends the current beat context but a pending directive may
      // still target the next paragraph; keep it.
      continue;
    }
    // A new content line begins the next beat.
    beatIndex += 1;
    if (pending) {
      directives.set(beatIndex, pending);
      pending = null;
    }
  }

  return { text: kept.join("\n"), directives };
}
