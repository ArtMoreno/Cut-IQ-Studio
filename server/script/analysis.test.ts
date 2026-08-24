/**
 * Script analysis — pure-function unit tests (no I/O).
 */
import { describe, expect, it } from "vitest";
import {
  aliasesFor,
  analyzeScript,
  classifyCoverage,
  classifyPurpose,
  extractPersonNames,
  extractTeams,
  extractYears,
  generateQueries,
  splitIntoBeats,
} from "./analysis";

const LOFTON_SCRIPT = `Elijah Lofton arrived at Miami as a matchup problem. Coaches talked about using him all over the formation.

"Lofton is the kind of tight end you build a game plan around," said head coach Mario Cristobal.

Playing tight end at this level also means being willing to block. Lofton's run-blocking snaps showed real contact work.

In the 2024 season he had 31 receptions for 412 yards and three touchdowns.

The story is just beginning. Thanks for watching.`;

describe("splitIntoBeats", () => {
  it("splits paragraphs into separate beats", () => {
    const beats = splitIntoBeats("First sentence. Second one.\n\nNew paragraph here.");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.some((b) => b.includes("New paragraph"))).toBe(true);
  });

  it("keeps a quote block as its own beat", () => {
    const beats = splitIntoBeats(LOFTON_SCRIPT);
    const quoteBeat = beats.find((b) => b.startsWith('"Lofton is the kind'));
    expect(quoteBeat).toBeTruthy();
    expect(quoteBeat).toContain("Mario Cristobal");
  });

  it("never returns empty beats", () => {
    const beats = splitIntoBeats("   \n\n  ");
    expect(beats.length).toBe(0);
  });
});

describe("entity extraction", () => {
  it("finds person names from the script itself (no invention)", () => {
    const names = extractPersonNames(LOFTON_SCRIPT);
    expect(names).toContain("Elijah Lofton");
    expect(names).toContain("Mario Cristobal");
  });

  it("does not invent people not in the text", () => {
    const names = extractPersonNames("A quiet story about the weather.");
    expect(names).toEqual([]);
  });

  it("extracts teams", () => {
    expect(extractTeams("He committed to Miami over Ohio State.")).toContain("Miami");
    expect(extractTeams("He committed to Miami over Ohio State.").join(" ")).toContain("Ohio State");
  });

  it("extracts years", () => {
    expect(extractYears("In the 2024 season, back in 2019.")).toEqual(
      expect.arrayContaining(["2024", "2019"]),
    );
  });

  it("builds alias variants", () => {
    const aliases = aliasesFor("Elijah Lofton");
    expect(aliases).toContain("Lofton");
    expect(aliases).toContain("Elijah");
  });
});

describe("coverage classification", () => {
  it("flags recruiting coverage", () => {
    const { types } = classifyCoverage("His high-school recruiting ranking was five stars.");
    expect(types).toContain("high_school_recruiting");
  });

  it("flags interview/press cues and wants transcript search", () => {
    const { types, needsTranscript } = classifyCoverage('In the interview he said "I was ready."');
    expect(types).toContain("interview");
    expect(needsTranscript).toBe(true);
  });

  it("marks visual-only beats (crowd atmosphere, no speech cues)", () => {
    const { visualOnly, needsTranscript } = classifyCoverage("The stadium atmosphere was electric that night.");
    expect(visualOnly).toBe(true);
    expect(needsTranscript).toBe(false);
  });

  it("falls back to backup b-roll when nothing matches", () => {
    const { types } = classifyCoverage("And then it happened.");
    expect(types).toContain("backup_broll");
  });
});

describe("purpose classification", () => {
  it("marks the first beat as hook and quoted beats as quote", () => {
    expect(classifyPurpose("Opening line.", 0, 5)).toBe("hook");
    expect(classifyPurpose('"A quote."', 2, 5)).toBe("quote");
  });

  it("detects stat callouts", () => {
    expect(classifyPurpose("He had 31 receptions for 412 yards.", 2, 5)).toBe("stat_callout");
  });
});

describe("query generation", () => {
  it("stays within the budget and dedupes", () => {
    const queries = generateQueries(
      {
        text: "Lofton arrived at Miami.",
        entities: ["Elijah Lofton", "Miami"],
        aliases: { "Elijah Lofton": ["Lofton", "Elijah"] },
        coverageTypes: ["game_footage", "player_highlights"],
      },
      ["2024"],
    );
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.some((q) => q.toLowerCase().includes("lofton"))).toBe(true);
  });

  it("generates no queries for entity-less beats", () => {
    const queries = generateQueries(
      { text: "And then.", entities: [], aliases: {}, coverageTypes: ["backup_broll"] },
      [],
    );
    expect(queries).toEqual([]);
  });
});

describe("analyzeScript (end-to-end, pure)", () => {
  it("produces ordered beats with entities, coverage, and queries", () => {
    const analysis = analyzeScript(LOFTON_SCRIPT);
    expect(analysis.beats.length).toBeGreaterThanOrEqual(4);
    expect(analysis.beats.map((b) => b.ord)).toEqual([...analysis.beats.keys()]);
    expect(analysis.primaryEntities).toContain("Elijah Lofton");
    const withQueries = analysis.beats.filter((b) => b.queries.length > 0);
    expect(withQueries.length).toBeGreaterThan(0);
    // every beat keeps its exact text from the script
    for (const b of analysis.beats) {
      expect(LOFTON_SCRIPT.replace(/\s+/g, " ")).toContain(b.text.slice(0, 20));
    }
  });

  it("warns on empty input and truncates huge scripts", () => {
    expect(analyzeScript("").warnings.length).toBeGreaterThan(0);
    const huge = Array.from({ length: 200 }, (_, i) => `Beat sentence number ${i} about Marcus Webb.`).join("\n\n");
    const analysis = analyzeScript(huge, { maxBeats: 60 });
    expect(analysis.beats.length).toBeLessThanOrEqual(60);
    expect(analysis.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
});
