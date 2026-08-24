import { Navigate, useSearchParams } from "react-router";
import { InlineError, InlineLoading } from "@/components/InlineState";
import { trpc } from "@/providers/trpc";

export default function LegacyAssembleRedirect() {
  const [params] = useSearchParams();
  const legacyProjectId = Number(params.get("project"));
  const open = trpc.assemble.open.useQuery(
    { id: legacyProjectId },
    { enabled: Number.isSafeInteger(legacyProjectId) && legacyProjectId > 0, retry: false },
  );

  if (!Number.isSafeInteger(legacyProjectId) || legacyProjectId <= 0) return <Navigate to="/" replace />;
  if (open.isLoading) return <div className="flex h-dvh items-center justify-center bg-zinc-950"><InlineLoading label="Opening finished clips…" /></div>;
  if (open.data?.sourceProjectFk) return <Navigate to={`/clip-package?project=${open.data.sourceProjectFk}`} replace />;
  return (
    <div className="flex h-dvh items-center justify-center bg-zinc-950 p-6">
      <InlineError title="This old Assemble link has no Find Clips source" message="Open a completed Find Clips project to view its finished clip package." />
    </div>
  );
}
