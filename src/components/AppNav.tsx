import { Activity, Clapperboard, Menu, Scissors, Sparkles } from "lucide-react";
import { Link, NavLink } from "react-router";
import type { ReactNode } from "react";

import { trpc } from "../providers/trpc";
import { openProDialog } from "../lib/license";

type AppArea = "find" | "studio" | "assemble" | "diagnostics";

const primary = [
  { area: "find" as const, to: "/", label: "Find Clips", icon: Clapperboard },
  { area: "studio" as const, to: "/transcript-studio", label: "Manual Clip Studio", icon: Scissors },
];

function navClass(active: boolean) {
  return `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-brand text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${
    active ? "bg-brand-500/10 text-brand-300 shadow-sm ring-1 ring-brand-500/15" : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
  }`;
}

function ProNavButton() {
  const status = trpc.license.status.useQuery();
  const isPro = status.data?.tier === "pro";
  return (
    <button
      type="button"
      onClick={() => openProDialog()}
      title={isPro ? "Cut IQ Studio Pro is active on this machine" : "Unlock batch render and package export with a one-time purchase"}
      className={`hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 font-brand text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 md:inline-flex ${
        isPro
          ? "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"
          : "bg-brand-500 text-[#0B0D0C] hover:bg-brand-400"
      }`}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {isPro ? "Pro active" : "Get Pro"}
    </button>
  );
}

export function AppNav({ active, actions }: { active: AppArea; actions?: ReactNode }) {
  return (
    <header className="relative z-40 shrink-0 border-b border-white/[0.08] bg-[#0B0D0C]/95 px-3 py-2.5 backdrop-blur-xl sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400" aria-label="Cut IQ Studio home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-500/20 bg-[#111311] shadow-lg shadow-black/40">
            <img src="/brand/cut-iq-icon-green.svg" alt="" className="h-7 w-7" />
          </span>
          <span className="hidden flex-col leading-none sm:flex" aria-hidden="true">
            <span className="font-brand text-[13px] font-semibold tracking-[-0.035em] text-[#F7F8F5]">CUT IQ</span>
            <span className="mt-1 font-brand text-[7px] font-medium tracking-[0.36em] text-brand-500">STUDIO</span>
          </span>
        </Link>

        <nav className="hidden items-center rounded-lg border border-white/[0.08] bg-[#111311] p-0.5 md:flex" aria-label="Primary navigation">
          {primary.map((item) => {
            const Icon = item.icon;
            return <NavLink key={item.area} to={item.to} end={item.area === "find"} className={() => navClass(active === item.area)}><Icon className="h-3.5 w-3.5" />{item.label}</NavLink>;
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-1 md:flex">
          <ProNavButton />
          <NavLink to="/diagnostics" className={() => `inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-brand text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 ${active === "diagnostics" ? "bg-brand-500/10 text-brand-300" : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200"}`}>
            <Activity className="h-3.5 w-3.5" /> Diagnostics
          </NavLink>
        </div>

        <details className="group relative ml-auto md:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 font-brand text-xs font-medium text-zinc-200 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
            <Menu className="h-4 w-4" /> Menu
          </summary>
          <nav className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 rounded-xl border border-white/10 bg-[#111311] p-1.5 shadow-2xl shadow-black/60" aria-label="Mobile navigation">
            {primary.map((item) => {
              const Icon = item.icon;
              return <NavLink key={item.area} to={item.to} end={item.area === "find"} className={() => `${navClass(active === item.area)} w-full justify-start`}><Icon className="h-4 w-4" />{item.label}</NavLink>;
            })}
            <NavLink to="/diagnostics" className={() => `${navClass(active === "diagnostics")} w-full justify-start`}><Activity className="h-4 w-4" />Diagnostics</NavLink>
            <button type="button" onClick={() => openProDialog()} className={`${navClass(false)} w-full justify-start`}><Sparkles className="h-4 w-4" />Get Pro</button>
          </nav>
        </details>

        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
