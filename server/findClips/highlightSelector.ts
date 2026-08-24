export type HighlightTunerMode = "balanced" | "highlights" | "best_only" | "custom";

export type HighlightClassification = "actual_play" | "probable_play" | "incidental_mention";

export interface HighlightTunerSettings {
  mode: HighlightTunerMode;
  maxClipsPerGame: number;
  minimumEstimatedYards: number;
  minimumExcitement: number;
  includeProbablePlays: boolean;
  alwaysIncludeTouchdowns: boolean;
  includeKeyDowns: boolean;
  includeRedZonePlays: boolean;
}

export interface HighlightCandidate {
  id?: string | number;
  title?: string | null;
  transcriptExcerpt?: string | null;
  sourceUrl?: string | null;
  dupGroupKey?: string | null;
  editIn?: number | null;
  editOut?: number | null;
  relevanceScore?: number | null;
  qualityScore?: number | null;
}

export interface HighlightSignals {
  classification: HighlightClassification;
  touchdown: boolean;
  keyDown: boolean;
  redZone: boolean;
  estimatedYards: number | null;
  excitement: number;
  score: number;
  cues: readonly string[];
}

export type HighlightSelectionReason = "always_include_touchdown" | "ranked_highlight";
export type HighlightRejectionReason =
  | "incidental_mention"
  | "probable_play_disabled"
  | "below_highlight_threshold"
  | "per_game_limit"
  | "outside_job_scope"
  | "duplicate_play";

export interface SelectedHighlight<T extends HighlightCandidate> {
  candidate: T;
  originalIndex: number;
  gameKey: string;
  signals: HighlightSignals;
  reason: HighlightSelectionReason;
}

export interface UnselectedHighlight<T extends HighlightCandidate> {
  candidate: T;
  originalIndex: number;
  gameKey: string;
  signals: HighlightSignals;
  reason: HighlightRejectionReason;
}

export interface HighlightSelection<T extends HighlightCandidate> {
  settings: Readonly<HighlightTunerSettings>;
  selected: readonly SelectedHighlight<T>[];
  unselected: readonly UnselectedHighlight<T>[];
}

export interface HighlightSelectionOptions<T extends HighlightCandidate> {
  /** Player attribution keeps nearby action by another player from scoring. */
  player?: string;
  /** Production integration should pass the engine's canonical sourceGameKey. */
  getGameKey?: (candidate: T, team: string) => string;
  /** Job-specific scope checks (for example, explicit wrong-season titles). */
  isCandidateEligible?: (candidate: T) => boolean;
}

const MODE_DEFAULTS: Readonly<Record<Exclude<HighlightTunerMode, "custom">, Readonly<HighlightTunerSettings>>> = {
  balanced: Object.freeze({
    mode: "balanced",
    maxClipsPerGame: 8,
    minimumEstimatedYards: 5,
    minimumExcitement: 8,
    includeProbablePlays: true,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: true,
  }),
  highlights: Object.freeze({
    mode: "highlights",
    maxClipsPerGame: 5,
    minimumEstimatedYards: 10,
    minimumExcitement: 13,
    includeProbablePlays: false,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: true,
  }),
  best_only: Object.freeze({
    mode: "best_only",
    maxClipsPerGame: 3,
    minimumEstimatedYards: 15,
    minimumExcitement: 18,
    includeProbablePlays: false,
    alwaysIncludeTouchdowns: true,
    includeKeyDowns: true,
    includeRedZonePlays: false,
  }),
};

export const DEFAULT_HIGHLIGHT_TUNER_MODE: Exclude<HighlightTunerMode, "custom"> = "highlights";

export function defaultHighlightTunerSettings(
  mode: Exclude<HighlightTunerMode, "custom"> = DEFAULT_HIGHLIGHT_TUNER_MODE,
): Readonly<HighlightTunerSettings> {
  return MODE_DEFAULTS[mode];
}

