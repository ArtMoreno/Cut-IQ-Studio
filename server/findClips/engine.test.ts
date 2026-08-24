import { describe, expect, it } from "vitest";
import {
  balancedPlayerPlayOrder,
  BROADCAST_IDENTITY_ANCHOR,
  broadcastSoundbiteCandidateIsCanonical,
  broadcastSoundbiteScore,
  buildFindJobSearchQueries,
  diversifySourcesByGame,
  findJobCandidateIsGrounded,
  parseFindJobGames,
  playerActionScore,
  playerCandidateIsReviewable,
  playerIdentityEvidence,
  playerHighlightCandidateIsCanonical,
  rankSourceMetadata,
  selectBroadcastSoundbiteWindows,
  sourceGameKey,
  teamAliases,
  uniqueCanonicalPlayerHighlightCandidates,
  uniqueCanonicalBroadcastSoundbiteCandidates,
  uniqueReviewablePlayerCandidates,
} from "./engine";
import { curatedSourcesForFindJob } from "./curatedSources";

describe("Find Clips curated source portfolios", () => {
  it("adds the supplied Miami 2025 portfolio, including the local Texas A&M archive when present", () => {
    const sources = curatedSourcesForFindJob({ team: "Miami Hurricanes", season: 2025 });
    expect(sources.length).toBeGreaterThanOrEqual(20);
    expect(new Set(sources.map((source) => source.videoId)).size).toBe(sources.length);
    expect(sources.filter((source) => source.kind === "full_game").length).toBeGreaterThanOrEqual(15);
    expect(sources.find((source) => source.opponent === "Notre Dame")?.videoId).toBe("pH-45Dz3tzg");
    expect(sources.some((source) => source.opponent === "Indiana" && source.kind === "full_game")).toBe(true);
    const localTexasAm = sources.find((source) => source.videoId === "local-miami-tamu-2025-full");
    if (localTexasAm) {
      expect(localTexasAm.sourceType).toBe("local");
      expect(localTexasAm.url).toMatch(/^file:/);
    }
  });

  it("filters the portfolio to explicitly requested games", () => {
    const sources = curatedSourcesForFindJob({
      team: "University of Miami",
      season: 2025,
      games: ["FSU", "Pitt"],
    });
    expect(sources.map((source) => source.opponent)).toEqual(["Florida State", "Pittsburgh"]);
  });

  it("does not leak Miami sources into another team or season", () => {
    expect(curatedSourcesForFindJob({ team: "Miami Ohio", season: 2025 })).toEqual([]);
    expect(curatedSourcesForFindJob({ team: "Miami Hurricanes", season: 2024 })).toEqual([]);
    expect(curatedSourcesForFindJob({ team: "BYU", season: 2025 })).toEqual([]);
  });
});

