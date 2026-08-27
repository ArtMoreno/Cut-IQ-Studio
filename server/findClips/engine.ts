import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  clipCandidates,
  clipJobs,
  findJobs,
  findSources,
  scriptBeats,
  scriptProjects,
  scriptRevisions,
  transcriptSegments,
  videos,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { extractVideoId, fetchVideoMeta } from "../clipsift";
import { getTranscriptProvider } from "../transcript/youtubeProvider";
import { fetchLocalWhisperTranscript } from "../transcript/localWhisperProvider";
import type { TranscriptResult } from "../transcript/provider";
import { searchYouTubeKeyless } from "../script/providers";
import { enqueueClip, cancelRunningJob } from "../clip/engine";
import { runAnalyze, runDiscover, runRank, upsertScriptProject } from "../script/pipeline";
import { progressForStage } from "./progress";
import { curatedSourcesForFindJob } from "./curatedSources";
import { probeMedia } from "../clip/mediaProbe";
import { transcribeVoiceover } from "../assemble/voiceover";
import { canonicalLocalVideoPath } from "../transcriptStudio/exportPaths";
import { readHighlightTunerGate } from "./highlightTunerGate";
import { highlightGameKey, highlightTitleMatchesSeason, selectHighlights } from "./highlightSelector";
import { resolveStoredHighlightTunerSettings } from "./highlightTunerConfig";

export type FindJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export interface CreateFindJobInput {
  player: string;
  team: string;
  season: number;
  opponent?: string;
  scriptText: string;
  projectName?: string;
  sourceLimit?: number;
  clipLimit?: number;
  preferredHeight?: number;
  minimumHeight?: number;
  preRollSec?: number;
  postRollSec?: number;
  localAsrFallback?: boolean;
  highlightTuner?: {
    mode: "everything" | "balanced" | "highlights" | "best_only" | "custom";
    maxClipsPerGame?: number;
    minimumEstimatedYards?: number;
    minimumExcitement?: number;
    includeProbablePlays?: boolean;
    alwaysIncludeTouchdowns?: boolean;
    includeKeyDowns?: boolean;
    includeRedZonePlays?: boolean;
  };
  autoStart?: boolean;
}

