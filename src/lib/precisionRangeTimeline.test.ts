import { describe, expect, it } from "vitest";
import { precisionTimelineWindow } from "@/components/studio/PrecisionRangeTimeline";

describe("precisionTimelineWindow", () => {
  it("shows useful context around both original and revised ranges", () => {
    const window = precisionTimelineWindow({ duration: 3600, originalIn: 100, originalOut: 120, inPoint: 92, outPoint: 130 });
    expect(window.start).toBeCloseTo(78.7, 1);
    expect(window.end).toBeCloseTo(143.3, 1);
  });

  it("stays within source boundaries", () => {
    const window = precisionTimelineWindow({ duration: 60, originalIn: 2, originalOut: 50, inPoint: 0, outPoint: 60 });
    expect(window.start).toBe(0);
    expect(window.end).toBe(60);
  });
});
