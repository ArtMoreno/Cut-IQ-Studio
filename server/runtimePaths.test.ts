import { describe, expect, it } from "vitest";
import { CLIPSIFT_INSTALL_ROOT, CLIPSIFT_RUNTIME_PATHS } from "./runtimePaths";

describe("Cut IQ-owned runtime paths", () => {
  it("keeps every default executable inside the Cut IQ installation", () => {
    const install = CLIPSIFT_INSTALL_ROOT.toLowerCase();
    for (const path of Object.values(CLIPSIFT_RUNTIME_PATHS)) {
      expect(path.toLowerCase().startsWith(install)).toBe(true);
      expect(path.toLowerCase()).not.toContain("tapesift");
    }
  });
});
