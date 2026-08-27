import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { findJobs } from "@db/schema";
import {
  createFindJob,
  findJobDetail,
  findWorkerStatus,
  listFindJobs,
  setFindJobAction,
} from "./findClips/engine";
import { CLIPSIFT_RUNTIME_PATHS } from "./runtimePaths";

const execFileP = promisify(execFile);

export const highlightTunerSchema = z.object({
  mode: z.enum(["everything", "balanced", "highlights", "best_only", "custom"]),
  maxClipsPerGame: z.number().int().min(1).max(50).optional(),
  minimumEstimatedYards: z.number().int().min(0).max(99).optional(),
  minimumExcitement: z.number().int().min(0).max(25).optional(),
  includeProbablePlays: z.boolean().optional(),
  alwaysIncludeTouchdowns: z.boolean().optional(),
  includeKeyDowns: z.boolean().optional(),
  includeRedZonePlays: z.boolean().optional(),
}).strict();

export const createFindJobSchema = z.object({
  player: z.string().min(1).max(255),
  team: z.string().min(1).max(255),
  season: z.number().int().min(1900).max(2200),
  opponent: z.string().max(255).optional(),
  scriptText: z.string().trim().max(100_000).optional().default(""),
  projectName: z.string().max(255).optional(),
  sourceLimit: z.number().int().min(1).max(200).default(60),
  clipLimit: z.number().int().min(1).max(500).default(100),
  preferredHeight: z.number().int().min(720).max(4320).default(1080),
  minimumHeight: z.number().int().min(720).max(2160).default(720),
  preRollSec: z.number().min(0).max(60).default(10),
  postRollSec: z.number().min(0).max(90).default(15),
  localAsrFallback: z.boolean().default(true),
  highlightTuner: highlightTunerSchema.optional(),
  autoStart: z.boolean().default(true),
}).refine((input) => input.preferredHeight >= input.minimumHeight, {
  message: "Preferred quality must be at least the minimum quality.",
  path: ["preferredHeight"],
});

export function buildFindClipsCoverageBrief(input: {
  player: string;
  team: string;
  season: number;
  opponent?: string;
  scriptText?: string;
}): string {
  const supplied = input.scriptText?.trim() ?? "";
  if (supplied.length >= 20) return supplied;
  const games = input.opponent?.trim();
  const scope = games
    ? `Focus on these games or opponents: ${games.replaceAll(/\r?\n/g, ", ")}.`
    : `Search every available ${input.team} game from the ${input.season} season.`;
  const notes = supplied ? `Additional user note: ${supplied}.` : "";
  return [
    `Find and clip football plays featuring ${input.player} for ${input.team} during the ${input.season} season.`,
    scope,
    `Prioritize plays where ${input.player} is directly involved, clearly identified, or central to the result of the play.`,
    `Include enough setup before the snap and enough aftermath, replay, or broadcast identification after the play for full context.`,
    `Also identify broadcast video sound bites where announcers discuss ${input.player} or the broadcast shows the player while providing useful context.`,
    notes,
  ].filter(Boolean).join(" ");
}

type Diagnostic = { id: string; label: string; status: "pass" | "warning" | "fail"; detail: string };

export async function runDiagnostics(includeNetwork: boolean): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  try {
    getDb().$client.prepare("select 1").get();
    out.push({ id: "database", label: "App database", status: "pass", detail: "SQLite responded." });
  } catch (error) {
    out.push({ id: "database", label: "App database", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }
  const paths = [
    ["yt-dlp", "Cut IQ yt-dlp", CLIPSIFT_RUNTIME_PATHS.ytDlp],
    ["ffmpeg", "Cut IQ FFmpeg", CLIPSIFT_RUNTIME_PATHS.ffmpeg],
    ["ffprobe", "Cut IQ ffprobe", CLIPSIFT_RUNTIME_PATHS.ffprobe],
    ["python", "Cut IQ transcription Python", CLIPSIFT_RUNTIME_PATHS.whisperPython],
    ["whisper", "Cut IQ Whisper model", CLIPSIFT_RUNTIME_PATHS.whisperModel],
  ] as const;
  for (const [id, label, path] of paths) {
    out.push({ id, label, status: existsSync(path) ? "pass" : id === "whisper" || id === "python" ? "warning" : "fail", detail: existsSync(path) ? path : `Not found: ${path}` });
  }
  try {
    const drive = statfsSync("D:/");
    const freeBytes = Number(drive.bavail) * Number(drive.bsize);
    const freeGb = freeBytes / 1024 ** 3;
    out.push({ id: "storage", label: "D: free space", status: freeGb >= 50 ? "pass" : freeGb >= 15 ? "warning" : "fail", detail: `${freeGb.toFixed(1)} GB free` });
  } catch (error) {
    out.push({ id: "storage", label: "D: free space", status: "fail", detail: String(error) });
  }
  out.push({ id: "worker", label: "Persistent worker", status: findWorkerStatus().started ? "pass" : "warning", detail: findWorkerStatus().started ? "Running inside the supervised Cut IQ server." : "Starts with the production server." });
  out.push({ id: "node", label: "Node runtime", status: "pass", detail: process.version });
  if (includeNetwork) {
    try {
      const { stdout } = await execFileP(
        CLIPSIFT_RUNTIME_PATHS.ytDlp,
        ["--js-runtimes", "node", "--skip-download", "--dump-single-json", "--no-warnings", "https://www.youtube.com/watch?v=aOeDq1nnP6k"],
        { timeout: 45_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      const metadata = JSON.parse(stdout) as { id?: string; title?: string };
      if (!metadata.id) throw new Error("yt-dlp returned no canonical video id.");
      out.push({ id: "youtube_probe", label: "YouTube metadata probe", status: "pass", detail: `${metadata.id}: ${metadata.title ?? "metadata returned"}` });
    } catch (error) {
      out.push({ id: "youtube_probe", label: "YouTube metadata probe", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

export const findClipsRouter = createRouter({
  create: publicQuery.input(createFindJobSchema).mutation(({ input }) => createFindJob({
    ...input,
    scriptText: buildFindClipsCoverageBrief(input),
  })),
  list: publicQuery.query(() => listFindJobs()),
  detail: publicQuery.input(z.object({ id: z.number() })).query(({ input }) => findJobDetail(input.id)),
  byProject: publicQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input }) => {
      const [job] = await getDb().select().from(findJobs).where(eq(findJobs.projectFk, input.projectId));
      return job ?? null;
    }),
  action: publicQuery
    .input(z.object({ id: z.number(), action: z.enum(["start", "pause", "resume", "cancel", "retry"]) }))
    .mutation(async ({ input }) => {
      await setFindJobAction(input.id, input.action);
      return { ok: true };
    }),
  worker: publicQuery.query(() => findWorkerStatus()),
  diagnostics: publicQuery
    .input(z.object({ includeNetwork: z.boolean().default(false) }))
    .query(({ input }) => runDiagnostics(input.includeNetwork)),
});
