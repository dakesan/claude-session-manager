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
                      session.status === "queued"  ? 0 :
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

function LogsTab({ s, paused, onTogglePause }) {
  const lines = useStreamingLogs(s, paused);
  const ref = useR(null);
  useE(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span className="pill"><span className="dot" data-status={s.status === "working" && !paused ? "working" : "stopped"} style={{ width: 6, height: 6 }} />
          {s.status === "working" && !paused ? "streaming" : paused ? "paused" : "static"}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{lines.length} lines</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {s.status === "working" && (
            <button className="btn btn-ghost" onClick={onTogglePause} title={paused ? "Resume" : "Pause"}>
              {paused ? <Ico.play /> : <Ico.pause />} {paused ? "Resume" : "Pause"}
            </button>
          )}
          <button className="btn btn-ghost" title="Copy"><Ico.copy /> Copy</button>
        </div>
      </div>

      <div className="logs" ref={ref}>
        {lines.map((l, i) => (
          <div key={l.id} className="line" data-sev={l.sev}>
            <span className="t">{fmtClock(l.t)}</span>
            <span className="sev">{sevGlyph(l.sev)}</span>
            <span className={"m" + (i === lines.length - 1 && s.status === "working" && !paused ? " caret" : "")}>
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

// ─── Drawer shell ────────────────────────────────────────────────────────────
function Drawer({ session, onClose, onAction, toast }) {
  const [tab, setTab] = useS("detail");
  const [paused, setPaused] = useS(false);
  useE(() => { setTab("detail"); setPaused(false); }, [session?.id]);

  useE(() => {
    const fn = (e) => { if (e.key === "Escape" && session) onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [session, onClose]);

  if (!session) return <div className="drawer" data-open="false" />;
  const s = session;

  const canStop = s.status === "working" || s.status === "idle" || s.status === "queued";
  const canRespawn = s.status === "done" || s.status === "stopped" || s.status === "error";

  return (
    <div className="drawer" data-open="true">
      {s.status === "working" && <div className="loader" />}

      <div className="drawer-hdr">
        <span className="dot" data-status={s.status} />
        <span className="name">{s.name}</span>
        <span className="id">{s.id}</span>
        <button className="btn btn-ghost btn-icon x" onClick={onClose} aria-label="Close"><Ico.x /></button>
      </div>

      <div className="drawer-actions">
        <button className="btn"><Ico.terminal /> Attach</button>
        {canStop && <button className="btn btn-danger" onClick={() => onAction("stop", s)}><Ico.stop /> Stop</button>}
        {canRespawn && <button className="btn" onClick={() => onAction("respawn", s)}><Ico.refresh /> Respawn</button>}
        {s.rc && <button className="btn"><Ico.link /> Open in RC <Ico.ext /></button>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost"><Ico.branch /> {s.branch || "no branch"}</button>
        <button className="btn btn-ghost btn-icon" title="More"><Ico.dots /></button>
      </div>

      <div className="drawer-tabs">
        <button data-active={tab === "detail"} onClick={() => setTab("detail")}>Detail</button>
        <button data-active={tab === "logs"} onClick={() => setTab("logs")}>
          Logs <span className="badge">live</span>
        </button>
        <button data-active={tab === "transcript"} onClick={() => setTab("transcript")}>
          Transcript <span className="badge">{s.turns}</span>
        </button>
      </div>

      <div className="drawer-body">
        {tab === "detail" && <DetailTab s={s} />}
        {tab === "logs" && <LogsTab s={s} paused={paused} onTogglePause={() => setPaused((p) => !p)} />}
        {tab === "transcript" && <TranscriptTab s={s} />}
      </div>
    </div>
  );
}

// ─── New Session modal ───────────────────────────────────────────────────────
function NewSessionModal({ open, onClose, onCreate }) {
  const [prompt, setPrompt] = useS("");
  const [name, setName] = useS("");
  const [model, setModel] = useS("claude-sonnet-4-5");
  const [project, setProject] = useS("monorepo-web");
  const [rc, setRc] = useS("lab-server");
  const taRef = useR(null);

  useE(() => {
    if (open) {
      setPrompt(""); setName("");
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
    onCreate({ prompt: trimmed, name: name.trim() || autoName(trimmed), model, project, rc });
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
