import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("Transcript Studio process isolation", () => {
  it("does not enter the shared clip worker or mutate Find Clips records", () => {
    const studioSources = [
      "server/transcriptStudioRouter.ts",
      "server/transcriptStudio/exportEngine.ts",
      "server/transcriptStudio/exportPaths.ts",
      "server/transcriptStudio/desktopPicker.ts",
    ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
    const executableStudioSources = withoutComments(studioSources);

    for (const forbiddenIdentifier of [
      "clipJobs",
      "moments",
      "enqueueClip",
      "findJobs",
      "findJobSources",
      "findJobTranscripts",
      "clipCandidates",
      "findClipAssociations",
    ]) {
      expect(executableStudioSources).not.toMatch(new RegExp(`\\b${forbiddenIdentifier}\\b`));
    }
  });

  it("does not let Find Clips depend on Transcript Studio records or export code", () => {
    const findSources = [
      "server/findClipsRouter.ts",
      "server/findClips/engine.ts",
      "server/findClips/progress.ts",
    ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");

    expect(findSources).not.toMatch(/\btranscriptStudioSessions\b/);
    expect(findSources).not.toMatch(/\btranscriptStudioSegmentEdits\b/);
    expect(findSources).not.toMatch(/\btranscriptStudioExports\b/);
    expect(findSources).not.toMatch(/transcriptStudio\/exportEngine/);
  });

  it("keeps the Clip Package Studio bridge read-only toward Find Clips truth", () => {
    const bridge = withoutComments(readFileSync(resolve(process.cwd(), "server/clipPackage/studioBridge.ts"), "utf8"));
    const packageRouter = withoutComments(readFileSync(resolve(process.cwd(), "server/clipPackageRouter.ts"), "utf8"));

    expect(bridge).not.toMatch(/\.update\(\s*(clipCandidates|clipJobs|findJobs|findJobSources|findJobTranscripts)\s*\)/);
    expect(bridge).not.toMatch(/\.delete\(\s*(clipCandidates|clipJobs|findJobs|findJobSources|findJobTranscripts)\s*\)/);
    expect(bridge).not.toMatch(/\.insert\(\s*(clipCandidates|clipJobs|findJobs|findJobSources|findJobTranscripts)\s*\)/);
    expect(bridge).toMatch(/\.insert\(clipPackageEditVersions\)/);
    expect(packageRouter).toMatch(/handoffId:\s*z\.string\(\)\.uuid\(\)/);
  });
});
