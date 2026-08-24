export const HIGHLIGHT_TUNER_ENV = "CLIPSIFT_HIGHLIGHT_TUNER";

export type HighlightTunerGate = Readonly<{
  enabled: boolean;
  mode: "everything" | "highlights";
}>;

/**
 * The tuner remains unavailable unless the process is started with an exact
 * explicit opt-in. With the gate off, `everything` preserves the legacy path.
 */
export function readHighlightTunerGate(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HighlightTunerGate {
  const enabled = environment[HIGHLIGHT_TUNER_ENV] === "1";
  return Object.freeze({
    enabled,
    mode: enabled ? "highlights" : "everything",
  });
}
