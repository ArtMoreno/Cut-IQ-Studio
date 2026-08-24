import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  Captions,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Film,
  Folder,
  FolderOpen,
  GripVertical,
  Link2,
  ListChecks,
  Loader2,
  Pause,
  Play,
  PlusCircle,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Square,
  Trash2,
  Undo2,
  UploadCloud,
  X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { Player, type PlayerHandle } from "@/components/Player";
import { ImportDialog } from "@/components/ImportDialog";
import {
  TranscriptStudioReader,
  type StudioTranscriptEdit,
  type StudioTranscriptSegment,
} from "@/components/studio/TranscriptStudioReader";
import { StudioMediaPlayer } from "@/components/studio/StudioMediaPlayer";
import { PrecisionRangeTimeline } from "@/components/studio/PrecisionRangeTimeline";
import { fmtTime } from "@/lib/youtube";
import { normalizeYouTubeUrl, resolveEditorPlayhead, validateClipRange } from "@/lib/transcriptStudio";
import { markStudioIn, markStudioOut } from "@/lib/studioTransport";
import {
  createStudioExportPlan,
  resolveStudioShortcut,
  summarizeStudioBasket,
  studioExportActions,
  validateStudioDestination,
  type StudioExportMode,
} from "@/lib/studioEditingBay";
import { trpc } from "@/providers/trpc";
import { AppNav } from "@/components/AppNav";

type StudioStage = "idle" | "inspecting" | "captions" | "preparing" | "ready" | "error" | "cancelled";

interface StudioVideo {
  id: number;
  videoId: string;
  url: string;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  transcriptKind: "manual" | "auto" | "local-whisper" | "imported" | "none";
  transcriptLang: string | null;
  status: "ok" | "no_transcript" | "error";
  errorMessage: string | null;
  lastPosition: number;
  durationSec?: number | null;
}

interface SourceProfile {
  videoId: string;
  canonicalUrl: string;
  title: string | null;
  channel: string | null;
  thumbnail: string | null;
  durationSec: number | null;
  sourceHeight: number | null;
  availableHeights: number[];
  recommendedHeight: number | null;
  isLive: boolean;
  sourceType?: "youtube" | "local";
  mediaUrl?: string | null;
}

type DraftStatus = "draft" | "queued" | "failed";

interface StudioClipDraft {
  clientId: string;
  label: string;
  inPoint: number;
  outPoint: number;
  status: DraftStatus;
  jobId?: number;
  momentId?: number;
  outputDir?: string;
  height?: number;
  error?: string;
  createdAt: number;
  selected: boolean;
}

interface LocalStudioMedia {
  objectUrl: string;
  name: string;
  path?: string;
}

interface PackageEditContext {
  handoffId: string;
  projectId: number;
  projectName: string;
  candidateId: number;
  videoDbId: number;
  sourceUrl: string;
  sourceTitle: string | null;
  transcriptAvailable: boolean;
  originalIn: number;
  originalOut: number;
  suggestedIn: number;
  suggestedOut: number;
  transcriptExcerpt: string | null;
  beatText: string | null;
  selectionKind: string;
  intent: "new_version" | "replacement";
  status: "draft" | "exporting" | "ready" | "failed" | "retired";
  studioExportId: number | null;
  studioDraftId: string | null;
  activeReplacement: boolean;
  version: { id: string };
}

interface PackageRevisionState {
  versionId: string;
  exportId: number;
  draftId: string;
  mode: "copy" | "replacement";
}

function stageLabel(stage: StudioStage) {
  switch (stage) {
    case "inspecting": return "Inspecting video";
    case "captions": return "Finding captions";
    case "preparing": return "Preparing transcript";
    case "ready": return "Ready";
    case "cancelled": return "Cancelled";
    case "error": return "Needs attention";
    default: return "Paste a source";
  }
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  if (lower.includes("private")) return "This video is private or requires the owner's permission.";
  if (lower.includes("deleted") || lower.includes("unavailable")) return "This video is unavailable or has been deleted.";
  if (lower.includes("region") || lower.includes("country")) return "This video is restricted in this region.";
  if (lower.includes("login") || lower.includes("sign in")) return "This video requires a signed-in YouTube session.";
  if (lower.includes("live")) return "This livestream cannot be processed until a stable replay is available.";
  if (lower.includes("transcript") || lower.includes("caption")) return "Cut IQ could not obtain a usable transcript for this video.";
  if (lower.includes("network") || lower.includes("fetch")) return "Cut IQ could not reach the source. Check your connection and try again.";
  return message || "Cut IQ could not load this source. Try again or choose another video.";
}

