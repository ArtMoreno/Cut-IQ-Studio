/**
 * Script analysis: break pipeline narration into ordered visual beats with
 * entities, coverage needs, and budgeted search queries.
 *
 * Pure functions only — no I/O — so they are fully unit-testable.
 * Nothing here invents games, quotes, seasons, or events: every entity
 * must appear in the script text itself.
 */

export type CoverageType =
  | "game_footage"
  | "player_highlights"
  | "high_school_recruiting"
  | "press_conference"
  | "interview"
  | "coach_quote"
  | "practice_footage"
  | "crowd_stadium"
  | "historical"
  | "scoreboard_stats"
  | "establishing_shot"
  | "reaction_shot"
  | "transition_broll"
  | "backup_broll";

export type BeatPurpose =
  | "hook"
  | "narration"
  | "quote"
  | "play_reference"
  | "stat_callout"
  | "background"
  | "transition"
  | "outro";

export interface BeatAnalysis {
  ord: number;
  text: string;
  entities: string[];
  aliases: Record<string, string[]>; // entity -> variants
  purpose: BeatPurpose;
  coverageTypes: CoverageType[];
  needsTranscriptSearch: boolean;
  visualOnly: boolean;
  desiredClipLenSec: number;
  queries: string[]; // budgeted, deduplicated
  uncertainty: string | null;
}

export interface ScriptAnalysis {
  beats: BeatAnalysis[];
  primaryEntities: string[]; // most-mentioned entities across the script
  warnings: string[];
}

// ---------------------------------------------------------------- utils ----

const STOPWORDS = new Set([
  "the", "a", "an", "and", "but", "or", "so", "of", "in", "on", "at", "to",
  "for", "with", "that", "this", "these", "those", "his", "her", "he", "she",
  "it", "its", "was", "were", "is", "are", "be", "been", "as", "by", "from",
  "into", "over", "under", "about", "when", "where", "what", "which", "who",
  "had", "has", "have", "not", "no", "you", "they", "them", "their", "our",
  "we", "i", "my", "me", "him", "us", "if", "then", "than", "because", "after",
  "before", "while", "during", "will", "would", "could", "should", "can",
  "do", "does", "did", "done", "up", "out", "just", "also", "very", "more",
  "most", "some", "any", "all", "every", "each", "one", "two", "three", "here",
  "there", "now", "still", "even", "get", "got", "make", "made", "like",
]);

const POSITION_WORDS = new Set([
  "qb", "quarterback", "rb", "running", "wr", "receiver", "wideout", "te",
  "tight", "end", "ot", "tackle", "og", "guard", "c", "center", "ol",
  "lineman", "de", "defensive", "dt", "lb", "linebacker", "cb", "corner",
  "cornerback", "s", "safety", "db", "back", "k", "kicker", "p", "punter",
  "ls", "long", "snapper", "coach",
]);

