import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronDown, Film, Loader2, ShieldCheck } from "lucide-react";
import { trpc } from "@/providers/trpc";
import {
  highlightTunerModes,
  highlightTunerPreset,
  normalizeHighlightTunerDraft,
  type HighlightTunerFormValue,
} from "@/components/findClips/highlightTunerForm";

const highlightDraftKey = "clipsift.findClips.mobileHighlightTuner.v1";

function readHighlightDraft(): HighlightTunerFormValue {
  try {
    return normalizeHighlightTunerDraft(JSON.parse(localStorage.getItem(highlightDraftKey) ?? "null"));
  } catch {
    localStorage.removeItem(highlightDraftKey);
    return normalizeHighlightTunerDraft();
  }
}

const inputClass =
  "mt-1.5 min-h-12 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";

export default function MobileNewJob() {
  const navigate = useNavigate();
  const [player, setPlayer] = useState("");
  const [team, setTeam] = useState("");
  const [season, setSeason] = useState(new Date().getFullYear());
  const [games, setGames] = useState("");
  const [brief, setBrief] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [preferredHeight, setPreferredHeight] = useState(1080);
  const [minimumHeight, setMinimumHeight] = useState(720);
  const [preRollSec, setPreRollSec] = useState(10);
  const [postRollSec, setPostRollSec] = useState(15);
  const [sourceLimit, setSourceLimit] = useState(60);
  const [clipLimit, setClipLimit] = useState(100);
  const [highlightTuner, setHighlightTuner] = useState(readHighlightDraft);
  const create = trpc.findClips.create.useMutation({
    onSuccess: job => {
      localStorage.removeItem(highlightDraftKey);
      navigate(`/m?started=${job.id}`);
    },
  });
  const valid = player.trim()
    && team.trim()
    && season >= 1900
    && highlightTuner.maxClipsPerGame >= 1
    && highlightTuner.maxClipsPerGame <= 50
    && highlightTuner.minimumEstimatedYards >= 0
    && highlightTuner.minimumEstimatedYards <= 99
    && highlightTuner.minimumExcitement >= 0
    && highlightTuner.minimumExcitement <= 25;

  useEffect(() => {
    localStorage.setItem(highlightDraftKey, JSON.stringify(highlightTuner));
  }, [highlightTuner]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || create.isPending) return;
    create.mutate({
      player: player.trim(),
      team: team.trim(),
      season,
      opponent: games.trim() || undefined,
      scriptText: brief.trim(),
      sourceLimit,
      clipLimit,
      preferredHeight,
      minimumHeight,
      preRollSec,
      postRollSec,
      localAsrFallback: true,
      highlightTuner,
      autoStart: true,
    });
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-4 pb-24"
      aria-labelledby="mobile-new-job-title"
    >
      <div className="mb-5">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-400">
          Find Clips
        </p>
        <h1
          id="mobile-new-job-title"
          className="mt-1 text-2xl font-semibold tracking-tight"
        >
          Start a new job
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          The job runs on your Cut IQ PC even if you close this phone.
        </p>
      </div>
      <section className="space-y-4 rounded-2xl border border-white/10 bg-[#0e1013] p-4">
        <label className="block text-xs font-semibold text-zinc-300">
          Player or subject *
          <input
            autoFocus
            autoComplete="off"
            className={inputClass}
            value={player}
            onChange={e => setPlayer(e.target.value)}
            placeholder="Demari Brown"
          />
        </label>
        <label className="block text-xs font-semibold text-zinc-300">
          Team *
          <input
            autoComplete="organization"
            className={inputClass}
            value={team}
            onChange={e => setTeam(e.target.value)}
            placeholder="Miami Hurricanes"
          />
        </label>
        <label className="block text-xs font-semibold text-zinc-300">
          Season *
          <input
            inputMode="numeric"
            className={inputClass}
            type="number"
            min={1900}
            max={2200}
            value={season}
            onChange={e => setSeason(Number(e.target.value))}
          />
        </label>
        <label className="block text-xs font-semibold text-zinc-300">
          Priority games or opponents
          <textarea
            className={`${inputClass} min-h-24 py-3`}
            value={games}
            onChange={e => setGames(e.target.value)}
            placeholder="Leave blank for the full season, or enter one game per line"
          />
        </label>
      </section>
      <section className="rounded-2xl border border-white/10 bg-[#0e1013] p-4">
        <label className="block text-xs font-semibold text-zinc-300" htmlFor="mobile-highlight-focus">
          Highlight focus
        </label>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">Everything keeps the current engine behavior. Filtered modes preserve unselected candidates for review.</p>
        <select
          id="mobile-highlight-focus"
          className={inputClass}
          value={highlightTuner.mode}
          onChange={event => {
            const mode = event.target.value as HighlightTunerFormValue["mode"];
            setHighlightTuner(current => mode === "custom" ? { ...current, mode } : highlightTunerPreset(mode));
          }}
        >
          {highlightTunerModes.map(option => <option key={option.mode} value={option.mode}>{option.label} — {option.description}</option>)}
        </select>
        {highlightTuner.mode === "custom" && (
          <div className="mt-4 space-y-3 border-t border-zinc-800 pt-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-zinc-400">Max clips / game<input inputMode="numeric" className={inputClass} type="number" min={1} max={50} value={highlightTuner.maxClipsPerGame} onChange={event => setHighlightTuner(current => ({ ...current, maxClipsPerGame: Number(event.target.value) }))} /></label>
              <label className="text-xs text-zinc-400">Minimum yards<input inputMode="numeric" className={inputClass} type="number" min={0} max={99} value={highlightTuner.minimumEstimatedYards} onChange={event => setHighlightTuner(current => ({ ...current, minimumEstimatedYards: Number(event.target.value) }))} /></label>
              <label className="text-xs text-zinc-400">Excitement (0–25)<input inputMode="numeric" className={inputClass} type="number" min={0} max={25} value={highlightTuner.minimumExcitement} onChange={event => setHighlightTuner(current => ({ ...current, minimumExcitement: Number(event.target.value) }))} /></label>
            </div>
            {([
              ["includeProbablePlays", "Include probable plays"],
              ["alwaysIncludeTouchdowns", "Always include touchdowns"],
              ["includeKeyDowns", "Include key downs"],
              ["includeRedZonePlays", "Include brand-zone plays"],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex min-h-11 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 text-xs text-zinc-300">
                <input className="h-4 w-4 accent-brand-500" type="checkbox" checked={highlightTuner[key]} onChange={event => setHighlightTuner(current => ({ ...current, [key]: event.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-white/10 bg-[#0e1013] p-4">
        <label className="block text-xs font-semibold text-zinc-300">
          Coverage brief or script
          <textarea
            className={`${inputClass} min-h-32 py-3`}
            value={brief}
            onChange={e => setBrief(e.target.value)}
            placeholder="Optional — Cut IQ creates the football coverage plan when this is blank."
          />
        </label>
        <div className="mt-3 flex gap-2 text-xs text-zinc-500">
          <Check className="h-4 w-4 shrink-0 text-emerald-400" />
          <span>
            Player plays and full-video broadcast sound bites are included.
          </span>
        </div>
      </section>
      <section className="rounded-2xl border border-white/10 bg-[#0e1013] p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div>
            <h2 className="font-semibold">Clip standards</h2>
            <p className="mt-1 text-xs text-zinc-500">
              1080p preferred, never below 720p.
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs text-zinc-400">
            Before
            <input
              inputMode="decimal"
              type="number"
              min={0}
              max={60}
              className={inputClass}
              value={preRollSec}
              onChange={e => setPreRollSec(Number(e.target.value))}
            />
          </label>
          <label className="text-xs text-zinc-400">
            After
            <input
              inputMode="decimal"
              type="number"
              min={0}
              max={90}
              className={inputClass}
              value={postRollSec}
              onChange={e => setPostRollSec(Number(e.target.value))}
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="mt-4 flex min-h-11 w-full items-center justify-between border-t border-zinc-800 pt-3 text-sm font-semibold text-zinc-400"
          aria-expanded={advanced}
        >
          Advanced processing
          <ChevronDown
            className={`h-4 w-4 transition ${advanced ? "rotate-180" : ""}`}
          />
        </button>
        {advanced && (
          <div className="mt-3 space-y-3">
            <label className="block text-xs text-zinc-400">
              Preferred quality
              <select
                className={inputClass}
                value={preferredHeight}
                onChange={e =>
                  setPreferredHeight(
                    Math.max(Number(e.target.value), minimumHeight)
                  )
                }
              >
                <option value={1080}>1080p</option>
                <option value={720}>720p</option>
                <option value={1440}>1440p</option>
                <option value={2160}>4K</option>
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              Minimum quality
              <select
                className={inputClass}
                value={minimumHeight}
                onChange={e => {
                  const next = Number(e.target.value);
                  setMinimumHeight(next);
                  setPreferredHeight(current => Math.max(current, next));
                }}
              >
                <option value={720}>720p</option>
                <option value={1080}>1080p</option>
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              Source search budget
              <input
                inputMode="numeric"
                type="number"
                min={1}
                max={200}
                className={inputClass}
                value={sourceLimit}
                onChange={e => setSourceLimit(Number(e.target.value))}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Maximum automatic clips
              <input
                inputMode="numeric"
                type="number"
                min={1}
                max={500}
                className={inputClass}
                value={clipLimit}
                onChange={e => setClipLimit(Number(e.target.value))}
              />
            </label>
          </div>
        )}
      </section>
      {create.isError && (
        <div
          role="alert"
          className="rounded-xl border border-brand-500/25 bg-brand-500/10 p-3 text-sm text-brand-200"
        >
          {create.error.message}
        </div>
      )}
      <div className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#0b0c0f]/97 px-4 pt-3 backdrop-blur">
        <button
          type="submit"
          disabled={!valid || create.isPending}
          className="mx-auto flex min-h-12 w-full max-w-lg items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-bold text-white disabled:opacity-40"
        >
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Film className="h-4 w-4" />
          )}
          {create.isPending ? "Starting pipeline…" : "Start Cut IQ job"}
        </button>
      </div>
    </form>
  );
}
