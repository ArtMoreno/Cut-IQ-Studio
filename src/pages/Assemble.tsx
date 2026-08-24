import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  clipPreviewSource,
  clipThumbnailSource,
  fmtClock,
  fmtSeconds,
  itemPreviewSource,
  manifestClipDuration,
  sortTimelineItems,
  timelineItemFromManifestClip,
  timelineDuration,
  tracksIn,
  type AssembleDoc,
  type ManifestClip,
  type TimelineItem,
} from "@/lib/assemble";
import { skipToken } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Download,
  Film,
  GripVertical,
  ListPlus,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  Scissors,
  Scissors as SplitIcon,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { InlineError } from "@/components/InlineState";
import { useSearchParams } from "react-router";

const TRACK_LABEL: Record<string, string> = {
  V2: "V2 · replay / graphics",
  V1: "V1 · footage",
  A1: "A1 · narration",
  A2: "A2 · source audio",
  A3: "A3 · music",
};

export default function Assemble() {
  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <AppNav active="assemble" />
      <AssembleWorkspace />
    </div>
  );
}

function AssembleWorkspace() {
  const [params, setParams] = useSearchParams();
  const [projectId, setProjectId] = useState<number | null>(() => {
    const value = params.get("project");
    return value && Number.isFinite(Number(value)) ? Number(value) : null;
  });

  const openProject = (id: number) => {
    setProjectId(id);
    setParams({ project: String(id) });
  };

  const closeProject = () => {
    setProjectId(null);
    setParams({});
  };

  if (projectId == null) {
    return <ProjectList onOpen={openProject} />;
  }
  return <Editor projectId={projectId} onExit={closeProject} />;
}

// ── Project list / create ───────────────────────────────────────────────────

