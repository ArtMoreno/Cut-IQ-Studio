import { describe, it, expect } from "vitest";
import { parseScriptDirectives } from "./directives";
import { segmentsToSrt, segmentsToCaptionCues } from "./captions";

describe("parseScriptDirectives", () => {
  it("strips directive lines from narration and maps them to beats", () => {
    const script = [
      "Miami spent most of the year getting him the ball underneath.",
      "",
      "[visual: broken tackle]",
      "[prefer: Louisville]",
      "[duration: 7s]",
      "",
      "That is where his acceleration became a problem.",
      "",
      "[graphic]",
      "He caught 28 passes on third and fourth down.",
    ].join("\n");

    const parsed = parseScriptDirectives(script);
    expect(parsed.text).not.toContain("[visual");
    expect(parsed.text).not.toContain("[graphic]");
    expect(parsed.text).toContain("Miami spent most of the year");

    // beat 0 has no directive (directives precede beat 1)
    const d1 = parsed.directives.get(1);
    expect(d1?.visual).toBe("broken tackle");
    expect(d1?.prefer).toBe("Louisville");
    expect(d1?.durationSec).toBe(7);

    const d3 = parsed.directives.get(2);
    expect(d3?.graphic).toBe(true);
  });

  it("handles plain prose with no directives", () => {
    const parsed = parseScriptDirectives("Just a normal sentence.\n\nAnother one.");
    expect(parsed.directives.size).toBe(0);
    expect(parsed.text).toBe("Just a normal sentence.\n\nAnother one.");
  });
});

describe("segmentsToSrt", () => {
  it("formats timed cues as SRT", () => {
    const srt = segmentsToSrt([
      { text: "Hello", start: 4.18, end: 8.72 },
      { text: "World", start: 8.72, end: 14.96 },
    ]);
    expect(srt).toContain("00:00:04,180 --> 00:00:08,720");
    expect(srt).toContain("Hello");
    expect(srt).toContain("2\n00:00:08,720 --> 00:00:14,960");
  });

  it("drops invalid cues", () => {
    const srt = segmentsToSrt([{ text: "", start: 1, end: 2 }, { text: "ok", start: 2, end: 1 }]);
    expect(srt).toBe("");
  });
});

describe("segmentsToCaptionCues", () => {
  it("chunks long segments and distributes timing evenly", () => {
    const longText = "word ".repeat(60).trim(); // 360 chars
    const cues = segmentsToCaptionCues([{ text: longText, start: 0, end: 10 }]);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0].start).toBeCloseTo(0, 5);
    expect(cues[cues.length - 1].end).toBeCloseTo(10, 5);
    // each chunk is within the char budget
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(126);
  });

  it("keeps short segments as a single cue", () => {
    const cues = segmentsToCaptionCues([{ text: "Short.", start: 1, end: 3 }]);
    expect(cues.length).toBe(1);
    expect(cues[0]).toEqual({ text: "Short.", start: 1, end: 3 });
  });
});
