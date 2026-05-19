/**
 * MCP Server for Claude Session Manager.
 *
 * This is a thin MCP wrapper that forwards requests to a running CSM HTTP API.
 * The CSM_URL environment variable specifies the base URL of the CSM server
 * (e.g. "http://lab:8321"). Defaults to "http://localhost:8321".
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CSM_URL = (process.env.CSM_URL || "http://localhost:8321").replace(
  /\/$/,
  "",
);

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function csmFetch(
  path: string,
  opts?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${CSM_URL}${path}`;
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "claude-session-manager",
    version: "0.5.0",
  });

  // --- list_sessions ---
  server.tool(
    "list_sessions",
    "List all Claude Code sessions managed by CSM. Returns session ID, name, status, prompt, and Remote Control URL for each session.",
    {},
    async () => {
      const { ok, data } = await csmFetch("/api/sessions");
      if (!ok) return errorResult(`Failed to list sessions: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- get_session ---
  server.tool(
    "get_session",
    "Get details of a specific Claude Code session by its short ID or full UUID.",
    { id: z.string().describe("Session short ID (8 chars) or full UUID") },
    async ({ id }) => {
      const { ok, data, status } = await csmFetch(`/api/sessions/${id}`);
      if (status === 404) return errorResult(`Session not found: ${id}`);
      if (!ok) return errorResult(`Failed to get session: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- create_session ---
  server.tool(
    "create_session",
    "Create a new interactive Claude Code session with Remote Control enabled. The session runs in tmux and is accessible from claude.ai/code. Takes ~13s to return (waits for RC URL capture).",
    {
      prompt: z.string().describe("Initial prompt to send to Claude"),
      name: z
        .string()
        .optional()
        .describe("Session name (used as Remote Control name). Auto-generated if omitted"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for the session. Defaults to server's cwd"),
    },
    async ({ prompt, name, cwd }) => {
      const { ok, data } = await csmFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, name, cwd }),
      });
      if (!ok) return errorResult(`Failed to create session: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- stop_session ---
  server.tool(
    "stop_session",
    "Stop a running Claude Code session. Kills the tmux session and claude process.",
    { id: z.string().describe("Session short ID or full UUID") },
    async ({ id }) => {
      const { ok, data } = await csmFetch(`/api/sessions/${id}/stop`, {
        method: "POST",
      });
      if (!ok) return errorResult(`Failed to stop session: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- remove_session ---
  server.tool(
    "remove_session",
    "Stop and remove a Claude Code session. Kills the process (if running) and removes CSM tracking metadata.",
    { id: z.string().describe("Session short ID or full UUID") },
    async ({ id }) => {
      const { ok, data } = await csmFetch(`/api/sessions/${id}`, {
        method: "DELETE",
      });
      if (!ok) return errorResult(`Failed to remove session: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- respawn_session ---
  server.tool(
    "respawn_session",
    "Re-create a stopped session with the same prompt and working directory.",
    { id: z.string().describe("Session short ID or full UUID") },
    async ({ id }) => {
      const { ok, data } = await csmFetch(`/api/sessions/${id}/respawn`, {
        method: "POST",
      });
      if (!ok) return errorResult(`Failed to respawn session: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- get_logs ---
  server.tool(
    "get_logs",
    "Get the JSONL transcript of a Claude Code session formatted as readable log lines.",
    { id: z.string().describe("Session short ID or full UUID") },
    async ({ id }) => {
      const { ok, data } = await csmFetch(`/api/sessions/${id}/logs`);
      if (!ok) return errorResult(`Failed to get logs: ${JSON.stringify(data)}`);
      const logs = (data as Record<string, unknown>)?.logs;
      return textResult(typeof logs === "string" ? logs : "(no logs)");
    },
  );

  // --- refresh_rc_url ---
  server.tool(
    "refresh_rc_url",
    "Re-scan the tmux pane for the Remote Control URL. Useful if the URL was not captured at creation time.",
    { id: z.string().describe("Session short ID or full UUID") },
    async ({ id }) => {
      const { ok, data } = await csmFetch(`/api/sessions/${id}/rc-url`);
      if (!ok) return errorResult(`Failed to refresh RC URL: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- browse_directory ---
  server.tool(
    "browse_directory",
    "Browse directories on the CSM host. Useful for choosing a working directory when creating a session.",
    {
      path: z
        .string()
        .optional()
        .describe("Directory path to browse. Defaults to home directory"),
    },
    async ({ path }) => {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const { ok, data } = await csmFetch(`/api/browse${qs}`);
      if (!ok) return errorResult(`Failed to browse: ${JSON.stringify(data)}`);
      return jsonResult(data);
    },
  );

  // --- health ---
  server.tool(
    "health",
    "Check if the CSM server is running and healthy.",
    {},
    async () => {
      try {
        const { ok, data } = await csmFetch("/api/health");
        if (!ok) return errorResult("CSM server unhealthy");
        return jsonResult(data);
      } catch (e) {
        return errorResult(
          `Cannot reach CSM server at ${CSM_URL}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  return server;
}
