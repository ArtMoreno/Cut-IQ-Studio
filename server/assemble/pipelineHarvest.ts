/**
 * pipeline job folder harvest — read the automation pipeline's on-disk output
 * (D:\Clips\pipeline_jobs\<slug>) into a clip manifest.
 *
 * Two on-disk formats exist in Art's production jobs:
 *   A. `clips_to_render.txt` at the job root (mark-fletcher-jr-power-2025)
 *   B. `00_job/clip_manifest.csv` (+ `00_job/beat_map.csv`) with full
 *      provenance: source URL/title, player, opponent, verification flags,
 *      local paths, broadcast timecodes (malachi-toney-yac-2025,
 *      miami-football-hype-2026)
 *
 * This harvester reads BOTH, preferring (A) when present. Source in/out are
 * always CLIP-RELATIVE (0..duration) because exported clips are self-contained
 * padded segments; broadcast timecodes are preserved in queryContext as
 * provenance, never used as trim offsets.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ClipManifest, ManifestClip } from "./manifest";
import { clipDownloadUrl } from "./manifest";
import { probeMedia } from "../clip/mediaProbe";

const PIPELINE_JOBS_ROOT = process.env.PIPELINE_JOBS_ROOT || "D:/Clips/pipeline_jobs";

export interface ParsedClipLine {
  code: string;
  videoId: string;
  inSec: number;
  outSec: number;
  description: string;
  game: string | null;
}

/**
 * Parse `clips_to_render.txt` into clip entries. The file uses:
 *   # N. GAMETAG: "commentary quote" (1234s)
 *   code=VIDEOID|in_sec|out_sec|"description"
 * Comment lines provide the game tag; only well-formed data lines are returned.
 */
export function parseClipsToRender(text: string): ParsedClipLine[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ParsedClipLine[] = [];
  let currentGame: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = /^#\s*\d*\.?\s*([A-Za-z0-9@ .&'-]+?)\s*:/.exec(line);
      if (m) currentGame = m[1].trim() || null;
      continue;
    }
    // data line: code=VIDEOID|in|out|"description"
    const m = /^([\w-]+)\s*=\s*([A-Za-z0-9_-]{11})\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*"([^"]*)"\s*$/.exec(line);
    if (!m) continue;
    const inSec = Number(m[3]);
    const outSec = Number(m[4]);
    if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec) continue;
    out.push({ code: m[1], videoId: m[2], inSec, outSec, description: m[5], game: currentGame });
  }
  return out;
}

// ── CSV parsing (clip_manifest.csv / beat_map.csv) ──────────────────────────

/** Minimal CSV parser handling BOM, CRLF, and quoted fields. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export interface ManifestCsvRow {
  clipId: string;
  beatId: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceVideoId: string;
  inTc: string;
  outTc: string;
  player: string;
  team: string;
  season: string;
  opponent: string;
  localPath: string;
  identityVerified: boolean;
  actionVerified: boolean;
}

/** Parse `00_job/clip_manifest.csv` into typed rows (header-driven). */
export function parseClipManifestCsv(text: string): ManifestCsvRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    clipId: col("clip_id"),
    beatId: col("beat_id"),
    sourceUrl: col("source_url"),
    sourceTitle: col("source_title"),
    sourceVideoId: col("source_video_id"),
    inTc: col("in_tc"),
    outTc: col("out_tc"),
    player: col("player"),
    team: col("team"),
    season: col("season"),
    opponent: col("opponent"),
    localPath: col("local_path"),
    identityVerified: col("identity_verified"),
    actionVerified: col("action_verified"),
  };
  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : "");

  return rows.slice(1).map((r) => ({
    clipId: get(r, idx.clipId),
    beatId: get(r, idx.beatId),
    sourceUrl: get(r, idx.sourceUrl),
    sourceTitle: get(r, idx.sourceTitle),
    sourceVideoId: get(r, idx.sourceVideoId),
    inTc: get(r, idx.inTc),
    outTc: get(r, idx.outTc),
    player: get(r, idx.player),
    team: get(r, idx.team),
    season: get(r, idx.season),
    opponent: get(r, idx.opponent),
    localPath: get(r, idx.localPath),
    identityVerified: get(r, idx.identityVerified).toLowerCase() === "true",
    actionVerified: get(r, idx.actionVerified).toLowerCase() === "true",
  }));
}

