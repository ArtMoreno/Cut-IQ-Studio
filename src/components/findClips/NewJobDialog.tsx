import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, ChevronDown, FileUp, Film, Loader2, Search, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { trpc } from "@/providers/trpc";
import {
  highlightTunerModes,
  highlightTunerPreset,
  highlightTunerSummary,
  normalizeHighlightTunerDraft,
  type HighlightTunerFormValue,
} from "./highlightTunerForm";

const draftKey = "clipsift.findClips.newProjectDraft.v2";

export type SavedProjectDraft = {
  player?: string;
  team?: string;
  season?: number;
  games?: string;
  scriptText?: string;
  sourceLimit?: number;
  clipLimit?: number;
  preferredHeight?: number;
  minimumHeight?: number;
  preRollSec?: number;
  postRollSec?: number;
  localAsrFallback?: boolean;
  highlightTuner?: HighlightTunerFormValue;
};

function readProjectDraft(): SavedProjectDraft {
  try {
    return JSON.parse(localStorage.getItem(draftKey) ?? "{}") as SavedProjectDraft;
  } catch {
    localStorage.removeItem(draftKey);
    return {};
  }
}

function gameCount(value: string): number {
  return new Set(value.split(/[\n,;|]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)).size;
}

const inputClass = "w-full rounded-xl border border-zinc-700/80 bg-[#111215] px-3.5 py-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15";

