import { describe, expect, it } from "vitest";
import { HIGHLIGHT_TUNER_ENV, readHighlightTunerGate } from "./highlightTunerGate";

describe("highlight tuner safety gate", () => {
  it("is disabled by default and preserves Everything mode", () => {
    expect(readHighlightTunerGate({})).toEqual({ enabled: false, mode: "everything" });
  });

  it("requires the exact explicit opt-in value", () => {
    for (const value of ["", "0", "true", "TRUE", "yes"]) {
      expect(readHighlightTunerGate({ [HIGHLIGHT_TUNER_ENV]: value }).enabled).toBe(false);
    }
    expect(readHighlightTunerGate({ [HIGHLIGHT_TUNER_ENV]: "1" })).toEqual({
      enabled: true,
      mode: "highlights",
    });
  });

  it("returns an immutable gate", () => {
    expect(Object.isFrozen(readHighlightTunerGate({}))).toBe(true);
  });
});
