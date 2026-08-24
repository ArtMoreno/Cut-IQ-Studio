import {
  ExternalLink,
  Info,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";

export default function MobileMore() {
  return (
    <section>
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-400">
        Companion
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">More</h1>
      <div className="mt-5 space-y-3">
        <article className="rounded-2xl border border-white/10 bg-[#0e1013] p-4">
          <div className="flex items-start gap-3">
            <MonitorSmartphone className="h-5 w-5 shrink-0 text-brand-400" />
            <div>
              <h2 className="font-semibold">
                Add Cut IQ to your Home Screen
              </h2>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm leading-relaxed text-zinc-400">
                <li>Open this page in Safari.</li>
                <li>Tap the Share button.</li>
                <li>Choose Add to Home Screen.</li>
              </ol>
            </div>
          </div>
        </article>
        <article className="rounded-2xl border border-white/10 bg-[#0e1013] p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
            <div>
              <h2 className="font-semibold">Private connection</h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                This companion reaches the Cut IQ PC through your private
                Tailscale network. Keep Tailscale connected on the phone and
                leave the PC awake while reviewing video.
              </p>
            </div>
          </div>
        </article>
        <article className="rounded-2xl border border-white/10 bg-[#0e1013] p-4">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 shrink-0 text-sky-400" />
            <div>
              <h2 className="font-semibold">Desktop workspace</h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Advanced source setup and Windows folder controls remain on the
                PC. Phone edits and jobs use the same Cut IQ database.
              </p>
              <a
                href="/"
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-4 text-sm font-semibold"
              >
                Open desktop view <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