export function customHighlightTunerSettings(
  overrides: Partial<Omit<HighlightTunerSettings, "mode">> = {},
): Readonly<HighlightTunerSettings> {
  const base = MODE_DEFAULTS.highlights;
  return Object.freeze({
    ...base,
    ...overrides,
    mode: "custom",
    maxClipsPerGame: positiveInteger(overrides.maxClipsPerGame, base.maxClipsPerGame),
    minimumEstimatedYards: nonNegativeNumber(overrides.minimumEstimatedYards, base.minimumEstimatedYards),
    minimumExcitement: nonNegativeNumber(overrides.minimumExcitement, base.minimumExcitement),
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? value! : fallback;
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9'!]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return only clauses locally attributable to the requested player. A new
 * named actor after "as/while/but/then" or a quarterback keep ends the window.
 */
export function playerAttributedTranscript(transcript: string | null | undefined, player?: string): string {
  const source = transcript ?? "";
  if (!player?.trim()) return source;
  const playerParts = normalized(player).split(" ").filter(Boolean);
  const surname = playerParts.at(-1);
  if (!surname) return "";
  const fullName = playerParts.map(escapedPattern).join("\\s+");
  const mentions = [...source.matchAll(new RegExp(`\\b(?:${fullName}|${escapedPattern(surname)})\\b`, "gi"))];
  if (!mentions.length) return "";

  return mentions.map((mention) => {
    const mentionStart = mention.index;
    const mentionEnd = mentionStart + mention[0].length;
    const sentenceStart = Math.max(
      source.lastIndexOf(".", mentionStart - 1),
      source.lastIndexOf("?", mentionStart - 1),
      source.lastIndexOf("!", mentionStart - 1),
      source.lastIndexOf("\n", mentionStart - 1),
    ) + 1;
    const endings = [".", "?", "!", "\n"]
      .map((separator) => source.indexOf(separator, mentionEnd))
      .filter((index) => index >= 0);
    const sentenceEnd = endings.length ? Math.min(...endings) + 1 : source.length;
    const beforeMention = source.slice(Math.max(sentenceStart, mentionStart - 30), mentionStart);
    if (/\bfake(?:s|d)?(?: it)? to\s*$/i.test(beforeMention)) return source.slice(mentionStart, mentionEnd);
    const immediateTouchdown = /\btouchdown\s*$/i.test(beforeMention) ? beforeMention.match(/touchdown\s*$/i)?.index : null;
    const start = immediateTouchdown == null ? mentionStart : Math.max(sentenceStart, mentionStart - (beforeMention.length - immediateTouchdown));
    let end = Math.min(sentenceEnd, mentionEnd + 100);
    const afterMention = source.slice(mentionEnd, end);
    const takeover = /(?:;|\b(?:as|while|but|then|for)\b)\s+(?!he\b|him\b|his\b)(?:the\s+)?(?:quarterback|qb|[a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})(?:\s+who)?\s+(?:keeps|scores|runs|rushes|dives|punches|powers|walks|catches|takes)\b/i.exec(afterMention);
    const namedCommaTakeover = /(?:,|;)\s+(?:the\s+)?(?:quarterback|QB|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:keeps|scores|runs|rushes|dives|punches|powers|walks|catches|takes)\b/.exec(afterMention);
    const cutoff = [takeover?.index, namedCommaTakeover?.index].filter((index): index is number => index != null);
    if (cutoff.length) end = mentionEnd + Math.min(...cutoff);
    return source.slice(start, end);
  }).join(" ");
}

function playerLocalContext(transcript: string | null | undefined, player?: string): string {
  const source = transcript ?? "";
  if (!player?.trim()) return source;
  const playerParts = normalized(player).split(" ").filter(Boolean);
  const surname = playerParts.at(-1);
  if (!surname) return "";
  const fullName = playerParts.map(escapedPattern).join("\\s+");
  const mentions = [...source.matchAll(new RegExp(`\\b(?:${fullName}|${escapedPattern(surname)})\\b`, "gi"))];
  return mentions.map((mention) => source.slice(
    Math.max(0, mention.index - 100),
    Math.min(source.length, mention.index + mention[0].length + 100),
  )).join(" ");
}

function playerNamePattern(player?: string): string | null {
  const parts = normalized(player ?? "").split(" ").filter(Boolean);
  const surname = parts.at(-1);
  if (!surname) return null;
  return `(?:${parts.map(escapedPattern).join("\\s+")}|${escapedPattern(surname)})`;
}

function playerAdjacentTouchdown(transcript: string | null | undefined, player?: string): boolean {
  const name = playerNamePattern(player);
  if (!name) return false;
  const text = normalized(transcript ?? "");
  const patterns = [
    new RegExp(`\\b(?:instead )?it'?s ${name} (?:it'?s )?(?:a )?touchdown\\b`),
    new RegExp(`\\btouchdown (?:is |for )?${name}\\b`),
    new RegExp(`\\btouchdown.{0,90}\\b${name} (?:just )?(?:stroll(?:ed|s)?|walk(?:ed|s)?|ran|runs?|went|goes?|got|gets?) (?:in|into the end(?: zone)?)\\b`),
  ];
  if (!patterns.some((pattern) => pattern.test(text))) return false;
  if (HISTORICAL_SCORE.test(text) || HYPOTHETICAL_SCORE.test(text)) return false;
  if (new RegExp(`\\bfake(?:s|d)?(?: it)? to ${name}\\b`).test(text)) return false;
  return true;
}

function playerAdjacentYardage(transcript: string | null | undefined, player?: string): string {
  const source = transcript ?? "";
  const name = playerNamePattern(player);
  if (!name) return "";
  const snippets: string[] = [];
  for (const mention of source.matchAll(new RegExp(`\\b${name}\\b`, "gi"))) {
    const after = source.slice(mention.index, Math.min(source.length, mention.index + mention[0].length + 65));
    const yardage = /\b\d{1,2}\s*(?:yards?|yds?)\s*(?:gain|pick\s*up|pickup|run|rush|reception)\b/i.exec(after);
    if (!yardage) continue;
    const throughYardage = after.slice(0, yardage.index + yardage[0].length + 12);
    if (/\b(?:last week|earlier|previously|prior|season|year)\b/i.test(throughYardage.slice(yardage.index))) continue;
    if (/(?:;|\b(?:as|while|but|then|for)\b)\s+(?!he\b|him\b|his\b)(?:the\s+)?(?:quarterback|qb|[a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})(?:\s+who)?\s+(?:keeps|scores|runs|rushes|dives|punches|powers|walks|catches|takes)\b/i.test(throughYardage)) continue;
    snippets.push(yardage[0]);
  }
  return snippets.join(" ");
}

const ACTIVE_PLAY = [
  /\b(?:takes?|gets?) the (?:handoff|carry)\b/,
  /\b(?:handoff|pitch) (?:to|for)\b/,
  /\b(?:runs?|rushes?|rumbles?|bursts?|scrambles?) (?:for|to|through|up|left|right)\b/,
  /\b(?:picks? up|gains?|loses?) (?:about )?(?:\d+|a |one |two |three |four |five |six |seven |eight |nine |ten )/,
  /\b(?:pass|throw) (?:is )?(?:caught|complete)\b/,
  /\b(?:caught|reception|tackled|brought down|breaks? free|into the end zone)\b/,
  /\b(?:scores|runs? it in|punches? it in|powers? it in|dives? in|walks? in)\b/,
];

const PROBABLE_PLAY = [
  /\b(?:run|rush|carry|reception|catch|handoff|tackle|first down|touchdown)\b/,
  /\b(?:up the middle|around the edge|down the sideline|at the goal line)\b/,
];

const INCIDENTAL = [
  /\b(?:last week|earlier this season|on the season|this year|career|in his career)\b/,
  /\b(?:averag(?:e|es|ing)|season total|stat line|yards per carry)\b/,
  /\b(?:interview|press conference|player profile|injury update|coming up|we talked (?:to|about))\b/,
];

const LIVE_OVERRIDE = [
  /\b(?:takes the handoff|gets the carry|handoff to|pitch to|breaks free|brought down)\b/,
  /\b(?:pass is caught|pass is complete|into the end zone)\b/,
];

const TOUCHDOWN = /\b(?:touchdown|td|into the end zone|house call|takes? it to the house)\b/;
const LIVE_TOUCHDOWN = /\b(?:scores|runs? it in|punches? it in|powers? it in|dives? in|walks? in)\b/;
const HISTORICAL_SCORE = /\b(?:scored|touchdown) (?:last week|earlier|previously|this season|this year)\b/;
const HYPOTHETICAL_SCORE = /\b(?:would|could|might)\b.{0,80}\btouchdown\b|\bif\b.{0,60}\b(?:score[sd]?|touchdown)\b/;
const KEY_DOWN = /\b(?:third|3rd|fourth|4th) (?:and|down)|\b(?:converts?|conversion|moves? the chains|first down)\b/;
const RED_ZONE = /\b(?:red zone|goal line|goal to go|inside the (?:twenty|20|ten|10|five|5)|and goal)\b/;

const EXCITEMENT_CUES: ReadonlyArray<readonly [RegExp, number, string]> = [
  [/\b(?:breaks? free|wide open|nobody is going to catch|gone)\b/, 8, "breakaway"],
  [/\b(?:huge|massive|explosive|incredible|spectacular|what a play)\b/, 6, "major_call"],
  [/\b(?:stiff arm|hurdles?|jukes?|spins? away|trucks?)\b/, 5, "elusive_finish"],
  [/\b(?:down the sideline|open field|across midfield)\b/, 4, "open_field"],
  [/\b(?:crowd (?:roars?|erupts?)|listen to this crowd)\b/, 5, "crowd_reaction"],
];

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
});

function yardNumber(value: string, suffix?: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed >= 0 && parsed <= 99 ? parsed : null;
  }
  const first = NUMBER_WORDS[value];
  if (first == null) return null;
  const second = suffix ? NUMBER_WORDS[suffix] : null;
  const parsed = second != null && first >= 20 && second < 10 ? first + second : first;
  return parsed <= 99 ? parsed : null;
}

