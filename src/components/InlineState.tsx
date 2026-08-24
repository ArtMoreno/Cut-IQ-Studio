import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Link } from "react-router";

export function InlineError({ title, message, onRetry, diagnostics = true }: { title: string; message: string; onRetry?: () => void; diagnostics?: boolean }) {
  return (
    <div className="m-auto flex max-w-lg flex-col items-center rounded-2xl border border-red-500/20 bg-red-950/10 p-8 text-center" role="alert">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500/10 text-brand-300"><AlertTriangle className="h-5 w-5" /></span>
      <h2 className="mt-4 text-base font-semibold text-zinc-100">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{message}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {onRetry && <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"><RefreshCw className="h-4 w-4" />Retry</button>}
        {diagnostics && <Link to="/diagnostics" className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">Open Diagnostics</Link>}
      </div>
    </div>
  );
}

export function InlineLoading({ label = "Loading…" }: { label?: string }) {
  return <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-zinc-500" role="status"><Loader2 className="h-5 w-5 animate-spin text-brand-400" />{label}</div>;
}
