/**
 * Source provider layer for Script / Project mode.
 *
 * Honest capability states per provider — nothing here pretends to fetch what
 * it cannot. YouTube search.list requires an API key; transcript fetching
 * and URL analysis work without one. Social providers expose "open external"
 * discovery links only (no scraping, no watermark handling).
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "../queries/connection";
import { transcriptSegments, videos } from "@db/schema";
import { extractVideoId, fetchVideoMeta } from "../clipsift";
import { getTranscriptProvider } from "../transcript/youtubeProvider";
import { extractQuotedPhrases, type BeatAnalysis } from "./analysis";
import { YTDLP_PATH as YTDLP_BIN } from "../runtimePaths";

const execFileP = promisify(execFile);

export type ProviderCapability =
  | "search_and_analyze" // live search + transcript/timestamp analysis
  | "url_import_analyze" // analyze a user-provided URL (transcript engine)
  | "open_external" // returns discovery links; acquisition is manual
  | "auth_required" // search exists but needs credentials
  | "unsupported";

export interface ProviderInfo {
  id: string;
  name: string;
  capability: ProviderCapability;
  capabilityReason?: string;
}

export interface NormalizedCandidate {
  provider: string;
  sourceUrl: string;
  sourceAccount: string | null;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
  videoFk: number | null; // library video row when backed by one
  transcriptExcerpt: string | null;
  segStart: number | null;
  segEnd: number | null;
  matchKind: "exact_transcript" | "strong_visual" | "probable_visual" | "broad_candidate" | "manual_review";
  reason: string;
  relevanceScore: number;
}

export interface ProviderSearchResult {
  provider: string;
  ok: boolean;
  capability: ProviderCapability;
  error?: string;
  candidates: NormalizedCandidate[];
}

const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const YT_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

function youtubeApiKey(): string {
  return process.env.CLIPSIFT_YOUTUBE_API_KEY ?? "";
}

function parseIsoDuration(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return Math.round(h * 3600 + min * 60 + s);
}

function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard-ish term overlap between a beat and candidate text (0..1). */
export function termOverlap(a: string, b: string): number {
  const ta = new Set(normalizeTerm(a).split(" ").filter((w) => w.length > 2));
  const tb = new Set(normalizeTerm(b).split(" ").filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(3, Math.min(ta.size, tb.size));
}

// ------------------------------------------------------------ registry ----

export function listProviders(): ProviderInfo[] {
  const ytKeyed = youtubeApiKey().length > 0;
  return [
    {
      id: "youtube",
      name: "YouTube",
      capability: "search_and_analyze",
      capabilityReason: ytKeyed
        ? "YouTube Data API search + caption analysis."
        : "Live search via yt-dlp (no API key needed) + caption/transcript analysis on import.",
    },
    {
      id: "library",
      name: "Cut IQ Library",
      capability: "search_and_analyze",
      capabilityReason: "Full-text search over transcripts already indexed in your library.",
    },
    {
      id: "instagram",
      name: "Instagram",
      capability: "open_external",
      capabilityReason: "No authorized Instagram search. Discovery links only — import the cleanest URL you find.",
    },
    {
      id: "tiktok",
      name: "TikTok",
      capability: "open_external",
      capabilityReason: "No authorized TikTok search. Discovery links only — import the cleanest URL you find.",
    },
    {
      id: "x",
      name: "X (Twitter)",
      capability: "open_external",
      capabilityReason: "No authorized X search. Discovery links only — import the cleanest URL you find.",
    },
  ];
}

export function providerCapability(id: string): ProviderInfo {
  return listProviders().find((p) => p.id === id) ?? { id, name: id, capability: "unsupported" as const };
}

// ----------------------------------------- youtube: keyless search (yt-dlp) --

interface YtDlpFlatEntry {
  id?: string;
  title?: string | null;
  channel?: string | null;
  duration?: number | null;
  thumbnails?: Array<{ url?: string }>;
}

/** Search YouTube without any API key, via yt-dlp's ytsearch. Honest, real results. */
export async function searchYouTubeKeyless(query: string, maxResults = 5): Promise<NormalizedCandidate[]> {
  const count = Math.min(Math.max(maxResults, 1), 20);
  let stdout: string;
  try {
    const { stdout: out } = await execFileP(
      YTDLP_BIN,
      [`ytsearch${count}:${query}`, "--flat-playlist", "-J", "--no-warnings"],
      { timeout: 45_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = out;
  } catch (err) {
    throw new Error(`yt-dlp search failed: ${String((err as Error).message ?? err)}`);
  }
  let data: { entries?: YtDlpFlatEntry[] };
  try {
    data = JSON.parse(stdout) as { entries?: YtDlpFlatEntry[] };
  } catch {
    throw new Error("yt-dlp returned non-JSON output (search may be rate-limited).");
  }
  return (data.entries ?? [])
    .filter((e) => e.id)
    .map((e) => ({
      provider: "youtube",
      sourceUrl: `https://www.youtube.com/watch?v=${e.id}`,
      sourceAccount: e.channel ?? null,
      title: e.title ?? null,
      publishedAt: null,
      durationSec: e.duration ?? null,
      thumbnailUrl: e.thumbnails?.[e.thumbnails.length - 1]?.url ?? null,
      videoFk: null,
      transcriptExcerpt: null,
      segStart: null,
      segEnd: null,
      matchKind: "broad_candidate" as const,
      reason: "YouTube search (yt-dlp, keyless) — import the cleanest match to analyze its transcript.",
      relevanceScore: 0,
    }));
}

// ------------------------------------------------- youtube: search.list ----

export async function searchYouTubeLive(
  query: string,
  maxResults = 5,
): Promise<NormalizedCandidate[]> {
  const key = youtubeApiKey();
  if (!key) {
    throw new Error("YOUTUBE_KEY_MISSING");
  }
  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(Math.min(Math.max(maxResults, 1), 10)),
    safeSearch: "moderate",
    key,
  });
  const res = await fetch(`${YT_SEARCH_URL}?${searchParams}`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 403) throw new Error("YouTube API quota exceeded or key restricted.");
  if (!res.ok) throw new Error(`YouTube search failed (${res.status}).`);
  const data = (await res.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: Record<string, unknown> }> };
  const ids = (data.items ?? []).map((i) => i.id?.videoId).filter(Boolean) as string[];
  if (!ids.length) return [];

  const detailParams = new URLSearchParams({
    part: "snippet,contentDetails",
    id: ids.join(","),
    key,
  });
  const detailRes = await fetch(`${YT_VIDEOS_URL}?${detailParams}`, { signal: AbortSignal.timeout(15000) });
  if (!detailRes.ok) return ids.map((id) => ({
    provider: "youtube",
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    sourceAccount: null,
    title: null,
    publishedAt: null,
    durationSec: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    videoFk: null,
    transcriptExcerpt: null,
    segStart: null,
    segEnd: null,
    matchKind: "broad_candidate" as const,
    reason: "YouTube search hit (metadata fetch failed; transcript not yet analyzed).",
    relevanceScore: 0.3,
  }));

  const detail = (await detailRes.json()) as {
    items?: Array<{
      id?: string;
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
      contentDetails?: { duration?: string };
    }>;
  };
  return (detail.items ?? []).map((it) => {
    const vid = it.id ?? "";
    return {
      provider: "youtube",
      sourceUrl: `https://www.youtube.com/watch?v=${vid}`,
      sourceAccount: it.snippet?.channelTitle ?? null,
      title: it.snippet?.title ?? null,
      publishedAt: it.snippet?.publishedAt ?? null,
      durationSec: parseIsoDuration(it.contentDetails?.duration ?? null),
      thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      videoFk: null,
      transcriptExcerpt: null,
      segStart: null,
      segEnd: null,
      matchKind: "broad_candidate" as const,
      reason: "YouTube search match — open to verify; run transcript analysis for timestamps.",
      relevanceScore: 0.5,
    } satisfies NormalizedCandidate;
  });
}

