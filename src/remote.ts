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
// createSession on the remote can block for up to ~100s before it returns:
// waitForTuiReady runs a 30s attempt and, on slow hosts, a second 60s retry
// (90s total), then captureRcUrl polls for up to 10s. The previous 60s budget
// was shorter than this worst case (it was sized for the pre-retry ~40s path),
// so on a slow remote the host aborted the fetch mid-spawn and surfaced a 502
// even though the session was still being created — the recurring "remote
// session created but initial prompt never injected" symptom. Keep this
// comfortably above the 100s ceiling.
const CREATE_FETCH_TIMEOUT_MS = 150_000;
// A message to an idle-stopped remote session triggers a transparent respawn
// (--resume + waitForTuiReady, up to ~90s) before the send completes, so this
// must comfortably exceed that ceiling. Normal messages return in well under a
// second; the only downside of the larger budget is slower detection of a
// genuinely unreachable remote on the message path.
const MESSAGE_FETCH_TIMEOUT_MS = 150_000;

async function fetchWithTimeout(
  url: string,
  opts?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    const res = await fetchWithTimeout(
      `${nodeUrl}/api/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, name, cwd, model }),
      },
      CREATE_FETCH_TIMEOUT_MS,
    );
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

/** Proxy a transcript request to the correct remote node */
export async function proxyGetTranscript(
  nodeUrl: string,
  sessionId: string,
): Promise<unknown[] | null> {
  try {
    const res = await fetchWithTimeout(`${nodeUrl}/api/sessions/${sessionId}/transcript`);
    if (!res.ok) return null;
    const data = (await res.json()) as { turns?: unknown[] };
    return Array.isArray(data.turns) ? data.turns : [];
  } catch {
    return null;
  }
}

/** Proxy a send-message request to the correct remote node */
export async function proxyMessage(
  nodeUrl: string,
  sessionId: string,
  prompt: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetchWithTimeout(
      `${nodeUrl}/api/sessions/${sessionId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      },
      MESSAGE_FETCH_TIMEOUT_MS,
    );
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Proxy a multipart upload to the correct remote node. The original request
 * body is streamed through unchanged so we do not have to materialize the
 * file payload in memory on the host side.
 */
export async function proxyUpload(
  nodeUrl: string,
  sessionId: string,
  req: Request,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const headers = new Headers();
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    const cl = req.headers.get("content-length");
    if (cl) headers.set("content-length", cl);

    const res = await fetch(`${nodeUrl}/api/sessions/${sessionId}/upload`, {
      method: "POST",
      headers,
      body: req.body,
      // Node's undici requires this when streaming a request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Stream a file from a remote node. The Response object is forwarded
 * verbatim (status, headers, body) so the browser sees the same content
 * type and disposition the remote produced.
 */
export async function proxyFile(
  nodeUrl: string,
  path: string,
): Promise<Response | null> {
  try {
    const url = `${nodeUrl}/api/files?path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    // Re-wrap so we drop hop-by-hop headers and keep the relevant ones.
    const headers = new Headers();
    for (const k of [
      "content-type",
      "content-length",
      "content-disposition",
      "cache-control",
    ]) {
      const v = res.headers.get(k);
      if (v) headers.set(k, v);
    }
    return new Response(res.body, {
      status: res.status,
      headers,
    });
  } catch {
    return null;
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
