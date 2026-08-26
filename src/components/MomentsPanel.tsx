import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { isPaymentRequired, openProDialog } from "@/lib/license";
import { fmtTime } from "@/lib/youtube";
import { toCSV, toJSON, toMarkdown, toPlainText, toPremiereCSV, downloadFile, type ExportMoment } from "@/lib/export";
import { ClipJobsPanel } from "@/components/ClipJobsPanel";
import { Trash2, Copy, ExternalLink, Download, Flag, Check, ChevronDown, Pencil, Loader2, Video, UploadCloud, Film, X, FolderPlus } from "lucide-react";

const COLORS: Record<string, string> = {
  amber: "bg-amber-400",
  red: "bg-brand-400",
  green: "bg-emerald-400",
  blue: "bg-sky-400",
  purple: "bg-violet-400",
};

const STATUSES = ["candidate", "selected", "used"] as const;

interface ExportResultItem {
  ok: boolean;
  name: string;
  error?: string | null;
  drivePath?: string | null;
}

interface ClipState {
  running: boolean;
  upload: boolean;
  result: { ok: boolean; message?: string; outDir?: string; total?: number; failed?: number; results?: ExportResultItem[] } | null;
}

interface Props {
  videoDbId: number;
  video: { title: string | null; url: string; videoId: string };
  currentTime: number;
  inPoint: number | null;
  outPoint: number | null;
  onSetIn: () => void;
  onSetOut: () => void;
  onPreviewRange: () => void;
  onSeek: (sec: number) => void;
  filter: "all" | "saved" | "notes";
  onFilter: (f: "all" | "saved" | "notes") => void;
}

