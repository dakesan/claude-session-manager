/**
 * Hono HTTP server for Claude Session Manager.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { dirname, join, resolve, basename, extname } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import * as cli from "./claude-cli.js";
import { CONFIG } from "./config.js";
import * as remote from "./remote.js";
import * as schedulesStore from "./schedules.js";
import * as scheduler from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "..", "static");

const app = new Hono();

// --- API routes ---

app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    version: "0.6.0",
    uptime: process.uptime(),
    hostname: hostname(),
    mode: CONFIG.server.mode,
    remotes: CONFIG.remotes.length,
  });
});

type LifecycleFilter = "active" | "archived" | "dead" | "all";

function parseLifecycleFilter(raw: string | undefined): LifecycleFilter {
  if (raw === "archived" || raw === "dead" || raw === "all") return raw;
  return "active";
}

function matchesLifecycle(
  session: { lifecycleState?: string },
  filter: LifecycleFilter,
): boolean {
  if (filter === "all") return true;
  // Treat missing lifecycleState as "active" (back-compat with remotes that
  // haven't been upgraded yet).
  const state = session.lifecycleState || "active";
  return state === filter;
}

app.get("/api/sessions", async (c) => {
  const lifecycle = parseLifecycleFilter(c.req.query("lifecycle"));

  const [localSessions, remoteSessions] = await Promise.all([
    cli.listSessions(),
    remote.fetchAllRemoteSessions(lifecycle),
  ]);

  // Tag local sessions with node info
  const localHostname = hostname();
  const tagged = localSessions
    .filter((s) => matchesLifecycle(s, lifecycle))
    .map((s) => ({
      ...s,
      node: localHostname,
      nodeUrl: null, // null = local
    }));

  // Remote sessions are pre-filtered by the remote node, but re-filter here in
  // case a remote node returned everything (older versions).
  const filteredRemote = remoteSessions.filter((s) => matchesLifecycle(s, lifecycle));

  return c.json([...tagged, ...filteredRemote]);
});

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");

  // Try local first
  const session = await cli.getSession(id);
  if (session) return c.json({ ...session, node: hostname(), nodeUrl: null });

  // Try remotes if in host mode
  if (CONFIG.server.mode === "host") {
    const remoteSessions = await remote.fetchAllRemoteSessions();
    const rs = remote.findNodeForSession(remoteSessions, id);
    if (rs) return c.json(rs);
  }

  return c.json({ error: "Not found" }, 404);
});

app.post("/api/sessions", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    name?: string;
    cwd?: string;
    model?: string;
    node?: string; // target node name (host mode only)
  }>();
  if (!body.prompt) return c.json({ error: "prompt is required" }, 400);

  // If a target node is specified and we're in host mode, proxy to that node
  if (body.node && CONFIG.server.mode === "host") {
    const targetNode = CONFIG.remotes.find((r) => r.name === body.node);
    if (!targetNode) return c.json({ error: `Unknown node: ${body.node}` }, 400);

    const result = await remote.proxyCreate(targetNode.url, body.prompt, body.name, body.cwd, body.model);
    if (!result) {
      // Record the failure on the host: a failed remote spawn otherwise leaves
      // no trace here, which is exactly what made the "remote session created
      // but prompt never injected" symptom so hard to diagnose.
      await cli.logProxyEvent(
        body.node,
        "proxy-create-failed",
        `name=${body.name ?? "(none)"} cwd=${body.cwd ?? "(default)"}`,
      );
      return c.json({ error: `Failed to create session on ${body.node}` }, 502);
    }
    return c.json({ ...result, node: body.node, nodeUrl: targetNode.url }, 201);
  }

  try {
    const session = await cli.createSession(body.prompt, body.name, body.cwd, body.model);
    return c.json({ ...session, node: hostname(), nodeUrl: null }, 201);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.post("/api/sessions/:id/stop", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  // Proxy to remote node if nodeUrl is specified
  if (nodeUrl) {
    const ok = await remote.proxyStop(nodeUrl, id);
    if (!ok) return c.json({ error: `Failed to stop ${id} on remote node` }, 502);
    return c.json({ status: "stopped", shortId: id });
  }

  const ok = await cli.stopSession(id);
  if (!ok) return c.json({ error: `Failed to stop ${id}` }, 500);
  return c.json({ status: "stopped", shortId: id });
});

app.post("/api/sessions/:id/respawn", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  if (nodeUrl) {
    const ok = await remote.proxyRespawn(nodeUrl, id);
    if (!ok) return c.json({ error: `Failed to respawn ${id} on remote node` }, 502);
    return c.json({ status: "respawned", shortId: id });
  }

  const ok = await cli.respawnSession(id);
  if (!ok) return c.json({ error: `Failed to respawn ${id}` }, 500);
  return c.json({ status: "respawned", shortId: id });
});

app.post("/api/sessions/:id/restore", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  if (nodeUrl) {
    const ok = await remote.proxyRestore(nodeUrl, id);
    if (!ok) return c.json({ error: `Failed to restore ${id} on remote node` }, 502);
    return c.json({ status: "restored", shortId: id });
  }

  const ok = await cli.restoreSession(id);
  if (!ok) return c.json({ error: `Failed to restore ${id}` }, 404);
  return c.json({ status: "restored", shortId: id });
});

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  if (nodeUrl) {
    const ok = await remote.proxyRemove(nodeUrl, id);
    if (!ok) return c.json({ error: `Failed to remove ${id} on remote node` }, 502);
    return c.json({ status: "removed", shortId: id });
  }

  const ok = await cli.removeSession(id);
  if (!ok) return c.json({ error: `Failed to remove ${id}` }, 500);
  return c.json({ status: "removed", shortId: id });
});

app.get("/api/sessions/:id/logs", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  if (nodeUrl) {
    const logs = await remote.proxyGetLogs(nodeUrl, id);
    return c.json({ shortId: id, logs });
  }

  const logs = await cli.getLogs(id);
  return c.json({ shortId: id, logs });
});

app.get("/api/sessions/:id/transcript", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  if (nodeUrl) {
    const turns = await remote.proxyGetTranscript(nodeUrl, id);
    if (turns === null) return c.json({ error: "Remote node unreachable" }, 502);
    return c.json({ shortId: id, turns });
  }

  const turns = await cli.getTranscript(id);
  return c.json({ shortId: id, turns });
});

app.post("/api/sessions/:id/message", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  const body = await c.req
    .json<{ prompt?: string; attachments?: string[] }>()
    .catch(() => ({} as { prompt?: string; attachments?: string[] }));
  const prompt = (body.prompt || "").trim();
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (!prompt && attachments.length === 0) {
    return c.json({ error: "prompt or attachments are required" }, 400);
  }

  // Build the wire prompt by appending the [添付ファイル] block. The protocol
  // injected at session spawn time teaches claude how to interpret this.
  const wirePrompt = attachments.length === 0
    ? prompt
    : `${prompt || "添付ファイルを確認してください"}\n\n[添付ファイル]\n${attachments
        .map((p) => `  - ${p}`)
        .join("\n")}`;

  if (nodeUrl) {
    const r = await remote.proxyMessage(nodeUrl, id, wirePrompt);
    return c.json(r.body, r.status as 200 | 400 | 404 | 409 | 502);
  }

  const result = await cli.sendMessage(id, wirePrompt);
  if (result.ok) return c.json({ status: "sent", shortId: id });

  if (result.reason === "not_found") return c.json({ error: "Session not found" }, 404);
  if (result.reason === "stopped") {
    return c.json({ error: "Session is stopped — respawn it before sending messages" }, 409);
  }
  if (result.reason === "no_tmux") {
    return c.json({ error: "No tmux pane found for session" }, 409);
  }
  return c.json({ error: result.detail || "tmux send failed" }, 500);
});

app.post("/api/sessions/:id/upload", async (c) => {
  const id = c.req.param("id");
  const nodeUrl = c.req.query("nodeUrl");

  if (nodeUrl) {
    const r = await remote.proxyUpload(nodeUrl, id, c.req.raw);
    return c.json(r.body, r.status as 200 | 400 | 404 | 502);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (e) {
    return c.json(
      { error: "Failed to parse multipart body", detail: e instanceof Error ? e.message : String(e) },
      400,
    );
  }

  // The form field name is "files" (single or multiple). Accept either.
  const raw = body["files"] ?? body["file"];
  const list: File[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) if (v instanceof File) list.push(v);
  } else if (raw instanceof File) {
    list.push(raw);
  }

  const result = await cli.saveUploads(id, list);
  if (result.ok) return c.json({ files: result.files });
  if (result.reason === "not_found") return c.json({ error: "Session not found" }, 404);
  if (result.reason === "no_files") return c.json({ error: "No files were uploaded" }, 400);
  return c.json({ error: result.detail || "Failed to save uploads" }, 500);
});

app.get("/api/sessions/:id/rc-url", async (c) => {
  const id = c.req.param("id");
  const rcUrl = await cli.refreshRcUrl(id);
  return c.json({ shortId: id, rcUrl: rcUrl || null });
});

app.get("/api/nodes", async (c) => {
  const localSessions = await cli.listSessions();
  const localNode = {
    name: hostname(),
    url: null,
    online: true,
    hostname: hostname(),
    version: "0.6.0",
    sessionCount: localSessions.length,
  };

  const remoteStatuses = await remote.getNodesStatus();
  return c.json([localNode, ...remoteStatuses]);
});

app.get("/api/roster", async (c) => {
  const roster = await cli.getRoster();
  return c.json(roster);
});

// --- File serving ---
// Serve a file referenced by absolute path (uploads or assistant output).
// Used by the chat UI to render images inline and offer downloads.
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
};

const INLINE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".pdf", ".txt", ".csv", ".json",
]);

app.get("/api/files", async (c) => {
  const rawPath = c.req.query("path");
  const nodeUrl = c.req.query("nodeUrl");

  if (!rawPath) return c.json({ error: "path is required" }, 400);

  if (nodeUrl) {
    const r = await remote.proxyFile(nodeUrl, rawPath);
    if (!r) return c.json({ error: "Remote node unreachable" }, 502);
    return r;
  }

  // Anti-traversal: reject relative segments before resolving.
  if (!rawPath.startsWith("/") || rawPath.includes("..")) {
    return c.json({ error: "Absolute path required (no '..')" }, 400);
  }

  const abs = resolve(rawPath);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
  if (!st.isFile()) {
    return c.json({ error: "Not a regular file" }, 400);
  }

  const ext = extname(abs).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const disposition = INLINE_EXTENSIONS.has(ext) ? "inline" : "attachment";
  const filename = basename(abs).replace(/"/g, "");

  const nodeStream = createReadStream(abs);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(st.size),
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
});

// --- Models ---
// Canonical list of Claude models for UI pickers.  Kept inline because the
// `claude` CLI doesn't expose a "list-models" subcommand; update this when
// new models are released.
app.get("/api/models", (c) => {
  return c.json({
    // Aliases that always resolve to the latest model in their tier.
    aliases: [
      { id: "opus",   label: "Opus",   description: "latest Opus (deepest reasoning)" },
      { id: "sonnet", label: "Sonnet", description: "latest Sonnet (balanced)" },
      { id: "haiku",  label: "Haiku",  description: "latest Haiku (fastest, cheapest)" },
    ],
    // Specific pinned model IDs.
    models: [
      { id: "claude-opus-4-7",            label: "Opus 4.7",   tier: "opus",   release: "latest" },
      { id: "claude-sonnet-4-6",          label: "Sonnet 4.6", tier: "sonnet", release: "latest" },
      { id: "claude-haiku-4-5-20251001",  label: "Haiku 4.5",  tier: "haiku",  release: "latest" },
    ],
  });
});

// --- Directory browsing ---

app.get("/api/browse", async (c) => {
  const rawPath = c.req.query("path");
  const nodeUrl = c.req.query("nodeUrl");

  // Proxy to remote node when in host mode
  if (nodeUrl) {
    const data = await remote.proxyBrowse(nodeUrl, rawPath);
    if (!data) return c.json({ error: "Failed to browse remote node" }, 502);
    return c.json(data);
  }

  const raw = rawPath || homedir();
  const target = resolve(raw.replace(/^~/, homedir()));

  // Prevent traversal outside home
  const home = homedir();
  if (!target.startsWith(home) && target !== "/") {
    return c.json({ error: "Path must be under home directory" }, 403);
  }

  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      return c.json({ error: "Not a directory" }, 400);
    }
    const entries = await readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: join(target, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return c.json({
      current: target,
      parent: target === home ? null : dirname(target),
      dirs,
    });
  } catch {
    return c.json({ error: `Cannot read ${target}` }, 400);
  }
});

// --- Schedule routes ---

app.get("/api/schedules", async (c) => {
  const list = await schedulesStore.listSchedules();
  return c.json(list);
});

app.post("/api/schedules", async (c) => {
  const body = await c.req.json<{
    name?: string;
    cron?: string;
    timezone?: string;
    prompt?: string;
    cwd?: string;
    model?: string;
    enabled?: boolean;
  }>();

  if (!body.name || !body.name.trim()) return c.json({ error: "name is required" }, 400);
  if (!body.cron || !body.cron.trim()) return c.json({ error: "cron is required" }, 400);
  if (!scheduler.isValidCron(body.cron)) return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400);
  if (!body.prompt || !body.prompt.trim()) return c.json({ error: "prompt is required" }, 400);

  const created = await schedulesStore.createSchedule({
    name: body.name,
    cron: body.cron,
    timezone: body.timezone,
    prompt: body.prompt,
    cwd: body.cwd,
    model: body.model,
    enabled: body.enabled,
  });
  await scheduler.registerSchedule(created);

  // Re-read to surface the nextRun the scheduler just computed
  const fresh = await schedulesStore.getSchedule(created.id);
  return c.json(fresh || created, 201);
});

app.get("/api/schedules/:id", async (c) => {
  const id = c.req.param("id");
  const s = await schedulesStore.getSchedule(id);
  if (!s) return c.json({ error: "Not found" }, 404);
  return c.json(s);
});

app.put("/api/schedules/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    cron?: string;
    timezone?: string;
    prompt?: string;
    cwd?: string;
    model?: string;
    enabled?: boolean;
  }>();

  if (body.cron !== undefined && !scheduler.isValidCron(body.cron)) {
    return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400);
  }

  const updated = await schedulesStore.updateSchedule(id, body);
  if (!updated) return c.json({ error: "Not found" }, 404);
  await scheduler.registerSchedule(updated);

  const fresh = await schedulesStore.getSchedule(id);
  return c.json(fresh || updated);
});

app.delete("/api/schedules/:id", async (c) => {
  const id = c.req.param("id");
  scheduler.unregisterSchedule(id);
  const ok = await schedulesStore.deleteSchedule(id);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ status: "deleted", id });
});

app.post("/api/schedules/:id/run", async (c) => {
  const id = c.req.param("id");
  const updated = await scheduler.fireSchedule(id, "manual");
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

// --- Static file serving ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".jsx": "text/babel",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

app.get("/", async (c) => {
  try {
    const html = await readFile(join(STATIC_DIR, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("index.html not found", 404);
  }
});

app.get("/schedules", async (c) => {
  try {
    const html = await readFile(join(STATIC_DIR, "schedules.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.text("schedules.html not found", 404);
  }
});

// Serve any static file from static/
app.get("/:file{.+\\..+}", async (c) => {
  const file = c.req.param("file");
  // Prevent path traversal
  if (file.includes("..")) return c.text("Forbidden", 403);
  const filePath = join(STATIC_DIR, file);
  try {
    const content = await readFile(filePath);
    const ext = "." + file.split(".").pop();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    return new Response(content, {
      headers: { "Content-Type": mime },
    });
  } catch {
    return c.text("Not found", 404);
  }
});

export { app };