/** Parse only explicit gain/run yardage phrases, never field position or clock numbers. */
export function estimatePlayYards(transcript: string | null | undefined): number | null {
  const text = normalized(transcript ?? "");
  const number = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
  const suffix = "(?:[- ](one|two|three|four|five|six|seven|eight|nine))?";
  const patterns = [
    new RegExp(`\\b${number}${suffix}\\s*(?:yards?|yds?)\\s+(?:run|rush|gain|pick up|pickup|reception|catch)\\b`, "g"),
    new RegExp(`\\b(?:gain(?:s|ed)?|pickup|picks? up|runs?|rushes?|rumbles?) (?:of |for )?${number}${suffix}\\s*(?:yards?|yds?)\\b`, "g"),
    new RegExp(`\\b(?:for|gained) ${number}${suffix}\\s*(?:yards?|yds?)\\b`, "g"),
  ];
  const estimates: number[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (/^\s*(?:prior|last week|earlier|previously)\b/.test(text.slice(match.index! + match[0].length, match.index! + match[0].length + 24))) continue;
      const parsed = yardNumber(match[1]!, match[2]);
      if (parsed != null) estimates.push(parsed);
    }
  }
  return estimates.length ? Math.max(...estimates) : null;
}

export function analyzeHighlightCandidate(candidate: HighlightCandidate, player?: string): HighlightSignals {
  const text = normalized(playerAttributedTranscript(candidate.transcriptExcerpt, player));
  const context = normalized(playerLocalContext(candidate.transcriptExcerpt, player));
  const adjacentTouchdown = playerAdjacentTouchdown(candidate.transcriptExcerpt, player);
  const active = adjacentTouchdown || ACTIVE_PLAY.some((pattern) => pattern.test(text));
  const probable = PROBABLE_PLAY.some((pattern) => pattern.test(text));
  const incidental = INCIDENTAL.some((pattern) => pattern.test(text)) && !LIVE_OVERRIDE.some((pattern) => pattern.test(text));
  const classification: HighlightClassification = incidental
    ? "incidental_mention"
    : active
      ? "actual_play"
      : probable
        ? "probable_play"
        : "incidental_mention";
  const touchdown = (adjacentTouchdown || TOUCHDOWN.test(text) || LIVE_TOUCHDOWN.test(text))
    && !HISTORICAL_SCORE.test(text)
    && !HYPOTHETICAL_SCORE.test(text);
  const keyDown = KEY_DOWN.test(context);
  const redZone = RED_ZONE.test(context);
  const estimatedYards = estimatePlayYards(`${text} ${playerAdjacentYardage(candidate.transcriptExcerpt, player)}`);
  const cues: string[] = [];
  let excitement = Math.min(4, (text.match(/!/g) ?? []).length * 2);
  for (const [pattern, points, cue] of EXCITEMENT_CUES) {
    if (!pattern.test(text)) continue;
    excitement += points;
    cues.push(cue);
  }
  if (touchdown) { excitement += 10; cues.push("touchdown"); }
  if (keyDown) { excitement += 4; cues.push("key_down"); }
  if (redZone) { excitement += 3; cues.push("red_zone"); }
  if (estimatedYards != null) cues.push(`estimated_${estimatedYards}_yards`);
  if (classification === "actual_play") cues.push("actual_play_language");
  if (classification === "probable_play") cues.push("probable_play_language");
  if (classification === "incidental_mention") cues.push("incidental_or_no_play_language");
  const existingConfidence = Math.max(0, Number(candidate.relevanceScore ?? 0)) + Math.max(0, Number(candidate.qualityScore ?? 0));
  const score = Math.round((
    (classification === "actual_play" ? 35 : classification === "probable_play" ? 16 : 0)
    + (touchdown ? 50 : 0)
    + (keyDown ? 12 : 0)
    + (redZone ? 8 : 0)
    + Math.min(30, (estimatedYards ?? 0) * 1.2)
    + Math.min(25, excitement)
    + Math.min(10, existingConfidence * 5)
  ) * 10) / 10;
  return Object.freeze({
    classification,
    touchdown,
    keyDown,
    redZone,
    estimatedYards,
    excitement: Math.min(25, excitement),
    score,
    cues: Object.freeze(cues),
  });
}

