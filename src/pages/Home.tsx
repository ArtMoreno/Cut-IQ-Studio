import { Navigate, useSearchParams } from "react-router";
import ScriptProjects from "@/components/script/ScriptProjects";

/**
 * Find Clips is Cut IQ's durable project home. The former Single Video page
 * duplicated Manual Clip Studio and is intentionally retired from navigation.
 * Existing `?mode=script&project=…` deep links remain valid; the explicit
 * legacy `?mode=video` entry hands off to the canonical manual cutter.
 */
export default function Home() {
  const [params] = useSearchParams();
  if (params.get("mode") === "video") return <Navigate to="/transcript-studio" replace />;

  const rawProjectId = params.get("project");
  const projectId = rawProjectId && Number.isFinite(Number(rawProjectId)) ? Number(rawProjectId) : undefined;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <ScriptProjects initialProjectId={projectId} />
    </div>
  );
}
