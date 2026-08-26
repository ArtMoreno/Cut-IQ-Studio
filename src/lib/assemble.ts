/**
 * Assemble client helpers — pure, no DOM/network. Mirrors the server's
 * AssembleDoc shape (server/assemble/project.ts) for the editor UI.
 */

export type Track = "V1" | "V2" | "A1" | "A2" | "A3";
export type PresetId = "vertical-9x16" | "youtube-16x9" | "square";
export type ClipSourceMode = "action" | "replay" | "full-play" | "generic";

export interface AssembleBeat {
  id: string;
  ord: number;
  text: string;
  intent: string[];
  entities: string[];
  queries: string[];
  beatType: "footage" | "graphic" | "montage" | "no-clip";
  narrationStart: number | null;
  narrationEnd: number | null;
  locked: boolean;
  unresolved: boolean;
}

export interface TimelineItem {
  id: string;
  clipId: string | null;
  track: Track;
  timelineStart: number;
  timelineEnd: number;
  sourcePath: string | null;
  sourceIn: number | null;
  sourceOut: number | null;
  beatId: string | null;
  matchConfidence: number | null;
  matchReason: string[];
  locked: boolean;
  unresolved: boolean;
  sourceMode: ClipSourceMode | null;
  gain: number;
  cropMode: "fit" | "fill" | "crop" | null;
  cropX: number;
  cropY: number;
  graphic?: { kind: "title" | "lower-third" | "stat" | "caption"; text: string; subtext?: string };
}

export interface AssembleDoc {
  schemaVersion: number;
  name: string;
  settings: { width: number; height: number; fps: number; preset: PresetId };
  scriptText: string | null;
  beats: AssembleBeat[];
  narration: {
    sourcePath: string | null;
    aligned: boolean;
    confidence: number | null;
    segments: Array<{ text: string; start: number; end: number }> | null;
  } | null;
  items: TimelineItem[];
  locked: { noReuse: boolean; preferredGame: string | null };
}

export interface ManifestClip {
  clipId: string;
  candidateId: number;
  beatOrd: number;
  beatText: string;
  game: string | null;
  opponent: string | null;
  sourceUrl: string;
  sourceVideoId: string | null;
  localPath: string | null;
  downloadUrl: string | null;
  drivePath: string | null;
  sourceStartSeconds: number | null;
  sourceEndSeconds: number | null;
  clipDurationSeconds: number | null;
  resolution: { width: number | null; height: number | null };
  container: string | null;
  codec: string | null;
  playerMention: { text: string | null; timeSeconds: number | null } | null;
  queryContext: string[];
  coverageTypes: string[];
  purpose: string | null;
  transcript: { text: string | null; segmentStart: number | null; segmentEnd: number | null };
  tags: string[];
  selectionKind?: "player_play" | "broadcast_soundbite" | "mention_match" | "other";
  verification: {
    playerVerified: boolean;
    contextVerified: boolean;
    confidence: number | null;
    matchKind: string;
    reason: string | null;
  };
}

export interface ClipManifest {
  schemaVersion: number;
  generatedAt: string;
  projectId: number;
  projectName: string;
  topic: string | null;
  player: { name: string; team: string | null; season: string | null } | null;
  clips: ManifestClip[];
  unresolvedBeats: number[];
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0.0s";
  if (sec >= 60) return `${fmtClock(sec)} (${sec.toFixed(1)}s)`;
  return `${sec.toFixed(1)}s`;
}

/** Pick a usable playback source for a timeline item (local first). */
export function itemPreviewSource(item: TimelineItem, clips: ManifestClip[]): string | null {
  if (!item.clipId) return null;
  const clip = clips.find((c) => c.clipId === item.clipId);
  return clip?.downloadUrl ?? clip?.sourceUrl ?? null;
}

/** Best playable source for a manifest clip. Rendered local media wins. */
export function clipPreviewSource(clip: ManifestClip): string | null {
  return clip.downloadUrl ?? clip.sourceUrl ?? null;
}

/** YouTube preview art when the manifest has a stable video id. */
export function clipThumbnailSource(clip: ManifestClip): string | null {
  return clip.sourceVideoId ? `https://i.ytimg.com/vi/${clip.sourceVideoId}/mqdefault.jpg` : null;
}

/** Reliable clip length for collection and timeline placement. */
export function manifestClipDuration(clip: ManifestClip): number {
  const range = (clip.sourceEndSeconds ?? 0) - (clip.sourceStartSeconds ?? 0);
  const duration = clip.clipDurationSeconds ?? range;
  return Number.isFinite(duration) && duration > 0 ? Math.max(0.3, duration) : 4;
}

/**
 * Build one clip-first timeline item. A rendered clip is already a standalone
 * file, so its edit window is clip-relative (0..duration). This keeps preview
 * and export aligned without changing the Assemble renderer.
 */
export function timelineItemFromManifestClip(
  clip: ManifestClip,
  timelineStart: number,
  id: string,
): TimelineItem {
  const duration = manifestClipDuration(clip);
  const hasRenderedFile = Boolean(clip.localPath || clip.downloadUrl);
  const sourceIn = hasRenderedFile ? 0 : (clip.sourceStartSeconds ?? 0);
  return {
    id,
    clipId: clip.clipId,
    track: "V1",
    timelineStart,
    timelineEnd: timelineStart + duration,
    sourcePath: clip.localPath,
    sourceIn,
    sourceOut: sourceIn + duration,
    beatId: clip.beatOrd >= 0 ? `beat-${clip.beatOrd}` : null,
    matchConfidence: clip.verification.confidence,
    matchReason: [
      clip.verification.matchKind,
      ...(clip.verification.reason ? [clip.verification.reason] : []),
    ],
    locked: false,
    unresolved: false,
    sourceMode: "action",
    gain: 1,
    cropMode: "fit",
    cropX: 0,
    cropY: 0,
  };
}

/** Duration of the whole timeline (max item end). */
export function timelineDuration(items: TimelineItem[]): number {
  return items.reduce((max, i) => Math.max(max, i.timelineEnd), 0);
}

/** Sort items by (track order, then timeline start) for stable rendering. */
export function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const trackRank: Record<Track, number> = { V1: 0, V2: 1, A1: 2, A2: 3, A3: 4 };
  return [...items].sort(
    (a, b) => trackRank[a.track] - trackRank[b.track] || a.timelineStart - b.timelineStart,
  );
}

/** Distinct tracks present, in display order. */
export function tracksIn(items: TimelineItem[]): Track[] {
  const order: Track[] = ["V2", "V1", "A1", "A2", "A3"];
  const present = new Set(items.map((i) => i.track));
  return order.filter((t) => present.has(t));
}
