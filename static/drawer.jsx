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
        {s.node && <><dt>Node</dt><dd className="sans"><Ico.server /> {s.node}</dd></>}
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
        const raw = await window.CSM_API.getLogs(id, session.nodeUrl);
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

// Polling cadence: slow when idle, fast for a short window right after a send
// so the user's reply lands quickly instead of waiting up to a full slow tick.
const TRANSCRIPT_SLOW_MS = 3000;
const TRANSCRIPT_FAST_MS = 700;
const TRANSCRIPT_FAST_WINDOW_MS = 90000;

// `pendingSince` is the epoch-ms of the last send (or null). While it is recent,
// transcript polling switches to the fast cadence to surface the reply sooner.
function useRealTranscript(session, pendingSince) {
  const [turns, setTurns] = useS([]);
  const [loading, setLoading] = useS(false);
  const lastId = useR(null);

  useE(() => {
    if (!session?.sessionId && !session?.id) return;
    const id = session.sessionId || session.id;
    const reset = id !== lastId.current;
    lastId.current = id;
    if (reset) {
      setTurns([]);
      setLoading(true);
    }

    let cancelled = false;
    let timer = null;

    const fetchTurns = async () => {
      if (!window.CSM_API) return;
      try {
        const data = await window.CSM_API.getTranscript(id, session.nodeUrl);
        if (!cancelled) setTurns(data);
      } catch {
        // keep previous turns on transient failure
      }
      if (!cancelled) setLoading(false);
    };

    const active = session.status === "working" || session.status === "waiting";

    // Self-scheduling loop so the interval can adapt per tick. An immediate
    // fetch runs first (also fired right after a send, since pendingSince is
    // a dependency), then we re-arm only for active sessions.
    const tick = async () => {
      await fetchTurns();
      if (cancelled || !active) return;
      const fast = pendingSince && Date.now() - pendingSince < TRANSCRIPT_FAST_WINDOW_MS;
      timer = setTimeout(tick, fast ? TRANSCRIPT_FAST_MS : TRANSCRIPT_SLOW_MS);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [session?.sessionId, session?.id, session?.status, pendingSince]);

  return { turns, loading, refresh: async () => {
    if (!window.CSM_API) return;
    const id = session.sessionId || session.id;
    try {
      const data = await window.CSM_API.getTranscript(id, session.nodeUrl);
      setTurns(data);
    } catch {}
  }};
}

// Count assistant turns — used as a skew-free "a new reply arrived" signal
// (comparing counts avoids relying on browser vs. transcript clock alignment).
function countAssistantTurns(turns) {
  let n = 0;
  for (const t of turns) if (t.role === "assistant") n++;
  return n;
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

// Rotating "Claude is doing something" verbs, cycled to convey liveness while
// we wait — the backend gives no real-time progress, so this is purely cosmetic.
const CHAT_THINK_WORDS = ["Thinking", "Working", "Reading", "Processing", "Reasoning"];

// Live activity indicator shown in the composer foot. `phase` is "thinking"
// (reply in flight) or "spawning" (session still booting); `since` is epoch-ms
// used for the elapsed timer. Renders nothing when phase is falsy.
function ChatStatus({ phase, since }) {
  const [dots, setDots] = useS("");
  const [wordIdx, setWordIdx] = useS(0);
  const [now, setNow] = useS(Date.now());

  useE(() => {
    if (!phase) return;
    const d = setInterval(() => setDots((p) => (p.length >= 3 ? "" : p + ".")), 500);
    const w = setInterval(() => setWordIdx((i) => i + 1), 3000);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(d); clearInterval(w); clearInterval(t); };
  }, [phase]);

  if (!phase) return null;

  const label = phase === "spawning"
    ? "Starting Claude session"
    : CHAT_THINK_WORDS[wordIdx % CHAT_THINK_WORDS.length];
  const elapsed = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;

  return (
    <span className="chat-status" data-phase={phase} aria-live="polite">
      <span className="chat-status-dot" />
      <span className="chat-status-label">{label}{dots}</span>
      {since && (
        <>
          <span className="chat-status-sep">·</span>
          <span className="chat-status-elapsed">{Pieces.fmtDuration(elapsed)}</span>
        </>
      )}
    </span>
  );
}

function TranscriptComposer({ session, phase, phaseSince, onSent, onError }) {
  const [text, setText] = useS("");
  const [sending, setSending] = useS(false);
  const [uploading, setUploading] = useS(false);
  const [dragHover, setDragHover] = useS(false);
  // [{name, path, size, type}]
  const [pending, setPending] = useS([]);
  const taRef = useR(null);
  const fileRef = useR(null);

  const stopped = session.status === "stopped";
  // Files can only be sent through the protocol on CSM-launched sessions.
  const supportsAttachments = session.launchedBy === "csm";

  const uploadFiles = async (fileList) => {
    if (!supportsAttachments || stopped) return;
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const id = session.sessionId || session.id;
      const data = await window.CSM_API.uploadFiles(id, files, session.nodeUrl);
      setPending((prev) => [...prev, ...(data.files || [])]);
    } catch (e) {
      onError?.(e.message || String(e));
    }
    setUploading(false);
  };

  const removePending = (path) => {
    setPending((prev) => prev.filter((p) => p.path !== path));
  };

  const submit = async () => {
    const trimmed = text.trim();
    if ((!trimmed && pending.length === 0) || sending || stopped) return;
    setSending(true);
    try {
      const attachments = pending.map((p) => p.path);
      await window.CSM_API.sendMessage(
        session.sessionId || session.id,
        trimmed,
        session.nodeUrl,
        attachments.length ? attachments : undefined,
      );
      setText("");
      setPending([]);
      onSent?.(trimmed, attachments);
    } catch (e) {
      onError?.(e.message || String(e));
    }
    setSending(false);
    setTimeout(() => taRef.current?.focus(), 0);
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragHover(false);
    if (!supportsAttachments) return;
    uploadFiles(e.dataTransfer.files);
  };

  const onPaste = (e) => {
    if (!supportsAttachments || stopped) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      // Clipboard images usually arrive with no name (just type=image/png).
      // Give them a stable, descriptive default so they land sensibly.
      if (!blob.name || blob.name === "image.png") {
        const ext = (blob.type.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
        const named = new File([blob], `clipboard-${Date.now()}.${ext}`, { type: blob.type });
        files.push(named);
      } else {
        files.push(blob);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    uploadFiles(files);
  };

  return (
    <div
      className={"transcript-composer" + (dragHover ? " drag-over" : "")}
      onDragOver={(e) => {
        if (!supportsAttachments) return;
        e.preventDefault();
        setDragHover(true);
      }}
      onDragLeave={() => setDragHover(false)}
      onDrop={onDrop}
    >
      {pending.length > 0 && (
        <div className="composer-attachments">
          {pending.map((p) => (
            <span key={p.path} className="composer-attachment-chip" title={p.path}>
              <span className="composer-attachment-name">{p.name}</span>
              <span className="composer-attachment-size">{fmtBytes(p.size)}</span>
              <button
                className="composer-attachment-remove"
                onClick={() => removePending(p.path)}
                aria-label="Remove"
                type="button"
              >×</button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={stopped
          ? "Session is stopped — respawn to send messages"
          : supportsAttachments
            ? "Type a follow-up prompt…  (⌘/Ctrl + Enter to send · drop or paste files to attach)"
            : "Type a follow-up prompt…  (⌘/Ctrl + Enter to send)"}
        disabled={stopped || sending}
        rows={3}
      />
      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ""; }}
      />
      <div className="transcript-composer-foot">
        {sending || uploading ? (
          <span className="transcript-composer-hint">{sending ? "sending…" : "uploading…"}</span>
        ) : phase ? (
          <ChatStatus phase={phase} since={phaseSince} />
        ) : (
          <span className="transcript-composer-hint">
            {stopped ? "respawn first" : "delivered via tmux paste"}
          </span>
        )}
        {supportsAttachments && (
          <button
            className="btn btn-ghost"
            disabled={uploading || sending || stopped}
            onClick={() => fileRef.current?.click()}
            type="button"
            title="Attach file"
          >
            <Ico.folder /> Attach
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={(!text.trim() && pending.length === 0) || sending || stopped || uploading}
          onClick={submit}
        >
          <Ico.plus /> Send
        </button>
      </div>
    </div>
  );
}

const IMG_EXTS = /\.(png|jpe?g|gif|webp|svg)$/i;

// Configure marked once on load (idempotent). GFM + line breaks + headerless.
if (window.marked && !window.__csmMarkedConfigured) {
  window.marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
  });
  window.__csmMarkedConfigured = true;
}

function renderMarkdown(text) {
  if (!text) return "";
  if (!window.marked || !window.DOMPurify) {
    // Fallback: render as preformatted text if libs failed to load.
    return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  const html = window.marked.parse(text);
  return window.DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel"],
  });
}

function Markdown({ text }) {
  const html = useM(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function TranscriptAttachment({ path, nodeUrl }) {
  const name = path.split("/").pop() || path;
  const isImage = IMG_EXTS.test(path);
  const href = window.CSM_API.fileUrl(path, nodeUrl);
  if (isImage) {
    return (
      <a className="transcript-attachment-img" href={href} target="_blank" rel="noreferrer" title={path}>
        <img src={href} alt={name} loading="lazy" />
      </a>
    );
  }
  return (
    <a className="transcript-attachment-file" href={href} target="_blank" rel="noreferrer" title={path}>
      <Ico.folder />
      <span className="transcript-attachment-name">{name}</span>
    </a>
  );
}

function TranscriptTurn({ turn, nodeUrl }) {
  const isUser = turn.role === "user";
  return (
    <div className={"transcript-turn" + (isUser ? " is-user" : " is-assistant")}>
      <div className="transcript-turn-role">
        {turn.role}
        <span className="transcript-turn-time">{fmtClock(turn.t)}</span>
      </div>
      {turn.text && (
        <div className="transcript-turn-text">
          <Markdown text={turn.text} />
        </div>
      )}
      {turn.attachments && turn.attachments.length > 0 && (
        <div className="transcript-turn-attachments">
          {turn.attachments.map((p) => (
            <TranscriptAttachment key={p} path={p} nodeUrl={nodeUrl} />
          ))}
        </div>
      )}
      {turn.tools && turn.tools.length > 0 && (
        <div className="transcript-turn-tools">
          {turn.tools.map((tool, i) => (
            <div key={i} className="transcript-tool">
              <span className="transcript-tool-name">{tool.name}</span>
              {tool.summary && <span className="transcript-tool-summary">{tool.summary}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Hard cap on how long the "thinking" indicator stays up with no reply, so a
// silently dropped injection can't leave the spinner spinning forever.
const CHAT_THINK_MAX_MS = 6 * 60 * 1000;
// A freshly launched CSM session shows a "spawning" hint until its first turn
// lands or this window elapses — guards against a stuck-empty session.
const CHAT_SPAWN_WINDOW_MS = 60000;

function TranscriptTab({ s, onToast }) {
  // `pending` tracks an in-flight reply: when we sent and the assistant-turn
  // count at that moment, so we can detect when a *new* reply has arrived.
  const [pending, setPending] = useS(null); // { sentAt, baseAssistantCount } | null
  const { turns, loading, refresh } = useRealTranscript(s, pending?.sentAt ?? null);
  const [optimistic, setOptimistic] = useS([]);
  const listRef = useR(null);

  // Reset send-state when the viewed session changes.
  useE(() => { setPending(null); }, [s.sessionId, s.id]);

  // Clear the thinking indicator once a new assistant turn has arrived and the
  // session has settled (status left "working"), or after the safety cap.
  useE(() => {
    if (!pending) return;
    const newReply = countAssistantTurns(turns) > pending.baseAssistantCount;
    const settled = s.status !== "working";
    const expired = Date.now() - pending.sentAt > CHAT_THINK_MAX_MS;
    if (s.status === "stopped" || expired || (newReply && settled)) {
      setPending(null);
    }
  }, [turns, s.status, pending]);

  // Phase shown in the composer foot. Thinking takes precedence over spawning.
  const phase = useM(() => {
    if (pending) return "thinking";
    const fresh = s.launchedBy === "csm"
      && turns.length === 0
      && s.status !== "stopped"
      && Date.now() - s.startedAt < CHAT_SPAWN_WINDOW_MS;
    return fresh ? "spawning" : null;
  }, [pending, turns.length, s.status, s.launchedBy, s.startedAt]);

  // When real turns catch up to optimistic ones, drop the latter
  useE(() => {
    if (optimistic.length === 0) return;
    setOptimistic((prev) =>
      prev.filter((opt) => !turns.some((t) => t.text === opt.text && t.role === "user" && t.t >= opt.t - 5000)),
    );
  }, [turns]);

  const allTurns = useM(() => [...turns, ...optimistic], [turns, optimistic]);

  // Auto-scroll to the latest message whenever the turn count grows OR the
  // session being viewed changes. Two RAFs guarantee the new turns + the
  // bottom attachments section are laid out before we measure scrollHeight.
  useE(() => {
    if (!listRef.current) return;
    const el = listRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }, [allTurns.length, s.sessionId, s.id]);

  return (
    <div className="transcript-wrap">
      <div className="transcript-toolbar">
        <span className="pill">
          <span className="dot" data-status={s.status === "stopped" ? "stopped" : "working"} style={{ width: 6, height: 6 }} />
          {loading && turns.length === 0 ? "loading" : `${turns.length} turn${turns.length === 1 ? "" : "s"}`}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" title="Refresh" onClick={refresh}>
          <Ico.refresh /> Refresh
        </button>
      </div>

      <div className="transcript-list" ref={listRef}>
        {allTurns.length === 0 && !loading && (
          <div className="transcript-empty">No conversation yet</div>
        )}
        {allTurns.map((t) => <TranscriptTurn key={t.uuid} turn={t} nodeUrl={s.nodeUrl} />)}
      </div>

      <TranscriptComposer
        session={s}
        phase={phase}
        phaseSince={pending?.sentAt ?? null}
        onSent={(text, attachments) => {
          setOptimistic((prev) => [...prev, {
            uuid: `opt-${Date.now()}`,
            role: "user",
            text: text || (attachments && attachments.length ? "(attachments)" : ""),
            attachments: attachments && attachments.length ? attachments : undefined,
            t: Date.now(),
          }]);
          // Snapshot the current assistant-turn count so we can tell when the
          // reply to *this* message lands, and start fast polling for it.
          setPending({ sentAt: Date.now(), baseAssistantCount: countAssistantTurns(turns) });
          const count = (attachments || []).length;
          onToast?.(count ? `Message sent · ${count} file${count === 1 ? "" : "s"}` : "Message sent");
        }}
        onError={(msg) => onToast?.(`Send failed: ${msg}`)}
      />
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
function Drawer({ session, onClose, onAction, onToast }) {
  const [tab, setTab] = useS("transcript");
  const [paused, setPaused] = useS(false);
  const [menuOpen, setMenuOpen] = useS(false);
  useE(() => { setTab("transcript"); setPaused(false); setMenuOpen(false); }, [session?.id]);


  if (!session) return null;
  const s = session;

  const lifecycle = s.lifecycleState || "active";
  const isDead = lifecycle === "dead";
  const isArchived = lifecycle === "archived";
  const canStop = !isDead && !isArchived && (s.status === "working" || s.status === "waiting");
  const canRespawn = !isDead && !isArchived && s.status === "stopped";
  const canRestore = isArchived;

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
        {s.launchedBy && (
          <span
            className="session-origin-badge"
            data-origin={s.launchedBy}
            title={s.launchedBy === "csm" ? "Launched by CSM" : "Discovered (external)"}
          >
            {s.launchedBy === "csm" ? "CSM" : "EXT"}
          </span>
        )}
        <span className="id">{s.id}</span>
        <button className="btn btn-ghost btn-icon x" onClick={onClose} aria-label="Close"><Ico.x /></button>
      </div>

      <div className="panel-actions">
        {canStop && <button className="btn btn-danger" onClick={() => onAction("stop", s)}><Ico.stop /> Stop</button>}
        {canRespawn && <button className="btn" onClick={() => onAction("respawn", s)}><Ico.refresh /> Respawn</button>}
        {canRestore && <button className="btn" onClick={() => onAction("restore", s)}><Ico.refresh /> Restore</button>}
        {isDead && <span className="btn btn-ghost" style={{ pointerEvents: "none", opacity: 0.7 }}>Cannot revive — transcript missing</span>}
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
        {/* `key` on each tab body forces a clean unmount/remount when the
            user switches sessions, so per-session local state (draft text,
            pending uploads, optimistic turns, paused logs, xterm) cannot
            bleed across into the next session's view. */}
        {tab === "detail" && <DetailTab key={s.sessionId || s.id} s={s} />}
        {tab === "logs" && <LogsTab key={s.sessionId || s.id} s={s} paused={paused} onTogglePause={() => setPaused((p) => !p)} />}
        {tab === "transcript" && <TranscriptTab key={s.sessionId || s.id} s={s} onToast={onToast} />}
        {tab === "terminal" && <TerminalTab key={s.sessionId || s.id} s={s} />}
      </div>
    </div>
  );
}

// ─── Path Browser ───────────────────────────────────────────────────────────
function PathBrowser({ value, onChange, nodeUrl, nodeLabel }) {
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
      const data = await window.CSM_API.browse(path || undefined, nodeUrl || undefined);
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
            <span className="path-browser-current">
              {nodeLabel ? <span style={{ color: "var(--text-dim)", marginRight: 6 }}>{nodeLabel}:</span> : null}
              {current}
            </span>
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
              <div key={d.path} className="path-browser-item" onClick={() => handleNavigate(d.path)} title="Enter directory">
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
  const [model, setModel] = useS("");          // "" = CLI default
  const [node, setNode] = useS("");            // empty = local
  const taRef = useR(null);

  useE(() => {
    if (open) {
      setPrompt(""); setName(""); setCwd(""); setNode(""); setModel("");
      setTimeout(() => taRef.current?.focus(), 50);
    }
  }, [open]);

  function submit() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onCreate({ prompt: trimmed, name: name.trim() || autoName(trimmed), cwd: cwd.trim() || undefined, model: model || undefined, node: node || undefined });
    onClose();
  }

  function autoName(p) {
    // Strip non-[a-z0-9-], then collapse repeats and trim edge dashes so a
    // mostly-non-ASCII prompt like "…Snakemake…" doesn't yield "-snakemake-"
    // (which used to break claude's argv parser before we switched to
    // --flag=value form).
    const slug = p.split(/\s+/).slice(0, 3).join("-").toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "");
    return slug || "session";
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
          {window.CSM_MODE === "host" && window.CSM_NODES.length > 0 && <>
            <label>Target node</label>
            <div className="opt-grid">
              {window.CSM_NODES.map((n) => (
                <div key={n.name} className={"opt" + (!n.online ? " opt-disabled" : "")} data-active={node === n.name || (!node && !n.url)}
                  onClick={() => {
                    if (!n.online) return;
                    const next = n.url ? n.name : "";
                    if (next !== node) { setNode(next); setCwd(""); }
                  }}>
                  <span className="lbl"><Ico.server /> {n.name}</span>
                  <span className="h">{n.online ? `${n.sessionCount} sessions` : "offline"}</span>
                </div>
              ))}
            </div>
          </>}

          <label>Prompt</label>
          <textarea ref={taRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder='e.g. "Find and fix the flaky test in apps/web/__tests__/checkout-flow.spec.ts"' />

          <label>Working directory</label>
          <PathBrowser
            value={cwd}
            onChange={setCwd}
            nodeUrl={(() => {
              const n = (window.CSM_NODES || []).find((x) => x.name === node);
              return n?.url || null;
            })()}
            nodeLabel={node || (window.CSM_HOSTNAME || "local")}
          />

          <label>Name <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)", fontWeight: 400 }}>optional</span></label>
          <input className="txt" value={name} onChange={(e) => setName(e.target.value)} placeholder={prompt ? autoName(prompt) : "auto"} />

          <label>Model</label>
          <div className="opt-grid">
            {[
              { v: "",       l: "Default", s: "CLI default" },
              { v: "haiku",  l: "Haiku",   s: "alias · fast · cheap" },
              { v: "sonnet", l: "Sonnet",  s: "alias · balanced" },
              { v: "opus",   l: "Opus",    s: "alias · deepest" },
            ].map((m) => (
              <div key={m.v || "default"} className="opt" data-active={model === m.v} onClick={() => setModel(m.v)}>
                <span className="lbl">{m.l}</span>
                <span className="h">{m.s}</span>
              </div>
            ))}
          </div>

          {(window.USAGE || []).length > 0 && <>
            <label>Recently used <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)", fontWeight: 400 }}>click to set node + working directory</span></label>
            <div className="opt-grid">
              {(window.USAGE || []).slice(0, 12).map((u) => {
                const targetNodeName = u.nodeUrl ? u.node : "";
                const active = (node === targetNodeName) && (cwd === u.cwd);
                return (
                  <div key={`${u.node}|${u.cwd}`} className="opt" data-active={active}
                    onClick={() => { setNode(targetNodeName); setCwd(u.cwd); }}
                    title={u.cwd}>
                    <span className="lbl">{u.name}</span>
                    <span className="h"><Ico.server /> {u.node} · {u.count}x</span>
                  </div>
                );
              })}
            </div>
          </>}
        </div>

        <div className="modal-foot">
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
