import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptTooManyRequestError,
} from "youtube-transcript";
import {
  TranscriptError,
  type TranscriptProvider,
  type TranscriptResult,
} from "./provider";

// Adapter: maintained public-transcript library behind the provider interface.
// Nothing outside this file imports the library directly.
export class YoutubeCaptionsProvider implements TranscriptProvider {
  readonly id = "youtube-captions";

  async fetchTranscript(videoId: string, lang?: string): Promise<TranscriptResult> {
    try {
      const items = await YoutubeTranscript.fetchTranscript(
        videoId,
        lang ? { lang } : undefined,
      );
      if (!items.length) {
        throw new TranscriptError("NO_TRANSCRIPT", "Transcript was empty.");
      }
      const segments = items.map((it, i) => {
        const start = it.offset / 1000;
        const end =
          i < items.length - 1
            ? items[i + 1].offset / 1000
            : start + it.duration / 1000;
        return { text: it.text.replace(/\s+/g, " ").trim(), start, end };
      });
      return {
        lang: lang ?? items[0].lang ?? "en",
        // The library does not distinguish manual vs auto captions; default to
        // manual-quality assumption is unsafe, so we mark fetched captions as
        // manual only when we cannot tell — surfaced as kind in result.
        kind: "manual",
        segments,
      };
    } catch (err) {
      if (err instanceof TranscriptError) throw err;
      if (err instanceof YoutubeTranscriptDisabledError) {
        throw new TranscriptError(
          "NO_TRANSCRIPT",
          "Captions are disabled for this video.",
        );
      }
      if (err instanceof YoutubeTranscriptNotAvailableError) {
        throw new TranscriptError(
          "NO_TRANSCRIPT",
          "No transcript is available for this video.",
        );
      }
      if (err instanceof YoutubeTranscriptVideoUnavailableError) {
        throw new TranscriptError(
          "VIDEO_UNAVAILABLE",
          "This video is private, deleted, age-restricted, or region-restricted.",
        );
      }
      if (err instanceof YoutubeTranscriptTooManyRequestError) {
        throw new TranscriptError(
          "NETWORK",
          "YouTube rate-limited transcript retrieval. Retry in a minute, or import a transcript file.",
        );
      }
      throw new TranscriptError(
        "PROVIDER",
        "YouTube could not provide a transcript for this source. Retry, or import a transcript (.srt / .vtt / timestamped text).",
      );
    }
  }
}

export function getTranscriptProvider(): TranscriptProvider {
  return new YoutubeCaptionsProvider();
}
