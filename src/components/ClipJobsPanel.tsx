/**
 * Clip Jobs panel — the Find Clips project render queue. Shows live progress, lets you
 * export one clip or a whole batch (to the configured Clips folder, optional Google Drive), and
 * retry/cancel failed jobs.
 */
import { useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { fmtTime } from "@/lib/youtube";
import { normalizeYouTubeUrl } from "@/lib/transcriptStudio";
import { Player, type PlayerHandle } from "@/components/Player";
import {
  Download, UploadCloud, Loader2, RotateCw,
  X, ListChecks, Film, Play, ChevronDown, ChevronUp, Scissors,
} from "lucide-react";

type JobView = {
  id: number;
  kind: "candidate" | "moment";
  projectFk: number | null;
  candidateFk: number | null;
  momentFk: number | null;
  videoFk: number | null;
  sourceUrl: string;
  title: string;
  contextLabel?: string | null;
  sourceTitle?: string | null;
  selectionKind?: "player_play" | "mention_match" | null;
  fileName: string | null;
  editIn: number;
  editOut: number;
  height: number;
  uploadToDrive: boolean;
  status: "queued" | "downloading" | "uploading" | "ready" | "failed" | "cancelled";
  progress: number;
  stage: string;
  outputPath: string | null;
  fileSizeBytes: number | null;
  drivePath: string | null;
  error: string | null;
  diagnosticError: string | null;
  downloadUrl: string | null;
  sizeLabel: string | null;
};

function statusStyle(s: JobView["status"]) {
  switch (s) {
    case "ready": return { dot: "bg-emerald-400", text: "text-emerald-300", label: "Ready" };
    case "downloading": return { dot: "bg-sky-400 animate-pulse", text: "text-sky-300", label: "Rendering" };
    case "uploading": return { dot: "bg-violet-400 animate-pulse", text: "text-violet-300", label: "Uploading" };
    case "queued": return { dot: "bg-zinc-500", text: "text-zinc-400", label: "Queued" };
    case "failed": return { dot: "bg-red-400", text: "text-red-300", label: "Failed" };
    case "cancelled": return { dot: "bg-zinc-700", text: "text-zinc-500", label: "Cancelled" };
  }
}

function JobRangeEditor({ j }: { j: JobView }) {
  const utils = trpc.useUtils();
  const normalized = normalizeYouTubeUrl(j.sourceUrl);
  const playerRef = useRef<PlayerHandle>(null);
  const [playhead, setPlayhead] = useState(j.editIn);
  const [editIn, setEditIn] = useState(j.editIn);
  const [editOut, setEditOut] = useState(j.editOut);
  const [previewRange, setPreviewRange] = useState<{ inSec: number; outSec: number } | null>(null);
  const [queuedJobId, setQueuedJobId] = useState<number | null>(null);
  const requeue = trpc.clips.requeueWithRange.useMutation({
    onSuccess: (result) => {
      setQueuedJobId(result.jobId);
      utils.clips.listJobs.invalidate();
    },
  });
  const active = j.status === "queued" || j.status === "downloading" || j.status === "uploading";
  const rangeValid = Number.isFinite(editIn) && Number.isFinite(editOut) && editIn >= 0 && editOut > editIn + 0.05;

  if (!normalized.ok) {
    return <p className="mt-2 rounded-md border border-zinc-800 bg-black/30 p-3 text-xs text-zinc-500">This source cannot be previewed inside Cut IQ.</p>;
  }

  return (
    <div data-testid={`clip-job-editor-${j.id}`} className="mt-2 rounded-lg border border-zinc-700 bg-zinc-950 p-3">
      <div className="mx-auto max-w-3xl">
        <Player
          ref={playerRef}
          videoId={normalized.videoId}
          startAt={editIn}
          onTime={setPlayhead}
          previewRange={previewRange}
          onPreviewEnd={() => setPreviewRange(null)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-300">Playhead {fmtTime(playhead)}</span>
        <button
          type="button"
          onClick={() => setEditIn(playerRef.current?.getTime() ?? playhead)}
          className="rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
        >
          Set In
        </button>
        <input
          aria-label="Clip In seconds"
          type="number"
          min="0"
          step="0.1"
          value={editIn}
          onChange={(event) => setEditIn(Number(event.target.value))}
          className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100"
        />
        <button
          type="button"
          onClick={() => setEditOut(playerRef.current?.getTime() ?? playhead)}
          className="rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
        >
          Set Out
        </button>
        <input
          aria-label="Clip Out seconds"
          type="number"
          min="0"
          step="0.1"
          value={editOut}
          onChange={(event) => setEditOut(Number(event.target.value))}
          className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-100"
        />
        <span className="font-mono text-[11px] text-red-400">{rangeValid ? fmtTime(editOut - editIn) : "Invalid range"}</span>
        <button
          type="button"
          disabled={!rangeValid}
          onClick={() => {
            setPreviewRange({ inSec: editIn, outSec: editOut });
            playerRef.current?.seekTo(editIn);
          }}
          className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          <Play className="h-3 w-3" /> Preview range
        </button>
        <button
          type="button"
          disabled={!rangeValid || active || requeue.isPending}
          onClick={() => requeue.mutate({ id: j.id, editIn, editOut })}
          className="ml-auto flex items-center gap-1 rounded bg-brand-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-brand-500 disabled:opacity-40"
          title={active ? "Wait for this export to finish before changing its range" : "Save this range and create a new export without deleting the existing file"}
        >
          {requeue.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Scissors className="h-3 w-3" />}
          Save &amp; queue new export
        </button>
      </div>
      {active && <p className="mt-2 text-[10px] text-amber-300">This export is active. Cancel or wait for it to finish before replacing its range.</p>}
      {requeue.error && <p className="mt-2 text-[10px] text-red-400">{requeue.error.message}</p>}
      {queuedJobId != null && <p className="mt-2 text-[10px] text-emerald-300">Updated range saved. Replacement export #{queuedJobId} is in the queue.</p>}
    </div>
  );
}

function JobRow({ j, expanded, onToggle }: { j: JobView; expanded: boolean; onToggle: () => void }) {
  const utils = trpc.useUtils();
  const retry = trpc.clips.retry.useMutation({ onSuccess: () => utils.clips.listJobs.invalidate() });
  const cancel = trpc.clips.cancel.useMutation({ onSuccess: () => utils.clips.listJobs.invalidate() });
  const st = statusStyle(j.status);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
        <span className="flex-1 truncate text-xs font-medium text-zinc-200">{j.contextLabel ?? j.title}</span>
        <span className={`text-[10px] ${st.text}`}>{st.label}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
        <span className="font-mono">{fmtTime(j.editIn)} – {fmtTime(j.editOut)}</span>
        <span className="text-zinc-600">·</span>
        <span>{j.height > 0 ? `${j.height}p` : "best"}</span>
        {j.contextLabel && j.sourceTitle && <span className="min-w-0 truncate text-zinc-600">· Source: {j.sourceTitle}</span>}
        {j.uploadToDrive && <span className="text-violet-400">· Drive</span>}
        {j.sizeLabel && <span>· {j.sizeLabel}</span>}
      </div>
      {(j.status === "downloading" || j.status === "uploading" || j.status === "queued") && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full ${j.status === "uploading" ? "bg-violet-500" : "bg-sky-500"}`}
            style={{ width: `${Math.max(2, j.progress)}%` }}
          />
        </div>
      )}
      {j.stage && (j.status === "downloading" || j.status === "uploading") && (
        <p className="mt-0.5 text-[10px] text-zinc-500">{j.stage}</p>
      )}
      {j.status === "failed" && j.error && (
        <div className="mt-0.5">
          <p className="break-words text-[10px] text-red-400/80">{j.error.slice(0, 240)}</p>
          {j.diagnosticError && (
            <details className="mt-1 text-[10px] text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Technical details</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[11px] text-zinc-400">{j.diagnosticError}</pre>
            </details>
          )}
        </div>
      )}
      {j.status === "ready" && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {j.downloadUrl && (
            <a
              href={j.downloadUrl}
              className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-700"
            >
              <Download className="h-3 w-3" /> Download
            </a>
          )}
          {j.drivePath && (
            <span className="flex items-center gap-1 text-[10px] text-violet-300">
              <UploadCloud className="h-3 w-3" /> Drive
            </span>
          )}
        </div>
      )}
      {(j.status === "failed" || j.status === "cancelled") && (
        <button
          type="button"
          onClick={() => retry.mutate({ id: j.id })}
          disabled={retry.isPending}
          className="mt-1.5 flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          {retry.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />} Retry export
        </button>
      )}
      {retry.error && <p className="mt-1 text-[11px] text-red-400" role="alert">{retry.error.message}</p>}
      <button
        type="button"
        onClick={onToggle}
        className="mt-2 flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-700"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {expanded ? "Close preview" : "Preview & set In/Out"}
      </button>
      {expanded && <JobRangeEditor key={`${j.id}:${j.editIn}:${j.editOut}`} j={j} />}
      {j.status === "queued" && (
        <button
          onClick={() => cancel.mutate({ id: j.id })}
          className="mt-1.5 flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700"
        >
          <X className="h-3 w-3" /> Cancel
        </button>
      )}
    </div>
  );
}

interface Props {
  /** Project-scoped queue (script mode) — show that project's jobs. */
  projectFk?: number;
  /** Legacy video-scoped queue retained for stored moment exports. */
  videoFk?: number;
  /** Compact variant for the right rail. */
  compact?: boolean;
}

export function ClipJobsPanel({ projectFk, videoFk, compact }: Props) {
  const utils = trpc.useUtils();
  const { data: jobs = [] } = trpc.clips.listJobs.useQuery(
    videoFk ? { videoFk } : projectFk ? { projectFk } : {},
    { refetchInterval: (query) => {
        const jobs = query.state.data ?? [];
        const hasActive = jobs.some((j) => ["queued", "downloading", "uploading", "rendering"].includes(j.status));
        return hasActive ? 2500 : false;
      } },
  );
  const [upload, setUpload] = useState(false);
  const [open, setOpen] = useState(true);
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  const [showEarlierMatches, setShowEarlierMatches] = useState(false);

  // Only show jobs relevant to this scope.
  const scoped = jobs.filter((j) =>
    videoFk ? j.videoFk === videoFk : projectFk ? j.projectFk === projectFk : true,
  );
  const playerPlays = scoped.filter((job) => job.selectionKind === "player_play");
  const canonical = playerPlays.length ? playerPlays : scoped;
  const earlierMatches = playerPlays.length ? scoped.filter((job) => job.selectionKind !== "player_play") : [];
  const visibleJobs = showEarlierMatches ? [...canonical, ...earlierMatches] : canonical;
  const active = canonical.filter((j) => j.status === "queued" || j.status === "downloading" || j.status === "uploading");
  const ready = canonical.filter((j) => j.status === "ready");
  const failed = canonical.filter((j) => j.status === "failed");

  const renderAll = trpc.clips.renderProject.useMutation({ onSuccess: () => utils.clips.listJobs.invalidate() });
  const renderVideo = trpc.clips.renderVideoMoments.useMutation({ onSuccess: () => utils.clips.listJobs.invalidate() });

  const doExportAll = () => {
    if (renderAll.isPending || renderVideo.isPending) return;
    if (projectFk != null) renderAll.mutate({ projectId: projectFk, uploadToDrive: upload });
    else if (videoFk != null) renderVideo.mutate({ videoDbId: videoFk, uploadToDrive: upload });
  };

  if (scoped.length === 0) return null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen((v) => !v)} className="flex flex-1 items-center gap-2 text-left">
          <Film className="h-4 w-4 text-brand-500" />
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{projectFk ? "New cuts for this project" : "Clip Queue"}</span>
          {active.length > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] text-sky-300">
              <Loader2 className="h-3 w-3 animate-spin" /> {active.length}
            </span>
          )}
          {ready.length > 0 && (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">{ready.length} ready</span>
          )}
          {failed.length > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-300">{failed.length} failed</span>
          )}
        </button>
      </div>

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <div className="flex items-center gap-1.5">
            <button
              onClick={doExportAll}
              disabled={renderAll.isPending || renderVideo.isPending}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-40"
            >
              {renderAll.isPending || renderVideo.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListChecks className="h-3.5 w-3.5" />}
              Export all to your Clips folder{upload ? " + Drive" : ""}
            </button>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 pl-1 text-[11px] text-zinc-400">
            <input type="checkbox" checked={upload} onChange={(e) => setUpload(e.target.checked)} className="accent-brand-600" />
            Also upload to Google Drive (optional)
          </label>

          {earlierMatches.length > 0 && (
            <button
              type="button"
              onClick={() => setShowEarlierMatches((value) => !value)}
              className="flex w-full items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-left text-[11px] text-amber-200 hover:bg-amber-500/10"
              aria-expanded={showEarlierMatches}
            >
              <span>{earlierMatches.length} earlier mention/non-highlight match{earlierMatches.length === 1 ? "" : "es"} preserved</span>
              {showEarlierMatches ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}

          <div className="space-y-1.5">
            {visibleJobs.slice(0, compact ? 12 : 50).map((j) => (
              <JobRow
                key={j.id}
                j={j as JobView}
                expanded={expandedJobId === j.id}
                onToggle={() => setExpandedJobId((current) => current === j.id ? null : j.id)}
              />
            ))}
          </div>
          {visibleJobs.length > (compact ? 12 : 50) && (
            <p className="text-center text-[10px] text-zinc-600">+{visibleJobs.length - (compact ? 12 : 50)} more</p>
          )}
        </div>
      )}
    </div>
  );
}
