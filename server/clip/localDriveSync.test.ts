import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyMp4ToLocalGoogleDrive,
  localDriveProjectFolder,
  safeDriveFileName,
  safeDriveProjectName,
} from "./localDriveSync";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clipsift-drive-sync-"));
  temporaryRoots.push(root);
  return root;
}

describe("local Google Drive desktop sync", () => {
  it("creates a stable CapCut-friendly project and MP4 name", () => {
    expect(safeDriveProjectName("Bear Bachmeier • BYU • 2025")).toBe("Bear Bachmeier - BYU - 2025");
    expect(safeDriveFileName("4th & 7: touchdown?.webm")).toBe("4th & 7- touchdown-.mp4");
  });

  it("keeps the project folder inside the configured Drive root", async () => {
    const root = await temporaryRoot();
    expect(localDriveProjectFolder(root, "../Bear • 2025")).toBe(join(root, "- Bear - 2025"));
  });

  it("copies finished MP4s, verifies them, and never overwrites a collision", async () => {
    const root = await temporaryRoot();
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    await mkdir(sourceA);
    await mkdir(sourceB);
    const firstSource = join(sourceA, "Touchdown.mp4");
    const secondSource = join(sourceB, "Touchdown.mp4");
    await writeFile(firstSource, Buffer.from("first finished clip"));
    await writeFile(secondSource, Buffer.from("second finished clip with a different size"));

    const firstTarget = await copyMp4ToLocalGoogleDrive({ sourcePath: firstSource, projectName: "Bear • BYU • 2025", root });
    const repeatedTarget = await copyMp4ToLocalGoogleDrive({ sourcePath: firstSource, projectName: "Bear • BYU • 2025", root });
    const secondTarget = await copyMp4ToLocalGoogleDrive({ sourcePath: secondSource, projectName: "Bear • BYU • 2025", root });

    expect(repeatedTarget).toBe(firstTarget);
    expect(secondTarget).not.toBe(firstTarget);
    expect(await readFile(firstTarget, "utf8")).toBe("first finished clip");
    expect(await readFile(secondTarget, "utf8")).toBe("second finished clip with a different size");
  });
});
