import { useState } from "react";
import { Activity, CheckCircle2, AlertTriangle, XCircle, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { AppNav } from "@/components/AppNav";
import { InlineError } from "@/components/InlineState";

export default function Diagnostics() {
  const [includeNetwork, setIncludeNetwork] = useState(false);
  const query = trpc.findClips.diagnostics.useQuery({ includeNetwork });
  const icon = (status: string) => status === "pass" ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : status === "warning" ? <AlertTriangle className="h-5 w-5 text-amber-400" /> : <XCircle className="h-5 w-5 text-red-400" />;
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <AppNav active="diagnostics" />
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <Activity className="h-5 w-5 text-brand-400" />
        <div><h1 className="text-sm font-semibold">Diagnostics</h1><p className="text-[11px] text-zinc-500">Runtime, worker, media tools, storage, and transcription readiness</p></div>
        <button onClick={() => query.refetch()} className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
      </header>
      <main className="mx-auto max-w-4xl p-5">
        <label className="mb-4 flex items-center gap-2 text-xs text-zinc-400"><input type="checkbox" checked={includeNetwork} onChange={(event) => setIncludeNetwork(event.target.checked)} /> Include live yt-dlp metadata probe</label>
        {query.isLoading ? <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-brand-400" /></div> : query.isError ? (
          <InlineError title="Diagnostics could not run" message={query.error.message} onRetry={() => void query.refetch()} diagnostics={false} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(query.data ?? []).map((item) => (
              <div key={item.id} className="flex gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                {icon(item.status)}
                <div className="min-w-0"><p className="text-sm font-medium text-zinc-100">{item.label}</p><p className="mt-1 break-words text-xs leading-relaxed text-zinc-500">{item.detail}</p></div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
