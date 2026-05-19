// Drawer (session detail) + New Session modal.

const { useState: useS, useEffect: useE, useRef: useR, useMemo: useM } = React;

// ─── Synthetic log streamer ──────────────────────────────────────────────────
function useStreamingLogs(session, paused) {
  const [lines, setLines] = useS([]);
  const idx = useR(0);
  const last = useR(Date.now());

  useE(() => {
    setLines([]);
    idx.current = 0;
    last.current = Date.now() - 60000;
  }, [session?.id]);

  useE(() => {
    if (!session) return;
    const tmpl = window.LOG_TEMPLATES.default;
    // pre-seed: backfill ~half the template so the box never feels empty
    const seedCount = session.status === "working" ? Math.min(14, tmpl.length) :
                      session.status === "waiting" ? Math.min(14, tmpl.length) :
                      tmpl.length;
    const seeded = [];
    let t = Date.now() - 60000;
    for (let i = 0; i < seedCount; i++) {
      const [sev, ch, m] = tmpl[i];
      t += 600 + Math.random() * 1400;
      seeded.push({ id: i, sev, ch, m, t });
    }
    setLines(seeded);
    idx.current = seedCount;

    if (paused || session.status !== "working") return;

    const tick = setInterval(() => {
      idx.current = (idx.current + 1) % tmpl.length;
      const [sev, ch, m] = tmpl[idx.current];
      setLines((prev) => {
        const next = [...prev, { id: prev.length, sev, ch, m, t: Date.now() }];
        return next.slice(-200);
      });
    }, 1400 + Math.random() * 1100);
    return () => clearInterval(tick);
  }, [session?.id, session?.status, paused]);

  return lines;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function sevGlyph(s) {
  return s === "tool" ? "▸" : s === "ok" ? "✓" : s === "warn" ? "!" : s === "err" ? "✗" : "·";
}

// Lightweight log message renderer with tag + filename highlighting
function LogMessage({ ch, m }) {
  // Highlight file paths and common patterns
  const parts = [];
  let rest = m;
  const fileRe = /([\w./-]+\.[a-z]{1,4}(?::\d+(?:-\d+)?)?)/;
  let i = 0;
  while (rest.length && i < 12) {
    const match = rest.match(fileRe);
    if (!match) { parts.push(<span key={i++}>{rest}</span>); break; }
    parts.push(<span key={i++}>{rest.slice(0, match.index)}</span>);
    parts.push(<span key={i++} className="file">{match[0]}</span>);
    rest = rest.slice(match.index + match[0].length);
  }
  return (
    <span>
      <span className="tag">{ch}</span>
      {parts}
    </span>
  );
}

// ─── Drawer body sections ────────────────────────────────────────────────────
function DetailTab({ s }) {
  const stateJson = `{
  "id": "${s.id}",
  "name": "${s.name}",
  "status": "${s.status}",
  "model": "${s.model}",
  "started_at": ${Math.floor(s.startedAt / 1000)},
  "worktree": "${s.worktree || ''}",
  "branch": "${s.branch || ''}",
  "rc_session": ${s.rc ? `"${s.rc}"` : 'null'},
  "turns": ${s.turns},
  "usage": { "input_tokens": ${s.tokensIn}, "output_tokens": ${s.tokensOut} },
  "cost_usd": ${s.cost.toFixed(4)}
}`;

  return (
    <div>
      <div className="metric-row">
        <div className="metric">
          <div className="l">Runtime</div>
          <div className="v">{Pieces.fmtDuration(s.duration)}</div>
        </div>
        <div className="metric">
          <div className="l">Turns</div>
          <div className="v">{s.turns}</div>
        </div>
        <div className="metric">
          <div className="l">Tokens</div>
          <div className="v">{Pieces.fmtTokens(s.tokensIn + s.tokensOut)}<span className="s">total</span></div>
        </div>
        <div className="metric">
          <div className="l">Cost</div>
          <div className="v">${s.cost.toFixed(2)}</div>
        </div>
      </div>

      <div className="section-h">Prompt <span className="line" /></div>
      <div className="prompt-box">{s.prompt}</div>

      <div className="section-h">Session <span className="line" /></div>
      <dl className="detail-grid">
        <dt>Status</dt><dd className="sans"><Pieces.StatusCell status={s.status} blurb={Pieces.statusBlurb(s)} /></dd>
        <dt>Model</dt><dd>{s.model}</dd>
        <dt>Project</dt><dd className="sans">{(window.PROJECTS.find(p => p.id === s.project) || {}).name}</dd>
        <dt>Branch</dt><dd>{s.branch || <span style={{ color: "var(--text-dim)" }}>—</span>}</dd>
        <dt>Worktree</dt><dd>{s.worktree || <span style={{ color: "var(--text-dim)" }}>—</span>}</dd>
        <dt>RC session</dt><dd>
          {s.rc ? (
            <span className="rc-link"><span className="dot" data-status="working" style={{ width: 6, height: 6 }} /> {s.rc} <Ico.ext /></span>
          ) : <span style={{ color: "var(--text-dim)" }}>—</span>}
        </dd>
        <dt>Started</dt><dd>{Pieces.fmtAgo(s.startedAt)}</dd>
        {s.error && <><dt style={{ color: "var(--st-error)" }}>Error</dt><dd className="sans" style={{ color: "var(--st-error)" }}>{s.error}</dd></>}
      </dl>

      <div className="section-h">state.json <span className="line" /><span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, textTransform: "none", letterSpacing: 0 }}>~/.claude/jobs/{s.id}/state.json</span></div>
      <pre className="code-box">{stateJson}</pre>
    </div>
  );
}

