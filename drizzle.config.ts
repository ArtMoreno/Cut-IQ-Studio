import "dotenv/config";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// Mirrors server/runtimePaths.ts. Kept literal here because drizzle-kit loads
// this file outside the server's module graph.
const databaseFile = resolve(
  process.env.CUTIQ_DATABASE_FILE || join(homedir(), ".cut-iq-studio", "cut-iq-studio.db"),
);

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseFile,
  },
});
