import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Search,
} from "lucide-react";
import { skipToken } from "@tanstack/react-query";
import { trpc } from "@/providers/trpc";
import { Player, type PlayerHandle } from "@/components/Player";
import { StudioMediaPlayer } from "@/components/studio/StudioMediaPlayer";
import { fmtDuration, videoIdFromUrl } from "./mobileUtils";

type Segment = {
  id: number;
  idx: number;
  text: string;
  start: number;
  end: number;
};

export default function MobileReview() {
  const [params] = useSearchParams();
  const handoffId = params.get("handoff") ?? "";
  const playerRef = useRef<PlayerHandle>(null);
  const handoff = trpc.clipPackage.studioHandoff.useQuery(
    handoffId ? { handoffId } : skipToken,
    {
      refetchInterval: q =>
        q.state.data && q.state.data.status !== "draft" ? 1000 : false,
    }
  );
  const openVideo = trpc.clipsift.openVideo.useMutation();
  const saveDraft = trpc.clipPackage.saveStudioHandoffDraft.useMutation();
  const setIntent = trpc.clipPackage.setStudioHandoffIntent.useMutation();
  const queueExport = trpc.studio.queueExport.useMutation();
  const attachExport = trpc.clipPackage.attachStudioExport.useMutation();
  const activate = trpc.clipPackage.activateEditedVersion.useMutation();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(1);
  const [query, setQuery] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [saveMode, setSaveMode] = useState<"new_version" | "replacement">(
    "new_version"
  );
  const version = trpc.clipPackage.editedVersion.useQuery(
    versionId ? { versionId } : skipToken,
    {
      refetchInterval: q =>
        ["ready", "failed", "retired"].includes(q.state.data?.status ?? "")
          ? false
          : 750,
    }
  );
  const data = handoff.data;
  useEffect(() => {
    if (!data) return;
    setInPoint(data.suggestedIn);
    setOutPoint(data.suggestedOut);
    setCurrentTime(data.suggestedIn);
    setSaveMode(data.intent);
    setDuration(value => Math.max(value, data.suggestedOut));
    openVideo.mutate(
      { videoDbId: data.videoDbId },
      {
        onSuccess: result => {
          setSegments(result.segments as Segment[]);
          setDuration(Number(result.video?.durationSec ?? data.suggestedOut));
        },
      }
    );
    // Hydrate exactly once per handoff; polling must not reset the user's marks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.handoffId]);
  useEffect(() => {
    if (data && (data.studioExportId != null || data.status !== "draft")) {
      setVersionId(data.version.id);
    }
  }, [data]);
  const filtered = useMemo(
    () =>
      query.trim()
        ? segments.filter(segment =>
            segment.text.toLowerCase().includes(query.trim().toLowerCase())
          )
        : segments,
    [query, segments]
  );
  const youtubeId = data ? videoIdFromUrl(data.sourceUrl) : null;
  const localSource = data?.sourceUrl.startsWith("file:")
    ? `/api/studio-media/${data.videoDbId}`
    : null;
  const valid =
    Number.isFinite(inPoint) &&
    Number.isFinite(outPoint) &&
    inPoint >= 0 &&
    outPoint > inPoint + 0.05 &&
    (!duration || outPoint <= duration + 0.25);
  const nudge = (which: "in" | "out", delta: number) => {
    if (which === "in")
      setInPoint(value => Math.max(0, Math.min(value + delta, outPoint - 0.1)));
    else
      setOutPoint(value =>
        Math.min(
          duration || Number.MAX_SAFE_INTEGER,
          Math.max(inPoint + 0.1, value + delta)
        )
      );
  };
  const persist = async (expected?: {
    editIn: number;
    editOut: number;
    intent: "new_version" | "replacement";
  }) => {
    if (!data || !valid) return;
    const baseline = expected ?? {
      editIn: data.suggestedIn,
      editOut: data.suggestedOut,
      intent: data.intent,
    };
    const saved = await saveDraft.mutateAsync({
      handoffId: data.handoffId,
      editIn: inPoint,
      editOut: outPoint,
      expectedEditIn: baseline.editIn,
      expectedEditOut: baseline.editOut,
      expectedIntent: baseline.intent,
    });
    await handoff.refetch();
    return saved;
  };
  const render = async () => {
    if (!data || !valid) return;
    try {
      let expected = {
        editIn: data.suggestedIn,
        editOut: data.suggestedOut,
        intent: data.intent,
      };
      if (saveMode !== data.intent) {
        const updated = await setIntent.mutateAsync({
          handoffId: data.handoffId,
          intent: saveMode,
        });
        expected = {
          editIn: updated.suggestedIn,
          editOut: updated.suggestedOut,
          intent: updated.intent,
        };
      }
      await persist(expected);
      const draftId = `mobile-${data.handoffId}`;
      const queued = await queueExport.mutateAsync({
        videoDbId: data.videoDbId,
        mode: "separate",
        title: `${data.projectName} revised clip`,
        items: [
          {
            draftId,
            label: data.beatText || data.sourceTitle || "Revised clip",
            inPoint,
            outPoint,
          },
        ],
      });
      const attached = await attachExport.mutateAsync({
        handoffId: data.handoffId,
        studioExportId: queued.export.id,
        draftId,
      });
      setVersionId(attached.version.id);
    } catch {
      /* mutation errors are rendered below */
    }
  };
  const busy =
    saveDraft.isPending ||
    setIntent.isPending ||
    queueExport.isPending ||
    attachExport.isPending;
  const error =
    handoff.error?.message ??
    openVideo.error?.message ??
    saveDraft.error?.message ??
    setIntent.error?.message ??
    queueExport.error?.message ??
    attachExport.error?.message ??
    activate.error?.message ??
    version.error?.message;
  if (handoff.isLoading)
    return (
      <div className="flex min-h-64 items-center justify-center text-zinc-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Opening source clip
      </div>
    );
  if (!data)
    return (
      <div
        role="alert"
        className="rounded-2xl border border-brand-500/25 bg-brand-500/10 p-4 text-sm text-brand-200"
      >
        <CircleAlert className="mb-2 h-5 w-5" />
        {error ?? "This edit handoff is unavailable."}
      </div>
    );
  return (
    <section className="pb-28">
      <Link
        to={`/m/package/${data.projectId}`}
        className="mb-2 inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to package
      </Link>
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-400">
        Mobile clip review
      </p>
      <h1 className="mt-1 line-clamp-2 text-xl font-semibold leading-tight">
        {data.sourceTitle ?? data.projectName}
      </h1>
      <p className="mt-1 text-xs text-zinc-500">
        Original {fmtDuration(data.originalIn)}–{fmtDuration(data.originalOut)}{" "}
        · your original stays recoverable
      </p>
      <div className="mt-4">
        {localSource ? (
          <StudioMediaPlayer
            ref={playerRef}
            src={localSource}
            title={data.sourceTitle ?? undefined}
            startAt={data.suggestedIn}
            previewRange={
              previewing ? { inSec: inPoint, outSec: outPoint } : null
            }
            onPreviewEnd={() => setPreviewing(false)}
            onTime={setCurrentTime}
            onDuration={setDuration}
          />
        ) : youtubeId ? (
          <Player
            ref={playerRef}
            videoId={youtubeId}
            startAt={data.suggestedIn}
            editorMode
            onTime={setCurrentTime}
            onDuration={setDuration}
            previewRange={
              previewing ? { inSec: inPoint, outSec: outPoint } : null
            }
            onPreviewEnd={() => setPreviewing(false)}
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-xl bg-zinc-900 p-6 text-center text-sm text-zinc-400">
            This source cannot be previewed on the phone.
          </div>
        )}
      </div>
      <div className="mt-4 rounded-2xl border border-white/10 bg-[#0e1013] p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-400">PLAYHEAD</span>
          <span className="font-mono text-sm text-white">
            {currentTime.toFixed(1)}s
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={0.1}
          value={Math.min(currentTime, Math.max(1, duration))}
          onChange={e => {
            const value = Number(e.target.value);
            setCurrentTime(value);
            playerRef.current?.seekTo(value, false);
          }}
          className="mt-3 h-11 w-full accent-brand-500"
          aria-label="Video playhead"
        />
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-[10px] font-bold text-emerald-400">IN</p>
            <p className="mt-1 font-mono text-lg">{inPoint.toFixed(1)}s</p>
            <button
              onClick={() => setInPoint(Math.min(currentTime, outPoint - 0.1))}
              className="mt-2 min-h-11 w-full rounded-lg bg-emerald-600 text-sm font-bold"
            >
              Set IN
            </button>
          </div>
          <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-3">
            <p className="text-[10px] font-bold text-brand-400">OUT</p>
            <p className="mt-1 font-mono text-lg">{outPoint.toFixed(1)}s</p>
            <button
              onClick={() => setOutPoint(Math.max(currentTime, inPoint + 0.1))}
              className="mt-2 min-h-11 w-full rounded-lg bg-brand-600 text-sm font-bold"
            >
              Set OUT
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {([-5, -1, -0.1] as const).map(value => (
            <button
              key={`in${value}`}
              onClick={() => nudge("in", value)}
              className="min-h-11 rounded-lg border border-zinc-700 text-xs font-semibold"
            >
              IN {value}s
            </button>
          ))}
          {([0.1, 1, 5] as const).map(value => (
            <button
              key={`out${value}`}
              onClick={() => nudge("out", value)}
              className="min-h-11 rounded-lg border border-zinc-700 text-xs font-semibold"
            >
              OUT +{value}s
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => {
              setInPoint(data.originalIn);
              setOutPoint(data.originalOut);
            }}
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 text-sm font-semibold"
          >
            <RotateCcw className="h-4 w-4" />
            Restore
          </button>
          <button
            onClick={() => {
              setPreviewing(true);
              playerRef.current?.seekTo(inPoint);
            }}
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 text-sm font-semibold"
          >
            {previewing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Preview range
          </button>
        </div>
        <p
          className={`mt-3 text-center font-mono text-xs ${valid ? "text-zinc-500" : "text-brand-300"}`}
        >
          {valid
            ? `${(outPoint - inPoint).toFixed(1)} seconds selected`
            : "Choose an OUT point after the IN point"}
        </p>
      </div>
      <div className="mt-4 rounded-2xl border border-white/10 bg-[#0e1013] p-4">
        <label className="relative block">
          <Search className="absolute left-3 top-3.5 h-4 w-4 text-zinc-600" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search transcript…"
            className="min-h-12 w-full rounded-xl border border-zinc-700 bg-zinc-900 pl-10 pr-3 text-base outline-none focus:border-brand-500"
          />
        </label>
        <div className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1">
          {filtered.length ? (
            filtered.map(segment => (
              <button
                key={segment.id}
                onClick={() => {
                  setCurrentTime(segment.start);
                  playerRef.current?.seekTo(segment.start);
                }}
                className={`flex min-h-11 w-full items-start gap-3 rounded-lg px-2 py-2 text-left ${currentTime >= segment.start && currentTime <= segment.end ? "bg-brand-500/10 text-white" : "text-zinc-400"}`}
              >
                <span className="shrink-0 font-mono text-[11px] text-brand-300">
                  {fmtDuration(segment.start)}
                </span>
                <span className="text-sm leading-snug">{segment.text}</span>
              </button>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-zinc-600">
              {openVideo.isPending
                ? "Loading transcript…"
                : data.transcriptAvailable
                  ? "No transcript lines match."
                  : "No transcript is available; manual IN/OUT still works."}
            </p>
          )}
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-brand-500/25 bg-brand-500/10 p-3 text-sm text-brand-200"
        >
          {error}
        </div>
      )}
      {version.data && (
        <div
          className={`mt-4 rounded-xl border p-3 text-sm ${version.data.status === "ready" ? "border-emerald-500/25 bg-emerald-500/10" : version.data.status === "failed" ? "border-red-500/25 bg-red-500/10" : "border-sky-500/25 bg-sky-500/10"}`}
          role="status"
        >
          <div className="flex items-center justify-between">
            <span>{version.data.stage}</span>
            <span className="font-mono">
              {Math.round(version.data.progress)}%
            </span>
          </div>
          {version.data.status === "ready" &&
            saveMode === "replacement" &&
            !version.data.activeReplacement && (
              <button
                onClick={() => activate.mutate({ versionId: version.data.id })}
                className="mt-3 min-h-11 w-full rounded-xl bg-emerald-600 font-bold"
              >
                Make this the active package clip
              </button>
            )}
          {version.data.status === "ready" && (
            <Link
              to={`/m/package/${data.projectId}`}
              className="mt-2 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-500/30 font-semibold"
            >
              <CheckCircle2 className="h-4 w-4" />
              Return to package
            </Link>
          )}
        </div>
      )}
      {!versionId && data.status === "draft" && (
        <div className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#0b0c0f]/97 px-4 pt-3 backdrop-blur">
          <div className="mx-auto max-w-lg">
            <div className="mb-2 grid grid-cols-2 rounded-xl bg-black p-1">
              <button
                onClick={() => setSaveMode("new_version")}
                className={`min-h-10 rounded-lg text-xs font-semibold ${saveMode === "new_version" ? "bg-zinc-800 text-white" : "text-zinc-500"}`}
              >
                Save new copy
              </button>
              <button
                onClick={() => setSaveMode("replacement")}
                className={`min-h-10 rounded-lg text-xs font-semibold ${saveMode === "replacement" ? "bg-zinc-800 text-white" : "text-zinc-500"}`}
              >
                Replace package clip
              </button>
            </div>
            <div className="grid grid-cols-[0.8fr_1.2fr] gap-2">
              <button
                onClick={() => void persist()}
                disabled={!valid || busy}
                className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-zinc-700 text-sm font-bold disabled:opacity-40"
              >
                <Save className="h-4 w-4" />
                Save draft
              </button>
              <button
                onClick={() => void render()}
                disabled={!valid || busy}
                className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-bold disabled:opacity-40"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Render revised MP4
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
