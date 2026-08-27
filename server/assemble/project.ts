/**
 * Assemble project model — a versioned, nondestructive edit-decision model.
 *
 * The canonical edit is a JSON document (stored in SQLite, exportable to disk),
 * NOT a CMX3600/EDL and NOT a concat-demuxer recipe. FFmpeg is the render
 * backend; this document is the project. (Master prompt §69/§75.)
 *
 * Every timeline item references media + source in/out + timeline window and
 * carries the matching provenance so an automatic edit is auditable and every
 * decision is reversible.
 */

export const ASSEMBLE_DOC_SCHEMA_VERSION = 1;

export type Track = "V1" | "V2" | "A1" | "A2" | "A3";
export type PresetId = "vertical-9x16" | "youtube-16x9" | "square";
export type ClipSourceMode = "action" | "replay" | "full-play" | "generic";

export interface SequenceSettings {
  width: number;
  height: number;
  fps: number;
  preset: PresetId;
}

export const PRESETS: Record<PresetId, SequenceSettings> = {
  "vertical-9x16": { width: 1080, height: 1920, fps: 30, preset: "vertical-9x16" },
  "youtube-16x9": { width: 1920, height: 1080, fps: 30, preset: "youtube-16x9" },
  square: { width: 1080, height: 1080, fps: 30, preset: "square" },
};

export interface AssembleBeat {
  id: string; // "beat-<ord>"
  ord: number;
  text: string;
  intent: string[];
  entities: string[]; // people/teams extracted from the beat text
  queries: string[]; // budgeted search queries (from analyzeScript)
  beatType: "footage" | "graphic" | "montage" | "no-clip";
  narrationStart: number | null; // VO-aligned window (null = script-estimated)
  narrationEnd: number | null;
  locked: boolean;
  unresolved: boolean;
}

export interface TimelineItem {
  id: string; // "item-<n>"
  clipId: string | null; // manifest clip id (null for graphics)
  track: Track;
  timelineStart: number;
  timelineEnd: number;
  sourcePath: string | null;
  sourceIn: number | null;
  sourceOut: number | null;
  beatId: string | null;
  matchConfidence: number | null;
  matchReason: string[];
  locked: boolean;
  unresolved: boolean;
  sourceMode: ClipSourceMode | null;
  gain: number;
  // vertical crop/scale (v1: fit / fill / center-crop + manual X/Y)
  cropMode: "fit" | "fill" | "crop" | null;
  cropX: number; // normalized -0.5..0.5 pan (0 = center)
  cropY: number;
  // simple graphics (only when clipId == null)
  graphic?: {
    kind: "title" | "lower-third" | "stat" | "caption";
    text: string;
    subtext?: string;
  };
}

export interface AssembleDoc {
  schemaVersion: number;
  name: string;
  settings: SequenceSettings;
  scriptText: string | null;
  beats: AssembleBeat[];
  narration: {
    sourcePath: string | null;
    aligned: boolean;
    confidence: number | null;
    /** timed narration segments (for captions) — from VO transcription */
    segments: Array<{ text: string; start: number; end: number }> | null;
  } | null;
  items: TimelineItem[];
  locked: { noReuse: boolean; preferredGame: string | null };
}

export function defaultDoc(name: string, preset: PresetId = "vertical-9x16", scriptText: string | null = null): AssembleDoc {
  return {
    schemaVersion: ASSEMBLE_DOC_SCHEMA_VERSION,
    name,
    settings: { ...PRESETS[preset] },
    scriptText,
    beats: [],
    narration: null,
    items: [],
    locked: { noReuse: false, preferredGame: null },
  };
}

/** Validate a doc object came from us; returns the doc or throws. */
export function parseAssembleDoc(raw: unknown, name: string): AssembleDoc {
  if (!raw || typeof raw !== "object") throw new Error("Assemble project data is invalid.");
  const doc = raw as Partial<AssembleDoc>;
  if (doc.schemaVersion !== ASSEMBLE_DOC_SCHEMA_VERSION) {
    throw new Error(`Unsupported Assemble project schema (expected ${ASSEMBLE_DOC_SCHEMA_VERSION}).`);
  }
  if (!Array.isArray(doc.beats) || !Array.isArray(doc.items)) {
    throw new Error("Assemble project is missing its beats or timeline.");
  }
  const preset: PresetId = doc.settings?.preset && doc.settings.preset in PRESETS ? doc.settings.preset : "vertical-9x16";
  return {
    ...defaultDoc(name, preset, doc.scriptText ?? null),
    ...doc,
    settings: { ...PRESETS[preset] },
    beats: doc.beats as AssembleBeat[],
    items: doc.items as TimelineItem[],
  };
}

/** Collapse a timeline item list into ordered, non-negative, contiguous edits. */
export function normalizeTimeline(items: TimelineItem[]): TimelineItem[] {
  return items
    .filter((i) => i.timelineEnd > i.timelineStart)
    .sort((a, b) => a.timelineStart - b.timelineStart)
    .map((i, idx) => ({ ...i, id: i.id || `item-${idx}` }));
}

/** Total timeline duration (max item end, floor 0). */
export function timelineDuration(items: TimelineItem[]): number {
  return items.reduce((max, i) => Math.max(max, i.timelineEnd), 0);
}
