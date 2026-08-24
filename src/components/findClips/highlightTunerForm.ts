export type HighlightTunerFormMode = "everything" | "balanced" | "highlights" | "best_only" | "custom";

export type HighlightTunerFormValue = {
  mode: HighlightTunerFormMode;
  maxClipsPerGame: number;
  minimumEstimatedYards: number;
  minimumExcitement: number;
  includeProbablePlays: boolean;
  alwaysIncludeTouchdowns: boolean;
  includeKeyDowns: boolean;
  includeRedZonePlays: boolean;
};

export const highlightTunerModes: ReadonlyArray<Readonly<{
  mode: HighlightTunerFormMode;
  label: string;
  description: string;
}>> = [
  { mode: "everything", label: "Everything", description: "Current behavior; keep every grounded candidate." },
  { mode: "balanced", label: "Balanced", description: "Keep more useful plays while trimming routine mentions." },
  { mode: "highlights", label: "Highlights", description: "Favor touchdowns, key downs, and runs of 10+ yards." },
  { mode: "best_only", label: "Best Only", description: "A short list of the strongest plays from each game." },
  { mode: "custom", label: "Custom", description: "Set your own thresholds and inclusion rules." },
];

const presets: Readonly<Record<Exclude<HighlightTunerFormMode, "custom">, Readonly<HighlightTunerFormValue>>> = {
  everything: Object.freeze({
    mode: "everything",
    maxClipsPerGame: 8,
    minimumEstimatedYards: 0,
    minimumExcitement: 0,
    includeProbablePlays: true,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: true,
  }),
  balanced: Object.freeze({
    mode: "balanced",
    maxClipsPerGame: 8,
    minimumEstimatedYards: 5,
    minimumExcitement: 8,
    includeProbablePlays: true,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: true,
  }),
  highlights: Object.freeze({
    mode: "highlights",
    maxClipsPerGame: 5,
    minimumEstimatedYards: 10,
    minimumExcitement: 13,
    includeProbablePlays: false,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: true,
  }),
  best_only: Object.freeze({
    mode: "best_only",
    maxClipsPerGame: 3,
    minimumEstimatedYards: 15,
    minimumExcitement: 18,
    includeProbablePlays: false,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: false,
  }),
};

export function highlightTunerPreset(mode: Exclude<HighlightTunerFormMode, "custom">): HighlightTunerFormValue {
  return { ...presets[mode] };
}

export function defaultHighlightTunerFormValue(): HighlightTunerFormValue {
  return highlightTunerPreset("everything");
}

export function normalizeHighlightTunerDraft(value?: Partial<HighlightTunerFormValue> | null): HighlightTunerFormValue {
  if (!value || !highlightTunerModes.some((option) => option.mode === value.mode)) return defaultHighlightTunerFormValue();
  const mode = value.mode!;
  const base = mode === "custom" ? presets.highlights : presets[mode];
  return {
    ...base,
    ...value,
    mode,
    maxClipsPerGame: positiveInteger(value.maxClipsPerGame, base.maxClipsPerGame),
    minimumEstimatedYards: boundedNumber(value.minimumEstimatedYards, base.minimumEstimatedYards, 0, 99),
    minimumExcitement: boundedNumber(value.minimumExcitement, base.minimumExcitement, 0, 25),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 1 && value! <= 50 ? Math.floor(value!) : fallback;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) && value! >= minimum && value! <= maximum ? value! : fallback;
}

export function highlightTunerSummary(value: HighlightTunerFormValue): string {
  const option = highlightTunerModes.find((candidate) => candidate.mode === value.mode)!;
  if (value.mode !== "custom") return option.label;
  return `Custom · ${value.maxClipsPerGame}/game · ${value.minimumEstimatedYards}+ yards`;
}