export function parseFindJobGames(value?: string | null): string[] {
  const seen = new Set<string>();
  return (value ?? "")
    .split(/[\n,;|]+/)
    .map((game) => game.trim())
    .filter((game) => {
      if (!game) return false;
      const key = normalize(game);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function buildFindJobSearchQueries(input: {
  player: string;
  team: string;
  season: number;
  games?: string | null;
  beatText?: string;
  beatOrd?: number;
}): string[] {
  const text = normalize(input.beatText ?? "");
  const actions: string[] = [];
  if (/intercept|picked off|\bpicks?\b|turnover/.test(text)) actions.push("interception", "pick six");
  if (/touchdown|took one back/.test(text)) actions.push("touchdown return");
  if (/tackle/.test(text)) actions.push("tackle");
  if (/pass breakup|catch point/.test(text)) actions.push("pass breakup");
  if (/\bsack\b/.test(text)) actions.push("sack");
  if (/starter|cornerback|outside corner/.test(text)) actions.push("cornerback highlights");

  const games = parseFindJobGames(input.games);
  const gameOffset = ((input.beatOrd ?? 0) * 2) % Math.max(1, games.length);
  const activeGame = games.length ? games[gameOffset] : null;
  const nextGame = games.length > 1 ? games[(gameOffset + 1) % games.length] : activeGame;
  const action = actions[0] ?? "highlights";
  const queries = activeGame
    ? [
        `${input.player} ${activeGame} ${input.season} ${action}`,
        `${input.team} ${nextGame} ${input.season} full game`,
        `${input.team} ${activeGame} ${input.season} full game`,
        `${input.player} ${nextGame} ${input.season} highlights`,
        `${input.player} ${input.team} ${input.season} highlights`,
        `${input.team} ${input.season} football full game`,
      ]
    : [
        `${input.player} ${input.team} ${input.season} ${action}`,
        `${input.team} ${input.season} football full game`,
        `${input.player} ${input.team} ${input.season} highlights`,
        `${input.team} ${input.season} football highlights`,
        ...actions.slice(1, 3).map((term) => `${input.player} ${input.team} ${input.season} ${term}`),
      ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()))].slice(0, 6);
}

const ACTIVE_CLIP_STATUSES = ["queued", "downloading", "uploading"] as const;
const TERMINAL_FIND_STATUSES = ["completed", "completed_with_warnings", "cancelled", "failed"];
const NEGATIVE_SOURCE_TERMS = ["podcast", "reaction", "gaming", "madden", "interview", "talk show", "preview", "prediction"];
const POSITIVE_SOURCE_TERMS = ["official", "highlights", "full game", "condensed", "broadcast", "football", "sports"];
const STOP = new Set([
  "the", "and", "that", "this", "with", "from", "into", "for", "his", "her", "their", "was", "were", "are", "but",
  "against", "game", "season", "team", "player", "football", "after", "before", "when", "then", "than", "they", "them",
]);

function clipRangeKey(sourceUrl: string, editIn: number, editOut: number): string {
  return `${extractVideoId(sourceUrl) ?? sourceUrl}|${editIn.toFixed(1)}|${editOut.toFixed(1)}`;
}

let workerStarted = false;
let pumping = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function jsonStrings(value: string | null): string[] {
  try {
    return value ? (JSON.parse(value) as string[]) : [];
  } catch {
    return [];
  }
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TEAM_SUFFIXES = new Set([
  "bearcats", "bears", "buckeyes", "bulls", "cardinals", "cavaliers", "cougars", "cowboys", "cyclones",
  "eagles", "falcons", "gators", "hawks", "hokies", "hurricanes", "jaguars", "jayhawks", "knights",
  "nittany", "panthers", "rams", "rebels", "seminoles", "spartans", "tigers", "trojans", "utes", "wildcats",
  "wolverines", "wolfpack",
]);

/** Return stable school/team aliases without turning a mascot into identity. */
export function teamAliases(team: string): string[] {
  const full = normalize(team);
  const parts = full.split(" ").filter(Boolean);
  const withoutMascot = parts.filter((part, index) => index < parts.length - 1 || !TEAM_SUFFIXES.has(part)).join(" ");
  return [...new Set([full, withoutMascot].filter((alias) => alias.length >= 3))];
}

function teamIdentityStrength(value: string, team: string): number {
  const haystack = normalize(value);
  const aliases = teamAliases(team);
  if (aliases.some((alias) => haystack.includes(alias))) return 1;
  const teamParts = normalize(team).split(" ").filter((part) => part.length >= 4 && !TEAM_SUFFIXES.has(part));
  if (!teamParts.length) return 0;
  const haystackParts = new Set(haystack.split(" "));
  return teamParts.filter((part) => haystackParts.has(part)).length / teamParts.length;
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOP.has(token));
}

export const PLAYER_PLAY_REASON_PREFIX = "Player-action play sequence";
export const BROADCAST_SOUNDBITE_REASON_PREFIX = "Broadcast sound bite";
export const BROADCAST_IDENTITY_ANCHOR = "full-name identity anchored in this broadcast";

function editDistance(left: string, right: string): number {
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = prior[0]!;
    prior[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = prior[rightIndex]!;
      prior[rightIndex] = Math.min(
        prior[rightIndex]! + 1,
        prior[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prior[right.length]!;
}

function playerNamePositions(value: string, player: string): number[] {
  const nameParts = normalize(player).split(" ").filter(Boolean);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.at(-1) ?? "";
  if (lastName.length < 4) return [];
  // Short surnames are dangerously close to ordinary caption words. For
  // example, the old distance of 3 allowed "last"/"lead" to stand in for
  // "Lucas" and turned generic team plays into false player matches.
  const allowedDistance = lastName.length <= 5 ? 1 : lastName.length >= 8 ? 3 : 2;
  const positions: number[] = [];
  const matches = [...value.matchAll(/\b[a-z]+\b/g)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const word = match[0];
    const next = matches[index + 1]?.[0] ?? "";
    const surname = word.length <= 2 && next ? `${word}${next}` : word;
    if (surname[0] !== lastName[0] || Math.abs(surname.length - lastName.length) > allowedDistance) continue;
    const distance = editDistance(surname, lastName);
    const previousIndex = word.length <= 2 && next ? index - 1 : index - 1;
    const previous = matches[previousIndex]?.[0] ?? "";
    const firstAttached = previous[0] === firstName[0]
      && Math.abs(previous.length - firstName.length) <= 1
      && editDistance(previous, firstName) <= 1;
    const accepted = surname === lastName
      || (distance <= allowedDistance && (lastName.length > 5 || firstAttached));
    if (accepted) positions.push(match.index);
  }
  return positions;
}

function hasPlayerFullName(value: string, player: string): boolean {
  const nameParts = normalize(player).split(" ").filter(Boolean);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.at(-1) ?? "";
  const words = normalize(value).match(/\b[a-z]+\b/g) ?? [];
  const firstDistance = firstName.length <= 6 ? 1 : 2;
  const lastDistance = lastName.length <= 5 ? 1 : lastName.length >= 8 ? 3 : 2;
  for (let index = 0; index < words.length - 1; index++) {
    const first = words[index]!;
    const firstMatches = first[0] === firstName[0] && Math.abs(first.length - firstName.length) <= firstDistance && editDistance(first, firstName) <= firstDistance;
    if (!firstMatches) continue;
    const surnameCandidates = [
      words[index + 1] ?? "",
      `${words[index + 1] ?? ""}${words[index + 2] ?? ""}`,
    ];
    if (surnameCandidates.some((last) =>
      last[0] === lastName[0]
      && Math.abs(last.length - lastName.length) <= lastDistance
      && editDistance(last, lastName) <= lastDistance
    )) return true;
  }
  return false;
}

export type PlayerIdentityEvidence = "target" | "other" | "uncertain" | "absent";

/**
 * Resolve identity independently from action scoring. Exact/fuzzy full-name
 * evidence can approve a candidate; surname-only evidence stays reviewable;
 * an explicitly different first name (Jaylen Lucas) or use of the target
 * surname as another person's first name (Lucas Carneiro) is rejected.
 */
export function playerIdentityEvidence(text: string, player: string): PlayerIdentityEvidence {
  const normalizedText = normalize(text);
  if (hasPlayerFullName(normalizedText, player)) return "target";
  const nameParts = normalize(player).split(" ").filter(Boolean);
  const firstName = nameParts[0] ?? "";
  const lastName = nameParts.at(-1) ?? "";
  if (!lastName || !playerNamePositions(normalizedText, player).length) return "absent";

  const rawWords = text.match(/\b[A-Za-z][A-Za-z'-]*\b/g) ?? [];
  for (let index = 0; index < rawWords.length; index++) {
    const word = normalize(rawWords[index]!);
    const next = normalize(rawWords[index + 1] ?? "");
    if (!word || !next) continue;
    const startsLikeName = /^[A-Z]/.test(rawWords[index]!) && /^[A-Z]/.test(rawWords[index + 1]!);
    if (!startsLikeName) continue;
    if (next === lastName && word !== firstName) return "other";
    if (word === lastName && next !== firstName) return "other";
  }
  return "uncertain";
}

export function playerActionScore(text: string, player: string): number {
  const value = normalize(text);
  const namePositions = playerNamePositions(value, player);
  if (!namePositions.length) return 0;
  if (playerIdentityEvidence(text, player) === "other") return 0;
  if (/\bbrother\b/.test(value) && !hasPlayerFullName(value, player)) return 0;
  const signals: Array<[RegExp, number]> = [
    [/\b(touchdown|scores?|into the end zone|finds the end zone)\b/, 5],
    [/\b(throws?|passing|pass is complete|complete to|caught by|connects with|deep ball)\b/, 4],
    [/\b(scrambles?|keeps it|quarterback keeper|designed run|zone read|rushes?|runs? for)\b/, 4],
    [/\b(first down|gain of|picked up|\d{1,2} yards?|inside the \d{1,2}|to the \d{1,2})\b/, 2.5],
    [/\b(broken tackle|sideline|under pressure|steps up|rolls? out|play action)\b/, 2],
    [/\b(intercepts?|interception|pick six|picked off)\b/, 5],
    [/\b(tackles?|tackled by|made the tackle|makes? the tackle|in on the tackle|combined for the tackle|stops?|brings? (?:him|the runner) down|open field tackle)\b/, 5],
    [/\b(pushed? (?:him|the runner)? ?out|forced? (?:him|the runner)? ?out|out of bounds by|had him tied up)\b/, 5],
    [/\b(pass breakups?|breaks? up the pass|broken up|knocks? (?:it|the pass) away|knocked away|deflects?|deflected|bats? (?:it|the pass) down|got (?:a|his) hand on (?:it|the ball)|gets? (?:a|his) hand on (?:it|the ball))\b/, 5],
    [/\b(almost (?:picked off|intercepted|an interception)|diving (?:interception )?attempt|nearly (?:picked off|intercepted))\b/, 5],
    [/\b(read (?:it )?beautifully|well defended|helped in (?:the )?coverage|excellent coverage|good coverage|pretty good (?:job of )?coverage|in coverage|nice play in the secondary|stellar defensive work|forced? (?:the )?incompletion|wasnt there)\b/, 5],
    [/\b(sacks?|pressures?|quarterback pressure|blitz(?:es|ing)?)\b/, 4],
    [/\b(forced fumble|forces? the fumble|fumble recovery|recovers? the fumble)\b/, 4],
    [/\b(coverage|covered|targeted|cornerback|defensive back)\b/, 2],
  ];
  let score = 2;
  let primaryHits = 0;
  for (const [pattern, weight] of signals) {
    const match = pattern.exec(value);
    if (!match || match.index == null) continue;
    const closeToName = namePositions.some((position) => Math.abs(position - match.index) <= 160);
    if (!closeToName) continue;
    score += weight;
    primaryHits++;
  }
  if (!primaryHits) return 0;
  if (/\b(first|second|third|fourth) and \d+\b/.test(value)) score += 1;
  if (score < 7 && /\b(freshman|starter|season|record|award|mvp|statistically|coming into today|on the year)\b/.test(value)) score -= 3;
  if (/\b(fighting off|winning the one on one (?:battle|battles)|couldnt collect|dropped it|beat(?:en)? by the receiver)\b/.test(value)) score -= 6;
  if (/\bworking against\b/.test(value) && /\b(?:caught|catch|first down)\b/.test(value)) score -= 8;
  const namedAsOpponentOnCatch = /\b(?:caught|catch|first down)\b/.test(value)
    && namePositions.some((position) => /\bagainst\s*$/.test(value.slice(Math.max(0, position - 32), position)));
  if (namedAsOpponentOnCatch) score -= 8;
  if (/\b(?:pushed? [a-z ]{2,24}|[a-z]+|o [a-z]+) to the ground as\b.{0,100}\bbreaks? up the pass\b/.test(value)) score -= 8;
  if (/\b(starting corners? out of (?:this|the) game|holding down the other corner spot|injur(?:y|ies|ed) piling up)\b/.test(value)) score -= 8;
  if (/\b(pass interference|didnt get a jam|did not get a jam|failed to reroute|easy route and an? easy throw|beaten in coverage|beat him in coverage|gave up the (?:catch|completion|touchdown))\b/.test(value)) score -= 7;
  if (/\b(will he|tonight|games this year|most of any|coming into the year|became the starter|most recently|picked up a yard|comes back in)\b/.test(value)) score -= 4;
  if (/\b(games this year|most of any|passing touchdown and a rushing touchdown|tied for the most)\b/.test(value)) score -= 3;
  return Math.max(0, Math.round(score * 10) / 10);
}

export function playerHighlightCandidateIsCanonical(
  candidate: { reason?: string | null; transcriptExcerpt?: string | null },
  player: string,
): boolean {
  const identity = playerIdentityEvidence(candidate.transcriptExcerpt ?? "", player);
  return Boolean(
    !candidate.reason?.startsWith(BROADCAST_SOUNDBITE_REASON_PREFIX)
      && (identity === "target" || (identity === "uncertain" && candidate.reason?.includes(BROADCAST_IDENTITY_ANCHOR)))
      && playerActionScore(candidate.transcriptExcerpt ?? "", player) >= 7,
  );
}

export function playerCandidateIsReviewable(
  candidate: { reason?: string | null; transcriptExcerpt?: string | null },
  player: string,
): boolean {
  const identity = playerIdentityEvidence(candidate.transcriptExcerpt ?? "", player);
  if (identity === "other" || identity === "absent") return false;
  if (candidate.reason?.startsWith(BROADCAST_SOUNDBITE_REASON_PREFIX)) {
    return broadcastSoundbiteScore(candidate.transcriptExcerpt ?? "", player) >= 6;
  }
  return playerActionScore(candidate.transcriptExcerpt ?? "", player) >= 4;
}

function playerEvidenceTerms(text: string | null | undefined): Set<string> {
  return new Set((text?.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((term) => term.length >= 4));
}

function playerEvidenceContainment(left: string | null | undefined, right: string | null | undefined): number {
  const leftTerms = playerEvidenceTerms(left);
  const rightTerms = playerEvidenceTerms(right);
  const denominator = Math.min(leftTerms.size, rightTerms.size);
  if (denominator < 8) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared++;
  return shared / denominator;
}

function playerEvidenceSharesSequence(left: string | null | undefined, right: string | null | undefined, size = 7): boolean {
  const leftWords = normalize(left ?? "").split(" ").filter(Boolean);
  const rightText = ` ${normalize(right ?? "")} `;
  if (leftWords.length < size) return false;
  for (let index = 0; index <= leftWords.length - size; index++) {
    if (rightText.includes(` ${leftWords.slice(index, index + size).join(" ")} `)) return true;
  }
  return false;
}

export function uniqueCanonicalPlayerHighlightCandidates<
  T extends { reason?: string | null; transcriptExcerpt?: string | null },
>(candidates: T[], player: string): T[] {
  const kept: T[] = [];
  for (const candidate of candidates) {
    if (!playerHighlightCandidateIsCanonical(candidate, player)) continue;
    if (kept.some((prior) =>
      playerEvidenceContainment(prior.transcriptExcerpt, candidate.transcriptExcerpt) >= 0.78
      || playerEvidenceSharesSequence(prior.transcriptExcerpt, candidate.transcriptExcerpt)
    )) continue;
    kept.push(candidate);
  }
  return kept;
}

export function uniqueCanonicalBroadcastSoundbiteCandidates<
  T extends { reason?: string | null; transcriptExcerpt?: string | null },
>(candidates: T[], player: string): T[] {
  const kept: T[] = [];
  for (const candidate of candidates) {
    if (!broadcastSoundbiteCandidateIsCanonical(candidate, player)) continue;
    if (kept.some((prior) =>
      playerEvidenceContainment(prior.transcriptExcerpt, candidate.transcriptExcerpt) >= 0.78
      || playerEvidenceSharesSequence(prior.transcriptExcerpt, candidate.transcriptExcerpt)
    )) continue;
    kept.push(candidate);
  }
  return kept;
}

export function uniqueReviewablePlayerCandidates<
  T extends { reason?: string | null; transcriptExcerpt?: string | null },
>(candidates: T[], player: string): T[] {
  const kept: T[] = [];
  for (const candidate of candidates) {
    if (!playerCandidateIsReviewable(candidate, player)) continue;
    if (kept.some((prior) =>
      playerEvidenceContainment(prior.transcriptExcerpt, candidate.transcriptExcerpt) >= 0.78
      || playerEvidenceSharesSequence(prior.transcriptExcerpt, candidate.transcriptExcerpt)
    )) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * Score commentary that is about the player rather than a live call of a play.
 * This is deliberately separate from playerActionScore so the normal player-
 * play quota and queue never absorb profile, sideline or analysis moments.
 */
export function broadcastSoundbiteScore(text: string, player: string): number {
  const value = normalize(text);
  const namePositions = playerNamePositions(value, player);
  if (!namePositions.length || (value.includes("brother") && !hasPlayerFullName(value, player))) return 0;

  const editorialSignals: Array<[RegExp, number]> = [
    [/\b(talked to|spoke with|told us|said (?:that|he)|asked (?:him|about)|what can you tell us|keep an eye on)\b/, 4],
    [/\b(grew up|high school|recruited|recruiting|transfer(?:red)?|journey|background|family|father|mother)\b/, 4],
    [/\b(freshman|sophomore|junior|senior|starter|starting quarterback|first start|young quarterback)\b/, 3],
    [/\b(leadership|confidence|composure|maturity|mentality|personality|passionate|toughness|tough young|work ethic)\b/, 3],
    [/\b(impressive|remarkable|special|talent|ability|comfortable|accurate|accuracy|decision making|development)\b/, 2.5],
    [/\b(injury|injured|ankle|knee|shoulder|health|limping|sideline|pregame|halftime)\b/, 2.5],
    [/\b(on the year|this season|career|record|statistically|completion percentage|passing yards|rushing yards|touchdowns?)\b/, 2],
    [/\b(what makes|most impressed|the thing about|why he|how he|does such a good job|great job of)\b/, 2],
  ];
  let score = 2;
  let editorialHits = 0;
  for (const [pattern, weight] of editorialSignals) {
    const match = pattern.exec(value);
    if (!match || match.index == null) continue;
    const closeToName = namePositions.some((position) => Math.abs(position - match.index) <= 200);
    if (!closeToName) continue;
    score += weight;
    editorialHits++;
  }
  if (!editorialHits) return 0;
  if (value.split(" ").length >= 35) score += 1;

  const livePlaySignals = [
    /\b(first|second|third|fourth) and \d+\b/,
    /\b(takes? the snap|takes? a snap|play fake|play action|hands? it off)\b/,
    /\b(throws?|scrambles?|keeps it|rolls? out|complete to|caught by|first down)\b/,
    /\b(underneath to|over the middle to|out to|to the \d{1,2}|inside the \d{1,2}|gain of \d+|for \d+ yards?)\b/,
  ].filter((pattern) => pattern.test(value)).length;
  if ((livePlaySignals >= 1 && editorialHits < 2) || (livePlaySignals >= 2 && editorialHits < 3)) return 0;
  score -= livePlaySignals * 1.5;
  return Math.max(0, Math.round(score * 10) / 10);
}

export function broadcastSoundbiteCandidateIsCanonical(
  candidate: { reason?: string | null; transcriptExcerpt?: string | null },
  player: string,
): boolean {
  const identity = playerIdentityEvidence(candidate.transcriptExcerpt ?? "", player);
  return Boolean(
    candidate.reason?.startsWith(BROADCAST_SOUNDBITE_REASON_PREFIX)
      && (identity === "target" || (identity === "uncertain" && candidate.reason?.includes(BROADCAST_IDENTITY_ANCHOR)))
      && broadcastSoundbiteScore(candidate.transcriptExcerpt ?? "", player) >= 6,
  );
}

export interface BroadcastTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface BroadcastSoundbiteWindow {
  start: number;
  end: number;
  editIn: number;
  editOut: number;
  center: number;
  text: string;
  score: number;
}

/** Pick contextual, non-overlapping commentary windows from one broadcast. */
export function selectBroadcastSoundbiteWindows(
  segments: BroadcastTranscriptSegment[],
  player: string,
  limit = 3,
): BroadcastSoundbiteWindow[] {
  const hits: BroadcastSoundbiteWindow[] = [];
  for (let index = 0; index < segments.length; index++) {
    if (!playerNamePositions(normalize(segments[index]!.text), player).length) continue;
    const startIndex = Math.max(0, index - 6);
    const endIndex = Math.min(segments.length - 1, index + 12);
    const windowSegments = segments.slice(startIndex, endIndex + 1);
    const text = windowSegments.map((segment) => segment.text).join(" ");
    const score = broadcastSoundbiteScore(text, player);
    if (score < 6) continue;
    const start = windowSegments[0]!.start;
    const end = windowSegments.at(-1)!.end;
    const center = (segments[index]!.start + segments[index]!.end) / 2;
    const editIn = Math.max(0, start - 5);
    const editOut = Math.max(editIn + 8, Math.min(editIn + 75, end + 6));
    hits.push({ start, end, editIn, editOut, center, text, score });
  }

  const selected: BroadcastSoundbiteWindow[] = [];
  for (const hit of hits.sort((left, right) => right.score - left.score || left.start - right.start)) {
    if (selected.some((prior) => Math.abs(prior.center - hit.center) < 75)) continue;
    selected.push(hit);
    if (selected.length >= Math.max(1, limit)) break;
  }
  return selected.sort((left, right) => left.start - right.start);
}

export function sourceGameKey(title: string | null, team: string): string {
  const normalizedTitle = normalize(title ?? "");
  const normalizedTeam = normalize(team);
  const sides = normalizedTitle.split(/\b(?:vs|at)\b/).map((side) => side.trim()).filter(Boolean);
  const opponentSide = sides.find((side) => normalizedTeam && !side.includes(normalizedTeam)) ?? normalizedTitle;
  const generic = new Set([
    ...tokens(normalizedTeam), "full", "game", "replay", "highlights", "highlight", "football", "college", "ncaa",
    "big", "acc", "conference", "week", "bowl", "espn", "cfb", "sports", "pop", "tarts", "december", "november", "october",
    "september", "august", "january",
  ]);
  const opponent = opponentSide
    .split(" ")
    .filter((token) => !generic.has(token) && !/^\d+$/.test(token) && !/^20\d{2}$/.test(token))
    .slice(0, 5)
    .join(" ");
  return opponent || normalizedTitle || "unknown-game";
}

export function diversifySourcesByGame<T extends { title: string | null; rankScore: number }>(
  sources: T[],
  team: string,
  limit: number,
): T[] {
  const groups = new Map<string, T[]>();
  for (const source of sources.sort((a, b) => b.rankScore - a.rankScore)) {
    const key = sourceGameKey(source.title, team);
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  const rankedGroups = [...groups.values()].sort((a, b) => (b[0]?.rankScore ?? 0) - (a[0]?.rankScore ?? 0));
  const diversified: T[] = [];
  for (let depth = 0; diversified.length < limit && rankedGroups.some((group) => depth < group.length); depth++) {
    for (const group of rankedGroups) {
      const source = group[depth];
      if (source) diversified.push(source);
      if (diversified.length >= limit) break;
    }
  }
  return diversified;
}

/**
 * Keep the strongest plays from every discovered game near the front of the
 * queue. The round-robin order prevents one long broadcast from consuming the
 * whole clip budget before the other games are represented.
 */
export function balancedPlayerPlayOrder<T extends {
  title: string | null;
  relevanceScore: number;
  qualityScore: number;
}>(candidates: T[], team: string): T[] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = sourceGameKey(candidate.title, team);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const rankedGroups = [...groups.values()]
    .map((group) => group.sort((a, b) => (b.relevanceScore + b.qualityScore) - (a.relevanceScore + a.qualityScore)))
    .sort((a, b) => ((b[0]?.relevanceScore ?? 0) + (b[0]?.qualityScore ?? 0)) - ((a[0]?.relevanceScore ?? 0) + (a[0]?.qualityScore ?? 0)));
  const ordered: T[] = [];
  for (let depth = 0; rankedGroups.some((group) => depth < group.length); depth++) {
    for (const group of rankedGroups) {
      const candidate = group[depth];
      if (candidate) ordered.push(candidate);
    }
  }
  return ordered;
}

export function rankSourceMetadata(input: {
  title?: string | null;
  channel?: string | null;
  player: string;
  team: string;
  season: number;
  opponent?: string | null;
}): number {
  const haystack = normalize(`${input.title ?? ""} ${input.channel ?? ""}`);
  const lastName = normalize(input.player).split(" ").at(-1) ?? "";
  const teamStrength = teamIdentityStrength(haystack, input.team);
  let score = 0.1;
  if (lastName && haystack.includes(lastName)) score += 0.28;
  if (teamStrength > 0) score += 0.2 * teamStrength;
  if (haystack.includes(String(input.season))) score += 0.08;
  const mentionedYears: string[] = haystack.match(/\b20\d{2}\b/g) ?? [];
  if (mentionedYears.length && !mentionedYears.includes(String(input.season))) score -= 0.3;
  if (parseFindJobGames(input.opponent).some((game) => haystack.includes(normalize(game)))) score += 0.16;
  for (const term of POSITIVE_SOURCE_TERMS) if (haystack.includes(term)) score += 0.07;
  for (const term of NEGATIVE_SOURCE_TERMS) if (haystack.includes(term)) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

function sourceTitleIsGrounded(job: Pick<typeof findJobs.$inferSelect, "player" | "team" | "opponent">, title: string | null): boolean {
  const value = normalize(title ?? "");
  const player = normalize(job.player);
  const lastName = player.split(" ").at(-1) ?? "";
  const teamStrength = teamIdentityStrength(value, job.team);
  const games = parseFindJobGames(job.opponent);
  const footballContext = /football|corner|interception|defensive|touchdown|tackle|highlights|full game|broadcast|sports/.test(value);
  const conflictsWithTeam = teamAliases(job.team).includes("miami") && /\bmiami ohio\b/.test(value) && !value.includes(normalize(job.team));
  if (conflictsWithTeam) return false;
  return Boolean(
    (player && value.includes(player) && footballContext)
    || (teamStrength >= 1 && footballContext)
    || games.some((game) => value.includes(normalize(game)))
    || (lastName && value.includes(lastName) && /football|corner|interception|defensive|highlights/.test(value))
  );
}

export function findJobCandidateIsGrounded(
  job: Pick<typeof findJobs.$inferSelect, "player" | "team" | "season" | "opponent">,
  candidate: Pick<typeof clipCandidates.$inferSelect, "provider" | "title" | "sourceAccount">,
): boolean {
  if (candidate.provider !== "youtube" && candidate.provider !== "library") return true;
  return sourceTitleIsGrounded(job, candidate.title)
    && rankSourceMetadata({
      title: candidate.title,
      channel: candidate.sourceAccount,
      player: job.player,
      team: job.team,
      season: job.season,
      opponent: job.opponent,
    }) >= 0.35;
}

async function reconcileVerifiedCoverage(projectId: number): Promise<{ covered: number; missing: number }> {
  const db = getDb();
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return { covered: 0, missing: 0 };
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id));
  const candidates = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id));
  const readyJobs = (await db.select().from(clipJobs).where(eq(clipJobs.projectFk, projectId))).filter((clip) => clip.status === "ready");
  const readyCandidateIds = new Set(readyJobs.map((clip) => Number(clip.candidateFk)).filter(Boolean));
  let covered = 0;
  for (const beat of beats) {
    const verified = candidates.some((candidate) => candidate.beatFk === beat.id && readyCandidateIds.has(candidate.id));
    await db.update(scriptBeats).set({ status: verified ? "covered" : "needs_footage" }).where(eq(scriptBeats.id, beat.id));
    if (verified) covered++;
  }
  return { covered, missing: beats.length - covered };
}

/** Replace generic pronoun/name searches with job-grounded football searches. */
async function groundFindJobBeats(job: typeof findJobs.$inferSelect): Promise<void> {
  const db = getDb();
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return;
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord));
  const contentBeats = beats.filter((beat) => !/^\s*#/.test(beat.text) && !/FINAL RECORDING SCRIPT|USE THIS FOR VO/i.test(beat.text));
  const removed = beats.filter((beat) => !contentBeats.includes(beat));
  for (const beat of removed) await db.delete(scriptBeats).where(eq(scriptBeats.id, beat.id));
  for (let ord = 0; ord < contentBeats.length; ord++) {
    const beat = contentBeats[ord]!;
    const text = normalize(beat.text);
    const inferredGames: string[] = [];
    if (/east carolina|\becu\b/.test(text)) inferredGames.push("East Carolina", "ECU");
    if (/georgia tech|pop tarts/.test(text)) inferredGames.push("Georgia Tech", "Pop-Tarts Bowl");
    const configuredGames = parseFindJobGames(job.opponent);
    const queries = buildFindJobSearchQueries({
      player: job.player,
      team: job.team,
      season: job.season,
      games: [...configuredGames, ...inferredGames].join("\n"),
      beatText: beat.text,
      beatOrd: ord,
    });
    await db
      .update(scriptBeats)
      .set({ ord, queries: JSON.stringify(queries) })
      .where(eq(scriptBeats.id, beat.id));
  }
}

function transcriptMatchScore(needles: string[], text: string): number {
  const haystack = normalize(text);
  const hayTokens = new Set(tokens(haystack));
  if (!needles.length || !hayTokens.size) return 0;
  let hits = 0;
  let exactBonus = 0;
  for (const needle of needles) {
    const n = normalize(needle);
    if (!n) continue;
    if (n.includes(" ") && haystack.includes(n)) exactBonus += 0.35;
    for (const token of tokens(n)) if (hayTokens.has(token)) hits++;
  }
  const uniqueNeedleTokens = new Set(needles.flatMap(tokens));
  return Math.min(1, exactBonus + hits / Math.max(4, uniqueNeedleTokens.size));
}

async function markJob(jobId: number, patch: Partial<typeof findJobs.$inferInsert>): Promise<void> {
  await getDb().update(findJobs).set({ ...patch, lastProgressAt: new Date(), workerHeartbeatAt: new Date() }).where(eq(findJobs.id, jobId));
}

async function storeTranscript(videoFk: number, result: TranscriptResult): Promise<void> {
  const db = getDb();
  await db.delete(transcriptSegments).where(eq(transcriptSegments.videoFk, videoFk));
  if (result.segments.length) {
    await db.insert(transcriptSegments).values(
      result.segments.map((segment, idx) => ({ videoFk, idx, text: segment.text, start: segment.start, end: segment.end })),
    );
  }
  await db
    .update(videos)
    .set({
      transcriptKind: result.kind,
      transcriptLang: result.lang,
      status: "ok",
      errorMessage: null,
      retrievedAt: new Date(),
    })
    .where(eq(videos.id, videoFk));
}

async function ensureVideo(seed: SourceSeed): Promise<typeof videos.$inferSelect> {
  const db = getDb();
  let [video] = await db.select().from(videos).where(eq(videos.videoId, seed.videoId));
  if (!video) {
    if (seed.sourceType === "local") {
      const localPath = canonicalLocalVideoPath(seed.localPath ?? "");
      if (!existsSync(localPath)) throw new Error("The curated local full-game file is missing.");
      const probe = await probeMedia(localPath);
      const [inserted] = await db
        .insert(videos)
        .values({
          videoId: seed.videoId,
          url: seed.url,
          title: seed.title,
          channel: seed.channel ?? "Local full-game archive",
          durationSec: Math.round(probe.durationSec),
          status: "ok",
        })
        .returning({ id: videos.id });
      [video] = await db.select().from(videos).where(eq(videos.id, inserted.id));
      return video!;
    }
    const meta = await fetchVideoMeta(seed.videoId);
    const [inserted] = await db
      .insert(videos)
      .values({
        videoId: seed.videoId,
        url: `https://www.youtube.com/watch?v=${seed.videoId}`,
        title: meta.title,
        channel: meta.channel,
        thumbnail: meta.thumbnail,
        status: "ok",
      })
      .returning({ id: videos.id });
    [video] = await db.select().from(videos).where(eq(videos.id, inserted.id));
  }
  return video!;
}

async function acquireCaptionFirst(
  video: typeof videos.$inferSelect,
  allowLocalFallback: boolean,
  localJobId: string,
  localPath: string | null,
): Promise<TranscriptResult> {
  if (video.transcriptKind !== "none") {
    const segments = await getDb()
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.videoFk, video.id))
      .orderBy(asc(transcriptSegments.idx));
    if (segments.length) {
      return {
        kind: video.transcriptKind === "imported" ? "manual" : video.transcriptKind,
        lang: video.transcriptLang ?? "unknown",
        segments: segments.map((s) => ({ text: s.text, start: s.start, end: s.end })),
      };
    }
  }
  if (localPath) {
    const local = await transcribeVoiceover(canonicalLocalVideoPath(localPath));
    const result: TranscriptResult = { kind: "local-whisper", lang: local.lang, segments: local.segments };
    await storeTranscript(video.id, result);
    return result;
  }
  try {
    const result = await getTranscriptProvider().fetchTranscript(video.videoId);
    await storeTranscript(video.id, result);
    return result;
  } catch (captionError) {
    if (!allowLocalFallback) throw captionError;
    const result = await fetchLocalWhisperTranscript(video.videoId, undefined, localJobId);
    await storeTranscript(video.id, result);
    return result;
  }
}

type SourceSeed = {
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  durationSec: number | null;
  publishedAt: string | null;
  query: string | null;
  rankScore: number;
  sourceType: "youtube" | "local";
  localPath: string | null;
};

async function collectSourceSeeds(job: typeof findJobs.$inferSelect): Promise<SourceSeed[]> {
  const db = getDb();
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return [];
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id));
  const beatMap = new Map(beats.map((beat) => [beat.id, beat]));
  const candidates = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id));
  const unique = new Map<string, SourceSeed>();
  for (const source of curatedSourcesForFindJob({
    team: job.team,
    season: job.season,
    games: parseFindJobGames(job.opponent),
  })) {
    unique.set(source.videoId, {
      videoId: source.videoId,
      url: source.url,
      title: source.title,
      channel: null,
      durationSec: null,
      publishedAt: null,
      query: source.sourceLabel,
      rankScore: source.rankScore,
      sourceType: source.sourceType,
      localPath: source.localPath,
    });
  }
  for (const candidate of candidates) {
    if (candidate.provider !== "youtube" && candidate.provider !== "library") continue;
    const videoId = extractVideoId(candidate.sourceUrl);
    if (!videoId) continue;
    const beat = beatMap.get(candidate.beatFk);
    const query = jsonStrings(beat?.queries ?? null)[0] ?? null;
    const rankScore = rankSourceMetadata({
      title: candidate.title,
      channel: candidate.sourceAccount,
      player: job.player,
      team: job.team,
      season: job.season,
      opponent: job.opponent,
    });
    const seed: SourceSeed = {
      videoId,
      url: candidate.sourceUrl,
      title: candidate.title,
      channel: candidate.sourceAccount,
      durationSec: candidate.durationSec,
      publishedAt: candidate.publishedAt,
      query,
      rankScore,
      sourceType: "youtube",
      localPath: null,
    };
    const prior = unique.get(videoId);
    if (!prior || prior.rankScore < rankScore) unique.set(videoId, seed);
  }
  // The shared transcript library is the cheapest and most reliable source
  // portfolio. A new job must reuse it even when discovery represented the
  // same video with a library candidate rather than a YouTube candidate.
  const cachedVideos = await db.select().from(videos);
  for (const video of cachedVideos) {
    if (video.transcriptKind === "none" || !sourceTitleIsGrounded(job, video.title)) continue;
    const rankScore = Math.min(1, rankSourceMetadata({
      title: video.title,
      channel: video.channel,
      player: job.player,
      team: job.team,
      season: job.season,
      opponent: job.opponent,
    }) + 0.12);
    if (rankScore < 0.35) continue;
    const seed: SourceSeed = {
      videoId: video.videoId,
      url: video.url,
      title: video.title,
      channel: video.channel,
      durationSec: video.durationSec,
      publishedAt: null,
      query: "Shared Cut IQ transcript cache",
      rankScore,
      sourceType: "youtube",
      localPath: null,
    };
    const prior = unique.get(video.videoId);
    if (!prior || prior.rankScore < rankScore) unique.set(video.videoId, seed);
  }
  if (!parseFindJobGames(job.opponent).length) {
    try {
      const seasonResults = await searchYouTubeKeyless(`${job.team} ${job.season} football full game`, job.sourceLimit);
      for (const candidate of seasonResults) {
        const videoId = extractVideoId(candidate.sourceUrl);
        if (!videoId) continue;
        const rankScore = rankSourceMetadata({
          title: candidate.title,
          channel: candidate.sourceAccount,
          player: job.player,
          team: job.team,
          season: job.season,
          opponent: job.opponent,
        });
        const seed: SourceSeed = {
          videoId,
          url: candidate.sourceUrl,
          title: candidate.title,
          channel: candidate.sourceAccount,
          durationSec: candidate.durationSec,
          publishedAt: candidate.publishedAt,
          query: `${job.team} ${job.season} football full game`,
          rankScore,
          sourceType: "youtube",
          localPath: null,
        };
        const prior = unique.get(videoId);
        if (!prior || prior.rankScore < rankScore) unique.set(videoId, seed);
      }
    } catch {
      // Beat-specific discovery remains available when the supplemental season search is unavailable.
    }
  }
  const grounded = [...unique.values()]
    .filter((seed) => seed.rankScore >= 0.35 && sourceTitleIsGrounded(job, seed.title))
    .sort((a, b) => b.rankScore - a.rankScore);
  return diversifySourcesByGame(grounded, job.team, job.sourceLimit);
}

