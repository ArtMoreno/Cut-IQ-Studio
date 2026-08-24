/**
 * Script / Project mode — script submission dialog (manual paste fallback;
 * Other local operators can submit through the same control API without this dialog).
 * Radix Dialog: focus-trapped, Escape closes, background is inert.
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { FileUp, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SubmitDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (projectId: number) => void }) {
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [docUrl, setDocUrl] = useState("");
  const [docId, setDocId] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hasDraft = Boolean(scriptText.trim() || topic.trim() || title.trim() || docUrl.trim());
  const requestClose = () => {
    if (hasDraft && !window.confirm("Discard this script revision? What you typed here will be lost.")) return;
    onClose();
  };
  const submit = trpc.script.submitScript.useMutation({
    onSuccess: (res) => onCreated(res.projectId),
    onError: (e) => setError(e.message),
  });

  // Try to extract a Google Doc ID from a pasted URL.
  const docIdFromUrl = (url: string): string => {
    const m = url.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
    return m ? m[1] : "";
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setScriptText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const input = "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-brand-500";

  return (
    <Dialog open onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl border-zinc-800 bg-zinc-950 p-5">
        <DialogHeader className="pr-8">
          <DialogTitle>Add a script revision</DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            Manual entry — scripts can also be submitted automatically through Cut IQ's stable local control API.
            Paste the finished narration only (not the research packet).
          </DialogDescription>
        </DialogHeader>
        {error && <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input className={input} placeholder="Topic (e.g. Elijah Lofton)" value={topic} onChange={(e) => setTopic(e.target.value)} />
            <input className={input} placeholder="Project title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <input
            className={input}
            placeholder="Google Doc URL (optional — used for stable identity)"
            value={docUrl}
            onChange={(e) => { setDocUrl(e.target.value); setDocId(docIdFromUrl(e.target.value)); }}
          />
          {docId && <p className="text-xs text-zinc-500">Doc ID detected: <code className="text-zinc-300">{docId}</code></p>}
          <textarea
            className={`${input} min-h-[280px] font-mono text-xs leading-relaxed`}
            placeholder="Paste the final script narration here, exactly as written…"
            value={scriptText}
            onChange={(e) => setScriptText(e.target.value)}
          />
          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">
              <FileUp className="h-3.5 w-3.5" /> or import a .txt file
              <input type="file" accept=".txt,.md,text/plain" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
            </label>
            <div className="flex gap-2">
              <button onClick={requestClose} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
              <button
                disabled={submit.isPending || !scriptText.trim()}
                onClick={() => {
                  setError(null);
                  submit.mutate({
                    scriptText,
                    topic: topic.trim() || undefined,
                    projectName: title.trim() || undefined,
                    sourceDocId: docId || undefined,
                    sourceUrl: docUrl.trim() || undefined,
                    sourceProvider: docId ? "google_docs" : "manual",
                    extractedFromHeading: "manual paste",
                  });
                }}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-40"
              >
                {submit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Submit script
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
