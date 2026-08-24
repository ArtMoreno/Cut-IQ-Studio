import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Edit3,
  Lock,
  LockOpen,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { fmtTime } from "@/lib/youtube";
import { findSegmentIndexAtTime } from "@/lib/transcriptStudio";

export interface StudioTranscriptSegment {
  id: number | string;
  idx: number;
  text: string;
  start: number;
  end: number;
}

export interface StudioTranscriptEdit {
  segmentIdx: number;
  originalText: string;
  displayText: string;
}

interface Props {
  segments: readonly StudioTranscriptSegment[];
  edits: Record<number, StudioTranscriptEdit>;
  currentTime: number;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchFocusRequest?: number;
  onSeek: (seconds: number) => void;
  onSaveSegment: (segment: StudioTranscriptSegment, displayText: string) => void;
  onResetSegment: (segment: StudioTranscriptSegment) => void;
  selection?: { inSec: number; outSec: number } | null;
  originalSelection?: { inSec: number; outSec: number } | null;
}

const ROW_HEIGHT = 68;
const OVERSCAN = 8;

function normalizedText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMatches(text: string, query: string) {
  const raw = query.trim();
  if (!raw) return false;
  const phrase = raw.match(/^"(.+)"$/);
  const haystack = normalizedText(text);
  if (phrase) return haystack.includes(normalizedText(phrase[1]));
  return normalizedText(raw)
    .split(" ")
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function ClickableText({
  text,
  highlighted,
}: {
  text: string;
  highlighted: boolean;
}) {
  if (!text) {
    return <span className="italic text-zinc-600">[Segment text removed]</span>;
  }

  return (
    <p
      className={`line-clamp-1 w-full rounded px-0.5 text-left ${
        highlighted
          ? "bg-amber-300/90 text-zinc-950"
          : "text-zinc-300"
      }`}
      title={text}
    >
      {text}
    </p>
  );
}

export function TranscriptStudioReader({
  segments,
  edits,
  currentTime,
  searchQuery,
  onSearchQueryChange,
  searchFocusRequest = 0,
  onSeek,
  onSaveSegment,
  onResetSegment,
  selection = null,
  originalSelection = null,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const programmaticScrollRef = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(620);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [activeResultState, setActiveResultState] = useState({ query: "", index: 0 });
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const displaySegments = useMemo(
    () =>
      segments.map((segment) => ({
        segment,
        displayText: edits[segment.idx]?.displayText ?? segment.text,
        hasEdit: Boolean(edits[segment.idx]),
      })),
    [edits, segments],
  );

  const matchingIndexes = useMemo(() => {
    if (!searchQuery.trim()) return [] as number[];
    return displaySegments.flatMap(({ displayText }, index) =>
      textMatches(displayText, searchQuery) ? [index] : [],
    );
  }, [displaySegments, searchQuery]);
  const activeResult = activeResultState.query === searchQuery
    ? Math.min(activeResultState.index, Math.max(0, matchingIndexes.length - 1))
    : 0;

  const timedSegments = useMemo(
    () =>
      segments.map((segment) => ({
        id: String(segment.id),
        startMs: Math.round(segment.start * 1000),
        endMs: Math.round(segment.end * 1000),
      })),
    [segments],
  );

  const activeSegmentIndex = useMemo(
    () => findSegmentIndexAtTime(timedSegments, Math.round(currentTime * 1000)),
    [currentTime, timedSegments],
  );

  const scrollToIndex = useCallback((index: number, behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport || index < 0) return;
    const targetTop = Math.max(0, index * ROW_HEIGHT - viewport.clientHeight / 2 + ROW_HEIGHT / 2);
    programmaticScrollRef.current = true;
    // Keep the virtual window in lockstep with an imperative seek. Some browser
    // builds do not dispatch the scroll event until after the next paint, which
    // otherwise leaves the viewport scrolled into an unrendered blank region.
    setScrollTop(targetTop);
    viewport.scrollTo({
      top: targetTop,
      behavior,
    });
    window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, behavior === "smooth" ? 350 : 0);
  }, []);

  useEffect(() => {
    if (searchFocusRequest > 0) searchRef.current?.focus();
  }, [searchFocusRequest]);

  useEffect(() => {
    if (followPlayback && !searchQuery && activeSegmentIndex >= 0) {
      scrollToIndex(activeSegmentIndex);
    }
  }, [activeSegmentIndex, followPlayback, scrollToIndex, searchQuery]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewportHeight(viewport.clientHeight));
    observer.observe(viewport);
    setViewportHeight(viewport.clientHeight);
    return () => observer.disconnect();
  }, []);

  const jumpResult = (direction: 1 | -1) => {
    if (!matchingIndexes.length) return;
    const next = (activeResult + direction + matchingIndexes.length) % matchingIndexes.length;
    setActiveResultState({ query: searchQuery, index: next });
    const segmentIndex = matchingIndexes[next];
    scrollToIndex(segmentIndex);
    onSeek(segments[segmentIndex].start);
  };

  const startEditing = (segment: StudioTranscriptSegment, displayText: string) => {
    setEditingIdx(segment.idx);
    setEditValue(displayText);
    setFollowPlayback(false);
  };

  const saveEditing = (segment: StudioTranscriptSegment) => {
    onSaveSegment(segment, editValue);
    setEditingIdx(null);
  };

  const virtualized = displaySegments.length > 50;
  const firstIndex = virtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const lastIndex = virtualized
    ? Math.min(displaySegments.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
    : displaySegments.length;
  const rendered = displaySegments.slice(firstIndex, lastIndex);

  return (
    <section className="flex h-full min-h-0 flex-col bg-zinc-950" aria-label="Transcript editor">
      <div className="space-y-2 border-b border-zinc-800 bg-zinc-950/95 p-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              ref={searchRef}
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jumpResult(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onSearchQueryChange("");
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search edited transcript..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-9 pr-8 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-brand-500 focus:ring-1 focus:ring-brand-500/40"
              aria-label="Search transcript"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchQueryChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                aria-label="Clear transcript search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFollowPlayback((value) => !value)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400 ${
              followPlayback
                ? "border-brand-500/50 bg-brand-500/10 text-brand-300"
                : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
            }`}
            title={followPlayback ? "Following playback" : "Resume following playback"}
          >
            {followPlayback ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
            Follow
          </button>
        </div>

        <div className="flex min-h-5 items-center justify-between gap-3 text-[11px] text-zinc-500">
          <span>
            {searchQuery
              ? `${matchingIndexes.length} ${matchingIndexes.length === 1 ? "result" : "results"}${matchingIndexes.length ? ` - ${activeResult + 1} of ${matchingIndexes.length}` : ""}`
              : `${segments.length.toLocaleString()} timed segments`}
          </span>
          {searchQuery ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => jumpResult(-1)}
                disabled={!matchingIndexes.length}
                className="rounded border border-zinc-700 p-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                aria-label="Previous transcript result"
                title="Previous result (Shift+Enter)"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => jumpResult(1)}
                disabled={!matchingIndexes.length}
                className="rounded border border-zinc-700 p-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                aria-label="Next transcript result"
                title="Next result (Enter)"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <span className="hidden sm:block">Ctrl/Cmd+F to search</span>
          )}
        </div>
      </div>

      {segments.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-zinc-500">
          No transcript is ready for this source yet.
        </div>
      ) : (
        <div
          ref={viewportRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            if (!programmaticScrollRef.current) setFollowPlayback(false);
          }}
          onWheel={() => setFollowPlayback(false)}
          onPointerDown={() => setFollowPlayback(false)}
        >
          <div style={{ height: virtualized ? firstIndex * ROW_HEIGHT : undefined }} />
          {rendered.map(({ segment, displayText, hasEdit }, offset) => {
            const index = firstIndex + offset;
            const isActive = index === activeSegmentIndex;
            const isMatch = matchingIndexes.includes(index);
            const isActiveResult = searchQuery.length > 0 && matchingIndexes[activeResult] === index;
            const overlapsSelection =
              selection != null && segment.end >= selection.inSec && segment.start <= selection.outSec;
            const overlapsOriginalSelection =
              originalSelection != null && segment.end >= originalSelection.inSec && segment.start <= originalSelection.outSec;
            const isEditing = editingIdx === segment.idx;

            return (
              <article
                key={segment.id}
                data-studio-segment={segment.idx}
                style={{ height: ROW_HEIGHT }}
                className={`group relative overflow-hidden rounded-lg border px-3 py-2 transition ${
                  isActiveResult
                    ? "border-amber-400/70 bg-amber-400/10"
                    : isActive
                      ? "border-brand-500/50 bg-brand-500/10"
                      : overlapsSelection
                        ? "border-brand-900/50 bg-brand-950/20"
                        : overlapsOriginalSelection
                          ? "border-amber-500/40 border-dashed bg-amber-500/[0.04]"
                        : "border-transparent hover:border-zinc-800 hover:bg-zinc-900/70"
                }`}
              >
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => onSeek(segment.start)}
                    className={`mt-0.5 shrink-0 font-mono text-xs outline-none hover:text-brand-300 focus-visible:ring-1 focus-visible:ring-brand-400 ${
                      isActive || isActiveResult ? "text-brand-300" : "text-zinc-500"
                    }`}
                    title="Seek to segment"
                  >
                    {fmtTime(segment.start)}
                  </button>
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <textarea
                        autoFocus
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            saveEditing(segment);
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingIdx(null);
                          }
                        }}
                        rows={1}
                        className="h-8 w-full resize-none rounded border border-brand-500/60 bg-zinc-950 px-2 py-1 text-sm leading-relaxed text-zinc-100 outline-none focus:ring-1 focus:ring-brand-400"
                        aria-label={`Edit transcript segment at ${fmtTime(segment.start)}`}
                      />
                    ) : (
                      <div
                        className={`w-full text-left text-sm leading-relaxed ${
                          isActive ? "text-zinc-100" : "text-zinc-300"
                        }`}
                      >
                        <ClickableText
                          text={displayText}
                          highlighted={isMatch}
                        />
                      </div>
                    )}
                    <p className="mt-1 text-[10px] text-zinc-600">
                      {hasEdit ? "Edited text - original timing preserved" : "Approximate segment timing"}
                    </p>
                  </div>
                  <div className="flex h-7 shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => saveEditing(segment)}
                          className="rounded bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-300"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingIdx(null)}
                          className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEditing(segment, displayText)}
                          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                          aria-label={`Edit segment at ${fmtTime(segment.start)}`}
                          title="Edit segment"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        {hasEdit && (
                          <button
                            type="button"
                            onClick={() => onResetSegment(segment)}
                            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
                            aria-label={`Reset segment at ${fmtTime(segment.start)} to original`}
                            title="Reset segment to original"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
          <div style={{ height: virtualized ? (displaySegments.length - lastIndex) * ROW_HEIGHT : undefined }} />
        </div>
      )}
    </section>
  );
}
