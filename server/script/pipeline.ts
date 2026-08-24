/**
 * Script/Project pipeline: upsert by Google Doc identity, content-hash
 * revisions, staged execution with per-provider failure isolation, candidate
 * dedupe + ranking. All state is persisted incrementally to the existing
 * database — restarts resume rather than restart.
 */
import { createHash } from "crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  clipCandidates,
  scriptBeats,
  scriptProjects,
  scriptRevisions,
  scriptSearchCache,
  type CANDIDATE_STATES,
} from "@db/schema";
import { analyzeScript, type BeatAnalysis } from "./analysis";
import { discoverForBeat, listProviders, type NormalizedCandidate } from "./providers";

export type ScriptProjectStatus =
  | "imported"
  | "analyzing"
  | "building_coverage"
  | "searching_sources"
  | "fetching_transcripts"
  | "ranking_candidates"
  | "ready_for_review"
  | "partially_complete"
  | "failed";

export interface LogEntry {
  at: string;
  stage: string;
  provider?: string;
  ok: boolean;
  message?: string;
}

export function scriptHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r/g, "")).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendLog(existing: string | null, entry: LogEntry): string {
  let arr: LogEntry[] = [];
  try {
    arr = existing ? (JSON.parse(existing) as LogEntry[]) : [];
  } catch {
    arr = [];
  }
  arr.push(entry);
  return JSON.stringify(arr.slice(-200));
}

export function defaultProjectName(topic: string | undefined, requested: string | undefined): string {
  if (requested?.trim()) return requested.trim();
  const date = new Date().toISOString().slice(0, 10);
  const t = (topic ?? "CSC").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  return `${date}__CSC__${t || "Untitled"}`;
}

// ---------------------------------------------------------------- upsert ----

export interface UpsertResult {
  projectId: number;
  revision: number;
  isNewProject: boolean;
  isNewRevision: boolean;
  status: ScriptProjectStatus;
  name: string;
}

/**
 * Upsert a script submission by stable document identity.
 * - Same doc ID + unchanged hash  -> reopen existing project (no duplicate).
 * - Same doc ID + changed hash    -> new revision on the same project.
 * - No doc ID                     -> hash-based match against prior projects
 *   of the same provider, else create.
 */
export async function upsertScriptProject(input: {
  title?: string;
  topic?: string;
  tags?: string[];
  sourceProvider: string;
  sourceDocId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceModifiedAt?: string;
  scriptText: string;
  extractedFromHeading?: string;
  projectName?: string;
}): Promise<UpsertResult> {
  const db = getDb();
  const hash = scriptHash(input.scriptText);

  let project: typeof scriptProjects.$inferSelect | undefined;

  if (input.sourceDocId) {
    [project] = await db
      .select()
      .from(scriptProjects)
      .where(eq(scriptProjects.sourceDocId, input.sourceDocId));
  }
  // A caller-provided source identity owns its own project. Falling back to a
  // script hash here caused independently-created Find Clips jobs with the
  // same player/team/season brief to reopen the previous project and inherit
  // its candidates and rendered clips.
  if (!project && !input.sourceDocId) {
    // Fall back: same provider + identical hash already exists.
    const all = await db.select().from(scriptProjects).orderBy(desc(scriptProjects.id));
    for (const p of all) {
      const [rev] = await db
        .select()
        .from(scriptRevisions)
        .where(eq(scriptRevisions.projectFk, p.id))
        .orderBy(desc(scriptRevisions.revision))
        .limit(1);
      if (rev?.scriptHash === hash && p.sourceProvider === input.sourceProvider) {
        project = p;
        break;
      }
    }
  }

  let isNewProject = false;
  let revisionNo: number;

  if (!project) {
    isNewProject = true;
    const [ins] = await db
      .insert(scriptProjects)
      .values({
        name: defaultProjectName(input.topic, input.projectName),
        topic: input.topic ?? null,
        tags: JSON.stringify(input.tags ?? []),
        sourceProvider: input.sourceProvider,
        sourceDocId: input.sourceDocId ?? null,
        sourceTitle: input.sourceTitle ?? null,
        sourceUrl: input.sourceUrl ?? null,
        sourceModifiedAt: input.sourceModifiedAt ?? null,
        status: "imported",
        currentRevision: 1,
      })
      .$returningId();
    [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, ins.id));
    revisionNo = 1;
    await db.insert(scriptRevisions).values({
      projectFk: project!.id,
      revision: 1,
      scriptText: input.scriptText,
      scriptHash: hash,
      extractedFromHeading: input.extractedFromHeading ?? null,
    });
  } else {
    const [latest] = await db
      .select()
      .from(scriptRevisions)
      .where(eq(scriptRevisions.projectFk, project.id))
      .orderBy(desc(scriptRevisions.revision))
      .limit(1);

    if (latest?.scriptHash === hash) {
      // Unchanged script: reopen, no new revision.
      return {
        projectId: project.id,
        revision: project.currentRevision,
        isNewProject: false,
        isNewRevision: false,
        status: project.status as ScriptProjectStatus,
        name: project.name,
      };
    }
    revisionNo = (latest?.revision ?? 0) + 1;
    await db.insert(scriptRevisions).values({
      projectFk: project.id,
      revision: revisionNo,
      scriptText: input.scriptText,
      scriptHash: hash,
      extractedFromHeading: input.extractedFromHeading ?? null,
    });
    // Update provenance from the freshest submission.
    await db
      .update(scriptProjects)
      .set({
        sourceTitle: input.sourceTitle ?? project.sourceTitle,
        sourceUrl: input.sourceUrl ?? project.sourceUrl,
        sourceModifiedAt: input.sourceModifiedAt ?? project.sourceModifiedAt,
        topic: input.topic ?? project.topic,
        currentRevision: revisionNo,
        status: "imported",
      })
      .where(eq(scriptProjects.id, project.id));
    [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, project.id));
  }

  return {
    projectId: project!.id,
    revision: revisionNo,
    isNewProject,
    isNewRevision: !isNewProject && revisionNo > 1,
    status: "imported",
    name: project!.name,
  };
}

