/**
 * Hono HTTP server for Claude Session Manager.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import * as cli from "./claude-cli.js";
import { CONFIG } from "./config.js";
import * as remote from "./remote.js";

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

app.get("/api/sessions", async (c) => {
  const [localSessions, remoteSessions] = await Promise.all([
    cli.listSessions(),
    remote.fetchAllRemoteSessions(),
  ]);

  // Tag local sessions with node info
  const localHostname = hostname();
  const tagged = localSessions.map((s) => ({
    ...s,
    node: localHostname,
    nodeUrl: null, // null = local
  }));

  return c.json([...tagged, ...remoteSessions]);
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
    node?: string; // target node name (host mode only)
  }>();
  if (!body.prompt) return c.json({ error: "prompt is required" }, 400);

  // If a target node is specified and we're in host mode, proxy to that node
  if (body.node && CONFIG.server.mode === "host") {
    const targetNode = CONFIG.remotes.find((r) => r.name === body.node);
    if (!targetNode) return c.json({ error: `Unknown node: ${body.node}` }, 400);

    const result = await remote.proxyCreate(targetNode.url, body.prompt, body.name, body.cwd);
    if (!result) return c.json({ error: `Failed to create session on ${body.node}` }, 502);
    return c.json({ ...result, node: body.node, nodeUrl: targetNode.url }, 201);
  }

  try {
    const session = await cli.createSession(body.prompt, body.name, body.cwd);
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

// --- Directory browsing ---

app.get("/api/browse", async (c) => {
  const raw = c.req.query("path") || homedir();
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
