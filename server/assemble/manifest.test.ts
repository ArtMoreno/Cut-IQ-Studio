import { describe, it, expect } from "vitest";
import {
  containerFromPath,
  deriveSubject,
  mapCandidateToClip,
  type ManifestSourceRow,
} from "./manifest";
import { clipCandidates, clipJobs, scriptBeats, videos } from "@db/schema";

type Candidate = typeof clipCandidates.$inferSelect;
type Job = typeof clipJobs.$inferSelect;
type Beat = typeof scriptBeats.$inferSelect;
type Video = typeof videos.$inferSelect;

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    projectFk: 1,
    revisionFk: 1,
    beatFk: 7,
    provider: "library",
    videoFk: 100,
    sourceUrl: "https://www.youtube.com/watch?v=U1qZljTraBE",
    sourceAccount: "Miami Hurricanes",
    title: "Miami vs Louisville",
    publishedAt: null,
    durationSec: 5000,
    thumbnailUrl: null,
    matchKind: "exact_transcript",
    transcriptExcerpt: "Toney makes the first man miss and turns upfield",
    segStart: 12.0,
    segEnd: 18.5,
    editIn: 9.0,
    editOut: 20.0,
    relevanceScore: 0.9,
    qualityScore: 0.8,
    cleanSourceScore: 0.7,
    visualConfidence: 0.95,
    reason: "player verified; YAC semantic match",
    acquisitionStatus: "library_indexed",
    dupGroupKey: "yt:U1qZljTraBE",
    state: "approved",
    userNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 3,
    kind: "candidate",
    projectFk: 1,
    candidateFk: 1,
    momentFk: null,
    videoFk: 100,
    sourceUrl: "https://www.youtube.com/watch?v=U1qZljTraBE",
    title: "Miami-vs-Louisville-000009",
    fileName: "Miami-vs-Louisville-000009.mp4",
    editIn: 9.0,
    editOut: 20.0,
    height: 1080,
    minimumHeight: 720,
    uploadToDrive: true,
    status: "ready",
    progress: 100,
    stage: "Done",
    outputPath: "D:\\Clips\\project-1\\Miami-vs-Louisville-000009.mp4",
    fileSizeBytes: 12345678,
    outputWidth: 1920,
    outputHeight: 1080,
    outputDurationSec: 11.0,
    outputHasAudio: true,
    drivePath: "ClipSift/project-1/Miami-vs-Louisville-000009.mp4",
    error: null,
    diagnosticError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function beat(over: Partial<Beat> = {}): Beat {
  return {
    id: 7,
    projectFk: 1,
    revisionFk: 1,
    ord: 17,
    text: "Against Louisville, he broke the first tackle and turned a short throw into an explosive gain.",
    entities: JSON.stringify(["Malachi Toney", "Louisville"]),
    aliases: JSON.stringify({ "Malachi Toney": ["Toney", "Malachi"] }),
    purpose: "play_reference",
    coverageTypes: JSON.stringify(["game_footage"]),
    needsTranscriptSearch: true,
    visualOnly: false,
    desiredClipLenSec: 8,
    queries: JSON.stringify(["Toney broken tackle", "Louisville highlights"]),
    uncertainty: null,
    status: "covered",
    createdAt: new Date(),
    ...over,
  };
}

function video(over: Partial<Video> = {}): Video {
  return {
    id: 100,
    videoId: "U1qZljTraBE",
    url: "https://www.youtube.com/watch?v=U1qZljTraBE",
    title: "Miami vs Louisville",
    channel: "Miami Hurricanes",
    thumbnail: null,
    durationSec: 5000,
    transcriptLang: "en",
    transcriptKind: "auto",
    status: "ok",
    errorMessage: null,
    favorite: false,
    archived: false,
    projectId: null,
    lastPosition: 0,
    lastOpenedAt: new Date(),
    retrievedAt: new Date(),
    createdAt: new Date(),
    ...over,
  };
}

describe("deriveSubject", () => {
  it("derives a person + team + season from what Cut IQ already holds", () => {
    const s = deriveSubject({
      topic: "Mark Fletcher Jr. power running",
      name: "2026-08-13__JOB__mark-fletcher-jr-power-2025",
      entities: ["Mark Fletcher Jr."],
      scriptText: "Mark Fletcher Jr. ran through the Miami defense in 2025.",
    });
    expect(s).not.toBeNull();
    expect(s?.name?.toLowerCase()).toContain("fletcher");
    expect(s?.season).toBe("2025");
  });

  it("returns null when nothing can be determined honestly", () => {
    expect(deriveSubject({ topic: null, name: "untitled", entities: [] })).toBeNull();
  });
});

describe("containerFromPath", () => {
  it("infers container from filename extension only", () => {
    expect(containerFromPath("D:\\Clips\\p\\clip.mp4")).toBe("mp4");
    expect(containerFromPath(null)).toBeNull();
  });
});

describe("mapCandidateToClip", () => {
  it("maps a rendered, verified candidate preserving source anchors", () => {
    const row: ManifestSourceRow = {
      candidate: candidate(),
      job: job(),
      video: video(),
      beat: beat(),
      beatOrd: 17,
    };
    const clip = mapCandidateToClip(row);
    expect(clip.clipId).toBe("cand-1");
    expect(clip.sourceStartSeconds).toBe(9.0);
    expect(clip.sourceEndSeconds).toBe(20.0);
    expect(clip.clipDurationSeconds).toBe(11.0);
    expect(clip.container).toBe("mp4");
    expect(clip.codec).toBeNull(); // never asserted without a probe
    expect(clip.downloadUrl).toBe("/api/clips/project-1%2FMiami-vs-Louisville-000009.mp4");
    expect(clip.verification.playerVerified).toBe(true);
    expect(clip.verification.matchKind).toBe("exact_transcript");
    expect(clip.queryContext).toContain("Toney broken tackle");
    expect(clip.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it("labels action-harvest clips separately from simple name matches", () => {
    const action = mapCandidateToClip({
      candidate: candidate({ reason: "Player-action play sequence (signal 11.0): play-by-play action language appears next to Bear Bachmeier." }),
      job: job(), video: video(), beat: beat(), beatOrd: 0,
    });
    const mention = mapCandidateToClip({
      candidate: candidate({ reason: "Caption-first transcript match (80% deterministic term coverage)." }),
      job: job(), video: video(), beat: beat(), beatOrd: 0,
    });
    const soundbite = mapCandidateToClip({
      candidate: candidate({ reason: "Broadcast sound bite (signal 10.0): profile commentary about Malachi Toney." }),
      job: job(), video: video(), beat: beat(), beatOrd: 0,
    });
    expect(action.selectionKind).toBe("player_play");
    expect(soundbite.selectionKind).toBe("broadcast_soundbite");
    expect(mention.selectionKind).toBe("mention_match");
  });

  it("treats an unrendered candidate as unresolved evidence, not false visual", () => {
    const row: ManifestSourceRow = {
      candidate: candidate({ state: "undecided" }),
      job: null,
      video: null,
      beat: beat(),
      beatOrd: 17,
    };
    const clip = mapCandidateToClip(row);
    expect(clip.localPath).toBeNull();
    expect(clip.verification.playerVerified).toBe(false);
    expect(clip.clipDurationSeconds).toBe(11); // editOut - editIn fallback
  });
});
