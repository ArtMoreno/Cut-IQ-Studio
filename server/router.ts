import { createRouter, publicQuery } from "./middleware";
import { clipsiftRouter } from "./clipsiftRouter";
import { scriptRouter } from "./scriptRouter";
import { clipRouter } from "./clipRouter";
import { transcriptStudioRouter } from "./transcriptStudioRouter";
import { assembleRouter } from "./assembleRouter";
import { findClipsRouter } from "./findClipsRouter";
import { clipPackageRouter } from "./clipPackageRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  clipsift: clipsiftRouter,
  script: scriptRouter,
  clips: clipRouter,
  studio: transcriptStudioRouter,
  assemble: assembleRouter,
  findClips: findClipsRouter,
  clipPackage: clipPackageRouter,
});

export type AppRouter = typeof appRouter;
