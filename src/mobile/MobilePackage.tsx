import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  CheckSquare2,
  CircleAlert,
  CloudCheck,
  Download,
  FileVideo2,
  Loader2,
  Play,
  Search,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { trpc } from "@/providers/trpc";
import { isPaymentRequired, openProDialog } from "@/lib/license";
import {
  clipThumbnailSource,
  manifestClipDuration,
  type ManifestClip,
} from "@/lib/assemble";
import { downloadHref, fmtDuration, mobileClipFileName } from "./mobileUtils";

type MobileClip = ManifestClip & {
  previewUrl: string;
  packageAssetId: string;
  editedVersion?: {
    id: string;
    previewUrl: string | null;
    downloadUrl: string | null;
    editIn: number;
    editOut: number;
  } | null;
};

export default function MobilePackage() {
  const navigate = useNavigate();
  const projectId = Number(useParams().projectId);
  const query = trpc.clipPackage.open.useQuery(
    { projectId },
    {
      enabled: Number.isSafeInteger(projectId) && projectId > 0,
      refetchInterval: 5000,
    }
  );
  const handoff = trpc.clipPackage.createStudioHandoff.useMutation();
  const seedDraft = trpc.clipPackage.saveStudioHandoffDraft.useMutation();
  const queue = trpc.clipPackage.queueExport.useMutation({
    onSuccess: job => setExportId(job.id),
    onError: error => { if (isPaymentRequired(error)) openProDialog("Package export"); },
  });
  const [lane, setLane] = useState<"plays" | "soundbites" | "copies" | "all">(
    "plays"
  );
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [playRequest, setPlayRequest] = useState(0);
  const [sharingAssetId, setSharingAssetId] = useState<string | null>(null);
  const [preparedShare, setPreparedShare] = useState<{
    assetId: string;
    file: File;
  } | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const exportQuery = trpc.clipPackage.exportJob.useQuery(
    { id: exportId! },
    {
      enabled: Boolean(exportId),
      refetchInterval: q =>
        ["ready", "failed", "cancelled"].includes(q.state.data?.status ?? "")
          ? false
          : 500,
    }
  );
  const exportDownloadUrls = exportQuery.data?.downloadUrls ?? [];
  const videoRef = useRef<HTMLVideoElement>(null);
  const data = query.data;
  const originals = (data?.clips ?? []) as MobileClip[];
  const copies = (data?.savedCopies ?? []) as MobileClip[];
  const all = [...originals, ...copies];
  const laneItems =
    lane === "plays"
      ? originals.filter(c => c.selectionKind !== "broadcast_soundbite")
      : lane === "soundbites"
        ? originals.filter(c => c.selectionKind === "broadcast_soundbite")
        : lane === "copies"
          ? copies
          : all;
  const clips = useMemo(
    () =>
      laneItems.filter(
        c =>
          !search.trim() ||
          [c.game, c.beatText, c.transcript.text].some(v =>
            v?.toLowerCase().includes(search.trim().toLowerCase())
          )
      ),
    [laneItems, search]
  );
  const active =
    all.find(clip => clip.packageAssetId === activeId) ?? clips[0] ?? null;
  const mediaUrl =
    active?.editedVersion?.previewUrl ?? active?.previewUrl ?? null;
  useEffect(() => {
    if (!playRequest || !mediaUrl) return;
    const frame = window.requestAnimationFrame(() => {
      void videoRef.current?.play();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mediaUrl, playRequest]);
  const toggle = (id: string) =>
    setSelected(current =>
      current.includes(id)
        ? current.filter(value => value !== id)
        : [...current, id]
    );
  const adjust = async (clip: MobileClip) => {
    try {
      const opened = await handoff.mutateAsync({
        projectId,
        candidateId: clip.candidateId,
        intent: "new_version",
      });
      const seedIn = clip.sourceStartSeconds;
      const seedOut = clip.sourceEndSeconds;
      if (
        seedIn != null &&
        seedOut != null &&
        seedOut > seedIn &&
        (seedIn !== opened.suggestedIn || seedOut !== opened.suggestedOut)
      ) {
        await seedDraft.mutateAsync({
          handoffId: opened.handoffId,
          editIn: seedIn,
          editOut: seedOut,
          expectedEditIn: opened.suggestedIn,
          expectedEditOut: opened.suggestedOut,
          expectedIntent: opened.intent,
        });
      }
      navigate(`/m/review?handoff=${encodeURIComponent(opened.handoffId)}`);
    } catch {
      /* errors render below */
    }
  };
  const exportSelected = (mode: "separate" | "joined") =>
    queue.mutate({
      projectId,
      mode,
      assetIds: selected,
      title: data?.projectName,
    });

  const openPhotosShareSheet = async (file: File) => {
    const shareData: ShareData = {
      files: [file],
      title: "Cut IQ clip",
    };
    if (
      typeof navigator.share !== "function" ||
      (typeof navigator.canShare === "function" && !navigator.canShare(shareData))
    ) {
      throw new Error("This browser cannot share video files. Open the clip, tap Share, then Save Video.");
    }
    setShareMessage("In the share sheet, tap Save Video.");
    await navigator.share(shareData);
    setPreparedShare(null);
    setShareMessage("Clip shared. Choose Save Video to place it in Photos.");
  };

  const saveClipToPhotos = async (clip: MobileClip) => {
    // Share the exact clip through its browser-compatible H.264/AAC preview.
    // This avoids handing Apple Photos either the full broadcast or a source
    // codec that iOS may not accept, while leaving the original pipeline output
    // untouched on the PC and Drive.
    const sourceUrl = clip.editedVersion?.previewUrl ?? clip.previewUrl;
    if (!sourceUrl || sharingAssetId) return;
    if (preparedShare?.assetId === clip.packageAssetId) {
      setShareError(null);
      try {
        await openPhotosShareSheet(preparedShare.file);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setShareMessage("Clip ready. Tap again when you want the Photos share sheet.");
        } else {
          setShareError(error instanceof Error ? error.message : "The clip could not be shared.");
          setShareMessage(null);
        }
      }
      return;
    }
    setSharingAssetId(clip.packageAssetId);
    setShareMessage(
      `Preparing the ${fmtDuration(manifestClipDuration(clip))} clip for Apple Photos…`
    );
    setShareError(null);
    try {
      const response = await fetch(downloadHref(sourceUrl));
      if (!response.ok) throw new Error(`Clip download failed (${response.status}).`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Cut IQ returned an empty clip file.");
      const file = new File(
        [blob],
        mobileClipFileName(clip.game, clip.candidateId),
        { type: "video/mp4" }
      );
      setPreparedShare({ assetId: clip.packageAssetId, file });
      await openPhotosShareSheet(file);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareMessage("Clip ready. Tap again when you want the Photos share sheet.");
      } else if (error instanceof DOMException && error.name === "NotAllowedError") {
        setShareMessage("Clip ready. Tap Open Photos share sheet.");
      } else {
        setShareError(error instanceof Error ? error.message : "The clip could not be shared.");
        setShareMessage(null);
      }
    } finally {
      setSharingAssetId(null);
    }
  };
  if (query.isLoading)
    return (
      <div className="flex min-h-64 items-center justify-center text-zinc-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading clips
      </div>
    );
  if (query.isError || !data)
    return (
      <div
        role="alert"
        className="rounded-2xl border border-brand-500/25 bg-brand-500/10 p-4 text-sm text-brand-200"
      >
        <CircleAlert className="mb-2 h-5 w-5" />
        {query.error?.message ?? "This package is unavailable."}
        <button
          onClick={() => query.refetch()}
          className="mt-4 min-h-11 w-full rounded-xl border border-brand-400/30"
        >
          Retry
        </button>
      </div>
    );
  return (
    <section className="pb-28">
      <Link
        to="/m/packages"
        className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400"
      >
        <ArrowLeft className="h-4 w-4" />
        Packages
      </Link>
      <h1 className="text-xl font-semibold leading-tight">
        {data.projectName}
      </h1>
      <div className="mt-2 flex items-center gap-2 text-xs text-emerald-300">
        <CloudCheck className="h-4 w-4" />
        {data.driveSync?.available
          ? `${data.driveSync.syncedClipCount} clips synced to My Drive`
          : "Finished MP4s are safe on the Cut IQ PC"}
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-800 bg-black">
        <video
          key={mediaUrl ?? "none"}
          ref={videoRef}
          src={mediaUrl ?? undefined}
          poster={
            active ? (clipThumbnailSource(active) ?? undefined) : undefined
          }
          controls
          playsInline
          preload="metadata"
          className="aspect-video w-full object-contain"
        />
      </div>
      {active && (
        <div className="mt-3 rounded-xl border border-white/10 bg-[#0e1013] p-3">
          <h2 className="text-sm font-semibold">
            {active.game ?? `Clip ${active.candidateId}`}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            {fmtDuration(manifestClipDuration(active))} ·{" "}
            {active.selectionKind === "broadcast_soundbite"
              ? "Video sound bite"
              : "Player play"}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => void adjust(active)}
              disabled={handoff.isPending || seedDraft.isPending}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-500/35 text-sm font-semibold text-brand-200"
            >
              {handoff.isPending || seedDraft.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SlidersHorizontal className="h-4 w-4" />
              )}
              Adjust IN/OUT
            </button>
            {(active.editedVersion?.downloadUrl ?? active.downloadUrl) && (
              <button
                type="button"
                onClick={() => void saveClipToPhotos(active)}
                disabled={Boolean(sharingAssetId)}
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 text-sm font-semibold"
              >
                {sharingAssetId === active.packageAssetId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {sharingAssetId === active.packageAssetId
                  ? "Preparing clip…"
                  : preparedShare?.assetId === active.packageAssetId
                    ? "Open Photos share sheet"
                    : `Save ${fmtDuration(manifestClipDuration(active))} clip to Photos`}
              </button>
            )}
          </div>
          {shareMessage && (
            <p role="status" className="mt-3 text-xs text-emerald-300">
              {shareMessage}
            </p>
          )}
          {shareError && (
            <p role="alert" className="mt-3 text-xs text-red-300">
              {shareError}
            </p>
          )}
        </div>
      )}
      <div
        className="mt-5 flex gap-2 overflow-x-auto pb-1"
        aria-label="Clip category"
      >
        {(
          [
            [
              "plays",
              "Plays",
              originals.filter(c => c.selectionKind !== "broadcast_soundbite")
                .length,
            ],
            [
              "soundbites",
              "Sound bites",
              originals.filter(c => c.selectionKind === "broadcast_soundbite")
                .length,
            ],
            ["copies", "Copies", copies.length],
            ["all", "All", all.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setLane(key)}
            className={`min-h-11 shrink-0 rounded-xl border px-4 text-sm font-semibold ${lane === key ? "border-zinc-600 bg-zinc-800 text-white" : "border-zinc-800 text-zinc-500"}`}
            aria-pressed={lane === key}
          >
            {label} <span className="ml-1 font-mono text-xs">{count}</span>
          </button>
        ))}
      </div>
      <label className="relative mt-3 block">
        <Search className="absolute left-3 top-3.5 h-4 w-4 text-zinc-600" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search titles or transcript…"
          className="min-h-12 w-full rounded-xl border border-zinc-700 bg-zinc-900 pl-10 pr-3 text-base outline-none focus:border-brand-500"
        />
      </label>
      <div className="mt-3 space-y-3">
        {clips.length ? (
          clips.map(clip => {
            const chosen = selected.includes(clip.packageAssetId);
            return (
              <article
                key={clip.packageAssetId}
                className={`rounded-2xl border p-3 ${chosen ? "border-emerald-500/60 bg-emerald-500/[0.06]" : "border-zinc-800 bg-[#0e1013]"}`}
              >
                <button
                  onClick={() => {
                    setActiveId(clip.packageAssetId);
                    setPlayRequest(value => value + 1);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  className="block w-full text-left"
                >
                  <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
                    {clipThumbnailSource(clip) ? (
                      <img
                        src={clipThumbnailSource(clip)!}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <FileVideo2 className="absolute inset-0 m-auto h-8 w-8 text-zinc-700" />
                    )}
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/75">
                        <Play className="ml-0.5 h-5 w-5 fill-current" />
                      </span>
                    </span>
                    <span className="absolute bottom-2 right-2 rounded bg-black/85 px-2 py-1 font-mono text-xs">
                      {fmtDuration(manifestClipDuration(clip))}
                    </span>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold leading-snug">
                    {clip.game ?? `Clip ${clip.candidateId}`}
                  </h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    {clip.selectionKind === "broadcast_soundbite"
                      ? "Video sound bite"
                      : "Player play"}
                  </p>
                </button>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button
                    onClick={() => {
                      setActiveId(clip.packageAssetId);
                      setPlayRequest(value => value + 1);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-zinc-700 text-xs font-semibold"
                  >
                    <Play className="h-4 w-4" />
                    Play
                  </button>
                  <button
                    onClick={() => void adjust(clip)}
                    className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-zinc-700 text-xs font-semibold"
                  >
                    <SlidersHorizontal className="h-4 w-4" />
                    Adjust
                  </button>
                  <button
                    onClick={() => toggle(clip.packageAssetId)}
                    className={`flex min-h-11 items-center justify-center gap-1 rounded-xl border text-xs font-semibold ${chosen ? "border-emerald-500/50 text-emerald-300" : "border-zinc-700"}`}
                  >
                    {chosen ? (
                      <CheckSquare2 className="h-4 w-4" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                    {chosen ? "Selected" : "Select"}
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-700 p-8 text-center text-sm text-zinc-500">
            No finished clips match this view.
          </div>
        )}
      </div>
      {(handoff.isError ||
        seedDraft.isError ||
        queue.isError ||
        exportQuery.isError) && (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-brand-500/25 bg-brand-500/10 p-3 text-sm text-brand-200"
        >
          {handoff.error?.message ??
            seedDraft.error?.message ??
            queue.error?.message ??
            exportQuery.error?.message}
        </div>
      )}
      {exportQuery.data && (
        <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3 text-sm">
          <div className="flex justify-between">
            <span>{exportQuery.data.stage}</span>
            <span className="font-mono text-emerald-300">
              {Math.round(exportQuery.data.progress)}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${exportQuery.data.progress}%` }}
            />
          </div>
          {exportQuery.data.status === "ready" && exportDownloadUrls.length > 0 && (
              <div className="mt-3 grid gap-2">
                {exportDownloadUrls.map((url, index) => (
                  <a
                    key={url}
                    href={url}
                    download
                    className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 font-bold text-white"
                  >
                    <Download className="h-4 w-4" />
                    {exportDownloadUrls.length === 1
                      ? "Download MP4 to phone"
                      : `Download MP4 ${index + 1}`}
                  </a>
                ))}
              </div>
            )}
        </div>
      )}
      {selected.length > 0 && (
        <div className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#0b0c0f]/97 px-4 pt-3 backdrop-blur">
          <div className="mx-auto max-w-lg">
            <p className="mb-2 text-center text-xs text-zinc-400">
              {selected.length} selected
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => exportSelected("separate")}
                disabled={queue.isPending}
                className="min-h-12 rounded-xl border border-zinc-700 text-sm font-bold"
              >
                Save separately
              </button>
              <button
                onClick={() => exportSelected("joined")}
                disabled={queue.isPending}
                className="min-h-12 rounded-xl bg-emerald-600 text-sm font-bold"
              >
                Combine MP4
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
