import {
  normalizeWindowsAbsolutePath,
  validateClipRange,
} from "./transcriptStudio";

export type StudioShortcutAction =
  | "focus-search"
  | "search-next"
  | "search-previous"
  | "toggle-play"
  | "set-in"
  | "set-out"
  | "step-backward"
  | "pause"
  | "step-forward"
  | "dismiss";

export interface StudioShortcutInput {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** True for inputs, textareas, selects, and contenteditable transcript text. */
  editableTarget?: boolean;
  /** Enter navigation is only captured while the Studio search control is active. */
  searchActive?: boolean;
}

/**
 * Resolves only Transcript Studio-owned shortcuts. The caller remains
 * responsible for preventDefault after a non-null action is returned.
 */
export function resolveStudioShortcut(input: StudioShortcutInput): StudioShortcutAction | null {
  if (input.editableTarget) return null;

  const key = input.key.toLocaleLowerCase("en-US");
  const primaryModifier = Boolean(input.ctrlKey || input.metaKey);
  if (primaryModifier && !input.altKey && key === "f") return "focus-search";
  if (primaryModifier || input.altKey) return null;

  if (input.searchActive && key === "enter") {
    return input.shiftKey ? "search-previous" : "search-next";
  }
  if (input.code === "Space" || key === " ") return "toggle-play";
  if (key === "i") return "set-in";
  if (key === "o") return "set-out";
  if (key === "j") return "step-backward";
  if (key === "k") return "pause";
  if (key === "l") return "step-forward";
  if (key === "escape") return "dismiss";
  return null;
}

export interface StudioBasketClip {
  id: string;
  label: string;
  inMs: number;
  outMs: number;
  /** Unchecked clips remain in the basket but are excluded from export. */
  selected: boolean;
}

export interface StudioBasketSummary {
  selectedCount: number;
  totalDurationMs: number;
  orderedClips: StudioBasketClip[];
  invalidClipIds: string[];
  modes: {
    single: boolean;
    separate: boolean;
    join: boolean;
  };
}

/**
 * Produces the exact selection displayed in the sticky export bar. The visible
 * basket order is authoritative so Move Up/Down also determines joined output.
 */
export function summarizeStudioBasket(
  clips: readonly StudioBasketClip[],
  videoDurationMs: number,
): StudioBasketSummary {
  const selected = clips
    .map((clip, basketIndex) => ({ clip, basketIndex }))
    .filter(({ clip }) => clip.selected);
  const invalidClipIds = selected
    .filter(({ clip }) => !validateClipRange(clip.inMs, clip.outMs, videoDurationMs).ok)
    .map(({ clip }) => clip.id);
  const invalidIds = new Set(invalidClipIds);
  const orderedClips = selected
    .filter(({ clip }) => !invalidIds.has(clip.id))
    .sort((left, right) => left.basketIndex - right.basketIndex)
    .map(({ clip }) => clip);
  const totalDurationMs = orderedClips.reduce((total, clip) => total + clip.outMs - clip.inMs, 0);

  return {
    selectedCount: orderedClips.length,
    totalDurationMs,
    orderedClips,
    invalidClipIds,
    modes: {
      single: orderedClips.length === 1,
      separate: orderedClips.length >= 1,
      join: orderedClips.length >= 2,
    },
  };
}

export type StudioExportMode = "single" | "separate" | "join";

export type StudioExportPlan =
  | {
      ok: true;
      mode: StudioExportMode;
      clips: StudioBasketClip[];
      totalDurationMs: number;
    }
  | {
      ok: false;
      error: "invalid-selection" | "nothing-selected" | "single-requires-one" | "join-requires-two";
      message: string;
    };

/** Validates a single, separate-files, or joined export before work is queued. */
export function createStudioExportPlan(
  clips: readonly StudioBasketClip[],
  videoDurationMs: number,
  mode: StudioExportMode,
): StudioExportPlan {
  const summary = summarizeStudioBasket(clips, videoDurationMs);
  if (summary.invalidClipIds.length) {
    return { ok: false, error: "invalid-selection", message: "Fix the invalid clip ranges before exporting." };
  }
  if (summary.selectedCount === 0) {
    return { ok: false, error: "nothing-selected", message: "Select at least one clip to export." };
  }
  if (mode === "single" && summary.selectedCount !== 1) {
    return { ok: false, error: "single-requires-one", message: "Single clip export requires exactly one selected clip." };
  }
  if (mode === "join" && summary.selectedCount < 2) {
    return { ok: false, error: "join-requires-two", message: "Select at least two clips to join." };
  }
  return {
    ok: true,
    mode,
    clips: summary.orderedClips,
    totalDurationMs: summary.totalDurationMs,
  };
}

export type StudioDestinationValidation =
  | { ok: true; path: string }
  | { ok: false; error: "empty" | "not-absolute"; message: string };

/** Accepts any absolute Windows drive or UNC folder selected by the user. */
export function validateStudioDestination(input: string): StudioDestinationValidation {
  if (!input.trim()) {
    return { ok: false, error: "empty", message: "Choose a folder for the exported MP4 files." };
  }
  const path = normalizeWindowsAbsolutePath(input);
  if (!path) {
    return { ok: false, error: "not-absolute", message: "Choose an absolute Windows folder path." };
  }
  return { ok: true, path };
}

export type StudioExportStatus = "draft" | "queued" | "rendering" | "ready" | "failed" | "cancelled";

export interface StudioExportActions {
  canCancel: boolean;
  canRetry: boolean;
  canOpen: boolean;
  canRemove: boolean;
}

/** Keeps failed/cancelled jobs recoverable while treating a verified file as final. */
export function studioExportActions(status: StudioExportStatus): StudioExportActions {
  return {
    canCancel: status === "queued" || status === "rendering",
    canRetry: status === "failed" || status === "cancelled",
    canOpen: status === "ready",
    canRemove: status === "draft" || status === "failed" || status === "cancelled" || status === "ready",
  };
}
