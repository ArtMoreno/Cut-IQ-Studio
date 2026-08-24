import {
  customHighlightTunerSettings,
  defaultHighlightTunerSettings,
  type HighlightTunerSettings,
} from "./highlightSelector";

type StoredHighlightTuner = Partial<Omit<HighlightTunerSettings, "mode">> & {
  mode?: "everything" | HighlightTunerSettings["mode"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validOptionalNumber(value: unknown, minimum: number, maximum: number): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum);
}

function validOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

/**
 * Resolve a persisted per-job tuner. Any absent, malformed, unknown, or
 * explicit Everything value returns null so the caller takes the legacy path.
 */
export function resolveStoredHighlightTunerSettings(value: string | null | undefined): Readonly<HighlightTunerSettings> | null {
  if (!value?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.mode !== "string" || parsed.mode === "everything") return null;
  if (parsed.mode === "balanced" || parsed.mode === "highlights" || parsed.mode === "best_only") {
    return defaultHighlightTunerSettings(parsed.mode);
  }
  if (parsed.mode !== "custom") return null;
  if (
    !validOptionalNumber(parsed.maxClipsPerGame, 1, 50)
    || !validOptionalNumber(parsed.minimumEstimatedYards, 0, 99)
    || !validOptionalNumber(parsed.minimumExcitement, 0, 25)
    || !validOptionalBoolean(parsed.includeProbablePlays)
    || !validOptionalBoolean(parsed.alwaysIncludeTouchdowns)
    || !validOptionalBoolean(parsed.includeKeyDowns)
    || !validOptionalBoolean(parsed.includeRedZonePlays)
  ) return null;
  return customHighlightTunerSettings(parsed as StoredHighlightTuner);
}