async function matchSourceToBeats(job: typeof findJobs.$inferSelect, source: SourceSeed, videoFk: number): Promise<number> {
  const db = getDb();
  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.videoFk, videoFk))
    .orderBy(asc(transcriptSegments.idx));
  if (!segments.length) return 0;
  if (!sourceTitleIsGrounded(job, source.title) || source.rankScore < 0.35) return 0;
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return 0;
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id));
  let matched = 0;
  for (const beat of beats) {
    const aliases = (() => {
      try {
        return Object.entries(JSON.parse(beat.aliases ?? "{}") as Record<string, string[]>).flatMap(([key, values]) => [key, ...values]);
      } catch {
        return [] as string[];
      }
    })();
    const entities = jsonStrings(beat.entities);
    const queries = jsonStrings(beat.queries);
    const needles = [job.player, job.player.split(/\s+/).at(-1) ?? "", job.opponent ?? "", ...entities, ...aliases, ...queries, beat.text]
      .filter(Boolean)
      .slice(0, 18);
    let best: { index: number; score: number; text: string } | null = null;
    for (let index = 0; index < segments.length; index++) {
      const window = segments.slice(index, index + 3).map((s) => s.text).join(" ");
      const identity = normalize(window);
      const lastName = normalize(job.player).split(" ").at(-1) ?? "";
      // Team/game sources must still identify the subject in commentary; a
      // generic word overlap cannot turn another player into a match.
      if (!identity.includes(normalize(job.player)) && (!lastName || !identity.includes(lastName))) continue;
      const score = transcriptMatchScore(needles, window);
      if (!best || score > best.score) best = { index, score, text: window };
    }
    if (!best || best.score < 0.22) continue;
    const first = segments[best.index]!;
    const last = segments[Math.min(segments.length - 1, best.index + 2)]!;
    const dupKey = `yt:${source.videoId}`;
    const beatCandidates = await db
      .select()
      .from(clipCandidates)
      .where(and(eq(clipCandidates.beatFk, beat.id), eq(clipCandidates.dupGroupKey, dupKey)));
    for (const candidate of beatCandidates) {
      await db
        .update(clipCandidates)
        .set({
          videoFk,
          transcriptExcerpt: best.text,
          segStart: first.start,
          segEnd: last.end,
          matchKind: "exact_transcript",
          relevanceScore: Math.max(candidate.relevanceScore ?? 0, best.score),
          acquisitionStatus: "caption_indexed",
          reason: `Caption-first transcript match (${Math.round(best.score * 100)}% deterministic term coverage).`,
        })
        .where(eq(clipCandidates.id, candidate.id));
      matched++;
    }
  }
  return matched;
}

