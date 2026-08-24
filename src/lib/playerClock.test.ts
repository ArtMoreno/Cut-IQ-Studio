import { describe, expect, it } from "vitest";
import { reconcilePlayerClock } from "./playerClock";

describe("YouTube player clock reconciliation", () => {
  it("holds a transcript seek while the iframe still reports its old time", () => {
    const pending = { targetSeconds: 120, expiresAtMs: 3_000 };
    expect(reconcilePlayerClock(20, pending, 1_000)).toEqual({ seconds: 120, pending });
  });

  it("releases after the iframe catches up or the safety timeout expires", () => {
    const pending = { targetSeconds: 120, expiresAtMs: 3_000 };
    expect(reconcilePlayerClock(119.5, pending, 1_000)).toEqual({ seconds: 120, pending: null });
    expect(reconcilePlayerClock(25, pending, 3_001)).toEqual({ seconds: 25, pending: null });
  });
});
