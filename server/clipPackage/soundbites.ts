import { asc, desc, eq, inArray } from "drizzle-orm";
import {
  clipCandidates,
  clipJobs,
  findJobs,
  findSources,
  scriptBeats,
  scriptRevisions,
  transcriptSegments,
} from "@db/schema";
import { enqueueClip } from "../clip/engine";
import {
  BROADCAST_SOUNDBITE_REASON_PREFIX,
  broadcastSoundbiteCandidateIsCanonical,
  findJobCandidateIsGrounded,
  selectBroadcastSoundbiteWindows,
  sourceGameKey,
} from "../findClips/engine";
import { getDb } from "../queries/connection";

const ACTIVE_CLIP_STATUSES = new Set(["queued", "downloading", "uploading"]);

type Candidate = typeof clipCandidates.$inferSelect;

export interface BroadcastSoundbiteStatus {
  available: boolean;
  candidateCount: number;
  readyCount: number;
  activeCount: number;
  failedCount: number;
  activeProgress: number;
}

async function latestRevision(projectId: number) {
  const [revision] = await getDb()
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  return revision ?? null;
}

async function projectContext(projectId: number) {
  const db = getDb();
  const [job] = await db.select().from(findJobs).where(eq(findJobs.projectFk, projectId)).limit(1);
  const revision = await latestRevision(projectId);
  return { db, job: job ?? null, revision };
}

function soundbiteCandidates(candidates: Candidate[], player: string): Candidate[] {
  return candidates.filter((candidate) => broadcastSoundbiteCandidateIsCanonical(candidate, player));
}

function orderedAcrossGames(candidates: Candidate[], team: string): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = sourceGameKey(candidate.title, team);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const ranked = [...groups.values()]
    .map((group) => group.sort((left, right) => (right.relevanceScore + right.qualityScore) - (left.relevanceScore + left.qualityScore)))
    .sort((left, right) => ((right[0]?.relevanceScore ?? 0) + (right[0]?.qualityScore ?? 0)) - ((left[0]?.relevanceScore ?? 0) + (left[0]?.qualityScore ?? 0)));
  const result: Candidate[] = [];
  for (let depth = 0; ranked.some((group) => depth < group.length); depth++) {
    for (const group of ranked) {
      const candidate = group[depth];
      if (candidate) result.push(candidate);
    }
  }
  return result;
}

async function discoverBroadcastSoundbites(projectId: number): Promise<Candidate[]> {
  const { db, job, revision } = await projectContext(projectId);
  if (!job || !revision) return [];
  const beats = await db
    .select()
    .from(scriptBeats)
    .where(eq(scriptBeats.revisionFk, revision.id))
    .orderBy(asc(scriptBeats.ord));
  if (!beats.length) return [];
  const sources = await db
    .select()
    .from(findSources)
    .where(eq(findSources.projectFk, projectId))
    .orderBy(desc(findSources.rankScore));
  const existing = await db
    .select()
    .from(clipCandidates)
    .where(eq(clipCandidates.revisionFk, revision.id));

  for (const source of sources) {
    if (source.videoFk == null || !findJobCandidateIsGrounded(job, {
      provider: "youtube",
      title: source.title,
      sourceAccount: source.channel,
    })) continue;
    const title = (source.title ?? "").toLowerCase();
    if (/interview|press conference|podcast|reaction|talk show/.test(title)) continue;
    const segments = await db
      .select({ start: transcriptSegments.start, end: transcriptSegments.end, text: transcriptSegments.text })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.videoFk, source.videoFk))
      .orderBy(asc(transcriptSegments.idx));
    const windows = selectBroadcastSoundbiteWindows(segments, job.player, 3);
    for (const window of windows) {
      const duplicate = existing.some((candidate) =>
        candidate.sourceUrl === source.url
          && candidate.reason?.startsWith(BROADCAST_SOUNDBITE_REASON_PREFIX)
          && candidate.segStart != null
          && Math.abs(candidate.segStart - window.start) < 30,
      );
      if (duplicate) continue;
      const beat = beats[(existing.length + windows.indexOf(window)) % beats.length]!;
      const [inserted] = await db
        .insert(clipCandidates)
        .values({
          projectFk: projectId,
          revisionFk: revision.id,
          beatFk: beat.id,
          provider: "youtube",
          videoFk: source.videoFk,
          sourceUrl: source.url,
          sourceAccount: source.channel,
          title: source.title,
          publishedAt: source.publishedAt,
          durationSec: source.durationSec,
          thumbnailUrl: `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg`,
          matchKind: "exact_transcript",
          transcriptExcerpt: window.text,
          segStart: window.start,
          segEnd: window.end,
          editIn: window.editIn,
          editOut: source.durationSec == null ? window.editOut : Math.min(source.durationSec, window.editOut),
          relevanceScore: Math.min(0.99, 0.55 + window.score / 20),
          qualityScore: 0.8,
          cleanSourceScore: 0.5,
          visualConfidence: 0,
          reason: `${BROADCAST_SOUNDBITE_REASON_PREFIX} (signal ${window.score.toFixed(1)}): broadcast profile, sideline or analysis commentary about ${job.player}.`,
          acquisitionStatus: "caption_indexed",
          dupGroupKey: `sound:${source.videoId}:${Math.round(window.center / 15)}`.slice(0, 80),
          state: "approved",
        })
        .returning({ id: clipCandidates.id });
      if (inserted?.id != null) {
        const [candidate] = await db.select().from(clipCandidates).where(eq(clipCandidates.id, Number(inserted.id)));
        if (candidate) existing.push(candidate);
      }
    }
  }
  return soundbiteCandidates(existing, job.player);
}

