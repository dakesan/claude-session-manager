/**
 * Remote node proxy for multi-node CSM aggregation.
 *
 * When running in "host" mode, the host fetches session data from all
 * configured remote CSM instances and merges them with local sessions.
 * Mutating operations (stop, respawn, remove, create) are proxied to
 * the correct remote node.
 */

import { CONFIG, type RemoteNode } from "./config.js";
import type { Session } from "./claude-cli.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RemoteSession extends Session {
  /** Which node this session belongs to */
  node: string;
  /** Base URL of the node (for proxying actions) */
  nodeUrl: string;
}

interface RemoteHealth {
  status: string;
  version: string;
  hostname: string;
  uptime: number;
}

export interface NodeStatus {
  name: string;
  url: string;
  online: boolean;
  hostname?: string;
  version?: string;
  sessionCount: number;
  error?: string;
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Remote node operations ─────────────────────────────────────────────────

/** Fetch sessions from a single remote node */
async function fetchRemoteSessions(
  node: RemoteNode,
  lifecycle?: string,
): Promise<RemoteSession[]> {
  try {
    const qs = lifecycle ? `?lifecycle=${encodeURIComponent(lifecycle)}` : "";
    const res = await fetchWithTimeout(`${node.url}/api/sessions${qs}`);
    if (!res.ok) return [];
    const sessions = (await res.json()) as Session[];
    return sessions.map((s) => ({
      ...s,
      node: node.name,
      nodeUrl: node.url,
    }));
  } catch {
    return [];
  }
}

/** Check health of a remote node */
async function checkNodeHealth(
  node: RemoteNode,
): Promise<NodeStatus> {
  try {
    const res = await fetchWithTimeout(`${node.url}/api/health`);
    if (!res.ok) {
      return {
        name: node.name,
        url: node.url,
        online: false,
        sessionCount: 0,
        error: `HTTP ${res.status}`,
      };
    }
    const health = (await res.json()) as RemoteHealth;
    return {
      name: node.name,
      url: node.url,
      online: true,
      hostname: health.hostname,
      version: health.version,
      sessionCount: 0, // will be filled after session fetch
    };
  } catch (e) {
    return {
      name: node.name,
      url: node.url,
      online: false,
      sessionCount: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Fetch sessions from all configured remote nodes in parallel */
export async function fetchAllRemoteSessions(
  lifecycle?: string,
): Promise<RemoteSession[]> {
  if (CONFIG.server.mode !== "host" || CONFIG.remotes.length === 0) {
    return [];
  }

  const results = await Promise.all(
    CONFIG.remotes.map((node) => fetchRemoteSessions(node, lifecycle)),
  );
  return results.flat();
}

/** Get health status of all configured remote nodes */
export async function getNodesStatus(): Promise<NodeStatus[]> {
  if (CONFIG.remotes.length === 0) return [];

  const statuses = await Promise.all(
    CONFIG.remotes.map((node) => checkNodeHealth(node)),
  );

  // Fetch session counts in parallel
  const sessionResults = await Promise.all(
    CONFIG.remotes.map((node) => fetchRemoteSessions(node)),
  );
  for (let i = 0; i < statuses.length; i++) {
    statuses[i].sessionCount = sessionResults[i].length;
  }

  return statuses;
}

/** Proxy a stop request to the correct remote node */
export async function proxyStop(
  nodeUrl: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions/${sessionId}/stop`, {
      method: "POST",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Proxy a respawn request to the correct remote node */
export async function proxyRespawn(
  nodeUrl: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions/${sessionId}/respawn`, {
      method: "POST",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Proxy a restore request to the correct remote node */
export async function proxyRestore(
  nodeUrl: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions/${sessionId}/restore`, {
      method: "POST",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Proxy a remove request to the correct remote node */
export async function proxyRemove(
  nodeUrl: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Proxy a create request to a specific remote node */
export async function proxyCreate(
  nodeUrl: string,
  prompt: string,
  name?: string,
  cwd?: string,
  model?: string,
): Promise<Session | null> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, name, cwd, model }),
    });
    if (!res.ok) return null;
    return (await res.json()) as Session;
  } catch {
    return null;
  }
}

/** Proxy a logs request to the correct remote node */
export async function proxyGetLogs(
  nodeUrl: string,
  sessionId: string,
): Promise<string> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions/${sessionId}/logs`);
    if (!res.ok) return "(error fetching remote logs)";
    const data = (await res.json()) as { logs: string };
    return data.logs || "(no output)";
  } catch {
    return "(remote node unreachable)";
  }
}

/** Proxy a directory-browse request to a remote node */
export async function proxyBrowse(
  nodeUrl: string,
  path?: string,
): Promise<{
  current: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
} | null> {
  try {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await fetchWithTimeout(`${nodeUrl}/api/browse${qs}`);
    if (!res.ok) return null;
    return (await res.json()) as {
      current: string;
      parent: string | null;
      dirs: { name: string; path: string }[];
    };
  } catch {
    return null;
  }
}

/** Find which remote node owns a session by shortId or sessionId */
export function findNodeForSession(
  remoteSessions: RemoteSession[],
  id: string,
): RemoteSession | undefined {
  return remoteSessions.find(
    (s) => s.sessionId === id || s.shortId === id,
  );
}