describe("Find Clips source ranking", () => {
  it("prefers official football highlights that match the subject and team", () => {
    const official = rankSourceMetadata({
      title: "Evan Johnson pick six | BYU Football Official Highlights 2025",
      channel: "BYU Cougars",
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      opponent: "East Carolina",
    });
    const reaction = rankSourceMetadata({
      title: "Podcast reaction and prediction show",
      channel: "Fan Talk",
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      opponent: "East Carolina",
    });
    expect(official).toBeGreaterThan(reaction);
    expect(official).toBeGreaterThanOrEqual(0.7);
  });

  it("rewards opponent-specific game sources", () => {
    const specific = rankSourceMetadata({
      title: "BYU vs East Carolina condensed game",
      channel: "College Football",
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      opponent: "East Carolina",
    });
    const generic = rankSourceMetadata({
      title: "BYU season preview",
      channel: "Sports Talk",
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      opponent: "East Carolina",
    });
    expect(specific).toBeGreaterThan(generic);
  });

  it("recognizes any game in a multi-game job", () => {
    const specific = rankSourceMetadata({
      title: "BYU vs Utah 2025 full game",
      channel: "College Football",
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      opponent: "East Carolina\nUtah\nTCU",
    });
    const unrelated = rankSourceMetadata({
      title: "Colorado vs Arizona 2025 full game",
      channel: "College Football",
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      opponent: "East Carolina\nUtah\nTCU",
    });
    expect(specific).toBeGreaterThan(unrelated);
  });

  it("penalizes highlight reels from the wrong season", () => {
    const current = rankSourceMetadata({ title: "Evan Johnson 2025 BYU highlights", channel: "Football Film", player: "Evan Johnson", team: "BYU", season: 2025 });
    const stale = rankSourceMetadata({ title: "Evan Johnson 2016 highlights", channel: "Recruit Film", player: "Evan Johnson", team: "BYU", season: 2025 });
    expect(current).toBeGreaterThan(stale);
    expect(stale).toBeLessThan(0.42);
  });

  it("accepts school-name aliases used by official broadcasts without accepting Miami Ohio", () => {
    expect(teamAliases("Miami Hurricanes")).toContain("miami");
    const job = { player: "Ethan Oconnor", team: "Miami Hurricanes", season: 2025, opponent: null };
    expect(findJobCandidateIsGrounded(job, {
      provider: "library",
      title: "Miami vs SMU Full Game Replay | 2025 ACC Football",
      sourceAccount: "ACC Digital Network",
    })).toBe(true);
    expect(findJobCandidateIsGrounded(job, {
      provider: "library",
      title: "Miami Ohio vs Buffalo Full Game | 2025 Football",
      sourceAccount: "College Sports",
    })).toBe(false);
  });
});

describe("Find Clips season and game search plan", () => {
  it("normalizes a pasted opponent list without duplicates", () => {
    expect(parseFindJobGames("Utah\nTCU, East Carolina; Utah")).toEqual(["Utah", "TCU", "East Carolina"]);
  });

  it("defaults to player-season and full-season team searches", () => {
    expect(buildFindJobSearchQueries({ player: "Evan Johnson", team: "BYU", season: 2025 })).toEqual(
      expect.arrayContaining([
        "Evan Johnson BYU 2025 highlights",
        "BYU 2025 football full game",
      ]),
    );
  });

  it("rotates explicitly supplied games across script beats", () => {
    const games = "Utah\nTCU\nEast Carolina\nColorado";
    const first = buildFindJobSearchQueries({ player: "Evan Johnson", team: "BYU", season: 2025, games, beatOrd: 0 });
    const second = buildFindJobSearchQueries({ player: "Evan Johnson", team: "BYU", season: 2025, games, beatOrd: 1 });
    expect(first[0]).toContain("Utah");
    expect(first[1]).toBe("BYU TCU 2025 full game");
    expect(second[0]).toContain("East Carolina");
    expect(second[1]).toBe("BYU Colorado 2025 full game");
  });

  it("keeps football actions in the YouTube query", () => {
    const queries = buildFindJobSearchQueries({
      player: "Evan Johnson",
      team: "BYU",
      season: 2025,
      beatText: "He returned an interception for a touchdown.",
    });
    expect(queries[0]).toContain("interception");
  });
});

describe("Find Clips project candidate ownership", () => {
  const job = { player: "Bear Bachmeier", team: "BYU", season: 2025, opponent: "Utah\nTCU\nArizona" };

  it("hides unrelated clips inherited from the shared transcript library", () => {
    expect(findJobCandidateIsGrounded(job, {
      provider: "library",
      title: "Miami vs Florida State Full Game Replay | 2025 ACC Football",
      sourceAccount: "ACC Digital Network",
    })).toBe(false);
  });

  it("keeps current-team and requested-game footage", () => {
    expect(findJobCandidateIsGrounded(job, {
      provider: "youtube",
      title: "Utah vs. BYU Full Game Replay | 2025 Big 12 Football",
      sourceAccount: "Big 12 Studios",
    })).toBe(true);
  });

  it("does not remove job-grounded external discovery links", () => {
    expect(findJobCandidateIsGrounded(job, {
      provider: "instagram",
      title: "Instagram search: Bear Bachmeier BYU highlights",
      sourceAccount: null,
    })).toBe(true);
  });
});

