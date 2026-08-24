import { describe, expect, it } from "vitest";
import { assertVerifiedClip } from "./mediaProbe";

describe("assertVerifiedClip", () => {
  const completeProbe = { width: 1280, height: 720, durationSec: 3.02, hasAudio: true };

  it("accepts a playable HD clip inside frame-level duration tolerance", () => {
    expect(() => assertVerifiedClip(completeProbe, 3, 720)).not.toThrow();
  });

  it("rejects a silent, low-resolution, or materially wrong-duration output", () => {
    expect(() => assertVerifiedClip({ ...completeProbe, hasAudio: false }, 3, 720)).toThrow(/audio/i);
    expect(() => assertVerifiedClip({ ...completeProbe, height: 480 }, 3, 720)).toThrow(/720p/i);
    expect(() => assertVerifiedClip({ ...completeProbe, durationSec: 4 }, 3, 720)).toThrow(/duration/i);
  });
});
