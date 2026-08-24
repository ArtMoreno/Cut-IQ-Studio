import { describe, expect, it } from "vitest";
import { mobileClipFileName } from "../mobile/mobileUtils";

describe("mobileClipFileName", () => {
  it("labels the download as a clip and removes Windows-unsafe characters", () => {
    expect(mobileClipFileName('Miami: Full Game / Replay?', 5864)).toBe(
      "Miami Full Game Replay - clip 5864.mp4"
    );
  });

  it("uses a clear fallback title", () => {
    expect(mobileClipFileName(null, 42)).toBe("Cut IQ clip - clip 42.mp4");
  });
});