function ProjectList({ onOpen }: { onOpen: (id: number) => void }) {
  const utils = trpc.useUtils();
  const list = trpc.assemble.listProjects.useQuery();
  const scriptProjects = trpc.script.listProjects.useQuery();
  const create = trpc.assemble.create.useMutation({
    onSuccess: (res) => {
      utils.assemble.listProjects.invalidate();
      onOpen(res.id);
    },
  });

  const [name, setName] = useState("");
  const [preset, setPreset] = useState<"csc-vertical" | "youtube-16x9" | "square">("csc-vertical");
  const [sourceKind, setSourceKind] = useState<"none" | "project" | "csc">("none");
  const [sourceProjectFk, setSourceProjectFk] = useState<number | undefined>(undefined);
  const [sourceCscSlug, setSourceCscSlug] = useState<string | undefined>(undefined);
  const cscJobs = trpc.assemble.listCscJobs.useQuery();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({
      name: name.trim(),
      preset,
      sourceProjectFk: sourceKind === "project" ? sourceProjectFk : undefined,
      sourceCscSlug: sourceKind === "csc" ? sourceCscSlug : undefined,
    });
  };

  const recentProjects = list.isLoading ? (
    <div className="p-4 text-sm text-zinc-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading projects…</div>
  ) : list.isError ? (
    <InlineError title="Assemble projects could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />
  ) : (list.data ?? []).length === 0 ? (
    <div className="p-4 text-sm text-zinc-500">No Assemble projects yet.</div>
  ) : (
    <div className="divide-y divide-zinc-800">
      {(list.data ?? []).map((p) => (
        <button key={p.id} onClick={() => onOpen(p.id)} className="block w-full px-4 py-3 text-left hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500"><span>{p.preset}</span><span>·</span><span>{p.status}</span></div>
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600/10 ring-1 ring-emerald-500/30">
          <Clapperboard className="h-8 w-8 text-emerald-400" />
        </div>
        <h1 className="text-2xl font-semibold">Assemble</h1>
        <p className="max-w-md text-sm text-zinc-400">
          Review verified clips, collect them in any order, and export one clip or a complete H.264 cut. Script matching is optional.
        </p>

        <form onSubmit={submit} className="mt-2 w-full max-w-md space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Project name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Malachi Toney — YAC — 2025"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Output preset</label>
            <div className="flex gap-2">
              {(["csc-vertical", "youtube-16x9", "square"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPreset(p)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${preset === p ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                >
                  {p === "csc-vertical" ? "9:16" : p === "youtube-16x9" ? "16:9" : "1:1"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Clip source (optional)</label>
            <div className="flex gap-2">
              {([
                ["none", "None"],
                ["project", "Script job"],
                ["csc", "CSC folder"],
              ] as const).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setSourceKind(kind)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${sourceKind === kind ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {sourceKind === "project" && (
              <select
                value={sourceProjectFk ?? ""}
                onChange={(e) => setSourceProjectFk(e.target.value ? Number(e.target.value) : undefined)}
                className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              >
                <option value="">— choose script job —</option>
                {(scriptProjects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            {sourceKind === "csc" && (
              <select
                value={sourceCscSlug ?? ""}
                onChange={(e) => setSourceCscSlug(e.target.value || undefined)}
                className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              >
                <option value="">— choose CSC job folder —</option>
                {(cscJobs.data ?? []).map((slug) => (
                  <option key={slug} value={slug}>{slug}</option>
                ))}
              </select>
            )}
          </div>
          <button
            type="submit"
            disabled={create.isPending || !name.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create project
          </button>
          {create.isError && <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">{create.error.message}</p>}
        </form>

        <section className="mt-4 w-full max-w-md overflow-hidden rounded-xl border border-zinc-800 text-left lg:hidden" aria-label="Recent Assemble projects">
          <div className="border-b border-zinc-800 px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Recent projects</div>
          {recentProjects}
        </section>
      </div>

      <div className="hidden w-[380px] shrink-0 overflow-y-auto border-l border-zinc-800 lg:block">
        <div className="border-b border-zinc-800 px-4 py-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Recent projects</div>
        {recentProjects}
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

function Editor({ projectId, onExit }: { projectId: number; onExit: () => void }) {
  const open = trpc.assemble.open.useQuery({ id: projectId });

  if (open.isLoading) return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading project…</div>;
  if (open.isError || !open.data) return <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"><InlineError title="This Assemble project could not be opened" message={open.error?.message ?? "The project was not found or could not be read."} onRetry={() => void open.refetch()} /><button type="button" onClick={onExit} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"><ArrowLeft className="h-4 w-4" />Back to Assemble projects</button></div>;

  return (
    <EditorLoaded
      key={projectId}
      projectId={projectId}
      initialDoc={open.data.doc}
      sourceProjectFk={open.data.sourceProjectFk ?? null}
      sourceCscSlug={open.data.sourceCscSlug ?? null}
      onExit={onExit}
    />
  );
}

function EditorLoaded({
  projectId,
  initialDoc,
  sourceProjectFk,
  sourceCscSlug,
  onExit,
}: {
  projectId: number;
  initialDoc: AssembleDoc;
  sourceProjectFk: number | null;
  sourceCscSlug: string | null;
  onExit: () => void;
}) {
  const save = trpc.assemble.save.useMutation();
  const analyze = trpc.assemble.analyzeScript.useMutation();
  const assemble = trpc.assemble.autoAssemble.useMutation();
  const render = trpc.assemble.render.useMutation();
  const alignVo = trpc.assemble.alignVoiceover.useMutation();
  const reveal = trpc.assemble.revealInExplorer.useMutation();

  const [doc, setDoc] = useState<AssembleDoc>(initialDoc);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"source" | "sequence">("source");
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [clipSearch, setClipSearch] = useState("");
  const [clipFilter, setClipFilter] = useState<"all" | "unused" | "timeline">("all");
  const [activeBeatId, setActiveBeatId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sourcePlaying, setSourcePlaying] = useState(false);
  const [zoom, setZoom] = useState(40); // px per second
  const [scriptDraft, setScriptDraft] = useState(doc.scriptText ?? "");
  const [voPath, setVoPath] = useState(doc.narration?.sourcePath ?? "");
  const [voStatus, setVoStatus] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<{ ok: boolean; outputPath: string; error: string | null; width: number | null; height: number | null; durationSec: number | null; skippedPlaceholders: number } | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportDir, setExportDir] = useState("");
  const [exportName, setExportName] = useState("");
  const [panelsOpen, setPanelsOpen] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Undo/redo history (bounded, in-memory; persisted doc is the source of truth).
  const [undoStack, setUndoStack] = useState<AssembleDoc[]>([]);
  const [redoStack, setRedoStack] = useState<AssembleDoc[]>([]);

  const manifestQuery = trpc.assemble.manifest.useQuery(
    sourceProjectFk != null ? { sourceProjectId: sourceProjectFk, renderedOnly: true } : skipToken,
  );
  const cscManifestQuery = trpc.assemble.cscManifest.useQuery(
    sourceCscSlug != null ? { slug: sourceCscSlug } : skipToken,
  );
  const exportLocationsQuery = trpc.assemble.listExportLocations.useQuery(
    sourceCscSlug != null ? { slug: sourceCscSlug } : {},
  );
  const manifest = (sourceCscSlug != null ? cscManifestQuery.data : manifestQuery.data) ?? null;

  const persist = useCallback(
    (next: AssembleDoc) => {
      setUndoStack((stack) => {
        const s = [...stack, doc];
        if (s.length > 50) s.shift();
        return s;
      });
      setRedoStack([]);
      setDoc(next);
      save.mutate({ id: projectId, doc: next });
    },
    [projectId, save, doc],
  );

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const prev = stack[stack.length - 1];
      setRedoStack((r) => [...r, doc]);
      setDoc(prev);
      save.mutate({ id: projectId, doc: prev });
      return stack.slice(0, -1);
    });
  }, [projectId, save, doc]);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      if (stack.length === 0) return stack;
      const next = stack[stack.length - 1];
      setUndoStack((u) => [...u, doc]);
      setDoc(next);
      save.mutate({ id: projectId, doc: next });
      return stack.slice(0, -1);
    });
  }, [projectId, save, doc]);

  const clips = useMemo(() => manifest?.clips ?? [], [manifest]);
  const clipById = useMemo(() => new Map(clips.map((c) => [c.clipId, c])), [clips]);
  const items = sortTimelineItems(doc.items);
  const duration = timelineDuration(items);
  const timelineClipIds = useMemo(
    () => new Set(items.flatMap((item) => (item.clipId ? [item.clipId] : []))),
    [items],
  );
  const previewClip = clips.find((clip) => clip.clipId === previewClipId) ?? clips[0] ?? null;
  const filteredClips = useMemo(() => {
    const query = clipSearch.trim().toLowerCase();
    return clips.filter((clip) => {
      const inTimeline = timelineClipIds.has(clip.clipId);
      if (clipFilter === "unused" && inTimeline) return false;
      if (clipFilter === "timeline" && !inTimeline) return false;
      if (!query) return true;
      return [
        clip.game,
        clip.opponent,
        clip.beatText,
        clip.transcript.text,
        ...clip.tags,
        ...clip.queryContext,
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [clips, clipFilter, clipSearch, timelineClipIds]);
  const selectedUnusedClipIds = selectedClipIds.filter((id) => !timelineClipIds.has(id));
  const visibleUnusedClipIds = filteredClips
    .filter((clip) => !timelineClipIds.has(clip.clipId))
    .map((clip) => clip.clipId);
  const allVisibleSelected = visibleUnusedClipIds.length > 0
    && visibleUnusedClipIds.every((id) => selectedClipIds.includes(id));

  const selected = items.find((i) => i.id === selectedItemId) ?? null;

  // Timeline-driven preview: the player shows whichever V1 item covers the
  // playhead (falling back to the selected item), so playback runs ACROSS
  // clips like a real edit instead of restarting each clip from zero.
  const activeItem = useMemo(
    () => items.find((i) => i.track === "V1" && playhead >= i.timelineStart - 0.001 && playhead < i.timelineEnd) ?? null,
    [items, playhead],
  );
  const shownItem = activeItem ?? (selected?.track === "V1" ? selected : null) ?? selected;
  const sequencePreviewSource = shownItem ? itemPreviewSource(shownItem, clips) : null;
  const sourcePreviewSource = previewClip ? clipPreviewSource(previewClip) : null;
  const previewSource = previewMode === "source" ? sourcePreviewSource : sequencePreviewSource;
  const [buffering, setBuffering] = useState(false);
  const loadedSrcRef = useRef<string | null>(null);
  const playheadRef = useRef(playhead);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const seek = useCallback((sec: number) => {
    setPlayhead(Math.max(0, Math.min(sec, duration || sec)));
  }, [duration]);

  // Keep the <video> element synchronized to the timeline position: load the
  // covering clip's media and offset its currentTime to the item's source window.
  useEffect(() => {
    const v = videoRef.current;
    if (previewMode !== "sequence" || !v || !shownItem || !sequencePreviewSource) return;
    if (loadedSrcRef.current !== sequencePreviewSource) {
      loadedSrcRef.current = sequencePreviewSource;
      v.src = sequencePreviewSource;
    }
    const shownClip = shownItem.clipId ? clipById.get(shownItem.clipId) : null;
    const renderedFileOffset = shownClip?.downloadUrl && shownItem.sourceIn != null && shownClip.sourceStartSeconds != null
      && shownItem.sourceIn >= shownClip.sourceStartSeconds - 0.05
      ? shownClip.sourceStartSeconds
      : 0;
    const desired = Math.max(0, (shownItem.sourceIn ?? 0) - renderedFileOffset + Math.max(0, playhead - shownItem.timelineStart));
    if (Math.abs(v.currentTime - desired) > 0.35) {
      try {
        v.currentTime = desired;
      } catch {
        // media not ready yet; the sync effect re-runs on next state change
      }
    }
  }, [clipById, playhead, previewMode, sequencePreviewSource, shownItem]);

  // Source clips are standalone previews. Start rendered clips at zero and
  // remote source media at the manifest's source in-point.
  useEffect(() => {
    const v = videoRef.current;
    if (previewMode !== "source" || !v || !previewClip || !sourcePreviewSource) return;
    setPlaying(false);
    setSourcePlaying(false);
    if (loadedSrcRef.current !== sourcePreviewSource) {
      loadedSrcRef.current = sourcePreviewSource;
      v.src = sourcePreviewSource;
    }
    const desired = previewClip.downloadUrl ? 0 : (previewClip.sourceStartSeconds ?? 0);
    const seekToStart = () => {
      if (Math.abs(v.currentTime - desired) > 0.1) v.currentTime = desired;
    };
    if (v.readyState >= 1) seekToStart();
    else v.addEventListener("loadedmetadata", seekToStart, { once: true });
    return () => v.removeEventListener("loadedmetadata", seekToStart);
  }, [previewClip, previewMode, sourcePreviewSource]);

  // Master clock: while playing, advance the playhead on rAF; the video is a
  // slave display (corrected above when it drifts).
  useEffect(() => {
    if (!playing || previewMode !== "sequence") return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const np = playheadRef.current + dt;
      if (np >= duration && duration > 0) {
        setPlayhead(duration);
        setPlaying(false);
        return;
      }
      setPlayhead(np);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, previewMode]);

  const togglePlay = useCallback(() => {
    if (previewMode !== "sequence") return;
    if (!shownItem && !activeItem) return;
    // Restart from the top when pressing play at the end.
    if (!playing && duration > 0 && playheadRef.current >= duration - 0.05) setPlayhead(0);
    setPlaying((p) => !p);
  }, [playing, shownItem, activeItem, duration, previewMode]);

  const togglePrimaryPlayback = useCallback(() => {
    if (previewMode === "sequence") {
      togglePlay();
      return;
    }
    const v = videoRef.current;
    if (!v || !sourcePreviewSource) return;
    if (v.paused) void v.play().catch(() => setBuffering(true));
    else v.pause();
  }, [previewMode, sourcePreviewSource, togglePlay]);

  // Drive the actual media element from the playing state (playhead is master).
  useEffect(() => {
    const v = videoRef.current;
    if (previewMode !== "sequence" || !v || !sequencePreviewSource) return;
    if (playing) {
      void v.play().catch(() => setBuffering(true));
    } else {
      v.pause();
    }
  }, [playing, previewMode, sequencePreviewSource]);

  // If the user clicks a clip while paused, make sure its media actually plays
  // from the right offset (some browsers need an explicit nudge after seek).
  useEffect(() => {
    const v = videoRef.current;
    if (previewMode === "sequence" && v && !playing && sequencePreviewSource && loadedSrcRef.current === sequencePreviewSource) {
      void v.play().then(() => v.pause()).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, sequencePreviewSource, shownItem?.id]);

  // keyboard: undo/redo + space play/pause
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === " ") {
        e.preventDefault();
        togglePrimaryPlayback();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, togglePrimaryPlayback]);

  const removeItem = (id: string) => {
    persist({ ...doc, items: doc.items.filter((i) => i.id !== id) });
    setSelectedItemId(null);
  };

  const rippleDelete = (id: string) => {
    const victim = doc.items.find((i) => i.id === id);
    if (!victim) return;
    const gap = victim.timelineEnd - victim.timelineStart;
    persist({
      ...doc,
      items: doc.items
        .filter((i) => i.id !== id)
        .map((i) =>
          i.timelineStart >= victim.timelineEnd - 0.001
            ? { ...i, timelineStart: i.timelineStart - gap, timelineEnd: i.timelineEnd - gap }
            : i,
        ),
    });
    setSelectedItemId(null);
  };

  // Timeline drag-to-move: shift the timeline window, source range unchanged.
  const moveItem = (id: string, newStart: number) => {
    const item = doc.items.find((i) => i.id === id);
    if (!item) return;
    const len = item.timelineEnd - item.timelineStart;
    persist({
      ...doc,
      items: doc.items.map((i) => (i.id === id ? { ...i, timelineStart: newStart, timelineEnd: newStart + len } : i)),
    });
  };

  // Timeline edge-drag: true trim — the corresponding source edge moves with
  // the timeline edge (clamped to the media), so what you see is what stays.
  const trimItem = (id: string, newStart: number, newEnd: number) => {
    const item = doc.items.find((i) => i.id === id);
    if (!item) return;
    const clip = item.clipId ? clipById.get(item.clipId) : null;
    const mediaDur = clip?.clipDurationSeconds ?? null;
    let srcIn = item.sourceIn ?? 0;
    let srcOut = item.sourceOut ?? srcIn + (item.timelineEnd - item.timelineStart);
    let tlStart = newStart;
    let tlEnd = newEnd;

    // Left edge: advance/retract the source in-point by the same delta.
    const dLeft = newStart - item.timelineStart;
    if (dLeft !== 0) {
      let s = srcIn + dLeft;
      if (s < 0) {
        tlStart = item.timelineStart - srcIn; // clamp at media start
        s = 0;
      }
      if (s > srcOut - 0.3) s = srcOut - 0.3;
      srcIn = s;
    }
    // Right edge: advance/retract the source out-point by the same delta.
    const dRight = newEnd - item.timelineEnd;
    if (dRight !== 0) {
      let s = srcOut + dRight;
      const maxOut = mediaDur != null && mediaDur > 0 ? mediaDur : Number.MAX_SAFE_INTEGER;
      if (s > maxOut) {
        tlEnd = item.timelineEnd + (maxOut - srcOut); // clamp at media end
        s = maxOut;
      }
      if (s < srcIn + 0.3) s = srcIn + 0.3;
      srcOut = s;
    }
    persist({
      ...doc,
      items: doc.items.map((i) =>
        i.id === id ? { ...i, timelineStart: tlStart, timelineEnd: tlEnd, sourceIn: srcIn, sourceOut: srcOut } : i,
      ),
    });
  };

  const previewManifestClip = (clip: ManifestClip) => {
    setPlaying(false);
    setSourcePlaying(false);
    videoRef.current?.pause();
    setPreviewClipId(clip.clipId);
    setPreviewMode("source");
  };

  const toggleClipSelection = (clipId: string) => {
    setSelectedClipIds((current) =>
      current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId],
    );
  };

  const addClipsToTimeline = (clipIds: string[]) => {
    const requested = new Set(clipIds);
    const ordered = clips.filter((clip) => requested.has(clip.clipId) && !timelineClipIds.has(clip.clipId));
    if (ordered.length === 0) return;
    let cursor = duration;
    const stamp = Date.now();
    const added = ordered.map((clip, index) => {
      const item = timelineItemFromManifestClip(clip, cursor, `manual-${stamp}-${index + 1}`);
      cursor = item.timelineEnd;
      return item;
    });
    persist({ ...doc, items: [...doc.items, ...added] });
    setSelectedClipIds((current) => current.filter((id) => !requested.has(id)));
    setSelectedItemId(added[0].id);
    setPreviewMode("sequence");
    seek(added[0].timelineStart);
  };

  const reviewSequence = () => {
    if (items.length === 0) return;
    setPlaying(false);
    setPreviewMode("sequence");
    const first = items.find((item) => item.track === "V1") ?? items[0];
    setSelectedItemId(first.id);
    seek(0);
  };

  // Auto-assemble: score every beat against the verified clips and lay the
  // best matches onto V1, leaving honest "NO MATCH" placeholders where nothing
  // clears the confidence bar (master prompt §11).
  const seedDraft = async () => {
    if (clips.length === 0) return;
    if (doc.beats.length === 0) {
      addClipsToTimeline(clips.map((clip) => clip.clipId));
      return;
    }

    const result = await assemble.mutateAsync({
      beats: doc.beats,
      clips,
      lockedBeatIds: doc.beats.filter((b) => b.locked).map((b) => b.id),
      preserveItems: doc.items.filter((i) => i.locked),
    });
    persist({ ...doc, items: result.items });
  };

  const selectedClip = selected?.clipId ? clipById.get(selected.clipId) ?? null : null;

  const analyzeScript = async () => {
    if (!scriptDraft.trim()) return;
    const { beats } = await analyze.mutateAsync({ scriptText: scriptDraft });
    const next = { ...doc, scriptText: scriptDraft, beats };
    // Immediately produce a rough cut from the analyzed beats (master prompt:
    // "analyze my script … place close to it … a rough draft, a seed draft").
    if (clips.length > 0) {
      const result = await assemble.mutateAsync({
        beats: next.beats,
        clips,
        lockedBeatIds: next.beats.filter((b) => b.locked).map((b) => b.id),
        preserveItems: next.items.filter((i) => i.locked),
      });
      next.items = result.items;
    }
    persist(next);
  };

  const importVoiceover = async () => {
    if (!voPath.trim()) return;
    setVoStatus("transcribing…");
    try {
      let next: AssembleDoc;
      if (doc.beats.length === 0) {
        const vo = await alignVo.mutateAsync({ audioPath: voPath.trim(), beats: [] });
        next = {
          ...doc,
          narration: { sourcePath: voPath.trim(), aligned: true, confidence: null, segments: vo.segments },
        };
        setVoStatus(`transcribed ${vo.duration.toFixed(1)}s of narration`);
      } else {
        const vo = await alignVo.mutateAsync({ audioPath: voPath.trim(), beats: doc.beats });
        next = {
          ...doc,
          beats: vo.beats,
          narration: { sourcePath: voPath.trim(), aligned: true, confidence: vo.confidence, segments: vo.segments },
        };
        setVoStatus(`aligned ${vo.segments.length} segments (${Math.round(vo.confidence * 100)}% confidence)`);
      }
      // VO is the master clock: immediately rebuild the rough cut on the real
      // narration windows instead of waiting for another button press.
      if (clips.length > 0 && next.beats.length > 0) {
        const result = await assemble.mutateAsync({
          beats: next.beats,
          clips,
          lockedBeatIds: next.beats.filter((b) => b.locked).map((b) => b.id),
          preserveItems: next.items.filter((i) => i.locked),
        });
        next = { ...next, items: result.items };
      }
      persist(next);
    } catch (e) {
      setVoStatus(e instanceof Error ? e.message : "Voiceover import failed.");
    }
  };

  const doRender = async () => {
    setRenderResult(null);
    const result = await render.mutateAsync({
      id: projectId,
      outputDir: exportDir || undefined,
      outputName: exportName.trim() || undefined,
    });
    setRenderResult(result);
    setShowExportDialog(false);
  };

  const revealFile = async (path: string) => {
    try {
      await reveal.mutateAsync({ path });
    } catch {
      // explorer spawn failed — the path is still shown in the banner
    }
  };

  // Replace a selected item's clip with a candidate, preserving the narration window.
  const replaceClip = (itemId: string, clip: ManifestClip) => {
    const item = doc.items.find((i) => i.id === itemId);
    if (!item) return;
    const len = item.timelineEnd - item.timelineStart;
    const srcIn = clip.localPath || clip.downloadUrl ? 0 : (clip.sourceStartSeconds ?? 0);
    persist({
      ...doc,
      items: doc.items.map((i) =>
        i.id === itemId
          ? {
              ...i,
              clipId: clip.clipId,
              sourcePath: clip.localPath,
              sourceIn: srcIn,
              sourceOut: srcIn + len,
              matchConfidence: clip.verification.confidence,
              matchReason: [clip.verification.matchKind, ...(clip.verification.reason ? [clip.verification.reason] : [])],
              unresolved: false,
            }
          : i,
      ),
    });
  };

  // Trim the selected item's source window (± seconds, slip-style).
  const nudgeSource = (itemId: string, delta: number) => {
    const item = doc.items.find((i) => i.id === itemId);
    if (!item || item.sourceIn == null || item.sourceOut == null) return;
    const len = item.sourceOut - item.sourceIn;
    const newIn = Math.max(0, item.sourceIn + delta);
    persist({
      ...doc,
      items: doc.items.map((i) => (i.id === itemId ? { ...i, sourceIn: newIn, sourceOut: newIn + len } : i)),
    });
  };

  // Split the selected item at the playhead into two timeline items.
  const splitItem = (itemId: string) => {
    const item = doc.items.find((i) => i.id === itemId);
    if (!item) return;
    const splitAt = playhead;
    if (splitAt <= item.timelineStart + 0.2 || splitAt >= item.timelineEnd - 0.2) return;
    const srcPerSec = item.sourceIn != null && item.sourceOut != null ? (item.sourceOut - item.sourceIn) / (item.timelineEnd - item.timelineStart) : 0;
    const splitSource = item.sourceIn != null ? item.sourceIn + (splitAt - item.timelineStart) * srcPerSec : null;
    const a: TimelineItem = { ...item, id: `${item.id}a`, timelineEnd: splitAt, sourceOut: splitSource ?? item.sourceOut };
    const b: TimelineItem = { ...item, id: `${item.id}b`, timelineStart: splitAt, sourceIn: splitSource ?? item.sourceIn };
    persist({ ...doc, items: [...doc.items.filter((i) => i.id !== itemId), a, b] });
  };

  const selectBeat = (beatId: string) => {
    setActiveBeatId(beatId);
    const beat = doc.beats.find((b) => b.id === beatId);
    if (beat?.narrationStart != null) seek(beat.narrationStart);
    const item = doc.items.find((i) => i.beatId === beatId);
    if (item) setSelectedItemId(item.id);
  };

  const selectItem = (itemId: string) => {
    setPlaying(false);
    setPreviewMode("sequence");
    setSelectedItemId(itemId);
    const item = doc.items.find((i) => i.id === itemId);
    if (item?.beatId) setActiveBeatId(item.beatId);
    if (item) seek(item.timelineStart);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
        <button onClick={onExit} className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800" title="Back to projects" aria-label="Back to Assemble projects">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600">
            <Scissors className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold">{doc.name}</span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
            {doc.settings.width}×{doc.settings.height} · {doc.settings.fps}fps
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {manifest && (
            <span className="hidden text-xs text-zinc-500 sm:block">
              {manifest.clips.length} clips · {items.filter((item) => item.track === "V1" && !item.unresolved).length} in cut · {fmtClock(duration)}
            </span>
          )}
          <button onClick={undo} disabled={undoStack.length === 0} className="rounded-lg border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30" title="Undo (Ctrl+Z)" aria-label="Undo timeline change">
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={redo} disabled={redoStack.length === 0} className="rounded-lg border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30" title="Redo (Ctrl+Shift+Z)" aria-label="Redo timeline change">
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setPanelsOpen((v) => !v)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-medium ${panelsOpen ? "border-zinc-700 text-zinc-400 hover:bg-zinc-800" : "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"}`}
            title={panelsOpen ? "Hide script/clip panels (bigger player)" : "Show script/clip panels"}
          >
            {panelsOpen ? "Hide panels" : "Show panels"}
          </button>
          <button
            onClick={reviewSequence}
            disabled={items.length === 0}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            title="Preview the assembled sequence from the beginning"
          >
            <Film className="h-3.5 w-3.5" /> Review cut
          </button>
          <button
            onClick={() => addClipsToTimeline(clips.map((clip) => clip.clipId))}
            disabled={clips.length === 0 || clips.every((clip) => timelineClipIds.has(clip.clipId))}
            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            title="Append every unused verified clip to the cut"
          >
            <ListPlus className="h-3.5 w-3.5" /> Add all unused
          </button>
          <button
            onClick={() => {
              setExportName(doc.name);
              setExportDir((prev) => prev || exportLocationsQuery.data?.[0]?.path || "D:/Clips");
              setShowExportDialog(true);
            }}
            disabled={items.length === 0 || render.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            title="Render the assembled timeline to H.264/AAC"
          >
            {render.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export cut
          </button>
        </div>
      </header>

      {/* Export dialog — pick where it goes + name it */}
      {showExportDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={() => setShowExportDialog(false)}>
          <div className="w-[540px] rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 text-sm font-semibold text-zinc-100">Export video</div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">Save to</label>
            <div className="mb-2 flex flex-col gap-1">
              {(exportLocationsQuery.data ?? []).map((loc) => (
                <button
                  key={loc.path}
                  onClick={() => setExportDir(loc.path)}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs ${exportDir === loc.path ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
                >
                  <span>{loc.label}</span>
                  <span className="font-mono text-[10px] text-zinc-500">{loc.path}</span>
                </button>
              ))}
              <input
                value={exportDir}
                onChange={(e) => setExportDir(e.target.value)}
                  placeholder="…or choose a folder inside your Cut IQ Clips directory"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
              />
            </div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">File name (.mp4)</label>
            <input
              value={exportName}
              onChange={(e) => setExportName(e.target.value)}
              placeholder="my-video"
              className="mb-4 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowExportDialog(false)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                Cancel
              </button>
              <button
                onClick={doRender}
                disabled={!exportDir.trim() || !exportName.trim() || render.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {render.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Render
              </button>
            </div>
          </div>
        </div>
      )}

      {renderResult && (
        <div className={`flex items-center gap-2 border-b px-4 py-2 text-xs ${renderResult.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-brand-500/30 bg-brand-500/10 text-brand-300"}`}>
          {renderResult.ok ? (
            <>
              <span>Rendered {renderResult.width}×{renderResult.height} · {renderResult.durationSec?.toFixed(1)}s</span>
              {renderResult.skippedPlaceholders > 0 && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300">
                  {renderResult.skippedPlaceholders} unresolved beat(s) skipped
                </span>
              )}
              <button onClick={() => revealFile(renderResult.outputPath)} className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-200 hover:bg-zinc-700" title="Reveal in Windows Explorer">
                Show in Explorer
              </button>
              <span className="font-mono text-zinc-500">{renderResult.outputPath}</span>
            </>
          ) : (
            <span>Render failed: {renderResult.error}</span>
          )}
        </div>
      )}

      {/* Main: optional script assist | player | clip bin */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {panelsOpen && (
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-zinc-800 xl:block">
          <div className="border-b border-zinc-800 px-3 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Optional script assist</div>
            <p className="mt-1 text-[11px] leading-snug text-zinc-600">Paste narration only when you want Cut IQ to suggest a beat-matched order.</p>
          </div>
          <div className="border-b border-zinc-800 p-2">
            <textarea
              value={scriptDraft}
              onChange={(e) => setScriptDraft(e.target.value)}
              placeholder="Paste the finished narration here, then Analyze…"
              className="h-24 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-emerald-500"
            />
            <button
              onClick={analyzeScript}
              disabled={!scriptDraft.trim() || analyze.isPending}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              {analyze.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Analyze
            </button>
            <div className="mt-2 border-t border-zinc-800 pt-2">
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-500">Voiceover (WAV/MP3/M4A)</label>
              <input
                value={voPath}
                onChange={(e) => setVoPath(e.target.value)}
                      placeholder="Choose a local narration audio file"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] outline-none placeholder:text-zinc-600 focus:border-emerald-500"
              />
              <button
                onClick={importVoiceover}
                disabled={!voPath.trim() || alignVo.isPending}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-800 px-2 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
              >
                {alignVo.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Transcribe & align
              </button>
              {voStatus && <div className="mt-1 text-[10px] leading-snug text-zinc-500">{voStatus}</div>}
            </div>
          </div>
          <div className="divide-y divide-zinc-800/70">
            {doc.beats.length === 0 ? (
              <div className="p-3 text-xs leading-relaxed text-zinc-500">
                No script loaded. That is optional—preview clips, add them to the cut, and export normally from the Clip bin.
              </div>
            ) : (
              <>
                <div className="p-2">
                  <button
                    onClick={seedDraft}
                    disabled={assemble.isPending || clips.length === 0}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                  >
                    {assemble.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />} Arrange from script
                  </button>
                </div>
                {doc.beats.map((b) => {
                const isActive = b.id === activeBeatId;
                const hasItem = doc.items.some((i) => i.beatId === b.id && !i.unresolved);
                return (
                  <button
                    key={b.id}
                    onClick={() => selectBeat(b.id)}
                    className={`block w-full px-3 py-2 text-left text-xs ${isActive ? "bg-emerald-500/10" : "hover:bg-zinc-900"} ${b.unresolved || !hasItem ? "text-amber-400" : "text-zinc-300"}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{b.ord + 1}.</span>
                      {b.beatType !== "footage" && <span className="text-[10px] text-zinc-500">[{b.beatType}]</span>}
                      {hasItem && <span className="text-[9px] text-emerald-500">●</span>}
                    </div>
                    <div className="mt-0.5 leading-snug text-zinc-500">{b.text}</div>
                    {b.narrationStart != null && (
                      <div className="mt-1 font-mono text-[10px] text-zinc-600">{fmtSeconds(b.narrationStart)}–{fmtSeconds(b.narrationEnd ?? b.narrationStart)}</div>
                    )}
                  </button>
                );
                })}
              </>
            )}
          </div>
        </aside>
        )}

        <div className="flex min-h-[360px] min-w-0 shrink-0 flex-col overflow-hidden p-3 lg:min-h-0 lg:flex-1 lg:p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900/70 p-1">
              <button
                onClick={() => previewClip && setPreviewMode("source")}
                disabled={!previewClip}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${previewMode === "source" ? "bg-zinc-700 text-white shadow-sm" : "text-zinc-500 hover:text-zinc-200"} disabled:opacity-40`}
              >
                <Play className="h-3.5 w-3.5" /> Source clip
              </button>
              <button
                onClick={reviewSequence}
                disabled={items.length === 0}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${previewMode === "sequence" ? "bg-emerald-500/15 text-emerald-300 shadow-sm" : "text-zinc-500 hover:text-zinc-200"} disabled:opacity-40`}
              >
                <Film className="h-3.5 w-3.5" /> Full cut <span className="text-[10px] opacity-70">{items.filter((item) => item.track === "V1" && !item.unresolved).length}</span>
              </button>
            </div>
            <span className="truncate text-[11px] text-zinc-500">
              {previewMode === "source" ? "Review before adding" : `${fmtClock(duration)} assembled sequence`}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl bg-black/20">
            {previewSource ? (
              <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-black">
                <video
                  ref={videoRef}
                  src={previewSource}
                  controls={previewMode === "source"}
                  poster={previewMode === "source" && previewClip ? clipThumbnailSource(previewClip) ?? undefined : undefined}
                  className="h-full max-h-full w-full max-w-full object-contain"
                  onWaiting={() => setBuffering(true)}
                  onCanPlay={() => setBuffering(false)}
                  onPlaying={() => {
                    setBuffering(false);
                    if (previewMode === "source") setSourcePlaying(true);
                  }}
                  onPause={() => {
                    if (previewMode === "source") setSourcePlaying(false);
                  }}
                  onEnded={() => {
                    setPlaying(false);
                    setSourcePlaying(false);
                  }}
                />
                {buffering && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-56 w-full max-w-lg flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 px-8 text-center">
                <Clapperboard className="h-8 w-8 text-zinc-700" />
                <p className="text-sm font-medium text-zinc-400">Choose a clip from the Clip bin</p>
                <p className="max-w-sm text-xs leading-relaxed text-zinc-600">Click any clip to preview it, select several for a batch, or drag a clip onto the timeline.</p>
              </div>
            )}
          </div>

          {previewMode === "source" && previewClip && (
            <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-zinc-100">{previewClip.game ?? previewClip.clipId}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span>{fmtSeconds(manifestClipDuration(previewClip))}</span>
                    {previewClip.resolution.width && previewClip.resolution.height ? <span>{previewClip.resolution.width}×{previewClip.resolution.height}</span> : null}
                    {previewClip.verification.playerVerified ? <span className="inline-flex items-center gap-1 text-emerald-400"><Check className="h-3 w-3" /> verified</span> : null}
                  </div>
                </div>
                <button
                  onClick={togglePrimaryPlayback}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800"
                >
                  {sourcePlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} {sourcePlaying ? "Pause clip" : "Play clip"}
                </button>
                <button
                  onClick={() => addClipsToTimeline([previewClip.clipId])}
                  disabled={timelineClipIds.has(previewClip.clipId)}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:bg-emerald-500/10 disabled:text-emerald-400"
                >
                  {timelineClipIds.has(previewClip.clipId) ? <><Check className="h-3.5 w-3.5" /> In cut</> : <><Plus className="h-3.5 w-3.5" /> Add to cut</>}
                </button>
                {previewClip.downloadUrl ? (
                  <a
                    href={previewClip.downloadUrl}
                    download
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-emerald-500/50 hover:text-emerald-300"
                    title="Download this verified clip as MP4"
                  >
                    <Download className="h-3.5 w-3.5" /> Download MP4
                  </a>
                ) : null}
              </div>
              {previewClip.transcript.text ? (
                <p className="mt-2 line-clamp-2 border-t border-zinc-800 pt-2 text-xs leading-relaxed text-zinc-500">“{previewClip.transcript.text}”</p>
              ) : null}
            </div>
          )}

          {/* Full-cut transport — big play, scrub, skip */}
          {previewMode === "sequence" && (
          <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                disabled={!previewSource}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-30"
                title="Play / Pause (Space)"
              >
                {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </button>
              <button onClick={() => seek(Math.max(0, playhead - 5))} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800" title="Skip back 5s">
                −5s
              </button>
              <button onClick={() => seek(Math.min(duration, playhead + 5))} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800" title="Skip forward 5s">
                +5s
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(0.1, duration)}
                step={0.05}
                value={Math.min(playhead, duration)}
                onChange={(e) => seek(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
                title="Scrub timeline"
              />
              <span className="font-mono text-xs text-zinc-400">
                {fmtClock(playhead)} / {fmtClock(duration)}
              </span>
            </div>
          </div>
          )}

          {previewMode === "sequence" && selected && (
            <div className="mt-3 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-xs text-zinc-400">
                  <span className="font-medium text-zinc-200">{selectedClip?.game ?? selected.id}</span>
                  {selectedClip?.verification.matchKind && <span className="ml-2 text-zinc-500">· {selectedClip.verification.matchKind}</span>}
                  {selected.matchReason?.length ? (
                    <div className="mt-0.5 text-[10px] text-zinc-600">{selected.matchReason.join(" · ")}</div>
                  ) : null}
                  {selected.unresolved && <div className="mt-0.5 text-[10px] text-amber-400">NO MATCH — pick a clip below or leave it.</div>}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={togglePlay} className="flex items-center gap-1 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700">
                    {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} {playing ? "Pause" : "Play"}
                  </button>
                  <button onClick={() => removeItem(selected.id)} className="rounded-md border border-zinc-700 p-1.5 text-zinc-400 hover:border-red-500/50 hover:text-red-400" title="Remove from timeline">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                <span className="font-medium uppercase tracking-wide">Crop</span>
                {(["fit", "fill", "crop"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => persist({ ...doc, items: doc.items.map((i) => (i.id === selected.id ? { ...i, cropMode: m } : i)) })}
                    className={`rounded-md border px-1.5 py-0.5 font-medium ${selected.cropMode === m ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                  >
                    {m}
                  </button>
                ))}
                <span className="ml-2 font-medium uppercase tracking-wide">Trim</span>
                <button onClick={() => nudgeSource(selected.id, -0.5)} className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800" title="Slip source earlier">−0.5s</button>
                <button onClick={() => nudgeSource(selected.id, 0.5)} className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800" title="Slip source later">+0.5s</button>
                <button onClick={() => splitItem(selected.id)} className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800" title="Split at playhead">
                  <SplitIcon className="inline h-3 w-3" /> Split
                </button>
              </div>
              {selected.clipId && (
                <div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Alternates (click to replace)</div>
                  <div className="flex flex-wrap gap-1">
                    {clips
                      .filter((c) => c.clipId !== selected.clipId)
                      .slice(0, 4)
                      .map((c) => (
                        <button
                          key={c.clipId}
                          onClick={() => replaceClip(selected.id, c)}
                          className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-emerald-500/50 hover:text-emerald-200"
                          title={c.transcript.text ?? c.game ?? c.clipId}
                        >
                          {c.game ?? c.clipId}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {panelsOpen && (
        <aside className="flex h-[460px] w-full shrink-0 flex-col overflow-hidden border-t border-zinc-800 bg-zinc-950 lg:h-auto lg:max-h-none lg:w-[420px] lg:max-w-[42vw] lg:border-l lg:border-t-0">
          <div className="shrink-0 border-b border-zinc-800 bg-zinc-950/95 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-300">Clip bin</div>
                <div className="mt-0.5 text-[11px] text-zinc-600">Preview, collect, or drag clips into the cut</div>
              </div>
              <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-400">{clips.length}</span>
            </div>
            <label className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 focus-within:border-emerald-500/60">
              <Search className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
              <input
                value={clipSearch}
                onChange={(event) => setClipSearch(event.target.value)}
                placeholder="Search title, transcript, team…"
                className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
              />
            </label>
            <div className="mt-2 flex items-center gap-1">
              {(["all", "unused", "timeline"] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => setClipFilter(filter)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium capitalize ${clipFilter === filter ? "bg-zinc-700 text-white" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"}`}
                >
                  {filter === "timeline" ? "In cut" : filter}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-zinc-600">{filteredClips.length} shown</span>
            </div>
          </div>

          {clips.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/65 px-3 py-2">
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() => {
                    if (allVisibleSelected) {
                      const visible = new Set(visibleUnusedClipIds);
                      setSelectedClipIds((current) => current.filter((id) => !visible.has(id)));
                    } else {
                      setSelectedClipIds((current) => [...new Set([...current, ...visibleUnusedClipIds])]);
                    }
                  }}
                  disabled={visibleUnusedClipIds.length === 0}
                  className="h-4 w-4 accent-emerald-500"
                />
                Select shown
              </label>
              <button
                onClick={() => addClipsToTimeline(selectedUnusedClipIds)}
                disabled={selectedUnusedClipIds.length === 0}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <ListPlus className="h-3.5 w-3.5" /> Add selected {selectedUnusedClipIds.length ? `(${selectedUnusedClipIds.length})` : ""}
              </button>
            </div>
          )}

          {clips.length === 0 ? (
            <div className="p-4 text-xs leading-relaxed text-zinc-500">No verified clips are available from the source project yet.</div>
          ) : filteredClips.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-zinc-500">
              <Search className="h-6 w-6 text-zinc-700" />
              No clips match this search and filter.
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
              {filteredClips.map((c) => {
                const inTimeline = timelineClipIds.has(c.clipId);
                const isPreviewed = previewMode === "source" && previewClip?.clipId === c.clipId;
                const isChecked = selectedClipIds.includes(c.clipId);
                const thumbnail = clipThumbnailSource(c);
                return (
                <article
                  key={c.clipId}
                  draggable={!inTimeline}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-clipsift-clip-id", c.clipId);
                  }}
                  className={`group rounded-xl border p-2 transition ${isPreviewed ? "border-emerald-500/60 bg-emerald-500/[0.07]" : "border-zinc-800 bg-zinc-900/55 hover:border-zinc-700 hover:bg-zinc-900"}`}
                >
                  <div className="flex gap-2.5">
                    <button
                      onClick={() => previewManifestClip(c)}
                      className="relative h-[68px] w-[112px] shrink-0 overflow-hidden rounded-lg bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      title="Preview clip"
                      aria-label={`Preview ${c.game ?? c.clipId}`}
                    >
                      {thumbnail ? <img src={thumbnail} alt="" loading="lazy" className="h-full w-full object-cover opacity-80 transition group-hover:opacity-100" /> : <Film className="absolute inset-0 m-auto h-6 w-6 text-zinc-700" />}
                      <span className="absolute inset-0 flex items-center justify-center bg-black/15">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white shadow-lg"><Play className="ml-0.5 h-3.5 w-3.5 fill-current" /></span>
                      </span>
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 font-mono text-[9px] text-white">{fmtClock(manifestClipDuration(c))}</span>
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <button onClick={() => previewManifestClip(c)} className="line-clamp-2 min-w-0 flex-1 text-left text-xs font-semibold leading-snug text-zinc-100 hover:text-emerald-300">
                          {c.game ?? c.clipId}
                        </button>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={inTimeline}
                          onChange={() => toggleClipSelection(c.clipId)}
                          aria-label={`Select ${c.game ?? c.clipId} for batch add`}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
                        {c.verification.playerVerified ? <span className="inline-flex items-center gap-0.5 text-emerald-400"><Check className="h-3 w-3" /> Verified</span> : <span>Candidate</span>}
                        {c.resolution.width && c.resolution.height ? <span>{c.resolution.width}×{c.resolution.height}</span> : null}
                        {c.beatOrd >= 0 ? <span>Beat {c.beatOrd + 1}</span> : null}
                      </div>
                      {c.transcript.text ? <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-zinc-600">“{c.transcript.text}”</p> : null}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 border-t border-zinc-800/80 pt-2">
                    <button onClick={() => previewManifestClip(c)} className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800">
                      Preview
                    </button>
                    <button
                      onClick={() => inTimeline ? selectItem(items.find((item) => item.clipId === c.clipId)!.id) : addClipsToTimeline([c.clipId])}
                      className={`rounded-md px-2 py-1 text-[10px] font-semibold ${inTimeline ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-600 text-white hover:bg-emerald-500"}`}
                    >
                      {inTimeline ? "View in cut" : "+ Add to cut"}
                    </button>
                    {c.downloadUrl ? (
                      <a href={c.downloadUrl} download className="rounded-md border border-zinc-700 p-1 text-zinc-400 hover:border-emerald-500/50 hover:text-emerald-300" title="Download this MP4" aria-label={`Download ${c.game ?? c.clipId} as MP4`}>
                        <Download className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                    <span className="ml-auto flex items-center gap-1 text-[9px] text-zinc-700" title={inTimeline ? "Already in cut" : "Drag to the timeline"}>
                      {inTimeline ? <><Check className="h-3 w-3" /> In cut</> : <><GripVertical className="h-3.5 w-3.5" /> Drag</>}
                    </span>
                  </div>
                </article>
                );
              })}
            </div>
          )}
        </aside>
        )}
      </div>

      {/* Timeline */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950">
        <Timeline
          items={items}
          clips={clips}
          duration={duration}
          zoom={zoom}
          playhead={playhead}
          selectedId={selectedItemId}
          onSelect={selectItem}
          onSeek={seek}
          onZoom={setZoom}
          onMoveItem={moveItem}
          onTrimEdges={trimItem}
          onSplit={splitItem}
          onDelete={removeItem}
          onRippleDelete={rippleDelete}
          onDropClip={(clipId) => addClipsToTimeline([clipId])}
        />
      </div>
    </div>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

type DragMode = "move" | "trim-left" | "trim-right";

interface DragState {
  id: string;
  mode: DragMode;
  startX: number;
  orig: TimelineItem;
  cur: TimelineItem;
}

function Timeline({
  items,
  clips,
  duration,
  zoom,
  playhead,
  selectedId,
  onSelect,
  onSeek,
  onZoom,
  onMoveItem,
  onTrimEdges,
  onSplit,
  onDelete,
  onRippleDelete,
  onDropClip,
}: {
  items: TimelineItem[];
  clips: ManifestClip[];
  duration: number;
  zoom: number;
  playhead: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSeek: (sec: number) => void;
  onZoom: (z: number) => void;
  onMoveItem: (id: string, newStart: number) => void;
  onTrimEdges: (id: string, newStart: number, newEnd: number) => void;
  onSplit: (id: string) => void;
  onDelete: (id: string) => void;
  onRippleDelete: (id: string) => void;
  onDropClip: (clipId: string) => void;
}) {
  const trackList = tracksIn(items);
  const width = Math.max(600, (duration + 4) * zoom);
  const laneH = 48;

  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [binDragOver, setBinDragOver] = useState(false);
  const scrubbingRef = useRef(false);

  // Close the context menu on any click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const seekFromClientX = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    onSeek(Math.max(0, (clientX - rect.left) / zoom));
  };

  const startRulerScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    seekFromClientX(e.clientX, el);
    scrubbingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (scrubbingRef.current) seekFromClientX(ev.clientX, el);
    };
    const onUp = () => {
      scrubbingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startItemDrag = (e: React.MouseEvent, item: TimelineItem, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(item.id);
    const startX = e.clientX;
    const orig = { ...item };
    const len = orig.timelineEnd - orig.timelineStart;

    const geometryAt = (clientX: number): TimelineItem => {
      const dt = (clientX - startX) / zoom;
      if (mode === "move") {
        const s = Math.max(0, orig.timelineStart + dt);
        return { ...orig, timelineStart: s, timelineEnd: s + len };
      }
      if (mode === "trim-left") {
        const s = Math.min(orig.timelineEnd - 0.3, Math.max(0, orig.timelineStart + dt));
        return { ...orig, timelineStart: s };
      }
      const end = Math.max(orig.timelineStart + 0.3, orig.timelineEnd + dt);
      return { ...orig, timelineEnd: end };
    };

    const onMove = (ev: MouseEvent) => {
      setDrag({ id: item.id, mode, startX, orig, cur: geometryAt(ev.clientX) });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setDrag(null);
      const dt = (ev.clientX - startX) / zoom;
      if (Math.abs(dt) * zoom < 3) return; // sub-pixel drag = plain click
      if (mode === "move") onMoveItem(item.id, Math.max(0, orig.timelineStart + dt));
      else if (mode === "trim-left")
        onTrimEdges(item.id, Math.min(orig.timelineEnd - 0.3, Math.max(0, orig.timelineStart + dt)), orig.timelineEnd);
      else onTrimEdges(item.id, orig.timelineStart, Math.max(orig.timelineStart + 0.3, orig.timelineEnd + dt));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const openMenu = (e: React.MouseEvent, item: TimelineItem) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(item.id);
    setMenu({ x: e.clientX, y: e.clientY, id: item.id });
  };

  return (
    <div
      className={`flex flex-col transition ${binDragOver ? "bg-emerald-500/[0.06] ring-1 ring-inset ring-emerald-500/50" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("application/x-clipsift-clip-id")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setBinDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBinDragOver(false);
      }}
      onDrop={(event) => {
        const clipId = event.dataTransfer.getData("application/x-clipsift-clip-id");
        if (!clipId) return;
        event.preventDefault();
        setBinDragOver(false);
        onDropClip(clipId);
      }}
    >
      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-1.5">
        <span className="font-mono text-xs text-zinc-400">{fmtClock(playhead)}</span>
        <span className="text-[10px] text-zinc-600">drop from Clip bin · drag clips to reorder · drag edges to trim · right-click to cut</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => onZoom(Math.max(10, zoom - 10))} className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800">−</button>
          <span className="text-[11px] text-zinc-500">{zoom}px/s</span>
          <button onClick={() => onZoom(Math.min(160, zoom + 10))} className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800">+</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="relative" style={{ width: `${width}px` }}>
          {/* ruler — click or drag to scrub */}
          <div className="relative h-6 cursor-pointer border-b border-zinc-800 bg-zinc-900/40" onMouseDown={startRulerScrub}>
            {Array.from({ length: Math.ceil(width / (zoom * 5)) + 1 }).map((_, i) => (
              <span key={i} className="absolute top-0 font-mono text-[9px] text-zinc-600" style={{ left: i * zoom * 5 }}>
                {fmtClock(i * 5)}
              </span>
            ))}
          </div>
          {/* tracks */}
          {trackList.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-xs text-zinc-600">
              Timeline is empty. Add selected clips—or drag any clip from the Clip bin here.
            </div>
          ) : (
            trackList.map((track) => (
              <div key={track} className="flex border-b border-zinc-800/60" style={{ height: laneH }}>
                <div className="w-24 shrink-0 border-r border-zinc-800 px-2 text-[10px] leading-[48px] text-zinc-500">
                  {TRACK_LABEL[track] ?? track}
                </div>
                <div className="relative flex-1 bg-zinc-900/30">
                  {items
                    .filter((i) => i.track === track)
                    .map((i) => {
                      const shown = drag && drag.id === i.id ? drag.cur : i;
                      const left = shown.timelineStart * zoom;
                      const w = Math.max(6, (shown.timelineEnd - shown.timelineStart) * zoom);
                      const isSel = i.id === selectedId;
                      const label = i.unresolved
                        ? "NO MATCH"
                        : (clips.find((clip) => clip.clipId === i.clipId)?.game ?? i.clipId ?? i.id);
                      return (
                        <div
                          key={i.id}
                          onMouseDown={(e) => startItemDrag(e, i, "move")}
                          onContextMenu={(e) => openMenu(e, i)}
                          className={`absolute top-1 bottom-1 cursor-grab overflow-hidden rounded border text-left text-[10px] leading-4 active:cursor-grabbing ${
                            i.unresolved
                              ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                              : isSel
                                ? "border-emerald-400 bg-emerald-500/20 text-emerald-100"
                                : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                          }`}
                          style={{ left, width: w }}
                          title={label}
                        >
                          <span className="pointer-events-none block truncate px-2 pt-0.5">{label}</span>
                          {!i.unresolved && (
                            <>
                              <div
                                onMouseDown={(e) => startItemDrag(e, i, "trim-left")}
                                className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-emerald-400/0 hover:bg-emerald-400/40"
                                title="Drag to trim in-point"
                              />
                              <div
                                onMouseDown={(e) => startItemDrag(e, i, "trim-right")}
                                className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-emerald-400/0 hover:bg-emerald-400/40"
                                title="Drag to trim out-point"
                              />
                            </>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))
          )}
          {/* playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-brand-500" style={{ left: playhead * zoom }} />
        </div>
      </div>

      {/* context menu */}
      {menu && (
        <div
          className="fixed z-50 min-w-44 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onSplit(menu.id);
              setMenu(null);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
          >
            ✂ Cut at playhead
          </button>
          <button
            onClick={() => {
              onDelete(menu.id);
              setMenu(null);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Delete (leaves gap)
          </button>
          <button
            onClick={() => {
              onRippleDelete(menu.id);
              setMenu(null);
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-brand-300 hover:bg-zinc-800"
          >
            Ripple delete (close gap)
          </button>
        </div>
      )}
    </div>
  );
}
