import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { AppNav } from "@/components/AppNav";
import { NewFindClipsJobForm, type SavedProjectDraft } from "@/components/findClips/NewJobDialog";

export default function NewFindClipsJob() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialDraft = (location.state as { initialDraft?: SavedProjectDraft } | null)?.initialDraft;
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#08090b] text-zinc-100">
      <AppNav
        active="find"
        actions={<Link to="/" className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> Jobs</Link>}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1380px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          <div className="mb-6 max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-brand-400">Find Clips · New job</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Start a new Cut IQ pipeline</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">Give Cut IQ the player, team, season, and any priority games. Add a script when you have one, or let Cut IQ build the football coverage plan automatically.</p>
          </div>
          <NewFindClipsJobForm initialDraft={initialDraft} onCreated={(projectId) => navigate(`/?project=${projectId}`)} />
        </div>
      </main>
    </div>
  );
}
