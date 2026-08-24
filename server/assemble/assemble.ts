/**
 * Auto-assembly — turn ranked matches into a V1 timeline.
 *
 * For each beat, allocate the best non-blocked clip above the accept threshold;
 * otherwise emit an honest "NO MATCH" placeholder (master prompt §11). Locked
 * beats and their existing items are left untouched (master prompt §89). Uses
 * action-window source ranges rather than clip starts where available (§63).
 */
import type { AssembleBeat, TimelineItem } from "./project";
import type { ManifestClip } from "./manifest";
import { rankClipsForBeat } from "./match";

export interface AssembleOptions {
  /** max seconds per beat to use from a clip (avoid over-long shots) */
  maxClipSeconds?: number;
  /** minimum shot duration to keep cuts readable */
  minShotSeconds?: number;
  /** beat ids that are locked (skip) */
  lockedBeatIds?: Set<string>;
  /** existing items to preserve (locked / manual work) */
  preserveItems?: TimelineItem[];
}

const DEFAULT_MAX = 12;
const DEFAULT_MIN = 2.5;
const ACCEPT_SCORE = 0.4;

export interface AutoAssembleResult {
  items: TimelineItem[];
  placeholders: Array<{ beatId: string; beatText: string; suggested: string[] }>;
  unresolvedBeatIds: string[];
}

export function autoAssemble(
  beats: AssembleBeat[],
  clips: ManifestClip[],
  opts: AssembleOptions = {},
): AutoAssembleResult {
  const maxClip = opts.maxClipSeconds ?? DEFAULT_MAX;
  const minShot = opts.minShotSeconds ?? DEFAULT_MIN;
  const locked = opts.lockedBeatIds ?? new Set<string>();

  const preserved = (opts.preserveItems ?? []).filter((i) => i.locked);
  const items: TimelineItem[] = [...preserved];
  let cursor = preserved.reduce((max, i) => Math.max(max, i.timelineEnd), 0);

  const usedClipIds = new Set<string>(preserved.map((i) => i.clipId).filter((c): c is string => c != null));
  const recentGames: string[] = [];
  const placeholders: AutoAssembleResult["placeholders"] = [];
  const unresolvedBeatIds: string[] = [];

  for (const beat of beats) {
    if (locked.has(beat.id)) continue;
    if (beat.beatType === "graphic" || beat.beatType === "no-clip") {
      // no football clip required; emit an intentional empty marker
      continue;
    }

    const ranking = rankClipsForBeat(beat, clips, { usedClipIds, recentGames });
    const best = ranking.find((r) => !r.hardBlocked && r.score >= ACCEPT_SCORE);

    const beatDuration = beat.narrationStart != null && beat.narrationEnd != null
      ? Math.max(minShot, beat.narrationEnd - beat.narrationStart)
      : minShot;

    if (!best || best.confidence === "unresolved") {
      // Fallback for generic beats (§15): when the narration carries NO hard
      // constraint (no named game/player), fill the window with the best
      // available verified clip as "generic b-roll" so the draft stays whole
      // and exportable. Beats whose candidates are ALL hard-blocked (named
      // game/player mismatch) stay honest NO MATCH placeholders — the §49 gate.
      // Never reuses a clip (§78 diversity); when every unused clip is blocked,
      // the beat stays an honest placeholder.
      const fallback = ranking.find((r) => !r.hardBlocked && !usedClipIds.has(r.clip.clipId));
      if (fallback) {
        const clip = fallback.clip;
        const srcIn = clip.sourceStartSeconds ?? 0;
        const srcDuration = clip.clipDurationSeconds ?? (clip.sourceEndSeconds ?? 0) - (clip.sourceStartSeconds ?? 0);
        const useSeconds = Math.max(minShot, Math.min(beatDuration, maxClip, srcDuration || beatDuration));
        items.push({
          id: `item-${beat.ord}-${items.length + 1}`,
          clipId: clip.clipId,
          track: "V1",
          timelineStart: cursor,
          timelineEnd: cursor + useSeconds,
          sourcePath: clip.localPath,
          sourceIn: srcIn,
          sourceOut: srcIn + useSeconds,
          beatId: beat.id,
          matchConfidence: fallback.score,
          matchReason: ["generic b-roll (best available)", ...fallback.reasons],
          locked: false,
          unresolved: false,
          sourceMode: "generic",
          gain: 1,
          cropMode: "fill",
          cropX: 0,
          cropY: 0,
        });
        usedClipIds.add(clip.clipId);
        const game = clip.game ?? clip.opponent;
        if (game) recentGames.push(game);
        cursor += useSeconds;
        continue;
      }
      const suggested = ranking.slice(0, 3).map((r) => r.reasons.join(", ")).filter(Boolean);
      placeholders.push({ beatId: beat.id, beatText: beat.text, suggested });
      unresolvedBeatIds.push(beat.id);
      items.push({
        id: `item-unresolved-${beat.ord}`,
        clipId: null,
        track: "V1",
        timelineStart: cursor,
        timelineEnd: cursor + beatDuration,
        sourcePath: null,
        sourceIn: null,
        sourceOut: null,
        beatId: beat.id,
        matchConfidence: null,
        matchReason: ["no verified match"],
        locked: false,
        unresolved: true,
        sourceMode: null,
        gain: 1,
        cropMode: "fit",
        cropX: 0,
        cropY: 0,
      });
      cursor += beatDuration;
      continue;
    }

    const clip = best.clip;
    const srcIn = clip.sourceStartSeconds ?? 0;
    const srcDuration = clip.clipDurationSeconds ?? (clip.sourceEndSeconds ?? 0) - (clip.sourceStartSeconds ?? 0);
    const useSeconds = Math.max(minShot, Math.min(beatDuration, maxClip, srcDuration || beatDuration));
    const srcOut = srcIn + useSeconds;

    items.push({
      id: `item-${beat.ord}-${items.length + 1}`,
      clipId: clip.clipId,
      track: "V1",
      timelineStart: cursor,
      timelineEnd: cursor + useSeconds,
      sourcePath: clip.localPath,
      sourceIn: srcIn,
      sourceOut: srcOut,
      beatId: beat.id,
      matchConfidence: best.score,
      matchReason: best.reasons,
      locked: false,
      unresolved: false,
      sourceMode: "action",
      gain: 1,
      cropMode: "fill",
      cropX: 0,
      cropY: 0,
    });

    usedClipIds.add(clip.clipId);
    const game = clip.game ?? clip.opponent;
    if (game) recentGames.push(game);
    cursor += useSeconds;
  }

  return { items, placeholders, unresolvedBeatIds };
}
