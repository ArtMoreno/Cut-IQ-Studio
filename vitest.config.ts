import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // Pipeline integration tests hit the live network (keyless yt-dlp YouTube
    // search per beat), so the default 5s per-test budget is too tight. Give
    // them room; failures will still surface as real assertion errors.
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["api/**/*.test.ts", "api/**/*.spec.ts", "server/**/*.test.ts", "server/**/*.spec.ts", "src/lib/**/*.test.ts"],
    alias: {
      "@db": path.resolve(templateRoot, "./db"),
      "@contracts": path.resolve(templateRoot, "./contracts"),
    },
  },
});
