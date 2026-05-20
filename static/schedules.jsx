// Schedule management page — separate UI from main session dashboard.

const { useState, useEffect, useMemo, useCallback } = React;

const API = "/api";

// ─── API helpers ────────────────────────────────────────────────────────────
async function apiList() {
  const res = await fetch(`${API}/schedules`);
  if (!res.ok) throw new Error("Failed to load schedules");
  return res.json();
}
async function apiCreate(body) {
  const res = await fetch(`${API}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}
async function apiUpdate(id, body) {
  const res = await fetch(`${API}/schedules/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}
async function apiDelete(id) {
  const res = await fetch(`${API}/schedules/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
}
async function apiRun(id) {
  const res = await fetch(`${API}/schedules/${id}/run`, { method: "POST" });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}
async function apiBrowse(path) {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  const qs = params.toString();
  const res = await fetch(qs ? `${API}/browse?${qs}` : `${API}/browse`);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}
async function apiModels() {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

// ─── Cron utilities ─────────────────────────────────────────────────────────
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad2(n) { return n.toString().padStart(2, "0"); }

function presetToCron(preset) {
  const { kind, hour, minute, dow } = preset;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (kind === "daily") return `${m} ${h} * * *`;
  if (kind === "weekly") return `${m} ${h} * * ${dow}`;
  if (kind === "hourly") return `${m} * * * *`;
  return "";
}

// Try to parse a cron expression back into a preset; null if not a known preset
function cronToPreset(cron) {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  const isNum = (s) => /^\d+$/.test(s);

  if (dom === "*" && mon === "*" && dow === "*" && isNum(m) && isNum(h)) {
    return { kind: "daily", hour: pad2(parseInt(h, 10)), minute: pad2(parseInt(m, 10)), dow: "1" };
  }
  if (dom === "*" && mon === "*" && isNum(dow) && isNum(m) && isNum(h)) {
    return { kind: "weekly", hour: pad2(parseInt(h, 10)), minute: pad2(parseInt(m, 10)), dow };
  }
  if (h === "*" && dom === "*" && mon === "*" && dow === "*" && isNum(m)) {
    return { kind: "hourly", hour: "00", minute: pad2(parseInt(m, 10)), dow: "1" };
  }
  return null;
}

function describeCron(cron) {
  const p = cronToPreset(cron);
  if (!p) return cron;
  if (p.kind === "daily") return `Daily at ${p.hour}:${p.minute}`;
  if (p.kind === "weekly") return `Weekly on ${DAY_NAMES[parseInt(p.dow, 10)]} at ${p.hour}:${p.minute}`;
  if (p.kind === "hourly") return `Every hour at :${p.minute}`;
  return cron;
}

// ─── PathBrowser (local-only; mirrors the one in drawer.jsx) ───────────────
function PathBrowser({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState([]);
  const [current, setCurrent] = useState("");
  const [parentPath, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const ref = React.useRef(null);

  useEffect(() => {
    if (!open) return;
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);

  const browse = async (path) => {
    setLoading(true);
    try {
      const data = await apiBrowse(path || undefined);
      setDirs(data.dirs || []);
      setCurrent(data.current || "");
      setParent(data.parent || null);
    } catch {
      setDirs([]);
    }
    setLoading(false);
  };

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="sch-form-input mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~ (home directory)"
          style={{ flex: 1 }}
        />
        <button
          className="btn"
          type="button"
          onClick={() => { setOpen(true); browse(value || undefined); }}
          title="Browse directories"
        >
          📁 Browse
        </button>
      </div>
      {open && (
        <div className="path-browser">
          <div className="path-browser-header">
            <span className="path-browser-current">{current}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => { onChange(current); setOpen(false); }}
              title="Select this directory"
            >
              ✓
            </button>
          </div>
          {parentPath && (
            <div className="path-browser-item path-browser-parent" onClick={() => browse(parentPath)}>
              ↑ ..
            </div>
          )}
          <div className="path-browser-list">
            {loading && <div className="path-browser-empty">Loading…</div>}
            {!loading && dirs.length === 0 && <div className="path-browser-empty">No subdirectories</div>}
            {!loading && dirs.map((d) => (
              <div key={d.path} className="path-browser-item" onClick={() => browse(d.path)} title="Enter directory">
                📁 {d.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Model picker (fetches /api/models) ────────────────────────────────────
function ModelPicker({ value, onChange, modelData }) {
  if (!modelData) {
    return (
      <input
        className="sch-form-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Loading models…"
      />
    );
  }
  const options = [
    { id: "",   label: "Default", description: "CLI default" },
    ...modelData.aliases.map((a) => ({ ...a, alias: true })),
    ...modelData.models,
  ];
  return (
    <div>
      <select className="sch-form-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((m) => (
          <option key={m.id || "default"} value={m.id}>
            {m.label}{m.alias ? " (alias)" : ""}{m.id ? ` — ${m.id}` : ""}
          </option>
        ))}
      </select>
      <div className="sch-form-hint">
        {(() => {
          const sel = options.find((o) => o.id === value);
          return sel?.description || "";
        })()}
      </div>
    </div>
  );
}

function fmtDateLocal(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

// ─── Form ───────────────────────────────────────────────────────────────────
function ScheduleForm({ initial, onCancel, onSubmit, modelData }) {
  const initialPreset = initial ? cronToPreset(initial.cron) : { kind: "daily", hour: "09", minute: "00", dow: "1" };
  const initialMode = initial ? (initialPreset ? "preset" : "custom") : "preset";

  const [name, setName] = useState(initial?.name || "");
  const [prompt, setPrompt] = useState(initial?.prompt || "");
  const [cwd, setCwd] = useState(initial?.cwd || "");
  const [model, setModel] = useState(initial?.model || "");
  const [timezone, setTimezone] = useState(initial?.timezone || "Asia/Tokyo");
  const [enabled, setEnabled] = useState(initial?.enabled !== false);

  const [mode, setMode] = useState(initialMode); // "preset" | "custom"
  const [preset, setPreset] = useState(initialPreset || { kind: "daily", hour: "09", minute: "00", dow: "1" });
  const [customCron, setCustomCron] = useState(initial?.cron || "0 9 * * *");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const effectiveCron = mode === "preset" ? presetToCron(preset) : customCron.trim();

  const submit = useCallback(async (e) => {
    e?.preventDefault?.();
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    if (!prompt.trim()) { setError("Prompt is required"); return; }
    if (!effectiveCron) { setError("Schedule is required"); return; }
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        prompt,
        cwd: cwd.trim() || undefined,
        model: model.trim() || undefined,
        timezone: timezone.trim() || "Asia/Tokyo",
        enabled,
        cron: effectiveCron,
      });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  }, [name, prompt, cwd, model, timezone, enabled, effectiveCron, onSubmit]);

  return (
    <div className="sch-modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form className="sch-modal" onSubmit={submit}>
        <div className="sch-modal-hdr">
          <div className="t">{initial ? "Edit schedule" : "New schedule"}</div>
          <div className="s">Runs as a regular CSM session at the scheduled time.</div>
        </div>

        <div className="sch-modal-body">
          <label className="sch-form-label">Name</label>
          <input
            className="sch-form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Plaud daily sync"
            autoFocus
          />

          <label className="sch-form-label">Prompt</label>
          <textarea
            className="sch-form-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="/plaud-to-obsidian   or any prompt you'd type in a Claude session"
          />

          <label className="sch-form-label">Working directory</label>
          <PathBrowser value={cwd} onChange={setCwd} />

          <label className="sch-form-label">Model</label>
          <ModelPicker value={model} onChange={setModel} modelData={modelData} />

          <label className="sch-form-label">Schedule</label>
          <div className="sch-tabs">
            <button type="button" data-active={mode === "preset"} onClick={() => setMode("preset")}>Preset</button>
            <button type="button" data-active={mode === "custom"} onClick={() => setMode("custom")}>Custom cron</button>
          </div>

          {mode === "preset" ? (
            <div>
              <div className="sch-preset-row">
                <div>
                  <label>Frequency</label>
                  <select className="sch-form-select" value={preset.kind} onChange={(e) => setPreset({ ...preset, kind: e.target.value })}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="hourly">Hourly</option>
                  </select>
                </div>
                {preset.kind === "weekly" && (
                  <div>
                    <label>Day</label>
                    <select className="sch-form-select" value={preset.dow} onChange={(e) => setPreset({ ...preset, dow: e.target.value })}>
                      {DAY_NAMES.map((n, i) => <option key={i} value={String(i)}>{n}</option>)}
                    </select>
                  </div>
                )}
                {preset.kind !== "hourly" && (
                  <div>
                    <label>Hour</label>
                    <input
                      className="sch-form-input mono"
                      type="number" min="0" max="23"
                      style={{ width: 70 }}
                      value={preset.hour}
                      onChange={(e) => setPreset({ ...preset, hour: e.target.value })}
                    />
                  </div>
                )}
                <div>
                  <label>Minute</label>
                  <input
                    className="sch-form-input mono"
                    type="number" min="0" max="59"
                    style={{ width: 70 }}
                    value={preset.minute}
                    onChange={(e) => setPreset({ ...preset, minute: e.target.value })}
                  />
                </div>
              </div>
              <div className="sch-form-hint">cron: <code>{presetToCron(preset)}</code> — {describeCron(presetToCron(preset))}</div>
            </div>
          ) : (
            <div>
              <input
                className="sch-form-input mono"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder="m h dom mon dow"
              />
              <div className="sch-form-hint">Standard 5-field cron (minute hour day-of-month month day-of-week).</div>
            </div>
          )}

          <div className="sch-row-2">
            <div>
              <label className="sch-form-label">Timezone</label>
              <input
                className="sch-form-input mono"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Tokyo"
              />
            </div>
            <div>
              <label className="sch-form-label">Enabled</label>
              <div style={{ paddingTop: 6 }}>
                <span
                  className="sch-toggle"
                  data-on={enabled}
                  onClick={() => setEnabled(!enabled)}
                  role="switch"
                  aria-checked={enabled}
                />
                <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-muted)" }}>
                  {enabled ? "On" : "Off"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="sch-modal-foot">
          {error && <span className="err">{error}</span>}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Saving…" : (initial ? "Save" : "Create")}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Item ───────────────────────────────────────────────────────────────────
function ScheduleItem({ s, onEdit, onDelete, onToggle, onRun, runningId }) {
  const last = s.lastRun;
  const running = runningId === s.id;

  return (
    <div className="sch-item" data-disabled={!s.enabled}>
      <div>
        <div className="sch-item-head">
          <span className="sch-item-name">{s.name}</span>
          <span className="sch-item-cron" title={s.cron}>{s.cron}</span>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
            {describeCron(s.cron)}
          </span>
          <span className="sch-item-tz">{s.timezone}</span>
        </div>
        <div className="sch-item-prompt" title={s.prompt}>{s.prompt}</div>
        <div className="sch-item-meta">
          <span><strong>Next</strong>{fmtDateLocal(s.nextRun)}</span>
          <span><strong>Last</strong>
            {last ? (
              <>
                {fmtDateLocal(last.firedAt)}{" "}
                <span className={last.status === "ok" ? "sch-status-ok" : "sch-status-err"}>
                  {last.status === "ok" ? "✓" : "✗"}
                </span>
                {last.shortId && (
                  <a href={`/#${last.shortId}`} style={{ marginLeft: 6, color: "var(--text-muted)" }}>
                    {last.shortId}
                  </a>
                )}
                {last.error && <span className="sch-status-err" title={last.error}> — {last.error}</span>}
              </>
            ) : "—"}
          </span>
          {s.cwd && <span><strong>Cwd</strong><code style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{s.cwd}</code></span>}
        </div>
      </div>

      <div className="sch-item-actions">
        <span
          className="sch-toggle"
          data-on={s.enabled}
          onClick={() => onToggle(s)}
          role="switch"
          aria-checked={s.enabled}
          title={s.enabled ? "Disable" : "Enable"}
        />
        <button className="btn btn-ghost" onClick={() => onRun(s)} disabled={running}>
          {running ? "Running…" : "Run now"}
        </button>
        <button className="btn btn-ghost" onClick={() => onEdit(s)}>Edit</button>
        <button className="btn btn-ghost btn-danger" onClick={() => onDelete(s)}>Delete</button>
      </div>
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
function SchedulesApp() {
  const [theme, setTheme] = useState(() => localStorage.getItem("csm-theme") || "dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("csm-theme", theme);
  }, [theme]);

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | { mode: "new" | "edit", schedule? }
  const [error, setError] = useState(null);
  const [runningId, setRunningId] = useState(null);
  const [modelData, setModelData] = useState(null);

  useEffect(() => {
    apiModels().then(setModelData).catch(() => setModelData(null));
  }, []);

  const reload = useCallback(async () => {
    try {
      const data = await apiList();
      setList(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    const i = setInterval(reload, 10000);
    return () => clearInterval(i);
  }, [reload]);

  const handleCreate = async (body) => {
    await apiCreate(body);
    setEditing(null);
    await reload();
  };
  const handleUpdate = async (body) => {
    await apiUpdate(editing.schedule.id, body);
    setEditing(null);
    await reload();
  };
  const handleToggle = async (s) => {
    try {
      await apiUpdate(s.id, { enabled: !s.enabled });
      await reload();
    } catch (e) { setError(e.message); }
  };
  const handleDelete = async (s) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    try {
      await apiDelete(s.id);
      await reload();
    } catch (e) { setError(e.message); }
  };
  const handleRun = async (s) => {
    setRunningId(s.id);
    try {
      await apiRun(s.id);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="sch-app">
      <header className="sch-hdr">
        <div className="sch-hdr-brand">
          Schedules
          <span className="muted">Claude Session Manager</span>
        </div>
        <div className="sch-hdr-spacer" />
        <a href="/" className="sch-hdr-link">← Sessions</a>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Toggle theme"
          aria-label="Toggle theme"
          style={{ marginLeft: 8 }}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </header>

      <main className="sch-main">
        <div className="sch-container">
          <div className="sch-title-row">
            <h1>Scheduled jobs</h1>
            <span className="grow" />
            <button className="btn btn-primary" onClick={() => setEditing({ mode: "new" })}>
              + New schedule
            </button>
          </div>

          {error && (
            <div className="sch-empty" style={{ borderColor: "var(--st-error, oklch(0.65 0.18 25))", color: "var(--st-error, oklch(0.65 0.18 25))" }}>
              {error}
            </div>
          )}

          {loading ? (
            <div className="sch-empty">Loading…</div>
          ) : list.length === 0 ? (
            <div className="sch-empty">
              <div style={{ marginBottom: 8 }}>No schedules yet.</div>
              <div style={{ fontSize: 13 }}>Create one to run a Claude session on a recurring schedule.</div>
            </div>
          ) : (
            <div className="sch-list">
              {list.map((s) => (
                <ScheduleItem
                  key={s.id}
                  s={s}
                  onEdit={(s) => setEditing({ mode: "edit", schedule: s })}
                  onDelete={handleDelete}
                  onToggle={handleToggle}
                  onRun={handleRun}
                  runningId={runningId}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      {editing && (
        <ScheduleForm
          initial={editing.mode === "edit" ? editing.schedule : null}
          onCancel={() => setEditing(null)}
          onSubmit={editing.mode === "edit" ? handleUpdate : handleCreate}
          modelData={modelData}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("schedules-root")).render(<SchedulesApp />);