function useRealLogs(session) {
  const [lines, setLines] = useS([]);
  const [loading, setLoading] = useS(false);
  const lastId = useR(null);

  useE(() => {
    if (!session?.sessionId && !session?.id) return;
    const id = session.sessionId || session.id;
    if (id === lastId.current) return;
    lastId.current = id;
    setLoading(true);
    setLines([]);

    const fetchLogs = async () => {
      if (!window.CSM_API) return;
      try {
        const raw = await window.CSM_API.getLogs(id);
        const parsed = raw.split("\n").filter(Boolean).map((line, i) => {
          const sev = line.startsWith("[user]") ? "info"
            : line.startsWith("[assistant]") ? "ok"
            : line.startsWith("[system]") ? "tool"
            : line.startsWith("[title]") ? "info"
            : "info";
          const ch = line.match(/^\[(\w+)\]/)?.[1] || "log";
          const m = line.replace(/^\[\w+\]\s*/, "");
          return { id: i, sev, ch, m, t: Date.now() - (raw.split("\n").length - i) * 1000 };
        });
        setLines(parsed);
      } catch {
        setLines([{ id: 0, sev: "err", ch: "error", m: "Failed to fetch logs", t: Date.now() }]);
      }
      setLoading(false);
    };

    fetchLogs();
    // Re-fetch every 5 seconds for active sessions
    if (session.status === "working" || session.status === "waiting") {
      const i = setInterval(fetchLogs, 5000);
      return () => clearInterval(i);
    }
  }, [session?.sessionId, session?.id, session?.status]);

  return { lines, loading };
}

function LogsTab({ s, paused, onTogglePause }) {
  const { lines, loading } = useRealLogs(s);
  const ref = useR(null);
  useE(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span className="pill"><span className="dot" data-status={s.status === "stopped" ? "stopped" : "working"} style={{ width: 6, height: 6 }} />
          {loading ? "loading" : s.status === "stopped" ? "static" : "live"}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{lines.length} lines</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-ghost" title="Copy" onClick={() => {
            const text = lines.map(l => `[${l.ch}] ${l.m}`).join("\n");
            navigator.clipboard?.writeText(text);
          }}><Ico.copy /> Copy</button>
        </div>
      </div>

      <div className="logs" ref={ref}>
        {lines.length === 0 && !loading && (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
            No log output yet
          </div>
        )}
        {lines.map((l, i) => (
          <div key={l.id} className="line" data-sev={l.sev}>
            <span className="t">{fmtClock(l.t)}</span>
            <span className="sev">{sevGlyph(l.sev)}</span>
            <span className={"m" + (i === lines.length - 1 && s.status === "working" ? " caret" : "")}>
              <LogMessage ch={l.ch} m={l.m} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TranscriptTab({ s }) {
  // Lightweight conversation preview
  const turns = [
    { role: "user", text: s.prompt },
    { role: "assistant", text: "I'll start by looking at the current behavior. Let me read the test file and run it a handful of times to confirm the failure rate." },
    { role: "tool", text: "Bash · pnpm vitest run checkout-flow --reporter=verbose" },
    { role: "assistant", text: "The test passed locally on the first run. Let me loop it 50× and capture the failures so I can see what's varying between runs." },
    { role: "tool", text: "Bash · for i in {1..50}; do …" },
    { role: "assistant", text: "Got it — 11 of 50 fail. The pattern matches CI. Looking at the test, the issue is in `useDraftOrder`: the effect depends on `cart` (object) and `cart.items`, but `cart` reference churns from an unrelated mutation, racing the draft restore." },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {turns.map((t, i) => (
        <div key={i} style={{
          padding: "10px 14px",
          borderRadius: 10,
          background: t.role === "user" ? "var(--surface-2)" :
                      t.role === "tool" ? "var(--surface)" : "transparent",
          border: t.role === "tool" ? ".5px solid var(--border)" : "none",
          fontFamily: t.role === "tool" ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: t.role === "tool" ? 11.5 : 12.5,
          color: t.role === "tool" ? "var(--st-idle)" : "var(--text)",
          lineHeight: 1.55,
        }}>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4, fontFamily: "var(--font-sans)" }}>
            {t.role}
          </div>
          {t.text}
        </div>
      ))}
      <div style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center", marginTop: 6 }}>
        Transcript truncated · {s.turns} turns total · ~/.claude/projects/{s.project}/{s.id}.jsonl
      </div>
    </div>
  );
}

// ─── Shared terminal creation helper ─────────────────────────────────────────
const XTERM_THEME = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "rgba(255,255,255,0.18)",
  black: "#1a1a1a",
  red: "#ff6b6b",
  green: "#69db7c",
  yellow: "#ffd43b",
  blue: "#74c0fc",
  magenta: "#da77f2",
  cyan: "#66d9e8",
  white: "#e5e5e5",
  brightBlack: "#555",
  brightRed: "#ff8787",
  brightGreen: "#8ce99a",
  brightYellow: "#ffe066",
  brightBlue: "#a5d8ff",
  brightMagenta: "#e599f7",
  brightCyan: "#99e9f2",
  brightWhite: "#ffffff",
};

