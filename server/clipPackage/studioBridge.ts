import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  clipCandidates,
  clipJobs,
  clipPackageEditVersions,
  scriptProjects,
  scriptBeats,
  transcriptSegments,
  transcriptStudioExports,
  videos,
} from "@db/schema";
import { getDb } from "../queries/connection";

export type PackageEditIntent = "new_version" | "replacement";

type VersionRow = typeof clipPackageEditVersions.$inferSelect;
type StudioExportRow = typeof transcriptStudioExports.$inferSelect;

export interface PackageEditedVersionView {
  id: string;
  packageAssetId: string;
  projectId: number;
  candidateId: number;
  videoDbId: number;
  sourceClipJobId: number;
  studioExportId: number | null;
  studioDraftId: string | null;
  intent: PackageEditIntent;
  status: "draft" | "exporting" | "ready" | "failed" | "retired";
  progress: number;
  stage: string;
  label: string;
  activeReplacement: boolean;
  canActivate: boolean;
  activationPending: boolean;
  originalIn: number;
  originalOut: number;
  editIn: number;
  editOut: number;
  outputPath: string | null;
  downloadUrl: string | null;
  previewUrl: string | null;
  drivePath: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function parseStudioItems(raw: string): Array<{ draftId: string; label: string; inPoint: number; outPoint: number }> {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      if (typeof value.draftId !== "string" || typeof value.label !== "string") return [];
      if (typeof value.inPoint !== "number" || typeof value.outPoint !== "number") return [];
      return [{ draftId: value.draftId, label: value.label, inPoint: value.inPoint, outPoint: value.outPoint }];
    });
  } catch {
    return [];
  }
}

function parseOutputPaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

export function studioOutputForVersion(row: VersionRow, studio: StudioExportRow | null): string | null {
  if (!studio || studio.status !== "ready" || studio.mode !== "separate" || !row.studioDraftId) return null;
  const itemIndex = parseStudioItems(studio.items).findIndex((item) => item.draftId === row.studioDraftId);
  if (itemIndex < 0) return null;
  const output = parseOutputPaths(studio.outputPaths)[itemIndex] ?? null;
  return output && existsSync(output) && statSync(output).isFile() ? output : null;
}

function effectiveVersionStatus(row: VersionRow, studio: StudioExportRow | null, output: string | null) {
  if (row.status === "retired") return "retired" as const;
  if (!studio) return row.studioExportFk ? "failed" as const : "draft" as const;
  if (studio.status === "failed" || studio.status === "cancelled") return "failed" as const;
  if (studio.status === "ready") return output ? "ready" as const : "failed" as const;
  return "exporting" as const;
}