async function harvestPlayerPlays(
  job: typeof findJobs.$inferSelect,
  source: SourceSeed,
  videoFk: number,
): Promise<number> {
  const db = getDb();
  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.videoFk, videoFk))
    .orderBy(asc(transcriptSegments.idx));
  if (!segments.length || !findJobCandidateIsGrounded(job, { provider: "youtube", title: source.title, sourceAccount: source.channel })) return 0;
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return 0;
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord));
  if (!beats.length) return 0;
  const existing = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id));
  const existingRanges = new Set(
    existing
      .filter((candidate) => candidate.sourceUrl === source.url && candidate.segStart != null)
      .map((candidate) => `${source.videoId}:${Math.round(candidate.segStart! / 3)}`),
  );
  const sourceIdentityAnchored = hasPlayerFullName(segments.map((segment) => segment.text).join(" "), job.player);
  const hits: Array<{ start: number; end: number; text: string; score: number; center: number }> = [];
  for (let index = 0; index < segments.length; index++) {
    const startIndex = Math.max(0, index - 2);
    const endIndex = Math.min(segments.length - 1, index + 5);
    const windowSegments = segments.slice(startIndex, endIndex + 1);
    const text = windowSegments.map((segment) => segment.text).join(" ");
    if (!playerNamePositions(normalize(text), job.player).length) continue;
    const score = playerActionScore(text, job.player);
    // Harvest for recall. A score below the automatic-package threshold is a
    // review candidate, not a reason to erase a possibly real player moment.
    if (score < 4) continue;
    const start = windowSegments[0]!.start;
    const end = windowSegments.at(-1)!.end;
    hits.push({ start, end, text, score, center: (start + end) / 2 });
  }
  const selected: typeof hits = [];
  for (const hit of hits.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (selected.some((prior) => Math.abs(prior.center - hit.center) < 30)) continue;
    selected.push(hit);
  }
  selected.sort((a, b) => a.start - b.start);

  let inserted = 0;
  for (let index = 0; index < selected.length; index++) {
    const hit = selected[index]!;
    const rangeKey = `${source.videoId}:${Math.round(hit.start / 3)}`;
    if (existingRanges.has(rangeKey)) continue;
    const beat = beats
      .map((candidate) => ({
        beat: candidate,
        score: transcriptMatchScore([candidate.text, ...jsonStrings(candidate.entities), ...jsonStrings(candidate.queries)], hit.text),
      }))
      .sort((a, b) => b.score - a.score || a.beat.ord - b.beat.ord)[0]?.beat ?? beats[index % beats.length]!;
    await db.insert(clipCandidates).values({
      projectFk: job.projectFk,
      revisionFk: revision.id,
      beatFk: beat.id,
      provider: "youtube",
      videoFk,
      sourceUrl: source.url,
      sourceAccount: source.channel,
      title: source.title,
      publishedAt: source.publishedAt,
      durationSec: source.durationSec,
      thumbnailUrl: `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg`,
      matchKind: "exact_transcript",
      transcriptExcerpt: hit.text,
      segStart: hit.start,
      segEnd: hit.end,
      relevanceScore: Math.min(0.99, 0.55 + hit.score / 20),
      qualityScore: 0,
      cleanSourceScore: 0,
      visualConfidence: Math.min(0.98, 0.6 + hit.score / 25),
      reason: `${PLAYER_PLAY_REASON_PREFIX} (signal ${hit.score.toFixed(1)}): play-by-play action language appears next to ${job.player}.${sourceIdentityAnchored ? ` ${BROADCAST_IDENTITY_ANCHOR}.` : ""}`,
      acquisitionStatus: "caption_indexed",
      dupGroupKey: `play:${source.videoId}:${Math.round(hit.start / 5)}`.slice(0, 80),
      state: "undecided",
    });
    existingRanges.add(rangeKey);
    inserted++;
  }
  return inserted;
}