export function MomentsPanel({ videoDbId, video, currentTime, inPoint, outPoint, onSetIn, onSetOut, onPreviewRange, onSeek, filter, onFilter }: Props) {
  const utils = trpc.useUtils();
  const { data: moments = [] } = trpc.clipsift.listMoments.useQuery({ videoDbId });
  const saveMoment = trpc.clipsift.saveMoment.useMutation({ onSuccess: () => utils.clipsift.listMoments.invalidate() });
  const updateMoment = trpc.clipsift.updateMoment.useMutation({ onSuccess: () => utils.clipsift.listMoments.invalidate() });
  const deleteMoment = trpc.clipsift.deleteMoment.useMutation({ onSuccess: () => utils.clipsift.listMoments.invalidate() });
  const exportClips = trpc.clipsift.exportClips.useMutation();
  const renderMoment = trpc.clips.renderMoment.useMutation({ onSuccess: () => utils.clips.listJobs.invalidate() });
  const renderVideoJobs = trpc.clips.renderVideoMoments.useMutation({
    onSuccess: () => utils.clips.listJobs.invalidate(),
    onError: (error) => { if (isPaymentRequired(error)) openProDialog("Batch render"); },
  });
  const { data: scriptProjects = [] } = trpc.script.listProjects.useQuery();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNote, setEditNote] = useState("");
  const [showExport, setShowExport] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [projectMomentId, setProjectMomentId] = useState<number | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<number | null>(null);
  const [targetBeatId, setTargetBeatId] = useState<number | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [clipState, setClipState] = useState<ClipState>({ running: false, upload: false, result: null });
  const { data: targetProject } = trpc.script.project.useQuery(
    { id: targetProjectId ?? 0 },
    { enabled: targetProjectId != null },
  );
  const addMomentToProject = trpc.script.addMomentToProject.useMutation({
    onSuccess: (result) => {
      setProjectNotice(result.duplicate ? "This clip is already in that project beat." : "Clip added to the project.");
      utils.script.project.invalidate();
    },
  });

  const filtered = moments.filter((m) => (filter === "notes" ? !!m.note : true));
  const selected = moments.find((m) => m.id === selectedId) ?? null;

  const doExport = (kind: "csv" | "json" | "md" | "txt" | "premiere") => {
    const list: ExportMoment[] = filtered.map((m) => ({
      title: m.title, note: m.note, start: m.start, end: m.end, excerpt: m.excerpt, color: m.color, status: m.status,
    }));
    const base = (video.title ?? "clips").replace(/[^\w]+/g, "_").slice(0, 40);
    if (kind === "csv") downloadFile(`${base}.csv`, toCSV(video, list), "text/csv");
    if (kind === "premiere") downloadFile(`${base}_premiere_markers.csv`, toPremiereCSV(video, list), "text/csv");
    if (kind === "json") downloadFile(`${base}.json`, toJSON(video, list), "application/json");
    if (kind === "md") downloadFile(`${base}.md`, toMarkdown(video, list), "text/markdown");
    if (kind === "txt") downloadFile(`${base}.txt`, toPlainText(video, list));
    setShowExport(false);
  };

  const doClipExport = (upload: boolean) => {
    setShowExport(false);
    const ids = filtered.map((m) => m.id);
    if (!ids.length) {
      setClipState({ running: false, upload, result: { ok: false, message: "No moments to export." } });
      return;
    }
    // Route through the render queue (progress + retry + Drive upload + phone download).
    renderVideoJobs.mutate({ videoDbId, momentIds: ids, uploadToDrive: upload });
  };

  const saveRange = () => {
    if (inPoint == null) return;
    saveMoment.mutate({
      videoDbId,
      title: `Clip ${fmtTime(inPoint)}${outPoint != null ? ` – ${fmtTime(outPoint)}` : ""}`,
      start: inPoint,
      end: outPoint ?? undefined,
    });
  };

  // Nudge an existing moment's In/Out by ±delta seconds (clip longer/shorter).
  const nudge = (field: "start" | "end", delta: number) => {
    if (!selected) return;
    const cur = field === "start" ? selected.start : (selected.end ?? selected.start);
    const v = Math.max(0, cur + delta);
    updateMoment.mutate({ id: selected.id, ...(field === "start" ? { start: v } : { end: v }) });
  };

  const okCount = clipState.result ? (clipState.result.total ?? 0) - (clipState.result.failed ?? 0) : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-zinc-800 p-3">
        {/* Range selection */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Range selection</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <button onClick={onSetIn} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700">
              Set In <span className="ml-1 font-mono text-brand-400">{inPoint != null ? fmtTime(inPoint) : "—"}</span>
            </button>
            <button onClick={onSetOut} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700">
              Set Out <span className="ml-1 font-mono text-red-400">{outPoint != null ? fmtTime(outPoint) : "—"}</span>
            </button>
            <button onClick={onPreviewRange} disabled={inPoint == null || outPoint == null} className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40">
              Preview
            </button>
            <button onClick={saveRange} disabled={inPoint == null} className="rounded-md bg-brand-600 px-2.5 py-1.5 font-medium text-white hover:bg-brand-500 disabled:opacity-40">
              Save clip
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-600">Current playhead: {fmtTime(currentTime)}</p>

          {/* Adjust an existing moment's In/Out */}
          {selected && (
            <div className="mt-2 rounded-md border border-brand-900/40 bg-zinc-950/70 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] text-zinc-400">
                  Adjusting: <span className="text-zinc-200">{selected.title}</span>
                </p>
                <button onClick={() => setSelectedId(null)} className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Stop adjusting this moment">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-1 font-mono text-[11px] text-brand-400">
                {fmtTime(selected.start)}{selected.end != null ? ` – ${fmtTime(selected.end)}` : ""}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-zinc-500">In</span>
                <button onClick={() => nudge("start", -5)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">−5s</button>
                <button onClick={() => nudge("start", -1)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">−1s</button>
                <button onClick={() => nudge("start", 1)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">+1s</button>
                <button onClick={() => nudge("start", 5)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">+5s</button>
                <span className="ml-2 text-zinc-500">Out</span>
                <button onClick={() => nudge("end", -5)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">−5s</button>
                <button onClick={() => nudge("end", -1)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">−1s</button>
                <button onClick={() => nudge("end", 1)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">+1s</button>
                <button onClick={() => nudge("end", 5)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700">+5s</button>
                <button
                  onClick={() => { if (inPoint != null) updateMoment.mutate({ id: selected.id, start: inPoint }); }}
                  className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
                  title="Set this clip's In point to the current playhead"
                >
                  Set In→clip
                </button>
                <button
                  onClick={() => { if (outPoint != null) updateMoment.mutate({ id: selected.id, end: outPoint }); }}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-700"
                  title="Set this clip's Out point to the current playhead"
                >
                  Set Out→clip
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {(["all", "notes"] as const).map((f) => (
              <button
                key={f}
                onClick={() => onFilter(f)}
                className={`rounded-full px-2.5 py-1 text-xs ${filter === f ? "bg-brand-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
              >
                {f === "all" ? `All (${moments.length})` : "With notes"}
              </button>
            ))}
          </div>
          <div className="relative">
            <button onClick={() => setShowExport((v) => !v)} className="flex items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
              <Download className="h-3.5 w-3.5" /> Export <ChevronDown className="h-3 w-3" />
            </button>
            {showExport && (
              <div className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
                <p className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Edit lists</p>
                {([["csv", "CSV"], ["json", "JSON"], ["md", "Markdown"], ["txt", "Plain text"], ["premiere", "Premiere marker CSV"]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => doExport(k)} className="block w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800">
                    {label}
                  </button>
                ))}
                <p className="border-t border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">Video clips</p>
                <button onClick={() => doClipExport(false)} disabled={exportClips.isPending} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <Video className="h-3.5 w-3.5 text-zinc-500" /> Download MP4s → Clips folder
                </button>
                <button onClick={() => doClipExport(true)} disabled={exportClips.isPending} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                  <UploadCloud className="h-3.5 w-3.5 text-emerald-500" /> Clip & upload to Google Drive
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Clip export status / results */}
        {clipState.running && (
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-400" />
              Clipping {filtered.length} moment(s)… saving to your Clips folder{clipState.upload ? " + Google Drive" : ""}
          </div>
        )}
        {!clipState.running && clipState.result && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900 p-2.5 text-xs">
            {clipState.result.ok ? (
              <p className="text-emerald-400">
                ✓ Exported {okCount}/{clipState.result.total} clips → {clipState.result.outDir}
              </p>
            ) : (
              <p className="text-red-400">✗ {clipState.result.message ?? "Export failed"}</p>
            )}
            {clipState.result.results?.filter((r) => !r.ok).map((r) => (
              <p key={`err-${r.name}`} className="mt-1 break-words text-zinc-500">
                {r.name}: {r.error}
              </p>
            ))}
            {clipState.result.results?.filter((r) => r.ok && r.drivePath).map((r) => (
              <p key={`drv-${r.name}`} className="mt-0.5 text-zinc-400">↗ {r.drivePath}</p>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {/* Render queue for this video's moments */}
        <ClipJobsPanel videoFk={videoDbId} />
        {filtered.length === 0 && (
          <p className="p-2 text-sm text-zinc-500">
            No saved moments yet. Hover a transcript line and click the quote icon, or set an In/Out range.
          </p>
        )}
        {filtered.map((m) => (
          <div key={m.id} className={`rounded-lg border p-3 ${selectedId === m.id ? "border-brand-800/70 bg-zinc-900/90" : "border-zinc-800 bg-zinc-900"}`}>
            <div className="flex items-start justify-between gap-2">
              <button onClick={() => { setSelectedId(m.id); onSeek(m.start); }} className="flex items-center gap-2 text-left">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${COLORS[m.color] ?? COLORS.amber}`} />
                <span className="font-mono text-xs text-brand-400">
                  {fmtTime(m.start)}{m.end != null && ` – ${fmtTime(m.end)}`}
                </span>
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setProjectMomentId((current) => current === m.id ? null : m.id);
                    setProjectNotice(null);
                  }}
                  className={`flex items-center gap-1 rounded p-1 text-white ${projectMomentId === m.id ? "bg-emerald-600" : "bg-zinc-800 hover:bg-zinc-700"}`}
                  title="Add this saved clip to a Script / Project beat"
                  aria-label="Add clip to project"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => renderMoment.mutate({ momentId: m.id, uploadToDrive: true })}
                  disabled={renderMoment.isPending}
                  className="flex items-center gap-1 rounded bg-brand-600 p-1 text-white hover:bg-brand-500 disabled:opacity-40"
                  title={"Render this clip to the Clips folder and Google Drive"}
                  aria-label={`Render clip ${m.title} to the Clips folder and Google Drive`}
                >
                  {renderMoment.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
                </button>
                <select
                  value={m.status}
                  onChange={(e) => updateMoment.mutate({ id: m.id, status: e.target.value as (typeof STATUSES)[number] })}
                  className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                </select>
                <button onClick={() => { if (confirm("Delete this moment?")) deleteMoment.mutate({ id: m.id }); }} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Delete this moment" aria-label={`Delete moment ${m.title}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {projectMomentId === m.id && (
              <div data-testid={`moment-project-picker-${m.id}`} className="mt-2 rounded-md border border-emerald-900/50 bg-zinc-950/80 p-2.5">
                <p className="text-[11px] font-medium text-zinc-200">Add this saved clip to a project</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">The Single Video copy stays here. Choose the project beat where this clip belongs.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select
                    aria-label="Target project"
                    value={targetProjectId ?? ""}
                    onChange={(event) => {
                      const value = event.target.value ? Number(event.target.value) : null;
                      setTargetProjectId(value);
                      setTargetBeatId(null);
                      setProjectNotice(null);
                    }}
                    className="min-w-48 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
                  >
                    <option value="">Choose project…</option>
                    {scriptProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                  <select
                    aria-label="Target project beat"
                    value={targetBeatId ?? ""}
                    disabled={!targetProjectId || !targetProject?.beats.length}
                    onChange={(event) => setTargetBeatId(event.target.value ? Number(event.target.value) : null)}
                    className="min-w-48 flex-[2] rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 disabled:opacity-40"
                  >
                    <option value="">Choose project beat…</option>
                    {targetProject?.beats.map((beat) => (
                      <option key={beat.id} value={beat.id}>{beat.ord + 1}. {beat.text.slice(0, 90)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!targetProjectId || !targetBeatId || addMomentToProject.isPending}
                    onClick={() => addMomentToProject.mutate({ projectId: targetProjectId!, beatId: targetBeatId!, momentId: m.id })}
                    className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {addMomentToProject.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
                    Add to project
                  </button>
                </div>
                {targetProjectId && targetProject && targetProject.beats.length === 0 && (
                  <p className="mt-2 text-[10px] text-amber-300">This project has no beats yet. Run Analyze Script &amp; Find Clips in the project first.</p>
                )}
                {addMomentToProject.error && <p className="mt-2 text-[10px] text-red-400">{addMomentToProject.error.message}</p>}
                {projectNotice && <p className="mt-2 text-[10px] text-emerald-300">{projectNotice}</p>}
              </div>
            )}

            {editingId === m.id ? (
              <div className="mt-2 space-y-1.5">
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100" />
                <textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} rows={2} placeholder="Note…" className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100" />
                <div className="flex gap-1.5">
                  {Object.entries(COLORS).map(([name, cls]) => (
                    <button key={name} onClick={() => updateMoment.mutate({ id: m.id, color: name })} className={`h-4 w-4 rounded-full ${cls} ${m.color === name ? "ring-2 ring-white" : ""}`} />
                  ))}
                  <button
                    onClick={() => { updateMoment.mutate({ id: m.id, title: editTitle, note: editNote }); setEditingId(null); }}
                    className="ml-auto rounded bg-brand-600 px-2 py-0.5 text-xs text-white"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1.5">
                <div className="flex items-center gap-1.5">
                  <p className="flex-1 text-sm font-medium text-zinc-200">{m.title}</p>
                  <button onClick={() => { setEditingId(m.id); setEditTitle(m.title); setEditNote(m.note ?? ""); }} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" title="Edit title and note" aria-label={`Edit moment ${m.title}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
                {m.excerpt && <p className="mt-1 line-clamp-2 text-xs italic text-zinc-500">“{m.excerpt}”</p>}
                {m.note && <p className="mt-1 text-xs text-zinc-400">{m.note}</p>}
                <div className="mt-2 flex gap-1.5">
                  <button
                    onClick={() => navigator.clipboard.writeText(fmtTime(m.start))}
                    className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-700"
                  >
                    <Copy className="h-3 w-3" /> {fmtTime(m.start)}
                  </button>
                  {m.excerpt && (
                    <button
                      onClick={() => navigator.clipboard.writeText(`“${m.excerpt}”`)}
                      className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-700"
                    >
                      <Copy className="h-3 w-3" /> Quote
                    </button>
                  )}
                  <a
                    href={`https://www.youtube.com/watch?v=${video.videoId}&t=${Math.floor(m.start)}s`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-700"
                  >
                    <ExternalLink className="h-3 w-3" /> YouTube
                  </a>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// re-export icons used indirectly (keep tree-shake friendly)
export { Flag, Check };
