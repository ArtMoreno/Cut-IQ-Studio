export const FIND_CLIPS_STAGES = [
  { id: "analyzing", label: "Analyze script", start: 0, end: 15 },
  { id: "discovering", label: "Discover sources", start: 15, end: 30 },
  { id: "transcripts", label: "Get transcripts", start: 30, end: 60 },
  { id: "ranking", label: "Rank candidates", start: 60, end: 70 },
  { id: "extracting", label: "Queue clips", start: 70, end: 80 },
  { id: "verifying", label: "Download and verify", start: 80, end: 99 },
  { id: "complete", label: "Complete", start: 100, end: 100 },
] as const;

export type FindClipsProgressStage = (typeof FIND_CLIPS_STAGES)[number]["id"];

export function progressForStage(stage: string, fraction = 0): number {
  const definition = FIND_CLIPS_STAGES.find((candidate) => candidate.id === stage);
  if (!definition) return stage === "queued" ? 0 : 0;
  if (definition.id === "complete") return 100;
  const bounded = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return Math.round((definition.start + (definition.end - definition.start) * bounded) * 10) / 10;
}

export function stageSummary(stage: string): { label: string; current: number; total: number } {
  const activeIndex = FIND_CLIPS_STAGES.findIndex((candidate) => candidate.id === stage);
  if (activeIndex < 0) return { label: stage === "queued" ? "Waiting to start" : stage.replaceAll("_", " "), current: 0, total: 6 };
  if (stage === "complete") return { label: "Complete", current: 6, total: 6 };
  return { label: FIND_CLIPS_STAGES[activeIndex]!.label, current: activeIndex + 1, total: 6 };
}
