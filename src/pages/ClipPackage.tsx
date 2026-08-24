import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { skipToken } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock,
  CloudCheck,
  Download,
  ExternalLink,
  FileVideo2,
  Folder,
  FolderOpen,
  History,
  Loader2,
  MessageSquareText,
  Play,
  Search,
  SlidersHorizontal,
  Square,
  SquareCheckBig,
  X,
} from "lucide-react";
import { AppNav } from "@/components/AppNav";
import { InlineError, InlineLoading } from "@/components/InlineState";
import { trpc } from "@/providers/trpc";
import {
  clipThumbnailSource,
  fmtClock,
  manifestClipDuration,
  type ManifestClip,
} from "@/lib/assemble";

type ClipFilter = "all" | "verified" | "game" | "broll";
type MediaLane = "plays" | "soundbites" | "copies" | "all";
interface EditedPackageVersion {
  id: string;
  packageAssetId: string;
  status: "draft" | "exporting" | "ready" | "failed" | "retired";
  activeReplacement: boolean;
  editIn: number;
  editOut: number;
  previewUrl: string | null;
  downloadUrl: string | null;
  error: string | null;
}

type PackageClip = ManifestClip & {
  previewUrl: string;
  packageAssetId: string;
  editedVersions?: EditedPackageVersion[];
  editedVersion?: EditedPackageVersion | null;
  activeVersion?: EditedPackageVersion | null;
};

interface PackageReturnState {
  search: string;
  source: string;
  filter: ClipFilter;
  filtersOpen: boolean;
  selectedAssetIds: string[];
  mediaLane: MediaLane;
  activeCandidateId: number | null;
  activeAssetId?: string | null;
  railScrollTop: number;
}

function readReturnState(projectId: number): PackageReturnState | null {
  try {
    const raw = window.sessionStorage.getItem(`clipsift-package-ui:${projectId}`);
    return raw ? JSON.parse(raw) as PackageReturnState : null;
  } catch {
    return null;
  }
}

interface SessionExport {
  id: string;
  label: string;
  fileCount: number;
  finishedAt: number;
  outputPaths: string[];
}

