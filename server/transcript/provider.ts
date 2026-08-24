// Clean adapter interface for transcript providers.
// The rest of the app depends only on these types, never on a specific library.

/**
 * `local-whisper` is intentionally distinct from YouTube's automatic
 * captions.  The UI can then tell people when timing/text came from the
 * device-local fallback instead of implying that YouTube supplied it.
 */
export type TranscriptKind = "manual" | "auto" | "local-whisper";

export interface RawSegment {
  text: string;
  start: number; // seconds
  end: number; // seconds
}

export interface TranscriptResult {
  lang: string;
  kind: TranscriptKind;
  segments: RawSegment[];
}

export type TranscriptErrorCode =
  | "NO_TRANSCRIPT"
  | "VIDEO_UNAVAILABLE"
  | "NETWORK"
  | "PROVIDER"
  | "LOCAL_TRANSCRIPTION_UNAVAILABLE"
  | "LOCAL_TRANSCRIPTION_FAILED"
  | "LOCAL_TRANSCRIPTION_CANCELLED";

export class TranscriptError extends Error {
  code: TranscriptErrorCode;
  constructor(code: TranscriptErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TranscriptProvider {
  readonly id: string;
  fetchTranscript(videoId: string, lang?: string): Promise<TranscriptResult>;
}
