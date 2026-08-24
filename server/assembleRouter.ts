/**
 * Assemble — tRPC router for the script/voiceover → timeline editor.
 *
 * Persistence contract:
 *  - The project's canonical state is the versioned `doc` JSON (AssembleDoc).
 *  - Every save writes an autosave snapshot; the latest doc is recoverable.
 *  - The clip manifest is derived on demand from the source script project
 *    (harvest, never re-compute) and is exportable to the job folder.
 */
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { assembleAutosaves, assembleProjects } from "@db/schema";
import { defaultDoc, parseAssembleDoc, type PresetId } from "./assemble/project";
import { buildProjectManifest } from "./assemble/manifest";
import { harvestCscJob, listCscJobSlugs } from "./assemble/cscHarvest";
import { beatsFromScript, alignBeatsToNarration } from "./assemble/beatAnalysis";
import { renderProject } from "./assemble/render";
import { rankClipsForBeat } from "./assemble/match";
import { autoAssemble } from "./assemble/assemble";
import { transcribeVoiceover } from "./assemble/voiceover";

const docSchema = z.unknown(); // validated by parseAssembleDoc (schema-version gate)

export const assembleRouter = createRouter({
  listProjects: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db.select().from(assembleProjects).orderBy(desc(assembleProjects.updatedAt));
    return rows.map((p) => ({
      id: Number(p.id),
      name: p.name,
      preset: p.preset,
      status: p.status,
      sourceProjectFk: p.sourceProjectFk ? Number(p.sourceProjectFk) : null,
      sourceCscSlug: p.sourceCscSlug ?? null,
      updatedAt: p.updatedAt,
    }));
  }),

  create: publicQuery
    .input(
      z.object({
        name: z.string().min(1),
        preset: z.enum(["csc-vertical", "youtube-16x9", "square"]).default("csc-vertical"),
        sourceProjectFk: z.number().optional(),
        sourceCscSlug: z.string().optional(),
        scriptText: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const doc = defaultDoc(input.name, input.preset as PresetId, input.scriptText ?? null);
      const [ins] = await db
        .insert(assembleProjects)
        .values({
          name: input.name,
          sourceProjectFk: input.sourceProjectFk ?? null,
          sourceCscSlug: input.sourceCscSlug ?? null,
          doc: JSON.stringify(doc),
          preset: input.preset,
          status: "draft",
        })
        .$returningId();
      return { id: Number(ins.id) };
    }),

  open: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = getDb();
    const [project] = await db.select().from(assembleProjects).where(eq(assembleProjects.id, input.id));
    if (!project) throw new Error("Assemble project not found.");
    return {
      id: Number(project.id),
      name: project.name,
      preset: project.preset,
      status: project.status,
      sourceProjectFk: project.sourceProjectFk ? Number(project.sourceProjectFk) : null,
      sourceCscSlug: project.sourceCscSlug ?? null,
      doc: parseAssembleDoc(JSON.parse(project.doc), project.name),
    };
  }),

  save: publicQuery
    .input(
      z.object({
        id: z.number(),
        doc: docSchema,
        reason: z.string().default("autosave"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [project] = await db.select().from(assembleProjects).where(eq(assembleProjects.id, input.id));
      if (!project) throw new Error("Assemble project not found.");
      const doc = parseAssembleDoc(input.doc, project.name);
      const serialized = JSON.stringify(doc);
      await db.insert(assembleAutosaves).values({
        projectFk: input.id,
        doc: serialized,
        reason: input.reason,
      });
      await db.update(assembleProjects).set({ doc: serialized }).where(eq(assembleProjects.id, input.id));
      return { ok: true };
    }),

  restoreAutosave: publicQuery
    .input(z.object({ projectId: z.number(), autosaveId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const [snapshot] = await db
        .select()
        .from(assembleAutosaves)
        .where(eq(assembleAutosaves.id, input.autosaveId));
      if (!snapshot || Number(snapshot.projectFk) !== input.projectId) {
        throw new Error("Autosave not found for this project.");
      }
      await db
        .update(assembleProjects)
        .set({ doc: snapshot.doc })
        .where(eq(assembleProjects.id, input.projectId));
      return { ok: true };
    }),

  listAutosaves: publicQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(assembleAutosaves)
        .where(eq(assembleAutosaves.projectFk, input.projectId))
        .orderBy(desc(assembleAutosaves.id))
        .limit(50);
      return rows.map((r) => ({
        id: Number(r.id),
        reason: r.reason,
        createdAt: r.createdAt,
      }));
    }),

  // Derive the canonical clip manifest from the source script project.
  manifest: publicQuery
    .input(z.object({ sourceProjectId: z.number(), renderedOnly: z.boolean().default(true) }))
    .query(async ({ input }) => {
      return buildProjectManifest(input.sourceProjectId, { renderedOnly: input.renderedOnly });
    }),

  // List the automation pipeline's CSC job folders (the real production output).
  listCscJobs: publicQuery.query(() => listCscJobSlugs()),

  // Derive a manifest from an on-disk CSC job folder (03_clips/best + render list).
  cscManifest: publicQuery
    .input(z.object({ slug: z.string().min(1) }))
    .query(async ({ input }) => {
      return harvestCscJob(input.slug);
    }),

  updateStatus: publicQuery
    .input(z.object({ id: z.number(), status: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await getDb().update(assembleProjects).set({ status: input.status }).where(eq(assembleProjects.id, input.id));
      return { ok: true };
    }),

  // Analyze a script into ordered beats (reuses Cut IQ's analyzeScript).
  analyzeScript: publicQuery
    .input(z.object({ scriptText: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { beats } = beatsFromScript(input.scriptText);
      return { beats };
    }),

  // Rank candidate clips for a single beat (explainable scores + reasons).
  rankBeat: publicQuery
    .input(
      z.object({
        beat: z.object({
          id: z.string(),
          ord: z.number(),
          text: z.string(),
          intent: z.array(z.string()).default([]),
          entities: z.array(z.string()).default([]),
          queries: z.array(z.string()).default([]),
          beatType: z.enum(["footage", "graphic", "montage", "no-clip"]).default("footage"),
          narrationStart: z.number().nullable().default(null),
          narrationEnd: z.number().nullable().default(null),
          locked: z.boolean().default(false),
          unresolved: z.boolean().default(false),
        }),
        clips: z.array(z.unknown()),
      }),
    )
    .mutation(async ({ input }) => {
      return rankClipsForBeat(input.beat, input.clips as never[]);
    }),

  // Auto-assemble beats + clips into a V1 timeline (with honest placeholders).
  autoAssemble: publicQuery
    .input(
      z.object({
        beats: z.array(z.unknown()),
        clips: z.array(z.unknown()),
        lockedBeatIds: z.array(z.string()).default([]),
        preserveItems: z.array(z.unknown()).default([]),
      }),
    )
    .mutation(async ({ input }) => {
      return autoAssemble(input.beats as never[], input.clips as never[], {
        lockedBeatIds: new Set(input.lockedBeatIds),
        preserveItems: input.preserveItems as never[],
      });
    }),

  // Transcribe a local narration file into timed segments (local faster-whisper).
  transcribeVoiceover: publicQuery
    .input(z.object({ audioPath: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return transcribeVoiceover(input.audioPath);
    }),

  // Transcribe a narration file AND align script beats to real VO timing.
  alignVoiceover: publicQuery
    .input(
      z.object({
        audioPath: z.string().min(1),
        beats: z.array(z.unknown()),
      }),
    )
    .mutation(async ({ input }) => {
      const vo = await transcribeVoiceover(input.audioPath);
      const { beats, confidence } = alignBeatsToNarration(input.beats as never[], vo.segments);
      return { segments: vo.segments, lang: vo.lang, duration: vo.duration, beats, confidence };
    }),

  // Render the project's timeline to an H.264/AAC mp4 (local, verified).
  // Caller picks the export folder + filename (must live inside D:\Clips).
  render: publicQuery
    .input(
      z.object({
        id: z.number(),
        burnCaptions: z.boolean().default(true),
        outputDir: z.string().min(1).optional(),
        outputName: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const [project] = await db.select().from(assembleProjects).where(eq(assembleProjects.id, input.id));
      if (!project) throw new Error("Assemble project not found.");
      const doc = parseAssembleDoc(JSON.parse(project.doc), project.name);
      await db.update(assembleProjects).set({ status: "rendering" }).where(eq(assembleProjects.id, input.id));
      const result = await renderProject(doc, project.name, {
        narrationPath: doc.narration?.sourcePath ?? null,
        captions: input.burnCaptions ? (doc.narration?.segments ?? undefined) : undefined,
        outputDir: input.outputDir,
        outputName: input.outputName,
      });
      await db
        .update(assembleProjects)
        .set({ status: result.ok ? "rendered" : "failed", renderLog: JSON.stringify({ at: new Date().toISOString(), ok: result.ok, error: result.error, outputPath: result.outputPath }) })
        .where(eq(assembleProjects.id, input.id));
      return result;
    }),

  // Sensible export locations for the picker (job-local exports first).
  listExportLocations: publicQuery
    .input(z.object({ slug: z.string().optional() }))
    .query(({ input }) => {
      const locations: Array<{ label: string; path: string }> = [];
      if (input.slug) {
        locations.push({ label: "Job exports folder (recommended)", path: `D:/Clips/csc_jobs/${input.slug}/assemble/exports` });
      }
      locations.push(
        { label: "All Assemble exports", path: "D:/Clips/csc_jobs/.assemble-exports" },
        { label: "Clips root", path: "D:/Clips" },
      );
      return locations;
    }),

  // Reveal a rendered file in Windows Explorer (selects the file).
  revealInExplorer: publicQuery
    .input(z.object({ path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { spawn } = await import("node:child_process");
      if (!existsSync(input.path)) throw new Error("File no longer exists on disk.");
      spawn("explorer.exe", [`/select,${input.path.replace(/\//g, "\\")}`], { windowsHide: true, stdio: "ignore", detached: true }).unref();
      return { ok: true };
    }),
});
