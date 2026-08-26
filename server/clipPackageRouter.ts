import { z } from "zod";
import { createRouter, proProcedure, publicQuery } from "./middleware";
import { pickOutputDirectory } from "./transcriptStudio/desktopPicker";
import {
  cancelClipPackageExport,
  defaultClipPackageOutputDir,
  getClipPackageExport,
  openClipPackage,
  openClipPackageDriveFolder,
  openClipPackageOutput,
  queueClipPackageExport,
  syncClipPackageToLocalDrive,
} from "./clipPackage/exportEngine";
import { queueBroadcastSoundbites } from "./clipPackage/soundbites";
import {
  activateEditedVersion,
  attachStudioExport,
  createStudioHandoff,
  editedVersion,
  revertEditedReplacement,
  setStudioHandoffIntent,
  saveStudioHandoffDraft,
  studioHandoff,
} from "./clipPackage/studioBridge";

export const clipPackageRouter = createRouter({
  open: publicQuery
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(({ input }) => openClipPackage(input.projectId)),

  outputConfig: publicQuery.query(() => ({
    outputDir: defaultClipPackageOutputDir(),
    supportsArbitraryWindowsPath: true,
  })),

  chooseOutputDirectory: publicQuery.mutation(async () => ({
    path: await pickOutputDirectory(),
  })),

  createStudioHandoff: publicQuery
    .input(
      z.object({
        projectId: z.number().int().positive(),
        candidateId: z.number().int().positive(),
        intent: z.enum(["new_version", "replacement"]).default("new_version"),
      })
    )
    .mutation(({ input }) => createStudioHandoff(input)),

  studioHandoff: publicQuery
    .input(z.object({ handoffId: z.string().uuid() }))
    .query(({ input }) => studioHandoff(input.handoffId)),

  setStudioHandoffIntent: publicQuery
    .input(
      z.object({
        handoffId: z.string().uuid(),
        intent: z.enum(["new_version", "replacement"]),
      })
    )
    .mutation(({ input }) =>
      setStudioHandoffIntent(input.handoffId, input.intent)
    ),

  saveStudioHandoffDraft: publicQuery
    .input(
      z.object({
        handoffId: z.string().uuid(),
        editIn: z.number().finite().min(0),
        editOut: z.number().finite().min(0),
        expectedEditIn: z.number().finite().min(0),
        expectedEditOut: z.number().finite().min(0),
        expectedIntent: z.enum(["new_version", "replacement"]),
      })
    )
    .mutation(({ input }) =>
      saveStudioHandoffDraft({
        id: input.handoffId,
        editIn: input.editIn,
        editOut: input.editOut,
        expectedEditIn: input.expectedEditIn,
        expectedEditOut: input.expectedEditOut,
        expectedIntent: input.expectedIntent,
      })
    ),

  attachStudioExport: publicQuery
    .input(
      z.object({
        handoffId: z.string().uuid(),
        studioExportId: z.number().int().positive(),
        draftId: z.string().min(1).max(120),
      })
    )
    .mutation(({ input }) => attachStudioExport(input)),

  editedVersion: publicQuery
    .input(z.object({ versionId: z.string().uuid() }))
    .query(({ input }) => editedVersion(input.versionId)),

  activateEditedVersion: publicQuery
    .input(z.object({ versionId: z.string().uuid() }))
    .mutation(({ input }) => activateEditedVersion(input.versionId)),

  revertEditedReplacement: publicQuery
    .input(
      z.object({
        projectId: z.number().int().positive(),
        candidateId: z.number().int().positive(),
      })
    )
    .mutation(({ input }) =>
      revertEditedReplacement(input.projectId, input.candidateId)
    ),

  // Pro: delivery. Reviewing and opening a package stays free; producing the
  // packaged output, the soundbite set, or a Drive sync is the paid step.
  syncToDrive: proProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .mutation(({ input }) => syncClipPackageToLocalDrive(input.projectId)),

  openDriveFolder: publicQuery
    .input(z.object({ projectId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      if (!(await openClipPackageDriveFolder(input.projectId))) {
        throw new Error(
          "The synced Google Drive project folder is not available yet."
        );
      }
      return { ok: true };
    }),

  queueSoundbites: proProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        targetCount: z.number().int().min(1).max(24).default(8),
      })
    )
    .mutation(({ input }) =>
      queueBroadcastSoundbites(input.projectId, input.targetCount)
    ),

  queueExport: proProcedure
    .input(
      z
        .object({
          projectId: z.number().int().positive(),
          mode: z.enum(["separate", "joined"]),
          candidateIds: z
            .array(z.number().int().positive())
            .min(1)
            .max(100)
            .optional(),
          assetIds: z
            .array(z.string().min(1).max(128))
            .min(1)
            .max(100)
            .optional(),
          outputDir: z.string().min(3).max(4096).optional(),
          title: z.string().min(1).max(255).optional(),
        })
        .refine(
          input =>
            Boolean(input.candidateIds?.length || input.assetIds?.length),
          {
            message: "Choose at least one package clip or saved copy.",
            path: ["assetIds"],
          }
        )
    )
    .mutation(({ input }) => queueClipPackageExport(input)),

  exportJob: publicQuery
    .input(z.object({ id: z.string().uuid() }))
    .query(({ input }) => getClipPackageExport(input.id)),

  cancelExport: publicQuery
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => ({ ok: cancelClipPackageExport(input.id) })),

  openOutput: publicQuery
    .input(
      z.object({ id: z.string().uuid(), target: z.enum(["file", "folder"]) })
    )
    .mutation(({ input }) => {
      if (!openClipPackageOutput(input.id, input.target))
        throw new Error("This exported MP4 is no longer available.");
      return { ok: true };
    }),
});
