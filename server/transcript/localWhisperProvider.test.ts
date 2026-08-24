import { describe, expect, it } from "vitest";
import {
  buildLocalWhisperAudioDownloadArgs,
  isSafeYouTubeVideoId,
  parseLocalWhisperResult,
  resolveLocalWhisperJobDirectory,
} from "./localWhisperProvider";

describe("local Whisper transcript fallback safeguards", () => {
  it("only accepts a canonical YouTube video id and keeps temp jobs under their root", () => {
    expect(isSafeYouTubeVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isSafeYouTubeVideoId("../../not-a-video")).toBe(false);
    expect(resolveLocalWhisperJobDirectory("D:/Clips/.clipsift-transcript-tmp", "job-123e4567-e89b-12d3-a456-426614174000"))
      .toBe("D:\\Clips\\.clipsift-transcript-tmp\\job-123e4567-e89b-12d3-a456-426614174000");
    expect(() => resolveLocalWhisperJobDirectory("D:/Clips/.clipsift-transcript-tmp", "../outside"))
      .toThrow(/identifier/i);
  });

  it("preserves only model-emitted segment timings and marks their source honestly", () => {
    const result = parseLocalWhisperResult({
      language: "en",
      segments: [{ text: "  local   timing  ", start: 1.25, end: 3.5 }],
    });
    expect(result).toEqual({
      lang: "en",
      kind: "local-whisper",
      segments: [{ text: "local timing", start: 1.25, end: 3.5 }],
    });
    expect(() => parseLocalWhisperResult({ segments: [{ text: "guess", start: 3, end: 3 }] }))
      .toThrow(/invalid timed segment/i);
  });

  it("uses the tested embedded YouTube client when preparing captionless audio", () => {
    const args = buildLocalWhisperAudioDownloadArgs(
      "D:/Clips/.clipsift-transcript-tmp/job-123",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(args).toContain("youtube:player_client=web_embedded");
    expect(args).toContain("bestaudio/best");
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
