/**
 * Football-domain concept lexicon for clip matching.
 *
 * Maps editorial intents to concept families and their surface synonyms. This is
 * domain ENRICHMENT for the scoring system — not a keyword-only matcher (master
 * prompt §62). Hard metadata constraints always outrank semantic similarity.
 */

export interface FootballConcept {
  id: string;
  label: string;
  /** surface terms that indicate this concept in narration or commentary */
  terms: string[];
}

export const FOOTBALL_CONCEPTS: FootballConcept[] = [
  {
    id: "broken_tackle",
    label: "broken tackle",
    terms: ["broken tackle", "breaks a tackle", "breaking the first tackle", "broke the first tackle", "broke a tackle", "break a tackle", "makes the first defender miss", "missed tackle", "elusive", "yards after contact", "stiff arm", "bouncing off", "truck stick", "run over", "bulldoz", "powerful", "powering", "hard to bring down", "sheds a tackle", "shakes off"],
  },
  {
    id: "yac",
    label: "yards after catch",
    terms: ["yards after catch", "yac", "after the catch", "catch and run", "turns a short throw", "turned a short throw", "create after the catch", "turned a short completion", "screen", "checkdown", "underneath"],
  },
  {
    id: "explosive",
    label: "explosive play",
    terms: ["explosive", "big play", "breakaway", "breaks free", "long run", "chunk", "bursting", "accelerat", "explosive gain", "home run"],
  },
  {
    id: "power",
    label: "power running",
    terms: ["power", "bruising", "physical", "downhill", "pounding", "truck", "225", "strong", "tough", "between the tackles", "short yardage", "goal line", "barrels"],
  },
  {
    id: "touchdown",
    label: "touchdown",
    terms: ["touchdown", "td", "walks in", "stretches for the score", "into the end zone", "scores", "crosses the goal line"],
  },
  {
    id: "speed",
    label: "speed",
    terms: ["speed", "fast", "quick", "burst", "turns the corner", "outside", "edge", "sweep", "stretches"],
  },
  {
    id: "blocking",
    label: "blocking",
    terms: ["block", "blocking", "pass protect", "pancake", "mauler", "in the trenches", "chip"],
  },
  {
    id: "catch",
    label: "catch / reception",
    terms: ["catch", "caught", "reception", "target", "throw", "pass", "completion", "route", "hauled in", "snags"],
  },
];

export const GAME_NAMES = [
  "Notre Dame", "Louisville", "Clemson", "Florida", "Miami", "Florida State", "SMU", "Stanford", "Pitt", "Pittsburgh", "Ole Miss", "Indiana", "South Florida", "USF", "Bethune-Cookman", "Georgia Tech", "Virginia Tech", "North Carolina", "Duke", "Syracuse", "Boston College", "Wake Forest", "NC State", "Cal", "Virginia", "Kentucky", "Alabama", "Georgia", "Ohio State", "Texas", "Michigan", "Oregon", "Tennessee", "Auburn", "LSU", "USC", "Oklahoma", "Nebraska", "Wisconsin", "Penn State",
];

/** Normalize text for overlap matching. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Detect football concepts present in a piece of text. */
export function detectConcepts(text: string): string[] {
  const normalized = ` ${normalizeText(text)} `;
  const hits: string[] = [];
  for (const concept of FOOTBALL_CONCEPTS) {
    if (concept.terms.some((term) => normalized.includes(` ${normalizeText(term)} `))) {
      hits.push(concept.id);
    }
  }
  return hits;
}

/** Detect game references in narration (e.g. "Against Louisville", "in the Clemson game"). */
export function detectGames(text: string): string[] {
  const normalized = normalizeText(text);
  const found: string[] = [];
  const lower = GAME_NAMES.map((g) => g.toLowerCase());
  // Prefer multi-word names first so "Notre Dame" wins over "Dame".
  const ordered = [...GAME_NAMES].sort((a, b) => b.split(" ").length - a.split(" ").length);
  for (const name of ordered) {
    const n = name.toLowerCase();
    if (normalized.includes(n)) {
      found.push(name);
    }
  }
  void lower;
  return [...new Set(found)];
}

/** Token overlap between two text spans, as a 0..1 ratio. */
export function tokenOverlap(a: string, b: string): number {
  const aWords = new Set(normalizeText(a).split(" ").filter((w) => w.length > 2));
  const bWords = normalizeText(b).split(" ").filter((w) => w.length > 2);
  if (!aWords.size || !bWords.length) return 0;
  let hits = 0;
  for (const w of bWords) if (aWords.has(w)) hits += 1;
  return hits / Math.max(1, bWords.length);
}