function useXterm(containerRef, cwd, key) {
  const termRef = useR(null);
  const wsRef = useR(null);
  const fitRef = useR(null);

  useE(() => {
    if (!containerRef.current) return;

    const term = new window.Terminal({
      fontFamily: "'Hack Nerd Font Mono', 'Geist Mono', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: XTERM_THEME,
      allowProposedApi: true,
    });

    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;

    const links = new window.WebLinksAddon.WebLinksAddon();
    term.loadAddon(links);

    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws/terminal?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => { term.focus(); };
    ws.onmessage = (ev) => { term.write(ev.data); };
    ws.onclose = () => { term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n"); };
    ws.onerror = () => { term.write("\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n"); };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
    };
  }, [key]);

  return { termRef, wsRef, fitRef };
}

// ─── Terminal tab (xterm.js + WebSocket) ────────────────────────────────────
function TerminalTab({ s }) {
  const containerRef = useR(null);
  useXterm(containerRef, s.cwd || "~", s.id);

  return (
    <div className="terminal-tab">
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}

// ─── Global terminal panel (session-independent) ────────────────────────────
function GlobalTerminalPanel({ open, onClose }) {
  const containerRef = useR(null);
  const [connected, setConnected] = useS(false);

  // Only mount xterm when open
  useE(() => {
    if (!open || !containerRef.current) return;

    const term = new window.Terminal({
      fontFamily: "'Hack Nerd Font Mono', 'Geist Mono', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: XTERM_THEME,
      allowProposedApi: true,
    });

    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);

    const links = new window.WebLinksAddon.WebLinksAddon();
    term.loadAddon(links);

    term.open(containerRef.current);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws/terminal?cwd=${encodeURIComponent("~")}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => { setConnected(true); term.focus(); };
    ws.onmessage = (ev) => { term.write(ev.data); };
    ws.onclose = () => { setConnected(false); term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n"); };
    ws.onerror = () => { term.write("\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n"); };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      ws.close();
      term.dispose();
      setConnected(false);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="global-terminal">
      <div className="global-terminal-hdr">
        <Ico.terminal />
        <span className="global-terminal-title">Terminal</span>
        <span className={"global-terminal-status" + (connected ? " connected" : "")}>
          <span className="dot" data-status={connected ? "working" : "stopped"} style={{ width: 6, height: 6 }} />
          {connected ? "connected" : "disconnected"}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close terminal">
          <Ico.x />
        </button>
      </div>
      <div ref={containerRef} className="global-terminal-body" />
    </div>
  );
}

// ─── Dropdown menu ──────────────────────────────────────────────────────────
function DropdownMenu({ open, onClose, items }) {
  const ref = useR(null);
  useE(() => {
    if (!open) return;
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div ref={ref} className="dropdown-menu">
      {items.map((item, i) => item.separator ? (
        <div key={i} className="dropdown-sep" />
      ) : (
        <button key={i} className={"dropdown-item" + (item.danger ? " danger" : "")} onClick={() => { item.onClick(); onClose(); }}>
          {item.icon} <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Drawer shell ────────────────────────────────────────────────────────────
function Drawer({ session, onClose, onAction, toast }) {
  const [tab, setTab] = useS("detail");
  const [paused, setPaused] = useS(false);
  const [menuOpen, setMenuOpen] = useS(false);
  useE(() => { setTab("detail"); setPaused(false); setMenuOpen(false); }, [session?.id]);

  useE(() => {
    const fn = (e) => {
      if (e.key === "Escape" && session) {
        // Don't intercept Escape when terminal tab is active (xterm handles it)
        if (tab === "terminal") return;
        if (menuOpen) setMenuOpen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [session, onClose, menuOpen, tab]);

  if (!session) return null;
  const s = session;

  const canStop = s.status === "working" || s.status === "waiting";
  const canRespawn = s.status === "stopped";

  const menuItems = [
    { label: "Copy session ID", icon: <Ico.copy />, onClick: () => navigator.clipboard?.writeText(s.sessionId || s.id) },
    { label: "Copy logs", icon: <Ico.copy />, onClick: async () => {
      if (window.CSM_API) {
        const logs = await window.CSM_API.getLogs(s.sessionId || s.id);
        navigator.clipboard?.writeText(logs);
      }
    }},
    { separator: true },
    { label: "Remove session", icon: <Ico.trash />, danger: true, onClick: () => onAction("rm", s) },
  ];

  return (
    <div className="panel">
      {(s.status === "working") && <div className="loader" />}

      <div className="panel-hdr">
        <span className="dot" data-status={s.status} />
        <span className="name">{s.name}</span>
        <span className="id">{s.id}</span>
        <button className="btn btn-ghost btn-icon x" onClick={onClose} aria-label="Close"><Ico.x /></button>
      </div>

      <div className="panel-actions">
        {canStop && <button className="btn btn-danger" onClick={() => onAction("stop", s)}><Ico.stop /> Stop</button>}
        {canRespawn && <button className="btn" onClick={() => onAction("respawn", s)}><Ico.refresh /> Respawn</button>}
        <a className="btn" href={s.rc || "https://claude.ai/code"} target="_blank" rel="noopener"><Ico.link /> Remote Control <Ico.ext /></a>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost"><Ico.branch /> {s.branch || "no branch"}</button>
        <div style={{ position: "relative" }}>
          <button className="btn btn-ghost btn-icon" title="More" onClick={() => setMenuOpen(!menuOpen)}><Ico.dots /></button>
          <DropdownMenu open={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />
        </div>
      </div>

      <div className="panel-tabs">
        <button data-active={tab === "detail"} onClick={() => setTab("detail")}>Detail</button>
        <button data-active={tab === "logs"} onClick={() => setTab("logs")}>
          Logs <span className="badge">live</span>
        </button>
        <button data-active={tab === "transcript"} onClick={() => setTab("transcript")}>
          Transcript <span className="badge">{s.turns}</span>
        </button>
        <button data-active={tab === "terminal"} onClick={() => setTab("terminal")}>
          Terminal
        </button>
      </div>

      <div className={tab === "terminal" ? "panel-body panel-body-terminal" : "panel-body"}>
        {tab === "detail" && <DetailTab s={s} />}
        {tab === "logs" && <LogsTab s={s} paused={paused} onTogglePause={() => setPaused((p) => !p)} />}
        {tab === "transcript" && <TranscriptTab s={s} />}
        {tab === "terminal" && <TerminalTab s={s} />}
      </div>
    </div>
  );
}

// ─── Path Browser ───────────────────────────────────────────────────────────
function PathBrowser({ value, onChange }) {
  const [open, setOpen] = useS(false);
  const [dirs, setDirs] = useS([]);
  const [current, setCurrent] = useS("");
  const [parentPath, setParent] = useS(null);
  const [loading, setLoading] = useS(false);
  const ref = useR(null);

  useE(() => {
    if (!open) return;
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);

  const browse = async (path) => {
    if (!window.CSM_API?.browse) return;
    setLoading(true);
    try {
      const data = await window.CSM_API.browse(path || undefined);
      setDirs(data.dirs || []);
      setCurrent(data.current || "");
      setParent(data.parent || null);
    } catch {
      setDirs([]);
    }
    setLoading(false);
  };

  const handleOpen = () => {
    setOpen(true);
    browse(value || undefined);
  };

  const handleSelect = (path) => {
    onChange(path);
    setOpen(false);
  };

  const handleNavigate = (path) => {
    browse(path);
  };

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="txt"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~ (home directory)"
          style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
        <button className="btn" type="button" onClick={handleOpen} title="Browse directories">
          <Ico.folder /> Browse
        </button>
      </div>
      {open && (
        <div className="path-browser">
          <div className="path-browser-header">
            <span className="path-browser-current">{current}</span>
            <button className="btn btn-ghost btn-icon" onClick={() => handleSelect(current)} title="Select this directory">
              <Ico.check />
            </button>
          </div>
          {parentPath && (
            <div className="path-browser-item path-browser-parent" onClick={() => handleNavigate(parentPath)}>
              ↑ ..
            </div>
          )}
          <div className="path-browser-list">
            {loading && <div className="path-browser-empty">Loading…</div>}
            {!loading && dirs.length === 0 && <div className="path-browser-empty">No subdirectories</div>}
            {!loading && dirs.map((d) => (
              <div key={d.path} className="path-browser-item" onDoubleClick={() => handleNavigate(d.path)} onClick={() => handleSelect(d.path)}>
                <Ico.folder /> {d.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Session modal ───────────────────────────────────────────────────────
function NewSessionModal({ open, onClose, onCreate }) {
  const [prompt, setPrompt] = useS("");
  const [name, setName] = useS("");
  const [cwd, setCwd] = useS("");
  const [model, setModel] = useS("claude-sonnet-4-5");
  const [project, setProject] = useS("monorepo-web");
  const [rc, setRc] = useS("lab-server");
  const taRef = useR(null);

  useE(() => {
    if (open) {
      setPrompt(""); setName(""); setCwd("");
      setTimeout(() => taRef.current?.focus(), 50);
    }
  }, [open]);

  useE(() => {
    if (!open) return;
    const fn = (e) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  });

  function submit() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onCreate({ prompt: trimmed, name: name.trim() || autoName(trimmed), cwd: cwd.trim() || undefined, model, project, rc });
    onClose();
  }

  function autoName(p) {
    return p.split(/\s+/).slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "session";
  }

  if (!open) return null;
  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target.classList.contains("modal-scrim")) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-hdr">
          <div className="t">New background session</div>
          <div className="s">claude --bg "&lt;prompt&gt;" — runs detached, returns a short id.</div>
        </div>
        <div className="modal-body">
          <label>Prompt</label>
          <textarea ref={taRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder='e.g. "Find and fix the flaky test in apps/web/__tests__/checkout-flow.spec.ts"' />

          <label>Working directory</label>
          <PathBrowser value={cwd} onChange={setCwd} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label>Name <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)", fontWeight: 400 }}>optional</span></label>
              <input className="txt" value={name} onChange={(e) => setName(e.target.value)} placeholder={prompt ? autoName(prompt) : "auto"} />
            </div>
            <div>
              <label>Remote control</label>
              <div style={{ display: "flex", gap: 6 }}>
                {window.REMOTE_CONTROLS.map((r) => (
                  <div key={r.name} className="opt" data-active={rc === r.name} onClick={() => setRc(r.name)} style={{ flex: 1, padding: "8px 10px" }}>
                    <span className="lbl" style={{ fontSize: 11.5 }}>{r.name}</span>
                    <span className="h">{r.active}/{r.capacity}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <label>Model</label>
          <div className="opt-grid">
            {[
              { v: "claude-haiku-4-5",  l: "Haiku 4.5",  s: "fast · cheap" },
              { v: "claude-sonnet-4-5", l: "Sonnet 4.5", s: "balanced · default" },
              { v: "claude-opus-4-5",   l: "Opus 4.5",   s: "deepest · slowest" },
              { v: "claude-sonnet-4-5-thinking", l: "Sonnet 4.5 + thinking", s: "extended reasoning" },
            ].map((m) => (
              <div key={m.v} className="opt" data-active={model === m.v} onClick={() => setModel(m.v)}>
                <span className="lbl">{m.l}</span>
                <span className="h">{m.s}</span>
              </div>
            ))}
          </div>

          <label>Project</label>
          <div className="opt-grid">
            {window.PROJECTS.map((p) => (
              <div key={p.id} className="opt" data-active={project === p.id} onClick={() => setProject(p.id)}>
                <span className="lbl">{p.name}</span>
                <span className="h">{p.id}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <div className="shortcut-list">
            <span className="item"><span className="kbd">esc</span> close</span>
            <span className="item"><span className="kbd">⌘</span><span className="kbd">↵</span> create</span>
          </div>
          <div className="grow" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!prompt.trim()} onClick={submit} style={{ opacity: prompt.trim() ? 1 : .5 }}>
            <Ico.plus /> Launch session
          </button>
        </div>
      </div>
    </div>
  );
}

window.Drawer = Drawer;
window.NewSessionModal = NewSessionModal;
window.GlobalTerminalPanel = GlobalTerminalPanel;
