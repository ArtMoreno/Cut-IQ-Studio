import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { handoffSeedRange, packageEditedVersionView, studioOutputForVersion } from "./studioBridge";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectFk: 7,
    candidateFk: 9,
    sourceVideoFk: 11,
    sourceClipJobFk: 13,
    studioExportFk: 15,
    studioDraftId: "package-draft",
    intent: "new_version",
    status: "exporting",
    activeReplacement: false,
    originalIn: 120,
    originalOut: 150,
    editIn: 115,
    editOut: 165,
    drivePath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

function studio(outputPath: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 15,
    videoFk: 11,
    mode: "separate",
    title: "Revised clip",
    items: JSON.stringify([{ draftId: "package-draft", label: "Revised clip", inPoint: 115, outPoint: 165 }]),
    outputDir: tmpdir(),
    status: "ready",
    progress: 100,
    stage: "Ready",
    outputPaths: JSON.stringify([outputPath]),
    outputPath,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as never;
}

describe("Clip Package edited version output binding", () => {
  it("resolves only the exact verified Studio draft output", () => {
    const directory = mkdtempSync(join(tmpdir(), "clipsift-package-version-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "revised.mp4");
    writeFileSync(output, "verified-output");

    expect(studioOutputForVersion(version(), studio(output))).toBe(output);
    expect(studioOutputForVersion(version({ studioDraftId: "different-draft" }), studio(output))).toBeNull();
  });

  it("rejects unfinished, joined, missing, and moved Studio outputs", () => {
    const missing = join(tmpdir(), `missing-${Date.now()}.mp4`);
    expect(studioOutputForVersion(version(), studio(missing))).toBeNull();
    expect(studioOutputForVersion(version(), studio(missing, { status: "rendering" }))).toBeNull();
    expect(studioOutputForVersion(version(), studio(missing, { mode: "joined" }))).toBeNull();
    expect(studioOutputForVersion(version(), null)).toBeNull();
  });

  it("hydrates durable render progress, stage, and replacement intent", () => {
    const rendering = packageEditedVersionView(
      version({ intent: "replacement" }),
      studio("not-ready.mp4", { status: "rendering", progress: 42, stage: "Rendering clip 1 of 1" }),
    );
    expect(rendering).toMatchObject({
      intent: "replacement",
      status: "exporting",
      progress: 42,
      stage: "Rendering clip 1 of 1",
      activeReplacement: false,
      canActivate: false,
    });
  });

  it("seeds a re-edit from the active revision while retaining caller-owned original timing", () => {
    expect(handoffSeedRange(120, 150, {
      editIn: 112,
      editOut: 168,
      activeReplacement: true,
      status: "ready",
    })).toEqual({ editIn: 112, editOut: 168 });
    expect(handoffSeedRange(120, 150, {
      editIn: 112,
      editOut: 168,
      activeReplacement: false,
      status: "ready",
    })).toEqual({ editIn: 120, editOut: 150 });
  });
});