describe("Find Clips player-action harvesting", () => {
  it("scores an on-field play and caption garbles but rejects a biographical name mention", () => {
    expect(playerActionScore(
      "Bear Bachmeier keeps it on the zone read, breaks a tackle and scores a touchdown for BYU.",
      "Bear Bachmeier",
    )).toBeGreaterThanOrEqual(9);
    expect(playerActionScore(
      "Bear Bachmeier is the freshman starter and has had an impressive season.",
      "Bear Bachmeier",
    )).toBe(0);
    expect(playerActionScore(
      "Bear Bachmire rolls out and throws complete for a first down.",
      "Bear Bachmeier",
    )).toBeGreaterThanOrEqual(8);
  });

  it("rejects negative plays, previews and a sibling's play from the canonical package", () => {
    const reason = "Player-action play sequence (signal 10.0): play-by-play action language appears next to Bear Bachmeier.";
    expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt: "Bachmire throws deep and it is incomplete. He had a touchdown but the receiver dropped it." }, "Bear Bachmeier")).toBe(false);
    expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt: "Tiger Bachmire, the brother on the return, is taken down inside the 10." }, "Bear Bachmeier")).toBe(false);
    expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt: "Bear Bachmire could not be stopped. Seven games this year with a passing touchdown and a rushing touchdown, tied for the most of any quarterback." }, "Bear Bachmeier")).toBe(false);
    expect(playerActionScore("Bachmire scrambles through traffic for 18 yards and a first down.", "Bear Bachmeier")).toBeGreaterThanOrEqual(7);
    expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt: "Bachmire scrambles through traffic for 18 yards and a first down." }, "Bear Bachmeier")).toBe(false);
    expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt: "Bear Bachmire scrambles through traffic for 18 yards and a first down." }, "Bear Bachmeier")).toBe(true);
  });

  it("does not confuse ordinary broadcast words or other Miami players with Xavier Lucas", () => {
    const reason = "Player-action play sequence (signal 10.0): play-by-play action language appears next to Xavier Lucas.";
    const falseMatches = [
      "Tony off and running. Malachi Toney does not lose foot races. Fourth down. Touchdown as the Canes strike the lead from 40.",
      "Mark Fletcher had 86 yards in the last game and now has another touchdown on the run.",
      "Kiwan Lacy takes it down the long sideline and reaches up to make the catch.",
      "CJ Carr throws a perfect touchdown and puts pressure on the young quarterback.",
      "The tight end Luca Gilbert makes the reception and is stopped just shy of the touchdown.",
    ];
    for (const transcriptExcerpt of falseMatches) {
      expect(playerActionScore(transcriptExcerpt, "Xavier Lucas")).toBe(0);
      expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt }, "Xavier Lucas")).toBe(false);
    }
  });

  it("recognizes defensive-back plays only when Lucas is actually named", () => {
    const reason = "Player-action play sequence (signal 10.0): play-by-play action language appears next to Xavier Lucas.";
    const surnameOnly = {
      reason,
      transcriptExcerpt: "Lucas closes from the boundary and breaks up the pass on third down.",
    };
    expect(playerActionScore(surnameOnly.transcriptExcerpt, "Xavier Lucas")).toBeGreaterThanOrEqual(7);
    expect(playerHighlightCandidateIsCanonical(surnameOnly, "Xavier Lucas")).toBe(false);
    expect(playerHighlightCandidateIsCanonical({
      ...surnameOnly,
      reason: `${reason} ${BROADCAST_IDENTITY_ANCHOR}.`,
    }, "Xavier Lucas")).toBe(true);
    expect(playerHighlightCandidateIsCanonical({
      reason,
      transcriptExcerpt: "Xavier Lukas steps in front of the receiver and intercepts the pass for Miami.",
    }, "Xavier Lucas")).toBe(true);
  });

  it("uses deterministic full-name identity and rejects other people named Lucas", () => {
    expect(playerIdentityEvidence("Xavier Lucas made the tackle.", "Xavier Lucas")).toBe("target");
    expect(playerIdentityEvidence("Lucas closes in coverage.", "Xavier Lucas")).toBe("uncertain");
    expect(playerIdentityEvidence("Jaylen Lucas takes the handoff.", "Xavier Lucas")).toBe("other");
    expect(playerIdentityEvidence("Lucas Carneiro kicks the field goal.", "Xavier Lucas")).toBe("other");
    expect(playerActionScore("Jaylen Lucas takes the handoff and runs for a first down.", "Xavier Lucas")).toBe(0);
    expect(playerHighlightCandidateIsCanonical({
      reason: `Player-action play sequence. ${BROADCAST_IDENTITY_ANCHOR}.`,
      transcriptExcerpt: "Jaylen Lucas takes the handoff and runs for a first down.",
    }, "Xavier Lucas")).toBe(false);
  });

  it("packages reviewable surname-only plays without admitting explicit identity conflicts", () => {
    const playReason = "Player-action play sequence (signal 8.0): play-by-play action language appears next to OJ Frederique.";
    const candidates = [
      { id: 1, reason: playReason, transcriptExcerpt: "Frederique closes quickly and makes the tackle after a short gain." },
      { id: 2, reason: playReason, transcriptExcerpt: "Jaylen Lucas takes the handoff and runs for a first down." },
      { id: 3, reason: playReason, transcriptExcerpt: "Lucas Carneiro kicks the field goal through the uprights." },
      { id: 4, reason: playReason, transcriptExcerpt: "Miami scores a touchdown on the opening drive." },
    ];
    expect(playerCandidateIsReviewable(candidates[0]!, "OJ Frederique")).toBe(true);
    expect(playerCandidateIsReviewable(candidates[1]!, "Xavier Lucas")).toBe(false);
    expect(playerCandidateIsReviewable(candidates[2]!, "Xavier Lucas")).toBe(false);
    expect(playerCandidateIsReviewable(candidates[3]!, "OJ Frederique")).toBe(false);
    expect(uniqueReviewablePlayerCandidates(candidates, "OJ Frederique").map((candidate) => candidate.id)).toEqual([1]);
  });

  it("packages player-grounded broadcast commentary as video sound bites", () => {
    const soundbite = {
      reason: "Broadcast sound bite (signal 12.0): broadcast profile commentary.",
      transcriptExcerpt: "We talked to the coaches about OJ Frederique, and they praised his preparation, confidence and leadership in the secondary.",
    };
    expect(playerCandidateIsReviewable(soundbite, "OJ Frederique")).toBe(true);
  });

  it("keeps real defensive actions even when replay commentary mentions biography", () => {
    expect(playerActionScore(
      "The home run ball is broken up by OJ Frederique, the sophomore who had an excellent freshman season.",
      "OJ Frederique",
    )).toBeGreaterThanOrEqual(7);
    expect(playerActionScore(
      "The receiver was tackled by OJ Frederique after the catch.",
      "OJ Frederique",
    )).toBeGreaterThanOrEqual(7);
    expect(playerActionScore(
      "Almost picked off by OJ Frederique on the diving attempt.",
      "OJ Frederique",
    )).toBeGreaterThanOrEqual(7);
  });

  it("recognizes apostrophe, spacing and caption variants for O'Connor", () => {
    const positivePlays = [
      "The halfback pass was read beautifully by Ethan O' Conor for Miami.",
      "The route wasn't there because Ethan O Connor had him tied up, forcing the punt.",
      "The runner was pushed out of bounds by Ethan O'Connor after a four yard gain.",
      "The pass was incomplete and Ethan Oconnor helped in the coverage.",
    ];
    for (const transcriptExcerpt of positivePlays) {
      expect(playerActionScore(transcriptExcerpt, "Ethan Oconnor")).toBeGreaterThanOrEqual(7);
      expect(playerHighlightCandidateIsCanonical({ reason: "Transcript cache evidence", transcriptExcerpt }, "Ethan Oconnor")).toBe(true);
    }
    expect(playerActionScore("Connor throws a touchdown pass to Ethan Smith.", "Ethan Oconnor")).toBe(0);
  });

  it("rejects a named defender being beaten even when the source is player-grounded", () => {
    const negativeOrNonPlay = [
      "The receiver made the catch in traffic, fighting off Ethan O'Connor for the first down.",
      "That pass is caught for the first down. The receiver was working against Oconnor.",
      "They pushed Oconnor to the ground as Bryce Fitzgerald comes over and ultimately breaks up the pass.",
      "Oconnor to the ground as Bryce Fitzgerald comes over and ultimately breaks up the pass before the next snap.",
      "Their leading receiver was working against Oconnor. On replay, it was a strong catch after the tip.",
      "Against Oconnor. On replay, it was the last catch and a nice job by the receiver securing it.",
      "Ethan O' Conor is holding down the other corner spot. Both starting corners are out of this game as the injuries pile up.",
    ];
    for (const transcriptExcerpt of negativeOrNonPlay) {
      expect(playerHighlightCandidateIsCanonical({ reason: "Transcript cache evidence", transcriptExcerpt }, "Ethan Oconnor")).toBe(false);
    }
  });

  it("rejects player-specific defensive penalties and clearly beaten coverage from highlights", () => {
    const reason = "Player-action play sequence (signal 10.0): play-by-play action language appears next to Xavier Lucas.";
    const negativePlays = [
      "Xavier Lucas did not get a jam or reroute and it was an easy route and an easy throw for the completion.",
      "Pass interference, defense number six. That is going against Xavier Lucas right there on your screen.",
      "They tested Xavier Lucas down the field after the pass interference called against him.",
    ];
    for (const transcriptExcerpt of negativePlays) {
      expect(playerHighlightCandidateIsCanonical({ reason, transcriptExcerpt }, "Xavier Lucas")).toBe(false);
    }
  });

  it("collapses duplicate player evidence from alternate broadcasts before queueing", () => {
    const reason = "Player-action play sequence (signal 10.0): play-by-play action language appears next to Xavier Lucas.";
    const candidates = [
      { id: 1, reason, transcriptExcerpt: "Micah Gilbert picked up the first down. Xavier Lucas made the tackle. Xavier Lucas another transfer from Wisconsin." },
      { id: 2, reason, transcriptExcerpt: "Micah Gilbert got stood up after the first down. It was Xavier Lucas who made the tackle. Xavier Lucas another transfer from Wisconsin." },
      { id: 3, reason, transcriptExcerpt: "Lucas jumped the route and came down with the interception on the sideline for Miami." },
      { id: 4, reason, transcriptExcerpt: "Wasn't there. Jaylen Hornsby, the intended receiver. Ethan O'Connor had him tied up, forcing the punt." },
      { id: 5, reason, transcriptExcerpt: "The rush comes. Wasn't there. Jaylen Hornsby, the intended receiver. Ethan O'Connor had him tied up, forcing the punt after third down." },
    ];
    expect(uniqueCanonicalPlayerHighlightCandidates(candidates.slice(0, 3), "Xavier Lucas").map((candidate) => candidate.id)).toEqual([1]);
    expect(uniqueCanonicalPlayerHighlightCandidates(candidates.slice(3), "Ethan Oconnor").map((candidate) => candidate.id)).toEqual([4]);
  });

  it("groups alternate bowl broadcast titles under the same opponent", () => {
    expect(sourceGameKey("2025 Pop Tarts Bowl Full Game | Georgia Tech vs BYU", "BYU")).toBe("georgia tech");
    expect(sourceGameKey("#22 Georgia Tech vs #12 BYU Full Game Replay", "BYU")).toBe("georgia tech");
  });

  it("round-robins the strongest plays across games before taking seconds", () => {
    const ordered = balancedPlayerPlayOrder([
      { key: "utah-1", title: "Utah vs BYU", relevanceScore: 0.99, qualityScore: 0.8 },
      { key: "utah-2", title: "Utah vs BYU", relevanceScore: 0.98, qualityScore: 0.8 },
      { key: "tcu-1", title: "TCU vs BYU", relevanceScore: 0.9, qualityScore: 0.8 },
      { key: "gt-1", title: "Georgia Tech vs BYU", relevanceScore: 0.85, qualityScore: 0.8 },
    ], "BYU");
    expect(ordered.map((candidate) => candidate.key)).toEqual(["utah-1", "tcu-1", "gt-1", "utah-2"]);
  });

  it("uses one source per game before duplicate uploads consume source slots", () => {
    const sources = diversifySourcesByGame([
      { key: "gt-a", title: "Georgia Tech vs BYU Full Game", rankScore: 0.99 },
      { key: "gt-b", title: "2025 Pop Tarts Bowl Georgia Tech vs BYU", rankScore: 0.98 },
      { key: "utah", title: "Utah vs BYU Full Game", rankScore: 0.9 },
      { key: "tcu", title: "TCU vs BYU Full Game", rankScore: 0.85 },
    ], "BYU", 3);
    expect(sources.map((source) => source.key)).toEqual(["gt-a", "utah", "tcu"]);
  });
});

