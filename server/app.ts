import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { existsSync, createReadStream, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { videos } from "@db/schema";
import { appRouter } from "./router";
import { createContext } from "./context";
import { control } from "./control";
import { getDb } from "./queries/connection";
import { canonicalLocalVideoPath } from "./transcriptStudio/exportPaths";
import { clipPackagePreviewPath } from "./clipPackage/preview";
import { packageEditedVersionOutput } from "./clipPackage/studioBridge";
import { packageVersionContentDisposition } from "./clipPackage/download";
import { clipPackageExportOutput } from "./clipPackage/exportEngine";
import { fileURLToPath } from "node:url";
import { CLIPS_DIR } from "./runtimePaths";

/**
 * Shared Hono app. Used by:
 *  - server/boot.ts   (standalone production server)
 *  - api/index.ts     (Vercel serverless entry)
 */
const app = new Hono<{ Bindings: HttpBindings }>();

// NOTE: no bodyLimit middleware — it consumed request bodies before the tRPC
// fetch handler could read them (mutations arrived as undefined input). The
// server is loopback/tailnet-only; body size is not a threat model here.
app.use("/api/trpc/*", async c => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.route("/api/control", control);

// Stream only a registered Transcript Studio local source. The database id is
// resolved back to its exact file URL and revalidated; request text is never
// treated as a filesystem path.
app.get("/api/studio-media/:videoDbId", async c => {
  const videoDbId = Number(c.req.param("videoDbId"));
  if (!Number.isSafeInteger(videoDbId) || videoDbId <= 0)
    return c.json({ error: "Not Found" }, 404);
  const [video] = await getDb()
    .select()
    .from(videos)
    .where(eq(videos.id, videoDbId));
  if (
    !video ||
    !video.videoId.startsWith("local-") ||
    !video.url.startsWith("file:")
  )
    return c.json({ error: "Not Found" }, 404);
  let file: string;
  try {
    file = canonicalLocalVideoPath(fileURLToPath(video.url));
  } catch {
    return c.json({ error: "Not Found" }, 404);
  }
  const { size } = statSync(file);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", localVideoMime(file));
  const range = c.req.header("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2]
      ? Math.min(Number.parseInt(match[2], 10), size - 1)
      : size - 1;
    if (start >= size || end < start) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(
      createReadStream(file, { start, end }) as unknown as ReadableStream,
      206
    );
  }
  c.header("Content-Length", String(size));
  return c.body(createReadStream(file) as unknown as ReadableStream);
});

// Finished Find Clips outputs may use a production codec that browsers cannot
// decode. Prepare a cached H.264/AAC compatibility copy for preview only; the
// original MP4 remains the file users download and the Find Clips pipeline is
// never rewritten.
app.get("/api/clip-preview/:candidateId", async c => {
  const candidateId = Number(c.req.param("candidateId"));
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0)
    return c.json({ error: "Not Found" }, 404);
  let file: string;
  try {
    file = await clipPackagePreviewPath(candidateId);
  } catch {
    return c.json({ error: "Preview unavailable" }, 404);
  }
  const { size } = statSync(file);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", "video/mp4");
  c.header("Content-Disposition", "inline");
  const range = c.req.header("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2]
      ? Math.min(Number.parseInt(match[2], 10), size - 1)
      : size - 1;
    if (start >= size || end < start) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(
      createReadStream(file, { start, end }) as unknown as ReadableStream,
      206
    );
  }
  c.header("Content-Length", String(size));
  return c.body(createReadStream(file) as unknown as ReadableStream);
});

// Stream only a registered, verified Manual Studio version. The URL contains
// an opaque row id; the stored arbitrary Windows output path is never accepted
// from request text.
app.get("/api/package-version/:versionId", async c => {
  const versionId = c.req.param("versionId");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      versionId
    )
  ) {
    return c.json({ error: "Not Found" }, 404);
  }
  let file: string;
  try {
    file = await packageEditedVersionOutput(versionId);
  } catch {
    return c.json({ error: "Not Found" }, 404);
  }
  const { size } = statSync(file);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", "video/mp4");
  c.header(
    "Content-Disposition",
    packageVersionContentDisposition(file, c.req.query("download") === "1")
  );
  const range = c.req.header("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2]
      ? Math.min(Number.parseInt(match[2], 10), size - 1)
      : size - 1;
    if (start >= size || end < start) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(
      createReadStream(file, { start, end }) as unknown as ReadableStream,
      206
    );
  }
  c.header("Content-Length", String(size));
  return c.body(createReadStream(file) as unknown as ReadableStream);
});

app.get("/api/package-export/:exportId/:index", async c => {
  const exportId = c.req.param("exportId");
  const index = Number(c.req.param("index"));
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      exportId
    )
  )
    return c.json({ error: "Not Found" }, 404);
  const file = clipPackageExportOutput(exportId, index);
  if (!file) return c.json({ error: "Not Found" }, 404);
  const { size } = statSync(file);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", "video/mp4");
  c.header(
    "Content-Disposition",
    packageVersionContentDisposition(file, c.req.query("download") === "1")
  );
  const range = c.req.header("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2]
      ? Math.min(Number.parseInt(match[2], 10), size - 1)
      : size - 1;
    if (start >= size || end < start) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(
      createReadStream(file, { start, end }) as unknown as ReadableStream,
      206
    );
  }
  c.header("Content-Length", String(size));
  return c.body(createReadStream(file) as unknown as ReadableStream);
});

function localVideoMime(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    default:
      return "application/octet-stream";
  }
}

// Serve finished clips for download + in-editor preview (desktop + phone via tailnet).
// Supports HTTP Range requests so the <video> element can seek/buffer huge files.
app.get("/api/clips/*", async c => {
  const name = c.req.path.split("/api/clips/")[1];
  if (!name) return c.json({ error: "Not Found" }, 404);
  const decodedName = decodeURIComponent(name);
  const file = resolve(join(CLIPS_DIR, decodedName));
  if (!file.startsWith(CLIPS_DIR) || !existsSync(file))
    return c.json({ error: "Not Found" }, 404);

  const { size } = statSync(file);
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", "video/mp4");
  const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
  const downloadName = decodedName.split(/[\\/]/).pop() || "Cut IQ-clip.mp4";
  c.header(
    "Content-Disposition",
    `${disposition}; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  );

  const range = c.req.header("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start >= size || end < start) {
      c.header("Content-Range", `bytes */${size}`);
      return c.body(null, 416);
    }
    const stream = createReadStream(file, { start, end });
    c.header("Content-Range", `bytes ${start}-${end}/${size}`);
    c.header("Content-Length", String(end - start + 1));
    return c.body(stream as unknown as ReadableStream, 206);
  }

  c.header("Content-Length", String(size));
  const stream = createReadStream(file);
  // node:fs ReadStream is a valid BodyInit in undici; cast to satisfy TS lib dom gap.
  return c.body(stream as unknown as ReadableStream);
});

app.all("/api/*", c => c.json({ error: "Not Found" }, 404));

export default app;
