import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import { trpc } from "../providers/trpc";
import {
  PRO_PRICE_LABEL,
  PRO_PURCHASE_URL,
  closeProDialog,
  useProDialog,
} from "../lib/license";

const PRO_FEATURES = [
  "Batch render a whole project in one pass",
  "Batch render every saved moment on a video",
  "Clip package export and broadcast soundbites",
  "Sync a finished package to Drive",
];

export function ProDialog() {
  const { open, prompt } = useProDialog();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const status = trpc.license.status.useQuery(undefined, { enabled: open });
  const activate = trpc.license.activate.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.license.status.invalidate();
      closeProDialog();
    },
    onError: (mutationError) => setError(mutationError.message),
  });
  const deactivate = trpc.license.deactivate.useMutation({
    onSuccess: () => void utils.license.status.invalidate(),
  });

  useEffect(() => {
    if (open) {
      setKey("");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const isPro = status.data?.tier === "pro";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeProDialog();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pro-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") closeProDialog();
        }}
        className="w-[460px] max-w-full rounded-2xl border border-white/10 bg-[#111311] p-5 shadow-2xl shadow-black/60"
      >
        <div className="flex items-start justify-between gap-4">
          <h2
            id="pro-dialog-title"
            className="font-brand text-sm font-semibold text-[#F7F8F5]"
          >
            {isPro ? "Cut IQ Studio Pro is active" : "Cut IQ Studio Pro"}
          </h2>
          <button
            type="button"
            onClick={closeProDialog}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isPro ? (
          <>
            <p className="mt-2 text-[12px] leading-5 text-zinc-400">
              {status.data?.licensedTo
                ? `Licensed to ${status.data.licensedTo}.`
                : "Your key is active on this machine."}{" "}
              Thank you for paying for it.
            </p>
            <button
              type="button"
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending}
              className="mt-4 rounded-lg border border-white/10 px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.06] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              Remove key from this machine
            </button>
          </>
        ) : (
          <>
            <p className="mt-2 text-[12px] leading-5 text-zinc-400">
              {prompt
                ? `${prompt} is part of Pro.`
                : "Finding, reviewing, and rendering single clips stay free."}{" "}
              One payment, no subscription, no account.
            </p>

            <ul className="mt-3 space-y-1.5">
              {PRO_FEATURES.map((feature) => (
                <li
                  key={feature}
                  className="flex gap-2 text-[12px] leading-5 text-zinc-200"
                >
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-400" />
                  {feature}
                </li>
              ))}
            </ul>

            <a
              href={PRO_PURCHASE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 flex items-center justify-center rounded-lg bg-brand-500 px-3 py-2.5 font-brand text-[13px] font-semibold text-[#0B0D0C] transition-colors hover:bg-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              Get Pro — {PRO_PRICE_LABEL}
            </a>

            <form
              className="mt-4"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = key.trim();
                if (!trimmed) {
                  setError("Paste the key from your purchase email.");
                  return;
                }
                activate.mutate({ key: trimmed });
              }}
            >
              <label
                htmlFor="pro-key"
                className="font-brand text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500"
              >
                Already bought it?
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="pro-key"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="CIQPRO-..."
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(error)}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0B0D0C] px-2.5 py-2 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/20"
                />
                <button
                  type="submit"
                  disabled={activate.isPending}
                  className="rounded-lg border border-white/10 px-3 py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.06] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  {activate.isPending ? "Checking" : "Activate"}
                </button>
              </div>
            </form>
          </>
        )}

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] leading-5 text-red-300"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
