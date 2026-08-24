import { describe, expect, it } from "vitest";
import {
  analyzeHighlightCandidate,
  customHighlightTunerSettings,
  defaultHighlightTunerSettings,
  estimatePlayYards,
  highlightGameKey,
  highlightTitleMatchesSeason,
  inferHighlightGameKey,
  playerAttributedTranscript,
  selectHighlights,
} from "./highlightSelector";

type Fixture = {
  id: number;
  title: string;
  transcriptExcerpt: string;
  sourceUrl?: string;
  dupGroupKey?: string;
  editIn?: number;
  editOut?: number;
  relevanceScore?: number;
  qualityScore?: number;
};

const fixture = (id: number, title: string, transcriptExcerpt: string): Fixture => ({ id, title, transcriptExcerpt });

describe("highlight selector", () => {
  it("exposes future-UI presets without an Everything mode", () => {
    expect(defaultHighlightTunerSettings("balanced")).toMatchObject({ mode: "balanced", maxClipsPerGame: 8 });
    expect(defaultHighlightTunerSettings("highlights")).toMatchObject({ mode: "highlights", maxClipsPerGame: 5 });
    expect(defaultHighlightTunerSettings("best_only")).toMatchObject({ mode: "best_only", maxClipsPerGame: 3 });
    expect(customHighlightTunerSettings({ maxClipsPerGame: 2, minimumEstimatedYards: 12 })).toMatchObject({
      mode: "custom",
      maxClipsPerGame: 2,
      minimumEstimatedYards: 12,
    });
  });

  it("classifies live plays separately from statistical and broadcast mentions", () => {
    expect(analyzeHighlightCandidate(fixture(1, "BYU vs Utah", "Martin takes the handoff and runs for 14 yards."), "LJ Martin").classification).toBe("actual_play");
    expect(analyzeHighlightCandidate(fixture(2, "BYU vs Utah", "Martin has averaged six yards per carry this season."), "LJ Martin").classification).toBe("incidental_mention");
    expect(analyzeHighlightCandidate(fixture(3, "BYU vs Utah", "Coming up, our player profile on LJ Martin."), "LJ Martin").classification).toBe("incidental_mention");
  });

  it("detects touchdown, key-down, red-zone, and excitement cues", () => {
    const signals = analyzeHighlightCandidate(fixture(
      1,
      "BYU vs Utah",
      "Third and goal inside the five. Martin takes the handoff, breaks free, and goes into the end zone!",
    ), "LJ Martin");
    expect(signals).toMatchObject({ classification: "actual_play", touchdown: true, keyDown: true, redZone: true });
    expect(signals.excitement).toBeGreaterThanOrEqual(15);
  });

  it("parses only explicit, conservative yardage phrases", () => {
    expect(estimatePlayYards("Martin with a 22-yard run down the sideline")).toBe(22);
    expect(estimatePlayYards("He picks up twelve yards on the carry")).toBe(12);
    expect(estimatePlayYards("From the 40 to the 20 with 12:04 left")).toBeNull();
    expect(estimatePlayYards("Martin has 112 yards this season")).toBeNull();
    expect(estimatePlayYards("44 yd gain on the play")).toBe(44);
    expect(estimatePlayYards("19yd pick up")).toBe(19);
  });

  it("parses adjacent player-local yd gains but not another player or a prior play", () => {
    expect(analyzeHighlightCandidate(fixture(1, "BYU vs Portland State", "The handoff goes to LJ Martin. 44 yd gain on the play."), "LJ Martin").estimatedYards).toBe(44);
    expect(analyzeHighlightCandidate(fixture(2, "BYU vs Colorado", "A first down by LJ Martin. 19yd pick up."), "LJ Martin").estimatedYards).toBe(19);
    expect(analyzeHighlightCandidate(fixture(3, "BYU vs ECU", "LJ Martin blocks. Carson Ryan sneaks out as the tight end for a 24 yd pick up."), "LJ Martin").estimatedYards).toBeNull();
    expect(analyzeHighlightCandidate(fixture(4, "BYU vs Cincinnati", "A gain of one after the Martin 13 yd run prior."), "LJ Martin").estimatedYards).toBeNull();
  });

  it("always includes live touchdowns while rejecting historical touchdown mentions", () => {
    const result = selectHighlights([
      fixture(1, "BYU vs Utah", "Martin takes the handoff into the end zone for a touchdown."),
      fixture(2, "BYU vs Utah", "Martin scored a touchdown last week and has 300 yards this season."),
      fixture(3, "BYU vs Utah", "Martin runs it in for a touchdown."),
      fixture(4, "BYU vs Utah", "Martin scores! Touchdown BYU!"),
      fixture(5, "BYU vs Utah", "Martin punches it in!"),
    ], "BYU", customHighlightTunerSettings({ minimumEstimatedYards: 99, minimumExcitement: 99 }), { player: "LJ Martin" });
    expect(result.selected.map((item) => [item.candidate.id, item.reason])).toEqual([
      [4, "always_include_touchdown"],
      [5, "always_include_touchdown"],
      [1, "always_include_touchdown"],
      [3, "always_include_touchdown"],
    ]);
    expect(result.unselected.map((item) => [item.candidate.id, item.reason])).toEqual([[2, "incidental_mention"]]);
  });

  it("attributes action locally instead of awarding another player's touchdown", () => {
    const otherPlayer = analyzeHighlightCandidate(fixture(
      1,
      "BYU vs Utah",
      "LJ Martin blocks as Chase Roberts scores a touchdown for BYU!",
    ), "LJ Martin");
    const quarterbackKeep = analyzeHighlightCandidate(fixture(
      2,
      "BYU vs Utah",
      "Fake to Martin, Retzlaff keeps it and runs it in for a touchdown.",
    ), "LJ Martin");
    const hypothetical = analyzeHighlightCandidate(fixture(
      3,
      "BYU vs Utah",
      "That block by Martin would be the key if BYU scored a touchdown.",
    ), "LJ Martin");
    expect(otherPlayer.touchdown).toBe(false);
    expect(quarterbackKeep.touchdown).toBe(false);
    expect(hypothetical.touchdown).toBe(false);
    expect(playerAttributedTranscript("Martin takes the handoff and runs it in.", "LJ Martin")).toContain("runs it in");
  });

  it("recognizes target-bound adjacent and touchdown-before calls", () => {
    const calls = [
      "Instead, it's Martin. It's a touchdown. LJ Martin knows he had to get there.",
      "Flag thrown. Touchdown. There was a penalty flag on the play. Martin just strolled into the end.",
      "Offside and a touchdown for Martin to make it 36-13.",
    ];
    for (const transcript of calls) {
      expect(analyzeHighlightCandidate(fixture(1, "BYU vs TCU", transcript), "LJ Martin")).toMatchObject({
        classification: "actual_play",
        touchdown: true,
      });
    }
  });

  it("handles alternate actors, lowercase ASR, and later target mentions", () => {
    const falseAttributions = [
      "Martin blocks for Chase Roberts who scores a touchdown.",
      "Chase Roberts scores a touchdown behind a block by Martin.",
      "Martin blocks as chase roberts scores a touchdown.",
    ];
    for (const transcript of falseAttributions) {
      expect(analyzeHighlightCandidate(fixture(1, "BYU vs Utah", transcript), "LJ Martin").touchdown).toBe(false);
    }
    const laterTarget = analyzeHighlightCandidate(fixture(
      2,
      "BYU vs Utah",
      "Martin takes the handoff for 3 yards. Two plays later Martin scores after a 25-yard run! Touchdown BYU!",
    ), "LJ Martin");
    expect(laterTarget).toMatchObject({ classification: "actual_play", touchdown: true, estimatedYards: 25 });
  });

  it("caps ranked non-mandatory clips per inferred game but keeps other games", () => {
    const result = selectHighlights([
      fixture(1, "BYU vs Utah full game", "Martin takes the handoff and runs for 20 yards."),
      fixture(2, "BYU vs Utah highlights", "Martin gets the carry and runs for 15 yards."),
      fixture(3, "BYU vs Arizona full game", "Martin takes the handoff and runs for 18 yards."),
    ], "BYU", customHighlightTunerSettings({ maxClipsPerGame: 1, minimumEstimatedYards: 10 }));
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1, 3]);
    expect(result.unselected).toContainEqual(expect.objectContaining({ candidate: expect.objectContaining({ id: 2 }), reason: "per_game_limit" }));
  });

  it("supports the canonical engine game-key callback at the integration seam", () => {
    const candidates = [
      fixture(1, "Broadcast A", "Martin takes the handoff and runs for 20 yards."),
      fixture(2, "Broadcast B", "Martin gets the carry and runs for 18 yards."),
    ];
    const calls: number[] = [];
    const result = selectHighlights(
      candidates,
      "BYU",
      customHighlightTunerSettings({ maxClipsPerGame: 1 }),
      { getGameKey: (candidate) => { calls.push(candidate.id); return "canonical-utah"; } },
    );
    expect(calls).toEqual([1, 2]);
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1]);
    expect(result.unselected[0]).toMatchObject({ gameKey: "canonical-utah", reason: "per_game_limit" });
  });

  it("preserves job-out-of-scope candidates with an explicit reason", () => {
    const candidates = [
      fixture(1, "BYU vs Utah 2025", "Martin takes the handoff and runs for 20 yards."),
      fixture(2, "BYU vs Utah 2024", "Martin takes the handoff and runs for 25 yards."),
    ];
    const result = selectHighlights(candidates, "BYU", defaultHighlightTunerSettings("highlights"), {
      player: "LJ Martin",
      isCandidateEligible: (candidate) => candidate.title.endsWith("2025"),
    });
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1]);
    expect(result.unselected).toContainEqual(expect.objectContaining({
      candidate: expect.objectContaining({ id: 2 }),
      reason: "outside_job_scope",
    }));
  });

  it("keeps the isolated fallback aligned for noisy sponsored game titles", () => {
    expect(inferHighlightGameKey("BYU vs Utah Pop-Tarts Full Game Replay 2025", "BYU")).toBe("utah");
  });

  it("normalizes tuner game keys while separating championship rematches", () => {
    const arizona = [
      "#18 BYU @ Arizona, Condensed Full Game - Week 7, 2025",
      "BYU Cougars vs. Arizona Wildcats | 2025 Full Game",
    ].map((title) => highlightGameKey(title, "BYU"));
    const championship = [
      "#4 Texas Tech vs #11 BYU 2025 Big XII Championship | Full Game 1080p60fps",
      "2025 Big 12 Championship Full Game | BYU vs Texas Tech | 12-06-2025",
    ].map((title) => highlightGameKey(title, "BYU"));
    const regular = highlightGameKey("BYU vs. Texas Tech Full Game Replay (11.8.25) | 2025 Big 12 Football", "BYU");
    expect(new Set(arizona).size).toBe(1);
    expect(new Set(championship).size).toBe(1);
    expect(regular).not.toBe(championship[0]);
    expect(highlightGameKey("BYU vs Cincinnati November 2025 Full Game", "BYU")).toBe("cincinnati:regular");
    expect(highlightGameKey("Iowa State October Full Game vs BYU 2025", "BYU")).toBe("iowa state:regular");
  });

  it("reads four-digit and compact broadcast-date seasons", () => {
    expect(highlightTitleMatchesSeason("Kansas State vs. BYU (9.21.24) Full Game Replay | Big 12 Football", 2025)).toBe(false);
    expect(highlightTitleMatchesSeason("BYU 2025 archive: Kansas State at BYU (9.21.24)", 2025)).toBe(false);
    expect(highlightTitleMatchesSeason("BYU vs TCU 2025 Full Game", 2025)).toBe(true);
    expect(highlightTitleMatchesSeason("BYU football full game", 2025)).toBe(true);
  });

  it("suppresses metadata-backed duplicates before mandatory touchdowns while preserving reasons", () => {
    const repeated = "LJ Martin takes the handoff, breaks outside past two defenders, races down the sideline, and scores a touchdown for BYU.";
    const candidates: Fixture[] = [
      { ...fixture(1, "BYU vs Cincinnati 2025", repeated), sourceUrl: "https://video/one", dupGroupKey: "play-one", editIn: 100, editOut: 145 },
      { ...fixture(2, "BYU vs Cincinnati 2025", repeated), sourceUrl: "https://video/one", dupGroupKey: "soundbite-two", editIn: 105, editOut: 150 },
      { ...fixture(3, "Cincinnati vs BYU 2025", `${repeated} The blocking scheme created a clean lane and sealed the edge.`), sourceUrl: "https://video/two", editIn: 900, editOut: 945 },
      { ...fixture(4, "BYU vs Arizona 2025", repeated), sourceUrl: "https://video/three", editIn: 100, editOut: 145 },
    ];
    const result = selectHighlights(candidates, "BYU", customHighlightTunerSettings({ maxClipsPerGame: 1 }), {
      player: "LJ Martin",
      getGameKey: (candidate, team) => highlightGameKey(candidate.title, team),
    });
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1, 4]);
    expect(result.unselected.filter((item) => item.reason === "duplicate_play").map((item) => item.candidate.id)).toEqual([2, 3]);
    expect(result.selected.length + result.unselected.length).toBe(candidates.length);
  });

  it("does not treat a whole-video yt dupGroupKey as a single play", () => {
    const candidates: Fixture[] = [
      { ...fixture(1, "BYU vs Utah 2025", "Martin takes the handoff and runs for 20 yards."), sourceUrl: "https://video/one", dupGroupKey: "yt:abc", editIn: 100, editOut: 130 },
      { ...fixture(2, "BYU vs Utah 2025", "Martin takes the handoff and runs for 18 yards."), sourceUrl: "https://video/one", dupGroupKey: "yt:abc", editIn: 500, editOut: 530 },
    ];
    const result = selectHighlights(candidates, "BYU", customHighlightTunerSettings({ maxClipsPerGame: 5, minimumEstimatedYards: 10 }), { player: "LJ Martin" });
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1, 2]);
    expect(result.unselected).toHaveLength(0);
  });

  it("does not collapse distinct adjacent plays merely because padded ranges overlap", () => {
    const candidates: Fixture[] = [
      { ...fixture(1, "BYU vs Utah 2025", "Martin takes the handoff and runs for 20 yards down the left sideline."), sourceUrl: "https://video/one", editIn: 100, editOut: 135 },
      { ...fixture(2, "BYU vs Utah 2025", "Martin catches a pass and gains 18 yards through the middle of the defense."), sourceUrl: "https://video/one", editIn: 113, editOut: 148 },
    ];
    const result = selectHighlights(candidates, "BYU", customHighlightTunerSettings({ maxClipsPerGame: 5, minimumEstimatedYards: 10 }), { player: "LJ Martin" });
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1, 2]);
    expect(result.unselected).toHaveLength(0);
  });

  it("collapses same-source touchdown replay windows within one minute", () => {
    const candidates: Fixture[] = [
      { ...fixture(1, "TCU vs BYU 2025", "It's Martin. It's a touchdown for BYU."), sourceUrl: "https://video/one", editIn: 100, editOut: 142 },
      { ...fixture(2, "TCU vs BYU 2025", "Touchdown for Martin after the replay confirms the score."), sourceUrl: "https://video/one", editIn: 133, editOut: 176 },
    ];
    const result = selectHighlights(candidates, "BYU", defaultHighlightTunerSettings("highlights"), { player: "LJ Martin" });
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1]);
    expect(result.unselected).toContainEqual(expect.objectContaining({ candidate: expect.objectContaining({ id: 2 }), reason: "duplicate_play" }));
  });

  it("keeps distinct same-source touchdowns whose ranges do not overlap", () => {
    const candidates: Fixture[] = [
      { ...fixture(1, "BYU highlights 2025", "Martin takes the handoff and scores a touchdown."), sourceUrl: "https://video/one", editIn: 100, editOut: 120 },
      { ...fixture(2, "BYU highlights 2025", "Touchdown for Martin on another drive."), sourceUrl: "https://video/one", editIn: 135, editOut: 155 },
    ];
    const result = selectHighlights(candidates, "BYU", defaultHighlightTunerSettings("highlights"), { player: "LJ Martin" });
    expect(result.selected.map((item) => item.candidate.id)).toEqual([1, 2]);
    expect(result.unselected).toHaveLength(0);
  });

  it("lets mandatory touchdowns exceed a game's cap", () => {
    const result = selectHighlights([
      fixture(1, "BYU vs Utah", "Martin takes the handoff for a touchdown."),
      fixture(2, "BYU vs Utah", "Martin gets the carry and goes into the end zone for a touchdown."),
    ], "BYU", customHighlightTunerSettings({ maxClipsPerGame: 1 }));
    expect(result.selected).toHaveLength(2);
    expect(result.selected.every((item) => item.reason === "always_include_touchdown")).toBe(true);
  });

  it("is deterministic, stable on score ties, and non-destructive", () => {
    const candidates = Object.freeze([
      Object.freeze(fixture(1, "BYU vs Utah", "Martin takes the handoff and runs for 12 yards.")),
      Object.freeze(fixture(2, "BYU vs Arizona", "Martin takes the handoff and runs for 12 yards.")),
    ]);
    const before = JSON.stringify(candidates);
    const first = selectHighlights(candidates, "BYU", defaultHighlightTunerSettings("balanced"));
    const second = selectHighlights(candidates, "BYU", defaultHighlightTunerSettings("balanced"));
    expect(first.selected.map((item) => item.candidate.id)).toEqual([1, 2]);
    expect(second.selected.map((item) => item.candidate.id)).toEqual([1, 2]);
    expect(first.selected[0]!.candidate).toBe(candidates[0]);
    expect(JSON.stringify(candidates)).toBe(before);
  });

  it("preserves every rejected candidate with a reason", () => {
    const candidates = [
      fixture(1, "BYU vs Utah", "Martin takes the handoff and gains 11 yards."),
      fixture(2, "BYU vs Utah", "Martin is averaging five yards per carry this year."),
      fixture(3, "BYU vs Utah", "Martin with the carry."),
    ];
    const result = selectHighlights(candidates, "BYU", defaultHighlightTunerSettings("highlights"));
    expect(result.selected.length + result.unselected.length).toBe(candidates.length);
    expect(result.unselected.map((item) => item.reason)).toEqual(expect.arrayContaining(["incidental_mention", "probable_play_disabled"]));
  });
});
