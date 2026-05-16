// Live data bridge: fetches from the backend API and exposes the same
// globals that the prototype mock layer provided.

const API = "/api";

// ─── Static config (will be populated from /api/roster and /api/sessions) ────

window.PROJECTS = [];
window.REMOTE_CONTROLS = [];
window.STATUS_ORDER = ["working", "queued", "needs_input", "idle", "completed", "stopped", "failed"];
window.SEED_SESSIONS = [];

// ─── Log templates (used by the drawer's synthetic log streamer) ─────────────
// In production the Logs tab will call /api/sessions/:id/logs instead,
// but we keep this so the prototype streamer still works for sessions
// that are actively working.
window.LOG_TEMPLATES = {
  default: [
    ["info", "system", "session started"],
    ["tool", "Read",   "reading file…"],
    ["ok",   "Read",   "done"],
    ["tool", "Bash",   "running command…"],
    ["info", "stdout", "output line"],
  ],
};

// ─── Map backend session → prototype session shape ───────────────────────────
function mapSession(s) {
  // Backend state → prototype status
  const stateMap = {
    working: "working",
    needs_input: "idle",
    idle: "idle",
    completed: "done",
    failed: "error",
    stopped: "stopped",
    unknown: "stopped",
  };

  const startedAt = s.createdAt ? new Date(s.createdAt).getTime() : Date.now();
  const duration = Math.floor((Date.now() - startedAt) / 1000);

  return {
    id: s.shortId,
    name: s.name || s.shortId,
    prompt: s.prompt || "(no prompt)",
    status: stateMap[s.state] || "stopped",
    project: "default",
    startedAt,
    duration,
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    worktree: null,
    branch: null,
    rc: null,
    model: "unknown",
    cwd: s.cwd || null,
    // Keep original state for API calls
    _backendState: s.state,
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

  async stopSession(shortId) {
    const res = await fetch(`${API}/sessions/${shortId}/stop`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async respawnSession(shortId) {
    const res = await fetch(`${API}/sessions/${shortId}/respawn`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async removeSession(shortId) {
    const res = await fetch(`${API}/sessions/${shortId}`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  },

  async getLogs(shortId) {
    const res = await fetch(`${API}/sessions/${shortId}/logs`);
    if (!res.ok) return "(error fetching logs)";
    const data = await res.json();
    return data.logs || "(no output)";
  },

  fetchSessions,
};

// ─── Initial load ────────────────────────────────────────────────────────────
(async () => {
  const sessions = await fetchSessions();
  window.SEED_SESSIONS = sessions;
  window.PROJECTS = deriveProjects(sessions);

  // Try to get roster for Remote Control info
  try {
    const res = await fetch(`${API}/roster`);
    if (res.ok) {
      const roster = await res.json();
      // If roster has RC info, populate REMOTE_CONTROLS
      if (Array.isArray(roster.remoteControls)) {
        window.REMOTE_CONTROLS = roster.remoteControls;
      }
    }
  } catch {
    // ignore
  }

  // Signal that data is ready (app.jsx polls this)
  window._CSM_DATA_READY = true;
})();
