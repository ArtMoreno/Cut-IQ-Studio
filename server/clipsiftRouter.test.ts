import { describe, expect, it, vi } from "vitest";
import { acquireTranscript } from "./clipsiftRouter";
import { TranscriptError } from "./transcript/provider";

describe("Transcript Studio acquisition fallback", () => {
  it("uses local Whisper only after captions are explicitly unavailable", async () => {
    const captions = vi.fn().mockRejectedValue(new TranscriptError("NO_TRANSCRIPT", "Captions are disabled."));
    const local = vi.fn().mockResolvedValue({
      lang: "en",
      kind: "local-whisper" as const,
      segments: [{ text: "Device-local transcript", start: 0, end: 1.5 }],
    });

    await expect(acquireTranscript("jNQXAC9IVRw", "en", "studio-test-01", { captions, local }))
      .resolves.toMatchObject({ kind: "local-whisper", lang: "en" });
    expect(local).toHaveBeenCalledWith("jNQXAC9IVRw", "en", "studio-test-01");
  });

  it("does not download media when caption retrieval is a network problem", async () => {
    const captions = vi.fn().mockRejectedValue(new TranscriptError("NETWORK", "Rate limited."));
    const local = vi.fn();

    await expect(acquireTranscript("jNQXAC9IVRw", undefined, undefined, { captions, local }))
      .rejects.toMatchObject({ code: "NETWORK" });
    expect(local).not.toHaveBeenCalled();
  });
});
