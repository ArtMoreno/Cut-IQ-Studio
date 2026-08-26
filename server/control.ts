/**
 * Cut IQ control interface — localhost JSON API for the Script/Project
 * workflow. Mounted at /api/control/*.
 *
 * Error shape is stable: { "ok": false, "code": "...", "message": "..." }.
 * Codes: BAD_REQUEST, NOT_FOUND, PIPELINE_FAILED, AUTH.
 */
import { Hono, type Context } from "hono";
import { ControlSchemas } from "./script/providers";
import {
  getProjectStatus,
  runAnalyze,
  runDiscover,
  runRank,
  upsertScriptProject,
} from "./script/pipeline";
import { analyzeYouTubeUrl, listProviders } from "./script/providers";
import { getDb } from "./queries/connection";
import { scriptProjects } from "@db/schema";
import { eq, desc } from "drizzle-orm";
import { findJobs } from "@db/schema";
import { createFindJobSchema, runDiagnostics } from "./findClipsRouter";
import {
  createFindJob,
  findJobDetail,
  findWorkerStatus,
  listFindJobs,
  setFindJobAction,
} from "./findClips/engine";

export const control = new Hono();

function err(c: Context, code: string, message: string, status: 400 | 401 | 404 | 500) {
  return c.json({ ok: false, code, message }, status);
}

function requireControlToken(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const required = process.env.CLIPSIFT_CONTROL_TOKEN ?? "";
  if (!required) return true; // localhost-only deployment without token
  const got = c.req.header("x-clipsift-token") ?? "";
  return got === required;
}

control.get("/health", (c) => {
  return c.json({
    ok: true,
    app: "Cut IQ Web",
    mode: "script_project_control",
    version: "1.0.0",
    providers: listProviders(),
  });
});

control.get("/providers", (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  return c.json({ ok: true, providers: listProviders() });
});

control.post("/project/upsert", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(c, "BAD_REQUEST", "Body must be valid JSON.", 400);
  }
  const parsed = ControlSchemas.scriptIngress.safeParse(body);
  if (!parsed.success) {
    return err(c, "BAD_REQUEST", `Invalid script ingress: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 400);
  }
  const result = await upsertScriptProject(parsed.data);
  return c.json({ ok: true, ...result });
});

control.post("/project/run", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(c, "BAD_REQUEST", "Body must be valid JSON.", 400);
  }
  const parsed = ControlSchemas.runStages.safeParse(body);
  if (!parsed.success) {
    return err(c, "BAD_REQUEST", `Invalid run request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 400);
  }
  const { projectId, stages, onlyProviders, onlyBeats } = parsed.data;
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, projectId));
  if (!project) return err(c, "NOT_FOUND", `Project ${projectId} not found.`, 404);

  const stageResults: Record<string, unknown> = {};
  try {
    if (stages.includes("analyze")) stageResults.analyze = await runAnalyze(projectId);
    if (stages.includes("discover")) stageResults.discover = await runDiscover(projectId, { onlyProviders, onlyBeats });
    if (stages.includes("index")) stageResults.index = { note: "Transcript indexing happens during discovery via the existing transcript engine." };
    if (stages.includes("rank")) stageResults.rank = await runRank(projectId);
  } catch (e) {
    return err(c, "PIPELINE_FAILED", e instanceof Error ? e.message : String(e), 500);
  }
  const status = await getProjectStatus(projectId);
  return c.json({ ok: true, projectId, stages: stageResults, status });
});

control.get("/project/:id/status", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return err(c, "BAD_REQUEST", "Project id must be a number.", 400);
  try {
    const status = await getProjectStatus(id);
    return c.json({ ok: true, status });
  } catch (e) {
    return err(c, "NOT_FOUND", e instanceof Error ? e.message : String(e), 404);
  }
});

control.get("/project/:id/open", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return err(c, "BAD_REQUEST", "Project id must be a number.", 400);
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, id));
  if (!project) return err(c, "NOT_FOUND", `Project ${id} not found.`, 404);
  // The UI deep-link — opening it is done by the caller (e.g. `start` on Windows).
  return c.json({ ok: true, projectId: id, url: `/?mode=script&project=${id}`, name: project.name });
});

control.post("/project/:id/import-url", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const id = Number(c.req.param("id"));
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return err(c, "BAD_REQUEST", "Body must be valid JSON.", 400);
  }
  if (!body.url) return err(c, "BAD_REQUEST", "Missing 'url'.", 400);
  const db = getDb();
  const [project] = await db.select().from(scriptProjects).where(eq(scriptProjects.id, id));
  if (!project) return err(c, "NOT_FOUND", `Project ${id} not found.`, 404);
  const result = await analyzeYouTubeUrl(body.url);
  if ("error" in result) return err(c, "PIPELINE_FAILED", result.error, 500);
  return c.json({ ok: true, videoFk: result.videoFk, videoId: result.videoId, note: "Indexed into the library. Rerun discover to match it against beats." });
});

control.get("/projects", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const rows = await getDb().select().from(scriptProjects).orderBy(desc(scriptProjects.updatedAt));
  return c.json({ ok: true, projects: rows });
});

// Stable, caller-independent Find Clips controller. The desktop UI and every
// operator use these same durable jobs; the HTTP request never supervises the
// production pipeline after creation.
control.post("/job/create", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return err(c, "BAD_REQUEST", "Body must be valid JSON.", 400);
  }
  const parsed = createFindJobSchema.safeParse(body);
  if (!parsed.success) return err(c, "BAD_REQUEST", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), 400);
  const job = await createFindJob(parsed.data);
  return c.json({ ok: true, job });
});

control.get("/jobs", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  return c.json({ ok: true, jobs: await listFindJobs(), worker: findWorkerStatus() });
});

control.get("/worker/status", (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  return c.json({ ok: true, worker: findWorkerStatus() });
});

control.get("/doctor", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const checks = await runDiagnostics(c.req.query("network") === "1");
  return c.json({ ok: !checks.some((check) => check.status === "fail"), checks });
});

control.get("/job/:id", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return err(c, "BAD_REQUEST", "Job id must be a number.", 400);
  try {
    return c.json({ ok: true, ...(await findJobDetail(id)) });
  } catch (error) {
    return err(c, "NOT_FOUND", error instanceof Error ? error.message : String(error), 404);
  }
});

control.post("/job/:id/:action", async (c) => {
  if (!requireControlToken(c)) return err(c, "AUTH", "Missing or invalid x-clipsift-token.", 401);
  const id = Number(c.req.param("id"));
  const action = c.req.param("action") as "start" | "pause" | "resume" | "cancel" | "retry";
  if (!Number.isFinite(id) || !["start", "pause", "resume", "cancel", "retry"].includes(action)) {
    return err(c, "BAD_REQUEST", "Use start, pause, resume, cancel, or retry with a numeric job id.", 400);
  }
  const [job] = await getDb().select().from(findJobs).where(eq(findJobs.id, id));
  if (!job) return err(c, "NOT_FOUND", `Find Clips job ${id} not found.`, 404);
  await setFindJobAction(id, action);
  return c.json({ ok: true, id, action });
});
