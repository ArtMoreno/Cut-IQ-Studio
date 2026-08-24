import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ChevronUp, ChevronDown, Lock, LockOpen, History, Quote, X } from "lucide-react";
import { fmtTime } from "@/lib/youtube";
import { trpc } from "@/providers/trpc";

export interface Segment {
  id: number;
  idx: number;
  text: string;
  start: number;
  end: number;
}

function normalizeTerm(s: string) {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Props {
  videoDbId: number;
  segments: Segment[];
  currentTime: number;
  preroll: number;
  onPreroll: (n: number) => void;
  onSeek: (sec: number) => void;
  onSaveMoment: (seg: Segment) => void;
}

export function TranscriptPanel({ videoDbId, segments, currentTime, preroll, onPreroll, onSeek, onSaveMoment }: Props) {
  const [query, setQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [scrollLock, setScrollLock] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLButtonElement>(null);
  const recordSearch = trpc.clipsift.recordSearch.useMutation();
  const { data: history } = trpc.clipsift.recentSearches.useQuery(
    { videoDbId },
    { enabled: showHistory },
  );
  const { data: suggestions } = trpc.clipsift.suggestions.useQuery(
    { videoDbId, prefix: query.replace(/^"/, "").split(" ").pop() ?? "" },
    { enabled: query.length >= 2 && !query.startsWith('"') },
  );

  const { matches, terms, isPhrase } = useMemo(() => {
    const q = query.trim();
    if (!q) return { matches: [] as Segment[], terms: [] as string[], isPhrase: false };
    const phraseMatch = q.match(/^"([^"]+)"$/);
    const isPhrase = !!phraseMatch;
    const terms = phraseMatch
      ? [normalizeTerm(phraseMatch[1])]
      : normalizeTerm(q).split(" ").filter(Boolean);
    if (!terms.length || terms.some((t) => !t)) return { matches: [] as Segment[], terms: [] as string[], isPhrase };
    const matches = segments.filter((s) => {
      const norm = normalizeTerm(s.text);
      return isPhrase ? norm.includes(terms[0]) : terms.every((t) => norm.includes(t));
    });
    return { matches, terms, isPhrase };
  }, [query, segments]);

  const changeQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setActiveResult(0);
  };

  // record searches (debounced)
  useEffect(() => {
    if (!query.trim() || matches.length === 0) return;
    const t = setTimeout(() => recordSearch.mutate({ videoDbId, query: query.trim() }), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matches.length]);

  const activeSegmentIdx = useMemo(() => {
    let idx = -1;
    for (const s of segments) {
      if (s.start <= currentTime) idx = s.idx;
      else break;
    }
    return idx;
  }, [segments, currentTime]);

  // follow playback
  useEffect(() => {
    if (scrollLock && !query && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeSegmentIdx, scrollLock, query]);

  // scroll active search result into view
  useEffect(() => {
    if (query && matches.length && listRef.current) {
      const el = listRef.current.querySelector(`[data-result="${activeResult}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeResult, query, matches.length]);

  const highlight = (text: string) => {
    if (!terms.length) return text;
    const rawTerms = isPhrase
      ? [query.trim().replace(/^"|"$/g, "")]
      : query.trim().split(/\s+/).filter(Boolean);
    const pattern = rawTerms.map(escapeRegExp).join("|");
    if (!pattern) return text;
    const parts = text.split(new RegExp(`(${pattern})`, "gi"));
    return parts.map((p, i) =>
      i % 2 === 1 ? (
        <mark key={i} className="rounded bg-amber-400/80 px-0.5 text-zinc-900">
          {p}
        </mark>
      ) : (
        p
      ),
    );
  };

  const jumpResult = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (activeResult + dir + matches.length) % matches.length;
    setActiveResult(next);
    onSeek(matches[next].start);
  };

  const shown = query ? matches : segments;

  return (
    <div className="flex h-full flex-col">
      {/* Sticky search bar */}
      <div className="sticky top-0 z-10 space-y-2 border-b border-zinc-800 bg-zinc-950/95 p-3 backdrop-blur">
        <div className="relative flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onFocus={() => setShowHistory(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") jumpResult(e.shiftKey ? -1 : 1);
                if (e.key === "Escape") changeQuery("");
              }}
              placeholder='Search transcript… use "quotes" for exact phrase'
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-9 pr-8 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-brand-500"
            />
            {query && (
              <button onClick={() => changeQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                <X className="h-4 w-4" />
              </button>
            )}
            {suggestions && suggestions.length > 0 && query.length >= 2 && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => changeQuery(s)}
                    className="block w-full px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            title="Recent searches"
            onClick={() => setShowHistory((v) => !v)}
            className="rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800"
          >
            <History className="h-4 w-4" />
          </button>
          <select
            title="Seek preroll"
            value={preroll}
            onChange={(e) => onPreroll(Number(e.target.value))}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs text-zinc-300"
          >
            {[0, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>
                -{n}s
              </option>
            ))}
          </select>
          <button
            title={scrollLock ? "Auto-scroll locked to playback" : "Auto-scroll off"}
            onClick={() => setScrollLock((v) => !v)}
            className={`rounded-lg border p-2 ${scrollLock ? "border-brand-500/50 text-brand-400" : "border-zinc-700 text-zinc-400"} hover:bg-zinc-800`}
          >
            {scrollLock ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
          </button>
        </div>
        {showHistory && history && history.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {history.map((h) => (
              <button
                key={h}
                onClick={() => { changeQuery(h); setShowHistory(false); }}
                className="rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                {h}
              </button>
            ))}
          </div>
        )}
        {query && (
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>
              {matches.length} {matches.length === 1 ? "result" : "results"}
              {matches.length > 0 && ` · ${activeResult + 1} of ${matches.length}`}
            </span>
            <div className="flex gap-1">
              <button onClick={() => jumpResult(-1)} className="rounded border border-zinc-700 p-1 hover:bg-zinc-800" title="Previous (Shift+Enter)">
                <ChevronUp className="h-4 w-4" />
              </button>
              <button onClick={() => jumpResult(1)} className="rounded border border-zinc-700 p-1 hover:bg-zinc-800" title="Next (Enter)">
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transcript / results */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-2">
        {segments.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">No transcript loaded.</p>
        ) : query && matches.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">No matches for “{query}”.</p>
        ) : (
          shown.map((s, i) => {
            const isActiveLine = !query && s.idx === activeSegmentIdx;
            const isActiveResult = query && i === activeResult;
            return (
              <div key={s.id} className="group relative">
                <button
                  ref={isActiveLine ? activeLineRef : undefined}
                  data-result={query ? i : undefined}
                  data-transcript-segment={s.idx}
                  data-segment-start={s.start}
                  onClick={() => onSeek(s.start)}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition ${
                    isActiveResult
                      ? "bg-brand-500/15 ring-1 ring-brand-500/50"
                      : isActiveLine
                        ? "bg-brand-500/10 ring-1 ring-brand-500/40"
                        : "hover:bg-zinc-900"
                  }`}
                >
                  <span className={`mt-0.5 shrink-0 font-mono text-xs ${isActiveLine || isActiveResult ? "text-brand-400" : "text-zinc-500"}`}>
                    {fmtTime(s.start)}
                  </span>
                  <span className={`text-sm leading-relaxed ${isActiveLine ? "text-zinc-100" : "text-zinc-300"}`}>
                    {highlight(s.text)}
                  </span>
                </button>
                <button
                  title="Save as moment"
                  onClick={() => onSaveMoment(s)}
                  className="absolute right-2 top-2 rounded p-1 text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-amber-400 group-hover:opacity-100"
                >
                  <Quote className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
