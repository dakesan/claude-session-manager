// Reusable presentational pieces: StatusDot, Header, Sidebar, Table, Cards, Drawer, NewModal.
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
  if (s.status === "idle") return s.awaitingInput ? "Awaiting input" : "Idle";
  if (s.status === "done") return "Done";
  if (s.status === "stopped") return s.stoppedReason ? `Stopped · ${s.stoppedReason}` : "Stopped";
  if (s.status === "error") return "Error";
  if (s.status === "queued") return `Queued · #${s.queuePos ?? "?"}`;
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
function Header({ theme, onToggleTheme, query, onQuery, onNew, onOpenPalette }) {
  const inputRef = useRef(null);
  useEffect(() => {
    const fn = (e) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault(); inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  return (
    <header className="hdr">
      <div className="hdr-brand">
        <div className="hdr-brand-mark" aria-hidden="true">CS</div>
        <div className="hdr-brand-title">Session Manager<span className="muted">v0.4</span></div>
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

      <div className="hdr-spacer" />

      <div className="hdr-actions">
        <button className="btn btn-ghost btn-icon theme-tog" onClick={onToggleTheme} title={theme === "dark" ? "Light theme" : "Dark theme"} aria-label="Toggle theme">
          {theme === "dark" ? <Ico.sun /> : <Ico.moon />}
        </button>
        <button className="btn btn-ghost" onClick={onOpenPalette} title="Command palette">
          <Ico.dots />
        </button>
        <button className="btn btn-primary" onClick={onNew}>
          <Ico.plus /> New session <span className="kbd" style={{ background: "rgba(0,0,0,.12)", border: 0, color: "inherit", opacity: .6 }}>⌘K</span>
        </button>
      </div>
    </header>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function Sidebar({ filter, onFilter, counts, project, onProject, projectCounts }) {
  const filters = [
    { id: "all",     label: "All sessions" },
    { id: "working", label: "Working" },
    { id: "queued",  label: "Queued" },
    { id: "idle",    label: "Idle" },
    { id: "done",    label: "Done" },
    { id: "stopped", label: "Stopped" },
    { id: "error",   label: "Error" },
  ];

  return (
    <aside className="side">
      <div className="side-section">
        <div className="side-h">Filter</div>
        {filters.map((f) => (
          <div key={f.id} className="side-item" data-active={filter === f.id} onClick={() => onFilter(f.id)}>
            {f.id !== "all" && <span className="dot" data-status={f.id} />}
            {f.id === "all" && <span style={{ width: 8 }} />}
            <span>{f.label}</span>
            <span className="count">{counts[f.id] ?? 0}</span>
          </div>
        ))}
      </div>

      <div className="side-section">
        <div className="side-h">Remote control</div>
        {window.REMOTE_CONTROLS.map((rc) => (
          <div key={rc.name} className="rc-card">
            <div className="row">
              <span className="dot" data-status={rc.connected ? "working" : "stopped"} />
              <span className="name">{rc.name}</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }}>{rc.active}/{rc.capacity}</span>
            </div>
            <div className="meta">{rc.host}</div>
            <div className="bar"><span style={{ width: `${(rc.active / rc.capacity) * 100}%` }} /></div>
          </div>
        ))}
      </div>

      <div className="side-section">
        <div className="side-h">Projects</div>
        <div className="side-item" data-active={project === "all"} onClick={() => onProject("all")}>
          <span style={{ width: 8 }} /><span>All projects</span>
          <span className="count">{projectCounts.all}</span>
        </div>
        {window.PROJECTS.map((p) => (
          <div key={p.id} className="side-item" data-active={project === p.id} onClick={() => onProject(p.id)}>
            <span className="dot" style={{ background: p.color }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
            <span className="count">{projectCounts[p.id] ?? 0}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ─── Table ───────────────────────────────────────────────────────────────────
function SessionTable({ sessions, selectedId, onSelect, onAction }) {
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
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 130 }}>Status</th>
            <th style={{ width: 90 }}>ID</th>
            <th style={{ width: 160 }}>Name</th>
            <th>Prompt</th>
            <th style={{ width: 110 }}>Runtime</th>
            <th style={{ width: 110 }}>Tokens</th>
            <th style={{ width: 110 }}>Started</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} data-selected={selectedId === s.id} onClick={() => onSelect(s.id)}>
              <td className="col-status">
                <StatusCell status={s.status} blurb={statusBlurb(s)} />
              </td>
              <td className="col-id">{s.id}</td>
              <td className="col-name">{s.name}</td>
              <td className="col-prompt">{s.prompt}</td>
              <td className="col-runtime">{fmtDuration(s.duration)}</td>
              <td className="col-tokens">{fmtTokens(s.tokensIn + s.tokensOut)}</td>
              <td className="col-runtime" style={{ color: "var(--text-muted)" }}>{fmtAgo(s.startedAt)}</td>
              <td className="col-actions">
                <span className="row-actions">
                  {s.status === "working" || s.status === "idle" ? (
                    <button title="Stop" onClick={(e) => { e.stopPropagation(); onAction("stop", s); }}><Ico.stop /></button>
                  ) : (
                    <button title="Respawn" onClick={(e) => { e.stopPropagation(); onAction("respawn", s); }}><Ico.refresh /></button>
                  )}
                  <button title="Remove" onClick={(e) => { e.stopPropagation(); onAction("rm", s); }}><Ico.trash /></button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Cards view ──────────────────────────────────────────────────────────────
function SessionCards({ sessions, selectedId, onSelect }) {
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
    <div className="cards">
      {sessions.map((s) => (
        <div key={s.id} className="card" data-selected={selectedId === s.id} onClick={() => onSelect(s.id)}>
          <div className="hdr-row">
            <span className="dot" data-status={s.status} />
            <span className="name">{s.name}</span>
            <span className="id">{s.id}</span>
          </div>
          <div className="prompt">{s.prompt}</div>
          <div className="meta">
            <span style={{ color: "var(--text-muted)" }}>{statusBlurb(s)}</span>
            <span>·</span>
            <span className="dur">{fmtDuration(s.duration)}</span>
            <span>·</span>
            <span>{fmtTokens(s.tokensIn + s.tokensOut)} tok</span>
            <span style={{ marginLeft: "auto" }}>{fmtAgo(s.startedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

window.Pieces = { Header, Sidebar, SessionTable, SessionCards, StatusCell, fmtDuration, fmtAgo, fmtTokens, statusBlurb };