export function packageEditedVersionView(row: VersionRow, studio: StudioExportRow | null): PackageEditedVersionView {
  const output = studioOutputForVersion(row, studio);
  const status = effectiveVersionStatus(row, studio, output);
  const item = studio && row.studioDraftId
    ? parseStudioItems(studio.items).find((value) => value.draftId === row.studioDraftId) ?? null
    : null;
  const progress = status === "ready" ? 100 : status === "draft" ? 0 : Math.max(0, Math.min(100, studio?.progress ?? 0));
  const stage = status === "draft" ? "Not exported" : status === "ready" ? "Ready" : studio?.stage ?? status;
  return {
    id: row.id,
    packageAssetId: `version:${row.id}`,
    projectId: Number(row.projectFk),
    candidateId: Number(row.candidateFk),
    videoDbId: Number(row.sourceVideoFk),
    sourceClipJobId: Number(row.sourceClipJobFk),
    studioExportId: row.studioExportFk == null ? null : Number(row.studioExportFk),
    studioDraftId: row.studioDraftId,
    intent: row.intent,
    status,
    progress,
    stage,
    label: item?.label ?? studio?.title ?? "Revised clip",
    activeReplacement: row.activeReplacement && status === "ready",
    canActivate: status === "ready" && Boolean(output) && !row.activeReplacement,
    activationPending: row.intent === "replacement" && status === "ready" && !row.activeReplacement,
    originalIn: row.originalIn,
    originalOut: row.originalOut,
    editIn: row.editIn,
    editOut: row.editOut,
    outputPath: output,
    downloadUrl: output ? `/api/package-version/${encodeURIComponent(row.id)}?download=1` : null,
    previewUrl: output ? `/api/package-version/${encodeURIComponent(row.id)}` : null,
    drivePath: row.drivePath,
    error: studio?.error ?? (studio?.status === "ready" && !output ? "The edited MP4 is missing or was moved." : null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function handoffSeedRange(
  originalIn: number,
  originalOut: number,
  activeVersion: Pick<PackageEditedVersionView, "editIn" | "editOut" | "activeReplacement" | "status"> | null,
): { editIn: number; editOut: number } {
  if (activeVersion?.activeReplacement && activeVersion.status === "ready" && activeVersion.editOut > activeVersion.editIn) {
    return { editIn: activeVersion.editIn, editOut: activeVersion.editOut };
  }
  return { editIn: originalIn, editOut: originalOut };
}

async function studioById(id: number | null): Promise<StudioExportRow | null> {
  if (id == null) return null;
  const [studio] = await getDb().select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, id));
  return studio ?? null;
}

async function rowById(id: string): Promise<VersionRow> {
  const [row] = await getDb().select().from(clipPackageEditVersions).where(eq(clipPackageEditVersions.id, id));
  if (!row) throw new Error("That Clip Package edit handoff no longer exists.");
  return row;
}

export async function createStudioHandoff(input: {
  projectId: number;
  candidateId: number;
  intent: PackageEditIntent;
}) {
  const db = getDb();
  const [candidate] = await db
    .select()
    .from(clipCandidates)
    .where(and(eq(clipCandidates.id, input.candidateId), eq(clipCandidates.projectFk, input.projectId)));
  if (!candidate) throw new Error("That clip does not belong to this Clip Package.");
  if (candidate.videoFk == null) throw new Error("The original source video is not registered in Cut IQ.");

  const [sourceJob] = await db
    .select()
    .from(clipJobs)
    .where(and(
      eq(clipJobs.candidateFk, candidate.id),
      eq(clipJobs.projectFk, input.projectId),
      eq(clipJobs.status, "ready"),
    ))
    .orderBy(desc(clipJobs.id))
    .limit(1);
  if (!sourceJob?.outputPath || !existsSync(sourceJob.outputPath)) {
    throw new Error("The finished source clip is offline or missing.");
  }
  const [video] = await db.select().from(videos).where(eq(videos.id, candidate.videoFk));
  if (!video) throw new Error("The original source video is no longer registered in Cut IQ.");

  const originalIn = candidate.editIn ?? sourceJob.editIn;
  const originalOut = candidate.editOut ?? sourceJob.editOut;
  if (!(originalIn >= 0 && originalOut > originalIn + 0.05)) {
    throw new Error("The original clip does not have a valid editable source range.");
  }
  const activeVersion = (await listPackageEditedVersions(input.projectId))
    .find((version) => version.candidateId === input.candidateId && version.activeReplacement) ?? null;
  const seed = handoffSeedRange(originalIn, originalOut, activeVersion);
  const id = randomUUID();
  await db.insert(clipPackageEditVersions).values({
    id,
    projectFk: input.projectId,
    candidateFk: candidate.id,
    sourceVideoFk: video.id,
    sourceClipJobFk: sourceJob.id,
    intent: input.intent,
    originalIn,
    originalOut,
    editIn: seed.editIn,
    editOut: seed.editOut,
  });
  return studioHandoff(id);
}

export async function studioHandoff(id: string) {
  const db = getDb();
  const row = await rowById(id);
  const [candidate] = await db.select().from(clipCandidates).where(eq(clipCandidates.id, row.candidateFk));
  const [video] = await db.select().from(videos).where(eq(videos.id, row.sourceVideoFk));
  const [project] = await db.select({ name: scriptProjects.name }).from(scriptProjects).where(eq(scriptProjects.id, row.projectFk));
  const [beat] = candidate
    ? await db.select().from(scriptBeats).where(eq(scriptBeats.id, candidate.beatFk))
    : [];
  if (!candidate || Number(candidate.projectFk) !== Number(row.projectFk) || !video) {
    throw new Error("The original Clip Package lineage is no longer available.");
  }
  const [segment] = await db.select({ id: transcriptSegments.id })
    .from(transcriptSegments)
    .where(eq(transcriptSegments.videoFk, video.id))
    .limit(1);
  const studio = await studioById(row.studioExportFk == null ? null : Number(row.studioExportFk));
  const view = packageEditedVersionView(row, studio);
  return {
    handoffId: row.id,
    projectId: Number(row.projectFk),
    projectName: project?.name ?? `Project ${Number(row.projectFk)}`,
    candidateId: Number(row.candidateFk),
    videoDbId: Number(row.sourceVideoFk),
    sourceClipJobId: Number(row.sourceClipJobFk),
    sourceUrl: video.url,
    sourceTitle: video.title,
    transcriptAvailable: Boolean(segment),
    originalIn: row.originalIn,
    originalOut: row.originalOut,
    suggestedIn: row.editIn,
    suggestedOut: row.editOut,
    transcriptExcerpt: candidate.transcriptExcerpt,
    transcriptSegmentStart: candidate.segStart,
    transcriptSegmentEnd: candidate.segEnd,
    beatText: beat?.text ?? "",
    selectionKind: candidate.reason?.startsWith("Player-action play sequence")
      ? "player_play"
      : candidate.reason?.startsWith("Broadcast sound bite")
        ? "broadcast_soundbite"
        : "other",
    intent: row.intent,
    status: view.status,
    studioExportId: view.studioExportId,
    studioDraftId: view.studioDraftId,
    activeReplacement: view.activeReplacement,
    version: view,
  };
}

export async function attachStudioExport(input: { handoffId: string; studioExportId: number; draftId: string }) {
  const db = getDb();
  const row = await rowById(input.handoffId);
  if (row.studioExportFk != null) throw new Error("This handoff is already attached to a Manual Studio export.");
  const [studio] = await db.select().from(transcriptStudioExports).where(eq(transcriptStudioExports.id, input.studioExportId));
  if (!studio || Number(studio.videoFk) !== Number(row.sourceVideoFk)) {
    throw new Error("The Manual Studio export does not belong to this handoff's original source.");
  }
  if (studio.mode !== "separate") throw new Error("A Clip Package version must be exported as a separate MP4.");
  const items = parseStudioItems(studio.items);
  const item = items.find((value) => value.draftId === input.draftId);
  if (!item) throw new Error("That Studio draft is not part of the selected export.");
  if (!(item.inPoint >= 0 && item.outPoint > item.inPoint + 0.05)) throw new Error("The edited Studio range is invalid.");
  const status = studio.status === "ready"
    ? (studioOutputForVersion({ ...row, studioDraftId: input.draftId } as VersionRow, studio) ? "ready" : "failed")
    : studio.status === "failed" || studio.status === "cancelled"
      ? "failed"
      : "exporting";
  await db.update(clipPackageEditVersions).set({
    studioExportFk: studio.id,
    studioDraftId: input.draftId,
    editIn: item.inPoint,
    editOut: item.outPoint,
    status,
  }).where(eq(clipPackageEditVersions.id, row.id));
  const updated = await rowById(row.id);
  return { ok: true as const, version: packageEditedVersionView(updated, studio) };
}

export async function setStudioHandoffIntent(id: string, intent: PackageEditIntent) {
  const row = await rowById(id);
  if (row.status === "retired" || row.activeReplacement) {
    throw new Error("A retired or active package version cannot change save mode.");
  }
  await getDb().update(clipPackageEditVersions).set({ intent }).where(eq(clipPackageEditVersions.id, id));
  return studioHandoff(id);
}

/**
 * Persist a package-edit draft without touching the Find Clips candidate or
 * its verified source clip. This makes phone/desktop handoffs resumable before
 * a revised MP4 has been rendered.
 */
export async function saveStudioHandoffDraft(input: {
  id: string;
  editIn: number;
  editOut: number;
  expectedEditIn: number;
  expectedEditOut: number;
  expectedIntent: PackageEditIntent;
}) {
  const row = await rowById(input.id);
  if (row.status !== "draft" || row.studioExportFk != null) {
    throw new Error("This revision is already rendering or finished and can no longer be edited.");
  }
  if (!Number.isFinite(input.editIn) || !Number.isFinite(input.editOut) || input.editIn < 0 || input.editOut <= input.editIn + 0.05) {
    throw new Error("Choose a valid IN and OUT range before saving.");
  }
  const [video] = await getDb().select({ durationSec: videos.durationSec }).from(videos).where(eq(videos.id, row.sourceVideoFk));
  if (video?.durationSec != null && input.editOut > video.durationSec + 0.25) {
    throw new Error("The OUT point is beyond the end of the source video.");
  }
  const result = await getDb().update(clipPackageEditVersions).set({
    editIn: input.editIn,
    editOut: input.editOut,
  }).where(and(
    eq(clipPackageEditVersions.id, row.id),
    eq(clipPackageEditVersions.status, "draft"),
    isNull(clipPackageEditVersions.studioExportFk),
    eq(clipPackageEditVersions.editIn, input.expectedEditIn),
    eq(clipPackageEditVersions.editOut, input.expectedEditOut),
    eq(clipPackageEditVersions.intent, input.expectedIntent),
  ));
  // better-sqlite3 reports affected rows as `changes`.
  if (result.changes !== 1) {
    throw new Error("This clip was changed on another device. Refresh before saving again.");
  }
  return studioHandoff(row.id);
}

export async function editedVersion(id: string): Promise<PackageEditedVersionView> {
  const row = await rowById(id);
  const studio = await studioById(row.studioExportFk == null ? null : Number(row.studioExportFk));
  const view = packageEditedVersionView(row, studio);
  if (view.status !== row.status && row.status !== "retired") {
    await getDb().update(clipPackageEditVersions).set({ status: view.status }).where(eq(clipPackageEditVersions.id, id));
  }
  return view;
}

export async function activateEditedVersion(id: string): Promise<PackageEditedVersionView> {
  const row = await rowById(id);
  const ready = await editedVersion(id);
  if (ready.status !== "ready" || !ready.outputPath) {
    throw new Error("The edited MP4 must finish rendering and verification before it can replace the package clip.");
  }
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(clipPackageEditVersions).set({ activeReplacement: false })
      .where(and(
        eq(clipPackageEditVersions.projectFk, row.projectFk),
        eq(clipPackageEditVersions.candidateFk, row.candidateFk),
      ));
    await tx.update(clipPackageEditVersions).set({ activeReplacement: true, intent: "replacement", status: "ready" })
      .where(eq(clipPackageEditVersions.id, row.id));
  });
  return editedVersion(id);
}

