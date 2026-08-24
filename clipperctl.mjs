#!/usr/bin/env node
/**
 * clipperctl — stable local control CLI for ClipSift.
 * Talks to the localhost control API (http://127.0.0.1:<port>/api/control).
 * All output is JSON (--pretty for humans). Exit codes: 0 ok, 1 error.
 *
 * Commands:
 *   health
 *   doctor
 *   worker status
 *   job create|list|start|status|pause|resume|cancel|retry|results
 *   project upsert --json-file <file> | --json '<inline json>'
 *   project run --project-id <id> [--stages analyze,discover,index,rank]
 *   project status --project-id <id>
 *   project open --project-id <id>      (prints the UI URL; uses `start` on Windows)
 *   project import-url --project-id <id> --url <youtube url>
 *   providers
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PORT = process.env.CLIPSIFT_PORT ?? process.env.PORT ?? "3000";
const BASE = process.env.CLIPSIFT_CONTROL_URL ?? `http://localhost:${PORT}/api/control`;
const TOKEN = process.env["CLIPSIFT_CONTROL_TOKEN"] ?? "";

const args = process.argv.slice(2);
const pretty = args.includes("--pretty");
const boolFlag = (name) => args.includes(name);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function headers() {
  const h = { "content-type": "application/json" };
  if (TOKEN) h["x-clipsift-token"] = TOKEN;
  return h;
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(600_000), // pipeline runs can take minutes
  });
  const data = await res.json().catch(() => ({ ok: false, code: "BAD_RESPONSE", message: "Non-JSON response" }));
  return { status: res.status, data };
}

function out(data, status) {
  console.log(JSON.stringify(data, null, pretty ? 2 : 0));
  if (!data.ok || status >= 400) process.exitCode = 1;
}

async function main() {
  const [cmd, sub] = args;

  if (cmd === "health") {
    const r = await call("GET", "/health");
    return out(r.data, r.status);
  }

  if (cmd === "providers") {
    const r = await call("GET", "/providers");
    return out(r.data, r.status);
  }

  if (cmd === "doctor") {
    const r = await call("GET", `/doctor${boolFlag("--network") ? "?network=1" : ""}`);
    return out(r.data, r.status);
  }

  if (cmd === "worker" && sub === "status") {
    const r = await call("GET", "/worker/status");
    return out(r.data, r.status);
  }

  if (cmd === "job" && sub === "create") {
    let payload;
    const jsonFile = flag("--json-file");
    const inline = flag("--json");
    if (jsonFile) payload = JSON.parse(readFileSync(jsonFile, "utf8"));
    else if (inline) payload = JSON.parse(inline);
    else if (flag("--script")) {
      payload = {
        player: flag("--player"),
        team: flag("--team"),
        season: Number(flag("--season")),
        opponent: flag("--opponent") ?? undefined,
        scriptText: readFileSync(flag("--script"), "utf8"),
        sourceLimit: Number(flag("--sources") ?? 20),
        clipLimit: Number(flag("--clips") ?? 30),
        preferredHeight: Number(flag("--height") ?? 1080),
        minimumHeight: Number(flag("--minimum-height") ?? 720),
        autoStart: !boolFlag("--no-start"),
      };
    } else {
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      payload = JSON.parse(input);
    }
    const r = await call("POST", "/job/create", payload);
    return out(r.data, r.status);
  }

  if (cmd === "job" && sub === "list") {
    const r = await call("GET", "/jobs");
    return out(r.data, r.status);
  }

  if (cmd === "job" && ["status", "results"].includes(sub)) {
    const id = Number(flag("--id") ?? flag("--job-id"));
    const r = await call("GET", `/job/${id}`);
    return out(r.data, r.status);
  }

  if (cmd === "job" && ["start", "pause", "resume", "cancel", "retry"].includes(sub)) {
    const id = Number(flag("--id") ?? flag("--job-id"));
    const r = await call("POST", `/job/${id}/${sub}`, {});
    return out(r.data, r.status);
  }

  if (cmd === "project" && sub === "upsert") {
    let payload;
    const jsonFile = flag("--json-file");
    const inline = flag("--json");
    if (jsonFile) payload = JSON.parse(readFileSync(jsonFile, "utf8"));
    else if (inline) payload = JSON.parse(inline);
    else {
      // read from stdin
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      payload = JSON.parse(input);
    }
    const r = await call("POST", "/project/upsert", payload);
    return out(r.data, r.status);
  }

  if (cmd === "project" && sub === "run") {
    const projectId = Number(flag("--project-id"));
    if (!Number.isFinite(projectId)) {
      return out({ ok: false, code: "BAD_REQUEST", message: "--project-id is required" }, 400);
    }
    const stages = (flag("--stages") ?? "analyze,discover,index,rank").split(",");
    const onlyProviders = flag("--providers")?.split(",").filter(Boolean);
    const onlyBeats = flag("--beats")?.split(",").map(Number).filter(Number.isFinite);
    const r = await call("POST", "/project/run", { projectId, stages, onlyProviders, onlyBeats });
    return out(r.data, r.status);
  }

  if (cmd === "project" && sub === "status") {
    const projectId = Number(flag("--project-id"));
    const r = await call("GET", `/project/${projectId}/status`);
    return out(r.data, r.status);
  }

  if (cmd === "project" && sub === "open") {
    const projectId = Number(flag("--project-id"));
    const r = await call("GET", `/project/${projectId}/open`);
    if (r.data.ok && !boolFlag("--no-launch")) {
      const url = `http://localhost:${PORT}${r.data.url}`;
      if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
      else spawnSync("xdg-open", [url], { stdio: "ignore" });
      out({ ...r.data, launched: url }, r.status);
    } else {
      out(r.data, r.status);
    }
    return;
  }

  if (cmd === "project" && sub === "import-url") {
    const projectId = Number(flag("--project-id"));
    const url = flag("--url");
    const r = await call("POST", `/project/${projectId}/import-url`, { url });
    return out(r.data, r.status);
  }

  console.log(JSON.stringify({
    ok: false,
    code: "BAD_REQUEST",
    message: "Unknown command. Use: health | doctor | providers | worker status | job create|list|start|status|pause|resume|cancel|retry|results | project upsert|run|status|open|import-url",
  }));
  process.exitCode = 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, code: "CLI_ERROR", message: String(e?.message ?? e) }));
  process.exitCode = 1;
});
