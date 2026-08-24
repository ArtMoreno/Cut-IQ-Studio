import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { fmtTime } from "@/lib/youtube";
import { Star, Archive, Trash2, FolderPlus, Folder, RotateCcw, Search as SearchIcon } from "lucide-react";

interface Props {
  onOpen: (videoDbId: number) => void;
  currentVideoDbId?: number;
}

export function LibraryPanel({ onOpen, currentVideoDbId }: Props) {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<"all" | "recent" | "favorites" | "archived">("all");
  const [sort, setSort] = useState<"recent" | "added" | "title">("recent");
  const [projectId, setProjectId] = useState<number | undefined>();
  const [q, setQ] = useState("");
  const [newProject, setNewProject] = useState("");

  const { data: list = [] } = trpc.clipsift.library.useQuery({ filter, sort, projectId });
  const { data: projects = [] } = trpc.clipsift.listProjects.useQuery();
  const updateVideo = trpc.clipsift.updateVideo.useMutation({ onSuccess: () => utils.clipsift.library.invalidate() });
  const deleteVideo = trpc.clipsift.deleteVideo.useMutation({ onSuccess: () => utils.clipsift.library.invalidate() });
  const createProject = trpc.clipsift.createProject.useMutation({
    onSuccess: () => { utils.clipsift.listProjects.invalidate(); setNewProject(""); },
  });
  const deleteProject = trpc.clipsift.deleteProject.useMutation({ onSuccess: () => { utils.clipsift.listProjects.invalidate(); setProjectId(undefined); } });

  const shown = list.filter((v) => !q || (v.title ?? "").toLowerCase().includes(q.toLowerCase()) || (v.channel ?? "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-zinc-800 p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library…" className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none focus:border-brand-500" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "recent", "favorites", "archived"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-2.5 py-1 text-xs capitalize ${filter === f ? "bg-brand-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
              {f}
            </button>
          ))}
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
            <option value="recent">Last opened</option>
            <option value="added">Date added</option>
            <option value="title">Title</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setProjectId(undefined)} className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${projectId == null ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400"}`}>
            <Folder className="h-3 w-3" /> All projects
          </button>
          {projects.map((p) => (
            <button key={p.id} onClick={() => setProjectId(p.id)} onDoubleClick={() => { if (confirm(`Delete project “${p.name}”? Videos are kept.`)) deleteProject.mutate({ id: p.id }); }} className={`rounded-full px-2.5 py-1 text-xs ${projectId === p.id ? "bg-zinc-700 text-white" : "bg-zinc-800 text-zinc-400"}`} title="Double-click to delete">
              {p.name}
            </button>
          ))}
          <input value={newProject} onChange={(e) => setNewProject(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newProject.trim() && createProject.mutate({ name: newProject.trim() })} placeholder="+ New project" className="w-28 rounded-full border border-dashed border-zinc-700 bg-transparent px-2.5 py-1 text-xs text-zinc-300 outline-none focus:border-brand-500" />
          {newProject.trim() && (
            <button onClick={() => createProject.mutate({ name: newProject.trim() })} className="rounded-full bg-zinc-800 p-1 text-zinc-300">
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {shown.length === 0 && <p className="p-2 text-sm text-zinc-500">Nothing here yet. Open a video to add it to your library.</p>}
        {shown.map((v) => (
          <div key={v.id} className={`flex gap-3 rounded-lg border p-2.5 ${v.id === currentVideoDbId ? "border-brand-500/60 bg-brand-500/5" : "border-zinc-800 bg-zinc-900"}`}>
            <button onClick={() => onOpen(v.id)} className="shrink-0">
              {v.thumbnail ? (
                <img src={v.thumbnail} alt="" className="h-16 w-28 rounded-md object-cover" loading="lazy" />
              ) : (
                <div className="flex h-16 w-28 items-center justify-center rounded-md bg-zinc-800 text-xs text-zinc-500">No thumb</div>
              )}
            </button>
            <div className="min-w-0 flex-1">
              <button onClick={() => onOpen(v.id)} className="block w-full truncate text-left text-sm font-medium text-zinc-200 hover:text-white">
                {v.title ?? v.videoId}
              </button>
              <p className="truncate text-xs text-zinc-500">{v.channel ?? "Unknown channel"}</p>
              <p className="mt-0.5 text-[11px] text-zinc-600">
                {v.transcriptKind === "none" ? "No transcript" : v.transcriptKind === "imported" ? "Imported transcript" : `${v.transcriptKind === "auto" ? "Auto-generated" : "Manual"} captions${v.transcriptLang ? ` · ${v.transcriptLang}` : ""}`}
                {v.lastPosition > 0 && ` · resume ${fmtTime(v.lastPosition)}`}
              </p>
              <div className="mt-1.5 flex items-center gap-1">
                <button onClick={() => updateVideo.mutate({ id: v.id, favorite: !v.favorite })} className={`rounded p-1 hover:bg-zinc-800 ${v.favorite ? "text-amber-400" : "text-zinc-500"}`} title="Favorite">
                  <Star className="h-3.5 w-3.5" fill={v.favorite ? "currentColor" : "none"} />
                </button>
                <button onClick={() => updateVideo.mutate({ id: v.id, archived: !v.archived })} className="rounded p-1 text-zinc-500 hover:bg-zinc-800" title={v.archived ? "Unarchive" : "Archive"}>
                  {v.archived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                </button>
                <select
                  value={v.projectId ?? ""}
                  onChange={(e) => updateVideo.mutate({ id: v.id, projectId: e.target.value ? Number(e.target.value) : null })}
                  className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-[11px] text-zinc-400"
                >
                  <option value="">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={() => { if (confirm(`Delete “${v.title ?? v.videoId}” and its saved moments? This cannot be undone.`)) deleteVideo.mutate({ id: v.id }); }} className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400" title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