function makeClientId() {
  return `studio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(seconds: number, maximum: number) {
  return Math.min(Math.max(0, seconds), Math.max(0, maximum));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function restoreQueue(value: unknown): StudioClipDraft[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const inPoint = item.inPoint;
    const outPoint = item.outPoint;
    const label = item.label;
    if (typeof inPoint !== "number" || typeof outPoint !== "number" || typeof label !== "string") return [];
    if (!Number.isFinite(inPoint) || !Number.isFinite(outPoint) || outPoint <= inPoint) return [];
    // Older Transcript Studio sessions stored shared clip-job and moment ids.
    // Those ids belong to the automated renderer and can collide with the new
    // isolated Studio export ids, so preserve the ranges but restore them as
    // unlinked drafts that the user can export through the new Studio worker.
    const legacySharedJob = typeof item.momentId === "number" || typeof item.height === "number";
    const status: DraftStatus = legacySharedJob
      ? "draft"
      : item.status === "queued" || item.status === "failed" ? item.status : "draft";
    return [{
      clientId: typeof item.clientId === "string" ? item.clientId : makeClientId(),
      label: label.slice(0, 255),
      inPoint,
      outPoint,
      status,
      jobId: !legacySharedJob && typeof item.jobId === "number" ? item.jobId : undefined,
      outputDir: !legacySharedJob && typeof item.outputDir === "string" ? item.outputDir : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      selected: item.selected !== false,
    }];
  });
}

function sourceLabel(video: StudioVideo | null) {
  if (!video) return "Transcript not loaded";
  if (video.transcriptKind === "imported") return "Imported transcript";
  if (video.transcriptKind === "local-whisper") return "Local Whisper transcription";
  if (video.transcriptKind === "auto") return "YouTube automatic captions";
  if (video.transcriptKind === "manual") return "YouTube captions";
  return "Transcript unavailable";
}

function stageTone(stage: StudioStage) {
  if (stage === "ready") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (stage === "error") return "border-red-500/30 bg-red-500/10 text-red-300";
  if (stage === "cancelled") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  if (stage === "idle") return "border-zinc-700 bg-zinc-900 text-zinc-400";
  return "border-sky-500/30 bg-sky-500/10 text-sky-300";
}

export default function TranscriptStudio() {
  const navigate = useNavigate();
  const [routeParams] = useSearchParams();
  const handoffId = routeParams.get("handoff");
  const playerRef = useRef<PlayerHandle>(null);
  const activeInspectionRef = useRef<string | null>(null);
  const appliedSessionRef = useRef<number | null>(null);
  const restoreAttemptedRef = useRef(false);
  const loadedHandoffRef = useRef<string | null>(null);
  const packageEditRef = useRef<PackageEditContext | null>(null);
  const activationRequestedRef = useRef<string | null>(null);
  const [url, setUrl] = useState("");
  const [video, setVideo] = useState<StudioVideo | null>(null);
  const [source, setSource] = useState<SourceProfile | null>(null);
  const [segments, setSegments] = useState<StudioTranscriptSegment[]>([]);
  const [stage, setStage] = useState<StudioStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [previewRange, setPreviewRange] = useState<{ inSec: number; outSec: number } | null>(null);
  const [loopPreview, setLoopPreview] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [clipLabel, setClipLabel] = useState("");
  const [clipQueue, setClipQueue] = useState<StudioClipDraft[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [editOverrides, setEditOverrides] = useState<Record<number, StudioTranscriptEdit>>({});
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");
  const [localMedia, setLocalMedia] = useState<LocalStudioMedia | null>(null);
  const [outputDirectory, setOutputDirectory] = useState(() => window.localStorage.getItem("clipsift-studio-output-directory") ?? "");
  const [queueHistory, setQueueHistory] = useState<StudioClipDraft[][]>([]);
  const [queueFuture, setQueueFuture] = useState<StudioClipDraft[][]>([]);
  const [packageEdit, setPackageEdit] = useState<PackageEditContext | null>(null);
  const [packageRevision, setPackageRevision] = useState<PackageRevisionState | null>(null);
  const [packageSaveError, setPackageSaveError] = useState<string | null>(null);
  const [packageSavedMessage, setPackageSavedMessage] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const inspectSource = trpc.studio.inspectSource.useMutation();
  const cancelSourceJob = trpc.studio.cancelSourceJob.useMutation();
  const loadVideo = trpc.clipsift.loadVideo.useMutation();
  const openVideo = trpc.clipsift.openVideo.useMutation();
  const importTranscript = trpc.clipsift.importTranscript.useMutation();
  const saveSession = trpc.studio.saveSession.useMutation();
  const saveSegmentEdit = trpc.studio.saveSegmentEdit.useMutation();
  const resetSegment = trpc.studio.resetSegment.useMutation();
  const queueExport = trpc.studio.queueExport.useMutation();
  const openOutput = trpc.studio.openOutput.useMutation();
  const chooseLocalVideo = trpc.studio.chooseLocalVideo.useMutation();
  const chooseOutputDirectory = trpc.studio.chooseOutputDirectory.useMutation();
  const registerLocalSource = trpc.studio.registerLocalSource.useMutation();
  const cancelRender = trpc.studio.cancelExport.useMutation();
  const retryExport = trpc.studio.retryExport.useMutation();
  const attachStudioExport = trpc.clipPackage.attachStudioExport.useMutation();
  const setStudioHandoffIntent = trpc.clipPackage.setStudioHandoffIntent.useMutation();
  const activateEditedVersion = trpc.clipPackage.activateEditedVersion.useMutation({
    onSuccess: () => setPackageSavedMessage("Replacement verified and active in the clip package."),
    onError: (activationError) => {
      activationRequestedRef.current = null;
      setPackageSaveError(activationError.message);
    },
  });

  const packageHandoffQuery = trpc.clipPackage.studioHandoff.useQuery(
    { handoffId: handoffId ?? "00000000-0000-4000-8000-000000000000" },
    { enabled: Boolean(handoffId), retry: 1 },
  );
  const editedVersionQuery = trpc.clipPackage.editedVersion.useQuery(
    { versionId: packageRevision?.versionId ?? "00000000-0000-4000-8000-000000000000" },
    {
      enabled: Boolean(packageRevision),
      refetchInterval: (query) => {
        const status = String((query.state.data as { status?: string } | undefined)?.status ?? "");
        return ["ready", "failed", "cancelled", "active"].includes(status) ? false : 750;
      },
    },
  );
  const packageStudioExportQuery = trpc.studio.exportJob.useQuery(
    { exportId: packageRevision?.exportId ?? 1 },
    { enabled: Boolean(packageRevision?.exportId), refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["ready", "failed", "cancelled"].includes(status) ? false : 750;
    } },
  );

  const sessionQuery = trpc.studio.getSession.useQuery(
    { videoDbId: video?.id ?? 1 },
    { enabled: Boolean(video) },
  );
  const editsQuery = trpc.studio.listEdits.useQuery(
    { videoDbId: video?.id ?? 1 },
    { enabled: Boolean(video) },
  );
  const { data: renderJobs = [] } = trpc.studio.listExports.useQuery(
    { videoDbId: video?.id ?? 1, limit: 100 },
    { enabled: Boolean(video), refetchInterval: 2500 },
  );
  const outputConfigQuery = trpc.studio.outputConfig.useQuery();

  const sourceDuration = source?.durationSec ?? video?.durationSec ?? playerDuration;
  const usableDuration = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : 0;
  const rangeValidation = useMemo(() => {
    if (inPoint == null || outPoint == null) return null;
    return validateClipRange(inPoint * 1000, outPoint * 1000, usableDuration * 1000);
  }, [inPoint, outPoint, usableDuration]);
  const validRange = rangeValidation?.ok === true;
  const canExportHD = source?.sourceType === "local" || (source?.recommendedHeight != null && source.recommendedHeight >= 720);
  const workspaceActive = video != null || localMedia != null;
  const basketSummary = useMemo(() => summarizeStudioBasket(
    clipQueue.map((draft) => ({
      id: draft.clientId,
      label: draft.label,
      inMs: Math.round(draft.inPoint * 1000),
      outMs: Math.round(draft.outPoint * 1000),
      selected: draft.selected,
    })),
    Math.round(usableDuration * 1000),
  ), [clipQueue, usableDuration]);
  const selectedDuration = basketSummary.totalDurationMs / 1000;
  const latestCompletedExport = renderJobs.find((item) => item.status === "ready") ?? null;

  const commitQueue = useCallback((update: (current: StudioClipDraft[]) => StudioClipDraft[]) => {
    setClipQueue((current) => {
      const next = update(current);
      if (next === current) return current;
      setQueueHistory((history) => [...history.slice(-19), current]);
      setQueueFuture([]);
      return next;
    });
  }, []);

  const undoQueue = useCallback(() => {
    setQueueHistory((history) => {
      const previous = history.at(-1);
      if (!previous) return history;
      setClipQueue((current) => {
        setQueueFuture((future) => [current, ...future].slice(0, 20));
        return previous;
      });
      return history.slice(0, -1);
    });
  }, []);

  const redoQueue = useCallback(() => {
    setQueueFuture((future) => {
      const next = future[0];
      if (!next) return future;
      setClipQueue((current) => {
        setQueueHistory((history) => [...history.slice(-19), current]);
        return next;
      });
      return future.slice(1);
    });
  }, []);

  const editMap = useMemo(() => {
    const fromServer: Record<number, StudioTranscriptEdit> = {};
    for (const edit of editsQuery.data ?? []) {
      fromServer[edit.segmentIdx] = {
        segmentIdx: edit.segmentIdx,
        originalText: edit.originalText,
        displayText: edit.displayText,
      };
    }
    return { ...fromServer, ...editOverrides };
  }, [editOverrides, editsQuery.data]);

  useEffect(() => {
    if (!video) {
      appliedSessionRef.current = null;
      setSessionHydrated(false);
      return;
    }
    if (packageEditRef.current) {
      appliedSessionRef.current = video.id;
      setSessionHydrated(true);
      return;
    }
    if (!sessionQuery.isFetched || appliedSessionRef.current === video.id) return;
    const session = sessionQuery.data?.session;
    if (session?.videoFk === video.id) {
      setSearchQuery(session.searchQuery ?? "");
      setInPoint(session.inPoint ?? null);
      setOutPoint(session.outPoint ?? null);
      setClipQueue(restoreQueue(session.clipQueue));
      if (session.sourceHeight != null || session.sourceDurationSec != null) {
        setSource((current) => current ? {
          ...current,
          sourceHeight: session.sourceHeight ?? current.sourceHeight,
          durationSec: session.sourceDurationSec ?? current.durationSec,
        } : {
          videoId: video.videoId,
          canonicalUrl: video.url,
          title: video.title,
          channel: video.channel,
          thumbnail: video.thumbnail,
          durationSec: session.sourceDurationSec ?? video.durationSec ?? null,
          sourceHeight: session.sourceHeight ?? null,
          availableHeights: session.sourceHeight ? [session.sourceHeight] : [],
          recommendedHeight: session.sourceHeight && session.sourceHeight >= 720 ? session.sourceHeight : null,
          isLive: false,
        });
      }
    }
    appliedSessionRef.current = video.id;
    setSessionHydrated(true);
  }, [sessionQuery.data?.session, sessionQuery.isFetched, video]);

  // The most recently used Studio session is restored after an app restart.
  // Cached captions, edits, marks and queued jobs remain in MariaDB; this is
  // only a small local pointer to the last library video.
  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    if (handoffId) return;
    const rawId = window.localStorage.getItem("clipsift-transcript-studio-last-video");
    const videoDbId = rawId ? Number(rawId) : Number.NaN;
    if (!Number.isInteger(videoDbId) || videoDbId <= 0) return;
    void openVideo.mutateAsync({ videoDbId }).then((opened) => {
      if (!opened.video) return;
      const restored = opened.video as StudioVideo;
      const restoredSegments = opened.segments as StudioTranscriptSegment[];
      setVideo(restored);
      setUrl(restored.url);
      setSegments(restoredSegments);
      setCurrentTime(restored.lastPosition ?? 0);
      setPlayerDuration(restored.durationSec ?? 0);
      if (restored.videoId.startsWith("local-") || restored.url.startsWith("file:")) {
        setLocalMedia({
          objectUrl: `/api/studio-media/${restored.id}`,
          path: restored.url,
          name: restored.title ?? "Local video",
        });
        setSource({
          videoId: restored.videoId,
          canonicalUrl: restored.url,
          title: restored.title,
          channel: restored.channel ?? "Local file",
          thumbnail: restored.thumbnail,
          durationSec: restored.durationSec ?? null,
          sourceHeight: null,
          availableHeights: [],
          recommendedHeight: null,
          isLive: false,
          sourceType: "local",
          mediaUrl: `/api/studio-media/${restored.id}`,
        });
      }
      setStage(restoredSegments.length > 0 && restored.status === "ok" ? "ready" : "error");
      if (!restoredSegments.length || restored.status !== "ok") setError(restored.errorMessage ?? "The last Transcript Studio session has no usable transcript.");
    }).catch(() => {
      window.localStorage.removeItem("clipsift-transcript-studio-last-video");
    });
  }, [handoffId, openVideo]);

  useEffect(() => {
    if (!video || !sessionHydrated || packageEditRef.current) return;
    const timer = window.setTimeout(() => {
      saveSession.mutate({
        videoDbId: video.id,
        searchQuery,
        inPoint,
        outPoint,
        clipQueue,
        sourceHeight: source?.sourceHeight ?? null,
        sourceDurationSec: usableDuration || null,
      }, {
        onSuccess: () => setSessionNotice("Saved"),
        onError: () => setSessionNotice("Changes remain in this tab"),
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [clipQueue, inPoint, outPoint, saveSession, searchQuery, sessionHydrated, source?.sourceHeight, usableDuration, video]);

  useEffect(() => {
    if (!sessionNotice) return;
    const timer = window.setTimeout(() => setSessionNotice(""), 1600);
    return () => window.clearTimeout(timer);
  }, [sessionNotice]);

  useEffect(() => {
    window.localStorage.setItem("clipsift-studio-output-directory", outputDirectory);
  }, [outputDirectory]);

  useEffect(() => {
    if (!window.localStorage.getItem("clipsift-studio-output-directory") && outputConfigQuery.data?.outputDir) {
      setOutputDirectory(outputConfigQuery.data.outputDir);
    }
  }, [outputConfigQuery.data?.outputDir]);

  useEffect(() => () => {
    if (localMedia?.objectUrl.startsWith("blob:")) URL.revokeObjectURL(localMedia.objectUrl);
  }, [localMedia]);

  const seek = useCallback((seconds: number, autoplay = true) => {
    const bounded = usableDuration ? clamp(seconds, usableDuration) : Math.max(0, seconds);
    setCurrentTime(bounded);
    playerRef.current?.seekTo(bounded, autoplay);
    if (autoplay) setPlaying(true);
  }, [usableDuration]);

  const togglePlay = useCallback(() => {
    if (playing) {
      playerRef.current?.pause();
      setPlaying(false);
    } else {
      playerRef.current?.play();
      setPlaying(true);
    }
  }, [playing]);

  const capturePlayhead = useCallback(() => {
    const captured = resolveEditorPlayhead(playerRef.current?.getTime(), currentTime, usableDuration || null);
    if (captured == null) {
      setRangeError("The player is not ready yet. Start playback or use the scrubber, then set the mark again.");
      return null;
    }
    setCurrentTime(captured);
    return captured;
  }, [currentTime, usableDuration]);

  const setIn = useCallback(() => {
    const captured = capturePlayhead();
    if (captured == null) return;
    const result = markStudioIn({ inPoint, outPoint }, captured);
    if (!result.ok) {
      setRangeError(result.message);
      return;
    }
    setInPoint(result.inPoint);
    setOutPoint(result.outPoint);
    setPreviewRange(null);
    setRangeError(null);
  }, [capturePlayhead, inPoint, outPoint]);

  const setOut = useCallback(() => {
    const captured = capturePlayhead();
    if (captured == null) return;
    const result = markStudioOut(
      { inPoint, outPoint },
      captured,
      (start, end) => validateClipRange(start * 1000, end * 1000, usableDuration * 1000),
    );
    if (!result.ok) {
      setRangeError(result.message);
      return;
    }
    setInPoint(result.inPoint);
    setOutPoint(result.outPoint);
    setPreviewRange(null);
    setRangeError(null);
  }, [capturePlayhead, inPoint, outPoint, usableDuration]);

  const loadSource = useCallback(async (
    refresh = false,
    requestedUrl?: string,
    packageSeed?: PackageEditContext,
  ) => {
    const normalized = normalizeYouTubeUrl(requestedUrl ?? url);
    if (!normalized.ok) {
      setError(normalized.message);
      setStage("error");
      return;
    }

    const jobId = makeClientId();
    activeInspectionRef.current = jobId;
    setError(null);
    setRangeError(null);
    setStage("inspecting");
    setSessionHydrated(false);
    setLocalMedia(null);

    try {
      const inspected = await inspectSource.mutateAsync({ url: normalized.canonicalUrl, jobId });
      if (activeInspectionRef.current !== jobId) return;
      const nextSource = inspected as SourceProfile;
      setSource(nextSource);
      setUrl(nextSource.canonicalUrl);
      if (nextSource.isLive) {
        setStage("error");
        setError("This livestream cannot be processed until a stable replay is available.");
        return;
      }

      setStage("captions");
      const loaded = await loadVideo.mutateAsync({ url: nextSource.canonicalUrl, refresh, jobId });
      if (activeInspectionRef.current !== jobId) return;
      if (!loaded.ok) {
        setStage("error");
        setError(friendlyError(loaded.message));
        return;
      }

      const nextVideo = loaded.video as StudioVideo;
      const nextSegments = loaded.segments as StudioTranscriptSegment[];
      const seededIn = packageSeed ? Math.max(0, packageSeed.suggestedIn ?? packageSeed.originalIn) : null;
      const seededOut = packageSeed ? Math.max(seededIn ?? 0, packageSeed.suggestedOut ?? packageSeed.originalOut) : null;
      const seededStart = packageSeed ? Math.max(0, seededIn! - 3) : nextVideo.lastPosition ?? 0;
      setStage("preparing");
      setVideo(packageSeed ? { ...nextVideo, lastPosition: seededStart } : nextVideo);
      setSegments(nextSegments);
      setCurrentTime(seededStart);
      setPlayerDuration(nextVideo.durationSec ?? nextSource.durationSec ?? 0);
      setInPoint(seededIn);
      setOutPoint(seededOut);
      setPreviewRange(null);
      setClipQueue([]);
      setEditOverrides({});
      setSearchQuery("");
      if (packageSeed) setClipLabel(packageSeed.sourceTitle || `Revised clip ${packageSeed.candidateId}`);
      window.localStorage.setItem("clipsift-transcript-studio-last-video", String(nextVideo.id));
      appliedSessionRef.current = null;
      if (nextSegments.length === 0 || nextVideo.status !== "ok") {
        setStage("error");
        setError(nextVideo.errorMessage ?? "No usable transcript was returned for this source.");
      } else {
        setStage("ready");
      }
      utils.clipsift.library.invalidate();
    } catch (loadError) {
      if (activeInspectionRef.current !== jobId) return;
      setStage("error");
      setError(friendlyError(loadError));
    } finally {
      if (activeInspectionRef.current === jobId) activeInspectionRef.current = null;
    }
  }, [inspectSource, loadVideo, url, utils.clipsift.library]);

  useEffect(() => {
    const serverPayload = packageHandoffQuery.data as PackageEditContext | undefined;
    if (!handoffId || !serverPayload || loadedHandoffRef.current === handoffId) return;
    let payload = serverPayload;
    try {
      const rawSeed = window.sessionStorage.getItem(`clipsift-handoff-seed:${handoffId}`);
      if (rawSeed) {
        const seed = JSON.parse(rawSeed) as { inSec?: number; outSec?: number; label?: string };
        if (typeof seed.inSec === "number" && typeof seed.outSec === "number" && seed.outSec > seed.inSec) {
          payload = { ...serverPayload, suggestedIn: seed.inSec, suggestedOut: seed.outSec, sourceTitle: seed.label || serverPayload.sourceTitle };
        }
      }
    } catch {
      // Invalid optional UI seed cannot invalidate the server-owned handoff.
    }
    loadedHandoffRef.current = handoffId;
    packageEditRef.current = payload;
    setPackageEdit(payload);
    if (payload.studioExportId && payload.studioDraftId) {
      setPackageRevision({
        versionId: payload.version.id,
        exportId: payload.studioExportId,
        draftId: payload.studioDraftId,
        mode: payload.intent === "replacement" ? "replacement" : "copy",
      });
    }
    setPackageSaveError(null);
    setPackageSavedMessage(null);
    setUrl(payload.sourceUrl);
    setSessionHydrated(true);
    void loadSource(false, payload.sourceUrl, payload);
  }, [handoffId, loadSource, packageHandoffQuery.data]);

  useEffect(() => {
    if (!packageHandoffQuery.isError) return;
    setPackageSaveError(packageHandoffQuery.error?.message ?? "This clip-edit handoff is unavailable or expired. Return to the clip package and try again.");
  }, [packageHandoffQuery.error?.message, packageHandoffQuery.isError]);

  const loadLocalVideo = useCallback(async () => {
    try {
      const chosen = await chooseLocalVideo.mutateAsync();
      if (!chosen.path) return;
      setStage("preparing");
      setError(null);
      const result = await registerLocalSource.mutateAsync({ path: chosen.path, transcribe: true });
      const mediaUrl = result.mediaUrl;
      if (!result.video || !mediaUrl) throw new Error("Cut IQ registered the local file but did not return a playable media URL.");
      setVideo(result.video as StudioVideo);
      setSource({ ...result.source, sourceType: "local", mediaUrl });
      setSegments(result.segments as StudioTranscriptSegment[]);
      setLocalMedia({ objectUrl: mediaUrl, path: chosen.path, name: result.video.title ?? chosen.path.split(/[\\/]/).pop() ?? "Local video" });
      setCurrentTime(result.video.lastPosition ?? 0);
      setPlayerDuration(result.video.durationSec ?? result.probe.durationSec ?? 0);
      setStage(result.segments?.length ? "ready" : result.transcriptError ? "error" : "preparing");
      if (result.transcriptError) setError(friendlyError(result.transcriptError.message));
      setSessionHydrated(true);
      window.localStorage.setItem("clipsift-transcript-studio-last-video", String(result.video.id));
    } catch (localError) {
      setStage("error");
      setError(friendlyError(localError));
    }
  }, [chooseLocalVideo, registerLocalSource]);

  const cancelLoading = useCallback(async () => {
    const jobId = activeInspectionRef.current;
    activeInspectionRef.current = null;
    if (jobId) {
      try {
        await cancelSourceJob.mutateAsync({ jobId });
      } catch {
        // The job may already have finished; the local stale-result guard still applies.
      }
    }
    setStage("cancelled");
    setError("Loading was cancelled. You can retry when you are ready.");
  }, [cancelSourceJob]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const editableTarget = isTypingTarget(event.target);
      if (!editableTarget && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoQueue(); else undoQueue();
        return;
      }
      const action = resolveStudioShortcut({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "focus-search") setSearchFocusRequest((request) => request + 1);
      else if (action === "toggle-play") togglePlay();
      else if (action === "set-in") setIn();
      else if (action === "set-out") setOut();
      else if (action === "step-backward") seek(currentTime - 5);
      else if (action === "pause") { playerRef.current?.pause(); setPlaying(false); }
      else if (action === "step-forward") seek(currentTime + 5);
      else if (action === "dismiss") setPreviewRange(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [currentTime, redoQueue, seek, setIn, setOut, togglePlay, undoQueue]);

  const previewSelection = () => {
    if (!validRange || inPoint == null || outPoint == null) {
      setRangeError(rangeValidation && !rangeValidation.ok ? rangeValidation.message : "Set a valid In and Out selection first.");
      return;
    }
    setPreviewRange({ inSec: inPoint, outSec: outPoint });
    seek(inPoint);
  };

  const adjustPackageRange = (edge: "in" | "out", delta: number) => {
    if (inPoint == null || outPoint == null) return;
    if (edge === "in") {
      const next = Math.max(0, Math.min(outPoint - 0.1, inPoint + delta));
      setInPoint(next);
      if (currentTime > outPoint || currentTime < next) seek(next, false);
    } else {
      const maximum = usableDuration > 0 ? usableDuration : Number.MAX_SAFE_INTEGER;
      const next = Math.min(maximum, Math.max(inPoint + 0.1, outPoint + delta));
      setOutPoint(next);
    }
    setPreviewRange(null);
    setRangeError(null);
    setPackageSavedMessage(null);
  };

  const restorePackageRange = () => {
    if (!packageEdit) return;
    setInPoint(packageEdit.originalIn);
    setOutPoint(packageEdit.originalOut);
    setPreviewRange({ inSec: packageEdit.originalIn, outSec: packageEdit.originalOut });
    seek(Math.max(0, packageEdit.originalIn - 3), false);
    setRangeError(null);
  };

  const returnToPackage = () => {
    if (!packageEdit) return;
    const dirty = inPoint !== packageEdit.originalIn || outPoint !== packageEdit.originalOut;
    if (dirty && !packageRevision && !window.confirm("Leave without saving this revised range?")) return;
    const stored = window.sessionStorage.getItem(`clipsift-package-return:${packageEdit.projectId}:${packageEdit.candidateId}`);
    navigate(stored || `/clip-package?project=${packageEdit.projectId}&clip=${packageEdit.candidateId}`);
  };

  const savePackageRange = async (mode: "copy" | "replacement") => {
    if (!packageEdit || !video || !validRange || inPoint == null || outPoint == null) {
      setPackageSaveError("Set a valid IN and OUT range before saving this revision.");
      return;
    }
    if (!canExportHD) {
      setPackageSaveError("The original source does not currently have a verified 720p-or-better export stream.");
      return;
    }
    setPackageSaveError(null);
    setPackageSavedMessage(null);
    try {
      await setStudioHandoffIntent.mutateAsync({
        handoffId: packageEdit.handoffId,
        intent: mode === "replacement" ? "replacement" : "new_version",
      });
      const draftId = `package-${packageEdit.candidateId}-${Date.now().toString(36)}`;
      const queued = await queueExport.mutateAsync({
        videoDbId: video.id,
        mode: "separate",
        title: `${packageEdit.sourceTitle || `Clip ${packageEdit.candidateId}`} revised`,
        outputDir: outputDirectory,
        items: [{
          draftId,
          label: packageEdit.sourceTitle || `Revised clip ${packageEdit.candidateId}`,
          inPoint,
          outPoint,
        }],
      });
      const attached = await attachStudioExport.mutateAsync({
        handoffId: packageEdit.handoffId,
        studioExportId: queued.export.id,
        draftId,
      });
      setPackageRevision({
        versionId: attached.version.id,
        exportId: queued.export.id,
        draftId,
        mode,
      });
      setPackageSavedMessage(mode === "replacement"
        ? "Rendering and verifying the replacement. The original clip remains active until this finishes."
        : "Rendering a revised copy. The original clip will not be changed.");
    } catch (saveError) {
      setPackageSaveError(friendlyError(saveError));
    }
  };

  const retryPackageRevision = async () => {
    if (!packageRevision) return;
    setPackageSaveError(null);
    setPackageSavedMessage("Retrying the existing revision. The original packaged clip remains unchanged.");
    try {
      activationRequestedRef.current = null;
      await retryExport.mutateAsync({ exportId: packageRevision.exportId });
      await editedVersionQuery.refetch();
    } catch (retryError) {
      setPackageSaveError(friendlyError(retryError));
    }
  };

  const revisionView = editedVersionQuery.data as ({
    status?: string;
    progress?: number;
    stage?: string;
    canActivate?: boolean;
    activationPending?: boolean;
    error?: string | null;
  } | undefined);

  const activatePackageReplacement = useCallback(() => {
    if (!packageRevision || revisionView?.status !== "ready") return;
    activationRequestedRef.current = packageRevision.versionId;
    setPackageSaveError(null);
    activateEditedVersion.mutate({ versionId: packageRevision.versionId });
  }, [activateEditedVersion, packageRevision, revisionView?.status]);

  useEffect(() => {
    if (!packageRevision || revisionView?.status !== "ready") return;
    if (packageRevision.mode === "copy") {
      setPackageSavedMessage("Revised copy verified and ready. The original packaged clip is unchanged.");
      return;
    }
    if (activationRequestedRef.current === packageRevision.versionId) return;
    activatePackageReplacement();
  }, [activatePackageReplacement, packageRevision, revisionView?.status]);

  const addClip = () => {
    if (!validRange || inPoint == null || outPoint == null) {
      setRangeError(rangeValidation && !rangeValidation.ok ? rangeValidation.message : "Set a valid In and Out selection first.");
      return;
    }
    if (!canExportHD) {
      setRangeError("This source has no verified 720p-or-better export. Cut IQ will not label a lower-resolution clip as HD.");
      return;
    }
    const label = clipLabel.trim() || `Clip ${fmtTime(inPoint)} to ${fmtTime(outPoint)}`;
    commitQueue((queue) => [...queue, {
      clientId: makeClientId(),
      label,
      inPoint,
      outPoint,
      status: "draft",
      createdAt: Date.now(),
      selected: true,
    }]);
    setClipLabel("");
    setRangeError(null);
  };

  const queueDraft = useCallback(async (draft: StudioClipDraft) => {
    if (!video || draft.status === "queued") return;
    try {
      const result = await queueExport.mutateAsync({
        videoDbId: video.id,
        mode: "separate",
        title: draft.label,
        outputDir: outputDirectory,
        items: [{ draftId: draft.clientId, label: draft.label, inPoint: draft.inPoint, outPoint: draft.outPoint }],
      });
      setClipQueue((queue) => queue.map((item) => item.clientId === draft.clientId ? {
        ...item,
        status: "queued",
        jobId: result.export.id,
        outputDir: result.export.outputDir,
        error: undefined,
      } : item));
      if (video) utils.studio.listExports.invalidate({ videoDbId: video.id, limit: 100 });
    } catch (queueError) {
      setClipQueue((queue) => queue.map((item) => item.clientId === draft.clientId ? {
        ...item,
        status: "failed",
        error: friendlyError(queueError),
      } : item));
    }
  }, [outputDirectory, queueExport, utils.studio.listExports, video]);

  const removeDraft = async (draft: StudioClipDraft) => {
    if (draft.jobId != null && draft.status === "queued") {
      try {
        await cancelRender.mutateAsync({ exportId: draft.jobId });
        if (video) utils.studio.listExports.invalidate({ videoDbId: video.id, limit: 100 });
      } catch {
        // The job may be completed already. Removing it from the Studio session remains safe.
      }
    }
    commitQueue((queue) => queue.filter((item) => item.clientId !== draft.clientId));
  };

  const refreshExports = useCallback(() => {
    if (video) utils.studio.listExports.invalidate({ videoDbId: video.id, limit: 100 });
  }, [utils.studio.listExports, video]);

  const cancelStudioJob = useCallback(async (exportId: number) => {
    try {
      await cancelRender.mutateAsync({ exportId });
      refreshExports();
    } catch (cancelError) {
      setError(friendlyError(cancelError));
    }
  }, [cancelRender, refreshExports]);

  const retryStudioJob = useCallback(async (exportId: number) => {
    try {
      await retryExport.mutateAsync({ exportId });
      refreshExports();
    } catch (retryError) {
      setError(friendlyError(retryError));
    }
  }, [refreshExports, retryExport]);

  const moveDraft = (clientId: string, direction: -1 | 1) => {
    commitQueue((queue) => {
      const index = queue.findIndex((draft) => draft.clientId === clientId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= queue.length) return queue;
      const next = [...queue];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const exportSelection = async (mode: StudioExportMode) => {
    const destination = validateStudioDestination(outputDirectory);
    if (!destination.ok) {
      setRangeError(destination.message);
      return;
    }
    const plan = createStudioExportPlan(
      clipQueue.map((draft) => ({
        id: draft.clientId,
        label: draft.label,
        inMs: Math.round(draft.inPoint * 1000),
        outMs: Math.round(draft.outPoint * 1000),
        selected: draft.selected,
      })),
      Math.round(usableDuration * 1000),
      mode,
    );
    if (!plan.ok) {
      setRangeError(plan.message);
      return;
    }
    setOutputDirectory(destination.path);
    if (!video) return;
    try {
      const byId = new Map(clipQueue.map((draft) => [draft.clientId, draft]));
      const drafts = plan.clips.map((clip) => byId.get(clip.id)).filter((draft): draft is StudioClipDraft => Boolean(draft));
      const result = await queueExport.mutateAsync({
        videoDbId: video.id,
        mode: mode === "join" ? "joined" : "separate",
        title: mode === "join" ? `${source?.title ?? video.title ?? "Cut IQ"} joined clips` : `${drafts.length} Cut IQ clips`,
        outputDir: destination.path,
        items: drafts.map((draft) => ({ draftId: draft.clientId, label: draft.label, inPoint: draft.inPoint, outPoint: draft.outPoint })),
      });
      setClipQueue((queue) => queue.map((draft) => drafts.some((selected) => selected.clientId === draft.clientId) ? {
        ...draft,
        status: "queued",
        jobId: result.export.id,
        outputDir: result.export.outputDir,
        error: undefined,
      } : draft));
      setRangeError(null);
      utils.studio.listExports.invalidate({ videoDbId: video.id, limit: 100 });
    } catch (exportError) {
      setRangeError(friendlyError(exportError));
    }
  };

  const saveSegment = (segment: StudioTranscriptSegment, displayText: string) => {
    if (!video) return;
    setEditOverrides((edits) => ({
      ...edits,
      [segment.idx]: { segmentIdx: segment.idx, originalText: segment.text, displayText },
    }));
    saveSegmentEdit.mutate({
      videoDbId: video.id,
      segmentIdx: segment.idx,
      originalText: segment.text,
      displayText,
    }, {
      onSuccess: () => utils.studio.listEdits.invalidate({ videoDbId: video.id }),
      onError: (saveError) => setError(friendlyError(saveError)),
    });
  };

  const restoreSegment = (segment: StudioTranscriptSegment) => {
    if (!video) return;
    setEditOverrides((edits) => {
      const next = { ...edits };
      delete next[segment.idx];
      return next;
    });
    resetSegment.mutate({ videoDbId: video.id, segmentIdx: segment.idx }, {
      onSuccess: () => utils.studio.listEdits.invalidate({ videoDbId: video.id }),
      onError: (resetError) => setError(friendlyError(resetError)),
    });
  };

  const busy = inspectSource.isPending || loadVideo.isPending;
  const transcriptReady = video != null && segments.length > 0 && stage === "ready";
  const packageRevisionStatus = revisionView?.status ?? (packageRevision ? "queued" : null);
  const packageRevisionProgress = Math.max(0, Math.min(100, Math.round(revisionView?.progress ?? packageStudioExportQuery.data?.progress ?? (packageRevisionStatus === "ready" ? 100 : 0))));
  const packageSaveBusy = queueExport.isPending || attachStudioExport.isPending || activateEditedVersion.isPending
    || Boolean(packageRevisionStatus && !["ready", "active", "failed", "cancelled"].includes(packageRevisionStatus));
  const packageName = packageEdit
    ? packageEdit.projectName || window.sessionStorage.getItem(`clipsift-package-name:${packageEdit.projectId}:${packageEdit.candidateId}`) || `Project ${packageEdit.projectId}`
    : null;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#090a0c] text-zinc-100">
      <AppNav active="studio" actions={<span className={`hidden items-center gap-1.5 rounded border px-2 py-1 text-[11px] sm:inline-flex ${stageTone(stage)}`}>{busy && <Loader2 className="h-3 w-3 animate-spin" />}{stage === "ready" && <CheckCircle2 className="h-3 w-3" />}{stageLabel(stage)}</span>} />
      {(handoffId && !packageEdit) && (
        <div className="flex shrink-0 items-center gap-3 border-b border-brand-500/20 bg-brand-500/[0.04] px-5 py-2.5 text-sm" role="status">
          {packageHandoffQuery.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-brand-300" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}
          <span className="text-zinc-300">{packageHandoffQuery.isLoading ? "Opening the original source and timed transcript…" : packageSaveError ?? "This edit handoff could not be opened."}</span>
          {!packageHandoffQuery.isLoading && <button type="button" onClick={() => navigate(-1)} className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">Go back</button>}
        </div>
      )}
      {packageEdit && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-emerald-500/20 bg-[#0d1210] px-4 py-2.5 xl:px-5">
          <button type="button" onClick={returnToPackage} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to clip package
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-100">{packageName} <span className="px-1 text-zinc-600">/</span> {packageEdit.sourceTitle || `Clip ${packageEdit.candidateId}`}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-300"><CheckCircle2 className="h-4 w-4" />Editing a copy — original remains saved</span>
        </div>
      )}
      <header className={`${packageEdit ? "hidden" : ""} z-20 shrink-0 border-b border-white/10 bg-[#0c0d0f] px-4 py-2.5 xl:px-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="hidden shrink-0 sm:block"><p className="text-sm font-semibold">Manual Clip Studio</p><p className="text-[11px] text-zinc-500">YouTube or local video → transcript → MP4</p></div>
          <form className="relative order-3 min-w-[240px] flex-1 basis-full md:order-none md:basis-auto" onSubmit={(event) => { event.preventDefault(); if (!packageEdit) void loadSource(); }}>
            <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input value={url} readOnly={Boolean(packageEdit)} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a YouTube URL" className="h-11 w-full rounded-lg border border-zinc-700 bg-[#151619] pl-10 pr-20 text-sm text-zinc-100 shadow-inner outline-none read-only:cursor-default read-only:text-zinc-400 placeholder:text-zinc-600 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20" aria-label={packageEdit ? "Original package source URL" : "YouTube source URL"} />
            {!packageEdit && <button type="button" onClick={async () => { try { setUrl(await navigator.clipboard.readText()); } catch { setError("Clipboard access is unavailable. Paste the URL into the field instead."); } }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" aria-label="Paste URL from clipboard">Paste</button>}
          </form>
          {!packageEdit && <button type="button" onClick={() => void loadLocalVideo()} disabled={chooseLocalVideo.isPending || registerLocalSource.isPending} className="inline-flex h-11 items-center gap-2 rounded-lg border border-zinc-700 bg-[#151619] px-4 text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">{chooseLocalVideo.isPending || registerLocalSource.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}Choose file</button>}
          {!packageEdit && <button type="button" onClick={() => void loadSource()} disabled={busy || !url.trim()} className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white shadow-lg shadow-brand-950/40 hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}Load</button>}
          {busy ? <button type="button" onClick={() => void cancelLoading()} className="rounded-md px-2 py-2 text-xs text-amber-300 hover:bg-zinc-800 hover:text-amber-200">Cancel</button> : video ? <button type="button" onClick={() => void loadSource(true)} className="rounded-md p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Refresh transcript" aria-label="Refresh transcript"><RefreshCw className="h-4 w-4" /></button> : null}
          {sessionNotice && <span className="sr-only" aria-live="polite">{sessionNotice}</span>}
        </div>
      </header>

      {error && <div className="flex shrink-0 items-start gap-2 border-b border-red-500/25 bg-red-950/45 px-5 py-2 text-sm text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p className="flex-1">{error}</p><button type="button" onClick={() => setError(null)} className="rounded p-0.5 hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300" aria-label="Dismiss message"><X className="h-4 w-4" /></button></div>}

      {!workspaceActive && !handoffId ? (
        <main className="flex min-h-0 flex-1 overflow-y-auto p-6">
          <div className="m-auto grid w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-[#101114] shadow-2xl shadow-black/40 lg:grid-cols-[1.2fr_0.8fr]">
            <section className="p-8 sm:p-12"><span className="flex h-12 w-12 items-center justify-center rounded-xl border border-brand-500/30 bg-brand-500/10"><Film className="h-6 w-6 text-brand-400" /></span><p className="mt-6 text-sm font-medium text-brand-300">Fast manual clipping, kept separate</p><h1 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Find the moment in the transcript. Mark it. Export it.</h1><p className="mt-4 max-w-xl text-sm leading-6 text-zinc-400">Load a YouTube link or local video, click through its timed transcript, collect as many ranges as you need, then export individual MP4s or one joined cut.</p><div className="mt-6 flex flex-wrap gap-2 text-xs text-zinc-400"><span className="rounded-full border border-zinc-800 px-3 py-1.5">YouTube or local media</span><span className="rounded-full border border-zinc-800 px-3 py-1.5">Transcript search</span><span className="rounded-full border border-zinc-800 px-3 py-1.5">J K L · I / O</span></div></section>
            <aside className="border-t border-white/10 bg-black/15 p-8 lg:border-l lg:border-t-0"><h2 className="text-sm font-semibold">Editing bay workflow</h2><ol className="mt-5 space-y-5 text-sm text-zinc-400"><li className="flex gap-3"><span className="font-mono text-brand-400">01</span><span>Load a source and let Cut IQ prepare its timed transcript.</span></li><li className="flex gap-3"><span className="font-mono text-brand-400">02</span><span>Search, click, or follow playback to reach the exact moment.</span></li><li className="flex gap-3"><span className="font-mono text-brand-400">03</span><span>Set IN and OUT, preview the range, then add it to the basket.</span></li><li className="flex gap-3"><span className="font-mono text-brand-400">04</span><span>Select clips and export separate MP4s or one joined video.</span></li></ol></aside>
          </div>
        </main>
      ) : (
        <>
          <main className={`min-h-0 flex-1 overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1.7fr)_minmax(420px,1fr)] xl:overflow-hidden ${packageEdit ? "xl:grid-rows-[minmax(300px,50vh)_minmax(0,1fr)]" : ""}`}>
            <section className={packageEdit ? "contents" : "min-h-0 border-b border-white/10 p-3 sm:p-4 xl:overflow-y-auto xl:border-b-0 xl:border-r"}>
              <div className={packageEdit ? "min-h-0 overflow-hidden border-b border-white/10 p-3 sm:p-4 xl:col-start-1 xl:row-start-1 xl:border-b-0 xl:border-r" : "contents"}>
              <div className="overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl shadow-black/30">
                {localMedia ? (
                  <StudioMediaPlayer ref={playerRef} src={localMedia.objectUrl} title={localMedia.name} onTime={setCurrentTime} onDuration={setPlayerDuration} previewRange={previewRange} previewLoop={loopPreview} onPlayingChange={setPlaying} onPreviewEnd={() => { if (previewRange && loopPreview) seek(previewRange.inSec); else setPreviewRange(null); }} />
                ) : video ? (
                  <Player ref={playerRef} videoId={video.videoId} startAt={video.lastPosition} onTime={setCurrentTime} onDuration={setPlayerDuration} previewRange={previewRange} previewLoop={loopPreview} editorMode compact={Boolean(packageEdit)} onPlayingChange={setPlaying} onPreviewEnd={() => { if (previewRange && loopPreview) seek(previewRange.inSec); else setPreviewRange(null); }} />
                ) : handoffId ? <div className="flex aspect-video items-center justify-center gap-2 text-sm text-zinc-500"><Loader2 className="h-5 w-5 animate-spin text-brand-400" /> Preparing original source…</div> : null}
              </div>

              <div className="mt-2 flex min-h-8 items-center gap-2 px-1">
                {source?.thumbnail && <img src={source.thumbnail} alt="" className="hidden h-8 w-14 rounded object-cover sm:block" />}
                <div className="flex min-w-0 flex-1 items-center gap-2"><h1 className="min-w-0 truncate text-xs font-semibold">{source?.title ?? video?.title ?? localMedia?.name ?? "Untitled source"}</h1><span className="hidden truncate text-[11px] text-zinc-500 2xl:inline">{source?.channel ?? video?.channel ?? "Local file"}</span><div className="ml-auto hidden shrink-0 gap-1.5 text-[11px] text-zinc-500 sm:flex"><span className="rounded bg-zinc-900 px-1.5 py-0.5">{fmtTime(usableDuration)}</span><span className="rounded bg-zinc-900 px-1.5 py-0.5">{video ? `${sourceLabel(video)}${video.transcriptLang ? ` · ${video.transcriptLang}` : ""}` : "Local media"}</span><span className={`rounded px-1.5 py-0.5 ${canExportHD ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>{source?.sourceType === "local" ? "Original quality" : source?.sourceHeight ? `${source.sourceHeight}p source` : "Resolution pending"}</span></div></div>
                {video && !video.videoId.startsWith("local-") && <a href={`https://www.youtube.com/watch?v=${video.videoId}&t=${Math.floor(currentTime)}s`} target="_blank" rel="noreferrer" className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" aria-label="Open current time on YouTube"><ExternalLink className="h-4 w-4" /></a>}
              </div>
              </div>

              <section className={`${packageEdit ? "m-3 min-h-0 overflow-y-auto xl:col-span-2 xl:row-start-2" : "mt-3"} rounded-xl border border-white/10 bg-[#121316] p-3`} aria-label="Precise clip controls">
                {packageEdit && inPoint != null && outPoint != null && (
                  <div className="mb-3 rounded-lg border border-white/10 bg-black/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold text-zinc-200">Precision timeline</p>
                        <p className="mt-0.5 text-[11px] text-zinc-500">The dashed range is the packaged clip. The red range is what will be rendered.</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <span className="rounded border border-amber-500/25 px-2 py-1 text-amber-200">Original {fmtTime(packageEdit.originalOut - packageEdit.originalIn)}</span>
                        <span className="rounded border border-red-500/30 bg-red-500/[0.06] px-2 py-1 text-red-200">Revised {fmtTime(outPoint - inPoint)}</span>
                        <span className={`${outPoint - inPoint - (packageEdit.originalOut - packageEdit.originalIn) >= 0 ? "text-emerald-300" : "text-amber-300"}`}>
                          {outPoint - inPoint - (packageEdit.originalOut - packageEdit.originalIn) >= 0 ? "+" : ""}{(outPoint - inPoint - (packageEdit.originalOut - packageEdit.originalIn)).toFixed(1)}s context
                        </span>
                      </div>
                    </div>
                    <div className="mt-3">
                      <PrecisionRangeTimeline
                        duration={usableDuration}
                        originalIn={packageEdit.originalIn}
                        originalOut={packageEdit.originalOut}
                        inPoint={inPoint}
                        outPoint={outPoint}
                        currentTime={currentTime}
                        onInChange={(next) => { setInPoint(next); setPreviewRange(null); setPackageSavedMessage(null); }}
                        onOutChange={(next) => { setOutPoint(next); setPreviewRange(null); setPackageSavedMessage(null); }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => adjustPackageRange("in", -5)} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800">Start −5s</button>
                      <button type="button" onClick={() => adjustPackageRange("in", 5)} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800">Start +5s</button>
                      <button type="button" onClick={() => adjustPackageRange("out", -5)} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800">End −5s</button>
                      <button type="button" onClick={() => adjustPackageRange("out", 5)} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800">End +5s</button>
                      <button type="button" onClick={restorePackageRange} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-amber-500/25 px-2.5 py-1.5 text-[11px] font-medium text-amber-200 hover:bg-amber-500/[0.08]"><RotateCcw className="h-3 w-3" />Restore original</button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <button type="button" onClick={togglePlay} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300" aria-label={playing ? "Pause video" : "Play video"}>{playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}</button>
                  <span className="w-14 font-mono text-[11px] text-zinc-300">{fmtTime(currentTime)}</span><input type="range" min={0} max={Math.max(1, usableDuration)} step={0.05} value={clamp(currentTime, usableDuration || 1)} onChange={(event) => seek(Number(event.target.value), false)} className="h-1.5 min-w-24 flex-1 accent-brand-500" aria-label="Video scrubber" /><span className="w-14 text-right font-mono text-[11px] text-zinc-500">{fmtTime(usableDuration)}</span>
                </div>
                <div className="mt-3 grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-[122px_122px_minmax(92px,1fr)_auto_auto]">
                  <button type="button" onClick={setIn} className={`rounded-lg border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${inPoint == null ? "border-zinc-700 bg-zinc-950" : "border-brand-500 bg-brand-950/20"}`} title="Set IN (I)" aria-label="Set IN point at playhead (I)"><span className="block text-[11px] font-semibold text-brand-400">IN</span><span className="font-mono text-sm">{inPoint == null ? "--:--:--" : fmtTime(inPoint)}</span></button>
                  <button type="button" onClick={setOut} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400" title="Set OUT (O)" aria-label="Set OUT point at playhead (O)"><span className="block text-[11px] font-semibold text-zinc-400">OUT</span><span className="font-mono text-sm">{outPoint == null ? "--:--:--" : fmtTime(outPoint)}</span></button>
                  <div className="flex min-w-24 flex-col justify-center rounded-lg border border-transparent px-3"><span className="text-center text-xl font-medium">{validRange && inPoint != null && outPoint != null ? fmtTime(outPoint - inPoint) : "--:--"}</span><span className="text-center text-[11px] text-zinc-500">Selected duration</span></div>
                  <button type="button" onClick={previewSelection} disabled={!validRange} className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-4 text-xs font-medium hover:bg-zinc-800 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"><Play className="h-3.5 w-3.5" />Preview</button>
                  {!packageEdit && <button type="button" onClick={addClip} disabled={!validRange || !canExportHD} className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-500 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"><PlusCircle className="h-4 w-4" />Add clip</button>}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500"><span>J / K / L navigate · I / O mark · Space play</span><div className="flex items-center gap-2"><label className="flex items-center gap-1"><input type="checkbox" checked={loopPreview} onChange={(event) => setLoopPreview(event.target.checked)} className="accent-brand-500" />Loop preview</label><button type="button" onClick={() => { setInPoint(null); setOutPoint(null); setPreviewRange(null); setRangeError(null); }} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-zinc-800 hover:text-zinc-300"><Square className="h-3 w-3" />Clear range</button></div></div>
                {rangeError && <p className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-xs text-amber-300">{rangeError}</p>}
              </section>

              {packageEdit && (
                <section className="hidden" aria-label="Package revision">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
                    <div>
                      <h2 className="text-sm font-semibold text-zinc-100">Package revision</h2>
                      <p className="mt-1 text-xs leading-5 text-zinc-400">Save a separate verified copy, or replace the packaged clip after the new MP4 passes verification. The original remains available while rendering.</p>
                    </div>
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/[0.07] px-2.5 py-1 text-[10px] font-semibold text-emerald-300">Original protected</span>
                  </div>
                  {packageRevision && (
                    <div className="border-b border-white/10 px-4 py-3" role="status" aria-live="polite">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate font-medium text-zinc-200">{revisionView?.stage || packageStudioExportQuery.data?.stage || (packageRevision.mode === "replacement" ? "Preparing verified replacement" : "Preparing revised copy")}</span>
                        <span className="shrink-0 font-mono text-zinc-400">{packageRevisionProgress}%</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={packageRevisionProgress}>
                        <div className={`h-full rounded-full transition-[width] ${packageRevisionStatus === "failed" ? "bg-red-500" : packageRevisionStatus === "ready" || packageRevisionStatus === "active" ? "bg-emerald-500" : "bg-sky-500"}`} style={{ width: `${packageRevisionProgress}%` }} />
                      </div>
                    </div>
                  )}
                  {(packageSavedMessage || packageSaveError || revisionView?.error) && (
                    <div className={`mx-4 mt-3 rounded-lg border px-3 py-2 text-xs ${packageSaveError || revisionView?.error ? "border-red-500/25 bg-red-500/[0.06] text-red-200" : "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200"}`} role={packageSaveError || revisionView?.error ? "alert" : "status"}>
                      {packageSaveError || revisionView?.error || packageSavedMessage}
                    </div>
                  )}
                  <div className="hidden flex-wrap items-center justify-end gap-2 p-4">
                    <button type="button" onClick={returnToPackage} className="mr-auto min-h-10 rounded-lg px-3 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">Cancel</button>
                    {packageRevision && packageRevision.mode === "replacement" && revisionView?.canActivate && <button type="button" onClick={activatePackageReplacement} disabled={activateEditedVersion.isPending} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-500/35 px-4 text-xs font-semibold text-red-200 hover:bg-red-500/[0.08] disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${activateEditedVersion.isPending ? "animate-spin" : ""}`} />{packageSaveError ? "Retry activation" : "Activate replacement"}</button>}
                    {packageRevision && ["failed", "cancelled"].includes(packageRevisionStatus ?? "") && <button type="button" onClick={() => void retryPackageRevision()} disabled={retryExport.isPending} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-amber-500/30 px-4 text-xs font-semibold text-amber-200 hover:bg-amber-500/[0.08] disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${retryExport.isPending ? "animate-spin" : ""}`} />Retry revision</button>}
                    <button type="button" onClick={() => void savePackageRange("copy")} disabled={!validRange || packageSaveBusy || Boolean(packageRevision)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-4 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-35"><Copy className="h-3.5 w-3.5" />Save revised copy</button>
                    <button type="button" onClick={() => void savePackageRange("replacement")} disabled={!validRange || packageSaveBusy || Boolean(packageRevision)} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-xs font-semibold text-white shadow-lg shadow-red-950/30 hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-35"><Save className="h-3.5 w-3.5" />Replace packaged clip</button>
                  </div>
                </section>
              )}

              <section className={`${packageEdit ? "hidden" : "mt-3"} overflow-hidden rounded-xl border border-white/10 bg-[#121316]`} aria-label="Clip basket">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-3.5 py-3"><div><h2 className="text-sm font-semibold">Clip basket <span className="text-zinc-500">({clipQueue.length})</span></h2><p className="mt-0.5 text-[11px] text-zinc-500">Rename, reorder, preview, or uncheck anything before export.</p></div><div className="flex items-center gap-1"><button type="button" onClick={undoQueue} disabled={!queueHistory.length} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-25" aria-label="Undo basket change"><Undo2 className="h-4 w-4" /></button><button type="button" onClick={redoQueue} disabled={!queueFuture.length} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 disabled:opacity-25" aria-label="Redo basket change"><Redo2 className="h-4 w-4" /></button></div></div>
                <div className="flex gap-2 border-b border-white/10 bg-black/10 p-2.5"><input value={clipLabel} onChange={(event) => setClipLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addClip(); } }} placeholder="Optional clip name before adding" className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20" /><button type="button" onClick={addClip} disabled={!validRange || !canExportHD} className="rounded-md border border-zinc-700 px-3 text-xs font-medium hover:bg-zinc-800 disabled:opacity-30">Add range</button></div>
                {clipQueue.length ? <div className="overflow-hidden"><table className="w-full table-fixed text-left text-xs">
                  <colgroup>
                    <col className="w-8" />
                    <col className="w-9" />
                    <col className="w-8" />
                    <col />
                    <col className="hidden w-36 lg:table-column" />
                    <col className="hidden w-16 md:table-column" />
                    <col className="hidden w-16 md:table-column" />
                    <col className="hidden w-20 md:table-column" />
                    <col className="w-28 sm:w-36" />
                  </colgroup>
                  <thead className="border-b border-white/10 text-[11px] uppercase tracking-wider text-zinc-500"><tr><th className="px-2 py-2"><span className="sr-only">Reorder</span></th><th className="px-2 py-2"><input type="checkbox" checked={clipQueue.length > 0 && clipQueue.every((draft) => draft.selected)} onChange={(event) => commitQueue((queue) => queue.map((draft) => ({ ...draft, selected: event.target.checked })))} className="accent-brand-500" aria-label="Select all clips" /></th><th className="px-2 py-2">#</th><th className="px-2 py-2">Name</th><th className="hidden px-2 py-2 lg:table-cell">Thumbnail</th><th className="hidden px-2 py-2 md:table-cell">In</th><th className="hidden px-2 py-2 md:table-cell">Out</th><th className="hidden px-2 py-2 md:table-cell">Duration</th><th className="px-2 py-2 text-right">Actions</th></tr></thead><tbody className="divide-y divide-white/5">{clipQueue.map((draft, index) => {
                  const job = draft.jobId == null ? null : renderJobs.find((item) => item.id === draft.jobId) ?? null;
                  const normalizedStatus = job?.status === "preparing" || job?.status === "rendering" || job?.status === "joining"
                    ? "rendering"
                    : (job?.status ?? draft.status);
                  const actions = studioExportActions(normalizedStatus as "draft" | "queued" | "rendering" | "ready" | "failed" | "cancelled");
                  const progress = Math.max(0, Math.min(100, Math.round(job?.progress ?? (draft.status === "queued" ? 0 : 0))));
                  const statusTone = job?.status === "ready" ? "text-emerald-300" : job?.status === "failed" ? "text-red-300" : job?.status === "cancelled" ? "text-zinc-500" : job ? "text-sky-300" : "text-zinc-500";
                  return (
                    <tr key={draft.clientId} className={`${draft.selected ? "bg-white/[0.015]" : "opacity-55"} hover:bg-white/[0.03]`}>
                      <td className="px-2 py-2"><div className="flex items-center"><GripVertical className="h-4 w-4 text-zinc-700" /><div className="flex flex-col"><button type="button" onClick={() => moveDraft(draft.clientId, -1)} disabled={index === 0} className="text-zinc-500 hover:text-zinc-200 disabled:opacity-20" aria-label={`Move ${draft.label} up`}><ArrowUp className="h-3 w-3" /></button><button type="button" onClick={() => moveDraft(draft.clientId, 1)} disabled={index === clipQueue.length - 1} className="text-zinc-500 hover:text-zinc-200 disabled:opacity-20" aria-label={`Move ${draft.label} down`}><ArrowDown className="h-3 w-3" /></button></div></div></td>
                      <td className="px-2 py-2"><input type="checkbox" checked={draft.selected} onChange={(event) => commitQueue((queue) => queue.map((item) => item.clientId === draft.clientId ? { ...item, selected: event.target.checked } : item))} className="accent-brand-500" aria-label={`Select ${draft.label} for export`} /></td>
                      <td className="px-2 py-2 text-zinc-500">{index + 1}</td>
                      <td className="min-w-0 px-2 py-2">
                        <input value={draft.label} onChange={(event) => commitQueue((queue) => queue.map((item) => item.clientId === draft.clientId ? { ...item, label: event.target.value.slice(0, 255) } : item))} className="w-full min-w-0 truncate rounded border border-transparent bg-transparent px-1.5 py-1 text-zinc-200 outline-none hover:border-zinc-700 focus:border-brand-500" aria-label={`Rename clip ${index + 1}`} />
                        <div className="mt-1 flex items-center gap-2 px-1.5 font-mono text-[11px] text-zinc-500 md:hidden"><span>{fmtTime(draft.inPoint)} → {fmtTime(draft.outPoint)}</span><span className="text-zinc-700">·</span><span>{fmtTime(draft.outPoint - draft.inPoint)}</span></div>
                        {job && <div className="mt-1 px-1.5"><div className="flex items-center justify-between gap-2 text-[11px]"><span className={`truncate ${statusTone}`}>{job.stage || job.status}</span><span className="font-mono text-zinc-500">{progress}%</span></div><div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-label={`${draft.label} export progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div className={`h-full rounded-full ${job.status === "failed" ? "bg-red-500" : job.status === "ready" ? "bg-emerald-500" : "bg-sky-500"}`} style={{ width: `${progress}%` }} /></div></div>}
                      </td>
                      <td className="hidden px-2 py-2 lg:table-cell">
                        <div className="grid h-10 w-full grid-cols-3 overflow-hidden rounded-md border border-white/10 bg-zinc-950" title={`Source preview for ${draft.label}`}>
                          {source?.thumbnail ? [20, 50, 80].map((position) => <img key={position} src={source.thumbnail!} alt="" loading="lazy" className="h-full w-full border-r border-black/40 object-cover last:border-r-0" style={{ objectPosition: `${position}% center` }} />) : <span className="col-span-3 flex items-center justify-center text-zinc-600"><Film className="h-4 w-4" /></span>}
                        </div>
                      </td>
                      <td className="hidden px-2 py-2 font-mono text-zinc-400 md:table-cell">{fmtTime(draft.inPoint)}</td><td className="hidden px-2 py-2 font-mono text-zinc-400 md:table-cell">{fmtTime(draft.outPoint)}</td><td className="hidden px-2 py-2 font-mono text-zinc-400 md:table-cell">{fmtTime(draft.outPoint - draft.inPoint)}</td>
                      <td className="overflow-hidden px-2 py-2"><div className="flex flex-wrap items-center justify-end gap-1"><button type="button" onClick={() => { setInPoint(draft.inPoint); setOutPoint(draft.outPoint); setPreviewRange({ inSec: draft.inPoint, outSec: draft.outPoint }); seek(draft.inPoint); }} className="rounded-md border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800" aria-label={`Preview ${draft.label}`}><Play className="h-3.5 w-3.5" /></button>{!job && <button type="button" onClick={() => void queueDraft(draft)} disabled={queueExport.isPending} className="rounded-md border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30" aria-label={`Export ${draft.label}`}><Download className="h-3.5 w-3.5" /></button>}{job && actions.canCancel && <button type="button" onClick={() => void cancelStudioJob(job.id)} className="rounded-md border border-zinc-700 px-2 py-1.5 text-[11px] text-amber-300 hover:bg-zinc-800">Cancel</button>}{job && actions.canRetry && <button type="button" onClick={() => void retryStudioJob(job.id)} className="rounded-md border border-zinc-700 px-2 py-1.5 text-[11px] text-sky-300 hover:bg-zinc-800">Retry</button>}{job && actions.canOpen && <><button type="button" onClick={() => openOutput.mutate({ exportId: job.id, draftId: draft.clientId, target: "file" })} className="rounded-md border border-zinc-700 p-1.5 text-emerald-300 hover:bg-zinc-800" aria-label={`Open exported ${draft.label}`}><Download className="h-3.5 w-3.5" /></button><button type="button" onClick={() => openOutput.mutate({ exportId: job.id, target: "folder" })} className="rounded-md border border-zinc-700 p-1.5 text-emerald-300 hover:bg-zinc-800" aria-label={`Open folder for ${draft.label}`}><FolderOpen className="h-3.5 w-3.5" /></button></>}<button type="button" onClick={() => void removeDraft(draft)} disabled={Boolean(job && !actions.canRemove)} className="rounded-md border border-transparent p-1.5 text-zinc-500 hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-25" aria-label={`Remove ${draft.label}`}><Trash2 className="h-3.5 w-3.5" /></button></div>{(job?.error ?? draft.error) && <p className="mt-1 text-right text-[11px] text-red-300" title={job?.error ?? draft.error}>{job?.error ?? draft.error}</p>}</td>
                    </tr>
                  );
                })}</tbody></table></div> : <div className="flex min-h-28 flex-col items-center justify-center p-6 text-center"><ListChecks className="h-5 w-5 text-zinc-700" /><p className="mt-2 text-xs text-zinc-500">Set IN and OUT, then add your first clip.</p></div>}
              </section>
            </section>

            <aside className={`${packageEdit ? "min-h-[420px] xl:col-start-2 xl:row-start-1 xl:min-h-0" : "min-h-[520px]"} border-t border-white/10 bg-[#0d0e10] p-3 xl:border-t-0`}>
              <div className={`h-full overflow-hidden rounded-xl border border-white/10 bg-[#101114] ${packageEdit ? "min-h-[400px] xl:min-h-0" : "min-h-[500px] xl:min-h-[420px]"}`}>
                {transcriptReady ? <TranscriptStudioReader segments={segments} edits={editMap} currentTime={currentTime} searchQuery={searchQuery} onSearchQueryChange={setSearchQuery} searchFocusRequest={searchFocusRequest} onSeek={seek} onSaveSegment={saveSegment} onResetSegment={restoreSegment} selection={validRange && inPoint != null && outPoint != null ? { inSec: inPoint, outSec: outPoint } : null} originalSelection={packageEdit ? { inSec: packageEdit.originalIn, outSec: packageEdit.originalOut } : null} /> : <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 p-8 text-center">{busy || stage === "preparing" ? <Loader2 className="h-7 w-7 animate-spin text-red-400" /> : <Captions className="h-7 w-7 text-zinc-600" />}<div><h2 className="text-sm font-semibold text-zinc-200">{busy || stage === "preparing" ? stageLabel(stage) : video ? "Video ready · transcript unavailable" : "Transcript unavailable"}</h2><p className="mt-1 max-w-sm text-sm leading-6 text-zinc-500">{video ? "You can still review the original source and set precise IN and OUT points manually." : localMedia ? "Cut IQ is preparing a timed local transcript. You can already review the video and use precise transport controls." : error ?? "Import a transcript or retry the source when captions are available."}</p></div>{!busy && video && <button type="button" onClick={() => setShowImport(true)} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"><FileUp className="h-4 w-4" />Import transcript</button>}</div>}
              </div>
            </aside>
          </main>

          <footer className="z-20 shrink-0 border-t border-white/10 bg-[#111215] px-4 py-3 shadow-[0_-14px_32px_rgba(0,0,0,0.35)]">
            {packageEdit && <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-zinc-100">{packageName} <span className="px-1 text-zinc-600">/</span> {packageEdit.sourceTitle || `Clip ${packageEdit.candidateId}`}</p><p className="mt-0.5 text-[11px] text-zinc-400">{inPoint != null && outPoint != null ? `${fmtTime(inPoint)}–${fmtTime(outPoint)} · ${fmtTime(outPoint - inPoint)} revised` : "Set a valid IN and OUT range"} · original protected</p></div>
              {packageRevision && <div className="min-w-[210px] max-w-[320px] flex-1" role={packageSaveError || revisionView?.error ? "alert" : "status"} aria-live="polite">
                <div className={`flex items-center justify-between gap-2 text-[11px] ${packageSaveError || revisionView?.error ? "text-red-300" : packageRevisionStatus === "ready" || packageRevisionStatus === "active" ? "text-emerald-300" : "text-zinc-300"}`}>
                  <span className="truncate">{packageSaveError || revisionView?.error || packageSavedMessage || revisionView?.stage || packageStudioExportQuery.data?.stage || "Preparing revised clip"}</span>
                  <span className="shrink-0 font-mono">{packageRevisionProgress}%</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={packageRevisionProgress}>
                  <div className={`h-full rounded-full transition-[width] ${packageSaveError || revisionView?.error || packageRevisionStatus === "failed" ? "bg-red-500" : packageRevisionStatus === "ready" || packageRevisionStatus === "active" ? "bg-emerald-500" : "bg-sky-500"}`} style={{ width: `${packageRevisionProgress}%` }} />
                </div>
              </div>}
              <button type="button" onClick={returnToPackage} className="min-h-10 rounded-lg px-3 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">Cancel</button>
              {packageRevision && packageRevision.mode === "replacement" && revisionView?.canActivate && <button type="button" onClick={activatePackageReplacement} disabled={activateEditedVersion.isPending} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-500/35 px-4 text-xs font-semibold text-red-200 hover:bg-red-500/[0.08] disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${activateEditedVersion.isPending ? "animate-spin" : ""}`} />{packageSaveError ? "Retry activation" : "Activate replacement"}</button>}
              {packageRevision && packageRevisionStatus === "failed" && <button type="button" onClick={() => void retryPackageRevision()} disabled={retryExport.isPending} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-amber-500/30 px-4 text-xs font-semibold text-amber-200 hover:bg-amber-500/[0.08] disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${retryExport.isPending ? "animate-spin" : ""}`} />Retry revision</button>}
              <button type="button" onClick={() => void savePackageRange("copy")} disabled={!validRange || packageSaveBusy || Boolean(packageRevision)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-4 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-35"><Copy className="h-3.5 w-3.5" />Save revised copy</button>
              <button type="button" onClick={() => void savePackageRange("replacement")} disabled={!validRange || packageSaveBusy || Boolean(packageRevision)} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-35"><Save className="h-3.5 w-3.5" />Replace packaged clip</button>
            </div>}
            <div className={`${packageEdit ? "hidden" : "flex"} flex-col gap-3 xl:flex-row xl:items-center xl:justify-between`}>
              <div className="flex min-w-0 flex-1 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-950"><ListChecks className="h-5 w-5 text-zinc-300" /></span><div className="min-w-0"><div className="flex flex-wrap items-baseline gap-2"><strong className="text-base">{basketSummary.selectedCount} {basketSummary.selectedCount === 1 ? "clip" : "clips"} selected</strong><span className="text-zinc-600">·</span><span className="font-mono text-sm text-zinc-400">{fmtTime(selectedDuration)} total</span>{latestCompletedExport && <button type="button" onClick={() => openOutput.mutate({ exportId: latestCompletedExport.id, target: "folder" })} className="ml-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20"><CheckCircle2 className="h-3 w-3" />{latestCompletedExport.mode === "joined" ? "Joined MP4 ready" : `${latestCompletedExport.outputPaths.length} MP4${latestCompletedExport.outputPaths.length === 1 ? "" : "s"} ready`}</button>}</div><div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500"><Folder className="h-3 w-3 shrink-0" /><button type="button" onClick={async () => { const chosen = await chooseOutputDirectory.mutateAsync(); if (chosen.path) setOutputDirectory(chosen.path); }} className="max-w-[420px] truncate rounded px-1 text-left hover:bg-zinc-800 hover:text-zinc-300" title={`${outputDirectory} · Click to choose another folder`}>{outputDirectory}</button><button type="button" onClick={() => void navigator.clipboard.writeText(outputDirectory)} className="rounded p-1 hover:bg-zinc-800 hover:text-zinc-300" aria-label="Copy output folder path"><Copy className="h-3 w-3" /></button></div></div></div>
              <div className="flex flex-wrap items-center justify-end gap-2"><button type="button" onClick={async () => { const chosen = await chooseOutputDirectory.mutateAsync(); if (chosen.path) setOutputDirectory(chosen.path); }} disabled={chooseOutputDirectory.isPending} className="mr-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-40"><FolderOpen className="h-3.5 w-3.5" />Change folder</button><button type="button" onClick={() => void exportSelection(basketSummary.modes.single ? "single" : "separate")} disabled={!basketSummary.modes.separate || queueExport.isPending} className="inline-flex h-11 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-5 text-sm font-medium hover:bg-zinc-800 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"><Save className="h-4 w-4" />{basketSummary.modes.single ? "Export selected clip" : `Export separate files (${basketSummary.selectedCount})`}</button><button type="button" onClick={() => void exportSelection("join")} disabled={!basketSummary.modes.join || queueExport.isPending} className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-semibold text-white shadow-lg shadow-brand-950/30 hover:bg-brand-500 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"><Scissors className="h-4 w-4" />Join & export ({fmtTime(selectedDuration)})</button></div>
            </div>
          </footer>
        </>
      )}

      {showImport && video && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onImport={async (format, content) => {
            const imported = await importTranscript.mutateAsync({ videoDbId: video.id, format, content });
            setSegments(imported.segments as StudioTranscriptSegment[]);
            setVideo((current) => current ? { ...current, transcriptKind: "imported", status: "ok", errorMessage: null } : current);
            setStage("ready");
            utils.studio.listEdits.invalidate({ videoDbId: video.id });
          }}
        />
      )}
    </div>
  );
}
