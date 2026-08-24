/**
 * Script / Project mode — project list, pipeline control, and Clip Map.
 * Native extension of Cut IQ's existing visual system (zinc-950 / brand-600).
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { fmtTime } from "@/lib/youtube";
import { clipMapCSV, clipMapJSON, clipMapMarkdown } from "@/lib/clipMapExport";
import { SubmitDialog } from "./SubmitDialog";
import { ClipJobsPanel } from "@/components/ClipJobsPanel";
import { AppNav } from "@/components/AppNav";
import { InlineError, InlineLoading } from "@/components/InlineState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNavigate } from "react-router";
import {
  FileText, Scissors, Play, RefreshCw, Download, ExternalLink, Check, X as XIcon,
  ChevronRight, Loader2, AlertTriangle, Link2, Clapperboard, Trash2, Clock, Search,
  Film, Pencil, CheckCircle2, ListChecks, Square, CheckSquare,
} from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  imported: "Imported",
  analyzing: "Analyzing Script",
  building_coverage: "Building Coverage Plan",
  searching_sources: "Searching Sources",
  fetching_transcripts: "Fetching Transcripts",
  ranking_candidates: "Ranking Candidates",
  ready_for_review: "Ready for Review",
  partially_complete: "Partially Complete",
  failed: "Failed",
};

const FIND_STAGE_LABELS: Record<string, { label: string; current: number }> = {
  queued: { label: "Waiting to start", current: 0 },
  analyzing: { label: "Analyze script", current: 1 },
  discovering: { label: "Discover sources", current: 2 },
  transcripts: { label: "Get transcripts", current: 3 },
  ranking: { label: "Rank candidates", current: 4 },
  extracting: { label: "Queue clips", current: 5 },
  verifying: { label: "Download and verify", current: 6 },
  complete: { label: "Complete", current: 6 },
  failed: { label: "Needs attention", current: 0 },
  cancelled: { label: "Cancelled", current: 0 },
};

const FIND_STAGE_SEQUENCE = ["Analyze script", "Discover sources", "Get transcripts", "Rank candidates", "Queue clips", "Download & verify"];

function FindJobProgress({
  progress,
  stage,
  operation,
  compact = false,
}: {
  progress: number | null | undefined;
  stage: string;
  operation?: string | null;
  compact?: boolean;
}) {
  const percent = Math.max(0, Math.min(100, Number(progress ?? 0)));
  const stageInfo = FIND_STAGE_LABELS[stage] ?? { label: stage.replaceAll("_", " "), current: 0 };
  const rounded = Math.round(percent);
  return (
    <div className={compact ? "mt-3" : "w-full"}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]">
        <span className="truncate font-medium text-zinc-300">{stageInfo.label}{operation && !compact ? ` — ${operation}` : ""}</span>
        <span className="shrink-0 tabular-nums text-zinc-400">{rounded}%{stageInfo.current ? ` · stage ${stageInfo.current}/6` : ""}</span>
      </div>
      <div
        className={`overflow-hidden rounded-full bg-zinc-800 ${compact ? "h-1.5" : "h-2.5"}`}
        role="progressbar"
        aria-label={`Find Clips project completion: ${stageInfo.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${stage === "complete" ? "bg-emerald-500" : "bg-brand-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {!compact && (
        <div className="mt-2.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {FIND_STAGE_SEQUENCE.map((label, index) => {
            const number = index + 1;
            const complete = stage === "complete" || stageInfo.current > number;
            const active = stageInfo.current === number;
            return (
              <div key={label} className={`flex min-w-0 items-center gap-1.5 text-[10px] ${complete ? "text-emerald-300" : active ? "text-zinc-100" : "text-zinc-600"}`}>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border font-mono text-[9px] ${complete ? "border-emerald-500/40 bg-emerald-500/15" : active ? "border-brand-500/60 bg-brand-500/15 text-brand-300" : "border-zinc-700"}`}>
                  {complete ? <Check className="h-2.5 w-2.5" /> : number}
                </span>
                <span className="truncate">{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

type BeatRow = {
  id: number; ord: number; text: string; coverageTypes: string | null; status: string;
  entities: string | null; purpose: string | null; queries: string | null; uncertainty: string | null;
  needsTranscriptSearch: boolean; visualOnly: boolean; desiredClipLenSec: number | null;
  projectFk: number; revisionFk: number; createdAt: string | Date;
};
type CandRow = {
  id: number; projectFk: number; revisionFk: number; beatFk: number; provider: string;
  videoFk: number | null; sourceUrl: string; sourceAccount: string | null; title: string | null;
  publishedAt: string | null; durationSec: number | null; thumbnailUrl: string | null;
  matchKind: string; transcriptExcerpt: string | null; segStart: number | null; segEnd: number | null;
  editIn: number | null; editOut: number | null; relevanceScore: number; qualityScore: number;
  cleanSourceScore: number; visualConfidence: number; reason: string | null;
  acquisitionStatus: string; dupGroupKey: string | null; state: string; userNotes: string | null;
  createdAt: string | Date; updatedAt: string | Date;
};

// ------------------------------------------------------- candidate card ----

function CandidateCard({ c, onPreview }: { c: CandRow; onPreview: (c: CandRow) => void }) {
  const utils = trpc.useUtils();
  const update = trpc.script.updateCandidate.useMutation({
    onSuccess: () => utils.script.project.invalidate(),
  });
  const render = trpc.clips.renderCandidate.useMutation({ onSuccess: () => utils.clips.listJobs.invalidate() });
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState(c.userNotes ?? "");
  const [editTimes, setEditTimes] = useState(false);
  const [editIn, setEditIn] = useState<number>(c.editIn ?? c.segStart ?? 0);
  const [editOut, setEditOut] = useState<number>(c.editOut ?? c.segEnd ?? 0);
  const [upload, setUpload] = useState(false);

  const hasClip =
    c.editIn != null && c.editOut != null && c.editOut > (c.editIn ?? 0);

  const kindStyle: Record<string, string> = {
    exact_transcript: "bg-emerald-500/15 text-emerald-300",
    strong_visual: "bg-sky-500/15 text-sky-300",
    probable_visual: "bg-sky-500/10 text-sky-400",
    broad_candidate: "bg-zinc-800 text-zinc-400",
    manual_review: "bg-amber-500/15 text-amber-300",
  };
  const kindLabel: Record<string, string> = {
    exact_transcript: "Exact transcript match",
    strong_visual: "Strong visual match",
    probable_visual: "Probable visual match",
    broad_candidate: "Broad candidate",
    manual_review: "Manual review required",
  };

  const stateBorder =
    c.state === "approved" ? "border-emerald-500/60" : c.state === "rejected" ? "border-zinc-800 opacity-50" : "border-zinc-800";

  return (
    <div className={`rounded-lg border ${stateBorder} bg-zinc-900/60 p-3`}>
      <div className="flex items-start gap-3">
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" className="mt-0.5 h-14 w-24 shrink-0 rounded object-cover" />
        ) : (
          <div className="mt-0.5 flex h-14 w-24 shrink-0 items-center justify-center rounded bg-zinc-800">
            <Clapperboard className="h-5 w-5 text-zinc-600" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${kindStyle[c.matchKind] ?? "bg-zinc-800 text-zinc-400"}`}>
              {kindLabel[c.matchKind] ?? c.matchKind}
            </span>
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">{c.provider}</span>
            {c.segStart != null && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-zinc-400">
                <Clock className="h-3 w-3" /> {fmtTime(c.segStart)}
                {c.segEnd != null && `–${fmtTime(c.segEnd)}`}
              </span>
            )}
            <span className="ml-auto font-mono text-[10px] text-zinc-500">rel {c.relevanceScore.toFixed(2)}</span>
          </div>
          <p className="mt-1 truncate text-sm font-medium text-zinc-100">{c.title ?? c.sourceUrl}</p>
          {c.sourceAccount && <p className="truncate text-xs text-zinc-500">{c.sourceAccount}</p>}
          {c.transcriptExcerpt && (
            <p className="mt-1 line-clamp-2 text-xs italic text-zinc-400">“{c.transcriptExcerpt}”</p>
          )}
          {c.reason && <p className="mt-1 text-xs text-zinc-500">{c.reason}</p>}
          {c.editIn != null && c.editOut != null && (
            <p className="mt-1 font-mono text-[10px] text-zinc-400">
              Edit: {fmtTime(c.editIn)} → {fmtTime(c.editOut)} ({fmtTime(Math.max(0, c.editOut - c.editIn))})
            </p>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button onClick={() => onPreview(c)} className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700">
          <Play className="h-3 w-3" /> Preview
        </button>
        <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700">
          <ExternalLink className="h-3 w-3" /> Open Source
        </a>
        {c.segStart != null && (
          <button
            onClick={() => { const ts = c.segStart as number; navigator.clipboard.writeText(`${c.sourceUrl}&t=${Math.floor(ts)}s`); }}
            className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
            title="Copy timestamped link"
          >
            <Link2 className="h-3 w-3" /> Copy TS
          </button>
        )}
        <button
          onClick={() => setEditTimes((v) => !v)}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${editTimes ? "bg-brand-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
          title="Adjust the clip's start/end times"
        >
          <Pencil className="h-3 w-3" /> Edit times
        </button>
        {hasClip && (
          <button
            onClick={() => render.mutate({ candidateId: c.id, uploadToDrive: upload })}
            disabled={render.isPending}
            className="flex items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-40"
                  title="Render this clip to the configured Clips folder (and Drive if checked)"
          >
            {render.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />}
            Clip it
          </button>
        )}
        <label className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300">
          <input type="checkbox" checked={upload} onChange={(e) => setUpload(e.target.checked)} className="accent-brand-600" />
          Drive
        </label>
        <div className="ml-auto flex gap-1.5">
          <button
            onClick={() => update.mutate({ id: c.id, state: c.state === "approved" ? "undecided" : "approved" })}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${c.state === "approved" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-emerald-300 hover:bg-zinc-700"}`}
          >
            <Check className="h-3 w-3" /> Use Clip
          </button>
          <button
            onClick={() => update.mutate({ id: c.id, state: c.state === "rejected" ? "undecided" : "rejected" })}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${c.state === "rejected" ? "bg-zinc-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
          >
            <XIcon className="h-3 w-3" /> Reject
          </button>
          <button onClick={() => setNotesOpen((v) => !v)} className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700">
            Notes
          </button>
        </div>
      </div>
      {editTimes && hasClip && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-brand-900/40 bg-zinc-950/70 p-2">
          <span className="text-[11px] text-zinc-400">Start</span>
          <input
            type="number" step="0.1" value={editIn}
            onChange={(e) => setEditIn(Number(e.target.value))}
            className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 font-mono text-[11px] text-zinc-100"
          />
          <span className="text-[11px] text-zinc-400">End</span>
          <input
            type="number" step="0.1" value={editOut}
            onChange={(e) => setEditOut(Number(e.target.value))}
            className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 font-mono text-[11px] text-zinc-100"
          />
          <span className="font-mono text-[10px] text-brand-400">len {fmtTime(Math.max(0, editOut - editIn))}</span>
          <button
            onClick={() => update.mutate({ id: c.id, editIn, editOut }, { onSuccess: () => setEditTimes(false) })}
            className="rounded-md bg-brand-600 px-2 py-1 text-[11px] text-white hover:bg-brand-500"
          >
            Save times
          </button>
          <button onClick={() => { setEditIn(c.editIn ?? 0); setEditOut(c.editOut ?? 0); setEditTimes(false); }} className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700">
            Cancel
          </button>
        </div>
      )}
      {notesOpen && (
        <div className="mt-2 flex gap-2">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Your notes…"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-brand-500"
          />
          <button onClick={() => { update.mutate({ id: c.id, userNotes: notes }); setNotesOpen(false); }} className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs text-white hover:bg-brand-500">
            Save
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ preview ----

function PreviewModal({
  c,
  clips,
  onNavigate,
  onClose,
}: {
  c: CandRow;
  clips?: CandRow[];
  onNavigate?: (next: CandRow) => void;
  onClose: () => void;
}) {
  const vid = c.sourceUrl.match(/v=([\w-]{11})|youtu\.be\/([\w-]{11})/);
  const videoId = vid ? vid[1] ?? vid[2] : null;
  const startAt = c.editIn ?? c.segStart ?? 0;
  const list = clips ?? [c];
  const index = list.findIndex((item) => item.id === c.id);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < list.length - 1;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col gap-3 overflow-hidden border-zinc-800 bg-zinc-950 p-4" showCloseButton={false}>
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="truncate pr-6 text-sm font-medium">{c.title ?? c.sourceUrl}</DialogTitle>
          <DialogDescription className="sr-only">Candidate clip preview</DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded-md border border-brand-500/30 bg-brand-950/30 px-2 py-1 font-mono text-brand-300">
            IN {fmtTime(startAt)}{c.editOut != null ? ` → OUT ${fmtTime(c.editOut)}` : ""}
          </span>
          {c.editOut != null && (
            <span className="rounded-md border border-zinc-700 px-2 py-1 font-mono text-zinc-400">len {fmtTime(Math.max(0, c.editOut - startAt))}</span>
          )}
          {c.matchKind && (
            <span className="rounded-md border border-zinc-700 px-2 py-1 capitalize text-zinc-500">{c.matchKind.replaceAll("_", " ")}</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {videoId ? (
            <div className="mx-auto aspect-video w-full max-h-[56vh] overflow-hidden rounded-xl bg-black" style={{ maxWidth: "calc(56vh * 16 / 9)" }}>
              <iframe
                title="Preview"
                className="h-full w-full"
                src={`https://www.youtube-nocookie.com/embed/${videoId}?start=${Math.floor(startAt)}&autoplay=1`}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center text-sm text-zinc-400">
              This source is outside YouTube — open it externally to preview.
              <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 flex justify-center text-brand-400 hover:text-brand-300">
                Open Source <ExternalLink className="ml-1 h-3.5 w-3.5" />
              </a>
            </div>
          )}
          {c.transcriptExcerpt && <p className="mt-2 text-xs italic leading-relaxed text-zinc-400">“{c.transcriptExcerpt}”</p>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-800 pt-2.5">
          <button
            type="button"
            onClick={() => hasPrev && onNavigate?.(list[index - 1]!)}
            disabled={!hasPrev}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="Previous candidate"
          >
            ← Prev
          </button>
          <span className="font-mono text-[11px] text-zinc-600">{index + 1} / {list.length}</span>
          <button
            type="button"
            onClick={() => hasNext && onNavigate?.(list[index + 1]!)}
            disabled={!hasNext}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="Next candidate"
          >
            Next →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------- project detail ----

function ProjectDetail({ projectId, onBack }: { projectId: number; onBack: () => void }) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<CandRow | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [filter, setFilter] = useState<"all" | "approved" | "needs_review" | "exact">("all");

  const projectQuery = trpc.script.project.useQuery({ id: projectId }, {
    retry: 1,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status ?? "");
      return ["analyzing", "building_coverage", "searching_sources", "fetching_transcripts", "ranking_candidates"].includes(status) ? 5000 : false;
    },
  });
  const { data, isLoading, isError, error } = projectQuery;
  const { data: findJob } = trpc.findClips.byProject.useQuery({ projectId }, {
    retry: 1,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["queued", "running", "cancelling"].includes(status) ? 2000 : false;
    },
  });
  const runPipeline = trpc.script.runPipeline.useMutation({ onSuccess: () => utils.script.project.invalidate() });
  const findAction = trpc.findClips.action.useMutation({ onSuccess: () => utils.findClips.byProject.invalidate() });
  const importUrlMut = trpc.script.importUrl.useMutation({ onSuccess: () => utils.script.project.invalidate() });
  const updateBeat = trpc.script.updateBeat.useMutation({ onSuccess: () => utils.script.project.invalidate() });
  const deleteProject = trpc.script.deleteProject.useMutation({ onSuccess: onBack });

  if (isLoading) return <InlineLoading label="Opening Find Clips project…" />;
  if (isError || !data) return <InlineError title="This project could not be opened" message={error?.message ?? "Cut IQ could not load the project. Your saved project has not been changed."} onRetry={() => void projectQuery.refetch()} />;

  const { project, beats, candidates, status } = data;
  const running = findJob?.status === "running" || findJob?.status === "queued" || findJob?.status === "cancelling" || ["analyzing", "building_coverage", "searching_sources", "fetching_transcripts", "ranking_candidates"].includes(project.status);
  const candsByBeat = new Map<number, CandRow[]>();
  for (const c of candidates as CandRow[]) {
    const arr = candsByBeat.get(c.beatFk) ?? [];
    arr.push(c);
    candsByBeat.set(c.beatFk, arr);
  }
  for (const arr of candsByBeat.values()) arr.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const visibleCands = (arr: CandRow[]) =>
    arr.filter((c) =>
      filter === "approved" ? c.state === "approved"
        : filter === "needs_review" ? c.state === "undecided"
        : filter === "exact" ? c.matchKind === "exact_transcript"
        : c.state !== "rejected",
    );

  const exportName = `${project.name.replace(/[^\w-]+/g, "_")}_r${project.currentRevision}`;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-zinc-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onBack} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800" title="Back to projects" aria-label="Back to Find Clips projects"><ChevronRight className="h-4 w-4 rotate-180" /></button>
          <Scissors className="h-4 w-4 text-brand-500" />
          <h1 className="text-sm font-semibold text-zinc-100">{project.name}</h1>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${project.status === "ready_for_review" ? "bg-emerald-500/15 text-emerald-300" : project.status === "partially_complete" ? "bg-amber-500/15 text-amber-300" : project.status === "failed" ? "bg-red-500/15 text-red-300" : "bg-zinc-800 text-zinc-300"}`}>
            {findJob ? findJob.status.replaceAll("_", " ") : STATUS_LABELS[project.status] ?? project.status}
          </span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">rev {project.currentRevision}</span>
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-400" />}
          <div className="ml-auto flex flex-wrap gap-1.5">
            {findJob ? (
              <>
                {["queued", "running"].includes(findJob.status) && <button onClick={() => findAction.mutate({ id: findJob.id, action: "pause" })} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">Pause</button>}
                {["queued", "running", "paused"].includes(findJob.status) && <button onClick={() => findAction.mutate({ id: findJob.id, action: "cancel" })} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300">Cancel</button>}
                {findJob.status === "paused" && <button onClick={() => findAction.mutate({ id: findJob.id, action: "resume" })} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500">Resume</button>}
                {findJob.status === "failed" && <button onClick={() => findAction.mutate({ id: findJob.id, action: "retry" })} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500">Retry</button>}
                {["completed", "completed_with_warnings"].includes(findJob.status) && findJob.clipsVerified > 0 && (
                  <button onClick={() => navigate(`/clip-package?project=${projectId}`)} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500">
                    <Film className="h-3.5 w-3.5" /> Open clips
                  </button>
                )}
              </>
            ) : (
              <button
                onClick={() => runPipeline.mutate({ projectId })}
                disabled={runPipeline.isPending || running}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-40"
              >
                {runPipeline.isPending || running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                {beats.length ? "Rerun Pipeline" : "Analyze Script & Find Clips"}
              </button>
            )}
            <button onClick={() => setShowSubmit(true)} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" title="Submit an updated script revision" aria-label="Submit an updated script revision">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            {["ready_for_review", "partially_complete"].includes(project.status) && (
              <div className="flex gap-1.5">
                <button onClick={() => download(`${exportName}.clip_map.json`, clipMapJSON(project, beats as never[], candidates as CandRow[]), "application/json")} className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                  <Download className="h-3.5 w-3.5" /> JSON
                </button>
                <button onClick={() => download(`${exportName}.clip_map.csv`, clipMapCSV(project, beats as never[], candidates as CandRow[]), "text/csv")} className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
                <button onClick={() => download(`${exportName}.clip_map.md`, clipMapMarkdown(project, beats as never[], candidates as CandRow[]), "text/markdown")} className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                  <Download className="h-3.5 w-3.5" /> MD
                </button>
              </div>
            )}
            <button onClick={() => { if (confirm(`Delete project “${project.name}” and all its beats/candidates?`)) deleteProject.mutate({ id: projectId }); }} className="rounded-lg border border-zinc-800 p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title={`Delete ${project.name}`} aria-label={`Delete project ${project.name}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {/* Provenance */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-8 text-[11px] text-zinc-500">
          {project.sourceTitle && (
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" /> {project.sourceTitle}
              {project.sourceUrl && (
                <a href={project.sourceUrl} target="_blank" rel="noreferrer" className="text-brand-400 hover:text-brand-300">
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </span>
          )}
          {project.sourceDocId && <span className="font-mono">doc:{project.sourceDocId.slice(0, 12)}…</span>}
          {project.sourceModifiedAt && <span>modified {project.sourceModifiedAt}</span>}
          <span>{status.beats.total} beats · {status.beats.covered} covered · {status.beats.needsFootage} need footage</span>
          <span>{status.candidates.total} candidates · {status.candidates.withTimestamps} with timestamps</span>
        </div>
        {/* provider failures (honest, surfaced) */}
        {status.providerFailures.length > 0 && (
          <div className="mt-2 ml-8 flex flex-wrap gap-2">
            {status.providerFailures.slice(-4).map((f, i) => (
              <span key={i} className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
                <AlertTriangle className="h-3 w-3" /> {f.provider}: {f.message?.slice(0, 100)}
              </span>
            ))}
          </div>
        )}
        {/* filters + import URL */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-8">
          {([["all", "All"], ["approved", "Approved"], ["needs_review", "Undecided"], ["exact", "Exact transcript"]] as const).map(([f, label]) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-2.5 py-1 text-[11px] ${filter === f ? "bg-brand-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <input
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="Add a YouTube URL to this project…"
              className="w-64 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-brand-500"
              onKeyDown={(e) => {
                if (e.key === "Enter" && importUrl.trim()) {
                  importUrlMut.mutate({ projectId, url: importUrl.trim() });
                  setImportUrl("");
                }
              }}
            />
            <button
              disabled={importUrlMut.isPending || !importUrl.trim()}
              onClick={() => { importUrlMut.mutate({ projectId, url: importUrl.trim() }); setImportUrl(""); }}
              className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              {importUrlMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Index"}
            </button>
          </div>
        </div>
      </div>

      {findJob && (
        <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
          {["completed", "completed_with_warnings"].includes(findJob.status) && findJob.clipsVerified > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-3" role="status">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-emerald-200">Clips are ready</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {findJob.clipsVerified} verified clip{findJob.clipsVerified === 1 ? "" : "s"} finished{findJob.status === "completed_with_warnings" ? " with warnings — details below" : ""}. Review, preview, and package them in the clip package.
                </p>
              </div>
              <button
                onClick={() => navigate(`/clip-package?project=${projectId}`)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-950/40 hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              >
                <Film className="h-3.5 w-3.5" /> Open clip package
              </button>
            </div>
          )}
          {["completed", "completed_with_warnings"].includes(findJob.status) && findJob.clipsVerified === 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3" role="alert">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-amber-200">No playable clips were created</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  This run found {findJob.sourcesFound} source{findJob.sourcesFound === 1 ? "" : "s"}, but produced {findJob.transcriptsFound} timed transcript{findJob.transcriptsFound === 1 ? "" : "s"} and no verified MP4s. Retry with the same player, team, and season; a script is optional and Cut IQ will generate the football coverage plan when it is blank.
                </p>
              </div>
              <button
                onClick={() => navigate("/new-job", { state: { initialDraft: {
                  player: findJob.player,
                  team: findJob.team,
                  season: findJob.season,
                  games: findJob.opponent ?? "",
                  preferredHeight: findJob.preferredHeight,
                  minimumHeight: findJob.minimumHeight,
                  preRollSec: findJob.preRollSec,
                  postRollSec: findJob.postRollSec,
                  localAsrFallback: findJob.localAsrFallback,
                } } })}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry as new job
              </button>
            </div>
          )}
          <FindJobProgress
            progress={findJob.progressPercent}
            stage={findJob.stage}
            operation={["completed", "completed_with_warnings"].includes(findJob.status) && findJob.clipsVerified === 0 ? "Finished without verified clips" : findJob.currentOperation?.replaceAll("ClipSift", "Cut IQ")}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_repeat(5,1fr)]">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Current activity</p>
              <p className="mt-1 text-xs text-zinc-200">
                {["completed", "completed_with_warnings"].includes(findJob.status) && findJob.clipsVerified === 0 ? "Finished without verified clips" : findJob.currentOperation?.replaceAll("ClipSift", "Cut IQ") ?? findJob.stage.replaceAll("ClipSift", "Cut IQ")}
              </p>
              {findJob.lastError && <p className="mt-1 truncate text-[10px] text-amber-400">{findJob.lastError}</p>}
            </div>
            {[["Sources", findJob.sourcesFound], ["Transcripts", findJob.transcriptsFound], ["Candidates", findJob.candidatesFound], ["Clips queued", findJob.clipsQueued], ["Verified", findJob.clipsVerified]].map(([label, value]) => (
              <div key={String(label)}><p className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</p><p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p></div>
            ))}
          </div>
        </div>
      )}

      {/* Clip queue — export one-by-one or the whole batch */}
      <div className="border-b border-zinc-800 bg-zinc-950/40">
        <ClipJobsPanel projectFk={projectId} />
      </div>

      {/* Clip map */}
      <div className="flex-1 overflow-y-auto p-4">
        {beats.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <Clapperboard className="h-10 w-10 text-zinc-700" />
            <p className="text-sm text-zinc-400">
              {data.revision ? "Script stored. Run the pipeline to split it into visual beats and find clips." : "No script revision yet."}
            </p>
            {!running && (
              <button onClick={() => runPipeline.mutate({ projectId })} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
                Analyze Script & Find Clips
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {(beats as BeatRow[]).map((b) => {
              const cands = visibleCands(candsByBeat.get(b.id) ?? []);
              const all = candsByBeat.get(b.id) ?? [];
              return (
                <section key={b.id} className="rounded-xl border border-zinc-800 bg-zinc-950">
                  <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600/15 font-mono text-xs text-brand-300">{b.ord + 1}</span>
                    <p className="min-w-0 flex-1 text-sm text-zinc-200">{b.text}</p>
                    <button
                      onClick={() => updateBeat.mutate({ id: b.id, status: b.status === "needs_footage" ? "covered" : "needs_footage" })}
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] ${b.status === "covered" ? "bg-emerald-500/15 text-emerald-300" : b.status === "needs_footage" ? "bg-amber-500/15 text-amber-300" : "bg-zinc-800 text-zinc-400"}`}
                      title="Toggle covered / needs footage"
                    >
                      {b.status === "covered" ? "Covered" : b.status === "needs_footage" ? "Needs footage" : "Pending"}
                    </button>
                  </div>
                  {b.uncertainty && <p className="px-3 pt-2 text-[11px] text-amber-400/80">{b.uncertainty}</p>}
                  <div className="space-y-2 p-3">
                    {cands.length === 0 ? (
                      <p className="py-2 text-center text-xs text-zinc-600">
                        {all.length === 0
                          ? b.visualOnly
                            ? "Visual-only beat — no transcript evidence possible. Add a source URL above or use the external search links, then rerun this beat."
                            : "No candidates yet — rerun discovery for this beat or add a source URL above."
                          : "Hidden by filter."}
                      </p>
                    ) : (
                      cands.map((c) => <CandidateCard key={c.id} c={c} onPreview={setPreview} />)
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {preview && (
        <PreviewModal
          c={preview}
          clips={beats.flatMap((b) => visibleCands(candsByBeat.get(b.id) ?? []))}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
        />
      )}
      {showSubmit && (
        <SubmitDialog
          onClose={() => setShowSubmit(false)}
          onCreated={() => { setShowSubmit(false); utils.script.project.invalidate(); }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- list ----

export default function ScriptProjects({ initialProjectId }: { initialProjectId?: number }) {
  const [selected, setSelected] = useState<number | null>(initialProjectId ?? null);
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const projectsQuery = trpc.script.listProjects.useQuery(undefined, { refetchInterval: selected ? false : 3000 });
  const jobsQuery = trpc.findClips.list.useQuery(undefined, {
    refetchInterval: selected ? false : (query) => {
      const jobs = query.state.data ?? [];
      return jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status)) ? 2000 : false;
    },
  });
  const projects = projectsQuery.data ?? [];
  const findJobs = jobsQuery.data ?? [];
  const findByProject = new Map(findJobs.map((job) => [Number(job.projectFk), job]));
  const selectedIdList = [...selectedIds].sort((a, b) => a - b);
  const deletionPreview = trpc.script.projectDeletionPreview.useQuery(
    { ids: selectedIdList.length ? selectedIdList : [1] },
    { enabled: deleteOpen && selectedIdList.length > 0, retry: false },
  );
  const deleteProjects = trpc.script.deleteProjectsAndClips.useMutation({
    onSuccess: (result) => {
      setDeleteOpen(false);
      setDeleteConfirmation("");
      setSelectedIds(new Set());
      setManageMode(false);
      const driveTargets = result.deletedDriveFiles + result.deletedRemoteFolders;
      setDeleteNotice(`Deleted ${result.projectCount} project${result.projectCount === 1 ? "" : "s"}, ${result.deletedLocalFiles} local clip${result.deletedLocalFiles === 1 ? "" : "s"}, and ${driveTargets} Google Drive target${driveTargets === 1 ? "" : "s"}.`);
      void Promise.all([utils.script.listProjects.invalidate(), utils.findClips.list.invalidate()]);
    },
  });

  const toggleProject = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openProject = (id: number) => {
    const job = findByProject.get(Number(id));
    if (job && ["completed", "completed_with_warnings"].includes(job.status) && job.clipsVerified > 0) {
      navigate(`/clip-package?project=${id}`);
      return;
    }
    setSelected(id);
    navigate(`/?project=${id}`);
  };

  const closeProject = () => {
    setSelected(null);
    navigate("/");
    utils.script.listProjects.invalidate();
  };

  if (selected != null) {
    return <div className="flex min-h-0 flex-1 flex-col"><AppNav active="find" /><ProjectDetail projectId={selected} onBack={closeProject} /></div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppNav active="find" actions={<div className="flex items-center gap-2"><button onClick={() => { setManageMode((value) => !value); setSelectedIds(new Set()); setDeleteNotice(null); }} className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 ${manageMode ? "border-zinc-600 bg-zinc-800 text-white" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}><ListChecks className="h-3.5 w-3.5" /><span className="hidden sm:inline">{manageMode ? "Done" : "Manage projects"}</span><span className="sm:hidden">Manage</span></button><button onClick={() => navigate("/new-job")} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"><FileText className="h-3.5 w-3.5" /><span className="hidden sm:inline">New job</span><span className="sm:hidden">New</span></button></div>} />
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">Find Clips projects</h1>
          <p className="mt-0.5 text-xs text-zinc-500">Script beats → caption-first discovery → verified clips</p>
        </div>
      </div>
      {deleteNotice && <div className="border-b border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-2 text-xs text-emerald-300" role="status">{deleteNotice}</div>}
      {manageMode && projects.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <button onClick={() => setSelectedIds(new Set(projects.map((project) => Number(project.id))))} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800">Select all</button>
          <button onClick={() => setSelectedIds(new Set())} disabled={!selectedIds.size} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40">Clear</button>
          <span className="text-xs text-zinc-500">{selectedIds.size} selected</span>
          <button onClick={() => { setDeleteConfirmation(""); deleteProjects.reset(); setDeleteOpen(true); }} disabled={!selectedIds.size} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />Delete selected</button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-4">
        {projectsQuery.isLoading || jobsQuery.isLoading ? (
          <InlineLoading label="Loading Find Clips projects…" />
        ) : projectsQuery.isError || jobsQuery.isError ? (
          <InlineError title="Projects could not be loaded" message={projectsQuery.error?.message ?? jobsQuery.error?.message ?? "Cut IQ could not load project history."} onRetry={() => { void projectsQuery.refetch(); void jobsQuery.refetch(); }} />
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-600/10 ring-1 ring-brand-500/30">
              <Clapperboard className="h-8 w-8 text-brand-400" />
            </div>
            <h2 className="text-lg font-semibold">No Find Clips jobs yet</h2>
            <p className="max-w-md text-sm text-zinc-400">
              Add a player, team, season, and finished script. Cut IQ owns the durable job,
              searches captions before downloading media, and produces verified clips for review.
            </p>
            <button onClick={() => navigate("/new-job")} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
              New job
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const job = findByProject.get(Number(p.id));
              const checked = selectedIds.has(Number(p.id));
              return (
              <div
                key={p.id}
                className={`relative rounded-xl border bg-zinc-900/50 transition-colors ${checked ? "border-brand-500/70 ring-1 ring-brand-500/30" : "border-zinc-800 hover:border-brand-500/50"}`}
              >
                {manageMode && <button onClick={() => toggleProject(Number(p.id))} className="absolute right-3 top-3 z-10 rounded-md bg-zinc-950/80 p-1 text-zinc-300 hover:text-white" aria-label={`${checked ? "Deselect" : "Select"} ${p.name}`}>{checked ? <CheckSquare className="h-5 w-5 text-brand-400" /> : <Square className="h-5 w-5" />}</button>}
                <button
                  onClick={() => manageMode ? toggleProject(Number(p.id)) : openProject(p.id)}
                  className="block w-full rounded-xl p-4 pr-12 text-left hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${job?.status === "completed" || p.status === "ready_for_review" ? "bg-emerald-400" : job?.status === "completed_with_warnings" || p.status === "partially_complete" ? "bg-amber-400" : job?.status === "failed" || p.status === "failed" ? "bg-red-400" : job?.status === "running" ? "bg-red-400 animate-pulse" : "bg-zinc-600"}`} />
                    <p className="truncate text-sm font-medium text-zinc-100">{p.name}</p>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {job ? job.status.replaceAll("_", " ") : STATUS_LABELS[p.status] ?? p.status} · rev {p.currentRevision}
                    {p.sourceTitle ? ` · ${p.sourceTitle.slice(0, 40)}` : ""}
                  </p>
                  {job && <FindJobProgress progress={job.progressPercent} stage={job.stage} operation={job.currentOperation?.replaceAll("ClipSift", "Cut IQ")} compact />}
                  <p className="mt-2 text-[11px] text-zinc-600">{new Date(p.updatedAt).toLocaleString()}</p>
                </button>
              </div>
            )})}
          </div>
        )}
      </div>
      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!deleteProjects.isPending) setDeleteOpen(open); }}>
        <DialogContent className="border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete {selectedIds.size} project{selectedIds.size === 1 ? "" : "s"} and all clips?</DialogTitle>
          <DialogDescription className="text-zinc-400">This removes the selected project records, their managed MP4s from the Cut IQ Clips folder, and their connected Google Drive copies. Source YouTube videos are not affected.</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-300">
            {deletionPreview.isLoading ? <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Checking files and Drive targets…</span> : deletionPreview.isError ? <p className="text-red-300">{deletionPreview.error.message}</p> : deletionPreview.data ? <>
              <p>{deletionPreview.data.projectCount} project{deletionPreview.data.projectCount === 1 ? "" : "s"} · {deletionPreview.data.localFileCount} D: clip{deletionPreview.data.localFileCount === 1 ? "" : "s"} · {deletionPreview.data.driveFileCount} Drive-synced clip{deletionPreview.data.driveFileCount === 1 ? "" : "s"}{deletionPreview.data.remoteFolderCount ? ` · ${deletionPreview.data.remoteFolderCount} remote project folder${deletionPreview.data.remoteFolderCount === 1 ? "" : "s"}` : ""}</p>
              {deletionPreview.data.activeProjectNames.length > 0 && <p className="mt-2 text-amber-300">Stop or cancel active work first: {deletionPreview.data.activeProjectNames.join(", ")}</p>}
            </> : null}
          </div>
          <label className="text-xs text-zinc-400">Type <span className="font-mono font-semibold text-zinc-200">DELETE</span> to confirm.
            <input autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-brand-500" />
          </label>
          {deleteProjects.isError && <p className="text-xs text-red-300" role="alert">{deleteProjects.error.message}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeleteOpen(false)} disabled={deleteProjects.isPending} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">Cancel</button>
            <button
              onClick={() => deleteProjects.mutate({ ids: selectedIdList, confirmation: "DELETE" })}
              disabled={deleteConfirmation !== "DELETE" || deletionPreview.isLoading || deletionPreview.isError || !!deletionPreview.data?.activeProjectNames.length || deleteProjects.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {deleteProjects.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete projects and clips
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
