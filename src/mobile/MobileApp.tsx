import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import {
  BriefcaseBusiness,
  CirclePlus,
  Clapperboard,
  MoreHorizontal,
  Wifi,
  WifiOff,
} from "lucide-react";
import MobileDashboard from "./MobileDashboard";
import MobileNewJob from "./MobileNewJob";
import MobilePackage from "./MobilePackage";
import MobileReview from "./MobileReview";
import MobileMore from "./MobileMore";
import { trpc } from "@/providers/trpc";

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

function Shell() {
  const location = useLocation();
  const online = useOnline();
  const pc = trpc.findClips.worker.useQuery(undefined, {
    refetchInterval: 10000,
    retry: 1,
  });
  const connected = online && pc.isSuccess;
  const review = location.pathname.startsWith("/m/review");
  const links = [
    ["/m", "Jobs", BriefcaseBusiness],
    ["/m/new", "New job", CirclePlus],
    ["/m/packages", "Packages", Clapperboard],
    ["/m/more", "More", MoreHorizontal],
  ] as const;
  return (
    <div className="mobile-shell min-h-[100dvh] bg-[#0B0D0C] text-zinc-100">
      <header className="mobile-safe-top sticky top-0 z-40 border-b border-white/[0.08] bg-[#0B0D0C]/95 px-4 pb-3 backdrop-blur-xl">
        <div className="mx-auto flex h-12 max-w-lg items-center gap-3">
          <Link
            to="/m"
            className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            aria-label="Cut IQ Studio mobile home"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-brand-500/20 bg-[#111311] shadow-lg shadow-black/40">
              <img src="/brand/cut-iq-icon-green.svg" alt="" className="h-7 w-7" />
            </span>
            <span className="flex flex-col leading-none" aria-hidden="true">
              <span className="font-brand text-[13px] font-semibold tracking-[-0.035em] text-[#F7F8F5]">CUT IQ</span>
              <span className="mt-1 font-brand text-[7px] font-medium tracking-[0.36em] text-brand-500">STUDIO</span>
            </span>
          </Link>
          <span
            className={`ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium ${connected ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" : "border-amber-500/25 bg-amber-500/10 text-amber-200"}`}
            role="status"
          >
            {connected ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            {!online
              ? "Offline"
              : pc.isLoading
                ? "Checking PC"
                : connected
                  ? "PC connected"
                  : "PC unavailable"}
          </span>
        </div>
      </header>
      {!connected && !pc.isLoading && (
        <div className="sticky top-[calc(60px+env(safe-area-inset-top))] z-30 border-b border-amber-500/20 bg-amber-950/95 px-4 py-2 text-center text-xs text-amber-100">
          {online
            ? "Cut IQ PC unavailable — make sure the PC is awake and Tailscale is connected."
            : "Offline — running jobs continue on your Cut IQ PC."}
        </div>
      )}
      <main
        className={`mx-auto w-full max-w-lg px-4 pt-4 ${review ? "pb-6" : "pb-[calc(6.5rem+env(safe-area-inset-bottom))]"}`}
      >
        <Routes>
          <Route index element={<MobileDashboard mode="jobs" />} />
          <Route path="new" element={<MobileNewJob />} />
          <Route
            path="packages"
            element={<MobileDashboard mode="packages" />}
          />
          <Route path="package/:projectId" element={<MobilePackage />} />
          <Route path="review" element={<MobileReview />} />
          <Route path="more" element={<MobileMore />} />
          <Route path="*" element={<Navigate to="/m" replace />} />
        </Routes>
      </main>
      {!review && (
        <nav
          className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-[#0B0D0C]/96 px-2 pt-2 backdrop-blur-xl"
          aria-label="Mobile companion"
        >
          <div className="mx-auto grid max-w-lg grid-cols-4 gap-1">
            {links.map(([to, label, Icon]) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/m"}
                className={({ isActive }) =>
                  `flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl font-brand text-[11px] font-medium transition ${isActive ? "bg-brand-500/10 text-brand-300 ring-1 ring-brand-500/15" : "text-zinc-500"}`
                }
              >
                <Icon className="h-5 w-5" />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

export default function MobileApp() {
  return <Shell />;
}
