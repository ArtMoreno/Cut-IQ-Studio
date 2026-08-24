import { describe, expect, it } from "vitest";
import {
  buildStudioClipArguments,
  buildStudioSourceDownloadArgs,
  publicStudioExportError,
  studioExportFingerprint,
} from "./exportEngine";

describe("Transcript Studio owned export engine", () => {
  it("uses the software H.264 encoder included in Cut IQ's FFmpeg runtime", () => {
    const args = buildStudioClipArguments(
      "D:/source.mp4",
      "D:/Exports/clip.mp4",
      { draftId: "clip-1", label: "Clip 1", inPoint: 1, outPoint: 4 },
    );
    expect(args).toContain("libopenh264");
    expect(args).toContain("yuv420p");
    expect(args).not.toContain("libx264");
  });

  it("uses Cut IQ's embedded YouTube client first with a native fallback shape", () => {
    const embedded = buildStudioSourceDownloadArgs({
      jobDir: "D:/Clips/.clipsift-studio-tmp/job",
      outputTemplate: "D:/Clips/.clipsift-studio-source-cache/id.%(ext)s",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(embedded).toContain("youtube:player_client=web_embedded");
    expect(embedded).toContain("--ffmpeg-location");

    const native = buildStudioSourceDownloadArgs({
      jobDir: "D:/Clips/.clipsift-studio-tmp/job",
      outputTemplate: "D:/Clips/.clipsift-studio-source-cache/id.%(ext)s",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      useEmbeddedClient: false,
    });
    expect(native).not.toContain("--extractor-args");
  });

  it("keeps technical downloader output out of persisted public errors", () => {
    const raw = new Error("SOURCE_DOWNLOAD:HTTP 403 https://googlevideo.example/private-token");
    expect(publicStudioExportError(raw)).toMatch(/could not download/i);
    expect(publicStudioExportError(raw)).not.toContain("googlevideo");
  });

  it("fingerprints ordered manual selections without any automated project identity", () => {
    const clips = [
      { draftId: "a", label: "First", inPoint: 1, outPoint: 5 },
      { draftId: "b", label: "Second", inPoint: 8, outPoint: 12 },
    ];
    expect(studioExportFingerprint(4, clips)).toBe(studioExportFingerprint(4, clips));
    expect(studioExportFingerprint(4, clips)).not.toBe(studioExportFingerprint(4, [...clips].reverse()));
  });
});
