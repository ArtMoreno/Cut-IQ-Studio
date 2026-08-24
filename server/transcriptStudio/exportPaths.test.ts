import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalLocalVideoPath,
  canonicalWindowsDirectory,
  safeStudioFileStem,
  uniqueMp4Path,
} from "./exportPaths";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Transcript Studio export paths", () => {
  it("requires normal absolute Windows destinations", () => {
    expect(() => canonicalWindowsDirectory("relative/exports")).toThrow(/absolute Windows folder/i);
    expect(() => canonicalWindowsDirectory("\\\\.\\pipe\\clipsift")).toThrow(/normal local or network folder/i);
    expect(canonicalWindowsDirectory("E:\\Client Exports")).toBe("E:\\Client Exports");
  });

  it("sanitizes filenames and never overwrites an existing MP4", () => {
    const directory = mkdtempSync(join(tmpdir(), "clipsift-studio-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "Interview Clip.mp4"), "existing");
    expect(safeStudioFileStem('Interview: <Clip> / 1')).toBe("Interview Clip 1");
    expect(uniqueMp4Path(directory, "Interview Clip")).toBe(join(directory, "Interview Clip-2.mp4"));
  });

  it("accepts only existing supported local video files", () => {
    const directory = mkdtempSync(join(tmpdir(), "clipsift-studio-"));
    temporaryDirectories.push(directory);
    const video = join(directory, "source.mp4");
    writeFileSync(video, "fixture");
    expect(canonicalLocalVideoPath(video)).toBe(video);
    expect(() => canonicalLocalVideoPath(join(directory, "notes.txt"))).toThrow(/MP4, MOV, MKV/i);
  });
});
