/**
 * Clip Map exports — JSON / CSV / Markdown.
 * Pure functions over the project query shape (script.project).
 */
import { fmtTime } from "./youtube";

export interface ExportCandidate {
  id: number;
  provider: string;
  sourceUrl: string;
  sourceAccount: string | null;
  title: string | null;
  matchKind: string;
  transcriptExcerpt: string | null;
  segStart: number | null;
  segEnd: number | null;
  editIn: number | null;
  editOut: number | null;
  relevanceScore: number;
  state: string;
  reason: string | null;
  userNotes: string | null;
  beatFk: number;
}

export interface ExportBeat {
  id: number;
  ord: number;
  text: string;
  coverageTypes: string | null;
  status: string;
}

export interface ExportProjectInfo {
  id: number;
  name: string;
  status: string;
  currentRevision: number;
  sourceTitle: string | null;
  sourceUrl: string | null;
  sourceDocId: string | null;
  sourceModifiedAt: string | null;
}

interface FlatRow {
  beat: number;
  beatText: string;
  beatStatus: string;
  provider: string;
  matchKind: string;
  title: string;
  sourceUrl: string;
  sourceAccount: string;
  sourceIn: string;
  sourceOut: string;
  editIn: string;
  editOut: string;
  duration: string;
  excerpt: string;
  relevance: string;
  state: string;
  reason: string;
  notes: string;
}

function flatten(beats: ExportBeat[], candidates: ExportCandidate[]): FlatRow[] {
  const byBeat = new Map<number, ExportBeat>();
  for (const b of beats) byBeat.set(b.id, b);
  const rows: FlatRow[] = [];
  const ordered = [...candidates].sort((a, b) => {
    const ba = byBeat.get(a.beatFk)?.ord ?? 0;
    const bb = byBeat.get(b.beatFk)?.ord ?? 0;
    if (ba !== bb) return ba - bb;
    return b.relevanceScore - a.relevanceScore;
  });
  for (const c of ordered) {
    const beat = byBeat.get(c.beatFk);
    const dur =
      c.editIn != null && c.editOut != null ? Math.max(0, c.editOut - c.editIn) : null;
    rows.push({
      beat: beat?.ord ?? -1,
      beatText: beat?.text ?? "",
      beatStatus: beat?.status ?? "",
      provider: c.provider,
      matchKind: c.matchKind,
      title: c.title ?? "",
      sourceUrl: c.sourceUrl,
      sourceAccount: c.sourceAccount ?? "",
      sourceIn: c.segStart != null ? fmtTime(c.segStart) : "",
      sourceOut: c.segEnd != null ? fmtTime(c.segEnd) : "",
      editIn: c.editIn != null ? fmtTime(c.editIn) : "",
      editOut: c.editOut != null ? fmtTime(c.editOut) : "",
      duration: dur != null ? fmtTime(dur) : "",
      excerpt: c.transcriptExcerpt ?? "",
      relevance: c.relevanceScore.toFixed(2),
      state: c.state,
      reason: c.reason ?? "",
      notes: c.userNotes ?? "",
    });
  }
  return rows;
}

export function clipMapJSON(project: ExportProjectInfo, beats: ExportBeat[], candidates: ExportCandidate[]): string {
  return JSON.stringify(
    {
      project,
      beats,
      candidates: flatten(beats, candidates),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
}

export function clipMapCSV(_project: ExportProjectInfo, beats: ExportBeat[], candidates: ExportCandidate[]): string {
  const rows = flatten(beats, candidates);
  const head = [
    "Beat", "Script Beat", "Beat Status", "Provider", "Match Kind", "Title", "Source URL",
    "Source Account", "Source In", "Source Out", "Edit In", "Edit Out", "Duration",
    "Transcript Excerpt", "Relevance", "State", "Reason", "Notes",
  ];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [
    head.join(","),
    ...rows.map((r) =>
      [
        String(r.beat), r.beatText, r.beatStatus, r.provider, r.matchKind, r.title, r.sourceUrl,
        r.sourceAccount, r.sourceIn, r.sourceOut, r.editIn, r.editOut, r.duration, r.excerpt,
        r.relevance, r.state, r.reason, r.notes,
      ].map(esc).join(","),
    ),
  ].join("\n");
}

export function clipMapMarkdown(project: ExportProjectInfo, beats: ExportBeat[], candidates: ExportCandidate[]): string {
  const rows = flatten(beats, candidates);
  const lines: string[] = [];
  lines.push(`# Clip Map — ${project.name}`);
  lines.push("");
  lines.push(`- Status: **${project.status}** (revision ${project.currentRevision})`);
  if (project.sourceTitle) lines.push(`- Google Doc: ${project.sourceTitle}${project.sourceUrl ? ` — ${project.sourceUrl}` : ""}`);
  if (project.sourceModifiedAt) lines.push(`- Source modified: ${project.sourceModifiedAt}`);
  lines.push("");
  let currentBeat = -2;
  for (const r of rows) {
    if (r.beat !== currentBeat) {
      currentBeat = r.beat;
      lines.push(`## Beat ${r.beat + 1} — ${r.beatText.slice(0, 110)}${r.beatText.length > 110 ? "…" : ""}`);
      lines.push(`*Coverage status: ${r.beatStatus}*`);
      lines.push("");
    }
    const ts = r.sourceIn ? ` @ ${r.sourceIn}${r.sourceOut ? `–${r.sourceOut}` : ""}` : "";
    lines.push(`- **${r.title || r.provider}**${ts} (${r.matchKind}, rel ${r.relevance}, ${r.state})`);
    lines.push(`  - Source: ${r.sourceUrl}`);
    if (r.excerpt) lines.push(`  - Excerpt: “${r.excerpt}”`);
    if (r.editIn) lines.push(`  - Edit: in ${r.editIn} / out ${r.editOut} (${r.duration})`);
    if (r.reason) lines.push(`  - Why: ${r.reason}`);
    if (r.notes) lines.push(`  - Notes: ${r.notes}`);
  }
  return lines.join("\n");
}
