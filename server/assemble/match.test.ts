import { describe, it, expect } from "vitest";
import { detectConcepts, detectGames, tokenOverlap, normalizeText } from "./lexicon";
import { scoreClipForBeat } from "./match";
import { autoAssemble } from "./assemble";
import type { AssembleBeat } from "./project";
import type { ManifestClip } from "./manifest";

function beat(over: Partial<AssembleBeat> = {}): AssembleBeat {
  return {
    id: "beat-0",
    ord: 0,
    text: "",
    intent: [],
    entities: [],
    queries: [],
    beatType: "footage",
    narrationStart: 0,
    narrationEnd: 6,
    locked: false,
    unresolved: false,
    ...over,
  };
}

function clip(over: Partial<ManifestClip> = {}): ManifestClip {
  return {
    clipId: "csc-1",
    candidateId: 0,
    beatOrd: 0,
    beatText: "",
    game: "Louisville",
    opponent: "Louisville",
    sourceUrl: "https://www.youtube.com/watch?v=pH-45Dz3tzg",
    sourceVideoId: "pH-45Dz3tzg",
    localPath: "D:\\Clips\\c.mp4",
    downloadUrl: "/api/clips/c.mp4",
    drivePath: null,
    sourceStartSeconds: 14.2,
    sourceEndSeconds: 22.1,
    clipDurationSeconds: 7.9,
    resolution: { width: 1920, height: 1080 },
    container: "mp4",
    codec: null,
    playerMention: { text: "he breaks the first tackle and turns a short throw into an explosive gain", timeSeconds: 18.4 },
    queryContext: ["broken tackle", "yards after catch"],
    coverageTypes: [],
    purpose: null,
    transcript: { text: "breaks the first tackle and turns a short throw into an explosive gain", segmentStart: null, segmentEnd: null },
    tags: [],
    verification: { playerVerified: true, contextVerified: true, confidence: 0.96, matchKind: "manual_review", reason: "player verified" },
    ...over,
  };
}

describe("lexicon", () => {
  it("detects football concepts", () => {
    const concepts = detectConcepts("he broke the first tackle and turned a short throw into an explosive gain");
    expect(concepts).toContain("broken_tackle");
    expect(concepts).toContain("yac");
    expect(concepts).toContain("explosive");
  });

  it("detects game references", () => {
    expect(detectGames("Against Louisville, he broke the first tackle")).toContain("Louisville");
    expect(detectGames("late against Clemson in the playoff")).toContain("Clemson");
  });

  it("computes token overlap", () => {
    expect(tokenOverlap("broken tackle", "he breaks the first tackle")).toBeGreaterThan(0);
    expect(tokenOverlap("broken tackle", "unrelated passing play")).toBe(0);
  });

  it("normalizes text", () => {
    expect(normalizeText("  Breaking  the   TACKLE!! ")).toBe("breaking the tackle");
  });
});

describe("scoreClipForBeat — §49 no-false-visual gate", () => {
  it("hard-blocks a beat that names a different game", () => {
    const b = beat({ text: "Against Florida, he broke the first tackle." });
    const r = scoreClipForBeat(b, clip({ game: "Louisville", opponent: "Louisville" }));
    expect(r.hardBlocked).toBe(true);
    expect(r.blockReason).toContain("Florida");
    expect(r.confidence).toBe("unresolved");
  });

  it("high-scores a matching game + concept + transcript", () => {
    const b = beat({ text: "Against Louisville, he broke the first tackle and turned a short throw into an explosive gain." });
    const r = scoreClipForBeat(b, clip({ game: "Louisville" }));
    expect(r.hardBlocked).toBe(false);
    expect(r.components.game).toBe(1);
    expect(r.components.concept).toBeGreaterThan(0);
    expect(r.reasons).toContain("matching game");
    expect(r.score).toBeGreaterThan(0.4);
  });

  it("penalizes an already-used clip", () => {
    const b = beat({ text: "Against Louisville, he broke the first tackle." });
    const r = scoreClipForBeat(b, clip(), { usedClipIds: new Set(["csc-1"]) });
    expect(r.components.duplicatePenalty).toBe(-1);
  });
});

describe("autoAssemble — §45 real-clip honesty", () => {
  const louBeat = beat({ id: "beat-2", ord: 2, text: "Against Louisville, he turned a short completion into an explosive gain.", narrationStart: 8, narrationEnd: 14 });
  const louClip = clip({ clipId: "csc-lou", game: "Louisville" });
  const ndClip = clip({ clipId: "csc-nd", game: "Notre Dame", sourceStartSeconds: 30, sourceEndSeconds: 38 });

  it("places a matching Louisville clip on the beat that names Louisville, using the action window", () => {
    const result = autoAssemble([louBeat], [louClip, ndClip]);
    const placed = result.items.filter((i) => !i.unresolved);
    expect(placed.length).toBe(1);
    const louItem = placed.find((i) => i.beatId === "beat-2");
    expect(louItem).toBeDefined();
    expect(louItem!.clipId).toBe("csc-lou");
    expect(louItem!.sourceIn).toBe(14.2); // uses the action window, not clip start
  });

  it("hard-blocks the wrong game even when other clips are available", () => {
    // Beat names Louisville; only a Notre Dame clip exists → honest placeholder.
    const nd = clip({ clipId: "csc-nd", game: "Notre Dame", opponent: "Notre Dame", transcript: { text: "Notre Dame defense", segmentStart: null, segmentEnd: null }, sourceStartSeconds: 30, sourceEndSeconds: 38 });
    const result = autoAssemble([louBeat], [nd]);
    expect(result.items.length).toBe(1);
    expect(result.items[0].unresolved).toBe(true);
    expect(result.unresolvedBeatIds).toContain("beat-2");
  });

  it("accepts a clip whose provenance names the team even when the opponent field does not (Miami bug)", () => {
    // Real CSC shape: game/opponent hold the OPPONENT, the player's own team
    // (Miami) appears only in the source title inside transcript text.
    const miamiBeat = beat({ id: "b-mia", ord: 0, text: "Last year Miami handed him the burden of moving the offense.", narrationStart: 0, narrationEnd: 6 });
    const ndVsMiami = clip({
      clipId: "csc-nd-vs-mia",
      game: "Notre Dame",
      opponent: "Notre Dame",
      transcript: { text: "01 nd td toney — Notre Dame vs Miami", segmentStart: null, segmentEnd: null },
    });
    const r = scoreClipForBeat(miamiBeat, ndVsMiami);
    expect(r.hardBlocked).toBe(false);
  });

  it("never reuses the same clip across beats", () => {
    const clips = [clip({ clipId: "only", game: null, opponent: null, sourceStartSeconds: 0, sourceEndSeconds: 8, clipDurationSeconds: 8 })];
    const b1 = beat({ id: "b1", ord: 0, text: "He broke the first tackle and turned a short throw into an explosive gain.", narrationStart: 0, narrationEnd: 4 });
    const b2 = beat({ id: "b2", ord: 1, text: "The first defender rarely ended the play.", narrationStart: 4, narrationEnd: 8 });
    const result = autoAssemble([b1, b2], clips);
    const placed = result.items.filter((i) => !i.unresolved);
    const usedIds = placed.map((i) => i.clipId);
    expect(new Set(usedIds).size).toBe(usedIds.length);
  });
});
