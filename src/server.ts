/**
 * Hono HTTP server for Claude Session Manager.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import * as cli from "./claude-cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "..", "static");

const app = new Hono();

// --- API routes ---

app.get("/api/health", (c) => {
  return c.json({ status: "ok", version: "0.5.0", uptime: process.uptime() });
});

app.get("/api/sessions", async (c) => {
  const sessions = await cli.listSessions();
  return c.json(sessions);
});

app.get("/api/sessions/:id", async (c) => {
  const session = await cli.getSession(c.req.param("id"));
  if (!session) return c.json({ error: "Not found" }, 404);
  return c.json(session);
});

app.post("/api/sessions", async (c) => {
  const body = await c.req.json<{
    prompt: string;
    name?: string;
    cwd?: string;
  }>();
  if (!body.prompt) return c.json({ error: "prompt is required" }, 400);

  try {
    const session = await cli.createSession(body.prompt, body.name, body.cwd);
    return c.json(session, 201);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

app.post("/api/sessions/:id/stop", async (c) => {
  const id = c.req.param("id");
  const ok = await cli.stopSession(id);
  if (!ok) return c.json({ error: `Failed to stop ${id}` }, 500);
  return c.json({ status: "stopped", shortId: id });
});

app.post("/api/sessions/:id/respawn", async (c) => {
  const id = c.req.param("id");
  const ok = await cli.respawnSession(id);
  if (!ok) return c.json({ error: `Failed to respawn ${id}` }, 500);
  return c.json({ status: "respawned", shortId: id });
});

app.delete("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await cli.removeSession(id);
  if (!ok) return c.json({ error: `Failed to remove ${id}` }, 500);
  return c.json({ status: "removed", shortId: id });
});

app.get("/api/sessions/:id/logs", async (c) => {
  const id = c.req.param("id");
  const logs = await cli.getLogs(id);
  return c.json({ shortId: id, logs });
});

app.get("/api/sessions/:id/rc-url", async (c) => {
  const id = c.req.param("id");
  const rcUrl = await cli.refreshRcUrl(id);
  return c.json({ shortId: id, rcUrl: rcUrl || null });
});

app.get("/api/roster", async (c) => {
  const roster = await cli.getRoster();
  return c.json(roster);
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
