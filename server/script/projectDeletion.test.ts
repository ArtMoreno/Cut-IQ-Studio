import { describe, expect, it } from "vitest";
import { parseStudioOutputPaths, pathIsInside, rclonePurgeTargetIsAlreadyAbsent } from "./projectDeletion";

describe("project deletion safety", () => {
  it("accepts managed descendants but rejects roots and sibling paths", () => {
    expect(pathIsInside("D:/Clips", "D:/Clips/project-1/clip.mp4")).toBe(true);
    expect(pathIsInside("D:/Clips", "D:/Clips")).toBe(false);
    expect(pathIsInside("D:/Clips", "D:/Clips-archive/clip.mp4")).toBe(false);
    expect(pathIsInside("D:/Clips", "D:/Other/clip.mp4")).toBe(false);
  });

  it("collects and deduplicates persisted Studio output paths", () => {
    expect(parseStudioOutputPaths({
      outputPath: "D:/Clips/edited/one.mp4",
      outputPaths: JSON.stringify(["D:/Clips/edited/one.mp4", "D:/Clips/edited/two.mp4"]),
    })).toEqual(["D:/Clips/edited/one.mp4", "D:/Clips/edited/two.mp4"]);
  });

  it("does not turn malformed historic JSON into deletion targets", () => {
    expect(parseStudioOutputPaths({ outputPath: null, outputPaths: "not-json" })).toEqual([]);
  });

  it("treats a missing rclone purge target as already deleted", () => {
    expect(rclonePurgeTargetIsAlreadyAbsent(
      "ERROR : Attempt 3/3 failed with 1 errors and: directory not found\nNOTICE: Failed to purge: directory not found",
    )).toBe(true);
  });

  it("does not hide real rclone failures", () => {
    expect(rclonePurgeTargetIsAlreadyAbsent("ERROR : couldn't connect to Google Drive: access denied")).toBe(false);
  });
});
