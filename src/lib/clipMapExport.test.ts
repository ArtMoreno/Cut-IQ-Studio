/**
 * Clip map export tests — pure functions, no I/O.
 */
import { describe, expect, it } from "vitest";
import { clipMapCSV, clipMapJSON, clipMapMarkdown } from "./clipMapExport";

const project = {
  id: 1,
  name: "2026-08-07__JOB__Test-Topic",
  status: "ready_for_review",
  currentRevision: 2,
  sourceTitle: "Test Doc",
  sourceUrl: "https://docs.google.com/document/d/abc/edit",
  sourceDocId: "abc",
  sourceModifiedAt: "2026-08-07T12:00:00Z",
};

const beats = [
  { id: 10, ord: 0, text: "First beat text.", coverageTypes: '["game_footage"]', status: "covered" },
  { id: 11, ord: 1, text: "Second beat text.", coverageTypes: '["interview"]', status: "needs_footage" },
];

const candidates = [
  {
    id: 100,
    provider: "library",
    sourceUrl: "https://www.youtube.com/watch?v=AAAA",
    sourceAccount: "Example Channel",
    title: "Example interview",
    matchKind: "exact_transcript",
    transcriptExcerpt: "the exact quote line",
    segStart: 42.5,
    segEnd: 47.0,
    editIn: 39.5,
    editOut: 48.5,
    relevanceScore: 0.9,
    state: "approved",
    reason: "Transcript match",
    userNotes: "keep this",
    beatFk: 10,
  },
  {
    id: 101,
    provider: "instagram",
    sourceUrl: "https://www.instagram.com/explore/search/keyword/?q=test",
    sourceAccount: null,
    title: "Instagram search: test",
    matchKind: "manual_review",
    transcriptExcerpt: null,
    segStart: null,
    segEnd: null,
    editIn: null,
    editOut: null,
    relevanceScore: 0,
    state: "undecided",
    reason: "Open external",
    userNotes: null,
    beatFk: 11,
  },
];

describe("clip map exports", () => {
  it("JSON includes project, beats, and flat candidates", () => {
    const out = JSON.parse(clipMapJSON(project, beats, candidates));
    expect(out.project.name).toBe(project.name);
    expect(out.beats.length).toBe(2);
    expect(out.candidates.length).toBe(2);
    expect(out.candidates[0].beat).toBe(0); // sorted by beat order
    expect(out.candidates[0].editIn).toBe("0:39");
  });

  it("CSV has a header row and escapes quotes", () => {
    const lines = clipMapCSV(project, beats, candidates).split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("Beat");
    expect(lines[1]).toContain('"the exact quote line"');
  });

  it("Markdown groups candidates under their beats", () => {
    const md = clipMapMarkdown(project, beats, candidates);
    expect(md).toContain("# Clip Map — 2026-08-07__JOB__Test-Topic");
    expect(md.indexOf("Beat 1")).toBeLessThan(md.indexOf("Beat 2"));
    expect(md).toContain("@ 0:42");
    expect(md).toContain("revision 2");
  });
});
