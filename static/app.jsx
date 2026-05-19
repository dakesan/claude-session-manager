// Top-level app: state, filtering, theme toggle, modal & drawer wiring.

const { useState: uS, useEffect: uE, useMemo: uM, useCallback: uC } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "view": "list",
  "density": "regular",
  "accentTone": "neutral",
  "showStatusPulse": true
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [theme, setTheme] = uS(() => {
    const saved = localStorage.getItem("csm-theme");
    return saved || "dark";
  });
  uE(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("csm-theme", theme);
  }, [theme]);

  const [sessions, setSessions] = uS(window.SEED_SESSIONS || []);
  const [selectedId, setSelectedId] = uS(null);
  const [query, setQuery] = uS("");

  // Poll API for session updates every 3 seconds
  uE(() => {
    const poll = async () => {
      if (window.CSM_API) {
        const fresh = await window.CSM_API.fetchSessions();
        if (fresh.length > 0 || sessions.length > 0) {
          setSessions(fresh);
          window.PROJECTS = window.CSM_API ? (function() {
            const seen = new Set();
            const projects = [];
            for (const s of fresh) {
              if (!seen.has(s.project)) { seen.add(s.project); projects.push({ id: s.project, name: s.project, color: "var(--st-idle)" }); }
            }
            return projects;
          })() : [];
        }
      }
    };
    const i = setInterval(poll, 3000);
    return () => clearInterval(i);
  }, []);
  const [filter, setFilter] = uS("all");
  const [view, setView] = uS(t.view);
  const [modalOpen, setModalOpen] = uS(false);
  const [terminalOpen, setTerminalOpen] = uS(false);
  const [toast, setToast] = uS(null);

  uE(() => setView(t.view), [t.view]);

  // Live-tick durations for working sessions
  uE(() => {
    const i = setInterval(() => {
      setSessions((prev) => prev.map((s) =>
        s.status === "working" ? { ...s, duration: s.duration + 1 } : s
      ));
    }, 1000);
    return () => clearInterval(i);
  }, []);

  const counts = uM(() => {
    const c = { all: sessions.length };
    for (const s of sessions) c[s.status] = (c[s.status] || 0) + 1;
    return c;
  }, [sessions]);

  const filtered = uM(() => {
    let xs = sessions;
    if (filter !== "all") xs = xs.filter((s) => s.status === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      xs = xs.filter((s) =>
        s.id.includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q)
      );
    }
    // Sort: by status priority, then by startedAt desc
    return [...xs].sort((a, b) => {
      const ai = window.STATUS_ORDER.indexOf(a.status);
      const bi = window.STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return b.startedAt - a.startedAt;
    });
  }, [sessions, filter, query]);

  const selected = uM(() => sessions.find((s) => s.id === selectedId) || null, [sessions, selectedId]);

  const showToast = uC((msg) => {
    setToast(msg);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => setToast(null), 2200);
  }, []);

  // Actions — call backend API, then optimistically update UI
  const handleAction = uC(async (kind, s) => {
    try {
      if (kind === "stop" && window.CSM_API) await window.CSM_API.stopSession(s.id);
      if (kind === "respawn" && window.CSM_API) await window.CSM_API.respawnSession(s.id);
      if (kind === "rm" && window.CSM_API) await window.CSM_API.removeSession(s.id);
    } catch (e) {
      showToast(`Error: ${e.message}`);
      return;
    }

    setSessions((prev) => {
      if (kind === "rm") return prev.filter((x) => x.id !== s.id);
      return prev.map((x) => {
        if (x.id !== s.id) return x;
        if (kind === "stop") return { ...x, status: "stopped", stoppedReason: "user requested" };
        if (kind === "respawn") return { ...x, status: "working", duration: 0, startedAt: Date.now(), stoppedReason: undefined, error: undefined };
        return x;
      });
    });
    const verb = { stop: "Stopped", respawn: "Respawned", rm: "Removed", attach: "Attached to" }[kind] || kind;
    showToast(`${verb} ${s.name} · ${s.id}`);
    if (kind === "rm" && selectedId === s.id) setSelectedId(null);
  }, [selectedId, showToast]);

  const handleCreate = uC(async (opts) => {
    try {
      if (window.CSM_API) {
        const newSession = await window.CSM_API.createSession(opts.prompt, opts.name, opts.cwd);
        setSessions((prev) => [newSession, ...prev]);
        setSelectedId(newSession.id);
        showToast(`Launched ${newSession.name} · ${newSession.id}`);
        return;
      }
    } catch (e) {
      showToast(`Launch failed: ${e.message}`);
      return;
    }
    // Fallback: local-only session (shouldn't happen with backend)
    const id = Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const newSession = {
      id, name: opts.name, prompt: opts.prompt,
      status: "working", project: opts.project || "default",
      startedAt: Date.now(), duration: 0, turns: 0,
      tokensIn: 0, tokensOut: 0, cost: 0,
      worktree: null, branch: null,
      rc: opts.rc, model: opts.model,
    };
    setSessions((prev) => [newSession, ...prev]);
    setSelectedId(id);
    showToast(`Launched ${opts.name} · ${id}`);
  }, [showToast]);

  // Global shortcuts
  uE(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setModalOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault(); setTheme((th) => th === "dark" ? "light" : "dark");
      } else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault(); setTerminalOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  return (
    <div className="app">
      <Pieces.Header
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        query={query}
        onQuery={setQuery}
        onNew={() => setModalOpen(true)}
        onOpenPalette={() => setModalOpen(true)}
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        view={view}
        onViewChange={(v) => { setView(v); setTweak("view", v); }}
        filter={filter}
        onFilter={setFilter}
        counts={counts}
      />

      <main className="main main-full">
        <div className="split-view">
          <div className="split-list">
            {view === "list"
              ? <Pieces.ProjectGroupedList sessions={filtered} selectedId={selectedId} onSelect={setSelectedId} onAction={handleAction} />
              : <Pieces.ProjectKanban sessions={filtered} selectedId={selectedId} onSelect={setSelectedId} onAction={handleAction} />}
          </div>
          {selected && (<>
            <div className="split-panel-scrim" onClick={() => setSelectedId(null)} />
            <div className="split-panel">
              <Drawer
                session={selected}
                onClose={() => setSelectedId(null)}
                onAction={handleAction}
              />
            </div>
          </>)}
        </div>
      </main>

      <NewSessionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreate}
      />

      <GlobalTerminalPanel
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
      />

      <div className="toast" data-show={!!toast}>
        <Ico.check />
        <span>{toast}</span>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Display" />
        <TweakRadio label="View" value={view} options={["list", "kanban"]} onChange={(v) => { setView(v); setTweak("view", v); }} />
        <TweakSelect label="Theme" value={theme} options={["dark", "light"]} onChange={setTheme} />
        <TweakToggle label="Pulse working sessions" value={t.showStatusPulse} onChange={(v) => setTweak("showStatusPulse", v)} />
        <TweakSection label="Demo" />
        <TweakButton label="Launch demo session" onClick={() => handleCreate({
          prompt: "Demo prompt — refactor the navigation header to use the new spacing tokens.",
          name: "demo-" + Math.random().toString(16).slice(2, 6),
          model: "claude-sonnet-4-5", project: "design-system", rc: "lab-server",
        })} />
      </TweaksPanel>
    </div>
  );
}

// Pulse toggle: drop @keyframes animation when disabled
function applyPulse(on) {
  const id = "no-pulse-style";
  let el = document.getElementById(id);
  if (on) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    el.textContent = `.dot[data-status="working"]{animation:none!important;box-shadow:none!important}`;
    document.head.appendChild(el);
  }
}
const _origApp = App;
function AppWithPulse() {
  const [t] = useTweaks(TWEAK_DEFAULTS);
  uE(() => applyPulse(t.showStatusPulse !== false), [t.showStatusPulse]);
  return <_origApp />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<AppWithPulse />);
