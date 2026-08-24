import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readHighlightTunerGate } from "./highlightTunerGate";

type LjMartinBaseline = {
  capture: { readOnly: boolean; renderState: string };
  job: { id: number; player: string; team: string; clipLimit: number; candidatesFoundCounter: number };
  detail: { candidateRows: number; clipRows: number };
  candidateSnapshot: { sha256: string; exactTranscript: number; withEditRange: number };
  selection: { approvedCount: number; undecidedCount: number; approvedCandidateIds: number[] };
  outputs: { provisional: boolean };
};

const baseline = JSON.parse(
  readFileSync(new URL("./baselines/lj-martin-job-14.json", import.meta.url), "utf8"),
) as LjMartinBaseline;
const controls = JSON.parse(
  readFileSync(new URL("./baselines/control-jobs-11-13.json", import.meta.url), "utf8"),
) as { capture: { readOnly: boolean }; jobs: Array<{ id: number; candidateCounter: number; candidateRows: number; approvedReady: number }> };

describe("LJ Martin legacy selection baseline", () => {
  it("records a read-only snapshot while the final renders are explicitly provisional", () => {
    expect(baseline.capture.readOnly).toBe(true);
    expect(baseline.capture.renderState).toBe("provisional-active-job");
    expect(baseline.outputs.provisional).toBe(true);
  });

  it("locks the discovered candidate population independently from the selected export budget", () => {
    expect(baseline.job).toMatchObject({ id: 14, player: "LJ martin", team: "BYU", clipLimit: 100 });
    expect(baseline.detail.candidateRows).toBe(507);
    expect(baseline.job.candidatesFoundCounter).toBe(507);
    expect(baseline.candidateSnapshot.exactTranscript).toBe(507);
    expect(baseline.candidateSnapshot.withEditRange).toBe(507);
    expect(baseline.selection.approvedCount + baseline.selection.undecidedCount).toBe(507);
  });

  it("locks the exact legacy approved set without deleting unselected candidates", () => {
    expect(baseline.selection.approvedCandidateIds).toHaveLength(100);
    expect(new Set(baseline.selection.approvedCandidateIds).size).toBe(100);
    expect(baseline.selection.approvedCount).toBe(baseline.job.clipLimit);
    expect(baseline.selection.undecidedCount).toBe(407);
    expect(baseline.detail.clipRows).toBe(100);
    expect(baseline.candidateSnapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the future tuner disabled by default", () => {
    expect(readHighlightTunerGate({})).toEqual({ enabled: false, mode: "everything" });
  });

  it("keeps three completed control jobs for later before/after comparisons", () => {
    expect(controls.capture.readOnly).toBe(true);
    expect(controls.jobs.map((job) => job.id)).toEqual([13, 12, 11]);
    for (const job of controls.jobs) {
      expect(job.candidateRows).toBeGreaterThanOrEqual(job.candidateCounter);
      expect(job.approvedReady).toBeGreaterThan(0);
      expect(job.approvedReady).toBeLessThanOrEqual(job.candidateRows);
    }
  });
});
