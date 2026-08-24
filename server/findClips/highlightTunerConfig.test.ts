import { describe, expect, it } from "vitest";
import { resolveStoredHighlightTunerSettings } from "./highlightTunerConfig";

describe("stored highlight tuner settings", () => {
  it.each([null, "", "not json", "{}", '{"mode":"unknown"}', '{"mode":"everything"}'])(
    "keeps legacy Everything behavior for %s",
    (value) => expect(resolveStoredHighlightTunerSettings(value)).toBeNull(),
  );

  it.each([
    ["balanced", 8, 5],
    ["highlights", 5, 10],
    ["best_only", 3, 15],
  ] as const)("uses the canonical %s preset", (mode, maxClipsPerGame, minimumEstimatedYards) => {
    expect(resolveStoredHighlightTunerSettings(JSON.stringify({ mode, maxClipsPerGame: 49 }))).toMatchObject({
      mode,
      maxClipsPerGame,
      minimumEstimatedYards,
    });
  });

  it("accepts a bounded custom configuration", () => {
    expect(resolveStoredHighlightTunerSettings(JSON.stringify({
      mode: "custom",
      maxClipsPerGame: 4,
      minimumEstimatedYards: 12,
      minimumExcitement: 14,
      includeProbablePlays: false,
      alwaysIncludeTouchdowns: true,
      includeKeyDowns: true,
      includeRedZonePlays: false,
    }))).toMatchObject({ mode: "custom", maxClipsPerGame: 4, minimumEstimatedYards: 12, minimumExcitement: 14 });
  });

  it.each([
    { mode: "custom", maxClipsPerGame: 0 },
    { mode: "custom", maxClipsPerGame: 51 },
    { mode: "custom", minimumEstimatedYards: 100 },
    { mode: "custom", minimumExcitement: 26 },
    { mode: "custom", includeKeyDowns: "yes" },
  ])("fails closed to legacy for invalid custom data", (stored) => {
    expect(resolveStoredHighlightTunerSettings(JSON.stringify(stored))).toBeNull();
  });
});
