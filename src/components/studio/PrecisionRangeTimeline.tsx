import { fmtTime } from "@/lib/youtube";
import { Minus, Plus } from "lucide-react";
import { useState } from "react";

interface Props {
  duration: number;
  originalIn: number;
  originalOut: number;
  inPoint: number;
  outPoint: number;
  currentTime: number;
  onInChange: (seconds: number) => void;
  onOutChange: (seconds: number) => void;
}

export function precisionTimelineWindow(input: Pick<Props, "duration" | "originalIn" | "originalOut" | "inPoint" | "outPoint">) {
  const earliest = Math.min(input.originalIn, input.inPoint);
  const latest = Math.max(input.originalOut, input.outPoint);
  const span = Math.max(10, latest - earliest);
  const padding = Math.max(10, Math.min(30, span * 0.35));
  const start = Math.max(0, earliest - padding);
  const end = Math.min(input.duration || latest + padding, latest + padding);
  return { start, end: Math.max(start + 1, end) };
}

export function PrecisionRangeTimeline(props: Props) {
  const [zoom, setZoom] = useState(1);
  const baseWindow = precisionTimelineWindow(props);
  const center = (Math.min(props.originalIn, props.inPoint) + Math.max(props.originalOut, props.outPoint)) / 2;
  const contentHalfSpan = (Math.max(props.originalOut, props.outPoint) - Math.min(props.originalIn, props.inPoint)) / 2 + 1;
  const halfSpan = Math.max(contentHalfSpan, (baseWindow.end - baseWindow.start) / 2 / zoom);
  const window = {
    start: Math.max(0, center - halfSpan),
    end: Math.min(props.duration || center + halfSpan, center + halfSpan),
  };
  const span = window.end - window.start;
  const pct = (value: number) => `${Math.max(0, Math.min(100, ((value - window.start) / span) * 100))}%`;
  const ticks = Array.from({ length: 5 }, (_, index) => window.start + (span * index) / 4);

  return (
    <div className="w-full rounded-xl border border-white/10 bg-black/25 p-3" aria-label="Local precision timeline">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-zinc-100">Precision timeline</p>
          <p className="mt-0.5 text-[11px] text-zinc-400">Local source window · absolute broadcast time</p>
        </div>
        <div className="flex items-center gap-2"><span className="font-mono text-[11px] text-zinc-400">{fmtTime(window.start)} — {fmtTime(window.end)}</span><span className="text-[10px] text-zinc-500">Zoom</span><button type="button" onClick={() => setZoom((value) => Math.max(0.75, value - 0.25))} className="rounded border border-zinc-700 p-1 text-zinc-400 hover:bg-zinc-800" aria-label="Zoom timeline out"><Minus className="h-3 w-3" /></button><input type="range" min={0.75} max={3} step={0.25} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="w-20 accent-brand-500" aria-label={`Timeline zoom ${zoom.toFixed(2)} times`} /><button type="button" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} className="rounded border border-zinc-700 p-1 text-zinc-400 hover:bg-zinc-800" aria-label="Zoom timeline in"><Plus className="h-3 w-3" /></button></div>
      </div>

      <div className="relative mt-3 h-12 rounded-lg border border-zinc-800 bg-zinc-950">
        <div className="absolute inset-y-2 rounded border border-dashed border-amber-400/80 bg-amber-400/[0.08]" style={{ left: pct(props.originalIn), right: `calc(100% - ${pct(props.originalOut)})` }} aria-hidden="true" />
        <div className="absolute inset-y-4 rounded bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.42)]" style={{ left: pct(props.inPoint), right: `calc(100% - ${pct(props.outPoint)})` }} aria-hidden="true" />
        <div className="absolute inset-y-0 w-px bg-white/80" style={{ left: pct(props.currentTime) }} aria-hidden="true" />
        <span className="absolute bottom-0.5 -translate-x-1/2 rounded bg-brand-950 px-1 font-mono text-[9px] text-brand-200" style={{ left: pct(props.inPoint) }}>IN {fmtTime(props.inPoint)}</span>
        <span className="absolute top-0.5 -translate-x-1/2 rounded bg-red-950 px-1 font-mono text-[9px] text-red-200" style={{ left: pct(props.outPoint) }}>OUT {fmtTime(props.outPoint)}</span>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-zinc-600">{ticks.map((tick) => <span key={tick}>{fmtTime(tick)}</span>)}</div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
          <span className="flex items-center justify-between text-[11px]"><strong className="text-brand-300">IN</strong><span className="font-mono text-zinc-300">{fmtTime(props.inPoint)}</span></span>
          <input type="range" min={window.start} max={Math.max(window.start, props.outPoint - 0.1)} step={0.05} value={props.inPoint} onChange={(event) => props.onInChange(Number(event.target.value))} className="mt-2 h-1.5 w-full accent-red-500" aria-label={`IN point, ${fmtTime(props.inPoint)} absolute source time`} />
        </label>
        <label className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
          <span className="flex items-center justify-between text-[11px]"><strong className="text-red-300">OUT</strong><span className="font-mono text-zinc-300">{fmtTime(props.outPoint)}</span></span>
          <input type="range" min={Math.min(window.end, props.inPoint + 0.1)} max={window.end} step={0.05} value={props.outPoint} onChange={(event) => props.onOutChange(Number(event.target.value))} className="mt-2 h-1.5 w-full accent-red-500" aria-label={`OUT point, ${fmtTime(props.outPoint)} absolute source time`} />
        </label>
      </div>
      <p className="mt-2 text-[10px] text-zinc-500">Tab to either handle, then use arrow keys for fine adjustment. Amber dashed = original; red = revised.</p>
    </div>
  );
}
