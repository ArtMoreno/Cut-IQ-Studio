import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { PlayerHandle } from "@/components/Player";
import { fmtTime } from "@/lib/youtube";

interface Props {
  src: string;
  title?: string;
  startAt?: number;
  previewRange?: { inSec: number; outSec: number } | null;
  previewLoop?: boolean;
  onPreviewEnd?: () => void;
  onTime: (seconds: number) => void;
  onDuration?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

export const StudioMediaPlayer = forwardRef<PlayerHandle, Props>(function StudioMediaPlayer(
  { src, title, startAt = 0, previewRange, previewLoop = false, onPreviewEnd, onTime, onDuration, onPlayingChange },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(startAt);
  const [duration, setDuration] = useState(0);

  useImperativeHandle(ref, () => ({
    seekTo(seconds, autoplay = true) {
      const media = videoRef.current;
      if (!media) return;
      media.currentTime = Math.max(0, Math.min(seconds, media.duration || seconds));
      if (autoplay) void media.play();
    },
    stepBy(seconds, autoplay = true) {
      const media = videoRef.current;
      if (!media) return;
      media.currentTime = Math.max(0, Math.min(media.currentTime + seconds, media.duration || media.currentTime + seconds));
      if (autoplay) void media.play();
    },
    getTime: () => videoRef.current?.currentTime ?? null,
    play: () => { void videoRef.current?.play(); },
    pause: () => videoRef.current?.pause(),
  }), []);

  useEffect(() => {
    const media = videoRef.current;
    if (!media) return;
    media.currentTime = startAt;
  }, [src, startAt]);

  return (
    <div className="group relative aspect-video w-full overflow-hidden rounded-[10px] bg-black shadow-2xl shadow-black/30">
      <video
        ref={videoRef}
        src={src}
        aria-label={title ? `Local video: ${title}` : "Local video"}
        className="h-full w-full object-contain"
        playsInline
        onLoadedMetadata={(event) => {
          const nextDuration = event.currentTarget.duration || 0;
          setDuration(nextDuration);
          onDuration?.(nextDuration);
        }}
        onTimeUpdate={(event) => {
          const nextTime = event.currentTarget.currentTime;
          setCurrentTime(nextTime);
          onTime(nextTime);
          if (previewRange && nextTime >= previewRange.outSec) {
            if (previewLoop) {
              event.currentTarget.currentTime = previewRange.inSec;
              void event.currentTarget.play();
            } else {
              event.currentTarget.pause();
              onPreviewEnd?.();
            }
          }
        }}
        onPlay={() => { setPlaying(true); onPlayingChange?.(true); }}
        onPause={() => { setPlaying(false); onPlayingChange?.(false); }}
      />
      <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg bg-black/80 px-3 py-2 opacity-100 backdrop-blur transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => playing ? videoRef.current?.pause() : void videoRef.current?.play()}
          className="rounded-md p-1 text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label={playing ? "Pause local video" : "Play local video"}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="w-24 font-mono text-[11px] text-zinc-200">{fmtTime(currentTime)} / {fmtTime(duration)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={0.05}
          value={Math.min(currentTime, Math.max(1, duration))}
          onChange={(event) => {
            if (videoRef.current) videoRef.current.currentTime = Number(event.target.value);
          }}
          className="h-1 min-w-20 flex-1 accent-brand-500"
          aria-label="Local video timeline"
        />
        <button
          type="button"
          onClick={() => {
            const next = !muted;
            setMuted(next);
            if (videoRef.current) videoRef.current.muted = next;
          }}
          className="rounded-md p-1 text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label={muted ? "Unmute local video" : "Mute local video"}
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
});
