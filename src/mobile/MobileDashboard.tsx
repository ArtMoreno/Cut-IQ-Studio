import { Link } from "react-router";
import {
  AlertTriangle,
  ChevronRight,
  CirclePause,
  Clapperboard,
  Loader2,
  Play,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { trpc } from "@/providers/trpc";
import {
  ACTIVE_JOB_STATUSES,
  COMPLETE_JOB_STATUSES,
  stageLabel,
} from "./mobileUtils";

export default function MobileDashboard({
  mode,
}: {
  mode: "jobs" | "packages";
}) {
  const utils = trpc.useUtils();
  const jobs = trpc.findClips.list.useQuery(undefined, {
    refetchInterval: 4000,
  });
  const action = trpc.findClips.action.useMutation({
    onSuccess: () => utils.findClips.list.invalidate(),
  });
  const rows = (jobs.data ?? []).filter(
    job => mode === "jobs" || COMPLETE_JOB_STATUSES.includes(job.status)
  );
  const sorted = [...rows].sort(
    (a, b) =>
      Number(ACTIVE_JOB_STATUSES.includes(b.status)) -
        Number(ACTIVE_JOB_STATUSES.includes(a.status)) ||
      +new Date(b.updatedAt) - +new Date(a.updatedAt)
  );
  return (
    <section aria-labelledby="mobile-dashboard-title">
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-400">
            {mode === "jobs" ? "Companion dashboard" : "Finished work"}
          </p>
          <h1
            id="mobile-dashboard-title"
            className="mt-1 text-2xl font-semibold tracking-tight"
          >
            {mode === "jobs" ? "Jobs" : "Clip packages"}
          </h1>
        </div>
        {mode === "jobs" && (
          <Link
            to="/m/new"
            className="flex min-h-11 items-center rounded-xl bg-brand-600 px-4 text-sm font-bold text-white"
          >
            New job
          </Link>
        )}
      </div>
      {action.isError && (
        <div
          role="alert"
          className="mb-3 rounded-xl border border-brand-500/25 bg-brand-500/10 p-3 text-sm text-brand-200"
        >
          {action.error.message}
          <button onClick={() => action.reset()} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}
      {jobs.isLoading ? (
        <div className="flex min-h-48 items-center justify-center text-zinc-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading jobs
        </div>
      ) : jobs.isError ? (
        <div
          role="alert"
          className="rounded-2xl border border-brand-500/25 bg-brand-500/10 p-4 text-sm text-brand-200"
        >
          <AlertTriangle className="mb-2 h-5 w-5" />
          {jobs.error.message}
          <button
            onClick={() => jobs.refetch()}
            className="mt-4 min-h-11 w-full rounded-xl border border-brand-400/30"
          >
            Retry
          </button>
        </div>
      ) : !sorted.length ? (
        <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/40 p-8 text-center">
          <Clapperboard className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-3 font-semibold">
            {mode === "jobs"
              ? "No Cut IQ jobs yet"
              : "No finished packages yet"}
          </p>
          <p className="mt-1 text-sm text-zinc-500">
            {mode === "jobs"
              ? "Start your first player search from this phone."
              : "Completed jobs will appear here automatically."}
          </p>
          {mode === "jobs" && (
            <Link
              to="/m/new"
              className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-4 text-sm font-bold"
            >
              Start first job
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map(job => {
            const active = ["queued", "running"].includes(job.status);
            const complete = COMPLETE_JOB_STATUSES.includes(job.status);
            const percent = Math.max(
              0,
              Math.min(100, Math.round(job.progressPercent))
            );
            return (
              <article
                key={job.id}
                className="rounded-2xl border border-white/10 bg-[#0e1013] p-4 shadow-xl shadow-black/20"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold leading-snug">
                      {job.player}
                    </h2>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {job.team} · {job.season}
                    </p>
                  </div>
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${complete ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" : job.status === "failed" ? "border-red-500/25 bg-red-500/10 text-red-300" : "border-sky-500/25 bg-sky-500/10 text-sky-200"}`}
                  >
                    {job.status.replaceAll("_", " ")}
                  </span>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3 text-xs">
                  <span className="truncate font-medium text-zinc-300">
                    {stageLabel(job.stage)}
                  </span>
                  <span className="font-mono text-zinc-400">{percent}%</span>
                </div>
                <div
                  className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label={`${job.player} progress`}
                >
                  <div
                    className={`h-full rounded-full transition-[width] ${complete ? "bg-emerald-500" : "bg-brand-500"}`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-zinc-500">
                  {job.currentOperation?.replaceAll("ClipSift", "Cut IQ") ??
                    "Waiting for the next pipeline update"}
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/5 pt-3 text-center">
                  <div>
                    <strong className="block font-mono text-sm">
                      {job.sourcesFound}
                    </strong>
                    <span className="text-[10px] text-zinc-600">sources</span>
                  </div>
                  <div>
                    <strong className="block font-mono text-sm">
                      {job.candidatesFound}
                    </strong>
                    <span className="text-[10px] text-zinc-600">moments</span>
                  </div>
                  <div>
                    <strong className="block font-mono text-sm text-emerald-300">
                      {job.clipsVerified}
                    </strong>
                    <span className="text-[10px] text-zinc-600">
                      clips ready
                    </span>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  {complete ? (
                    <Link
                      to={`/m/package/${job.projectFk}`}
                      className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-bold"
                    >
                      <Play className="h-4 w-4" />
                      Open clips
                    </Link>
                  ) : job.status === "cancelling" ? (
                    <span className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-sm font-semibold text-amber-200">
                      Cancelling safely…
                    </span>
                  ) : active ? (
                    <>
                      <button
                        onClick={() =>
                          action.mutate({ id: job.id, action: "pause" })
                        }
                        disabled={action.isPending}
                        className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-zinc-700 text-sm font-semibold"
                      >
                        <CirclePause className="h-4 w-4" />
                        Pause
                      </button>
                      <button
                        onClick={() =>
                          window.confirm(
                            `Cancel ${job.player}'s job? Finished clips remain saved.`
                          ) && action.mutate({ id: job.id, action: "cancel" })
                        }
                        disabled={action.isPending}
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-brand-500/35 text-brand-300"
                        aria-label={`Cancel ${job.player} job`}
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </>
                  ) : job.status === "paused" ? (
                    <>
                      <button
                        onClick={() =>
                          action.mutate({ id: job.id, action: "resume" })
                        }
                        disabled={action.isPending}
                        className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-bold"
                      >
                        <Play className="h-4 w-4" />
                        Resume
                      </button>
                      <button
                        onClick={() =>
                          window.confirm(
                            `Cancel ${job.player}'s paused job? Finished clips remain saved.`
                          ) && action.mutate({ id: job.id, action: "cancel" })
                        }
                        disabled={action.isPending}
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-brand-500/35 text-brand-300"
                        aria-label={`Cancel ${job.player} job`}
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </>
                  ) : job.status === "failed" ? (
                    <button
                      onClick={() =>
                        action.mutate({ id: job.id, action: "retry" })
                      }
                      disabled={action.isPending}
                      className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-bold"
                    >
                      <RotateCcw className="h-4 w-4" />
                      Retry
                    </button>
                  ) : null}
                  <Link
                    to={
                      complete
                        ? `/m/package/${job.projectFk}`
                        : `/?project=${job.projectFk}`
                    }
                    className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-zinc-700"
                    aria-label={`Open ${job.player}`}
                  >
                    <ChevronRight className="h-5 w-5" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
