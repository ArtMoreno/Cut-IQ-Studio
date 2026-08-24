import { describe, expect, it } from "vitest";
import {
  buildFullSourceDownloadArgs,
  buildSectionDownloadArgs,
  extractYouTubeUrl,
  fmtClock,
  isRetryableYouTubeStreamFailure,
  isCanonicalCachedSourceName,
  parseYtDlpPercent,
  publicRenderError,
  sanitize,
  sanitizedRenderDiagnostic,
  shouldUseLocalCutFallback,
} from "./engine";

describe("clip render safety helpers", () => {
  it("canonicalizes only supported YouTube URLs before handing them to yt-dlp", () => {
    expect(extractYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=30")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(() => extractYouTubeUrl("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toThrow(/valid YouTube/i);
  });

  it("keeps renderer utility values safe and predictable", () => {
    expect(sanitize('A <clip> / name')).toBe("A-clip-name");
    expect(fmtClock(65.9)).toBe("00:01:05.900");
    expect(fmtClock(206.95517302288818)).toBe("00:03:26.955");
    expect(fmtClock(211.45927795040893)).toBe("00:03:31.459");
    expect(parseYtDlpPercent("[download] 45.7% of 10MiB")).toBe(45.7);
  });

  it("turns downloader diagnostics into a safe retry message", () => {
    const signedUrlDiagnostic = "HTTP error 403 Forbidden https://googlevideo.example/videoplayback?token=private";
    expect(publicRenderError(new Error(signedUrlDiagnostic)))
      .toBe("YouTube rejected both Cut IQ download strategies. Open technical details for the client and HTTP failure, then retry.");
    expect(publicRenderError(new Error(signedUrlDiagnostic))).not.toContain("googlevideo");
    expect(sanitizedRenderDiagnostic(signedUrlDiagnostic)).toContain("HTTP error 403 Forbidden");
    expect(sanitizedRenderDiagnostic(signedUrlDiagnostic)).not.toContain("googlevideo");
  });

  it("retries only transient YouTube stream refusals", () => {
    expect(isRetryableYouTubeStreamFailure({ code: 1, stdout: "", stderr: "HTTP error 403 Forbidden" })).toBe(true);
    expect(isRetryableYouTubeStreamFailure({ code: 1, stdout: "", stderr: "ffmpeg is not installed" })).toBe(false);
    expect(isRetryableYouTubeStreamFailure({ code: 0, stdout: "403 mentioned in title", stderr: "" })).toBe(false);
  });

  it("uses the tested embedded client and a resumable native-download fallback", () => {
    const section = buildSectionDownloadArgs({
      temporaryDir: "D:/Clips/tmp",
      finalFile: "D:/Clips/out.mp4",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      format: "bv*[height<=1080]+ba/b[height<=1080]",
      editIn: 7,
      editOut: 38,
    });
    expect(section).toContain("youtube:player_client=web_embedded");
    expect(section).toContain("--download-sections");

    const fallback = buildFullSourceDownloadArgs({
      temporaryDir: "D:/Clips/tmp",
      outputTemplate: "D:/Clips/cache/id.%(ext)s",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      format: "bv*[height<=1080]+ba/b[height<=1080]",
    });
    expect(fallback).not.toContain("--download-sections");
    expect(fallback).toContain("youtube:player_client=web_embedded");
    expect(fallback).toContain("--continue");
    expect(fallback).toContain("--force-ipv4");
    expect(fallback).toContain("--http-chunk-size");
    expect(shouldUseLocalCutFallback({ code: 1 }, false)).toBe(true);
    expect(shouldUseLocalCutFallback({ code: 0 }, false)).toBe(true);
    expect(shouldUseLocalCutFallback({ code: 0 }, true)).toBe(false);
  });

  it("only accepts complete exact-id cache artifacts", () => {
    expect(isCanonicalCachedSourceName("abc-123", "abc-123.mkv")).toBe(true);
    expect(isCanonicalCachedSourceName("abc-123", "abc-123.mp4")).toBe(true);
    expect(isCanonicalCachedSourceName("abc-123", "abc-123.webm")).toBe(true);
    expect(isCanonicalCachedSourceName("abc-123", "abc-123.f398.mp4")).toBe(false);
    expect(isCanonicalCachedSourceName("abc-123", "abc-123.mp4.part")).toBe(false);
    expect(isCanonicalCachedSourceName("abc-123", "abc-123.mkv.ytdl")).toBe(false);
    expect(isCanonicalCachedSourceName("abc-123", "other-abc-123.mkv")).toBe(false);
  });
});
