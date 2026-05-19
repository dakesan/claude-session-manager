// Live data bridge: fetches from the backend API and exposes the same
// globals that the prototype mock layer provided.

const API = "/api";

// ─── Static config ───────────────────────────────────────────────────────────

window.PROJECTS = [];
window.REMOTE_CONTROLS = [];
window.STATUS_ORDER = ["working", "queued", "needs_input", "idle", "completed", "stopped", "failed"];
window.SEED_SESSIONS = [];

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
function mapSession(s) {
  // Backend returns: sessionId, shortId, name, state, prompt, cwd,
  //                  createdAt, pid, projectSlug, gitBranch, model, version
  const startedAt = s.createdAt ? new Date(s.createdAt).getTime() : Date.now();
  const duration = Math.floor((Date.now() - startedAt) / 1000);

  return {
    id: s.shortId,
    name: s.name || s.shortId,
    prompt: s.prompt || "(no prompt)",
    status: s.state || "stopped",
    project: s.projectSlug || "default",
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
  };
}

// ─── Fetch sessions from API ─────────────────────────────────────────────────
async function fetchSessions() {
  try {
    const res = await fetch(`${API}/sessions`);
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

// ─── API action wrappers ─────────────────────────────────────────────────────
window.CSM_API = {
  async createSession(prompt, name, cwd) {
    const res = await fetch(`${API}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, name, cwd }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return mapSession(await res.json());
  },

  async stopSession(id) {
    // id here is shortId; backend accepts both shortId and sessionId
    const res = await fetch(`${API}/sessions/${id}/stop`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async respawnSession(id) {
    const res = await fetch(`${API}/sessions/${id}/respawn`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async removeSession(id) {
    const res = await fetch(`${API}/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async getLogs(id) {
    const res = await fetch(`${API}/sessions/${id}/logs`);
    if (!res.ok) return "(error fetching logs)";
    const data = await res.json();
    return data.logs || "(no output)";
  },

  async browse(path) {
    const url = path ? `${API}/browse?path=${encodeURIComponent(path)}` : `${API}/browse`;
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },

  fetchSessions,
};

// ─── Initial load ────────────────────────────────────────────────────────────
(async () => {
  const sessions = await fetchSessions();
  window.SEED_SESSIONS = sessions;
  window.PROJECTS = deriveProjects(sessions);

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
