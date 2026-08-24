import { describe, expect, it } from "vitest";
import { buildFindClipsCoverageBrief, createFindJobSchema } from "./findClipsRouter";

const required = {
  player: "Evan Johnson",
  team: "BYU",
  season: 2025,
  scriptText: "Evan Johnson returned an interception for a touchdown.",
};

describe("Find Clips new-job contract", () => {
  it("uses production quality and context defaults", () => {
    const parsed = createFindJobSchema.parse(required);
    expect(parsed.preferredHeight).toBe(1080);
    expect(parsed.minimumHeight).toBe(720);
    expect(parsed.preRollSec).toBe(10);
    expect(parsed.postRollSec).toBe(15);
    expect(parsed.autoStart).toBe(true);
    expect(parsed.highlightTuner).toBeUndefined();
  });

  it("accepts an explicit Everything tuner without requiring custom fields", () => {
    expect(createFindJobSchema.parse({
      ...required,
      highlightTuner: { mode: "everything" },
    }).highlightTuner).toEqual({ mode: "everything" });
  });

  it("accepts the complete custom highlight tuner contract", () => {
    const highlightTuner = {
      mode: "custom" as const,
      maxClipsPerGame: 5,
      minimumEstimatedYards: 10,
      minimumExcitement: 12,
      includeProbablePlays: false,
      alwaysIncludeTouchdowns: true,
      includeKeyDowns: true,
      includeRedZonePlays: true,
    };
    expect(createFindJobSchema.parse({ ...required, highlightTuner }).highlightTuner).toEqual(highlightTuner);
  });

  it.each([
    [{ mode: "custom", maxClipsPerGame: 0 }, "max clips below range"],
    [{ mode: "custom", maxClipsPerGame: 51 }, "max clips above range"],
    [{ mode: "custom", minimumEstimatedYards: -1 }, "minimum yards below range"],
    [{ mode: "custom", minimumEstimatedYards: 100 }, "minimum yards above range"],
    [{ mode: "custom", minimumExcitement: -1 }, "excitement below range"],
    [{ mode: "custom", minimumExcitement: 26 }, "excitement above range"],
    [{ mode: "unknown" }, "unknown mode"],
  ])("rejects invalid highlight tuner input: %s", (highlightTuner, _label) => {
    expect(createFindJobSchema.safeParse({ ...required, highlightTuner }).success).toBe(false);
  });

  it("rejects output below the 720p floor", () => {
    expect(createFindJobSchema.safeParse({ ...required, minimumHeight: 480 }).success).toBe(false);
  });

  it("rejects a preferred quality below the selected minimum", () => {
    expect(createFindJobSchema.safeParse({ ...required, preferredHeight: 720, minimumHeight: 1080 }).success).toBe(false);
  });

  it("accepts a newline-delimited game list", () => {
    expect(createFindJobSchema.parse({ ...required, opponent: "Utah\nTCU\nEast Carolina" }).opponent).toContain("TCU");
  });

  it("allows a metadata-only job without a finished script", () => {
    const parsed = createFindJobSchema.parse({ player: "Xavier Lucas", team: "Miami Hurricanes", season: 2025 });
    expect(parsed.scriptText).toBe("");
    expect(buildFindClipsCoverageBrief(parsed)).toContain("Xavier Lucas");
    expect(buildFindClipsCoverageBrief(parsed)).toContain("every available Miami Hurricanes game");
  });

  it("turns short notes into extra direction instead of rejecting the job", () => {
    const parsed = createFindJobSchema.parse({ ...required, scriptText: "CB" });
    const brief = buildFindClipsCoverageBrief(parsed);
    expect(brief).toContain("Additional user note: CB");
    expect(brief.length).toBeGreaterThan(20);
  });

  it("preserves a supplied finished script", () => {
    const parsed = createFindJobSchema.parse(required);
    expect(buildFindClipsCoverageBrief(parsed)).toBe(required.scriptText);
  });
});