async function harvestBroadcastSoundbites(
  job: typeof findJobs.$inferSelect,
  source: SourceSeed,
  videoFk: number,
): Promise<number> {
  const db = getDb();
  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.videoFk, videoFk))
    .orderBy(asc(transcriptSegments.idx));
  if (!segments.length || !findJobCandidateIsGrounded(job, { provider: "youtube", title: source.title, sourceAccount: source.channel })) return 0;
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return 0;
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord));
  if (!beats.length) return 0;
  const existing = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id));
  const existingRanges = new Set(
    existing
      .filter((candidate) => candidate.sourceUrl === source.url && candidate.segStart != null)
      .map((candidate) => `${source.videoId}:${Math.round(candidate.segStart! / 3)}`),
  );
  const sourceIdentityAnchored = hasPlayerFullName(segments.map((segment) => segment.text).join(" "), job.player);
  const windows = selectBroadcastSoundbiteWindows(segments, job.player, segments.length);
  let inserted = 0;
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]!;
    const rangeKey = `${source.videoId}:${Math.round(window.start / 3)}`;
    if (existingRanges.has(rangeKey)) continue;
    const beat = beats.find((candidate) => candidate.purpose === "quote") ?? beats[index % beats.length]!;
    await db.insert(clipCandidates).values({
      projectFk: job.projectFk,
      revisionFk: revision.id,
      beatFk: beat.id,
      provider: "youtube",
      videoFk,
      sourceUrl: source.url,
      sourceAccount: source.channel,
      title: source.title,
      publishedAt: source.publishedAt,
      durationSec: source.durationSec,
      thumbnailUrl: `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg`,
      matchKind: "exact_transcript",
      transcriptExcerpt: window.text,
      segStart: window.start,
      segEnd: window.end,
      editIn: window.editIn,
      editOut: window.editOut,
      relevanceScore: Math.min(0.97, 0.55 + window.score / 20),
      qualityScore: 0,
      cleanSourceScore: 0,
      visualConfidence: Math.min(0.9, 0.45 + window.score / 25),
      reason: `${BROADCAST_SOUNDBITE_REASON_PREFIX} (signal ${window.score.toFixed(1)}): broadcast profile or analysis about ${job.player}.${sourceIdentityAnchored ? ` ${BROADCAST_IDENTITY_ANCHOR}.` : ""}`,
      acquisitionStatus: "caption_indexed",
      dupGroupKey: `soundbite:${source.videoId}:${Math.round(window.start / 10)}`.slice(0, 80),
      state: "undecided",
    });
    existingRanges.add(rangeKey);
    inserted++;
  }
  return inserted;
}

