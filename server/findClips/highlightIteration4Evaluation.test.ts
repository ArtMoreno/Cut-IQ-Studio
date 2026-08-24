import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const evaluation = JSON.parse(readFileSync(new URL("./baselines/lj-martin-iteration-4-evaluation.json", import.meta.url), "utf8"));

describe("Iteration 4 LJ Martin evaluation evidence", () => {
  it("locks the read-only corpus and safety state", () => {
    expect(evaluation.capture).toMatchObject({ jobId: 14, candidateCount: 507, readOnly: true, gateEnabled: false });
  });

  it("locks the deduplicated Highlights result", () => {
    expect(evaluation.after).toMatchObject({
      highlightsSelected: 10,
      highlightsDuplicateRejects: 10,
      knownDuplicatePairsSurviving: 0,
      wrongSeasonCandidatesEligible: 0,
      auditedPrecision: 1,
      auditedEventRecall: 1,
    });
    expect(evaluation.after.highlightsCandidateIds).toEqual([6129, 6139, 6183, 6278, 6283, 6301, 6393, 6491, 6240, 6196]);
  });

  it("records scope limitations instead of overstating generalization", () => {
    expect(evaluation.knownLimitations).toHaveLength(3);
    expect(evaluation.knownLimitations.join(" ")).toMatch(/running-back-first/);
  });
});