// ------------------------------------------------------------- analyze ----

export async function runAnalyze(projectId: number): Promise<{ beats: number; warnings: string[] }> {
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found`);
  const [rev] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!rev) throw new Error(`Project ${projectId} has no script revision`);

  await db.update(scriptProjects).set({ status: "analyzing" }).where(eq(scriptProjects.id, projectId));

  const analysis = analyzeScript(rev.scriptText);

  // Beats are stable ownership anchors for candidates. Re-analyzing an
  // unchanged revision must not delete and recreate them because that leaves
  // existing candidates pointing at obsolete beat ids and corrupts coverage.
  const existing = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev.id));
  if (existing.length) {
    await db
      .update(scriptProjects)
      .set({
        status: "building_coverage",
        pipelineLog: appendLog(project.pipelineLog, {
          at: nowIso(),
          stage: "analyze",
          ok: true,
          message: `${existing.length} existing beats preserved for unchanged revision`,
        }),
      })
      .where(eq(scriptProjects.id, projectId));
    return { beats: existing.length, warnings: analysis.warnings };
  }

  if (analysis.beats.length) {
    await db.insert(scriptBeats).values(
      analysis.beats.map((b) => ({
        projectFk: projectId,
        revisionFk: rev.id,
        ord: b.ord,
        text: b.text,
        entities: JSON.stringify(b.entities),
        aliases: JSON.stringify(b.aliases),
        purpose: b.purpose,
        coverageTypes: JSON.stringify(b.coverageTypes),
        needsTranscriptSearch: b.needsTranscriptSearch,
        visualOnly: b.visualOnly,
        desiredClipLenSec: b.desiredClipLenSec,
        queries: JSON.stringify(b.queries),
        uncertainty: b.uncertainty,
        status: "pending" as const,
      })),
    );
  }

  await db
    .update(scriptProjects)
    .set({
      status: "building_coverage",
      pipelineLog: appendLog(project.pipelineLog, {
        at: nowIso(),
        stage: "analyze",
        ok: true,
        message: `${analysis.beats.length} beats; ${analysis.warnings.join("; ") || "no warnings"}`,
      }),
    })
    .where(eq(scriptProjects.id, projectId));

  return { beats: analysis.beats.length, warnings: analysis.warnings };
}

// ----------------------------------------------------------- discover ----

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const db = getDb();
  const [hit] = await db.select().from(scriptSearchCache).where(eq(scriptSearchCache.cacheKey, key));
  if (hit && hit.expiresAt > Date.now()) {
    return JSON.parse(hit.payload) as T;
  }
  const value = await fn();
  await db
    .insert(scriptSearchCache)
    .values({ cacheKey: key, payload: JSON.stringify(value), expiresAt: Date.now() + CACHE_TTL_MS })
    .onDuplicateKeyUpdate({ set: { payload: JSON.stringify(value), expiresAt: Date.now() + CACHE_TTL_MS } });
  return value;
}

/** Dedupe key: provider-agnostic video identity when known. */
export function dupGroupKey(c: NormalizedCandidate): string | null {
  const m = c.sourceUrl.match(/youtube\.com\/watch\?v=([\w-]{11})|youtu\.be\/([\w-]{11})/);
  if (m) return `yt:${m[1] ?? m[2]}`;
  return null;
}

export async function runDiscover(
  projectId: number,
  opts?: { onlyProviders?: string[]; onlyBeats?: number[] },
): Promise<{ candidates: number; providerFailures: string[] }> {
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found`);
  const [rev] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!rev) throw new Error("No revision");

  await db.update(scriptProjects).set({ status: "searching_sources" }).where(eq(scriptProjects.id, projectId));

  let beatRows = await db
    .select()
    .from(scriptBeats)
    .where(eq(scriptBeats.revisionFk, rev.id))
    .orderBy(asc(scriptBeats.ord));
  if (opts?.onlyBeats?.length) beatRows = beatRows.filter((b) => opts.onlyBeats!.includes(b.ord));

  const providerFailures: string[] = [];
  let totalInserted = 0;
  let log = project.pipelineLog;

  for (const beatRow of beatRows) {
    const beat: BeatAnalysis = {
      ord: beatRow.ord,
      text: beatRow.text,
      entities: JSON.parse(beatRow.entities ?? "[]"),
      aliases: JSON.parse(beatRow.aliases ?? "{}"),
      purpose: (beatRow.purpose ?? "narration") as BeatAnalysis["purpose"],
      coverageTypes: JSON.parse(beatRow.coverageTypes ?? "[]"),
      needsTranscriptSearch: !!beatRow.needsTranscriptSearch,
      visualOnly: !!beatRow.visualOnly,
      desiredClipLenSec: beatRow.desiredClipLenSec ?? 7,
      queries: JSON.parse(beatRow.queries ?? "[]"),
      uncertainty: beatRow.uncertainty,
    };

    // Search expansion can improve without changing the source script (for
    // example Find Clips adds player/team/game grounding). Include the actual
    // query set so stale, weaker discovery results are never replayed.
    const queryKey = createHash("sha256").update(JSON.stringify(beat.queries)).digest("hex").slice(0, 12);
    const cacheKey = `discover:${rev.scriptHash.slice(0, 16)}:beat${beatRow.ord}:q${queryKey}:${(opts?.onlyProviders ?? []).join(",")}`;
    const results = await cached(cacheKey, () => discoverForBeat(beat));

    for (const r of results) {
      if (opts?.onlyProviders?.length && !opts.onlyProviders.includes(r.provider)) continue;
      if (!r.ok) {
        providerFailures.push(`${r.provider}: ${r.error}`);
        log = appendLog(log, { at: nowIso(), stage: "discover", provider: r.provider, ok: false, message: r.error });
        continue; // provider failure must not erase other providers' results
      }
      // Remove only this provider's prior candidates for this beat (rerun-safe).
      await db
        .delete(clipCandidates)
        .where(
          and(
            eq(clipCandidates.beatFk, beatRow.id),
            eq(clipCandidates.provider, r.provider),
            eq(clipCandidates.revisionFk, rev.id),
            eq(clipCandidates.state, "undecided"),
          ),
        );
      if (r.candidates.length) {
        await db.insert(clipCandidates).values(
          r.candidates.map((c) => ({
            projectFk: projectId,
            revisionFk: rev.id,
            beatFk: beatRow.id,
            provider: c.provider,
            videoFk: c.videoFk,
            sourceUrl: c.sourceUrl,
            sourceAccount: c.sourceAccount,
            title: c.title,
            publishedAt: c.publishedAt,
            durationSec: c.durationSec,
            thumbnailUrl: c.thumbnailUrl,
            matchKind: c.matchKind,
            transcriptExcerpt: c.transcriptExcerpt,
            segStart: c.segStart,
            segEnd: c.segEnd,
            editIn: null,
            editOut: null,
            relevanceScore: c.relevanceScore,
            qualityScore: 0,
            cleanSourceScore: 0,
            visualConfidence: c.matchKind === "exact_transcript" ? 0 : 0.2,
            reason: c.reason,
            acquisitionStatus: c.videoFk ? "library_indexed" : c.matchKind === "manual_review" ? "open_external" : "metadata_only",
            dupGroupKey: dupGroupKey(c),
            state: "undecided" as (typeof CANDIDATE_STATES)[number],
          })),
        );
        totalInserted += r.candidates.length;
      }
      log = appendLog(log, {
        at: nowIso(),
        stage: "discover",
        provider: r.provider,
        ok: true,
        message: `${r.candidates.length} candidates for beat ${beatRow.ord}`,
      });
    }
  }

  // Carry over user decisions (approved/rejected state + notes) from the
  // previous revision for text-identical beats, so re-running a changed
  // script never loses the user's selections.
  if (rev.revision > 1) {
    const revs = await db
      .select()
      .from(scriptRevisions)
      .where(eq(scriptRevisions.projectFk, projectId))
      .orderBy(desc(scriptRevisions.revision))
      .limit(2);
    const prev = revs[1];
    if (prev) {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const prevBeats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, prev.id));
      const newBeats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev.id));
      for (const oldBeat of prevBeats) {
        const newBeat = newBeats.find((b) => norm(b.text) === norm(oldBeat.text));
        if (!newBeat) continue;
        const oldCands = await db.select().from(clipCandidates).where(eq(clipCandidates.beatFk, oldBeat.id));
        for (const oc of oldCands.filter((c) => c.state !== "undecided" || c.userNotes)) {
          const twin = (
            await db
              .select()
              .from(clipCandidates)
              .where(and(eq(clipCandidates.beatFk, newBeat.id), eq(clipCandidates.sourceUrl, oc.sourceUrl)))
          )[0];
          if (twin) {
            await db
              .update(clipCandidates)
              .set({ state: oc.state, userNotes: oc.userNotes ?? twin.userNotes })
              .where(eq(clipCandidates.id, twin.id));
          }
        }
      }
    }
  }

  await db
    .update(scriptProjects)
    .set({
      status: "fetching_transcripts",
      pipelineLog: log,
    })
    .where(eq(scriptProjects.id, projectId));

  return { candidates: totalInserted, providerFailures };
}