// --------------------------------- youtube: URL import + transcript engine ----

/** Ensure a YouTube URL is in the library with transcript, then return candidates. */
export async function analyzeYouTubeUrl(rawUrl: string): Promise<{ videoFk: number; videoId: string } | { error: string }> {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) return { error: "Not a recognizable YouTube URL." };
  const db = getDb();
  let [video] = await db.select().from(videos).where(eq(videos.videoId, videoId));
  if (!video) {
    const meta = await fetchVideoMeta(videoId);
    const [inserted] = await db
      .insert(videos)
      .values({
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: meta.title,
        channel: meta.channel,
        thumbnail: meta.thumbnail,
        status: "ok",
      })
      .returning({ id: videos.id });
    [video] = await db.select().from(videos).where(eq(videos.id, inserted.id));
  }
  if (video.transcriptKind === "none") {
    try {
      const result = await getTranscriptProvider().fetchTranscript(videoId);
      await db.delete(transcriptSegments).where(eq(transcriptSegments.videoFk, video.id));
      if (result.segments.length) {
        await db.insert(transcriptSegments).values(
          result.segments.map((s, i) => ({ videoFk: video!.id, idx: i, text: s.text, start: s.start, end: s.end })),
        );
      }
      await db
        .update(videos)
        .set({ transcriptKind: result.kind, transcriptLang: result.lang, status: "ok", errorMessage: null, retrievedAt: new Date() })
        .where(eq(videos.id, video.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.update(videos).set({ status: "error", errorMessage: msg }).where(eq(videos.id, video.id));
      return { error: msg };
    }
  }
  return { videoFk: video.id, videoId };
}

// ------------------------------ library: existing transcript engine search ----

/**
 * Search every indexed transcript in the library for beat phrases using the
 * existing exact/phrase matching logic from the Single Video workflow.
 * Returns timestamped candidates — this reuses the app's real transcript
 * engine, not a new one.
 */
export async function searchLibraryTranscripts(
  beat: BeatAnalysis,
  maxResults = 4,
): Promise<NormalizedCandidate[]> {
  const db = getDb();
  const allVideos = await db.select().from(videos);
  const indexed = allVideos.filter((v) => v.transcriptKind !== "none" && v.status === "ok");
  if (!indexed.length) return [];

  // Search terms: quoted phrases first (strongest transcript evidence), then
  // aliases + entities, longest first (most specific).
  const terms: string[] = [...extractQuotedPhrases(beat.text)];
  for (const [entity, aliases] of Object.entries(beat.aliases)) {
    terms.push(entity, ...(aliases ?? []));
  }
  terms.push(...beat.entities);
  const uniqTerms = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length).slice(0, 6);
  if (!uniqTerms.length) return [];

  const out: NormalizedCandidate[] = [];
  for (const v of indexed) {
    const segs = await db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.videoFk, v.id))
      .orderBy(transcriptSegments.idx);
    if (!segs.length) continue;

    let best: { seg: (typeof segs)[number]; score: number } | null = null;
    for (const term of uniqTerms) {
      const normTerm = normalizeTerm(term);
      if (normTerm.length < 3) continue;
      const hit = segs.find((s) => normalizeTerm(s.text).includes(normTerm));
      if (hit) {
        // Score: longer matched term = more specific match.
        best = { seg: hit, score: 0.5 + Math.min(0.4, term.length / 40) };
        break; // first (longest) term that hits is the strongest evidence
      }
    }
    if (best) {
      const bestMatch: { seg: (typeof segs)[number]; score: number } = best;
      const seg = bestMatch.seg;
      // Neighboring context for excerpt completeness (avoid mid-sentence cuts)
      const next = segs.find((s) => s.idx === seg.idx + 1);
      const excerpt = next && next.start - seg.end < 0.5 ? `${seg.text} ${next.text}` : seg.text;
      const excerptEnd = next && next.start - seg.end < 0.5 ? next.end : seg.end;
      out.push({
        provider: "library",
        sourceUrl: v.url,
        sourceAccount: v.channel,
        title: v.title,
        publishedAt: null,
        durationSec: v.durationSec,
        thumbnailUrl: v.thumbnail,
        videoFk: v.id,
        transcriptExcerpt: excerpt,
        segStart: seg.start,
        segEnd: excerptEnd,
        matchKind: "exact_transcript",
        reason: `Transcript contains “${uniqTerms.find((t) => normalizeTerm(seg.text).includes(normalizeTerm(t)))}” — exact phrase match in your library.`,
        relevanceScore: best.score,
      });
    }
  }
  return out.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, maxResults);
}

