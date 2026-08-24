import { describe, it, expect } from "vitest";
import { buildRenderPlan, buildScaleFilter } from "./render";
import type { TimelineItem } from "./project";

function item(over: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: "item-1",
    clipId: "cand-1",
    track: "V1",
    timelineStart: 0,
    timelineEnd: 5,
    sourcePath: "D:\\Clips\\a.mp4",
    sourceIn: 10,
    sourceOut: 15,
    beatId: "beat-1",
    matchConfidence: 0.9,
    matchReason: [],
    locked: false,
    unresolved: false,
    sourceMode: "action",
    gain: 1,
    cropMode: "fit",
    cropX: 0,
    cropY: 0,
    ...over,
  };
}

describe("buildScaleFilter", () => {
  it("fit pads to preserve aspect ratio", () => {
    const f = buildScaleFilter("fit", 1920, 1080, 1080, 1920);
    expect(f).toContain("scale=1080:1920:force_original_aspect_ratio=decrease");
    expect(f).toContain("pad=1080:1920");
  });

  it("fill/crop scales to cover and crops", () => {
    const f = buildScaleFilter("fill", 1920, 1080, 1080, 1920);
    expect(f).toContain("force_original_aspect_ratio=increase");
    expect(f).toContain("crop=1080:1920");
  });
});

describe("buildRenderPlan", () => {
  it("builds a trim+scale+concat graph with audio", () => {
    const plan = buildRenderPlan(
      [
        { item: item({ id: "a", sourceIn: 10, sourceOut: 15, timelineStart: 0, timelineEnd: 5 }), sourcePath: "D:\\Clips\\a.mp4", hasAudio: true },
        { item: item({ id: "b", sourceIn: 0, sourceOut: 6, timelineStart: 5, timelineEnd: 11 }), sourcePath: "D:\\Clips\\b.mp4", hasAudio: false },
      ],
      { width: 1080, height: 1920, fps: 30 },
    );
    expect(plan.inputs).toEqual(["D:\\Clips\\a.mp4", "D:\\Clips\\b.mp4"]);
    expect(plan.filterComplex).toContain("trim=start=10:end=15");
    expect(plan.filterComplex).toContain("concat=n=2:v=1:a=0[vc]");
    expect(plan.filterComplex).toContain("concat=n=2:v=0:a=1[ac]");
    // the audio-less input gets a silence generator
    expect(plan.filterComplex).toContain("aevalsrc=0");
  });
});
