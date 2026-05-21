// Live data bridge: fetches from the backend API and exposes the same
// globals that the prototype mock layer provided.

const API = "/api";

// ─── Static config ───────────────────────────────────────────────────────────

window.PROJECTS = [];
window.USAGE = [];
window.REMOTE_CONTROLS = [];
window.STATUS_ORDER = ["working", "waiting", "stopped"];
window.SEED_SESSIONS = [];
window.CSM_HOSTNAME = "";
window.CSM_MODE = "standalone";
window.CSM_NODES = [];

// ─── Log templates (fallback for synthetic streamer) ─────────────────────────
window.LOG_TEMPLATES = {
  default: [
    ["info", "system", "session started"],
    ["tool", "Read",   "reading file…"],
    ["ok",   "Read",   "done"],
    ["tool", "Bash",   "running command…"],
    ["info", "stdout", "output line"],
  ],
};

// ─── Map backend session → frontend session shape ────────────────────────────
/** Extract the last directory name from a project slug like "-home-oodake-Hiro" */
function projectDisplayName(slug) {
  if (!slug) return "default";
  // Slug is an absolute path with slashes replaced by hyphens and a leading hyphen
  // e.g. "-home-oodake-ghq-github-com-dakesan-claude-session-manager"
  // Use cwd if available (more reliable), otherwise fall back to slug's last segment
  const parts = slug.replace(/^-/, "").split("-");
  return parts[parts.length - 1] || slug;
}

function mapSession(s) {
  // Backend returns: sessionId, shortId, name, state, prompt, cwd,
  //                  createdAt, pid, projectSlug, gitBranch, model, version,
  //                  lifecycleState, archivedAt, lastActivityAt, scheduleId
  const startedAt = s.createdAt ? new Date(s.createdAt).getTime() : Date.now();
  const duration = Math.floor((Date.now() - startedAt) / 1000);

  // Prefer cwd's basename for project name; fall back to slug parsing
  const projectName = s.cwd ? s.cwd.split("/").filter(Boolean).pop() : projectDisplayName(s.projectSlug);

  return {
    id: s.shortId,
    name: s.name || s.shortId,
    prompt: s.prompt || "(no prompt)",
    status: s.state || "stopped",
    project: projectName || "default",
    startedAt,
    duration,
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    worktree: null,
    branch: s.gitBranch || null,
    rc: s.rcUrl || null,
    model: s.model || "unknown",
    cwd: s.cwd || null,
    pid: s.pid || null,
    sessionId: s.sessionId,
    version: s.version || null,
    node: s.node || null,
    nodeUrl: s.nodeUrl || null,
    lifecycleState: s.lifecycleState || "active",
    archivedAt: s.archivedAt || null,
    lastActivityAt: s.lastActivityAt || null,
    scheduleId: s.scheduleId || null,
  };
}

// ─── Fetch sessions from API ─────────────────────────────────────────────────
async function fetchSessions(lifecycle = "all") {
  try {
    const qs = lifecycle ? `?lifecycle=${encodeURIComponent(lifecycle)}` : "";
    const res = await fetch(`${API}/sessions${qs}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(mapSession);
  } catch {
    return [];
  }
}

// ─── Extract unique projects from sessions ───────────────────────────────────
function deriveProjects(sessions) {
  const seen = new Set();
  const projects = [];
  for (const s of sessions) {
    const p = s.project;
    if (!seen.has(p)) {
      seen.add(p);
      projects.push({ id: p, name: p, color: "var(--st-idle)" });
    }
  }
  return projects;
}

// ─── Used ranking: (cwd, node) usage frequency across sessions ─────────────
function deriveUsage(sessions) {
  const map = new Map(); // `${node}|${cwd}` -> {cwd, node, nodeUrl, name, count}
  for (const s of sessions) {
    if (!s.cwd) continue;
    const node = s.node || (window.CSM_HOSTNAME || "local");
    const nodeUrl = s.nodeUrl || null;
    const key = `${node}|${s.cwd}`;
    const name = s.cwd.split("/").filter(Boolean).pop() || s.cwd;
    const cur = map.get(key);
    if (cur) {
      cur.count += 1;
    } else {
      map.set(key, { cwd: s.cwd, node, nodeUrl, name, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ─── API action wrappers ─────────────────────────────────────────────────────
// Helper: append nodeUrl as query param for remote proxy
function nodeQuery(nodeUrl) {
  return nodeUrl ? `?nodeUrl=${encodeURIComponent(nodeUrl)}` : "";
}

window.CSM_API = {
  async createSession(prompt, name, cwd, node, model) {
    const res = await fetch(`${API}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, name, cwd, node, model }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return mapSession(await res.json());
  },

  async stopSession(id, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}/stop${nodeQuery(nodeUrl)}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async respawnSession(id, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}/respawn${nodeQuery(nodeUrl)}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async restoreSession(id, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}/restore${nodeQuery(nodeUrl)}`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async removeSession(id, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}${nodeQuery(nodeUrl)}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async getLogs(id, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}/logs${nodeQuery(nodeUrl)}`);
    if (!res.ok) return "(error fetching logs)";
    const data = await res.json();
    return data.logs || "(no output)";
  },

  async getTranscript(id, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}/transcript${nodeQuery(nodeUrl)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.turns) ? data.turns : [];
  },

  async sendMessage(id, prompt, nodeUrl) {
    const res = await fetch(`${API}/sessions/${id}/message${nodeQuery(nodeUrl)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async browse(path, nodeUrl) {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (nodeUrl) params.set("nodeUrl", nodeUrl);
    const qs = params.toString();
    const url = qs ? `${API}/browse?${qs}` : `${API}/browse`;
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },

  async fetchNodes() {
    try {
      const res = await fetch(`${API}/nodes`);
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  },

  fetchSessions,
};

// ─── Initial load ────────────────────────────────────────────────────────────
(async () => {
  const sessions = await fetchSessions();
  window.SEED_SESSIONS = sessions;
  window.PROJECTS = deriveProjects(sessions);
  window.USAGE = deriveUsage(sessions);

  // Get health info (hostname, mode)
  try {
    const res = await fetch(`${API}/health`);
    if (res.ok) {
      const health = await res.json();
      if (health.hostname) window.CSM_HOSTNAME = health.hostname;
      if (health.mode) window.CSM_MODE = health.mode;
    }
  } catch {
    // ignore
  }

  // Get node statuses (multi-node mode)
  try {
    const nodes = await window.CSM_API.fetchNodes();
    if (Array.isArray(nodes)) window.CSM_NODES = nodes;
  } catch {
    // ignore
  }

  // Get roster (process info)
  try {
    const res = await fetch(`${API}/roster`);
    if (res.ok) {
      const roster = await res.json();
      if (Array.isArray(roster.remoteControls)) {
        window.REMOTE_CONTROLS = roster.remoteControls;
      }
    }
  } catch {
    // ignore
  }

  window._CSM_DATA_READY = true;
})();
