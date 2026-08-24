import { describe, expect, it } from "vitest";
import { progressForStage, stageSummary } from "./progress";
import { recoveredFindJobPatch } from "./engine";

describe("Find Clips durable progress", () => {
  it("maps real stage work into a monotonic completion percentage", () => {
    expect(progressForStage("queued")).toBe(0);
    expect(progressForStage("analyzing", 1)).toBe(15);
    expect(progressForStage("transcripts", 0.5)).toBe(45);
    expect(progressForStage("verifying", 0.5)).toBe(89.5);
    expect(progressForStage("complete")).toBe(100);
  });

  it("bounds invalid fractions and reports the visible stage count", () => {
    expect(progressForStage("discovering", 2)).toBe(30);
    expect(progressForStage("discovering", -1)).toBe(15);
    expect(stageSummary("ranking")).toEqual({ label: "Rank candidates", current: 4, total: 6 });
    expect(stageSummary("complete")).toEqual({ label: "Complete", current: 6, total: 6 });
  });

  it("does not reset durable completion when the worker recovers a job", () => {
    expect(recoveredFindJobPatch()).not.toHaveProperty("progressPercent");
    expect(recoveredFindJobPatch().status).toBe("queued");
  });
});
