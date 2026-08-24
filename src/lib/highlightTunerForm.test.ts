import { describe, expect, it } from "vitest";
import {
  defaultHighlightTunerFormValue,
  highlightTunerPreset,
  normalizeHighlightTunerDraft,
} from "../components/findClips/highlightTunerForm";

describe("highlight tuner form settings", () => {
  it("defaults to legacy-preserving Everything mode", () => {
    expect(defaultHighlightTunerFormValue()).toMatchObject({ mode: "everything", includeProbablePlays: true });
  });

  it("provides stable presets for each filtered mode", () => {
    expect(highlightTunerPreset("balanced")).toMatchObject({ maxClipsPerGame: 8, minimumEstimatedYards: 5 });
    expect(highlightTunerPreset("highlights")).toMatchObject({ maxClipsPerGame: 5, minimumEstimatedYards: 10 });
    expect(highlightTunerPreset("best_only")).toMatchObject({ maxClipsPerGame: 3, minimumEstimatedYards: 15 });
  });

  it("normalizes old, invalid, and custom saved drafts safely", () => {
    expect(normalizeHighlightTunerDraft()).toEqual(defaultHighlightTunerFormValue());
    expect(normalizeHighlightTunerDraft({ mode: "custom", maxClipsPerGame: 4, minimumEstimatedYards: 12 })).toMatchObject({
      mode: "custom",
      maxClipsPerGame: 4,
      minimumEstimatedYards: 12,
      alwaysIncludeTouchdowns: true,
    });
    expect(normalizeHighlightTunerDraft({ mode: "custom", maxClipsPerGame: 51, minimumExcitement: 100 })).toMatchObject({
      maxClipsPerGame: 5,
      minimumExcitement: 13,
    });
  });
});