export async function revertEditedReplacement(projectId: number, candidateId: number) {
  await getDb().update(clipPackageEditVersions).set({ activeReplacement: false })
    .where(and(
      eq(clipPackageEditVersions.projectFk, projectId),
      eq(clipPackageEditVersions.candidateFk, candidateId),
    ));
  return { ok: true as const };
}

export async function listPackageEditedVersions(projectId: number): Promise<PackageEditedVersionView[]> {
  const db = getDb();
  const rows = await db.select().from(clipPackageEditVersions)
    .where(eq(clipPackageEditVersions.projectFk, projectId))
    .orderBy(desc(clipPackageEditVersions.createdAt));
  const result: PackageEditedVersionView[] = [];
  for (const row of rows) {
    const studio = await studioById(row.studioExportFk == null ? null : Number(row.studioExportFk));
    result.push(packageEditedVersionView(row, studio));
  }
  return result;
}

export async function packageEditedVersionOutput(id: string): Promise<string> {
  const view = await editedVersion(id);
  if (view.status !== "ready" || !view.outputPath) throw new Error("The edited package MP4 is not available.");
  return view.outputPath;
}

export async function setEditedVersionDrivePath(id: string, drivePath: string): Promise<void> {
  const row = await rowById(id);
  const view = await editedVersion(id);
  if (view.status !== "ready") throw new Error("Only a ready edited version can be synced to Drive.");
  await getDb().update(clipPackageEditVersions).set({ drivePath }).where(eq(clipPackageEditVersions.id, row.id));
}
