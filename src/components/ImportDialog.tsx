import { useRef, useState } from "react";
import { X, Upload } from "lucide-react";

interface Props {
  onClose: () => void;
  onImport: (format: "srt" | "vtt" | "text", content: string) => Promise<void>;
}

export function ImportDialog({ onClose, onImport }: Props) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"srt" | "vtt" | "text">("srt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (f: File) => {
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "srt") setFormat("srt");
    else if (ext === "vtt") setFormat("vtt");
    else setFormat("text");
    setText(await f.text());
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onImport(format, text);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Import transcript</h3>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:bg-zinc-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-3 flex gap-2">
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <Upload className="h-4 w-4" /> Choose .srt / .vtt / .txt
          </button>
          <input ref={fileRef} type="file" accept=".srt,.vtt,.txt,text/plain" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-300">
            <option value="srt">SubRip (.srt)</option>
            <option value="vtt">WebVTT (.vtt)</option>
            <option value="text">Timestamped text (12:34 line)</option>
          </select>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder={"Paste transcript here…\n\n.srt / .vtt content, or lines like:\n12:34 something was said"}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 outline-none focus:border-brand-500"
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button onClick={submit} disabled={busy || !text.trim()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-40">
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