export interface BeatMapRow {
  beatId: string;
  order: number;
  scriptLine: string;
  opponent: string;
  aliases: string[];
}

/** Parse `00_job/beat_map.csv` (per-beat script line + search aliases). */
export function parseBeatMapCsv(text: string): BeatMapRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    beatId: col("beat_id"),
    order: col("order"),
    scriptLine: col("script_line"),
    opponent: col("opponent"),
    aliases: col("search_aliases"),
  };
  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : "");
  return rows.slice(1).map((r) => ({
    beatId: get(r, idx.beatId),
    order: Number(get(r, idx.order)) || 0,
    scriptLine: get(r, idx.scriptLine),
    opponent: get(r, idx.opponent),
    aliases: get(r, idx.aliases)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
  }));
}

/** Parse a timecode like "00:58:40", "38:11", or plain seconds into seconds. */
export function parseTimecode(tc: string): number | null {
  const t = tc.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

/** List available pipeline job slugs (directories with a `00_job` folder). */
export function listPipelineJobSlugs(): string[] {
  const root = resolve(PIPELINE_JOBS_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "00_job")))
    .map((e) => e.name)
    .sort();
}

/** Best-effort parse of a JOB_SPEC.md line like `Subject: X` / `Team: Y` / `Season: Z`. */
function jobSpecField(spec: string, key: string): string | null {
  const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im").exec(spec);
  return m ? m[1].trim() : null;
}

/** Map a clips_to_render.txt code like `nd`/`ind3` to a readable game tag. */
export function gameFromCode(code: string): string | null {
  const base = code.replace(/\d+$/, "").toLowerCase();
  const map: Record<string, string> = {
    nd: "Notre Dame",
    usf: "South Florida",
    stan: "Stanford",
    smu: "SMU",
    pitt: "Pitt",
    miss: "Ole Miss",
    ind: "Indiana",
    bc: "Bethune-Cookman",
    lou: "Louisville",
    clem: "Clemson",
    uf: "Florida",
  };
  return map[base] ?? null;
}

export interface PipelineHarvestOptions {
  probeMedia?: boolean; // probe each mp4 for resolution/duration (default true)
}

export async function harvestPipelineJob(slug: string, opts: PipelineHarvestOptions = {}): Promise<ClipManifest> {
  const probe = opts.probeMedia ?? true;
  const jobDir = resolve(PIPELINE_JOBS_ROOT, slug);
  const clipsDir = resolve(jobDir, "03_clips", "best");
  const specPath = join(jobDir, "00_job", "JOB_SPEC.md");
  const statePath = join(jobDir, "00_job", "JOB_STATE.json");
  const renderListPath = join(jobDir, "clips_to_render.txt");
  const manifestCsvPath = join(jobDir, "00_job", "clip_manifest.csv");
  const beatMapPath = join(jobDir, "00_job", "beat_map.csv");

  if (!existsSync(jobDir)) throw new Error(`pipeline job "${slug}" not found.`);

  const spec = existsSync(specPath) ? readFileSync(specPath, "utf8") : "";
  const subject = jobSpecField(spec, "Subject") ?? jobSpecField(spec, "Topic") ?? slug;
  const team = jobSpecField(spec, "Team");
  const season = jobSpecField(spec, "Season");

  const beatMap = new Map<string, BeatMapRow>();
  if (existsSync(beatMapPath)) {
    for (const b of parseBeatMapCsv(readFileSync(beatMapPath, "utf8"))) beatMap.set(b.beatId, b);
  }

  // On-disk mp4 files in the best folder, keyed by leading index and by name.
  const files = existsSync(clipsDir) ? readdirSync(clipsDir).filter((f) => /\.mp4$/i.test(f)) : [];
  const fileByIndex = new Map<number, string>();
  const fileByName = new Map<string, string>();
  for (const f of files) {
    fileByName.set(f.toLowerCase(), f);
    const m = /^(\d+)[_-]/.exec(f);
    if (m) fileByIndex.set(Number(m[1]), f);
  }

  let clips: ManifestClip[] = [];

  if (existsSync(renderListPath)) {
    clips = await harvestFromRenderList(slug, renderListPath, clipsDir, fileByIndex, probe);
  } else if (existsSync(manifestCsvPath)) {
    clips = await harvestFromManifestCsv(slug, manifestCsvPath, clipsDir, fileByName, beatMap, probe);
  } else {
    clips = await harvestFromDirectory(slug, clipsDir, files, probe);
  }

  // Read the automation job state (summary counts/notes) for the manifest.
  let state: { clips_total?: number; clips_uploaded?: number; notes?: string } = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
    } catch {
      // ignore malformed state; the clip list still stands
    }
  }
  const totalExpected = typeof state.clips_total === "number" ? state.clips_total : clips.length;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectId: 0,
    projectName: slug,
    topic: subject ?? null,
    player: { name: subject ?? slug, team: team ?? null, season: season ?? null },
    clips,
    unresolvedBeats: clips.length < totalExpected ? [clips.length] : [],
  };
}