function clipType(clip: ManifestClip): string {
  const value = clip.purpose || clip.coverageTypes[0] || clip.verification.matchKind || "Finished clip";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function downloadHref(url: string): string {
  const [beforeHash, hash = ""] = url.split("#", 2);
  const [path, query = ""] = beforeHash.split("?", 2);
  const params = new URLSearchParams(query);
  if (!params.has("download")) params.set("download", "1");
  return `${path}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

export default function ClipPackage() {
  const [params] = useSearchParams();
  const projectId = Number(params.get("project"));

  return (
    <div className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-[#080a0c] text-zinc-100">
      <AppNav active="find" />
      {Number.isSafeInteger(projectId) && projectId > 0 ? (
        <ClipPackageLoaded projectId={projectId} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <InlineError
            title="Choose a finished Find Clips project"
            message="Clip packages open from a completed Find Clips project. No new Assemble project is required."
          />
        </div>
      )}
    </div>
  );
}

function ClipPackageLoaded({ projectId }: { projectId: number }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const pendingHandoffSeedRef = useRef<{ inSec: number; outSec: number; label: string } | null>(null);
  const initialReturnState = useMemo(() => readReturnState(projectId), [projectId]);
  const packageQuery = trpc.clipPackage.open.useQuery({ projectId }, {
    retry: 1,
    refetchInterval: (query) => query.state.data?.soundbites.activeCount ? 1_000 : false,
  });
  // Keep the package live while the Find Clips job is still finishing so new
  // verified clips appear without a manual refresh.
  const jobQuery = trpc.findClips.byProject.useQuery({ projectId }, {
    retry: 1,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status ?? "");
      return ["queued", "running", "cancelling"].includes(status) ? 3000 : false;
    },
  });
  const outputConfig = trpc.clipPackage.outputConfig.useQuery();
  const chooseOutput = trpc.clipPackage.chooseOutputDirectory.useMutation({
    onSuccess: ({ path }) => {
      if (path) setOutputDir(path);
    },
  });
  const queueExport = trpc.clipPackage.queueExport.useMutation({
    onSuccess: (job) => setExportId(job.id),
  });
  const queueSoundbites = trpc.clipPackage.queueSoundbites.useMutation({
    onSuccess: (result) => {
      setSoundbiteNotice(result.queued
        ? `${result.queued} broadcast video sound bite${result.queued === 1 ? " is" : "s are"} being prepared as MP4.`
        : result.discovered
          ? "The strongest discovered sound bites are already ready or being prepared."
          : "No strong broadcast sound bites were found in the indexed game feeds.");
      void packageQuery.refetch();
    },
  });
  const createStudioHandoff = trpc.clipPackage.createStudioHandoff.useMutation({
    onSuccess: ({ handoffId }) => {
      if (pendingHandoffSeedRef.current) {
        window.sessionStorage.setItem(`clipsift-handoff-seed:${handoffId}`, JSON.stringify(pendingHandoffSeedRef.current));
      }
      pendingHandoffSeedRef.current = null;
      navigate(`/transcript-studio?handoff=${encodeURIComponent(handoffId)}`);
    },
    onError: (handoffError) => setMediaError(handoffError.message || "Cut IQ could not open this source in Manual Clip Studio."),
  });
  // The active export id lives in the URL (?export=) so progress and the
  // completion handoff survive a refresh or navigation away and back.
  const exportId = params.get("export");
  const setExportId = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("export", id);
    else next.delete("export");
    setParams(next, { replace: true });
  };
  const sessionHistoryRef = useRef<SessionExport[]>([]);
  const [sessionHistory, setSessionHistory] = useState<SessionExport[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const exportQuery = trpc.clipPackage.exportJob.useQuery(
    exportId ? { id: exportId } : skipToken,
    {
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status && ["ready", "failed", "cancelled"].includes(status) ? false : 400;
      },
    },
  );
  const cancelExport = trpc.clipPackage.cancelExport.useMutation({
    onSuccess: () => void exportQuery.refetch(),
  });
  const openOutput = trpc.clipPackage.openOutput.useMutation();
  const syncToDrive = trpc.clipPackage.syncToDrive.useMutation({
    onSuccess: () => void packageQuery.refetch(),
  });
  const openDriveFolder = trpc.clipPackage.openDriveFolder.useMutation();

  const [activeCandidateId, setActiveCandidateId] = useState<number | null>(() => {
    const value = Number(params.get("clip"));
    return Number.isSafeInteger(value) && value > 0 ? value : initialReturnState?.activeCandidateId ?? null;
  });
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>(() => initialReturnState?.selectedAssetIds ?? []);
  const [search, setSearch] = useState(() => initialReturnState?.search ?? "");
  const [source, setSource] = useState(() => initialReturnState?.source ?? "all");
  const [filter, setFilter] = useState<ClipFilter>(() => initialReturnState?.filter ?? "all");
  const [mediaLane, setMediaLane] = useState<MediaLane>(() => {
    const value = params.get("lane");
    return value === "soundbites" || value === "copies" || value === "all" ? value : initialReturnState?.mediaLane ?? "plays";
  });
  const [soundbiteNotice, setSoundbiteNotice] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState("");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => initialReturnState?.filtersOpen ?? false);
  const [playRequest, setPlayRequest] = useState(0);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(() => initialReturnState?.activeAssetId ?? null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const data = packageQuery.data;
  const clips = useMemo(() => (data?.clips ?? []) as PackageClip[], [data?.clips]);
  const savedCopyClips = useMemo(() => (data?.savedCopies ?? []) as PackageClip[], [data?.savedCopies]);
  const packageAssets = useMemo(() => [...clips, ...savedCopyClips], [clips, savedCopyClips]);
  const playClips = useMemo(() => clips.filter((clip) => clip.selectionKind !== "broadcast_soundbite"), [clips]);
  const soundbiteClips = useMemo(() => clips.filter((clip) => clip.selectionKind === "broadcast_soundbite"), [clips]);
  const laneClips = mediaLane === "plays" ? playClips : mediaLane === "soundbites" ? soundbiteClips : mediaLane === "copies" ? savedCopyClips : packageAssets;
  const activeClip = laneClips.find((clip) => clip.packageAssetId === activeAssetId)
    ?? laneClips.find((clip) => clip.candidateId === activeCandidateId) ?? laneClips[0] ?? null;
  const activeVersion = activeClip?.editedVersion ?? activeClip?.editedVersions?.find((version) => version.id === activeVersionId && version.status === "ready") ?? null;
  const activeMediaUrl = activeVersion?.previewUrl ?? activeClip?.previewUrl ?? null;
  const sources = useMemo(
    () => [...new Set(laneClips.map((clip) => clip.game).filter((value): value is string => Boolean(value)))].sort(),
    [laneClips],
  );
  const filteredClips = useMemo(() => {
    const query = search.trim().toLowerCase();
    return laneClips.filter((clip) => {
      if (source !== "all" && clip.game !== source) return false;
      if (filter === "verified" && !clip.verification.playerVerified) return false;
      if (filter === "game" && !clip.coverageTypes.includes("game_footage") && clip.purpose !== "play_reference") return false;
      if (filter === "broll" && !clip.coverageTypes.includes("backup_broll")) return false;
      if (!query) return true;
      return [
        clip.game,
        clip.beatText,
        clip.transcript.text,
        clip.purpose,
        ...clip.coverageTypes,
        ...clip.queryContext,
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [filter, laneClips, search, source]);
  const selectedClips = packageAssets.filter((clip) => selectedAssetIds.includes(clip.packageAssetId));
  const selectedDuration = selectedClips.reduce((sum, clip) => sum + manifestClipDuration(clip), 0);
  const allSelected = laneClips.length > 0 && laneClips.every((clip) => selectedAssetIds.includes(clip.packageAssetId));
  const currentExport = exportQuery.data;
  const exportActive = Boolean(currentExport && ["queued", "preparing", "exporting"].includes(currentExport.status));
  const jobRunning = Boolean(jobQuery.data && ["queued", "running"].includes(jobQuery.data.status));
  const jobStatus = jobQuery.data?.status ?? null;

  // Record finished exports into the session history so a completed joined
  // MP4 stays reachable after starting the next export.
  useEffect(() => {
    if (!currentExport || currentExport.status !== "ready" || !currentExport.outputPaths.length) return;
    if (sessionHistoryRef.current.some((entry) => entry.id === exportId)) return;
    sessionHistoryRef.current = [
      {
        id: exportId!,
        label: currentExport.stage === "MP4 ready"
          ? (currentExport.outputPaths[0]?.split(/[\\/]/).pop() ?? "Joined MP4")
          : `Separate files · ${currentExport.outputPaths.length}`,
        fileCount: currentExport.outputPaths.length,
        finishedAt: Date.now(),
        outputPaths: [...currentExport.outputPaths],
      },
      ...sessionHistoryRef.current.filter((entry) => entry.id !== exportId),
    ].slice(0, 8);
    setSessionHistory(sessionHistoryRef.current);
  }, [currentExport, currentExport?.status, currentExport?.outputPaths.length, exportId]);

  useEffect(() => {
    if (!outputDir && outputConfig.data?.outputDir) setOutputDir(outputConfig.data.outputDir);
  }, [outputConfig.data?.outputDir, outputDir]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeMediaUrl) return;
    setMediaError(null);
    video.load();
    if (!playRequest) return;
    const startPlayback = () => {
      void video.play().catch(() => {
        setMediaError("Playback was blocked. Press Play in the video controls to continue.");
      });
    };
    if (video.readyState >= 2) startPlayback();
    else video.addEventListener("canplay", startPlayback, { once: true });
    return () => video.removeEventListener("canplay", startPlayback);
  }, [activeMediaUrl, playRequest]);

  const previewClip = (clip: PackageClip) => {
    setActiveCandidateId(clip.candidateId);
    setActiveAssetId(clip.packageAssetId);
    setActiveVersionId(clip.editedVersion?.id ?? null);
    setPlayRequest((value) => value + 1);
  };

  const previewVersion = (clip: PackageClip, version: EditedPackageVersion) => {
    setActiveCandidateId(clip.candidateId);
    setActiveAssetId(version.packageAssetId);
    setActiveVersionId(version.id);
    setPlayRequest((value) => value + 1);
  };

  const adjustClip = (clip: PackageClip, version?: EditedPackageVersion) => {
    const editIn = version?.editIn ?? clip.sourceStartSeconds;
    const editOut = version?.editOut ?? clip.sourceEndSeconds;
    if (editIn == null || editOut == null || editOut <= editIn) {
      setMediaError("Cut IQ does not have the original source timing for this clip, so its context cannot be extended safely.");
      return;
    }
    const returnParams = new URLSearchParams(params);
    returnParams.set("project", String(projectId));
    returnParams.set("clip", String(clip.candidateId));
    returnParams.set("lane", clip.selectionKind === "broadcast_soundbite" ? "soundbites" : mediaLane);
    returnParams.delete("export");
    const returnTo = `/clip-package?${returnParams.toString()}`;
    window.sessionStorage.setItem(`clipsift-package-ui:${projectId}`, JSON.stringify({
      search,
      source,
      filter,
      filtersOpen,
      selectedAssetIds,
      mediaLane,
      activeCandidateId: clip.candidateId,
      activeAssetId: clip.packageAssetId,
      railScrollTop: railRef.current?.scrollTop ?? 0,
    } satisfies PackageReturnState));
    window.sessionStorage.setItem(`clipsift-package-name:${projectId}:${clip.candidateId}`, data?.projectName ?? "Cut IQ project");
    window.sessionStorage.setItem(`clipsift-package-return:${projectId}:${clip.candidateId}`, returnTo);
    pendingHandoffSeedRef.current = version ? { inSec: editIn, outSec: editOut, label: `${clip.game ?? `Clip ${clip.candidateId}`} revised copy` } : null;
    createStudioHandoff.mutate({ projectId, candidateId: clip.candidateId, intent: "new_version" });
  };

  useEffect(() => {
    if (!data || !initialReturnState || !railRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (railRef.current) railRef.current.scrollTop = initialReturnState.railScrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, initialReturnState]);

  const changeMediaLane = (lane: MediaLane) => {
    setMediaLane(lane);
    setActiveCandidateId(null);
    setSource("all");
    setFilter("all");
    setMediaError(null);
  };

  const prepareSoundbites = () => {
    setSoundbiteNotice(null);
    changeMediaLane("soundbites");
    queueSoundbites.mutate({
      projectId,
      targetCount: Math.min(24, Math.max(8, (data?.soundbites.readyCount ?? 0) + 8)),
    });
  };

  const toggleSelected = (assetId: string) => {
    setSelectedAssetIds((current) => current.includes(assetId)
      ? current.filter((id) => id !== assetId)
      : [...current, assetId]);
  };

  const startExport = (mode: "separate" | "joined") => {
    if (!selectedAssetIds.length) return;
    setExportId(null);
    queueExport.mutate({
      projectId,
      mode,
      assetIds: packageAssets.filter((clip) => selectedAssetIds.includes(clip.packageAssetId)).map((clip) => clip.packageAssetId),
      outputDir: outputDir || undefined,
      title: `${data?.projectName ?? "Cut IQ"} selected clips`,
    });
  };

  if (packageQuery.isLoading) return <InlineLoading label="Opening finished clips…" />;
  if (packageQuery.isError || !data) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <InlineError
          title="This clip package could not be opened"
          message={packageQuery.error?.message ?? "The finished project is unavailable."}
          onRetry={() => void packageQuery.refetch()}
        />
      </div>
    );
  }

  if (!clips.length) {
    const finishedWithoutClips = ["completed", "completed_with_warnings"].includes(String(jobStatus));
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
        <div className={`flex h-16 w-16 items-center justify-center rounded-2xl border ${finishedWithoutClips ? "border-amber-500/30 bg-amber-500/10" : "border-zinc-800 bg-zinc-900"}`}>
          {finishedWithoutClips ? <CircleAlert className="h-8 w-8 text-amber-400" /> : <FileVideo2 className="h-8 w-8 text-zinc-600" />}
        </div>
        <div>
          <h1 className="text-xl font-semibold">{finishedWithoutClips ? "This job finished without playable clips" : "No finished MP4s yet"}</h1>
          <p className="mt-2 max-w-lg text-sm leading-6 text-zinc-500">
            {finishedWithoutClips
              ? "There is nothing hidden in the player: this job created zero verified MP4 files. Open the job details to see the source and transcript counts, or start a corrected job with a full script or coverage brief."
              : "This package will fill automatically as the current Find Clips job renders and verifies MP4 files."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Link to={`/?project=${projectId}`} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-900">{finishedWithoutClips ? "View job details" : "View job progress"}</Link>
          {finishedWithoutClips && <Link to="/new-job" className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-500">Start corrected job</Link>}
        </div>
      </div>
    );
  }

  return (
    <>
      <main className="min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-3 sm:px-6">
        <div className="mx-auto flex h-full max-w-[1900px] flex-col">
          <div className="mb-3 flex flex-wrap items-end gap-x-5 gap-y-2">
            <div className="min-w-0">
              <Link to="/" className="mb-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 transition hover:text-zinc-200">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Find Clips
              </Link>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="truncate text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl">{data.projectName}</h1>
                <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> {data.playClipCount} plays · {data.soundbiteClipCount} video sound bites ready
                </span>
                {jobRunning && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-200" role="status">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Job still running — package fills as clips verify
                  </span>
                )}
                {!jobQuery.isLoading && jobStatus === "paused" && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200" role="status">
                    <Clock className="h-3.5 w-3.5" /> Job paused — open the job to resume it
                  </span>
                )}
                {!jobQuery.isError && !jobQuery.data && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/60 px-3 py-1 text-xs font-medium text-zinc-400" role="status">
                    <Clock className="h-3.5 w-3.5" /> No active job — showing last finished clips
                  </span>
                )}
              </div>
              {data.readyMatchCount > data.uniqueClipCount && (
                <p className="mt-1 text-xs text-zinc-600">{data.readyMatchCount} verified matches consolidated into {data.uniqueClipCount} unique MP4 files.</p>
              )}
              {data.preservedMentionClipCount > 0 && (
                <p className="mt-1 text-xs text-zinc-600">Loose transcript matches remain preserved in job details; only confidently classified plays and broadcast sound bites appear here.</p>
              )}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {data.driveSync && (
                <div className={`flex min-w-[330px] items-center gap-3 rounded-xl border px-3 py-2 ${data.driveSync.available ? "border-emerald-500/25 bg-emerald-500/[0.06]" : "border-amber-500/25 bg-amber-500/[0.06]"}`}>
                  <CloudCheck className={`h-5 w-5 shrink-0 ${data.driveSync.available ? "text-emerald-400" : "text-amber-400"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold text-zinc-200">
                      {data.driveSync.available
                        ? `${data.driveSync.syncedClipCount} of ${data.uniqueClipCount} automatically synced to My Drive`
                        : "Google Drive desktop is offline"}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500" title={data.driveSync.folderPath}>
                      {data.driveSync.available ? data.driveSync.folderPath : `Original MP4s remain safe on D: · expected ${data.driveSync.root}`}
                    </p>
                  </div>
                  {data.driveSync.available && data.driveSync.pendingClipCount > 0 && (
                    <button
                      type="button"
                      onClick={() => syncToDrive.mutate({ projectId })}
                      disabled={syncToDrive.isPending}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50"
                    >
                      {syncToDrive.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Sync now
                    </button>
                  )}
                  {data.driveSync.syncedClipCount > 0 && (
                    <button
                      type="button"
                      onClick={() => openDriveFolder.mutate({ projectId })}
                      disabled={openDriveFolder.isPending}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-2 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      <FolderOpen className="h-3.5 w-3.5" /> Open folder
                    </button>
                  )}
                </div>
              )}
              <Link to={`/?project=${projectId}`} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200">
                View job details <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          {(syncToDrive.isError || openDriveFolder.isError) && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
              <CircleAlert className="h-4 w-4 shrink-0" /> {syncToDrive.error?.message ?? openDriveFolder.error?.message}
            </div>
          )}

          <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <section className="flex min-h-0 flex-col" aria-label="Clip preview">
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-black shadow-2xl shadow-black/40">
                <video
                  key={activeMediaUrl ?? activeClip?.clipId}
                  ref={videoRef}
                  src={activeMediaUrl ?? undefined}
                  poster={!activeVersion && activeClip ? clipThumbnailSource(activeClip) ?? undefined : undefined}
                  controls
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain"
                  onLoadedData={() => setMediaError(null)}
                  onError={() => setMediaError("This finished MP4 could not be loaded. Refresh the package or open the job details to verify the file.")}
                />
                {mediaError && (
                  <div className="absolute inset-x-4 top-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-950/90 p-3 text-xs text-red-100 shadow-xl" role="alert">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />
                    <span>{mediaError}</span>
                  </div>
                )}
              </div>
              {activeClip && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/55 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold text-zinc-100">{activeClip.game ?? `Clip ${activeClip.candidateId}`}</h2>
                    <p className="mt-0.5 text-xs text-zinc-500">{fmtClock(activeVersion ? activeVersion.editOut - activeVersion.editIn : manifestClipDuration(activeClip))} · {activeVersion ? "Saved revised copy" : clipType(activeClip)} · {activeClip.resolution.width ?? "?"}×{activeClip.resolution.height ?? "?"}</p>
                  </div>
                  <button onClick={() => previewClip(activeClip)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
                    <Play className="h-3.5 w-3.5 fill-current" /> Play clip
                  </button>
                  <button disabled={createStudioHandoff.isPending} onClick={() => adjustClip(activeClip, activeVersion ?? undefined)} className="inline-flex items-center gap-1.5 rounded-lg border border-brand-500/35 bg-brand-500/[0.06] px-3 py-2 text-xs font-semibold text-brand-200 hover:border-brand-400/60 hover:bg-brand-500/10 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
                    {createStudioHandoff.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SlidersHorizontal className="h-3.5 w-3.5" />} Adjust in/out
                  </button>
                  {(activeVersion?.downloadUrl ?? activeClip.downloadUrl) && (
                    <a href={downloadHref((activeVersion?.downloadUrl ?? activeClip.downloadUrl)!)} download className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 hover:border-emerald-500/50 hover:text-emerald-300">
                      <Download className="h-3.5 w-3.5" /> Download clip
                    </a>
                  )}
                </div>
              )}
              {activeClip && (activeClip.editedVersions?.filter((version) => version.status === "ready" && !version.activeReplacement).length ?? 0) > 0 && (
                <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-900/35 p-2.5" aria-label="Saved revised copies">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <p className="text-[11px] font-semibold text-zinc-300">Saved revised copies</p>
                    <span className="font-mono text-[10px] text-zinc-500">{activeClip.editedVersions!.filter((version) => version.status === "ready" && !version.activeReplacement).length}</span>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {activeClip.editedVersions!.filter((version) => version.status === "ready" && !version.activeReplacement).map((version, index) => (
                      <div key={version.id} className={`flex min-w-[220px] items-center gap-2 rounded-lg border px-2.5 py-2 ${activeVersionId === version.id ? "border-brand-500/50 bg-brand-500/[0.06]" : "border-zinc-700 bg-zinc-950/70"}`}>
                        <button type="button" onClick={() => previewVersion(activeClip, version)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700" aria-label={`Preview revised copy ${index + 1}`}><Play className="h-3.5 w-3.5 fill-current" /></button>
                        <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium text-zinc-200">Revised copy {index + 1}</p><p className="font-mono text-[10px] text-zinc-500">{fmtClock(version.editOut - version.editIn)} · {fmtClock(version.editIn)}–{fmtClock(version.editOut)}</p></div>
                        <button type="button" onClick={() => adjustClip(activeClip, version)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-brand-200" aria-label={`Reopen revised copy ${index + 1} in Manual Clip Studio`}><SlidersHorizontal className="h-3.5 w-3.5" /></button>
                        {version.downloadUrl && <a href={downloadHref(version.downloadUrl)} download className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-emerald-200" aria-label={`Download revised copy ${index + 1}`}><Download className="h-3.5 w-3.5" /></a>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#0d0f12]" aria-label="Finished clips">
              <div className="shrink-0 space-y-2 border-b border-zinc-800 p-3">
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-black/40 p-1" aria-label="Clip category">
                  {([
                    ["plays", "Player plays", playClips.length],
                    ["soundbites", "Video sound bites", soundbiteClips.length],
                    ["copies", "Saved copies", savedCopyClips.length],
                    ["all", "All", packageAssets.length],
                  ] as const).map(([lane, label, count]) => (
                    <button
                      key={lane}
                      type="button"
                      onClick={() => changeMediaLane(lane)}
                      className={`rounded-md px-2 py-2 text-[11px] font-semibold transition ${mediaLane === lane ? "bg-zinc-800 text-zinc-50 shadow" : "text-zinc-500 hover:text-zinc-200"}`}
                      aria-pressed={mediaLane === lane}
                    >
                      {label} <span className="ml-1 font-mono text-[10px] text-zinc-500">{count}</span>
                    </button>
                  ))}
                </div>
                {(mediaLane === "soundbites" || data.soundbites.activeCount > 0) && (
                  <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-2.5">
                    <div className="flex items-center gap-2">
                      <MessageSquareText className="h-4 w-4 shrink-0 text-sky-300" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-sky-100">Broadcast video sound bites</p>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">
                          Full video plus audio from sideline stories, profiles, stats and analyst discussion. Player plays stay separate.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={prepareSoundbites}
                        disabled={queueSoundbites.isPending || data.soundbites.activeCount > 0 || !data.soundbites.available || data.soundbites.readyCount >= 24}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {(queueSoundbites.isPending || data.soundbites.activeCount > 0) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {data.soundbites.activeCount > 0
                          ? `Preparing ${data.soundbites.activeCount} · ${data.soundbites.activeProgress}%`
                          : data.soundbites.readyCount
                            ? "Add more"
                            : "Prepare video clips"}
                      </button>
                    </div>
                    {(soundbiteNotice || queueSoundbites.isError) && (
                      <p className={`mt-2 text-[10px] ${queueSoundbites.isError ? "text-red-300" : "text-sky-200/80"}`} role="status">
                        {queueSoundbites.error?.message ?? soundbiteNotice}
                      </p>
                    )}
                  </div>
                )}
                <div className="flex gap-2">
                  <label className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles or transcript…" className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-900 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500" />
                  </label>
                  <button
                    type="button"
                    onClick={() => setFiltersOpen((value) => !value)}
                    aria-expanded={filtersOpen}
                    className={`relative flex h-10 w-10 items-center justify-center rounded-lg border text-zinc-400 hover:bg-zinc-800 ${filtersOpen ? "border-emerald-500/50 text-emerald-300" : "border-zinc-700"}`}
                    title={filtersOpen ? "Hide clip filters" : "Show clip filters"}
                    aria-label={filtersOpen ? "Hide clip filters" : "Show clip filters"}
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    {(source !== "all" || filter !== "all") && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400" />}
                  </button>
                </div>
                {filtersOpen && (
                <div className="flex items-center gap-2">
                  <label className="relative min-w-0 flex-1">
                    <select value={source} onChange={(event) => setSource(event.target.value)} className="h-9 w-full appearance-none truncate rounded-lg border border-zinc-700 bg-zinc-900 px-3 pr-8 text-xs text-zinc-300">
                      <option value="all">All sources</option>
                      {sources.map((value) => <option key={value} value={value}>{value}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                  </label>
                  <label className="relative min-w-0 flex-1">
                    <select value={filter} onChange={(event) => setFilter(event.target.value as ClipFilter)} className="h-9 w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 pr-8 text-xs text-zinc-300">
                      <option value="all">All clip types</option>
                      <option value="verified">Verified</option>
                      <option value="game">Game footage</option>
                      <option value="broll">B-roll</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                  </label>
                  {(search || source !== "all" || filter !== "all") && (
                    <button onClick={() => { setSearch(""); setSource("all"); setFilter("all"); }} className="px-1.5 text-xs text-zinc-500 hover:text-zinc-200">Clear</button>
                  )}
                </div>
                )}
              </div>

              <div ref={railRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
                {filteredClips.length ? filteredClips.map((clip) => {
                  const selected = selectedAssetIds.includes(clip.packageAssetId);
                  const active = activeClip?.packageAssetId === clip.packageAssetId;
                  const thumbnail = clipThumbnailSource(clip);
                  return (
                    <article
                      key={clip.packageAssetId}
                      className={`group grid grid-cols-[122px_minmax(0,1fr)] gap-3 rounded-xl border p-2 transition ${selected ? "border-emerald-500/80 bg-emerald-500/[0.06]" : active ? "border-zinc-600 bg-zinc-900" : "border-zinc-800 bg-zinc-900/45 hover:border-zinc-700 hover:bg-zinc-900"}`}
                    >
                      <button type="button" onClick={() => previewClip(clip)} className="relative aspect-video overflow-hidden rounded-lg bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400" aria-label={`Play ${clip.game ?? `clip ${clip.candidateId}`}`}>
                        {thumbnail ? <img src={thumbnail} alt="" loading="lazy" className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100" /> : <FileVideo2 className="absolute inset-0 m-auto h-7 w-7 text-zinc-700" />}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/10"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/75 text-white shadow-xl"><Play className="ml-0.5 h-4 w-4 fill-current" /></span></span>
                        <span className="absolute bottom-1 right-1 rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-white">{fmtClock(manifestClipDuration(clip))}</span>
                      </button>
                      <div className="min-w-0">
                        <div className="flex items-start gap-2">
                          <h3 className="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-snug text-zinc-100">{clip.game ?? `Clip ${clip.candidateId}`}</h3>
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); toggleSelected(clip.packageAssetId); }}
                            className={`shrink-0 rounded text-zinc-500 hover:text-emerald-300 ${selected ? "text-emerald-400" : ""}`}
                            aria-label={`${selected ? "Remove" : "Add"} ${clip.game ?? `clip ${clip.candidateId}`} ${selected ? "from" : "to"} selection`}
                          >
                            {selected ? <SquareCheckBig className="h-5 w-5 fill-emerald-500/20" /> : <Square className="h-5 w-5" />}
                          </button>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-zinc-500">{clipType(clip)}</p>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); adjustClip(clip, clip.editedVersion ?? undefined); }}
                            disabled={createStudioHandoff.isPending}
                            className="inline-flex min-h-8 items-center gap-1 rounded-md border border-zinc-700 px-2 text-[11px] font-medium text-zinc-300 hover:border-brand-500/50 hover:bg-brand-500/[0.06] hover:text-brand-200 disabled:cursor-wait disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                            aria-label={`Adjust in and out points for ${clip.game ?? `clip ${clip.candidateId}`}`}
                          >
                            <SlidersHorizontal className="h-3 w-3" /> Adjust
                          </button>
                          {clip.downloadUrl && (
                            <a onClick={(event) => event.stopPropagation()} href={downloadHref(clip.downloadUrl)} download className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-zinc-300 hover:text-emerald-300">
                              <Download className="h-3.5 w-3.5" /> Download clip
                            </a>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                }) : mediaLane === "soundbites" && !soundbiteClips.length ? (
                  <div className="flex h-48 flex-col items-center justify-center gap-3 px-6 text-center">
                    <MessageSquareText className="h-7 w-7 text-sky-400/70" />
                    <div>
                      <p className="text-xs font-semibold text-zinc-300">No broadcast video sound bites prepared yet</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">Scan the captions already collected from these games, then render the strongest player stories and analysis as full MP4 video clips.</p>
                    </div>
                    <button
                      type="button"
                      onClick={prepareSoundbites}
                      disabled={queueSoundbites.isPending || data.soundbites.activeCount > 0 || !data.soundbites.available}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-[11px] font-semibold text-white hover:bg-sky-500 disabled:opacity-45"
                    >
                      {(queueSoundbites.isPending || data.soundbites.activeCount > 0) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {data.soundbites.activeCount > 0 ? `Preparing MP4s · ${data.soundbites.activeProgress}%` : "Prepare video clips"}
                    </button>
                  </div>
                ) : (
                  <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-xs text-zinc-600">
                    <Search className="h-6 w-6" /> No finished clips match these filters.
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </main>

      <footer className="relative z-30 shrink-0 border-t border-zinc-800 bg-[#0d0f12] px-4 py-3 shadow-[0_-16px_40px_rgba(0,0,0,0.35)] sm:px-6">
        {sessionHistory.length > 0 && (
          <div className="mx-auto mb-2 max-w-[1900px]">
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              aria-expanded={historyOpen}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-200"
            >
              <History className="h-3.5 w-3.5" />
              Exports this session ({sessionHistory.length})
              <ChevronDown className={`h-3 w-3 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
            </button>
            {historyOpen && (
              <ul className="mt-1 space-y-1" aria-label="Exports finished this session">
                {sessionHistory.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{entry.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-600">{new Date(entry.finishedAt).toLocaleTimeString()}</span>
                    {entry.fileCount === 1 && (
                      <button type="button" onClick={() => openOutput.mutate({ id: entry.id, target: "file" })} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800">
                        <Play className="h-3 w-3" /> Open file
                      </button>
                    )}
                    <button type="button" onClick={() => openOutput.mutate({ id: entry.id, target: "folder" })} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800">
                      <FolderOpen className="h-3 w-3" /> Open folder
                    </button>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(entry.outputPaths.join("\n"))}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
                      title={entry.outputPaths.join("\n")}
                    >
                      Copy path{entry.fileCount > 1 ? "s" : ""}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {currentExport && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-zinc-800">
            <div className={`h-full bg-emerald-500 transition-[width] duration-300 ${exportActive ? "" : currentExport.status === "failed" ? "bg-red-500" : ""}`} style={{ width: `${Math.max(1, currentExport.progress)}%` }} />
          </div>
        )}
        <div className="mx-auto flex max-w-[1900px] flex-wrap items-center gap-3">
          <button
            onClick={() => setSelectedAssetIds((current) => allSelected
              ? current.filter((id) => !laneClips.some((clip) => clip.packageAssetId === id))
              : [...new Set([...current, ...laneClips.map((clip) => clip.packageAssetId)])])}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
            title={allSelected ? "Clear this category" : "Select this category"}
            aria-label={allSelected ? "Clear this category" : "Select this category"}
          >
            {allSelected ? <SquareCheckBig className="h-5 w-5 text-emerald-400" /> : <Check className="h-5 w-5" />}
          </button>
          <div className="min-w-[220px]">
            <div className="flex items-baseline gap-2">
              <strong className="text-sm text-zinc-100">{selectedAssetIds.length} selected</strong>
              <span className="text-zinc-700">·</span>
              <span className="font-mono text-xs text-zinc-400">{fmtClock(selectedDuration)} total</span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-600">Download separate MP4 files or combine them into one MP4.</p>
          </div>
          <div className="min-w-[280px] flex-1 border-l border-zinc-800 pl-4">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Output to</p>
            <button
              onClick={() => chooseOutput.mutate()}
              disabled={chooseOutput.isPending || exportActive}
              className="flex max-w-xl items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-left text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-50"
            >
              {chooseOutput.isPending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Folder className="h-4 w-4 shrink-0" />}
              <span className="truncate">{outputDir || "Choose output folder"}</span>
              <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
          {exportActive ? (
            <div className="flex min-w-[330px] items-center justify-end gap-3">
              <div className="text-right">
                <p className="text-xs font-medium text-zinc-200">{currentExport?.stage ?? "Preparing export"}</p>
                <p className="mt-0.5 text-[11px] text-emerald-400">{Math.round(currentExport?.progress ?? 0)}%</p>
              </div>
              <button onClick={() => exportId && cancelExport.mutate({ id: exportId })} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:border-brand-500/50 hover:text-brand-300">
                <X className="h-3.5 w-3.5" /> Cancel
              </button>
            </div>
          ) : currentExport?.status === "ready" ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400"><CheckCircle2 className="h-4 w-4" /> {currentExport.stage}</span>
              {currentExport.outputPaths.length === 1 && <button onClick={() => exportId && openOutput.mutate({ id: exportId, target: "file" })} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"><Play className="h-3.5 w-3.5" /> Open file</button>}
              <button onClick={() => exportId && openOutput.mutate({ id: exportId, target: "folder" })} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"><FolderOpen className="h-3.5 w-3.5" /> Open folder</button>
              <button onClick={() => setExportId(null)} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Dismiss export result"><X className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="ml-auto flex items-center gap-2">
              {!outputDir && selectedAssetIds.length > 0 && (
                <p className="max-w-[240px] text-[11px] leading-snug text-amber-300/90">Choose an output folder below to enable exports.</p>
              )}
              <button
                disabled={!selectedAssetIds.length || queueExport.isPending || !outputDir}
                onClick={() => startExport("separate")}
                title={!selectedAssetIds.length ? "Select clips to export" : !outputDir ? "Choose an output folder first" : "Save each selected clip as its own MP4"}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-zinc-700 px-4 text-sm font-semibold text-zinc-100 hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {queueExport.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download selected
              </button>
              <button
                disabled={!selectedAssetIds.length || queueExport.isPending || !outputDir}
                onClick={() => startExport("joined")}
                title={!selectedAssetIds.length ? "Select clips to combine" : !outputDir ? "Choose an output folder first" : "Combine all selected clips into one MP4"}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white shadow-lg shadow-emerald-950/30 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {queueExport.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Combine selected
              </button>
            </div>
          )}
        </div>
        {(queueExport.isError || currentExport?.status === "failed") && (
          <div className="mx-auto mt-2 flex max-w-[1900px] items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
            <CircleAlert className="h-4 w-4 shrink-0" /> {queueExport.error?.message ?? currentExport?.error ?? "The package export failed."}
          </div>
        )}
      </footer>
    </>
  );
}
