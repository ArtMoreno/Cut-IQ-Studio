/**
 * Pure Transcript Studio helpers.
 *
 * This module intentionally does not touch the DOM, filesystem, process APIs, or
 * network. Server-side callers must still resolve filesystem symlinks before
 * writing; `resolveWindowsOutputPath` provides the strict lexical containment
 * check that is safe to share with the client.
 */

export type YouTubeUrlError =
  | "empty"
  | "malformed"
  | "unsupported-protocol"
  | "unsupported-host"
  | "unsupported-format"
  | "missing-video-id"
  | "invalid-video-id";

export type YouTubeUrlNormalization =
  | {
      ok: true;
      videoId: string;
      canonicalUrl: string;
    }
  | {
      ok: false;
      error: YouTubeUrlError;
      message: string;
    };

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.music.youtube.com",
]);
const SHORT_YOUTUBE_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function youTubeUrlFailure(error: YouTubeUrlError, message: string): YouTubeUrlNormalization {
  return { ok: false, error, message };
}

/**
 * Parses a user-provided YouTube URL and returns the one canonical URL that is
 * safe to hand to a downloader. Only known YouTube hosts and HTTP(S) are
 * accepted; lookalike hosts, credentials, and malformed IDs are rejected.
 */
export function normalizeYouTubeUrl(input: string): YouTubeUrlNormalization {
  const value = input.trim();
  if (!value) return youTubeUrlFailure("empty", "Paste a YouTube URL first.");
  if (/\s/.test(value)) return youTubeUrlFailure("malformed", "The YouTube URL cannot contain spaces.");

  let candidate = value;
  if (!/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(candidate)) {
    if (/^(?:www\.)?(?:youtube\.com|youtu\.be)(?:\/|$)/i.test(candidate) || /^(?:m\.|music\.)youtube\.com(?:\/|$)/i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return youTubeUrlFailure("malformed", "Enter a complete YouTube URL.");
    }
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return youTubeUrlFailure("malformed", "That is not a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return youTubeUrlFailure("unsupported-protocol", "Only HTTP(S) YouTube URLs are supported.");
  }
  if (url.username || url.password) {
    return youTubeUrlFailure("malformed", "YouTube URLs with credentials are not supported.");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  let videoId: string | null = null;

  if (SHORT_YOUTUBE_HOSTS.has(host)) {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    const route = (pathParts[0] ?? "").toLowerCase();

    if (route === "watch") {
      const ids = [...new Set(url.searchParams.getAll("v").filter(Boolean))];
      if (ids.length > 1) {
        return youTubeUrlFailure("malformed", "The URL contains more than one video ID.");
      }
      videoId = ids[0] ?? null;
    } else if (["shorts", "embed", "live", "v"].includes(route)) {
      videoId = pathParts[1] ?? null;
    } else if (!route) {
      return youTubeUrlFailure("missing-video-id", "The YouTube URL does not identify a video.");
    } else {
      return youTubeUrlFailure("unsupported-format", "Use a YouTube watch, short, or share URL.");
    }
  } else {
    return youTubeUrlFailure("unsupported-host", "Use a youtube.com or youtu.be URL.");
  }

  if (!videoId) {
    return youTubeUrlFailure("missing-video-id", "The YouTube URL does not identify a video.");
  }
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return youTubeUrlFailure("invalid-video-id", "The YouTube video ID is invalid.");
  }

  return {
    ok: true,
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export interface TimedTranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
}

/**
 * Resolves an editor action against the live player clock. The periodically
 * observed React value is only a fallback because it can trail playback by a
 * polling interval. Invalid clocks are rejected and known durations clamp the
 * result to the playable range.
 */
export function resolveEditorPlayhead(
  livePlayerSeconds: number | null | undefined,
  observedSeconds: number,
  durationSeconds?: number | null,
): number | null {
  const liveIsValid = typeof livePlayerSeconds === "number" && Number.isFinite(livePlayerSeconds);
  const observedIsValid = Number.isFinite(observedSeconds);
  // `seekTo` updates the editor state immediately, while the cross-origin
  // YouTube player may report its previous time for a short period. Normal
  // playback polling stays within 250 ms, so a larger divergence identifies a
  // recent scrub/transcript seek and the observed editor playhead must win.
  const liveHasCaughtUp = liveIsValid && observedIsValid && Math.abs(livePlayerSeconds - observedSeconds) <= 1;
  const candidate = liveHasCaughtUp
    ? livePlayerSeconds
    : observedIsValid
      ? observedSeconds
      : liveIsValid
        ? livePlayerSeconds
        : Number.NaN;
  if (!Number.isFinite(candidate)) return null;
  const nonNegative = Math.max(0, candidate);
  return typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.min(nonNegative, durationSeconds)
    : nonNegative;
}

function isFiniteTimestamp(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Finds the active segment in an ascending, non-overlapping segment list in
 * O(log n). Segment ends are inclusive only for the final segment, which makes
 * the normal shared boundary belong to the following segment.
 */
export function findSegmentIndexAtTime<T extends TimedTranscriptSegment>(
  segments: readonly T[],
  timeMs: number,
): number {
  if (!isFiniteTimestamp(timeMs) || segments.length === 0) return -1;

  let lower = 0;
  let upper = segments.length - 1;
  let candidate = -1;

  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const segment = segments[middle];
    if (isFiniteTimestamp(segment.startMs) && segment.startMs <= timeMs) {
      candidate = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }

  if (candidate === -1) return -1;
  const segment = segments[candidate];
  if (!isFiniteTimestamp(segment.endMs) || segment.endMs < segment.startMs) return -1;
  const isFinalSegment = candidate === segments.length - 1;
  const beforeEnd = isFinalSegment ? timeMs <= segment.endMs : timeMs < segment.endMs;
  return beforeEnd ? candidate : -1;
}

export function findSegmentAtTime<T extends TimedTranscriptSegment>(
  segments: readonly T[],
  timeMs: number,
): T | undefined {
  const index = findSegmentIndexAtTime(segments, timeMs);
  return index === -1 ? undefined : segments[index];
}

export type TranscriptTimingSource = "word" | "segment" | "approximate" | "none";

export interface TranscriptStudioToken {
  id: string;
  originalText: string;
  displayText: string;
  startMs: number | null;
  endMs: number | null;
  segmentId: string;
  timingSource: TranscriptTimingSource;
  hidden?: boolean;
}

export interface EditedTokenAlignmentOptions {
  /** Required only when inserting into an empty segment. */
  segmentId?: string;
  /** Lets persistence layers supply their own stable IDs for inserted tokens. */
  createTokenId?: (context: {
    segmentId: string;
    ordinal: number;
    text: string;
    existingTokenIds: readonly string[];
  }) => string;
}

/** Splits editable transcript text into visible word-like tokens without inventing punctuation. */
export function tokenizeTranscriptText(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalizedTokenText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US");
}

function stableTokenSuffix(text: string): string {
  let hash = 5381;
  for (const character of text) hash = (hash * 33) ^ character.charCodeAt(0);
  return (hash >>> 0).toString(36);
}

function makeUniqueTokenId(base: string, existingIds: Set<string>): string {
  const sanitizedBase = base.trim() || "untimed-token";
  let candidate = sanitizedBase;
  let counter = 2;
  while (existingIds.has(candidate)) {
    candidate = `${sanitizedBase}-${counter}`;
    counter += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

type AlignmentOperation =
  | { kind: "keep" | "replace"; sourceIndex: number; targetIndex: number }
  | { kind: "delete"; sourceIndex: number }
  | { kind: "insert"; targetIndex: number };

/**
 * Applies a whole-segment text edit while preserving token identities and their
 * real or approximate timings. Replacements reuse the old token; deletions are
 * hidden; only genuinely inserted words receive an untimed token.
 */
export function alignEditedTokens(
  tokens: readonly TranscriptStudioToken[],
  editedText: string,
  options: EditedTokenAlignmentOptions = {},
): TranscriptStudioToken[] {
  const sourceTokens = tokens.filter((token) => !token.hidden);
  const targetWords = tokenizeTranscriptText(editedText);
  const sourceLength = sourceTokens.length;
  const targetLength = targetWords.length;

  // Wagner-Fischer alignment: diagonal substitutions win cost ties so a normal
  // word replacement retains its timestamp instead of becoming delete + insert.
  const costs = Array.from({ length: sourceLength + 1 }, () => Array<number>(targetLength + 1).fill(0));
  const directions = Array.from({ length: sourceLength + 1 }, () => Array<"diag" | "delete" | "insert">(targetLength + 1).fill("diag"));
  for (let sourceIndex = 1; sourceIndex <= sourceLength; sourceIndex += 1) {
    costs[sourceIndex][0] = sourceIndex;
    directions[sourceIndex][0] = "delete";
  }
  for (let targetIndex = 1; targetIndex <= targetLength; targetIndex += 1) {
    costs[0][targetIndex] = targetIndex;
    directions[0][targetIndex] = "insert";
  }

  for (let sourceIndex = 1; sourceIndex <= sourceLength; sourceIndex += 1) {
    for (let targetIndex = 1; targetIndex <= targetLength; targetIndex += 1) {
      const sameText = normalizedTokenText(sourceTokens[sourceIndex - 1].displayText) === normalizedTokenText(targetWords[targetIndex - 1]);
      const diagonal = costs[sourceIndex - 1][targetIndex - 1] + (sameText ? 0 : 1);
      const deletion = costs[sourceIndex - 1][targetIndex] + 1;
      const insertion = costs[sourceIndex][targetIndex - 1] + 1;
      const minimum = Math.min(diagonal, deletion, insertion);
      costs[sourceIndex][targetIndex] = minimum;
      // Preserve exact matches first. For equally cheap non-matching paths,
      // prefer a trailing insertion/deletion to moving a replacement later in
      // the segment ("old" -> "corrected added" keeps `old`'s timing for
      // `corrected`, then creates an untimed `added`).
      directions[sourceIndex][targetIndex] = sameText && diagonal === minimum
        ? "diag"
        : insertion === minimum
          ? "insert"
          : deletion === minimum
            ? "delete"
            : "diag";
    }
  }

  const reverseOperations: AlignmentOperation[] = [];
  let sourceIndex = sourceLength;
  let targetIndex = targetLength;
  while (sourceIndex > 0 || targetIndex > 0) {
    const direction = directions[sourceIndex][targetIndex];
    if (sourceIndex > 0 && targetIndex > 0 && direction === "diag") {
      const source = sourceTokens[sourceIndex - 1];
      const kind = normalizedTokenText(source.displayText) === normalizedTokenText(targetWords[targetIndex - 1]) ? "keep" : "replace";
      reverseOperations.push({ kind, sourceIndex: sourceIndex - 1, targetIndex: targetIndex - 1 });
      sourceIndex -= 1;
      targetIndex -= 1;
    } else if (sourceIndex > 0 && (targetIndex === 0 || direction === "delete")) {
      reverseOperations.push({ kind: "delete", sourceIndex: sourceIndex - 1 });
      sourceIndex -= 1;
    } else {
      reverseOperations.push({ kind: "insert", targetIndex: targetIndex - 1 });
      targetIndex -= 1;
    }
  }

  const operations = reverseOperations.reverse();
  const existingIds = new Set(tokens.map((token) => token.id));
  const segmentId = options.segmentId ?? sourceTokens[0]?.segmentId ?? tokens[0]?.segmentId ?? "segment";
  const hiddenAtVisiblePosition = new Map<number, TranscriptStudioToken[]>();
  let visibleCount = 0;
  for (const token of tokens) {
    if (token.hidden) {
      const atPosition = hiddenAtVisiblePosition.get(visibleCount) ?? [];
      atPosition.push({ ...token, hidden: true });
      hiddenAtVisiblePosition.set(visibleCount, atPosition);
    } else {
      visibleCount += 1;
    }
  }

  const aligned: TranscriptStudioToken[] = [];
  const appendHiddenAt = (position: number) => {
    aligned.push(...(hiddenAtVisiblePosition.get(position) ?? []));
  };
  let consumedSource = 0;
  let insertedOrdinal = 0;
  appendHiddenAt(0);

  for (const operation of operations) {
    if (operation.kind === "insert") {
      const text = targetWords[operation.targetIndex];
      const proposedId = options.createTokenId?.({
        segmentId,
        ordinal: insertedOrdinal,
        text,
        existingTokenIds: [...existingIds],
      }) ?? `untimed-${segmentId}-${insertedOrdinal + 1}-${stableTokenSuffix(text)}`;
      insertedOrdinal += 1;
      aligned.push({
        id: makeUniqueTokenId(proposedId, existingIds),
        originalText: "",
        displayText: text,
        startMs: null,
        endMs: null,
        segmentId,
        timingSource: "none",
        hidden: false,
      });
      continue;
    }

    const source = sourceTokens[operation.sourceIndex];
    if (operation.kind === "delete") {
      aligned.push({ ...source, hidden: true });
    } else {
      aligned.push({
        ...source,
        displayText: targetWords[operation.targetIndex],
        hidden: false,
      });
    }
    consumedSource += 1;
    appendHiddenAt(consumedSource);
  }

  return aligned;
}

export interface TranscriptSearchIndexToken {
  tokenId: string;
  segmentId: string;
  start: number;
  end: number;
}

export interface TranscriptSearchIndex {
  text: string;
  tokens: readonly TranscriptSearchIndexToken[];
}

export interface TranscriptSearchMatch {
  index: number;
  query: string;
  start: number;
  end: number;
  tokenIds: readonly string[];
  segmentIds: readonly string[];
}

/** Normalizes user-visible text for case-insensitive, whitespace-tolerant search. */
export function normalizeTranscriptSearchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

/** Builds one compact index over all visible, edited transcript tokens. */
export function buildTranscriptSearchIndex(tokens: readonly TranscriptStudioToken[]): TranscriptSearchIndex {
  const indexedTokens: TranscriptSearchIndexToken[] = [];
  let text = "";

  for (const token of tokens) {
    if (token.hidden) continue;
    const normalized = normalizeTranscriptSearchText(token.displayText);
    if (!normalized) continue;
    if (text) text += " ";
    const start = text.length;
    text += normalized;
    indexedTokens.push({ tokenId: token.id, segmentId: token.segmentId, start, end: text.length });
  }

  return { text, tokens: indexedTokens };
}

/** Returns all case-insensitive matches, including matches in non-rendered segments. */
export function findTranscriptMatches(index: TranscriptSearchIndex, query: string): TranscriptSearchMatch[] {
  const normalizedQuery = normalizeTranscriptSearchText(query);
  if (!normalizedQuery || !index.text) return [];

  const matches: TranscriptSearchMatch[] = [];
  let searchFrom = 0;
  while (searchFrom < index.text.length) {
    const start = index.text.indexOf(normalizedQuery, searchFrom);
    if (start === -1) break;
    const end = start + normalizedQuery.length;
    const matchedTokens = index.tokens.filter((token) => token.start < end && token.end > start);
    matches.push({
      index: matches.length,
      query: normalizedQuery,
      start,
      end,
      tokenIds: matchedTokens.map((token) => token.tokenId),
      segmentIds: [...new Set(matchedTokens.map((token) => token.segmentId))],
    });
    searchFrom = start + Math.max(1, normalizedQuery.length);
  }
  return matches;
}

export type TokenSeekSource = "token" | "nearest-token" | "segment";

export interface TranscriptSeekTarget {
  timeMs: number;
  tokenId: string | null;
  segmentId: string;
  approximate: boolean;
  source: TokenSeekSource;
}

/**
 * Resolves a token click to a genuine timestamp. Untimed insertions borrow the
 * nearest real token or their parent segment; they never receive invented time.
 */
export function resolveTokenSeekTarget(
  tokens: readonly TranscriptStudioToken[],
  tokenId: string,
  segments: readonly TimedTranscriptSegment[] = [],
): TranscriptSeekTarget | undefined {
  const targetIndex = tokens.findIndex((token) => token.id === tokenId);
  if (targetIndex === -1) return undefined;
  const target = tokens[targetIndex];

  if (isFiniteTimestamp(target.startMs)) {
    return {
      timeMs: target.startMs,
      tokenId: target.id,
      segmentId: target.segmentId,
      approximate: target.timingSource !== "word",
      source: "token",
    };
  }

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < tokens.length; index += 1) {
    const candidate = tokens[index];
    if (candidate.hidden || candidate.segmentId !== target.segmentId || !isFiniteTimestamp(candidate.startMs)) continue;
    const distance = Math.abs(index - targetIndex);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  if (nearestIndex !== -1) {
    const nearest = tokens[nearestIndex];
    return {
      timeMs: nearest.startMs as number,
      tokenId: nearest.id,
      segmentId: target.segmentId,
      approximate: true,
      source: "nearest-token",
    };
  }

  const segment = segments.find((candidate) => candidate.id === target.segmentId);
  if (segment && isFiniteTimestamp(segment.startMs)) {
    return {
      timeMs: segment.startMs,
      tokenId: null,
      segmentId: target.segmentId,
      approximate: true,
      source: "segment",
    };
  }
  return undefined;
}

export type ClipRangeError =
  | "invalid-duration"
  | "invalid-time"
  | "in-before-zero"
  | "in-after-duration"
  | "out-after-duration"
  | "out-not-after-in";

export type ClipRangeValidation =
  | { ok: true; inMs: number; outMs: number; durationMs: number }
  | { ok: false; error: ClipRangeError; message: string };

/** Validates an exact clip selection before it reaches an export process. */
export function validateClipRange(inMs: number, outMs: number, videoDurationMs: number): ClipRangeValidation {
  if (!Number.isFinite(videoDurationMs) || videoDurationMs <= 0) {
    return { ok: false, error: "invalid-duration", message: "The video duration is unavailable." };
  }
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
    return { ok: false, error: "invalid-time", message: "Set both an In and an Out point." };
  }
  if (inMs < 0) return { ok: false, error: "in-before-zero", message: "The In point cannot be before zero." };
  if (inMs > videoDurationMs) {
    return { ok: false, error: "in-after-duration", message: "The In point is beyond the video duration." };
  }
  if (outMs > videoDurationMs) {
    return { ok: false, error: "out-after-duration", message: "The Out point is beyond the video duration." };
  }
  if (outMs <= inMs) {
    return { ok: false, error: "out-not-after-in", message: "The Out point must be after the In point." };
  }
  return { ok: true, inMs, outMs, durationMs: outMs - inMs };
}

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);
const WINDOWS_FILENAME_ILLEGAL = /[<>:"/\\|?*]/g;
const WINDOWS_FILENAME_ILLEGAL_TEST = /[<>:"/\\|?*]/;

function hasWindowsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function cleanWindowsFilenameText(value: string): string {
  return value
    .normalize("NFKC")
    .split("")
    .map((character) => (hasWindowsControlCharacter(character) ? " " : character))
    .join("")
    .replace(WINDOWS_FILENAME_ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
}

/** Produces one safe Windows filename component, never a path. */
export function sanitizeWindowsFilenamePart(input: string, fallback = "Untitled"): string {
  const cleaned = cleanWindowsFilenameText(input);
  const safeFallback = cleanWindowsFilenameText(fallback) || "Untitled";
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : safeFallback;
  const baseName = safe.split(".")[0].toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(baseName) ? `_${safe}` : safe;
}

export function isSafeWindowsFilename(filename: string): boolean {
  if (!filename || filename !== filename.trim() || /[\\/:]/.test(filename) || WINDOWS_FILENAME_ILLEGAL_TEST.test(filename) || hasWindowsControlCharacter(filename)) return false;
  if (filename === "." || filename === ".." || /[. ]$/.test(filename)) return false;
  return !WINDOWS_RESERVED_NAMES.has(filename.split(".")[0].toUpperCase());
}

/** Formats a time without `:` so it can safely participate in a filename. */
export function formatFilenameTimestamp(timeMs: number): string {
  const safeTime = Number.isFinite(timeMs) ? Math.max(0, Math.floor(timeMs)) : 0;
  const hours = Math.floor(safeTime / 3_600_000);
  const minutes = Math.floor((safeTime % 3_600_000) / 60_000);
  const seconds = Math.floor((safeTime % 60_000) / 1_000);
  const milliseconds = safeTime % 1_000;
  return `${String(hours).padStart(2, "0")}-${String(minutes).padStart(2, "0")}-${String(seconds).padStart(2, "0")}-${String(milliseconds).padStart(3, "0")}`;
}

function normalizeExtension(extension: string | undefined): string {
  const cleaned = (extension ?? "mp4").trim().replace(/^\.+/, "").replace(/[^A-Za-z\d]/g, "").toLowerCase();
  return `.${cleaned || "mp4"}`;
}

export interface SafeClipFilenameInput {
  videoTitle: string;
  clipLabel: string;
  inMs: number;
  outMs: number;
  extension?: string;
  /** Windows supports 255-character names; 160 leaves room for output paths. */
  maxLength?: number;
}

/** Builds a deterministic, legal, and readable filename for a clip export. */
export function createSafeClipFilename(input: SafeClipFilenameInput): string {
  const extension = normalizeExtension(input.extension);
  const requestedMaximum = Number.isFinite(input.maxLength) ? (input.maxLength as number) : 160;
  const maximum = Math.max(extension.length + 8, Math.min(requestedMaximum, 255));
  const base = [
    sanitizeWindowsFilenamePart(input.videoTitle, "Untitled video"),
    sanitizeWindowsFilenamePart(input.clipLabel, "Clip"),
    `${formatFilenameTimestamp(input.inMs)} to ${formatFilenameTimestamp(input.outMs)}`,
  ].join(" - ");
  const safeBase = base.slice(0, maximum - extension.length).replace(/[. ]+$/g, "") || "Clip";
  return `${safeBase}${extension}`;
}

function splitFilenameExtension(filename: string): { stem: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? { stem: filename.slice(0, dot), extension: filename.slice(dot) } : { stem: filename, extension: "" };
}

/** Returns the first deterministic ` (2)`, ` (3)`, … variant not reported as existing. */
export function nextAvailableFilename(filename: string, exists: (candidate: string) => boolean, maxAttempts = 10_000): string {
  if (!isSafeWindowsFilename(filename)) throw new Error("Filename must be a safe Windows filename.");
  if (!exists(filename)) return filename;
  const { stem, extension } = splitFilenameExtension(filename);
  for (let counter = 2; counter <= maxAttempts + 1; counter += 1) {
    const suffix = ` (${counter})`;
    const maximumStemLength = Math.max(1, 255 - extension.length - suffix.length);
    const candidate = `${stem.slice(0, maximumStemLength).replace(/[. ]+$/g, "") || "Clip"}${suffix}${extension}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error("Could not choose an available filename.");
}

function validWindowsPathPart(part: string): boolean {
  return Boolean(part) && part !== "." && part !== ".." && !/[<>:"|?*]/.test(part) && !hasWindowsControlCharacter(part);
}

/** Normalizes an absolute drive or UNC Windows path without performing I/O. */
export function normalizeWindowsAbsolutePath(input: string): string | undefined {
  const value = input.trim().replace(/\//g, "\\");
  const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(value);
  let prefix: string;
  let remainder: string;
  if (driveMatch) {
    prefix = `${driveMatch[1].toUpperCase()}:\\`;
    remainder = driveMatch[2];
  } else if (value.startsWith("\\\\")) {
    const parts = value.slice(2).split("\\");
    const server = parts.shift();
    const share = parts.shift();
    if (!server || !share || !validWindowsPathPart(server) || !validWindowsPathPart(share)) return undefined;
    prefix = `\\\\${server}\\${share}`;
    remainder = parts.join("\\");
  } else {
    return undefined;
  }

  const normalizedParts: string[] = [];
  for (const part of remainder.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      normalizedParts.pop();
      continue;
    }
    if (!validWindowsPathPart(part)) return undefined;
    normalizedParts.push(part);
  }
  if (!normalizedParts.length) return prefix;
  return `${prefix}${prefix.endsWith("\\") ? "" : "\\"}${normalizedParts.join("\\")}`;
}

/** Checks lexical containment after normalizing drive-letter casing and dot segments. */
export function isWindowsPathWithinRoot(outputRoot: string, candidatePath: string): boolean {
  const root = normalizeWindowsAbsolutePath(outputRoot);
  const candidate = normalizeWindowsAbsolutePath(candidatePath);
  if (!root || !candidate) return false;
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  return candidate.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US"));
}

export type WindowsOutputPathResolution =
  | { ok: true; root: string; path: string }
  | { ok: false; error: "invalid-output-root" | "unsafe-filename" | "outside-output-root" };

/**
 * Joins a plain safe filename to an absolute configured Windows output root.
 * This deliberately rejects subpaths so input cannot climb out of the root.
 */
export function resolveWindowsOutputPath(outputRoot: string, filename: string): WindowsOutputPathResolution {
  const root = normalizeWindowsAbsolutePath(outputRoot);
  if (!root) return { ok: false, error: "invalid-output-root" };
  if (!isSafeWindowsFilename(filename)) return { ok: false, error: "unsafe-filename" };
  const path = `${root}${root.endsWith("\\") ? "" : "\\"}${filename}`;
  if (!isWindowsPathWithinRoot(root, path)) return { ok: false, error: "outside-output-root" };
  return { ok: true, root, path };
}
