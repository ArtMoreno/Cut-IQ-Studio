import app from "./app";
import { env } from "./lib/env";
import { recoverStaleJobs } from "./clip/engine";
import { startFindClipsWorker } from "./findClips/engine";
import { recoverStudioExports } from "./transcriptStudio/exportEngine";
import { migrateDatabase } from "./queries/migrate";

// Standalone entry (npm run start / npm run dev via @hono/vite-dev-server).
// Static files + HTTP listener only when running outside Vercel.
if (env.isProduction) {
  // Create or update the local SQLite file before anything reads from it.
  migrateDatabase();

  // Reset any jobs that were mid-flight when the server last stopped
  // (interrupted by a restart). Queued jobs self-resume via the pump worker.
  recoverStaleJobs().catch((e) => console.error("[clip-engine] recover failed:", e));
  recoverStudioExports().catch((e) => console.error("[studio-export] recover failed:", e));
  startFindClipsWorker();

  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  // Loopback-only: the app has no auth; expose via tailscale serve, not the LAN.
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
