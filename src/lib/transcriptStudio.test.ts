import { describe, expect, it } from "vitest";
import {
  alignEditedTokens,
  buildTranscriptSearchIndex,
  createSafeClipFilename,
  findSegmentAtTime,
  findSegmentIndexAtTime,
  findTranscriptMatches,
  isWindowsPathWithinRoot,
  nextAvailableFilename,
  normalizeYouTubeUrl,
  resolveEditorPlayhead,
  resolveTokenSeekTarget,
  resolveWindowsOutputPath,
  validateClipRange,
  type TranscriptStudioToken,
} from "./transcriptStudio";

const tokens: TranscriptStudioToken[] = [
  {
    id: "token-1",
    originalText: "Hello",
    displayText: "Hello",
    startMs: 0,
    endMs: 400,
    segmentId: "segment-1",
    timingSource: "word",
  },
  {
    id: "token-2",
    originalText: "world",
    displayText: "world",
    startMs: 400,
    endMs: 1_000,
    segmentId: "segment-1",
    timingSource: "segment",
  },
];

describe("normalizeYouTubeUrl", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42",
    "https://youtu.be/dQw4w9WgXcQ?t=42",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    "youtube.com/watch?v=dQw4w9WgXcQ",
  ])("normalizes supported YouTube URL %s", (input) => {
    expect(normalizeYouTubeUrl(input)).toEqual({
      ok: true,
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it.each([
    ["https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "unsupported-host"],
    ["ftp://www.youtube.com/watch?v=dQw4w9WgXcQ", "unsupported-protocol"],
    ["https://www.youtube.com/watch?v=not-an-id", "invalid-video-id"],
    ["https://www.youtube.com/watch?list=PL123", "missing-video-id"],
  ])("rejects unsafe or malformed URL %s", (input, error) => {
    const result = normalizeYouTubeUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });
});

describe("timed transcript helpers", () => {
  const segments = [
    { id: "first", startMs: 0, endMs: 1_000 },
    { id: "second", startMs: 1_000, endMs: 2_000 },
    { id: "third", startMs: 2_000, endMs: 3_000 },
  ];

  it("uses a binary-compatible segment lookup with clear boundary behavior", () => {
    expect(findSegmentIndexAtTime(segments, 0)).toBe(0);
    expect(findSegmentIndexAtTime(segments, 1_000)).toBe(1);
    expect(findSegmentAtTime(segments, 3_000)?.id).toBe("third");
    expect(findSegmentIndexAtTime(segments, 3_001)).toBe(-1);
  });

  it("preserves real and approximate timing for replacements and gives inserts no timing", () => {
    const edited = alignEditedTokens(tokens, "Hello corrected added", {
      createTokenId: ({ ordinal }) => `new-${ordinal}`,
    });
    expect(edited).toMatchObject([
      { id: "token-1", displayText: "Hello", startMs: 0, endMs: 400, timingSource: "word", hidden: false },
      { id: "token-2", displayText: "corrected", startMs: 400, endMs: 1_000, timingSource: "segment", hidden: false },
      { id: "new-0", originalText: "", displayText: "added", startMs: null, endMs: null, timingSource: "none", hidden: false },
    ]);
  });

  it("hides deleted tokens without moving their timestamps", () => {
    const edited = alignEditedTokens(tokens, "Hello");
    expect(edited[1]).toMatchObject({ id: "token-2", hidden: true, startMs: 400, endMs: 1_000 });
  });

  it("indexes edited visible text and returns cross-segment search matches", () => {
    const index = buildTranscriptSearchIndex([
      { ...tokens[0], displayText: "Edited" },
      { ...tokens[1], displayText: "Transcript", segmentId: "segment-2" },
      { ...tokens[1], id: "hidden", displayText: "ignored", hidden: true },
    ]);
    const matches = findTranscriptMatches(index, "edited transcript");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ tokenIds: ["token-1", "token-2"], segmentIds: ["segment-1", "segment-2"] });
    expect(findTranscriptMatches(index, "IGNORED")).toEqual([]);
  });

  it("uses a nearest honest timestamp for an untimed insertion", () => {
    const aligned = alignEditedTokens(tokens, "Hello inserted world", { createTokenId: () => "inserted" });
    expect(resolveTokenSeekTarget(aligned, "inserted")).toEqual({
      timeMs: 0,
      tokenId: "token-1",
      segmentId: "segment-1",
      approximate: true,
      source: "nearest-token",
    });
  });
});

describe("clip export safety helpers", () => {
  it("captures marks from the live player clock with a safe observed fallback", () => {
    expect(resolveEditorPlayhead(12.345, 12, 60)).toBe(12.345);
    expect(resolveEditorPlayhead(null, 12, 60)).toBe(12);
    expect(resolveEditorPlayhead(0, 20.25, 60)).toBe(20.25);
    expect(resolveEditorPlayhead(61, Number.NaN, 60)).toBe(60);
    expect(resolveEditorPlayhead(Number.NaN, Number.NaN, 60)).toBeNull();
  });

  it("rejects invalid in/out selections", () => {
    expect(validateClipRange(1_000, 1_000, 10_000)).toMatchObject({ ok: false, error: "out-not-after-in" });
    expect(validateClipRange(-1, 1_000, 10_000)).toMatchObject({ ok: false, error: "in-before-zero" });
    expect(validateClipRange(1_000, 11_000, 10_000)).toMatchObject({ ok: false, error: "out-after-duration" });
    expect(validateClipRange(1_000, 2_500, 10_000)).toEqual({ ok: true, inMs: 1_000, outMs: 2_500, durationMs: 1_500 });
  });

  it("creates legal deterministic Windows filenames and selects a duplicate suffix", () => {
    const filename = createSafeClipFilename({
      videoTitle: 'A <bad>: title / with * characters?',
      clipLabel: "CON",
      inMs: 61_234,
      outMs: 65_678,
    });
    expect(filename).toBe("A bad title with characters - _CON - 00-01-01-234 to 00-01-05-678.mp4");
    expect(nextAvailableFilename("clip.mp4", (candidate) => candidate === "clip.mp4" || candidate === "clip (2).mp4")).toBe("clip (3).mp4");
  });

  it("contains exports in the configured Windows output root", () => {
    expect(resolveWindowsOutputPath("d:/Clips/Exports", "verified clip.mp4")).toEqual({
      ok: true,
      root: "D:\\Clips\\Exports",
      path: "D:\\Clips\\Exports\\verified clip.mp4",
    });
    expect(resolveWindowsOutputPath("D:\\Clips\\Exports", "..\\escape.mp4")).toEqual({ ok: false, error: "unsafe-filename" });
    expect(isWindowsPathWithinRoot("D:\\Clips\\Exports", "D:\\Clips\\Exports2\\escape.mp4")).toBe(false);
  });
});