// ── Format A: clips_to_render.txt ───────────────────────────────────────────

async function harvestFromRenderList(
  slug: string,
  renderListPath: string,
  clipsDir: string,
  fileByIndex: Map<number, string>,
  probe: boolean,
): Promise<ManifestClip[]> {
  const parsed = parseClipsToRender(readFileSync(renderListPath, "utf8"));
  const clips: ManifestClip[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const fileName = fileByIndex.get(i + 1) ?? null;
    const localPath = fileName ? join(clipsDir, fileName) : null;
    const probed = await maybeProbe(probe, localPath);
    const game = p.game ?? gameFromCode(p.code);
    clips.push({
      clipId: `job-${slug}-${i + 1}`,
      candidateId: 0,
      beatOrd: i,
      beatText: "",
      game,
      opponent: game ?? null,
      sourceUrl: `https://www.youtube.com/watch?v=${p.videoId}`,
      sourceVideoId: p.videoId,
      localPath,
      downloadUrl: clipDownloadUrl(localPath),
      drivePath: null,
      // CLIP-RELATIVE: exported clips are self-contained padded segments.
      sourceStartSeconds: 0,
      sourceEndSeconds: probed.duration ?? Math.max(1, p.outSec - p.inSec),
      clipDurationSeconds: probed.duration ?? p.outSec - p.inSec,
      resolution: probed.resolution,
      container: "mp4",
      codec: null,
      playerMention: { text: p.description, timeSeconds: null },
      queryContext: [`source ${p.inSec}s–${p.outSec}s`],
      coverageTypes: [],
      purpose: null,
      transcript: { text: p.description, segmentStart: null, segmentEnd: null },
      tags: [],
      verification: {
        playerVerified: true,
        contextVerified: true,
        confidence: 1,
        matchKind: "manual_review",
        reason: p.description,
      },
    });
  }
  return clips;
}

// ── Format B: 00_job/clip_manifest.csv ──────────────────────────────────────

