// Reusable presentational pieces: Header, ProjectGroupedList, ProjectKanban, Drawer.
// All read from props; no global state.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─── Formatters ──────────────────────────────────────────────────────────────
function fmtDuration(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
function fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtTokens(n) {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function statusBlurb(s) {
  if (s.status === "working") return s.currentTool ? `Using ${s.currentTool}` : "Working";
  if (s.status === "waiting") return "Waiting for input";
  if (s.status === "stopped") return s.stoppedReason ? `Stopped · ${s.stoppedReason}` : "Stopped";
  return s.status;
}

// ─── StatusDot ───────────────────────────────────────────────────────────────
function StatusCell({ status, blurb }) {
  return (
    <span className="status-label">
      <span className="dot" data-status={status} />
      <span>{blurb}</span>
    </span>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────
function Header({ theme, onToggleTheme, query, onQuery, onNew, onOpenPalette, terminalOpen, onToggleTerminal, view, onViewChange, filter, onFilter, counts }) {
  const inputRef = useRef(null);
  const [host, setHost] = useState(window.CSM_HOSTNAME || "");
  useEffect(() => {
    const fn = (e) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault(); inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  useEffect(() => {
    if (!host && window.CSM_HOSTNAME) setHost(window.CSM_HOSTNAME);
    const i = setInterval(() => {
      if (window.CSM_HOSTNAME && window.CSM_HOSTNAME !== host) setHost(window.CSM_HOSTNAME);
    }, 1000);
    return () => clearInterval(i);
  }, [host]);

  const filters = [
    { id: "all",      label: "All" },
    { id: "working",  label: "Working" },
    { id: "waiting",  label: "Waiting" },
    { id: "stopped",  label: "Stopped" },
    { id: "archived", label: "Archived" },
    { id: "dead",     label: "Dead" },
  ];

  return (
    <header className="hdr">
      <div className="hdr-brand">
        <img className="hdr-brand-icon" src="icon.png" alt="CSM" width="32" height="32" />
        <div className="hdr-brand-title">{host || "Session Manager"}<span className="muted">v0.5</span></div>
      </div>

      <div className="hdr-search">
        <Ico.search />
        <input
          ref={inputRef}
          placeholder="Search by id, name, prompt, branch…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="kbd-hint"><span className="kbd">/</span></span>
      </div>

      <div className="hdr-filters">
        {filters.map((f) => (
          <button
            key={f.id}
            className={"hdr-filter-btn" + (filter === f.id ? " active" : "")}
            onClick={() => onFilter(f.id)}
          >
            {f.id !== "all" && <span className="dot" data-status={f.id} style={{ width: 6, height: 6 }} />}
            {f.label}
            {(counts[f.id] ?? 0) > 0 && <span className="hdr-filter-count">{counts[f.id]}</span>}
          </button>
        ))}
      </div>

      <div className="hdr-spacer" />

      <div className="hdr-actions">
        <div className="view-toggle">
          <button data-active={view === "list"} onClick={() => onViewChange("list")} title="List view">
            <Ico.list />
          </button>
          <button data-active={view === "kanban"} onClick={() => onViewChange("kanban")} title="Kanban view">
            <Ico.grid />
          </button>
        </div>
        <a className="btn btn-ghost" href="/schedules" title="Scheduled jobs" style={{ textDecoration: "none" }}>
          Schedules
        </a>
        <button className={"btn btn-ghost btn-icon" + (terminalOpen ? " btn-active" : "")} onClick={onToggleTerminal} title="Toggle terminal (⌘`)" aria-label="Toggle terminal">
          <Ico.terminal />
        </button>
        <button className="btn btn-ghost btn-icon theme-tog" onClick={onToggleTheme} title={theme === "dark" ? "Light theme" : "Dark theme"} aria-label="Toggle theme">
          {theme === "dark" ? <Ico.sun /> : <Ico.moon />}
        </button>
        <button className="btn btn-primary" onClick={onNew}>
          <Ico.plus /> New session <span className="kbd" style={{ background: "rgba(0,0,0,.12)", border: 0, color: "inherit", opacity: .6 }}>⌘K</span>
        </button>
      </div>
    </header>
  );
}

// ─── Helper: group sessions by project ────────────────────────────────────────
function groupByProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = s.project || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return groups;
}

// ─── Project Grouped List (Claude-style) ─────────────────────────────────────
function ProjectGroupedList({ sessions, selectedId, onSelect, onAction }) {
  const groups = useMemo(() => groupByProject(sessions), [sessions]);

  if (sessions.length === 0) {
    return (
      <div className="empty">
        <div>
          <div className="ttl">No sessions match these filters</div>
          <div className="sub">Try clearing the search or picking a different status.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pgl">
      {[...groups.entries()].map(([project, items]) => (
        <div key={project} className="pgl-group">
          <div className="pgl-project-hdr">
            <span className="pgl-project-name">{project}</span>
            <span className="pgl-project-settings"><Ico.dots /></span>
          </div>
          <div className="pgl-items">
            {items.map((s) => (
              <div
                key={s.id}
                className={"pgl-item" + (selectedId === s.id ? " selected" : "")}
                onClick={() => onSelect(s.id)}
              >
                <span className="dot" data-status={s.status} style={{ width: 7, height: 7, flexShrink: 0 }} />
                <div className="pgl-item-main">
                  <div className="pgl-item-row1">
                    <span className="pgl-item-name">{s.name}</span>
                    <span className="pgl-item-prompt">{s.prompt}</span>
                  </div>
                  <div className="pgl-item-row2">
                    <span className="pgl-item-status">{statusBlurb(s)}</span>
                    <span className="pgl-item-sep">·</span>
                    <span className="pgl-item-detail">{fmtDuration(s.duration)}</span>
                    <span className="pgl-item-sep">·</span>
                    <span className="pgl-item-detail">{fmtTokens(s.tokensIn + s.tokensOut)} tok</span>
                    {s.branch && <>
                      <span className="pgl-item-sep">·</span>
                      <span className="pgl-item-detail"><Ico.branch /> {s.branch}</span>
                    </>}
                    {s.node && <>
                      <span className="pgl-item-sep">·</span>
                      <span className="pgl-item-detail pgl-item-node"><Ico.server /> {s.node}</span>
                    </>}
                  </div>
                </div>
                <div className="pgl-item-right">
                  <span className="pgl-item-meta">{fmtAgo(s.startedAt)}</span>
                  <span className="pgl-item-id">{s.id}</span>
                </div>
                <span className="pgl-item-actions">
                  {(() => {
                    const ls = s.lifecycleState || "active";
                    // Dead sessions cannot be revived — only deletion makes sense.
                    if (ls === "dead") {
                      return <button title="Delete metadata" onClick={(e) => { e.stopPropagation(); onAction("rm", s); }}><Ico.trash /></button>;
                    }
                    // Archived: bring back to default list. Respawn requires a separate click after restore.
                    if (ls === "archived") {
                      return <>
                        <button title="Restore" onClick={(e) => { e.stopPropagation(); onAction("restore", s); }}><Ico.refresh /></button>
                        <button title="Remove" onClick={(e) => { e.stopPropagation(); onAction("rm", s); }}><Ico.trash /></button>
                      </>;
                    }
                    // Active lifecycle — same Stop/Respawn behavior as before.
                    return <>
                      {s.status === "working" || s.status === "waiting" ? (
                        <button title="Stop" onClick={(e) => { e.stopPropagation(); onAction("stop", s); }}><Ico.stop /></button>
                      ) : (
                        <button title="Respawn" onClick={(e) => { e.stopPropagation(); onAction("respawn", s); }}><Ico.refresh /></button>
                      )}
                      <button title="Remove" onClick={(e) => { e.stopPropagation(); onAction("rm", s); }}><Ico.trash /></button>
                    </>;
                  })()}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Project Kanban ──────────────────────────────────────────────────────────
function ProjectKanban({ sessions, selectedId, onSelect, onAction }) {
  const groups = useMemo(() => groupByProject(sessions), [sessions]);

  if (sessions.length === 0) {
    return (
      <div className="empty">
        <div>
          <div className="ttl">No sessions match these filters</div>
          <div className="sub">Try clearing the search or picking a different status.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="kanban">
      {[...groups.entries()].map(([project, items]) => (
        <div key={project} className="kanban-col">
          <div className="kanban-col-hdr">
            <span className="kanban-col-name">{project}</span>
            <span className="kanban-col-count">{items.length}</span>
          </div>
          <div className="kanban-col-body">
            {items.map((s) => (
              <div
                key={s.id}
                className={"kanban-card" + (selectedId === s.id ? " selected" : "")}
                onClick={() => onSelect(s.id)}
              >
                <div className="kanban-card-hdr">
                  <span className="dot" data-status={s.status} style={{ width: 7, height: 7 }} />
                  <span className="kanban-card-name">{s.name}</span>
                </div>
                <div className="kanban-card-prompt">{s.prompt}</div>
                <div className="kanban-card-meta">
                  <span>{statusBlurb(s)}</span>
                  <span>·</span>
                  <span>{fmtDuration(s.duration)}</span>
                  <span>·</span>
                  <span>{fmtTokens(s.tokensIn + s.tokensOut)} tok</span>
                  <span style={{ marginLeft: "auto" }}>{fmtAgo(s.startedAt)}</span>
                </div>
                <div className="kanban-card-foot">
                  {s.branch && <span className="kanban-card-branch"><Ico.branch /> {s.branch}</span>}
                  {s.node && <span className="kanban-card-node"><Ico.server /> {s.node}</span>}
                  <span className="kanban-card-id">{s.id}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

window.Pieces = { Header, ProjectGroupedList, ProjectKanban, StatusCell, fmtDuration, fmtAgo, fmtTokens, statusBlurb };