async function jobsForCandidates(candidateIds: number[]) {
  return candidateIds.length
    ? getDb().select().from(clipJobs).where(inArray(clipJobs.candidateFk, candidateIds))
    : [];
}

export async function broadcastSoundbiteStatus(projectId: number): Promise<BroadcastSoundbiteStatus> {
  const { db, job, revision } = await projectContext(projectId);
  if (!job || !revision) {
    return { available: false, candidateCount: 0, readyCount: 0, activeCount: 0, failedCount: 0, activeProgress: 0 };
  }
  const all = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id));
  const candidates = soundbiteCandidates(all, job.player);
  const jobs = await jobsForCandidates(candidates.map((candidate) => Number(candidate.id)));
  let readyCount = 0;
  let activeCount = 0;
  let failedCount = 0;
  let progressTotal = 0;
  for (const candidate of candidates) {
    const rows = jobs.filter((row) => Number(row.candidateFk) === Number(candidate.id));
    if (rows.some((row) => row.status === "ready")) {
      readyCount++;
      continue;
    }
    const active = rows.find((row) => ACTIVE_CLIP_STATUSES.has(row.status));
    if (active) {
      activeCount++;
      progressTotal += active.progress ?? 0;
    } else if (rows.some((row) => row.status === "failed")) {
      failedCount++;
    }
  }
  return {
    available: job.transcriptsFound > 0,
    candidateCount: candidates.length,
    readyCount,
    activeCount,
    failedCount,
    activeProgress: activeCount ? Math.round(progressTotal / activeCount) : 0,
  };
}

export async function queueBroadcastSoundbites(projectId: number, targetCount: number) {
  const { db, job, revision } = await projectContext(projectId);
  if (!job || !revision) throw new Error("This Find Clips project is unavailable.");
  const discovered = await discoverBroadcastSoundbites(projectId);
  const jobs = await jobsForCandidates(discovered.map((candidate) => Number(candidate.id)));
  const protectedIds = new Set(
    jobs
      .filter((row) => row.status === "ready" || ACTIVE_CLIP_STATUSES.has(row.status))
      .map((row) => Number(row.candidateFk)),
  );
  const remaining = Math.max(0, targetCount - protectedIds.size);
  const ordered = orderedAcrossGames(discovered, job.team).filter((candidate) => !protectedIds.has(Number(candidate.id)));
  const queuedIds: number[] = [];
  for (const candidate of ordered.slice(0, remaining)) {
    if (candidate.editIn == null || candidate.editOut == null || candidate.editOut <= candidate.editIn) continue;
    await db.update(clipCandidates).set({ state: "approved" }).where(eq(clipCandidates.id, candidate.id));
    const clip = await enqueueClip({
      kind: "candidate",
      projectFk: projectId,
      candidateFk: candidate.id,
      videoFk: candidate.videoFk,
      sourceUrl: candidate.sourceUrl,
      title: `${job.player} broadcast video sound bite — ${candidate.title ?? "game broadcast"}`,
      editIn: candidate.editIn,
      editOut: candidate.editOut,
      height: job.preferredHeight,
      minimumHeight: job.minimumHeight,
      uploadToDrive: false,
    });
    queuedIds.push(Number(clip.id));
    protectedIds.add(Number(candidate.id));
  }
  return {
    ok: true as const,
    discovered: discovered.length,
    queued: queuedIds.length,
    alreadyReadyOrActive: protectedIds.size - queuedIds.length,
    targetCount,
    jobIds: queuedIds,
  };
}