// ---------------------------------------------------------------- rank ----

/**
 * Rank + suggest edit points. For transcript candidates, align edits to the
 * segment boundaries with the project's pre/post-roll config; mark beats
 * covered / needing footage.
 */
export async function runRank(projectId: number): Promise<{ ranked: number; beatsCovered: number; beatsMissing: number }> {
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found`);
  const [rev] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);
  if (!rev) throw new Error("No revision");

  await db.update(scriptProjects).set({ status: "ranking_candidates" }).where(eq(scriptProjects.id, projectId));

  const pre = project.prerollSec ?? 3;
  const post = project.postrollSec ?? 1.5;
  const defaultLen = project.defaultClipLenSec ?? 8;

  const candidates = await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, rev.id));

  // Duplicate grouping: within a group keep relevance ordering, mark alts.
  const groups = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!c.dupGroupKey) continue;
    const g = groups.get(c.dupGroupKey) ?? [];
    g.push(c);
    groups.set(c.dupGroupKey, g);
  }

  for (const c of candidates) {
    let editIn = c.editIn;
    let editOut = c.editOut;
    let quality = c.qualityScore ?? 0;
    let clean = c.cleanSourceScore ?? 0;

    if (c.segStart != null && c.segEnd != null) {
      // Speech: align to segment boundaries, apply configured roll.
      editIn = Math.max(0, c.segStart - pre);
      editOut = c.segEnd + post;
      quality = 0.8; // exact timestamps are the strongest evidence
      clean = c.provider === "library" ? 0.7 : 0.5;
    } else if (c.durationSec != null) {
      // Visual-only: suggest the opening window as a starting edit range.
      editIn = 0;
      editOut = Math.min(c.durationSec, defaultLen);
      quality = 0.3;
    }

    const relevance = Math.min(1, (c.relevanceScore ?? 0) + (c.matchKind === "exact_transcript" ? 0.25 : 0));

    await db
      .update(clipCandidates)
      .set({ editIn, editOut, relevanceScore: relevance, qualityScore: quality, cleanSourceScore: clean })
      .where(eq(clipCandidates.id, c.id));
  }

  // Beat coverage from ranked candidates.
  const beats = await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev.id)).orderBy(asc(scriptBeats.ord));
  let beatsCovered = 0;
  let beatsMissing = 0;
  for (const b of beats) {
    const cands = candidates.filter((c) => c.beatFk === b.id);
    const hasUsable = cands.some((c) => c.matchKind === "exact_transcript" || (c.videoFk != null && c.segStart != null));
    const status = hasUsable ? "covered" : "needs_footage";
    if (hasUsable) beatsCovered++;
    else beatsMissing++;
    await db.update(scriptBeats).set({ status }).where(eq(scriptBeats.id, b.id));
  }

  const finalStatus: ScriptProjectStatus = beatsMissing > 0 && beatsCovered > 0 ? "partially_complete" : beatsMissing === 0 && beats.length > 0 ? "ready_for_review" : "partially_complete";

  await db
    .update(scriptProjects)
    .set({
      status: finalStatus,
      pipelineLog: appendLog(project.pipelineLog, {
        at: nowIso(),
        stage: "rank",
        ok: true,
        message: `${candidates.length} candidates ranked; ${beatsCovered} beats covered, ${beatsMissing} need footage`,
      }),
    })
    .where(eq(scriptProjects.id, projectId));

  return { ranked: candidates.length, beatsCovered, beatsMissing };
}

// -------------------------------------------------------------- status ----

export interface ProjectStatus {
  projectId: number;
  name: string;
  status: ScriptProjectStatus;
  revision: number;
  sourceTitle: string | null;
  sourceUrl: string | null;
  sourceDocId: string | null;
  beats: { total: number; covered: number; needsFootage: number };
  candidates: { total: number; withTimestamps: number; approved: number; rejected: number };
  providerFailures: LogEntry[];
  providers: ReturnType<typeof listProviders>;
  log: LogEntry[];
}

export async function getProjectStatus(projectId: number): Promise<ProjectStatus> {
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId));
  if (!project) throw new Error(`Project ${projectId} not found`);
  const [rev] = await db
    .select()
    .from(scriptRevisions)
    .where(eq(scriptRevisions.projectFk, projectId))
    .orderBy(desc(scriptRevisions.revision))
    .limit(1);

  const beats = rev ? await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, rev.id)) : [];
  const candidates = rev ? await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, rev.id)) : [];

  let logEntries: LogEntry[] = [];
  try {
    logEntries = project.pipelineLog ? (JSON.parse(project.pipelineLog) as LogEntry[]) : [];
  } catch {
    logEntries = [];
  }

  return {
    projectId,
    name: project.name,
    status: project.status as ScriptProjectStatus,
    revision: project.currentRevision,
    sourceTitle: project.sourceTitle,
    sourceUrl: project.sourceUrl,
    sourceDocId: project.sourceDocId,
    beats: {
      total: beats.length,
      covered: beats.filter((b) => b.status === "covered").length,
      needsFootage: beats.filter((b) => b.status === "needs_footage").length,
    },
    candidates: {
      total: candidates.length,
      withTimestamps: candidates.filter((c) => c.segStart != null).length,
      approved: candidates.filter((c) => c.state === "approved").length,
      rejected: candidates.filter((c) => c.state === "rejected").length,
    },
    providerFailures: logEntries.filter((e) => e.stage === "discover" && !e.ok),
    providers: listProviders(),
    log: logEntries.slice(-30),
  };
}