export function NewFindClipsJobForm({ onCreated, initialDraft }: { onCreated: (projectId: number) => void; initialDraft?: SavedProjectDraft }) {
  const saved = useMemo(() => ({ ...readProjectDraft(), ...initialDraft }), [initialDraft]);
  const [player, setPlayer] = useState(saved.player ?? "");
  const [team, setTeam] = useState(saved.team ?? "");
  const [season, setSeason] = useState(saved.season ?? new Date().getFullYear());
  const [games, setGames] = useState(saved.games ?? "");
  const [scriptText, setScriptText] = useState(saved.scriptText ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [sourceLimit, setSourceLimit] = useState(saved.sourceLimit ?? 60);
  const [clipLimit, setClipLimit] = useState(saved.clipLimit ?? 100);
  const [preferredHeight, setPreferredHeight] = useState(saved.preferredHeight ?? 1080);
  const [minimumHeight, setMinimumHeight] = useState(Math.max(720, saved.minimumHeight ?? 720));
  const [preRollSec, setPreRollSec] = useState(saved.preRollSec ?? 10);
  const [postRollSec, setPostRollSec] = useState(saved.postRollSec ?? 15);
  const [localAsrFallback, setLocalAsrFallback] = useState(saved.localAsrFallback ?? true);
  const [highlightTuner, setHighlightTuner] = useState(() => normalizeHighlightTunerDraft(saved.highlightTuner));
  const [error, setError] = useState<string | null>(null);
  const create = trpc.findClips.create.useMutation({
    onSuccess: (job) => {
      localStorage.removeItem(draftKey);
      onCreated(Number(job.projectFk));
    },
    onError: (cause) => setError(cause.message),
  });

  const words = scriptText.trim() ? scriptText.trim().split(/\s+/).length : 0;
  const gamesEntered = gameCount(games);
  const valid = Boolean(
    player.trim()
    && team.trim()
    && Number.isInteger(season)
    && season >= 1900
    && season <= 2200
    && minimumHeight >= 720
    && preferredHeight >= minimumHeight
    && preRollSec >= 0
    && postRollSec >= 0
    && highlightTuner.maxClipsPerGame >= 1
    && highlightTuner.maxClipsPerGame <= 50
    && highlightTuner.minimumEstimatedYards >= 0
    && highlightTuner.minimumEstimatedYards <= 99
    && highlightTuner.minimumExcitement >= 0
    && highlightTuner.minimumExcitement <= 25,
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(draftKey, JSON.stringify({
        player,
        team,
        season,
        games,
        scriptText,
        sourceLimit,
        clipLimit,
        preferredHeight,
        minimumHeight,
        preRollSec,
        postRollSec,
        localAsrFallback,
        highlightTuner,
      } satisfies SavedProjectDraft));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [player, team, season, games, scriptText, sourceLimit, clipLimit, preferredHeight, minimumHeight, preRollSec, postRollSec, localAsrFallback, highlightTuner]);

  const loadFile = (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setError("That script is larger than 5 MB. Use a .txt or .md file under 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setScriptText(String(reader.result ?? ""));
      setError(null);
    };
    reader.onerror = () => setError("Cut IQ could not read that script file.");
    reader.readAsText(file);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || create.isPending) return;
    setError(null);
    create.mutate({
      player: player.trim(),
      team: team.trim(),
      season,
      opponent: games.trim() || undefined,
      scriptText: scriptText.trim(),
      sourceLimit,
      clipLimit,
      preferredHeight,
      minimumHeight,
      preRollSec,
      postRollSec,
      localAsrFallback,
      highlightTuner,
      autoStart: true,
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

        <section className="rounded-2xl border border-white/10 bg-[#0d0e11] p-5 shadow-2xl shadow-black/20 sm:p-6">
          <div className="mb-5 flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-400 ring-1 ring-brand-500/20"><Search className="h-4 w-4" /></span>
            <div><h2 className="text-base font-semibold text-white">Who are we finding?</h2><p className="mt-1 text-xs leading-relaxed text-zinc-500">Cut IQ grounds every YouTube search to the player, team, season, and games below.</p></div>
          </div>

          <div className="space-y-4">
            <label className="block"><span className="mb-1.5 block text-xs font-semibold text-zinc-300">Player / subject <span className="text-brand-400">*</span></span><input className={inputClass} value={player} onChange={(event) => setPlayer(event.target.value)} placeholder="Evan Johnson" autoFocus autoComplete="off" /></label>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
              <label className="block"><span className="mb-1.5 block text-xs font-semibold text-zinc-300">Team <span className="text-brand-400">*</span></span><input className={inputClass} value={team} onChange={(event) => setTeam(event.target.value)} placeholder="BYU" autoComplete="off" /></label>
              <label className="block"><span className="mb-1.5 block text-xs font-semibold text-zinc-300">Season <span className="text-brand-400">*</span></span><input className={inputClass} type="number" min={1900} max={2200} value={season} onChange={(event) => setSeason(Number(event.target.value))} /></label>
            </div>
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between gap-3 text-xs font-semibold text-zinc-300"><span>Games / opponents <span className="font-normal text-zinc-600">— optional</span></span><span className="font-normal tabular-nums text-zinc-600">{gamesEntered ? `${gamesEntered} entered` : "Full-season search"}</span></span>
              <textarea className={`${inputClass} min-h-24 resize-y leading-relaxed`} value={games} maxLength={255} onChange={(event) => setGames(event.target.value)} placeholder={"Utah\nTCU\nEast Carolina"} />
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">Leave this blank to search the full {team.trim() || "team"} {season || "season"}. Add one game per line to force those matchups into the search rotation.</p>
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0d0e11] p-5 shadow-2xl shadow-black/20 sm:p-6">
          <fieldset>
            <legend className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20"><Settings2 className="h-4 w-4" /></span>
              <span><span className="block text-base font-semibold text-white">Highlight focus</span><span className="mt-1 block text-xs font-normal leading-relaxed text-zinc-500">Choose how selective Cut IQ should be after it finds every grounded candidate. Everything preserves the current engine behavior.</span></span>
            </legend>
            <div className="mt-5 grid gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Highlight focus">
              {highlightTunerModes.map((option) => {
                const selected = highlightTuner.mode === option.mode;
                return (
                  <label key={option.mode} className={`cursor-pointer rounded-xl border p-3 transition focus-within:ring-2 focus-within:ring-brand-400 ${selected ? "border-brand-500/60 bg-brand-500/10 text-white" : "border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-zinc-700"}`}>
                    <input
                      className="sr-only"
                      type="radio"
                      name="highlight-tuner-mode"
                      value={option.mode}
                      checked={selected}
                      onChange={() => setHighlightTuner((current) => option.mode === "custom" ? { ...current, mode: "custom" } : highlightTunerPreset(option.mode))}
                    />
                    <span className="block text-xs font-semibold">{option.label}</span>
                    <span className="mt-1 block text-[10px] font-normal leading-relaxed text-zinc-500">{option.description}</span>
                  </label>
                );
              })}
            </div>
            {highlightTuner.mode === "custom" && (
              <div className="mt-4 rounded-xl border border-zinc-800 bg-black/20 p-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="text-xs font-medium text-zinc-400">Maximum clips / game<input className={`${inputClass} mt-1.5`} type="number" min={1} max={50} value={highlightTuner.maxClipsPerGame} onChange={(event) => setHighlightTuner((current) => ({ ...current, maxClipsPerGame: Number(event.target.value) }))} /></label>
                  <label className="text-xs font-medium text-zinc-400">Minimum estimated yards<input className={`${inputClass} mt-1.5`} type="number" min={0} max={99} value={highlightTuner.minimumEstimatedYards} onChange={(event) => setHighlightTuner((current) => ({ ...current, minimumEstimatedYards: Number(event.target.value) }))} /></label>
                  <label className="text-xs font-medium text-zinc-400">Minimum excitement <span className="font-normal text-zinc-600">(0–25)</span><input className={`${inputClass} mt-1.5`} type="number" min={0} max={25} value={highlightTuner.minimumExcitement} onChange={(event) => setHighlightTuner((current) => ({ ...current, minimumExcitement: Number(event.target.value) }))} /></label>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {([
                    ["includeProbablePlays", "Include probable plays", "Keep play-like transcript moments even when attribution is less certain."],
                    ["alwaysIncludeTouchdowns", "Always include touchdowns", "Touchdowns bypass yardage and excitement thresholds."],
                    ["includeKeyDowns", "Include key downs", "Keep third/fourth-down conversions and first-down cues."],
                    ["includeRedZonePlays", "Include brand-zone plays", "Keep goal-line and inside-the-20 action."],
                  ] as const).map(([key, label, description]) => (
                    <label key={key} className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs leading-relaxed text-zinc-400">
                      <input className="mt-0.5 h-4 w-4 accent-brand-500" type="checkbox" checked={highlightTuner[key]} onChange={(event) => setHighlightTuner((current) => ({ ...current, [key]: event.target.checked }))} />
                      <span><strong className="block font-medium text-zinc-200">{label}</strong>{description}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </fieldset>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0d0e11] p-5 shadow-2xl shadow-black/20 sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/20"><Sparkles className="h-4 w-4" /></span><div><h2 className="text-base font-semibold text-white">Script or search notes <span className="font-normal text-zinc-600">— optional</span></h2><p className="mt-1 text-xs leading-relaxed text-zinc-500">Add a finished script for exact editorial beats, or leave this blank and Cut IQ will build a football coverage plan from the player, team, season, and games.</p></div></div>
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 hover:text-white"><FileUp className="h-3.5 w-3.5" /> Import<input type="file" accept=".txt,.md,text/plain,text/markdown" className="hidden" onChange={(event) => event.target.files?.[0] && loadFile(event.target.files[0])} /></label>
          </div>
          <textarea className={`${inputClass} min-h-72 resize-y font-mono text-xs leading-6`} value={scriptText} onChange={(event) => setScriptText(event.target.value)} placeholder="Optional: paste a finished script, describe the plays you want, or leave blank for full-season player coverage…" />
          <div className="mt-2 flex items-center justify-between gap-4 text-[11px] text-zinc-600"><span>{scriptText.trim() ? "Your text will guide the search; short notes are accepted." : "No script required — Cut IQ will generate the coverage plan."}</span><span className="shrink-0 tabular-nums">{words.toLocaleString()} words</span></div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0d0e11] p-5 shadow-2xl shadow-black/20 sm:p-6">
          <div className="mb-5 flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20"><ShieldCheck className="h-4 w-4" /></span>
            <div><h2 className="text-base font-semibold text-white">Clip standards</h2><p className="mt-1 text-xs leading-relaxed text-zinc-500">These safeguards apply to every clip produced by this job.</p></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium text-zinc-400">Preferred quality<select className={`${inputClass} mt-1.5`} value={preferredHeight} onChange={(event) => setPreferredHeight(Math.max(Number(event.target.value), minimumHeight))}><option value={1080}>1080p</option><option value={1440}>1440p</option><option value={2160}>2160p / 4K</option><option value={720}>720p</option></select></label>
            <label className="text-xs font-medium text-zinc-400">Minimum quality<select className={`${inputClass} mt-1.5`} value={minimumHeight} onChange={(event) => { const next = Number(event.target.value); setMinimumHeight(next); setPreferredHeight((current) => Math.max(current, next)); }}><option value={720}>720p minimum</option><option value={1080}>1080p minimum</option></select></label>
            <label className="text-xs font-medium text-zinc-400">Context before<div className="relative mt-1.5"><input className={`${inputClass} pr-12`} type="number" min={0} max={60} value={preRollSec} onChange={(event) => setPreRollSec(Number(event.target.value))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-600">sec</span></div></label>
            <label className="text-xs font-medium text-zinc-400">Context after<div className="relative mt-1.5"><input className={`${inputClass} pr-12`} type="number" min={0} max={90} value={postRollSec} onChange={(event) => setPostRollSec(Number(event.target.value))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-600">sec</span></div></label>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">Default context includes the setup before the matched moment and the result, replay, or identification afterward. You can widen either side for a specific job.</p>

          <button type="button" onClick={() => setAdvanced((value) => !value)} className="mt-5 flex w-full items-center justify-between border-t border-zinc-800 pt-4 text-xs font-semibold text-zinc-400 hover:text-white" aria-expanded={advanced}><span className="flex items-center gap-2"><Settings2 className="h-3.5 w-3.5" /> Advanced processing</span><ChevronDown className={`h-4 w-4 transition-transform ${advanced ? "rotate-180" : ""}`} /></button>
          {advanced && (
            <div className="mt-4 grid gap-4 rounded-xl border border-zinc-800 bg-black/20 p-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-zinc-400">Source search budget<input className={`${inputClass} mt-1.5`} type="number" min={1} max={200} value={sourceLimit} onChange={(event) => setSourceLimit(Number(event.target.value))} /><span className="mt-1 block text-[10px] leading-relaxed text-zinc-600">Cut IQ still balances unique games before alternate uploads.</span></label>
              <label className="text-xs font-medium text-zinc-400">Maximum automatic exports<input className={`${inputClass} mt-1.5`} type="number" min={1} max={500} value={clipLimit} onChange={(event) => setClipLimit(Number(event.target.value))} /><span className="mt-1 block text-[10px] leading-relaxed text-zinc-600">Discovery keeps additional review candidates instead of discarding them.</span></label>
              <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs leading-relaxed text-zinc-400 sm:col-span-2"><input className="mt-0.5 h-4 w-4 accent-brand-500" type="checkbox" checked={localAsrFallback} onChange={(event) => setLocalAsrFallback(event.target.checked)} /><span><strong className="block font-medium text-zinc-200">Local transcription recovery</strong>Transcribe every selected game that lacks usable captions. This is slower, but prevents a two-video fallback ceiling from hiding the rest of a season.</span></label>
            </div>
          )}
        </section>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-5 xl:self-start">
        <section className="overflow-hidden rounded-2xl border border-brand-500/20 bg-gradient-to-b from-brand-500/[0.08] to-[#0d0e11] shadow-2xl shadow-black/20">
          <div className="border-b border-white/10 p-5"><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-brand-400">Ready to run</p><h2 className="mt-2 text-lg font-semibold text-white">{player.trim() || "New player"}{team.trim() ? ` · ${team.trim()}` : ""}</h2><p className="mt-1 text-sm text-zinc-500">{season || "Season"} · {gamesEntered ? `${gamesEntered} priority game${gamesEntered === 1 ? "" : "s"}` : "full-season search"}</p></div>
          <div className="space-y-3 p-5 text-xs text-zinc-400">
            {[scriptText.trim() ? "Build editorial beats from your script or notes" : "Build a football coverage plan from the job details", `Search YouTube across the ${season || "selected"} season`, `Highlight focus: ${highlightTunerSummary(highlightTuner)}`, "Check captions before downloading media", `Prefer ${preferredHeight}p and reject anything below ${minimumHeight}p`, `Keep ${preRollSec}s before and ${postRollSec}s after each match`, "Cut, probe, verify, and package finished MP4s"].map((item) => <div key={item} className="flex items-start gap-2.5"><span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300"><Check className="h-2.5 w-2.5" /></span><span className="leading-relaxed">{item}</span></div>)}
          </div>
          <div className="border-t border-white/10 p-5"><button type="submit" disabled={!valid || create.isPending} className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3.5 text-sm font-bold text-white shadow-lg shadow-brand-950/40 transition hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-40">{create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}{create.isPending ? "Starting pipeline…" : "Run Cut IQ"}</button><p className="mt-3 text-center text-[11px] leading-relaxed text-zinc-600">The job is saved before processing starts. Closing Cut IQ will not erase it.</p></div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0d0e11] p-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">After you start</p>
          <div className="mt-4 space-y-3">{["Analyze script", "Discover sources", "Get transcripts", "Rank candidates", "Queue clips", "Download & verify"].map((stage, index) => <div key={stage} className="flex items-center gap-3 text-xs text-zinc-400"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 font-mono text-[10px] text-zinc-500">{index + 1}</span>{stage}</div>)}</div>
          <p className="mt-4 border-t border-zinc-800 pt-4 text-xs leading-relaxed text-zinc-500">Cut IQ opens the live job page automatically so you can watch the overall percentage, current stage, source count, clip queue, and verified total.</p>
        </section>
      </aside>
    </form>
  );
}
