/**
 * Clip manifest — canonical, durable per-project metadata for Assemble.
 *
 * This is a NORMALIZATION layer, not a second analysis pass: it harvests the
 * intelligence Cut IQ already gathered during script analysis and clip
 * discovery (script_projects + script_beats + clip_candidates + clip_jobs +
 * videos) and writes it into one versioned `clip-manifest.json` document.
 *
 * Honesty rules (master prompt §27/§62):
 *  - Player/team/season are derived ONLY from text Cut IQ already has
 *    (project topic/name + beat entities). If it can't be determined, the
 *    field is null — never invented.
 *  - Codec is never asserted without a probe; container is inferred from the
 *    rendered filename extension.
 *  - There is no play-boundary/All-22/tag system in this codebase, so the
 *    manifest exposes the anchors that DO exist (edit in/out, transcript
 *    segment, candidate reason/confidence) rather than fabricating new ones.
 */

import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  clipCandidates,
  clipJobs,
  scriptBeats,
  scriptProjects,
  scriptRevisions,
  videos,
} from "@db/schema";
import { extractPersonNames, extractTeams, extractYears } from "../script/analysis";
import { CLIPS_DIR } from "../runtimePaths";

export const MANIFEST_SCHEMA_VERSION = 1;

// ── Document shape ──────────────────────────────────────────────────────────

export interface ManifestPlayer {
  name: string;
  team: string | null;
  season: string | null;
}

export interface ManifestVerification {
  playerVerified: boolean;
  contextVerified: boolean;
  confidence: number | null;
  matchKind: string;
  reason: string | null;
}

export interface ManifestClip {
  clipId: string;
  candidateId: number;
  beatOrd: number;
  beatText: string;
  game: string | null; // best-effort from source title/account
  opponent: string | null; // not reliably present; null unless parsed
  sourceUrl: string;
  sourceVideoId: string | null;
  localPath: string | null;
  downloadUrl: string | null; // /api/clips/<relative> for local preview
  drivePath: string | null;
  sourceStartSeconds: number | null; // editIn (source timecode)
  sourceEndSeconds: number | null; // editOut
  clipDurationSeconds: number | null; // rendered duration
  resolution: { width: number | null; height: number | null };
  container: string | null; // from filename extension only
  codec: string | null; // never asserted without probe
  playerMention: { text: string | null; timeSeconds: number | null } | null;
  queryContext: string[];
  coverageTypes: string[];
  purpose: string | null;
  transcript: { text: string | null; segmentStart: number | null; segmentEnd: number | null };
  tags: string[];
  selectionKind?: "player_play" | "broadcast_soundbite" | "mention_match" | "other";
  verification: ManifestVerification;
}

export interface ClipManifest {
  schemaVersion: number;
  generatedAt: string;
  projectId: number;
  projectName: string;
  topic: string | null;
  player: ManifestPlayer | null;
  clips: ManifestClip[];
  unresolvedBeats: number[];
}

// ── Pure derivation helpers (unit-testable, no I/O) ────────────────────────

/**
 * Derive subject identity from text Cut IQ already holds. Returns null for a
 * field when it cannot be determined honestly (never guesses).
 *
 * Season is derived from the topic + script text only — the project `name` is
 * a generated `YYYY-MM-DD__JOB__...` run-date stamp, not a football season, so
 * it is excluded to avoid treating a run date as a season.
 */
export function deriveSubject(input: {
  topic?: string | null;
  name?: string | null;
  entities?: string[];
  scriptText?: string | null;
}): ManifestPlayer | null {
  const entities = input.entities ?? [];
  const nameHaystack = [input.topic, input.name].filter(Boolean) as string[];
  const seasonHaystack = [input.topic, input.scriptText].filter(Boolean) as string[];

  // Prefer an entity explicitly detected as a person during analysis.
  const name =
    (extractPersonNames(entities.join(" "))[0] ??
      (nameHaystack.length ? extractPersonNames(nameHaystack.join(" "))[0] : undefined)) ??
    null;

  const team =
    (nameHaystack.length ? extractTeams(nameHaystack.join(" "))[0] : undefined) ?? null;
  const season =
    (seasonHaystack.length ? extractYears(seasonHaystack.join(" "))[0] : undefined) ?? null;

  if (!name && !team && !season) return null;
  return { name: name ?? "Unknown", team, season };
}