async function runCaptionFirst(job: typeof findJobs.$inferSelect): Promise<{ sources: number; transcripts: number; matches: number; warnings: string[] }> {
  const db = getDb();
  const seeds = await collectSourceSeeds(job);
  let transcripts = 0;
  let matches = 0;
  const warnings: string[] = [];
  const localFallbackBudget = job.localAsrFallback ? seeds.length : 0;
  let localFallbacks = 0;
  await markJob(job.id, { sourcesFound: seeds.length, progressPercent: progressForStage("transcripts", 0) });
  for (let index = 0; index < seeds.length; index++) {
    const seed = seeds[index]!;
    await markJob(job.id, {
      currentOperation: `Captions ${index + 1}/${seeds.length}: ${seed.title ?? seed.videoId}`,
      progressPercent: progressForStage("transcripts", seeds.length ? index / seeds.length : 1),
      workerHeartbeatAt: new Date(),
    });
    await db
      .insert(findSources)
      .values({
        jobFk: job.id,
        projectFk: job.projectFk,
        videoId: seed.videoId,
        url: seed.url,
        title: seed.title,
        channel: seed.channel,
        durationSec: seed.durationSec == null ? null : Math.round(seed.durationSec),
        publishedAt: seed.publishedAt,
        searchQuery: seed.query,
        sourceType: seed.sourceType,
        rankScore: seed.rankScore,
        status: "metadata",
        attemptCount: 0,
      })
      .onConflictDoUpdate({
        target: [findSources.jobFk, findSources.videoId],
        set: {
          title: seed.title,
          channel: seed.channel,
          durationSec: seed.durationSec == null ? null : Math.round(seed.durationSec),
          publishedAt: seed.publishedAt,
          searchQuery: seed.query,
          sourceType: seed.sourceType,
          rankScore: seed.rankScore,
        },
      });
    const [sourceRow] = await db
      .select()
      .from(findSources)
      .where(and(eq(findSources.jobFk, job.id), eq(findSources.videoId, seed.videoId)));
    try {
      const video = await ensureVideo(seed);
      const allowLocal = seed.rankScore >= 0.35 && localFallbacks < localFallbackBudget;
      const result = await acquireCaptionFirst(video, allowLocal, `find-${job.id}-${seed.videoId}`, seed.localPath);
      if (result.kind === "local-whisper") localFallbacks++;
      transcripts++;
      matches += await matchSourceToBeats(job, seed, video.id);
      matches += await harvestPlayerPlays(job, seed, video.id);
      matches += await harvestBroadcastSoundbites(job, seed, video.id);
      await db
        .update(findSources)
        .set({ videoFk: video.id, captionKind: result.kind, status: "transcript_ready", lastError: null, attemptCount: (sourceRow?.attemptCount ?? 0) + 1 })
        .where(eq(findSources.id, sourceRow!.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${seed.videoId}: ${message}`);
      if (sourceRow) {
        await db
          .update(findSources)
          .set({ status: "no_transcript", lastError: message.slice(0, 1000), attemptCount: (sourceRow.attemptCount ?? 0) + 1 })
          .where(eq(findSources.id, sourceRow.id));
      }
      // A source failure is isolated; continue through the ranked list.
    }
    await markJob(job.id, {
      transcriptsFound: transcripts,
      candidatesFound: matches,
      progressPercent: progressForStage("transcripts", seeds.length ? (index + 1) / seeds.length : 1),
    });
    if (await stopRequested(job.id)) break;
  }
  return { sources: seeds.length, transcripts, matches, warnings };
}

async function autoQueueClips(job: typeof findJobs.$inferSelect): Promise<number[]> {
  const db = getDb();
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!revision) return [];
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord));
  const candidates = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id));
  const existing = await db.select().from(clipJobs).where(eq(clipJobs.projectFk, job.projectFk));
  const candidatesById = new Map(candidates.map((candidate) => [Number(candidate.id), candidate]));
  const existingCandidateIds = new Set(
    existing
      .filter((row) => row.status === "ready" || ACTIVE_CLIP_STATUSES.includes(row.status as (typeof ACTIVE_CLIP_STATUSES)[number]))
      .map((row) => Number(row.candidateFk))
      .filter(Boolean),
  );
  const existingRanges = new Set(
    existing
      .filter((row) => row.status === "ready" || ACTIVE_CLIP_STATUSES.includes(row.status as (typeof ACTIVE_CLIP_STATUSES)[number]))
      .map((row) => clipRangeKey(row.sourceUrl, row.editIn, row.editOut)),
  );
  const eligible = candidates.filter((candidate) => {
    if (candidate.state === "rejected" || candidate.editIn == null || candidate.editOut == null || candidate.matchKind !== "exact_transcript") return false;
    const title = normalize(candidate.title ?? "");
    return !/interview|press conference|podcast|reaction/.test(title) && findJobCandidateIsGrounded(job, candidate);
  });
  const reviewable = uniqueReviewablePlayerCandidates(eligible, job.player);
  const reviewableExisting = existing.filter((row) => {
    const candidate = row.candidateFk ? candidatesById.get(Number(row.candidateFk)) : null;
    return candidate ? playerCandidateIsReviewable(candidate, job.player) : false;
  });
  const queued: number[] = reviewableExisting
    .filter((row) => row.status === "ready" || ACTIVE_CLIP_STATUSES.includes(row.status as (typeof ACTIVE_CLIP_STATUSES)[number]))
    .map((row) => row.id);
  const beatById = new Map(beats.map((beat) => [Number(beat.id), beat]));
  // A player-specific job must never fall back to generic team/game matches.
  // Player-grounded broadcast sound bites are a first-class video lane
  // alongside plays, then the combined set is balanced across games. Explicit
  // evidence for another person is rejected, while surname-only moments remain
  // available for fast human review instead of being silently discarded.
  const highlightTunerGate = readHighlightTunerGate();
  const highlightTuner = highlightTunerGate.enabled
    ? resolveStoredHighlightTunerSettings(job.highlightTunerSettings)
    : null;
  const ordered = highlightTuner
    ? selectHighlights(
        reviewable.filter((candidate) => (
          !existingCandidateIds.has(candidate.id)
          && !existingRanges.has(clipRangeKey(candidate.sourceUrl, candidate.editIn!, candidate.editOut!))
        )),
        job.team,
        highlightTuner,
        {
          player: job.player,
          getGameKey: (candidate, team) => highlightGameKey(candidate.title, team),
          isCandidateEligible: (candidate) => highlightTitleMatchesSeason(candidate.title, job.season),
        },
      ).selected.map((selection) => selection.candidate)
    : balancedPlayerPlayOrder(reviewable, job.team);
  for (const best of ordered) {
    if (queued.length >= job.clipLimit) break;
    if (existingCandidateIds.has(best.id) || existingRanges.has(clipRangeKey(best.sourceUrl, best.editIn!, best.editOut!))) continue;
    await db.update(clipCandidates).set({ state: "approved" }).where(eq(clipCandidates.id, best.id));
    const beat = beatById.get(Number(best.beatFk));
    const clip = await enqueueClip({
      kind: "candidate",
      projectFk: job.projectFk,
      candidateFk: best.id,
      videoFk: best.videoFk,
      sourceUrl: best.sourceUrl,
      title: best.title ?? (beat ? `Beat ${beat.ord + 1}` : `${job.player} play`),
      editIn: best.editIn!,
      editOut: best.editOut!,
      height: job.preferredHeight,
      minimumHeight: job.minimumHeight,
      uploadToDrive: false,
    });
    queued.push(clip.id);
    existingCandidateIds.add(best.id);
    existingRanges.add(clipRangeKey(best.sourceUrl, best.editIn!, best.editOut!));
  }
  await markJob(job.id, { clipsQueued: queued.length });
  return queued;
}

async function canonicalProjectClipRows(job: typeof findJobs.$inferSelect): Promise<Array<typeof clipJobs.$inferSelect>> {
  const db = getDb();
  const rows = await db.select().from(clipJobs).where(eq(clipJobs.projectFk, job.projectFk));
  const candidateIds = rows.map((row) => Number(row.candidateFk)).filter(Boolean);
  if (!candidateIds.length) return [];
  const candidates = await db.select().from(clipCandidates).where(inArray(clipCandidates.id, candidateIds));
  const reviewableIds = new Set(
    uniqueReviewablePlayerCandidates(candidates, job.player).map((candidate) => Number(candidate.id)),
  );
  return rows.filter((row) => row.status !== "cancelled" && row.candidateFk != null && reviewableIds.has(Number(row.candidateFk)));
}

async function stopRequested(jobId: number): Promise<boolean> {
  const [fresh] = await getDb().select().from(findJobs).where(eq(findJobs.id, jobId));
  return !!fresh?.pauseRequested || !!fresh?.cancelRequested;
}

async function honorControl(jobId: number): Promise<boolean> {
  const db = getDb();
  const [fresh] = await db.select().from(findJobs).where(eq(findJobs.id, jobId));
  if (!fresh) return true;
  if (fresh.cancelRequested) {
    await db
      .update(clipJobs)
      .set({ status: "cancelled", stage: "Cancelled with Find Clips job" })
      .where(and(eq(clipJobs.projectFk, fresh.projectFk), eq(clipJobs.status, "queued")));
    const active = await db
      .select()
      .from(clipJobs)
      .where(and(eq(clipJobs.projectFk, fresh.projectFk), inArray(clipJobs.status, ["downloading", "uploading"])));
    for (const clip of active) await cancelRunningJob(clip.id);
    await markJob(jobId, { status: "cancelled", stage: "cancelled", currentOperation: "Cancelled", completedAt: new Date() });
    return true;
  }
  if (fresh.pauseRequested) {
    await markJob(jobId, { status: "paused", stage: fresh.stage, currentOperation: "Paused safely between operations" });
    return true;
  }
  return false;
}

async function waitForClipVerification(job: typeof findJobs.$inferSelect): Promise<{ ready: number; failed: number }> {
  for (;;) {
    if (await honorControl(job.id)) return { ready: 0, failed: 0 };
    const rows = await canonicalProjectClipRows(job);
    const active = rows.filter((row) => ACTIVE_CLIP_STATUSES.includes(row.status as (typeof ACTIVE_CLIP_STATUSES)[number]));
    const readyRows = rows.filter((row) => row.status === "ready");
    const readyRanges = new Set(readyRows.map((row) => clipRangeKey(row.sourceUrl, row.editIn, row.editOut)));
    const ready = readyRanges.size;
    const failed = new Set(
      rows
        .filter((row) => row.status === "failed")
        .map((row) => clipRangeKey(row.sourceUrl, row.editIn, row.editOut))
        .filter((key) => !readyRanges.has(key)),
    ).size;
    const unresolvedFailed = ready >= job.clipLimit ? 0 : failed;
    const finished = rows.filter((row) => ["ready", "failed", "cancelled"].includes(row.status)).length;
    const activeProgress = active.reduce((sum, row) => sum + Math.max(0, Math.min(100, row.progress ?? 0)) / 100, 0);
    const verificationFraction = rows.length ? (finished + activeProgress) / rows.length : 1;
    await markJob(job.id, {
      clipsVerified: ready,
      progressPercent: progressForStage("verifying", verificationFraction),
      currentOperation: active.length ? `${active[0]!.stage} (${ready}/${rows.length} verified)` : "Clip verification complete",
    });
    if (!active.length) return { ready, failed: unresolvedFailed };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function processFindJob(jobId: number): Promise<void> {
  const db = getDb();
  let [job] = await db.select().from(findJobs).where(eq(findJobs.id, jobId));
  if (!job || TERMINAL_FIND_STATUSES.includes(job.status)) return;
  await markJob(job.id, { status: "running", startedAt: job.startedAt ?? new Date(), lastError: null });
  try {
    if (["queued", "analyzing"].includes(job.stage)) {
      await markJob(job.id, { stage: "analyzing", progressPercent: progressForStage("analyzing", 0), currentOperation: "Analyzing script into editorial beats" });
      await runAnalyze(job.projectFk);
      await groundFindJobBeats(job);
      await markJob(job.id, { stage: "discovering", progressPercent: progressForStage("discovering", 0), currentOperation: "Generating football searches and discovering sources" });
    }
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, job.id));
    if (await honorControl(job.id)) return;
    if (job.stage === "discovering") {
      const discovery = await runDiscover(job.projectFk);
      const warnings = [...jsonStrings(job.warnings), ...discovery.providerFailures];
      await markJob(job.id, { stage: "transcripts", progressPercent: progressForStage("transcripts", 0), warnings: JSON.stringify(warnings), currentOperation: "Ranking metadata before caption retrieval" });
    }
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, job.id));
    if (await honorControl(job.id)) return;
    if (job.stage === "transcripts") {
      const captions = await runCaptionFirst(job);
      const warnings = [...jsonStrings(job.warnings), ...captions.warnings];
      await markJob(job.id, {
        stage: "ranking",
        progressPercent: progressForStage("ranking", 0),
        warnings: JSON.stringify(warnings.slice(-200)),
        sourcesFound: captions.sources,
        transcriptsFound: captions.transcripts,
        candidatesFound: captions.matches,
        currentOperation: "Ranking timestamped candidate moments",
      });
    }
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, job.id));
    if (await honorControl(job.id)) return;
    if (job.stage === "ranking") {
      await runRank(job.projectFk);
      await markJob(job.id, { stage: "extracting", progressPercent: progressForStage("extracting", 0), currentOperation: "Balancing player-grounded plays and sound bites across discovered games" });
    }
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, job.id));
    if (await honorControl(job.id)) return;
    if (job.stage === "extracting") {
      await autoQueueClips(job);
      await markJob(job.id, { stage: "verifying", progressPercent: progressForStage("verifying", 0), currentOperation: "Downloading, cutting and verifying selected media" });
    }
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, job.id));
    if (await honorControl(job.id)) return;
    const result = await waitForClipVerification(job);
    const coverage = await reconcileVerifiedCoverage(job.projectFk);
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, job.id));
    if (job.status === "paused" || job.status === "cancelled") return;
    const warnings = jsonStrings(job.warnings);
    if (result.failed) warnings.push(`${result.failed} clip render(s) failed; other sources and clips were preserved.`);
    if (coverage.missing && result.ready < job.clipLimit) warnings.push(`${coverage.missing} script beat(s) still need verified footage.`);
    const noVerifiedClips = result.ready === 0;
    const status: FindJobStatus = noVerifiedClips ? "failed" : warnings.length || result.failed ? "completed_with_warnings" : "completed";
    await markJob(job.id, {
      status,
      stage: noVerifiedClips ? "failed" : "complete",
      progressPercent: 100,
      clipsVerified: result.ready,
      warnings: JSON.stringify(warnings.slice(-200)),
      lastError: noVerifiedClips ? "No player-grounded clips were produced after transcript and local fallback recovery." : null,
      currentOperation: noVerifiedClips
        ? "No player-grounded clips found — retry after adding games or another source"
        : `${result.ready} verified clip${result.ready === 1 ? "" : "s"} ready in the Cut IQ library`,
      completedAt: new Date(),
    });
  } catch (error) {
    [job] = await db.select().from(findJobs).where(eq(findJobs.id, jobId));
    const message = error instanceof Error ? error.message : String(error);
    const retryCount = (job?.retryCount ?? 0) + 1;
    if (job && retryCount <= job.maxRetries && !job.cancelRequested) {
      await markJob(jobId, { status: "queued", retryCount, lastError: message.slice(0, 2000), currentOperation: `Retry ${retryCount}/${job.maxRetries}: ${message}` });
    } else {
      await markJob(jobId, { status: "failed", stage: "failed", retryCount, lastError: message.slice(0, 2000), currentOperation: "Job failed after retry policy" });
    }
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const db = getDb();
    for (;;) {
      const [job] = await db.select().from(findJobs).where(eq(findJobs.status, "queued")).orderBy(asc(findJobs.id)).limit(1);
      if (!job) break;
      await processFindJob(job.id);
    }
  } catch (error) {
    console.error("[find-clips] worker error:", error);
  } finally {
    pumping = false;
  }
}

export function wakeFindClipsWorker(): void {
  void pump();
}

export function recoveredFindJobPatch() {
  return {
    status: "queued" as const,
    currentOperation: "Recovered after Cut IQ restart",
    workerHeartbeatAt: new Date(),
  };
}

export async function recoverFindJobs(): Promise<void> {
  await getDb()
    .update(findJobs)
    .set(recoveredFindJobPatch())
    .where(inArray(findJobs.status, ["running", "cancelling"]));
}

export function startFindClipsWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  void recoverFindJobs().then(() => pump()).catch((error) => console.error("[find-clips] recovery failed:", error));
  heartbeatTimer = setInterval(() => void pump(), 5_000);
  heartbeatTimer.unref?.();
}

export async function createFindJob(input: CreateFindJobInput): Promise<typeof findJobs.$inferSelect> {
  const db = getDb();
  const highlightTunerSettings = input.highlightTuner ? JSON.stringify(input.highlightTuner) : null;
  const project = await upsertScriptProject({
    topic: input.player,
    tags: [input.player, input.team, String(input.season), ...parseFindJobGames(input.opponent)],
    sourceProvider: "find_clips",
    sourceDocId: `find-clips-${randomUUID()}`,
    scriptText: input.scriptText,
    projectName: input.projectName ?? `${input.player} • ${input.team} • ${input.season}`,
    extractedFromHeading: "Find Clips job",
  });
  const preRollSec = input.preRollSec ?? 10;
  const postRollSec = input.postRollSec ?? 15;
  await db
    .update(scriptProjects)
    .set({ prerollSec: preRollSec, postrollSec: postRollSec, defaultClipLenSec: preRollSec + postRollSec })
    .where(eq(scriptProjects.id, project.projectId));
  await db
    .insert(findJobs)
    .values({
      projectFk: project.projectId,
      player: input.player.trim(),
      team: input.team.trim(),
      season: input.season,
      opponent: input.opponent?.trim() || null,
      sourceLimit: input.sourceLimit ?? 60,
      clipLimit: input.clipLimit ?? 100,
      preferredHeight: input.preferredHeight ?? 1080,
      minimumHeight: input.minimumHeight ?? 720,
      preRollSec,
      postRollSec,
      localAsrFallback: input.localAsrFallback ?? true,
      highlightTunerSettings,
      status: input.autoStart === false ? "paused" : "queued",
      stage: "queued",
      progressPercent: 0,
      currentOperation: input.autoStart === false ? "Created — ready to start" : "Queued",
      pauseRequested: input.autoStart === false,
      cancelRequested: false,
      retryCount: 0,
      maxRetries: 3,
      sourcesFound: 0,
      transcriptsFound: 0,
      candidatesFound: 0,
      clipsQueued: 0,
      clipsVerified: 0,
      warnings: JSON.stringify([]),
    })
    .onConflictDoUpdate({
        target: findJobs.projectFk,
        set: {
        player: input.player.trim(),
        team: input.team.trim(),
        season: input.season,
        opponent: input.opponent?.trim() || null,
        sourceLimit: input.sourceLimit ?? 60,
        clipLimit: input.clipLimit ?? 100,
        preferredHeight: input.preferredHeight ?? 1080,
        minimumHeight: input.minimumHeight ?? 720,
        preRollSec,
        postRollSec,
        localAsrFallback: input.localAsrFallback ?? true,
        highlightTunerSettings,
        status: input.autoStart === false ? "paused" : "queued",
        stage: "queued",
        progressPercent: 0,
        currentOperation: input.autoStart === false ? "Created — ready to start" : "Queued",
        pauseRequested: input.autoStart === false,
        cancelRequested: false,
        retryCount: 0,
        completedAt: null,
        lastError: null,
      },
    });
  const [job] = await db.select().from(findJobs).where(eq(findJobs.projectFk, project.projectId));
  if (input.autoStart !== false) wakeFindClipsWorker();
  return job!;
}

export async function setFindJobAction(jobId: number, action: "start" | "pause" | "resume" | "cancel" | "retry"): Promise<void> {
  const db = getDb();
  const [job] = await db.select().from(findJobs).where(eq(findJobs.id, jobId));
  if (!job) throw new Error(`Find Clips job ${jobId} not found.`);
  if (action === "pause") {
    await markJob(jobId, { pauseRequested: true, currentOperation: "Pause requested — finishing the current safe operation" });
    return;
  }
  if (action === "cancel") {
    await markJob(jobId, { cancelRequested: true, status: "cancelling", currentOperation: "Cancelling source and clip work safely" });
    return;
  }
  if (action === "retry") {
    const priorClips = await db.select().from(clipJobs).where(eq(clipJobs.projectFk, job.projectFk));
    for (const clip of priorClips.filter((row) => row.status === "downloading" || row.status === "uploading")) {
      await cancelRunningJob(clip.id);
    }
    await db
      .update(clipJobs)
      .set({ status: "cancelled", stage: "Superseded by a fresh Find Clips retry" })
      .where(and(eq(clipJobs.projectFk, job.projectFk), inArray(clipJobs.status, ["queued", "ready", "failed"])));
  }
  await markJob(jobId, {
    status: "queued",
    pauseRequested: false,
    cancelRequested: false,
    retryCount: action === "retry" ? 0 : job.retryCount,
    stage: action === "retry" ? "queued" : job.stage,
    progressPercent: action === "retry" ? 0 : job.progressPercent,
    lastError: action === "retry" ? null : job.lastError,
    warnings: action === "retry" ? "[]" : job.warnings,
    sourcesFound: action === "retry" ? 0 : job.sourcesFound,
    transcriptsFound: action === "retry" ? 0 : job.transcriptsFound,
    candidatesFound: action === "retry" ? 0 : job.candidatesFound,
    clipsQueued: action === "retry" ? 0 : job.clipsQueued,
    clipsVerified: action === "retry" ? 0 : job.clipsVerified,
    currentOperation: action === "retry" ? "Retry queued" : "Queued",
    startedAt: action === "retry" ? null : job.startedAt,
    completedAt: null,
  });
  wakeFindClipsWorker();
}

export async function findJobDetail(jobId: number) {
  const db = getDb();
  const [job] = await db.select().from(findJobs).where(eq(findJobs.id, jobId));
  if (!job) throw new Error(`Find Clips job ${jobId} not found.`);
  const sources = await db.select().from(findSources).where(eq(findSources.jobFk, jobId)).orderBy(desc(findSources.rankScore));
  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, job.projectFk))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  const beats = revision ? await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord)) : [];
  const candidates = revision ? await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id)) : [];
  const clips = await db.select().from(clipJobs).where(eq(clipJobs.projectFk, job.projectFk)).orderBy(asc(clipJobs.id));
  return { job, sources, beats, candidates, clips, warnings: jsonStrings(job.warnings) };
}

export async function listFindJobs() {
  return getDb().select().from(findJobs).orderBy(desc(findJobs.updatedAt));
}

export function findWorkerStatus() {
  return { started: workerStarted, busy: pumping, pollIntervalMs: 5_000 };
}
