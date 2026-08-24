/**
 * Clip matching / scoring engine.
 *
 * Scores a candidate clip against an editorial beat with explicit components.
 * Hard metadata constraints (game, player) outrank semantic similarity; a beat
 * with a hard game/player requirement is only matched by clips satisfying it
 * (master prompt §62). Every score carries its components + reasons so the UI
 * can explain a match.
 */
import type { AssembleBeat } from "./project";
import type { ManifestClip } from "./manifest";
import { detectConcepts, detectGames, normalizeText, tokenOverlap } from "./lexicon";

export interface MatchComponents {
  player: number;
  game: number;
  transcript: number;
  concept: number;
  actionWindow: number;
  duplicatePenalty: number;
  recentUsagePenalty: number;
}

export interface MatchResult {
  clip: ManifestClip;
  score: number;
  confidence: "high" | "medium" | "low" | "unresolved";
  components: MatchComponents;
  reasons: string[];
  hardBlocked: boolean;
  blockReason: string | null;
}

export interface MatchContext {
  /** clipIds already used earlier in the sequence (duplicate penalty) */
  usedClipIds?: Set<string>;
  /** consecutive clips from the same game (variety penalty) */
  recentGames?: string[];
  /** absolute minimum score to label something high */
  highThreshold?: number;
  /** absolute minimum score to accept as low (below → unresolved) */
  acceptThreshold?: number;
}

const HIGH = 0.72;
const ACCEPT = 0.45;

/** Player/game requirement from beat text — hard filters. Evidence may come
 *  from the clip's game/opponent fields OR its provenance text (source title,
 *  transcript) — e.g. "Notre Dame vs Miami" proves both teams for the clip. */
function hardRequirements(beat: AssembleBeat, clip: ManifestClip): { game: boolean; blocked: string | null } {
  const games = detectGames(beat.text);
  if (games.length === 0) return { game: false, blocked: null };

  const searchable = normalizeText(
    [clip.game, clip.opponent, clip.transcript.text, clip.playerMention?.text].filter(Boolean).join(" "),
  );
  const matches = games.some((g) => searchable.includes(normalizeText(g)));
  if (!matches) {
    return { game: true, blocked: `Beat names ${games.join("/")} but this clip is ${clip.game ?? "unknown"}.` };
  }
  return { game: true, blocked: null };
}

export function scoreClipForBeat(
  beat: AssembleBeat,
  clip: ManifestClip,
  ctx: MatchContext = {},
): MatchResult {
  const components: MatchComponents = {
    player: 0,
    game: 0,
    transcript: 0,
    concept: 0,
    actionWindow: 0,
    duplicatePenalty: 0,
    recentUsagePenalty: 0,
  };
  const reasons: string[] = [];

  // 1) Player identity — the clip must be the verified subject. For the
  //    automation path all clips are already player-verified; for the in-app
  //    path the verification flag is the signal.
  if (clip.verification.playerVerified) {
    components.player = 1.0;
    reasons.push("player verified");
  }

  // 2) Hard game constraint (outranks everything else).
  const req = hardRequirements(beat, clip);
  if (req.game) {
    if (req.blocked) return { clip, score: 0, confidence: "unresolved", components, reasons: [], hardBlocked: true, blockReason: req.blocked };
    components.game = 1.0;
    reasons.push("matching game");
  }

  // 3) Transcript / commentary overlap.
  const evidence = [clip.transcript.text, clip.playerMention?.text].filter(Boolean).join(" ");
  const overlap = tokenOverlap(beat.text, evidence);
  components.transcript = Math.min(1, overlap * 1.6);
  if (components.transcript > 0.25) reasons.push("transcript matches narration");

  // 4) Football concept overlap.
  const beatConcepts = new Set(detectConcepts(beat.text));
  const clipConcepts = new Set(detectConcepts(evidence));
  let conceptHits = 0;
  for (const c of beatConcepts) if (clipConcepts.has(c)) conceptHits += 1;
  components.concept = beatConcepts.size ? conceptHits / beatConcepts.size : 0;
  if (components.concept > 0) reasons.push("football concept match");

  // 5) Action-window quality: a clip with a known play window scores higher.
  if (clip.sourceStartSeconds != null && clip.sourceEndSeconds != null && (clip.sourceEndSeconds - clip.sourceStartSeconds) >= 3) {
    components.actionWindow = 0.15;
  }

  // 6) Duplicate / recent-usage penalties.
  if (ctx.usedClipIds?.has(clip.clipId)) {
    components.duplicatePenalty = -1.0;
    reasons.push("already used");
  }
  const game = clip.game ?? clip.opponent;
  if (game && ctx.recentGames?.slice(-2).includes(game)) {
    components.recentUsagePenalty = -0.15;
    reasons.push("recently used same game");
  }

  let score =
    components.player * 0.3 +
    components.game * 0.2 +
    components.transcript * 0.25 +
    components.concept * 0.25 +
    components.actionWindow +
    components.duplicatePenalty +
    components.recentUsagePenalty;

  score = Math.max(0, Math.min(1, score));

  const highThreshold = ctx.highThreshold ?? HIGH;
  const acceptThreshold = ctx.acceptThreshold ?? ACCEPT;
  const confidence: MatchResult["confidence"] =
    score >= highThreshold ? "high" : score >= acceptThreshold ? "medium" : score > 0 ? "low" : "unresolved";

  return { clip, score, confidence, components, reasons, hardBlocked: false, blockReason: null };
}

/** Rank all clips for a beat; best first. */
export function rankClipsForBeat(
  beat: AssembleBeat,
  clips: ManifestClip[],
  ctx: MatchContext = {},
): MatchResult[] {
  return clips
    .map((clip) => scoreClipForBeat(beat, clip, ctx))
    .sort((a, b) => {
      if (a.hardBlocked !== b.hardBlocked) return a.hardBlocked ? 1 : -1;
      return b.score - a.score;
    });
}