/** Isolated fallback matching the current engine grouper without importing runtime dependencies. */
export function inferHighlightGameKey(title: string | null | undefined, team: string): string {
  const normalizedTitle = normalized(title ?? "");
  const normalizedTeam = normalized(team);
  const sides = normalizedTitle.split(/\b(?:vs|at)\b/).map((side) => side.trim()).filter(Boolean);
  const opponentSide = sides.find((side) => normalizedTeam && !side.includes(normalizedTeam)) ?? normalizedTitle;
  const generic = new Set([
    ...normalizedTeam.split(" "), "full", "game", "replay", "highlights", "highlight", "football", "college", "ncaa",
    "big", "acc", "conference", "week", "bowl", "espn", "cfb", "sports", "pop", "tarts", "august", "september", "october",
    "november", "december", "january",
  ]);
  const opponent = opponentSide.split(" ").filter((token) => !generic.has(token) && !/^\d+$/.test(token) && !/^20\d{2}$/.test(token)).slice(0, 5).join(" ");
  return opponent || normalizedTitle || "unknown-game";
}

/** Tuner-only grouping that normalizes upload formatting and separates championships. */
export function highlightGameKey(title: string | null | undefined, team: string): string {
  const prepared = (title ?? "").replace(/#\d+/g, " ").replace(/@/g, " at ");
  const normalizedTitle = normalized(prepared);
  const normalizedTeam = normalized(team);
  const sides = normalizedTitle.split(/\b(?:vs|at)\b/).map((side) => side.trim()).filter(Boolean);
  const opponentSide = sides.find((side) => normalizedTeam && !side.includes(normalizedTeam)) ?? normalizedTitle;
  const generic = new Set([
    ...normalizedTeam.split(" "), "cougars", "wildcats", "full", "game", "replay", "condensed", "highlights", "highlight",
    "football", "college", "ncaa", "big", "xii", "conference", "week", "bowl", "espn", "cfb", "sports", "video",
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  ]);
  const opponent = opponentSide.split(" ").filter((token) => (
    !generic.has(token)
    && !/^\d+$/.test(token)
    && !/^20\d{2}$/.test(token)
    && !/^\d{3,4}p(?:\d+fps)?$/.test(token)
  )).slice(0, 5).join(" ") || "unknown-game";
  return `${opponent}${/\bchampionship\b/.test(normalizedTitle) ? ":championship" : ":regular"}`;
}

/** Accept undated titles and titles whose explicit four- or two-digit year matches the requested season. */
export function highlightTitleMatchesSeason(title: string | null | undefined, season: number): boolean {
  const source = title ?? "";
  const explicitYears = [...source.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  const shortDateYears = [...source.matchAll(/(?:^|[\s(])\d{1,2}[./-]\d{1,2}[./-](\d{2})\b/g)]
    .map((match) => 2000 + Number(match[1]));
  const years = [...explicitYears, ...shortDateYears];
  return years.length === 0 || years.every((year) => year === season);
}

const DISTINCTIVE_STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "between", "could", "down", "from", "game", "have",
  "into", "just", "martin", "more", "play", "right", "that", "their", "there", "these", "they", "this", "those", "through",
  "touchdown", "very", "watch", "what", "when", "where", "which", "with", "would", "yards", "your",
]);

function distinctiveTranscriptTokens(candidate: HighlightCandidate): Set<string> {
  return new Set(normalized(candidate.transcriptExcerpt ?? "").split(" ").filter((token) => token.length >= 4 && !DISTINCTIVE_STOP_WORDS.has(token)));
}

function rangesSubstantiallyOverlap(left: HighlightCandidate, right: HighlightCandidate): boolean {
  if (!left.sourceUrl || left.sourceUrl !== right.sourceUrl) return false;
  if (left.editIn == null || left.editOut == null || right.editIn == null || right.editOut == null) return false;
  const overlap = Math.min(left.editOut, right.editOut) - Math.max(left.editIn, right.editIn);
  const shorter = Math.min(left.editOut - left.editIn, right.editOut - right.editIn);
  const centerDistance = Math.abs(((left.editIn + left.editOut) / 2) - ((right.editIn + right.editOut) / 2));
  return shorter > 0 && centerDistance <= 4 && overlap / shorter >= 0.75;
}

function highlyDistinctiveTranscriptOverlap(left: HighlightCandidate, right: HighlightCandidate): boolean {
  const leftText = normalized(left.transcriptExcerpt ?? "");
  const rightText = normalized(right.transcriptExcerpt ?? "");
  if (Math.min(leftText.length, rightText.length) >= 80 && (leftText.includes(rightText) || rightText.includes(leftText))) return true;
  const leftTokens = distinctiveTranscriptTokens(left);
  const rightTokens = distinctiveTranscriptTokens(right);
  if (Math.min(leftTokens.size, rightTokens.size) < 12) return false;
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return common >= 12 && common / Math.min(leftTokens.size, rightTokens.size) >= 0.82;
}

function candidatesAreDuplicate(
  left: { candidate: HighlightCandidate; gameKey: string; signals: HighlightSignals },
  right: { candidate: HighlightCandidate; gameKey: string; signals: HighlightSignals },
): boolean {
  const sharedEventKey = left.candidate.dupGroupKey
    && left.candidate.dupGroupKey === right.candidate.dupGroupKey
    && /^(?:play|soundbite|sound):/i.test(left.candidate.dupGroupKey);
  if (sharedEventKey) return true;
  if (
    left.gameKey === right.gameKey
    && left.signals.touchdown
    && right.signals.touchdown
    && left.candidate.sourceUrl
    && left.candidate.sourceUrl === right.candidate.sourceUrl
    && left.candidate.editIn != null
    && left.candidate.editOut != null
    && right.candidate.editIn != null
    && right.candidate.editOut != null
  ) {
    const leftCenter = (left.candidate.editIn + left.candidate.editOut) / 2;
    const rightCenter = (right.candidate.editIn + right.candidate.editOut) / 2;
    const rangeOverlap = Math.min(left.candidate.editOut, right.candidate.editOut)
      - Math.max(left.candidate.editIn, right.candidate.editIn);
    if (rangeOverlap > 0 && Math.abs(leftCenter - rightCenter) <= 60) return true;
  }
  if (rangesSubstantiallyOverlap(left.candidate, right.candidate)) return true;
  return left.gameKey === right.gameKey && highlyDistinctiveTranscriptOverlap(left.candidate, right.candidate);
}

function preliminaryRejection(signals: HighlightSignals, settings: HighlightTunerSettings): HighlightRejectionReason | null {
  if (signals.classification === "incidental_mention") return "incidental_mention";
  if (signals.classification === "probable_play" && !settings.includeProbablePlays) return "probable_play_disabled";
  if (signals.touchdown && settings.alwaysIncludeTouchdowns) return null;
  const notable = (signals.estimatedYards != null && signals.estimatedYards >= settings.minimumEstimatedYards)
    || (signals.keyDown && settings.includeKeyDowns)
    || (signals.redZone && settings.includeRedZonePlays)
    || signals.excitement >= settings.minimumExcitement;
  return notable ? null : "below_highlight_threshold";
}

/**
 * Rank and select candidates without mutating the input array or its objects.
 * Always-included touchdowns may exceed the per-game cap; all other plays are
 * capped. Ties retain input order, making repeated runs deterministic.
 */
export function selectHighlights<T extends HighlightCandidate>(
  candidates: readonly T[],
  team: string,
  settings: Readonly<HighlightTunerSettings> = defaultHighlightTunerSettings(),
  options: Readonly<HighlightSelectionOptions<T>> = {},
): HighlightSelection<T> {
  const getGameKey = options.getGameKey ?? ((candidate: T, candidateTeam: string) => inferHighlightGameKey(candidate.title, candidateTeam));
  const analyzed = candidates.map((candidate, originalIndex) => ({
    candidate,
    originalIndex,
    gameKey: getGameKey(candidate, team),
    signals: analyzeHighlightCandidate(candidate, options.player),
    eligible: options.isCandidateEligible?.(candidate) ?? true,
  }));
  const ranked = [...analyzed].sort((left, right) => right.signals.score - left.signals.score || left.originalIndex - right.originalIndex);
  const selected: SelectedHighlight<T>[] = [];
  const unselected: UnselectedHighlight<T>[] = [];
  const dedupeRepresentatives: Array<(typeof ranked)[number]> = [];
  const gameCounts = new Map<string, number>();

  for (const item of ranked) {
    if (!item.eligible) {
      const { eligible: _eligible, ...preserved } = item;
      unselected.push({ ...preserved, reason: "outside_job_scope" });
      continue;
    }
    const rejection = preliminaryRejection(item.signals, settings);
    if (rejection) {
      const { eligible: _eligible, ...preserved } = item;
      unselected.push({ ...preserved, reason: rejection });
      continue;
    }
    if (dedupeRepresentatives.some((prior) => candidatesAreDuplicate(item, prior))) {
      const { eligible: _eligible, ...preserved } = item;
      unselected.push({ ...preserved, reason: "duplicate_play" });
      continue;
    }
    const mandatory = item.signals.touchdown && settings.alwaysIncludeTouchdowns;
    const count = gameCounts.get(item.gameKey) ?? 0;
    if (!mandatory && count >= settings.maxClipsPerGame) {
      const { eligible: _eligible, ...preserved } = item;
      unselected.push({ ...preserved, reason: "per_game_limit" });
      continue;
    }
    const { eligible: _eligible, ...preserved } = item;
    selected.push({ ...preserved, reason: mandatory ? "always_include_touchdown" : "ranked_highlight" });
    dedupeRepresentatives.push(item);
    gameCounts.set(item.gameKey, count + 1);
  }

  return Object.freeze({
    settings: Object.freeze({ ...settings }),
    selected: Object.freeze(selected),
    unselected: Object.freeze(unselected),
  });
}