async function harvestFromManifestCsv(
  slug: string,
  manifestCsvPath: string,
  clipsDir: string,
  fileByName: Map<string, string>,
  beatMap: Map<string, BeatMapRow>,
  probe: boolean,
): Promise<ManifestClip[]> {
  const rows = parseClipManifestCsv(readFileSync(manifestCsvPath, "utf8"));
  const clips: ManifestClip[] = [];
  let ord = 0;

  for (const r of rows) {
    if (!r.clipId) continue;

    // Resolve the media file: prefer the recorded local_path when it exists,
    // else fall back to a same-named file inside 03_clips/best.
    let localPath: string | null = null;
    const norm = (p: string) => p.replace(/\\/g, "/");
    if (r.localPath && existsSync(r.localPath)) localPath = norm(r.localPath);
    else {
      const name = r.localPath ? basename(r.localPath) : `${r.clipId}.mp4`;
      const hit = fileByName.get(name.toLowerCase());
      if (hit) localPath = join(clipsDir, hit);
    }
    if (!localPath) continue; // clip file missing on disk — skip honestly

    const probed = await maybeProbe(probe, localPath);
    const beat = beatMap.get(r.beatId);
    const inSec = parseTimecode(r.inTc);
    const outSec = parseTimecode(r.outTc);
    const game = r.opponent || beat?.opponent || null;
    const clipWords = r.clipId.replace(/\d+_/g, "").replace(/[_-]+/g, " ").trim();

    clips.push({
      clipId: `job-${slug}-${++ord}`,
      candidateId: 0,
      beatOrd: ord - 1,
      beatText: beat?.scriptLine ?? "",
      game,
      opponent: game,
      sourceUrl: r.sourceUrl || `https://www.youtube.com/watch?v=${r.sourceVideoId || ""}`,
      sourceVideoId: r.sourceVideoId || null,
      localPath,
      downloadUrl: clipDownloadUrl(localPath),
      drivePath: null,
      // CLIP-RELATIVE window; broadcast TC preserved as provenance below.
      sourceStartSeconds: 0,
      sourceEndSeconds: probed.duration ?? 0,
      clipDurationSeconds: probed.duration,
      resolution: probed.resolution,
      container: "mp4",
      codec: null,
      playerMention: { text: r.player || null, timeSeconds: null },
      queryContext: [
        ...(beat?.aliases ?? []),
        ...(inSec != null && outSec != null ? [`source ${r.inTc}–${r.outTc}`] : []),
      ],
      coverageTypes: [],
      purpose: null,
      transcript: { text: [clipWords, r.sourceTitle].filter(Boolean).join(" — "), segmentStart: null, segmentEnd: null },
      tags: [],
      verification: {
        playerVerified: r.identityVerified,
        contextVerified: r.actionVerified,
        confidence: r.identityVerified && r.actionVerified ? 1 : 0.6,
        matchKind: "manual_review",
        reason: beat?.scriptLine ?? r.sourceTitle,
      },
    });
  }
  return clips;
}

// ── Fallback: bare directory scan ───────────────────────────────────────────

async function harvestFromDirectory(slug: string, clipsDir: string, files: string[], probe: boolean): Promise<ManifestClip[]> {
  const clips: ManifestClip[] = [];
  let ord = 0;
  for (const f of files) {
    const localPath = join(clipsDir, f);
    const probed = await maybeProbe(probe, localPath);
    clips.push({
      clipId: `job-${slug}-${++ord}`,
      candidateId: 0,
      beatOrd: ord - 1,
      beatText: "",
      game: null,
      opponent: null,
      sourceUrl: "",
      sourceVideoId: null,
      localPath,
      downloadUrl: clipDownloadUrl(localPath),
      drivePath: null,
      sourceStartSeconds: 0,
      sourceEndSeconds: probed.duration ?? 0,
      clipDurationSeconds: probed.duration,
      resolution: probed.resolution,
      container: "mp4",
      codec: null,
      playerMention: { text: null, timeSeconds: null },
      queryContext: [],
      coverageTypes: [],
      purpose: null,
      transcript: { text: f.replace(/\.mp4$/i, "").replace(/[_-]+/g, " "), segmentStart: null, segmentEnd: null },
      tags: [],
      verification: { playerVerified: false, contextVerified: false, confidence: 0.4, matchKind: "directory_scan", reason: null },
    });
  }
  return clips;
}

async function maybeProbe(
  probe: boolean,
  localPath: string | null,
): Promise<{ resolution: { width: number | null; height: number | null }; duration: number | null }> {
  if (!probe || !localPath) return { resolution: { width: null, height: null }, duration: null };
  try {
    const media = await probeMedia(localPath);
    return { resolution: { width: media.width, height: media.height }, duration: media.durationSec };
  } catch {
    return { resolution: { width: null, height: null }, duration: null };
  }
}