/** Infer the container from a rendered filename extension (no probing). */
export function containerFromPath(path: string | null): string | null {
  if (!path) return null;
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Map one rendered candidate (candidate + its finished clip job + source video
 * + its beat) into a manifest clip record. Preserves only what exists.
 */
export interface ManifestSourceRow {
  candidate: typeof clipCandidates.$inferSelect;
  job: typeof clipJobs.$inferSelect | null; // may be null (not yet rendered)
  video: typeof videos.$inferSelect | null;
  beat: typeof scriptBeats.$inferSelect | null;
  beatOrd: number;
}

export function mapCandidateToClip(row: ManifestSourceRow): ManifestClip {
  const c = row.candidate;
  const job = row.job;
  const beat = row.beat;
  const editIn = c.editIn ?? c.segStart ?? null;
  const editOut = c.editOut ?? c.segEnd ?? null;
  const clipRelativeMention =
    c.segStart != null && editIn != null ? Math.max(0, c.segStart - editIn) : null;

  return {
    clipId: `cand-${Number(c.id)}`,
    candidateId: Number(c.id),
    beatOrd: row.beatOrd,
    beatText: beat?.text ?? "",
    game: c.title ?? c.sourceAccount ?? null,
    opponent: null, // Cut IQ does not store opponent identity today
    sourceUrl: c.sourceUrl,
    sourceVideoId: row.video?.videoId ?? extractVideoIdFromUrl(c.sourceUrl),
    localPath: job?.outputPath ?? null,
    downloadUrl: clipDownloadUrl(job?.outputPath ?? null),
    drivePath: job?.drivePath ?? null,
    sourceStartSeconds: editIn,
    sourceEndSeconds: editOut,
    clipDurationSeconds: job?.outputDurationSec ?? (editIn != null && editOut != null ? editOut - editIn : null),
    resolution: { width: job?.outputWidth ?? null, height: job?.outputHeight ?? null },
    container: containerFromPath(job?.outputPath ?? null),
    codec: null, // unverified; set by render probe, not here
    playerMention:
      c.transcriptExcerpt || clipRelativeMention != null
        ? { text: c.transcriptExcerpt ?? null, timeSeconds: clipRelativeMention }
        : null,
    queryContext: safeJsonArray(beat?.queries),
    coverageTypes: safeJsonArray(beat?.coverageTypes),
    purpose: beat?.purpose ?? null,
    transcript: {
      text: c.transcriptExcerpt ?? null,
      segmentStart: c.segStart ?? null,
      segmentEnd: c.segEnd ?? null,
    },
    tags: [...safeJsonArray(beat?.coverageTypes)],
    selectionKind: c.reason?.startsWith("Player-action play sequence")
      ? "player_play"
      : c.reason?.startsWith("Broadcast sound bite")
        ? "broadcast_soundbite"
        : c.reason?.startsWith("Caption-first transcript match")
          ? "mention_match"
          : "other",
    verification: {
      playerVerified: c.state === "approved",
      contextVerified: c.state === "approved" && (c.relevanceScore ?? 0) >= 0.5,
      confidence: c.visualConfidence ?? null,
      matchKind: c.matchKind ?? "manual_review",
      reason: c.reason ?? null,
    },
  };
}

function extractVideoIdFromUrl(url: string): string | null {
  const m = url.match(/youtube\.com\/watch\?v=([\w-]{11})|youtu\.be\/([\w-]{11})/);
  return m ? (m[1] ?? m[2]) : null;
}

/** Relative /api/clips/* URL for a rendered output path (for local preview). */
export function clipDownloadUrl(outputPath: string | null): string | null {
  if (!outputPath) return null;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(outputPath);
  const root = norm(CLIPS_DIR);
  const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file.split("/").slice(-2).join("/");
  return `/api/clips/${encodeURIComponent(relative)}`;
}

function safeJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ── DB generator ────────────────────────────────────────────────────────────

export interface BuildManifestOptions {
  /** Only include clips that have a rendered `ready` job (default true). */
  renderedOnly?: boolean;
}

export async function buildProjectManifest(
  projectId: number,
  opts: BuildManifestOptions = {},
): Promise<ClipManifest> {
  const renderedOnly = opts.renderedOnly ?? true;
  const db = getDb();

  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found.`);

  const [revision] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);

  const beats = revision
    ? await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord))
    : [];

  const candidates = revision
    ? await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id))
    : [];

  const candidateIds = candidates.map((c) => Number(c.id));
  const jobs = candidateIds.length
    ? await db.select().from(clipJobs).where(inArray(clipJobs.candidateFk, candidateIds))
    : [];

  const videoIds = [...new Set(candidates.map((c) => c.videoFk).filter((v): v is number => v != null))];
  const videoRows = videoIds.length
    ? await db.select().from(videos).where(inArray(videos.id, videoIds))
    : [];
  const videoById = new Map(videoRows.map((v) => [Number(v.id), v]));

  // Candidates store the beat primary key, not the beat ordinal. Keying this
  // map by `ord` silently assigned every rendered clip to beat 0 whenever the
  // auto-increment id differed from its display order.
  const beatById = new Map(beats.map((b) => [Number(b.id), b]));
  const jobByCandidate = new Map<number, typeof clipJobs.$inferSelect>();
  for (const job of jobs) {
    if (job.candidateFk == null) continue;
    const cid = Number(job.candidateFk);
    const existing = jobByCandidate.get(cid);
    // Prefer a `ready` job; fall back to the most recent otherwise.
    if (!existing || (job.status === "ready" && existing.status !== "ready")) jobByCandidate.set(cid, job);
  }

  const allEntities = candidates.flatMap((c) => {
    const beat = beatById.get(Number(c.beatFk));
    return beat ? safeJsonArray(beat.entities) : [];
  });

  const clips: ManifestClip[] = [];
  for (const candidate of candidates) {
    const job = jobByCandidate.get(Number(candidate.id)) ?? null;
    if (renderedOnly && (!job || job.status !== "ready")) continue;
    const beat = beatById.get(Number(candidate.beatFk)) ?? null;
    clips.push(
      mapCandidateToClip({
        candidate,
        job,
        video: candidate.videoFk != null ? (videoById.get(Number(candidate.videoFk)) ?? null) : null,
        beat,
        beatOrd: beat?.ord ?? 0,
      }),
    );
  }

  // Beats with no rendered candidate = honest unresolved markers.
  const coveredBeats = new Set(clips.map((c) => c.beatOrd));
  const unresolvedBeats = beats.map((b) => b.ord).filter((ord) => !coveredBeats.has(ord));

  const player = deriveSubject({
    topic: project.topic,
    name: project.name,
    entities: allEntities,
    scriptText: revision?.scriptText ?? null,
  });

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    projectId: projectId,
    projectName: project.name,
    topic: project.topic ?? null,
    player,
    clips,
    unresolvedBeats,
  };
}
