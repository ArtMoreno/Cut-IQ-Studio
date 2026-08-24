/**
 * Script / Project mode — UI-facing tRPC router.
 * Reuses the same pipeline module as the stable Cut IQ control API, so the desktop
 * UI and programmatic submission stay in perfect sync.
 */
import { z } from "zod";
import { eq, desc, asc } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { clipCandidates, findJobs, moments, scriptBeats, scriptProjects, scriptRevisions, videos } from "@db/schema";
import {
  getProjectStatus,
  runAnalyze,
  runDiscover,
  runRank,
  upsertScriptProject,
} from "./script/pipeline";
import { analyzeYouTubeUrl, listProviders } from "./script/providers";
import { ControlSchemas } from "./script/providers";
import { findJobCandidateIsGrounded } from "./findClips/engine";
import { deleteProjectsAndClips, getProjectDeletionPreview } from "./script/projectDeletion";

export const scriptRouter = createRouter({
  providers: publicQuery.query(() => ({ providers: listProviders() })),

  listProjects: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db.select().from(scriptProjects).orderBy(desc(scriptProjects.updatedAt));
    return rows;
  }),

  project: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, input.id));
      if (!project) throw new Error("Project not found.");
      const [revision] = await db
        .select()
        .from(scriptRevisions)
        .where(eq(scriptRevisions.projectFk, input.id))
        .orderBy(desc(scriptRevisions.revision))
        .limit(1);
      const revisions = await db
        .select()
        .from(scriptRevisions)
        .where(eq(scriptRevisions.projectFk, input.id))
        .orderBy(desc(scriptRevisions.revision));
      const beats = revision
        ? await db.select().from(scriptBeats).where(eq(scriptBeats.revisionFk, revision.id)).orderBy(asc(scriptBeats.ord))
        : [];
      let candidates = revision
        ? await db.select().from(clipCandidates).where(eq(clipCandidates.revisionFk, revision.id))
        : [];
      const status = await getProjectStatus(input.id);
      if (project.sourceProvider === "find_clips") {
        const [findJob] = await db.select().from(findJobs).where(eq(findJobs.projectFk, input.id));
        if (findJob) {
          candidates = candidates.filter((candidate) => findJobCandidateIsGrounded(findJob, candidate));
          status.candidates = {
            total: candidates.length,
            withTimestamps: candidates.filter((candidate) => candidate.segStart != null).length,
            approved: candidates.filter((candidate) => candidate.state === "approved").length,
            rejected: candidates.filter((candidate) => candidate.state === "rejected").length,
          };
        }
      }
      return { project, revision, revisions, beats, candidates, status };
    }),

  submitScript: publicQuery
    .input(ControlSchemas.scriptIngress)
    .mutation(async ({ input }) => {
      return upsertScriptProject(input);
    }),

  runPipeline: publicQuery
    .input(
      z.object({
        projectId: z.number(),
        stages: z.array(z.enum(["analyze", "discover", "index", "rank"])).default(["analyze", "discover", "index", "rank"]),
        onlyProviders: z.array(z.string()).optional(),
        onlyBeats: z.array(z.number()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out: Record<string, unknown> = {};
      if (input.stages.includes("analyze")) out.analyze = await runAnalyze(input.projectId);
      if (input.stages.includes("discover")) out.discover = await runDiscover(input.projectId, { onlyProviders: input.onlyProviders, onlyBeats: input.onlyBeats });
      if (input.stages.includes("rank")) out.rank = await runRank(input.projectId);
      return { stages: out, status: await getProjectStatus(input.projectId) };
    }),

  importUrl: publicQuery
    .input(z.object({ projectId: z.number(), url: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const res = await analyzeYouTubeUrl(input.url);
      if ("error" in res) throw new Error(res.error);
      return { videoFk: res.videoFk, videoId: res.videoId };
    }),

  addMomentToProject: publicQuery
    .input(
      z.object({
        projectId: z.number(),
        beatId: z.number(),
        momentId: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, input.projectId));
      if (!project) throw new Error("Project not found.");
      const [beat] = await db.select().from(scriptBeats).where(eq(scriptBeats.id, input.beatId));
      if (!beat || Number(beat.projectFk) !== input.projectId) throw new Error("That beat does not belong to the selected project.");
      const [moment] = await db.select().from(moments).where(eq(moments.id, input.momentId));
      if (!moment) throw new Error("Saved clip not found.");
      const [video] = await db.select().from(videos).where(eq(videos.id, moment.videoFk));
      if (!video) throw new Error("The saved clip's source video is missing.");

      const editIn = Math.max(0, moment.start);
      const editOut = moment.end != null && moment.end > editIn ? moment.end : editIn + 3;
      const existing = await db.select().from(clipCandidates).where(eq(clipCandidates.beatFk, beat.id));
      const duplicate = existing.find((candidate) =>
        Number(candidate.videoFk) === Number(video.id)
        && Math.abs((candidate.editIn ?? -1) - editIn) < 0.001
        && Math.abs((candidate.editOut ?? -1) - editOut) < 0.001,
      );
      if (duplicate) return { ok: true, candidateId: Number(duplicate.id), duplicate: true };

      const inserted = await db.insert(clipCandidates).values({
        projectFk: project.id,
        revisionFk: beat.revisionFk,
        beatFk: beat.id,
        provider: "single-video",
        videoFk: video.id,
        sourceUrl: video.url,
        sourceAccount: video.channel,
        title: moment.title || video.title || video.videoId,
        durationSec: video.durationSec,
        thumbnailUrl: video.thumbnail,
        matchKind: "manual_review",
        transcriptExcerpt: moment.excerpt,
        segStart: editIn,
        segEnd: editOut,
        editIn,
        editOut,
        reason: "Added from Single Video saved clips.",
        acquisitionStatus: "library",
        state: "approved",
        userNotes: moment.note,
      });
      const candidateId = Number(inserted[0].insertId);
      return { ok: true, candidateId, duplicate: false };
    }),

  updateCandidate: publicQuery
    .input(
      z.object({
        id: z.number(),
        state: z.enum(["undecided", "approved", "rejected"]).optional(),
        userNotes: z.string().nullable().optional(),
        editIn: z.number().nullable().optional(),
        editOut: z.number().nullable().optional(),
        relevanceScore: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await getDb().update(clipCandidates).set(clean).where(eq(clipCandidates.id, id));
      return { ok: true };
    }),

  updateBeat: publicQuery
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["pending", "covered", "needs_footage"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      await getDb().update(scriptBeats).set(patch).where(eq(scriptBeats.id, id));
      return { ok: true };
    }),

  updateProject: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        prerollSec: z.number().optional(),
        postrollSec: z.number().optional(),
        defaultClipLenSec: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await getDb().update(scriptProjects).set(clean).where(eq(scriptProjects.id, id));
      return { ok: true };
    }),

  projectDeletionPreview: publicQuery
    .input(z.object({ ids: z.array(z.number().int().positive()).min(1) }))
    .query(async ({ input }) => getProjectDeletionPreview(input.ids)),

  deleteProjectsAndClips: publicQuery
    .input(z.object({
      ids: z.array(z.number().int().positive()).min(1),
      confirmation: z.literal("DELETE"),
    }))
    .mutation(async ({ input }) => deleteProjectsAndClips(input.ids)),

  deleteProject: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(clipCandidates).where(eq(clipCandidates.projectFk, input.id));
      await db.delete(scriptBeats).where(eq(scriptBeats.projectFk, input.id));
      await db.delete(scriptRevisions).where(eq(scriptRevisions.projectFk, input.id));
      await db.delete(scriptProjects).where(eq(scriptProjects.id, input.id));
      return { ok: true };
    }),
});