describe("Find Clips broadcast sound-bite lane", () => {
  it("recognizes player profiles and broadcast analysis without treating live calls as sound bites", () => {
    expect(broadcastSoundbiteScore(
      "We talked to the coaches about Bear Bachmeier. The freshman starter has impressed them with his composure, confidence and leadership.",
      "Bear Bachmeier",
    )).toBeGreaterThanOrEqual(9);
    expect(broadcastSoundbiteScore(
      "Third and four. Bachmeier takes the snap, rolls out and throws complete for a first down at the 20.",
      "Bear Bachmeier",
    )).toBe(0);
    expect(broadcastSoundbiteScore(
      "Ryan Bear is the right tackle and his brother played here last season.",
      "Bear Bachmeier",
    )).toBe(0);
    expect(broadcastSoundbiteScore(
      "Bachmeier underneath to Martin for a first down. Martin committed to Stanford as a high school junior before BYU flipped him.",
      "Bear Bachmeier",
    )).toBe(0);
  });

  it("requires the explicit sound-bite classification before adding a clip to that lane", () => {
    const text = "Bear Bachmeier grew up playing linebacker, and the coaches told us that toughness shaped his mentality as a quarterback.";
    expect(broadcastSoundbiteCandidateIsCanonical({
      reason: "Broadcast sound bite (signal 12.0): broadcast profile commentary.",
      transcriptExcerpt: text,
    }, "Bear Bachmeier")).toBe(true);
    expect(broadcastSoundbiteCandidateIsCanonical({
      reason: "Caption-first transcript match (90% deterministic term coverage).",
      transcriptExcerpt: text,
    }, "Bear Bachmeier")).toBe(false);
  });

  it("keeps full context and removes overlapping mentions from one broadcast", () => {
    const segments = Array.from({ length: 40 }, (_, index) => ({
      start: index * 3,
      end: index * 3 + 2.8,
      text: index === 12
        ? "We talked to the coaches about Bear Bachmeier and his confidence."
        : index === 15
          ? "The freshman starter has shown remarkable composure and leadership."
          : `Broadcast context sentence ${index}.`,
    }));
    const windows = selectBroadcastSoundbiteWindows(segments, "Bear Bachmeier", 3);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.editIn).toBeLessThan(segments[12]!.start);
    expect(windows[0]!.editOut).toBeGreaterThan(segments[15]!.end);
  });

  it("deduplicates verified sound bites without mixing them into the play lane", () => {
    const reason = "Broadcast sound bite (signal 12.0): broadcast profile commentary.";
    const candidates = [
      { id: 1, reason, transcriptExcerpt: "We talked to the coaches about Bear Bachmeier. The freshman starter has impressed them with his confidence and leadership." },
      { id: 2, reason, transcriptExcerpt: "We talked to the coaches about Bear Bachmeier. The freshman starter has impressed them with his confidence and leadership this season." },
    ];
    expect(uniqueCanonicalBroadcastSoundbiteCandidates(candidates, "Bear Bachmeier").map((candidate) => candidate.id)).toEqual([1]);
  });
});
