import { describe, it, expect } from "vitest";
import {
  clipPreviewSource,
  clipThumbnailSource,
  fmtClock,
  fmtSeconds,
  itemPreviewSource,
  manifestClipDuration,
  sortTimelineItems,
  timelineItemFromManifestClip,
  timelineDuration,
  tracksIn,
  type ManifestClip,
  type TimelineItem,
} from "./assemble";

function item(over: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: "item-1",
    clipId: "cand-1",
    track: "V1",
    timelineStart: 0,
    timelineEnd: 5,
    sourcePath: null,
    sourceIn: null,
    sourceOut: null,
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

const clip: ManifestClip = {
  clipId: "cand-1",
  candidateId: 1,
  beatOrd: 0,
  beatText: "",
  game: null,
  opponent: null,
  sourceUrl: "https://www.youtube.com/watch?v=U1qZljTraBE",
  sourceVideoId: "U1qZljTraBE",
  localPath: "D:\\Clips\\project-1\\c.mp4",
  downloadUrl: "/api/clips/project-1/c.mp4",
  drivePath: null,
  sourceStartSeconds: 0,
  sourceEndSeconds: 5,
  clipDurationSeconds: 5,
  resolution: { width: 1920, height: 1080 },
  container: "mp4",
  codec: null,
  playerMention: null,
  queryContext: [],
  coverageTypes: [],
  purpose: null,
  transcript: { text: null, segmentStart: null, segmentEnd: null },
  tags: [],
  verification: { playerVerified: true, contextVerified: true, confidence: 0.9, matchKind: "exact_transcript", reason: null },
};

describe("fmtClock / fmtSeconds", () => {
  it("formats clocks and durations", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(75)).toBe("1:15");
    expect(fmtSeconds(12.34)).toBe("12.3s");
    expect(fmtSeconds(75)).toBe("1:15 (75.0s)");
    expect(fmtSeconds(-1)).toBe("0.0s");
  });
});

describe("timeline helpers", () => {
  it("computes duration from max item end", () => {
    expect(timelineDuration([item(), item({ timelineEnd: 11 })] )).toBe(11);
  });

  it("sorts by track then start", () => {
    const sorted = sortTimelineItems([
      item({ id: "b", track: "A1", timelineStart: 0 }),
      item({ id: "a", track: "V1", timelineStart: 10 }),
      item({ id: "c", track: "V1", timelineStart: 0 }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("lists tracks in display order", () => {
    expect(tracksIn([item({ track: "A1" }), item({ track: "V2" }), item({ track: "V1" })])).toEqual(["V2", "V1", "A1"]);
  });

  it("prefers the local download URL for preview", () => {
    expect(itemPreviewSource(item(), [clip])).toBe("/api/clips/project-1/c.mp4");
    expect(itemPreviewSource(item({ clipId: "missing" }), [clip])).toBeNull();
    expect(clipPreviewSource(clip)).toBe("/api/clips/project-1/c.mp4");
    expect(clipThumbnailSource(clip)).toBe("https://i.ytimg.com/vi/U1qZljTraBE/mqdefault.jpg");
  });

  it("creates clip-relative timeline items from rendered clips", () => {
    const placed = timelineItemFromManifestClip(
      { ...clip, sourceStartSeconds: 120, sourceEndSeconds: 127.5, clipDurationSeconds: 7.5 },
      11,
      "manual-1",
    );
    expect(manifestClipDuration({ ...clip, clipDurationSeconds: 7.5 })).toBe(7.5);
    expect(placed).toMatchObject({
      id: "manual-1",
      clipId: "cand-1",
      timelineStart: 11,
      timelineEnd: 18.5,
      sourceIn: 0,
      sourceOut: 7.5,
      sourcePath: "D:\\Clips\\project-1\\c.mp4",
    });
  });

  it("falls back to the source window when no rendered file exists", () => {
    const remote = { ...clip, localPath: null, downloadUrl: null, sourceStartSeconds: 30, sourceEndSeconds: 35, clipDurationSeconds: null };
    expect(clipPreviewSource(remote)).toBe(remote.sourceUrl);
    expect(manifestClipDuration(remote)).toBe(5);
    expect(timelineItemFromManifestClip(remote, 0, "remote")).toMatchObject({ sourceIn: 30, sourceOut: 35 });
  });
});
