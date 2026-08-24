import { describe, expect, it } from "vitest";
import {
  createStudioExportPlan,
  resolveStudioShortcut,
  studioExportActions,
  summarizeStudioBasket,
  validateStudioDestination,
  type StudioBasketClip,
} from "./studioEditingBay";

const clips: StudioBasketClip[] = [
  { id: "late", label: "Late", inMs: 30_000, outMs: 35_000, selected: true },
  { id: "early", label: "Early", inMs: 10_000, outMs: 18_000, selected: true },
  { id: "unchecked", label: "Unchecked", inMs: 20_000, outMs: 24_000, selected: false },
];

describe("Transcript Studio editing-bay keyboard contract", () => {
  it("maps the full transport and marking set", () => {
    expect(resolveStudioShortcut({ key: " ", code: "Space" })).toBe("toggle-play");
    expect(resolveStudioShortcut({ key: "i" })).toBe("set-in");
    expect(resolveStudioShortcut({ key: "O" })).toBe("set-out");
    expect(resolveStudioShortcut({ key: "j" })).toBe("step-backward");
    expect(resolveStudioShortcut({ key: "K" })).toBe("pause");
    expect(resolveStudioShortcut({ key: "l" })).toBe("step-forward");
    expect(resolveStudioShortcut({ key: "Escape" })).toBe("dismiss");
  });

  it("routes transcript search without stealing shortcuts from editors or fields", () => {
    expect(resolveStudioShortcut({ key: "f", ctrlKey: true })).toBe("focus-search");
    expect(resolveStudioShortcut({ key: "F", metaKey: true })).toBe("focus-search");
    expect(resolveStudioShortcut({ key: "Enter", searchActive: true })).toBe("search-next");
    expect(resolveStudioShortcut({ key: "Enter", shiftKey: true, searchActive: true })).toBe("search-previous");
    expect(resolveStudioShortcut({ key: "i", editableTarget: true })).toBeNull();
    expect(resolveStudioShortcut({ key: "f", ctrlKey: true, editableTarget: true })).toBeNull();
    expect(resolveStudioShortcut({ key: "s", ctrlKey: true })).toBeNull();
  });
});

describe("Transcript Studio clip basket contract", () => {
  it("preserves visible basket order and computes the exact selection total", () => {
    const summary = summarizeStudioBasket(clips, 60_000);
    expect(summary.orderedClips.map((clip) => clip.id)).toEqual(["late", "early"]);
    expect(summary.selectedCount).toBe(2);
    expect(summary.totalDurationMs).toBe(13_000);
    expect(summary.modes).toEqual({ single: false, separate: true, join: true });
  });

  it("keeps manually arranged ordering stable and excludes unchecked clips", () => {
    const summary = summarizeStudioBasket([
      { id: "first", label: "First", inMs: 1_000, outMs: 2_000, selected: true },
      { id: "second", label: "Second", inMs: 1_000, outMs: 2_000, selected: true },
      { id: "off", label: "Off", inMs: 0, outMs: 900, selected: false },
    ], 10_000);
    expect(summary.orderedClips.map((clip) => clip.id)).toEqual(["first", "second"]);
  });

  it("reports invalid ranges instead of silently dropping them into a batch", () => {
    const invalid = [...clips, { id: "bad", label: "Bad", inMs: 50_000, outMs: 70_000, selected: true }];
    const summary = summarizeStudioBasket(invalid, 60_000);
    expect(summary.invalidClipIds).toEqual(["bad"]);
    expect(createStudioExportPlan(invalid, 60_000, "separate")).toMatchObject({ ok: false, error: "invalid-selection" });
  });

  it("supports one clip, separate-file batches, and basket-ordered joined exports", () => {
    expect(createStudioExportPlan([clips[1]], 60_000, "single")).toMatchObject({ ok: true, mode: "single" });
    expect(createStudioExportPlan(clips, 60_000, "separate")).toMatchObject({ ok: true, mode: "separate" });
    const joined = createStudioExportPlan(clips, 60_000, "join");
    expect(joined.ok && joined.clips.map((clip) => clip.id)).toEqual(["late", "early"]);
    expect(createStudioExportPlan([clips[1]], 60_000, "join")).toMatchObject({ ok: false, error: "join-requires-two" });
  });
});

describe("Transcript Studio export destination and recovery contract", () => {
  it("accepts arbitrary absolute drive and network-share folders", () => {
    expect(validateStudioDestination("C:/Users/Editor/Desktop/Quick Clips")).toEqual({
      ok: true,
      path: "C:\\Users\\Editor\\Desktop\\Quick Clips",
    });
    expect(validateStudioDestination("D:\\Client Work\\Game 1")).toEqual({
      ok: true,
      path: "D:\\Client Work\\Game 1",
    });
    expect(validateStudioDestination("\\\\edit-nas\\exports\\Cut IQ")).toEqual({
      ok: true,
      path: "\\\\edit-nas\\exports\\Cut IQ",
    });
    expect(validateStudioDestination("../outside")).toMatchObject({ ok: false, error: "not-absolute" });
  });

  it("exposes cancel, retry, and completed-file actions only in valid states", () => {
    expect(studioExportActions("rendering")).toEqual({ canCancel: true, canRetry: false, canOpen: false, canRemove: false });
    expect(studioExportActions("failed")).toEqual({ canCancel: false, canRetry: true, canOpen: false, canRemove: true });
    expect(studioExportActions("cancelled")).toEqual({ canCancel: false, canRetry: true, canOpen: false, canRemove: true });
    expect(studioExportActions("ready")).toEqual({ canCancel: false, canRetry: false, canOpen: true, canRemove: true });
  });
});