const TEAM_HINT_WORDS = new Set([
  "miami", "alabama", "georgia", "ohio", "state", "texas", "michigan",
  "oregon", "tennessee", "florida", "auburn", "lsu", "clemson", "usc",
  "notre", "dame", "oklahoma", "baylor", "kansas", "kentucky", "arkansas",
  "mississippi", "ole", "miss", "vanderbilt", "missouri", "carolina",
  "virginia", "duke", "wake", "forest", "syracuse", "pitt", "pittsburgh",
  "boston", "college", "louisville", "cal", "stanford", "ucla", "washington",
  "arizona", "utah", "colorado", "nebraska", "iowa", "wisconsin", "minnesota",
  "illinois", "indiana", "purdue", "northwestern", "penn", "maryland",
  "rutgers", "hurricanes", "seminoles", "gators", "bulldogs", "tigercats",
  "tigers", "crimson", "tide", "sooners", "longhorns", "aggies", "rebels",
  "volunteers", "vols", "wildcats", "gamecocks", "razorbacks", "commodores",
  "eagles", "falcons", "owls", "bulls", "knights", "blackhawks",
]);

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation and paragraph breaks, keeping
  // abbreviations like "St." and "vs." intact enough for our purposes.
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+(?=[A-Z“"'])|\n{2,}|\n(?=[A-Z“"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanWord(w: string): string {
  return w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

function titleCase(w: string): string {
  return w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase();
}

// ------------------------------------------------------- beat splitting ----

const MAX_BEAT_SENTENCES = 3;
const MIN_BEAT_CHARS = 40;

/**
 * Group sentences into beats: quote blocks stand alone; otherwise sentences
 * are merged until the beat is long enough, capped at MAX_BEAT_SENTENCES.
 * Paragraph breaks always start a new beat.
 */
export function splitIntoBeats(scriptText: string): string[] {
  const paragraphs = scriptText
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter(Boolean);

  const beats: string[] = [];
  for (const para of paragraphs) {
    const sentences = splitSentences(para);
    let current: string[] = [];
    let currentLen = 0;
    const beatsBeforePara = beats.length;

    const flush = () => {
      if (current.length) {
        beats.push(current.join(" "));
        current = [];
        currentLen = 0;
      }
    };

    for (const s of sentences) {
      // A quote block is its own beat (it maps to interview/press footage).
      if (/^["“]/.test(s) && /["”]$/.test(s)) {
        flush();
        beats.push(s);
        continue;
      }
      current.push(s);
      currentLen += s.length;
      if (current.length >= MAX_BEAT_SENTENCES || currentLen >= 220) flush();
    }
    // Merge a trailing fragment into the previous beat of THIS paragraph only
    // (never across paragraph boundaries).
    if (current.length === 1 && currentLen < MIN_BEAT_CHARS && beats.length > beatsBeforePara) {
      beats[beats.length - 1] += " " + current[0];
    } else {
      flush();
    }
  }
  return beats;
}

// --------------------------------------------------------- entity mining ----

/** Extract candidate person names: capitalized sequences of 2-3 words. */
export function extractPersonNames(text: string): string[] {
  const found = new Map<string, number>();
  // Matches "Elijah Lofton", "Coach Mario Cristobal", "Arch Manning" etc.
  const re = /(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[0];
    const parts = raw.split(/\s+/).map(cleanWord).filter(Boolean);
    // Drop leading role words ("Coach Mario Cristobal" -> "Mario Cristobal")
    while (parts.length > 2 && POSITION_WORDS.has(parts[0].toLowerCase())) parts.shift();
    if (parts.length < 2) continue;
    // Reject sequences that look like team names only, or sentences
    const name = parts.slice(0, 3).map(titleCase).join(" ");
    if (name.split(" ").every((p) => TEAM_HINT_WORDS.has(p.toLowerCase())) && parts.length >= 2 && looksLikeTeam(name)) {
      continue;
    }
    found.set(name, (found.get(name) ?? 0) + 1);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

function looksLikeTeam(name: string): boolean {
  const parts = name.toLowerCase().split(" ");
  return parts.length >= 2 && TEAM_HINT_WORDS.has(parts[parts.length - 1]) && parts.every((p) => TEAM_HINT_WORDS.has(p));
}

/** Extract team/school names from the hint lexicon (only if in the script). */
export function extractTeams(text: string): string[] {
  const lower = text.toLowerCase();
  const teams: string[] = [];
  // Two-word combinations first (Ohio State, Notre Dame, Penn State...)
  for (const a of TEAM_HINT_WORDS) {
    for (const b of TEAM_HINT_WORDS) {
      if (a === b) continue;
      const combo = `${a} ${b}`;
      if (new RegExp(`\\b${combo}\\b`, "i").test(lower)) {
        const proper = text.match(new RegExp(`(${titleCase(a)}\\s+${titleCase(b)})`, "i"));
        if (proper && !teams.some((t) => t.toLowerCase() === proper[1].toLowerCase())) {
          teams.push(proper[1]);
        }
      }
    }
  }
  // Single strong tokens (Miami, Alabama, Georgia...)
  for (const t of TEAM_HINT_WORDS) {
    if (["state", "college", "notre", "dame", "ole", "miss"].includes(t)) continue;
    if (new RegExp(`\\b${t}\\b`, "i").test(lower)) {
      const proper = text.match(new RegExp(`\\b(${titleCase(t)})\\b`, "i"));
      if (proper && !teams.some((x) => x.toLowerCase() === proper[1].toLowerCase())
        && !teams.some((x) => x.toLowerCase().includes(proper[1].toLowerCase()))) {
        teams.push(proper[1]);
      }
    }
  }
  return teams.slice(0, 6);
}

export function extractYears(text: string): string[] {
  const years = new Set<string>();
  const re = /\b(19[6-9]\d|20[0-4]\d)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) years.add(m[1] ?? m[0]);
  // Season words: "2024 season", "last season", "as a freshman"
  return [...years];
}

/** Extract quoted phrases (8+ chars) from beat text — primary transcript search terms. */
export function extractQuotedPhrases(text: string): string[] {
  const out: string[] = [];
  const re = /["“]([^"”]{8,120})["”]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = (m[1] ?? "").trim();
    if (phrase) out.push(phrase);
  }
  return out;
}

/** Alias variants for a person name: surname, first name, full name. */
export function aliasesFor(name: string): string[] {
  const parts = name.split(" ").filter(Boolean);
  const variants: string[] = [];
  if (parts.length >= 2) {
    variants.push(parts[parts.length - 1]); // surname
    variants.push(parts[0]); // first name
    if (parts.length === 3) variants.push(`${parts[0]} ${parts[2]}`);
  }
  return [...new Set(variants)].filter((v) => v.length > 2 && !STOPWORDS.has(v.toLowerCase()));
}

// --------------------------------------------------- coverage heuristics ----

const COVERAGE_RULES: Array<{ re: RegExp; types: CoverageType[] }> = [
  { re: /\b(high\s?school|recruit(?:ing|ment)?|commit(?:ted|ment)?|offer(?:s|ed)?|rank(?:ed|ing)?|star(?:red)? prospect|transfer portal)\b/i, types: ["high_school_recruiting"] },
  { re: /\b(interview|press conference|presser|mic'?d up|podium|media (?:day|availability)|speaks? (?:with|to) (?:reporters?|media)|sat down)\b/i, types: ["interview", "press_conference"] },
  { re: /\b(coach|head coach|coordinator)\b.*\b(said|says|told|called|praised|explained)\b|\b(said|says)\b.*\b(coach)\b/i, types: ["coach_quote"] },
  { re: /\b(block(?:ing)?|run block|pass protect|chip|hand (?:in|on) the line|contact work)\b/i, types: ["practice_footage", "game_footage"] },
  { re: /\b(crowd|stadium|fans?|student section|sold out|atmosphere|tunnel walk|game ?day energy)\b/i, types: ["crowd_stadium"] },
  { re: /\b(stats?|numbers?|yards?|touchdowns?|receptions?|targets?|record(?:s)?|career[- ](?:best|high)|led the)\b/i, types: ["scoreboard_stats"] },
  { re: /\b(highlight(?:s)?|best plays?|top (?:\d+ )?plays?|every (?:snap|touch|catch)|all (?:his|the) touches)\b/i, types: ["player_highlights"] },
  { re: /\b(arrived?|rookie (?:year|season)|first (?:game|season|year)|freshman|debut)\b/i, types: ["game_footage", "historical"] },
  { re: /\b(transfer|portal|switched|moved to)\b/i, types: ["game_footage", "transition_broll"] },
  { re: /\b(injur(?:y|ies)|torn|sprain|rehab|came back|returned from)\b/i, types: ["game_footage", "interview"] },
  { re: /\b(championship|title game|playoff|bowl game|draft|combine|pro day)\b/i, types: ["game_footage", "historical"] },
  { re: /\b(reaction|celebrat(?:e|ion)|sideline (?:moment|reaction)|emotional)\b/i, types: ["reaction_shot"] },
  { re: /\b(city|campus|town|hometown|streets of|aerial)\b/i, types: ["establishing_shot"] },
];

const PLAY_REFERENCE_RE = /\b(play|snap|route|catch|touchdown|run|sack|interception|throw|pass|block|screen|slant|post|corner route|go route|hail mary|fourth (?:down|and)|two[- ]point)\b/i;
const VISUAL_ONLY_RE = /\b(crowd|stadium|atmosphere|tunnel|aerial|city|campus|b[- ]roll|slow motion|warm[- ]?ups?|practice)\b/i;
const SPEECH_RE = /\b(said|says|told|explained|admitted|described|quote|"|“|mic'?d|interview|press)\b/i;

export function classifyCoverage(text: string): { types: CoverageType[]; needsTranscript: boolean; visualOnly: boolean } {
  const types = new Set<CoverageType>();
  for (const rule of COVERAGE_RULES) {
    if (rule.re.test(text)) rule.types.forEach((t) => types.add(t));
  }
  const hasPlay = PLAY_REFERENCE_RE.test(text);
  if (hasPlay) types.add("game_footage");
  if (types.size === 0) types.add("backup_broll");

  const hasSpeechCue = SPEECH_RE.test(text);
  const visualOnly = VISUAL_ONLY_RE.test(text) && !hasSpeechCue && !hasPlay;
  const needsTranscript = hasSpeechCue && !visualOnly;
  return { types: [...types], needsTranscript, visualOnly };
}

// ------------------------------------------------- query generation (budgeted)

const QUERY_BUDGET_PER_BEAT = 3;

const COVERAGE_QUERY_TERMS: Partial<Record<CoverageType, string[]>> = {
  high_school_recruiting: ["high school highlights", "recruiting"],
  player_highlights: ["highlights", "every snap"],
  interview: ["interview"],
  press_conference: ["press conference"],
  coach_quote: ["press conference", "interview"],
  practice_footage: ["practice"],
  crowd_stadium: ["game day"],
  game_footage: ["highlights"],
  scoreboard_stats: ["highlights"],
  reaction_shot: ["reaction"],
  establishing_shot: ["campus"],
  historical: ["highlights"],
};

export function generateQueries(beat: { text: string; entities: string[]; aliases: Record<string, string[]>; coverageTypes: CoverageType[] }, years: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (q: string) => {
    const norm = q.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm && !seen.has(norm) && queries.length < QUERY_BUDGET_PER_BEAT) {
      seen.add(norm);
      queries.push(norm);
    }
  };

  const person = beat.entities.find((e) => (beat.aliases[e]?.length ?? 0) > 0);
  const team = beat.entities.find((e) => !beat.aliases[e] || beat.aliases[e].length === 0);
  const year = years[0];
  const surname = person ? (beat.aliases[person]?.[0] ?? person) : null;

  // 1) entity + coverage term (strongest)
  const coverageTerms = beat.coverageTypes.flatMap((c) => COVERAGE_QUERY_TERMS[c] ?? []);
  if (person && coverageTerms[0]) {
    add(`${person} ${coverageTerms[0]}${year ? " " + year : ""}`);
  }
  // 2) entity + team (game context)
  if (person && team) add(`${surname ?? person} ${team} highlights`);
  else if (person) add(`${person} highlights`);
  // 3) secondary coverage angle with alias to reduce redundancy
  if (surname && coverageTerms[1]) add(`${surname} ${coverageTerms[1]}`);
  else if (team && coverageTerms[0]) add(`${team} ${coverageTerms[0]}${year ? " " + year : ""}`);

  return queries;
}

// ------------------------------------------------------------ beat purpose ----

export function classifyPurpose(text: string, ord: number, total: number): BeatPurpose {
  if (/^["“]/.test(text)) return "quote";
  if (ord === 0) return "hook";
  if (ord === total - 1 && /\b(thanks|subscribe|follow|next time|until next|that'?s (?:the|all))\b/i.test(text)) return "outro";
  if (/\b(stats?|yards|touchdowns|receptions|record|numbers)\b/i.test(text) && /\d/.test(text)) return "stat_callout";
  if (PLAY_REFERENCE_RE.test(text)) return "play_reference";
  if (/^(but|yet|and yet|here'?s the thing|the thing is|so|now|meanwhile|back in)\b/i.test(text)) return "transition";
  if (/\b(grew up|hometown|background|history|before (?:he|she|they)|as a kid)\b/i.test(text)) return "background";
  return "narration";
}

// ------------------------------------------------------------------ main ----

export function analyzeScript(scriptText: string, opts?: { maxBeats?: number }): ScriptAnalysis {
  const warnings: string[] = [];
  const trimmed = scriptText.trim();
  if (!trimmed) return { beats: [], primaryEntities: [], warnings: ["Empty script."] };

  const rawBeats = splitIntoBeats(trimmed);
  const maxBeats = opts?.maxBeats ?? 60;
  if (rawBeats.length > maxBeats) {
    warnings.push(`Script produced ${rawBeats.length} beats; truncated to ${maxBeats}.`);
  }
  const beatTexts = rawBeats.slice(0, maxBeats);

  // Global entities for alias/query context
  const globalPeople = extractPersonNames(trimmed);
  const globalTeams = extractTeams(trimmed);
  const globalYears = extractYears(trimmed);

  const beats: BeatAnalysis[] = beatTexts.map((text, i) => {
    const people = extractPersonNames(text).filter((p) => globalPeople.includes(p));
    const teams = extractTeams(text);
    const entities = [...new Set([...people, ...teams])];
    const aliases: Record<string, string[]> = {};
    for (const p of people) aliases[p] = aliasesFor(p);

    const { types, needsTranscript, visualOnly } = classifyCoverage(text);
    const purpose = classifyPurpose(text, i, beatTexts.length);

    let uncertainty: string | null = null;
    if (entities.length === 0) {
      uncertainty = "No identifiable entities — candidates will need manual review.";
    }

    const desiredClipLenSec =
      purpose === "quote" ? 10 : purpose === "play_reference" ? 8 : purpose === "stat_callout" ? 6 : 7;

    return {
      ord: i,
      text,
      entities,
      aliases,
      purpose,
      coverageTypes: types,
      needsTranscriptSearch: needsTranscript,
      visualOnly,
      desiredClipLenSec,
      queries: generateQueries({ text, entities, aliases, coverageTypes: types }, globalYears),
      uncertainty,
    };
  });

  const primaryEntities = [...new Set([...globalPeople.slice(0, 3), ...globalTeams.slice(0, 3)])];

  return { beats, primaryEntities, warnings };
}
