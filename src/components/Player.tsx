import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { loadYouTubeAPI, fmtTime } from "@/lib/youtube";
import { reconcilePlayerClock, type PendingPlayerSeek } from "@/lib/playerClock";
import { Play, Pause, AlertTriangle, ExternalLink } from "lucide-react";

export interface PlayerHandle {
  seekTo: (sec: number, autoplay?: boolean) => void;
  stepBy: (seconds: number, autoplay?: boolean) => void;
  getTime: () => number | null;
  play: () => void;
  pause: () => void;
}

interface Props {
  videoId: string;
  startAt?: number;
  onTime: (t: number) => void;
  onDuration?: (d: number) => void;
  previewRange?: { inSec: number; outSec: number } | null;
  previewLoop?: boolean;
  onPreviewEnd?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  /**
   * Gives the parent page reliable keyboard focus instead of allowing the
   * cross-origin YouTube iframe to swallow editor shortcuts.
   */
  editorMode?: boolean;
  /** Use the wide, compact package-review frame so transport controls remain visible above the timeline. */
  compact?: boolean;
}

export const Player = forwardRef<PlayerHandle, Props>(function Player(
  { videoId, startAt = 0, onTime, onDuration, previewRange, previewLoop = false, onPreviewEnd, onPlayingChange, editorMode = false, compact = false },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const pendingSeekRef = useRef<PendingPlayerSeek | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const previewRef = useRef(previewRange);
  previewRef.current = previewRange;
  const onPreviewEndRef = useRef(onPreviewEnd);
  onPreviewEndRef.current = onPreviewEnd;
  const previewLoopRef = useRef(previewLoop);
  previewLoopRef.current = previewLoop;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;

  const issueSeek = useCallback((sec: number, autoplay = true) => {
      const p = playerRef.current;
      const target = Math.max(0, sec);
      pendingSeekRef.current = { targetSeconds: target, expiresAtMs: performance.now() + 2_500 };
      setCur(target);
      onTimeRef.current(target);
      if (readyRef.current && typeof p?.seekTo === "function") {
        p.seekTo(target, true);
        if (autoplay) p.playVideo?.();
      }
  }, []);

  useImperativeHandle(ref, () => ({
      seekTo: issueSeek,
      stepBy: (seconds: number, autoplay = true) => {
        const p = playerRef.current;
        if (!p) return;
        const base = pendingSeekRef.current?.targetSeconds ?? p.getCurrentTime?.() ?? 0;
        issueSeek(base + seconds, autoplay);
      },
    getTime: () => {
      if (!readyRef.current) return null;
      const value = playerRef.current?.getCurrentTime?.();
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const reconciled = reconcilePlayerClock(value, pendingSeekRef.current, performance.now());
      pendingSeekRef.current = reconciled.pending;
      return reconciled.seconds;
    },
    play: () => playerRef.current?.playVideo?.(),
    pause: () => playerRef.current?.pauseVideo?.(),
  }), [issueSeek]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setFailed(false);
    readyRef.current = false;
    pendingSeekRef.current = null;
    loadYouTubeAPI().then((YT) => {
      if (cancelled || !mountRef.current) return;
      playerRef.current?.destroy?.();
      const el = document.createElement("div");
      mountRef.current.innerHTML = "";
      mountRef.current.appendChild(el);
      try {
        playerRef.current = new YT.Player(el, {
          videoId,
          playerVars: {
            start: Math.floor(startAt),
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            controls: editorMode ? 0 : 1,
            disablekb: editorMode ? 1 : 0,
          },
          events: {
            onReady: (e: any) => {
              readyRef.current = true;
              const queuedTarget = pendingSeekRef.current?.targetSeconds;
              if (typeof queuedTarget === "number") {
                pendingSeekRef.current = { targetSeconds: queuedTarget, expiresAtMs: performance.now() + 2_500 };
                e.target.seekTo?.(queuedTarget, true);
                e.target.playVideo?.();
              }
              onDuration?.(e.target.getDuration?.() ?? 0);
              timer = window.setInterval(() => {
                const rawTime = playerRef.current?.getCurrentTime?.() ?? 0;
                const reconciled = reconcilePlayerClock(rawTime, pendingSeekRef.current, performance.now());
                pendingSeekRef.current = reconciled.pending;
                const t = reconciled.seconds;
                setCur(t);
                onTimeRef.current(t);
                const pr = previewRef.current;
                if (pr && t >= pr.outSec) {
                  if (previewLoopRef.current) {
                    playerRef.current?.seekTo?.(pr.inSec, true);
                    playerRef.current?.playVideo?.();
                  } else {
                    playerRef.current?.pauseVideo?.();
                    onPreviewEndRef.current?.();
                  }
                }
              }, 250);
            },
            onStateChange: (e: any) => {
              const nextPlaying = e.data === 1;
              setPlaying(nextPlaying);
              onPlayingChangeRef.current?.(nextPlaying);
            },
            onError: () => setFailed(true),
          },
        });
      } catch {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      playerRef.current?.destroy?.();
      playerRef.current = null;
      readyRef.current = false;
      pendingSeekRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorMode, videoId]);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo?.();
    else p.playVideo?.();
  }, [playing]);

  if (failed) {
    return (
      <div className={`flex w-full flex-col items-center justify-center gap-3 rounded-xl bg-zinc-900 text-center ${compact ? "aspect-[2.5/1]" : "aspect-video"}`}>
        <AlertTriangle className="h-8 w-8 text-amber-400" />
        <p className="max-w-sm text-sm text-zinc-300">
          The embedded player couldn't load this video (it may be embed-restricted). The transcript below still works.
        </p>
        <a
          href={`https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(cur)}s`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
        >
          Open on YouTube at {fmtTime(cur)} <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div data-testid="youtube-player-instance" className={`group relative w-full overflow-hidden rounded-xl bg-black ${compact ? "aspect-[2.5/1]" : "aspect-video"}`}>
      <div ref={mountRef} className={`absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full ${editorMode ? "pointer-events-none" : ""}`} />
      {editorMode ? (
        <button
          type="button"
          onClick={toggle}
          className="absolute inset-0 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
          aria-label={`${playing ? "Pause" : "Play"} video. Editor keyboard shortcuts stay active.`}
          title="Click to play or pause. J/K/L, I/O, and Space stay active."
        >
          {!playing && (
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/70 text-white shadow-xl backdrop-blur transition hover:scale-105 hover:bg-brand-600/90">
              <Play className="ml-0.5 h-6 w-6" />
            </span>
          )}
          <span className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-sm font-medium text-white backdrop-blur">
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {fmtTime(cur)}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-sm font-medium text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {fmtTime(cur)}
        </button>
      )}
    </div>
  );
});
