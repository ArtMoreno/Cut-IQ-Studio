import { describe, expect, it } from "vitest";
import { markStudioIn, markStudioOut } from "./studioTransport";

describe("Transcript Studio marking controls", () => {
  it("sets In from the captured playhead and clears a stale Out", () => {
    expect(markStudioIn({ inPoint: 5, outPoint: 10 }, 12)).toEqual({ ok: true, inPoint: 12, outPoint: null });
    expect(markStudioIn({ inPoint: 5, outPoint: 20 }, 12)).toEqual({ ok: true, inPoint: 12, outPoint: 20 });
  });

  it("sets Out only after In and returns validation failures", () => {
    const validate = (inPoint: number, outPoint: number) => outPoint - inPoint >= 0.5
      ? { ok: true as const }
      : { ok: false as const, message: "Selection must be at least half a second." };
    expect(markStudioOut({ inPoint: null, outPoint: null }, 4, validate)).toEqual({ ok: false, message: "Set an Out point after the In point." });
    expect(markStudioOut({ inPoint: 4, outPoint: null }, 4.2, validate)).toEqual({ ok: false, message: "Selection must be at least half a second." });
    expect(markStudioOut({ inPoint: 4, outPoint: null }, 5, validate)).toEqual({ ok: true, inPoint: 4, outPoint: 5 });
  });
});