// --------------------------------------------- social: open_external ----

export function socialDiscoveryLinks(beat: BeatAnalysis): NormalizedCandidate[] {
  const q = beat.queries[0] ?? beat.entities.slice(0, 2).join(" ");
  if (!q) return [];
  const enc = encodeURIComponent(q);
  const mk = (provider: string, url: string, title: string): NormalizedCandidate => ({
    provider,
    sourceUrl: url,
    sourceAccount: null,
    title,
    publishedAt: null,
    durationSec: null,
    thumbnailUrl: null,
    videoFk: null,
    transcriptExcerpt: null,
    segStart: null,
    segEnd: null,
    matchKind: "manual_review",
    reason: "Open external — search this source yourself, then import the cleanest URL you find (no scraping, no watermark removal).",
    relevanceScore: 0,
  });
  return [
    mk("instagram", `https://www.instagram.com/explore/search/keyword/?q=${enc}`, `Instagram search: ${q}`),
    mk("tiktok", `https://www.tiktok.com/search?q=${enc}`, `TikTok search: ${q}`),
    mk("x", `https://x.com/search?q=${enc}&f=video`, `X video search: ${q}`),
  ];
}

// -------------------------------------------------- per-beat dispatcher ----

export async function discoverForBeat(beat: BeatAnalysis): Promise<ProviderSearchResult[]> {
  const results: ProviderSearchResult[] = [];

  // 1) Library transcripts — always available, real timestamps.
  // Transcript search is useful whenever the beat has searchable terms
  // (quoted phrases, entities, or aliases), not only for speech-cue beats.
  const searchable =
    beat.needsTranscriptSearch || beat.entities.length > 0 || extractQuotedPhrases(beat.text).length > 0;
  try {
    if (searchable) {
      const cands = await searchLibraryTranscripts(beat);
      results.push({ provider: "library", ok: true, capability: "search_and_analyze", candidates: cands });
    } else {
      results.push({ provider: "library", ok: true, capability: "search_and_analyze", candidates: [] });
    }
  } catch (err) {
    results.push({ provider: "library", ok: false, capability: "search_and_analyze", error: String(err), candidates: [] });
  }

  // 2) YouTube live search — always available: Data API when keyed,
  //    keyless yt-dlp search otherwise (real results either way).
  const ytKeyed = youtubeApiKey().length > 0;
  for (const q of beat.queries.slice(0, 2)) {
    try {
      const cands = ytKeyed ? await searchYouTubeLive(q, 4) : await searchYouTubeKeyless(q, 4);
      results.push({ provider: "youtube", ok: true, capability: "search_and_analyze", candidates: cands });
    } catch (err) {
      results.push({ provider: "youtube", ok: false, capability: "search_and_analyze", error: String(err), candidates: [] });
      break; // search/rate-limit errors: don't hammer per query
    }
  }

  // 3) Social providers — discovery links only (labeled, never fake).
  if (beat.entities.length > 0) {
    for (const link of socialDiscoveryLinks(beat)) {
      results.push({ provider: link.provider, ok: true, capability: "open_external", candidates: [link] });
    }
  }

  return results;
}

export const ControlSchemas = {
  scriptIngress: z.object({
    title: z.string().min(1).max(255).optional(),
    topic: z.string().max(255).optional(),
    tags: z.array(z.string()).optional(),
    sourceProvider: z.string().max(40).default("google_docs"),
    sourceDocId: z.string().max(128).optional(),
    sourceTitle: z.string().max(512).optional(),
    sourceUrl: z.string().url().optional(),
    sourceModifiedAt: z.string().max(64).optional(),
    scriptText: z.string().min(1),
    extractedFromHeading: z.string().max(200).optional(),
    projectName: z.string().max(255).optional(),
  }),
  runStages: z.object({
    projectId: z.number(),
    stages: z.array(z.enum(["analyze", "discover", "index", "rank"])).default(["analyze", "discover", "index", "rank"]),
    onlyProviders: z.array(z.string()).optional(),
    onlyBeats: z.array(z.number()).optional(),
  }),
};
