/**
 * Claude Code session management via filesystem + process inspection.
 *
 * Claude CLI v2 stores data in:
 *   ~/.claude/sessions/<PID>.json      — active session registry (pid, sessionId, cwd, startedAt)
 *   ~/.claude/projects/<slug>/<uuid>.jsonl — conversation transcripts
 *   ~/.claude/projects/<slug>/<uuid>/     — session metadata (subagents, etc.)
 *
 * Session lifecycle is process-based: a running `claude` process with a known
 * PID means "working"; a dead PID means "stopped".
 */

import { exec, execFile, spawn } from "node:child_process";
import {
  readdir,
  readFile,
  writeFile,
  appendFile,
  mkdir,
  stat,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { CSM_FILE_PROTOCOL } from "./prompts.js";
import {
  extractAttachmentBlock,
  extractFilePaths,
  stripFilePaths,
} from "./file-extract.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── Binary paths (from config) ─────────────────────────────────────────────

const TMUX_BIN = CONFIG.paths.tmux;
const CLAUDE_BIN = CONFIG.paths.claude;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionState =
  | "working"
  | "waiting"
  | "stopped";

/**
 * Lifecycle category derived from runtime state + jsonl presence + archive flag.
 *   active   — visible in the default dashboard
 *   archived — TTL exceeded; user must restore to use again
 *   dead     — underlying jsonl transcript is gone; cannot be revived
 */
export type LifecycleState = "active" | "archived" | "dead";

export interface Session {
  /** Session UUID */
  sessionId: string;
  /** Short display ID (first 8 chars of sessionId) */
  shortId: string;
  /** AI-generated title or user-given name */
  name?: string;
  /** Current state derived from PID liveness */
  state: SessionState;
  /** Initial prompt (first user message) */
  prompt?: string;
  /** Working directory */
  cwd?: string;
  /** ISO timestamp or epoch ms when started */
  createdAt?: string;
  /** PID of the claude process (if known) */
  pid?: number;
  /** Project slug (dirname under ~/.claude/projects/) */
  projectSlug?: string;
  /** Git branch at session time */
  gitBranch?: string;
  /** Model used */
  model?: string;
  /** CLI version */
  version?: string;
  /** tmux session name (for CSM-managed sessions) */
  tmuxSession?: string;
  /** Remote Control URL (e.g. https://claude.ai/code/session_...) */
  rcUrl?: string;
  /** Schedule that spawned this session, if any */
  scheduleId?: string;
  /** ISO timestamp when the session was archived (sticky flag) */
  archivedAt?: string;
  /** ISO timestamp of the last jsonl activity (mtime); undefined if jsonl is gone */
  lastActivityAt?: string;
  /** Derived lifecycle category */
  lifecycleState?: LifecycleState;
  /** How this session entered CSM's view: "csm" = spawned by CSM, "discovered" = found externally */
  launchedBy?: "csm" | "discovered";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getClaudeDir(): string {
  return CONFIG.paths.claudeConfigDir;
}

/** Get the CSM-managed sessions directory */
function getCsmDir(): string {
  return join(getClaudeDir(), "csm-sessions");
}

/** Check if a PID is alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Derive short ID from session UUID */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

// ─── Session lifecycle logging ───────────────────────────────────────────────

/** Directory for CSM logs */
function getLogDir(): string {
  return join(getClaudeDir(), "csm-logs");
}

/** Append a timestamped entry to the session lifecycle log */
async function logLifecycle(
  sessionId: string,
  name: string | undefined,
  event: string,
  detail?: string,
): Promise<void> {
  const logDir = getLogDir();
  try {
    await mkdir(logDir, { recursive: true });
  } catch {
    // already exists
  }
  const ts = new Date().toISOString();
  const sid = shortId(sessionId);
  const line = `${ts}  ${event.padEnd(18)}  ${sid}  ${name || "(unnamed)"}${detail ? "  " + detail : ""}\n`;
  try {
    await appendFile(join(logDir, "lifecycle.log"), line);
  } catch {
    // best-effort logging
  }
}

/**
 * Track previous session states to detect transitions.
 * Map of sessionId → last known state.
 */
const _prevStates = new Map<string, SessionState>();

/** Compare current sessions against previous states, log transitions */
async function detectTransitions(sessions: Session[]): Promise<void> {
  for (const s of sessions) {
    const prev = _prevStates.get(s.sessionId);
    if (prev && prev !== s.state) {
      await logLifecycle(
        s.sessionId,
        s.name,
        `${prev} → ${s.state}`,
        s.pid ? `pid=${s.pid}` : undefined,
      );
    }
    _prevStates.set(s.sessionId, s.state);
  }
}

// ─── JSONL tail reading for waiting detection ───────────────────────────────

/**
 * Read the last N bytes of a JSONL transcript and determine the type of the
 * last meaningful message (user or assistant).  Returns "assistant" if Claude
 * has finished responding and is waiting for user input, "user" if the user
 * has sent a message and Claude is processing, or null if undetermined.
 */
async function getLastMessageRole(
  sessionId: string,
): Promise<"user" | "assistant" | null> {
  const projectsDir = join(getClaudeDir(), "projects");
  let slugs: string[];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    return null;
  }

  for (const slug of slugs) {
    const jsonlPath = join(projectsDir, slug, `${sessionId}.jsonl`);
    try {
      // Read last 8KB — enough to find the last few messages
      const { open: fsOpen } = await import("node:fs/promises");
      const fh = await fsOpen(jsonlPath, "r");
      const stat = await fh.stat();
      const readSize = Math.min(8192, stat.size);
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, stat.size - readSize);
      await fh.close();

      const tail = buf.toString("utf-8");
      const lines = tail.split("\n").filter(Boolean);

      // Walk backwards to find the last user or assistant message
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === "assistant" || obj.message?.role === "assistant") {
            return "assistant";
          }
          if (obj.type === "user" || obj.message?.role === "user") {
            return "user";
          }
        } catch {
          // Possibly a partial line at the start of the buffer — skip
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Session discovery ───────────────────────────────────────────────────────

/**
 * Read sessions from ~/.claude/sessions/*.json
 * These are PID-indexed files written by claude when it starts.
 */
async function readNativeSessions(): Promise<Session[]> {
  const sessionsDir = join(getClaudeDir(), "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(sessionsDir, entry), "utf-8");
      const data = JSON.parse(raw) as {
        pid: number;
        sessionId: string;
        cwd: string;
        startedAt: number;
      };
      const alive = isProcessAlive(data.pid);
      sessions.push({
        sessionId: data.sessionId,
        shortId: shortId(data.sessionId),
        state: alive ? "working" : "stopped",
        cwd: data.cwd,
        createdAt: new Date(data.startedAt).toISOString(),
        pid: data.pid,
      });
    } catch {
      // Corrupt or unreadable file — skip
    }
  }
  return sessions;
}

/**
 * Read sessions launched by CSM (stored in ~/.claude/csm-sessions/).
 * Each file is <sessionId>.json with pid, prompt, name, cwd, etc.
 */
async function readCsmSessions(): Promise<Session[]> {
  const csmDir = getCsmDir();
  let entries: string[];
  try {
    entries = await readdir(csmDir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(csmDir, entry), "utf-8");
      const data = JSON.parse(raw);
      const alive = data.pid ? isProcessAlive(data.pid) : false;
      // For tmux-managed sessions, also check if the tmux session is alive
      let state: SessionState = alive ? "working" : "stopped";
      if (!alive && data.tmuxSession) {
        try {
          await execAsync(
            `${TMUX_BIN} has-session -t '${data.tmuxSession}' 2>/dev/null`,
          );
          state = "working"; // tmux session exists even if PID detection failed
        } catch {
          // tmux session doesn't exist either
        }
      }
      const launchedBy: "csm" | "discovered" | undefined =
        data.launchedBy === "csm"
          ? "csm"
          : data.discovered === true
            ? "discovered"
            : undefined;
      sessions.push({
        sessionId: data.sessionId,
        shortId: shortId(data.sessionId),
        name: data.name,
        state,
        prompt: data.prompt,
        cwd: data.cwd,
        createdAt: data.createdAt,
        pid: data.pid,
        model: data.model,
        tmuxSession: data.tmuxSession,
        rcUrl: data.rcUrl,
        scheduleId: typeof data.scheduleId === "string" ? data.scheduleId : undefined,
        archivedAt: typeof data.archivedAt === "string" ? data.archivedAt : undefined,
        launchedBy,
      });
    } catch {
      // skip
    }
  }
  return sessions;
}

/**
 * Persist sessions that have no CSM metadata file yet. Snapshots whatever
 * is known (sessionId, cwd, name, prompt, etc.) into ~/.claude/csm-sessions
 * so the entry survives after the native session file is cleaned up.
 */
async function persistDiscoveredSessions(
  sessions: Session[],
  alreadyPersisted: Set<string>,
): Promise<void> {
  const toWrite = sessions.filter((s) => !alreadyPersisted.has(s.sessionId));
  if (toWrite.length === 0) return;

  const csmDir = getCsmDir();
  if (!existsSync(csmDir)) {
    try {
      await mkdir(csmDir, { recursive: true });
    } catch {
      return;
    }
  }

  await Promise.all(
    toWrite.map(async (s) => {
      const meta = {
        sessionId: s.sessionId,
        pid: s.pid,
        name: s.name || `discovered-${s.shortId}`,
        prompt: s.prompt || "",
        cwd: s.cwd,
        createdAt: s.createdAt,
        tmuxSession: s.tmuxSession,
        rcUrl: s.rcUrl,
        model: s.model,
        discovered: true,
      };
      try {
        await writeFile(
          join(getCsmDir(), `${s.sessionId}.json`),
          JSON.stringify(meta, null, 2),
        );
      } catch {
        // best effort — skip on failure
      }
    }),
  );
}

/**
 * Enrich sessions with AI-generated titles from JSONL transcripts.
 * Searches all project directories for matching sessionId.
 */
async function enrichWithTitles(sessions: Session[]): Promise<void> {
  const projectsDir = join(getClaudeDir(), "projects");
  let projectSlugs: string[];
  try {
    projectSlugs = await readdir(projectsDir);
  } catch {
    return;
  }

  // Build a lookup: sessionId → session reference
  const lookup = new Map<string, Session>();
  for (const s of sessions) {
    lookup.set(s.sessionId, s);
  }

  for (const slug of projectSlugs) {
    const slugDir = join(projectsDir, slug);
    let files: string[];
    try {
      files = await readdir(slugDir);
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const sid = f.replace(".jsonl", "");
      const session = lookup.get(sid);
      if (!session) continue;

      // Read first few lines to get ai-title and first user message
      try {
        const jsonlPath = join(slugDir, f);
        // Capture last activity time from file mtime — used by lifecycle classifier
        try {
          const st = await stat(jsonlPath);
          session.lastActivityAt = st.mtime.toISOString();
        } catch {
          // stat failed — leave lastActivityAt undefined
        }
        const content = await readFile(jsonlPath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        session.projectSlug = slug;

        for (const line of lines.slice(0, 10)) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "ai-title" && obj.aiTitle) {
              session.name = session.name || obj.aiTitle;
            }
            if (obj.type === "user" && obj.message?.content && !session.prompt) {
              const content = obj.message.content;
              session.prompt =
                typeof content === "string"
                  ? content.slice(0, 500)
                  : JSON.stringify(content).slice(0, 500);
            }
            if (obj.gitBranch && !session.gitBranch) {
              session.gitBranch = obj.gitBranch;
            }
            if (obj.version && !session.version) {
              session.version = obj.version;
            }
            if (obj.message?.model && !session.model) {
              session.model = obj.message.model;
            }
          } catch {
            // malformed JSON line
          }
        }
      } catch {
        // can't read file
      }
    }
  }
}

// ─── Lifecycle classification ───────────────────────────────────────────────

/**
 * Decide the lifecycle category for a session.
 * Order of precedence:
 *   1. working/waiting → always "active" (a live session is never archived/dead)
 *   2. jsonl missing  → "dead" (cannot be respawned)
 *   3. archivedAt set → "archived"
 *   4. otherwise      → "active"
 */
function classifyLifecycle(s: Session): LifecycleState {
  if (s.state === "working" || s.state === "waiting") return "active";
  if (!s.lastActivityAt) return "dead";
  if (s.archivedAt) return "archived";
  return "active";
}

/** TTL (in ms) for a given session, based on whether it was scheduled or ad-hoc. */
function ttlForSession(s: Session): number {
  const days = s.scheduleId
    ? CONFIG.lifecycle.archiveAfterDaysScheduled
    : CONFIG.lifecycle.archiveAfterDays;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Returns true if a stopped session has crossed its archive TTL.
 * Sessions without lastActivityAt (dead) or already-archived sessions return false.
 */
function shouldAutoArchive(s: Session, nowMs: number = Date.now()): boolean {
  if (s.state !== "stopped") return false;
  if (s.archivedAt) return false;
  if (!s.lastActivityAt) return false;
  const lastMs = new Date(s.lastActivityAt).getTime();
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs > ttlForSession(s);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function listSessions(): Promise<Session[]> {
  // Merge native sessions and CSM-launched sessions
  const [native, csm] = await Promise.all([
    readNativeSessions(),
    readCsmSessions(),
  ]);

  // Track which sessions already have a persisted CSM metadata file.
  // Anything missing gets persisted below so it survives native cleanup.
  const persistedIds = new Set(csm.map((s) => s.sessionId));

  // Deduplicate by sessionId (CSM data takes priority for enrichment)
  const byId = new Map<string, Session>();
  for (const s of native) byId.set(s.sessionId, s);
  for (const s of csm) {
    const existing = byId.get(s.sessionId);
    if (existing) {
      // Merge: keep CSM fields (name, prompt) but use native PID liveness
      existing.name = existing.name || s.name;
      existing.prompt = existing.prompt || s.prompt;
      existing.model = existing.model || s.model;
      existing.tmuxSession = existing.tmuxSession || s.tmuxSession;
      existing.rcUrl = existing.rcUrl || s.rcUrl;
      existing.launchedBy = existing.launchedBy || s.launchedBy;
    } else {
      byId.set(s.sessionId, s);
    }
  }

  const sessions = Array.from(byId.values());

  // Enrich with titles from JSONL transcripts
  await enrichWithTitles(sessions);

  // Persist any session that does not yet have a CSM metadata file, so the
  // entry survives after claude removes its ~/.claude/sessions/<pid>.json
  // file on exit. Without this, ad-hoc / pre-CSM sessions vanish from the
  // dashboard and cannot be respawned.
  await persistDiscoveredSessions(sessions, persistedIds);

  // Refine state: distinguish "working" (Claude processing) from "waiting" (user input needed)
  await Promise.all(
    sessions
      .filter((s) => s.state === "working")
      .map(async (s) => {
        const lastRole = await getLastMessageRole(s.sessionId);
        if (lastRole === "assistant") {
          s.state = "waiting";
        }
        // lastRole === "user" or null → keep "working"
      }),
  );

  // Sort: working first, then by createdAt desc
  sessions.sort((a, b) => {
    if (a.state === "working" && b.state !== "working") return -1;
    if (a.state !== "working" && b.state === "working") return 1;
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  // Assign lifecycle category — depends on archivedAt + lastActivityAt set above
  for (const s of sessions) {
    s.lifecycleState = classifyLifecycle(s);
  }

  // Detect and log state transitions (non-blocking)
  detectTransitions(sessions).catch(() => {});

  return sessions;
}

export async function getSession(
  id: string,
): Promise<Session | undefined> {
  const sessions = await listSessions();
  return sessions.find(
    (s) => s.sessionId === id || s.shortId === id,
  );
}

export async function getRoster(): Promise<Record<string, unknown>> {
  // No daemon/roster in current Claude CLI; return process-based info
  try {
    const { stdout } = await execAsync(
      "ps aux | grep -E '[c]laude' | grep -v 'csm-sessions\\|session-manager'",
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    return {
      processCount: lines.length,
      processes: lines.map((l) => {
        const parts = l.split(/\s+/);
        return {
          pid: parseInt(parts[1], 10),
          cpu: parts[2],
          mem: parts[3],
          command: parts.slice(10).join(" ").slice(0, 200),
        };
      }),
    };
  } catch {
    return { processCount: 0, processes: [] };
  }
}

/**
 * Launch an interactive Claude session inside a tmux pane with Remote Control enabled.
 *
 * Flow:
 *   1. `tmux new-session -d -s csm-<short> -c <cwd> -- claude --session-id <uuid> --remote-control <name>`
 *   2. Wait briefly for the claude process to start
 *   3. Extract the PID of the child claude process from the tmux pane
 *   4. Send the initial prompt via `tmux send-keys`
 *   5. Persist metadata for CSM tracking
 *
 * IMPORTANT: NO `-p` flag — this launches an interactive session that uses
 * regular Claude Max credits, not programmatic credits.
 */
export async function createSession(
  prompt: string,
  name?: string,
  cwd?: string,
  model?: string,
  scheduleId?: string,
): Promise<Session> {
  const sessionId = randomUUID();
  const sid = shortId(sessionId);
  const workDir = cwd || process.cwd();
  const tmuxSession = `csm-${sid}`;
  const rcName = name || `csm-${sid}`;

  // Build the claude command to run inside tmux
  const claudeArgs = [
    CLAUDE_BIN,
    "--session-id",
    sessionId,
    "--remote-control",
    rcName,
    "--append-system-prompt",
    CSM_FILE_PROTOCOL,
  ];
  if (model) {
    claudeArgs.push("--model", model);
  }
  if (CONFIG.session.dangerouslySkipPermissions) {
    claudeArgs.push("--dangerously-skip-permissions");
  }
  const claudeCmd = claudeArgs
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");

  // Launch tmux detached session with remain-on-exit so pane stays after exit
  await execAsync(
    [
      TMUX_BIN,
      "new-session",
      "-d",
      "-s",
      tmuxSession,
      "-c",
      workDir,
      "--",
      "bash",
      "-c",
      `${claudeCmd}; echo '[CSM] claude exited (exit code: '$?') at '$(date -Iseconds); exec sleep infinity`,
    ]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(" "),
  );

  // Enable remain-on-exit so the pane survives even if bash exits
  try {
    await execAsync(
      `${TMUX_BIN} set-option -t '${tmuxSession}' remain-on-exit on`,
    );
  } catch {
    // non-fatal
  }

  // Wait for the claude TUI to be ready (poll for the "❯" input cursor).
  // 30s budget because --append-system-prompt slows startup noticeably on
  // large protocol strings. Retry once with a doubled budget on slow hosts
  // (e.g. WGS workers) where the first attempt can miss the cursor.
  let ready = await waitForTuiReady(tmuxSession, 30);
  if (!ready) {
    await logLifecycle(
      sessionId,
      rcName,
      "tui-wait-retry",
      `first 30s wait timed out; retrying with 60s budget`,
    );
    ready = await waitForTuiReady(tmuxSession, 60);
  }

  // Extract PID of the claude process running inside the tmux pane
  const pid = await extractClaudePid(tmuxSession);

  // Send the initial prompt after the TUI is ready. Use paste-buffer
  // instead of bare send-keys so multi-line prompts and special chars
  // (', \, $, backticks) survive intact — same pattern as sendMessage().
  // Skip injection entirely if the TUI never became ready: sending while
  // claude is still painting drops the prompt silently.
  if (!ready) {
    await logLifecycle(
      sessionId,
      rcName,
      "prompt-skipped",
      `TUI not ready after 90s — initial prompt not injected`,
    );
  } else {
    try {
      const normalized = prompt.replace(/\r\n/g, "\n");
      const bufName = `csm-init-${sid}-${Date.now()}`;
      await execFileAsync(TMUX_BIN, ["set-buffer", "-b", bufName, "--", normalized]);
      await execFileAsync(TMUX_BIN, ["paste-buffer", "-p", "-d", "-b", bufName, "-t", tmuxSession]);
      await execFileAsync(TMUX_BIN, ["send-keys", "-t", tmuxSession, "Enter"]);
    } catch (e) {
      await logLifecycle(
        sessionId,
        rcName,
        "prompt-send-failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Extract Remote Control URL from tmux pane output
  // Claude prints something like "https://claude.ai/code/session_..." when RC starts
  let rcUrl: string | undefined;
  try {
    rcUrl = await captureRcUrl(tmuxSession, 10);
  } catch {
    // RC URL extraction failed — non-fatal
  }

  // Persist session metadata for CSM tracking
  const csmDir = getCsmDir();
  if (!existsSync(csmDir)) {
    await mkdir(csmDir, { recursive: true });
  }

  const meta = {
    sessionId,
    pid: pid || undefined,
    name: rcName,
    prompt,
    cwd: workDir,
    createdAt: new Date().toISOString(),
    tmuxSession,
    rcUrl: rcUrl || undefined,
    model: undefined,
    scheduleId: scheduleId || undefined,
    launchedBy: "csm" as const,
  };

  await writeFile(
    join(csmDir, `${sessionId}.json`),
    JSON.stringify(meta, null, 2),
  );

  // Log session creation
  await logLifecycle(sessionId, rcName, "created", `pid=${pid || "?"} tmux=${tmuxSession}${scheduleId ? ` schedule=${scheduleId}` : ""}`);

  const session: Session = {
    sessionId,
    shortId: sid,
    name: rcName,
    state: "working",
    prompt,
    cwd: workDir,
    createdAt: meta.createdAt,
    pid,
    rcUrl,
    scheduleId: scheduleId || undefined,
    lifecycleState: "active",
    launchedBy: "csm",
  };

  // Seed initial state for transition detection
  _prevStates.set(sessionId, "working");

  return session;
}

export async function stopSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;

  await logLifecycle(session.sessionId, session.name, "stop-requested", `pid=${session.pid || "?"}`);

  // Try to kill the tmux session first (cleanest shutdown)
  const tmuxSession = await getTmuxSessionName(session);
  if (tmuxSession) {
    try {
      await execAsync(`${TMUX_BIN} kill-session -t '${tmuxSession}'`);
      await logLifecycle(session.sessionId, session.name, "stopped", "via tmux kill-session");
      return true;
    } catch {
      // tmux session might already be dead — fall through to PID-based kill
    }
  }

  // Fallback: kill by PID
  if (session.pid) {
    if (!isProcessAlive(session.pid)) {
      await logLifecycle(session.sessionId, session.name, "stopped", "pid already dead");
      return true;
    }
    try {
      process.kill(session.pid, "SIGTERM");
      await logLifecycle(session.sessionId, session.name, "stopped", "via SIGTERM");
      return true;
    } catch {
      return true;
    }
  }

  return true;
}

/** Resolve tmux session name from session object or convention */
async function getTmuxSessionName(session: Session): Promise<string | null> {
  // Direct from session object (populated by readCsmSessions)
  if (session.tmuxSession) return session.tmuxSession;

  // Check CSM metadata file for tmuxSession field
  const csmFile = join(getCsmDir(), `${session.sessionId}.json`);
  try {
    const raw = JSON.parse(await readFile(csmFile, "utf-8"));
    if (raw.tmuxSession) return raw.tmuxSession;
  } catch {
    // no CSM file or malformed
  }

  // Convention: csm-<shortId>
  const candidate = `csm-${session.shortId}`;
  try {
    await execAsync(`${TMUX_BIN} has-session -t '${candidate}' 2>/dev/null`);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Extract the PID of the claude process running inside a tmux pane.
 * The pane runs bash → claude, so we find the shell PID first,
 * then look for the child claude process.
 */
async function extractClaudePid(
  tmuxSession: string,
): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync(
      `${TMUX_BIN} list-panes -t '${tmuxSession}' -F '#{pane_pid}'`,
    );
    const shellPid = parseInt(stdout.trim(), 10);
    if (!shellPid) return undefined;

    const { stdout: children } = await execAsync(
      `ps --ppid ${shellPid} -o pid= 2>/dev/null || true`,
    );
    const childPids = children
      .trim()
      .split("\n")
      .map((l) => parseInt(l.trim(), 10))
      .filter(Boolean);
    return childPids[0] || shellPid;
  } catch {
    return undefined;
  }
}

/**
 * Wait for Claude TUI to be ready by polling tmux pane content.
 * Looks for the `>` input prompt or "What can I help" text.
 */
async function waitForTuiReady(
  tmuxSession: string,
  maxWaitSec: number,
): Promise<boolean> {
  const interval = 500;
  const maxAttempts = Math.ceil((maxWaitSec * 1000) / interval);

  // Claude Code renders an "❯" input cursor on the line just above the
  // status bar once it is actually accepting keystrokes. The startup
  // banner ("claude.ai/code/...", model info, tips panel) is printed
  // *before* that cursor appears, so we cannot key off the banner alone
  // or send-keys arrives while the TUI is still painting.
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { stdout } = await execAsync(
        `${TMUX_BIN} capture-pane -t '${tmuxSession}' -p -S -30`,
      );
      if (stdout.includes("❯")) {
        // Settle briefly so the TUI is past any final layout pass.
        await new Promise((resolve) => setTimeout(resolve, 400));
        return true;
      }
    } catch {
      // tmux capture failed
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

/**
 * Capture the Remote Control URL from tmux pane output.
 * Claude prints the RC URL when it starts with --remote-control.
 * We poll the pane content for up to `maxWaitSec` seconds looking for it.
 */
async function captureRcUrl(
  tmuxSession: string,
  maxWaitSec: number,
): Promise<string | undefined> {
  const interval = 2000;
  const maxAttempts = Math.ceil((maxWaitSec * 1000) / interval);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { stdout } = await execAsync(
        `${TMUX_BIN} capture-pane -t '${tmuxSession}' -p -S -50`,
      );
      // Look for claude.ai/code/session_ URL pattern
      const match = stdout.match(/https:\/\/claude\.ai\/code\/session_\S+/);
      if (match) return match[0];
    } catch {
      // tmux capture failed
    }
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  return undefined;
}

/**
 * Try to extract RC URL from a running session's tmux pane.
 * Useful for sessions where rcUrl wasn't captured at creation time.
 */
export async function refreshRcUrl(id: string): Promise<string | undefined> {
  const session = await getSession(id);
  if (!session?.tmuxSession) return undefined;

  try {
    const { stdout } = await execAsync(
      `${TMUX_BIN} capture-pane -t '${session.tmuxSession}' -p -S -100`,
    );
    const match = stdout.match(/https:\/\/claude\.ai\/code\/session_\S+/);
    if (match) {
      // Update the CSM metadata file
      const csmFile = join(getCsmDir(), `${session.sessionId}.json`);
      try {
        const raw = JSON.parse(await readFile(csmFile, "utf-8"));
        raw.rcUrl = match[0];
        await writeFile(csmFile, JSON.stringify(raw, null, 2));
      } catch {
        // non-fatal
      }
      return match[0];
    }
  } catch {
    // capture failed
  }
  return undefined;
}

/**
 * Respawn a stopped session by resuming the existing session ID.
 * Uses `claude --resume <sessionId>` to restore conversation history.
 *
 * The sessionId was assigned via `--session-id <uuid>` at creation time,
 * so it uniquely identifies the conversation even when multiple sessions
 * share the same working directory.
 */
export async function respawnSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;

  // Can only respawn stopped sessions
  if (session.state === "working") return false;

  const sid = session.shortId;
  const workDir = session.cwd || process.cwd();
  const tmuxSession = `csm-${sid}`;
  const rcName = session.name || `csm-${sid}`;

  // Kill any stale tmux session with the same name (leftover from previous run)
  try {
    await execAsync(
      `${TMUX_BIN} kill-session -t '${tmuxSession}' 2>/dev/null`,
    );
  } catch {
    // No stale session — expected
  }

  // Build the claude command with --resume to restore the exact session.
  // Re-inject the CSM file protocol so respawned sessions keep the same
  // attachment conventions they were originally launched with.
  const resumeArgs = [
    CLAUDE_BIN,
    "--resume",
    session.sessionId,
    "--remote-control",
    rcName,
    "--append-system-prompt",
    CSM_FILE_PROTOCOL,
  ];
  if (CONFIG.session.dangerouslySkipPermissions) {
    resumeArgs.push("--dangerously-skip-permissions");
  }
  const claudeCmd = resumeArgs
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");

  try {
    // Launch tmux detached session with --resume and remain-on-exit
    await execAsync(
      [
        TMUX_BIN,
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        workDir,
        "--",
        "bash",
        "-c",
        `${claudeCmd}; echo '[CSM] claude exited (exit code: '$?') at '$(date -Iseconds); exec sleep infinity`,
      ]
        .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
        .join(" "),
    );

    // Enable remain-on-exit so the pane survives even if bash exits
    try {
      await execAsync(
        `${TMUX_BIN} set-option -t '${tmuxSession}' remain-on-exit on`,
      );
    } catch {
      // non-fatal
    }

    // Wait for TUI to be ready (matching the spawn budget)
    await waitForTuiReady(tmuxSession, 30);

    // Extract PID
    const pid = await extractClaudePid(tmuxSession);

    // Capture RC URL (always overwrite — old URL is invalid after respawn)
    const rcUrl = await captureRcUrl(tmuxSession, 10);

    // Update the CSM metadata file (also clears archivedAt — a respawned
    // session is by definition active again)
    const csmFile = join(getCsmDir(), `${session.sessionId}.json`);
    if (existsSync(csmFile)) {
      const raw = JSON.parse(await readFile(csmFile, "utf-8"));
      if (pid) raw.pid = pid;
      raw.tmuxSession = tmuxSession;
      if (rcUrl) raw.rcUrl = rcUrl;
      delete raw.archivedAt;
      await writeFile(csmFile, JSON.stringify(raw, null, 2));
    }

    // Log respawn
    await logLifecycle(session.sessionId, session.name, "respawned", `pid=${pid || "?"} tmux=${tmuxSession}`);
    _prevStates.set(session.sessionId, "working");

    return true;
  } catch (e) {
    await logLifecycle(session.sessionId, session.name, "respawn-failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ─── Lifecycle: archive sweep + restore ──────────────────────────────────────

async function readCsmMeta(
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const path = join(getCsmDir(), `${sessionId}.json`);
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeCsmMeta(
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(getCsmDir(), `${sessionId}.json`),
    JSON.stringify(meta, null, 2),
  );
}

/**
 * Clear the archivedAt flag on a session so it returns to the default list.
 * Does NOT respawn — the caller (or the user) can do that separately.
 * Returns true if the metadata exists (regardless of whether a flag was
 * actually cleared); false if the session is unknown.
 */
export async function restoreSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;
  const meta = await readCsmMeta(session.sessionId);
  if (!meta) return false;
  if (meta.archivedAt) {
    delete meta.archivedAt;
    await writeCsmMeta(session.sessionId, meta);
    await logLifecycle(session.sessionId, session.name, "restored");
  }
  return true;
}

/**
 * Walk all known sessions and set archivedAt on any that have crossed their
 * lifecycle TTL. Returns the number of sessions newly archived in this pass.
 * Working/waiting sessions and sessions with no jsonl (dead) are skipped.
 */
export async function runArchiveSweep(): Promise<{ archived: number }> {
  const sessions = await listSessions();
  const now = Date.now();
  let archived = 0;
  for (const s of sessions) {
    if (!shouldAutoArchive(s, now)) continue;
    const meta = await readCsmMeta(s.sessionId);
    if (!meta) continue;
    meta.archivedAt = new Date().toISOString();
    await writeCsmMeta(s.sessionId, meta);
    await logLifecycle(
      s.sessionId,
      s.name,
      "archived",
      `auto sweep (lastActivity=${s.lastActivityAt})`,
    );
    archived++;
  }
  return { archived };
}

export async function removeSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;

  // Stop if still running (tmux kill or PID kill)
  if (session.state === "working") {
    await stopSession(id);
  }

  // Remove CSM tracking file
  try {
    await unlink(join(getCsmDir(), `${session.sessionId}.json`));
  } catch {
    // might not exist (native-only session)
  }

  return true;
}

export async function getLogs(id: string): Promise<string> {
  const session = await getSession(id);
  if (!session) return "(session not found)";

  // Find JSONL transcript
  const projectsDir = join(getClaudeDir(), "projects");
  let projectSlugs: string[];
  try {
    projectSlugs = await readdir(projectsDir);
  } catch {
    return "(no projects directory)";
  }

  for (const slug of projectSlugs) {
    const jsonlPath = join(projectsDir, slug, `${session.sessionId}.jsonl`);
    try {
      const content = await readFile(jsonlPath, "utf-8");
      const lines = content.split("\n").filter(Boolean);

      // Format transcript as readable log
      const logLines: string[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "ai-title") {
            logLines.push(`[title] ${obj.aiTitle}`);
          } else if (obj.type === "user") {
            const msg =
              typeof obj.message?.content === "string"
                ? obj.message.content.slice(0, 300)
                : "(complex message)";
            logLines.push(`[user] ${msg}`);
          } else if (obj.type === "assistant" || obj.message?.role === "assistant") {
            const text = extractAssistantText(obj.message);
            if (text) logLines.push(`[assistant] ${text.slice(0, 300)}`);
          } else if (obj.type === "queue-operation") {
            logLines.push(`[system] ${obj.operation} at ${obj.timestamp}`);
          }
        } catch {
          // skip malformed line
        }
      }
      return logLines.join("\n") || "(empty transcript)";
    } catch {
      continue;
    }
  }
  return "(no transcript found)";
}

/** Extract text from assistant message content blocks */
function extractAssistantText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text as string)
      .join("\n")
      .slice(0, 500);
  }
  return "";
}

// ─── Structured transcript ──────────────────────────────────────────────────

export interface TranscriptTool {
  name: string;
  /** Single-line summary of the tool input (e.g. "rm -rf foo" for Bash) */
  summary?: string;
}

export interface TranscriptTurn {
  uuid: string;
  role: "user" | "assistant" | "system";
  /** Plain text portion of the message, if any */
  text?: string;
  /** Tool invocations from the assistant */
  tools?: TranscriptTool[];
  /** File paths surfaced via the CSM file protocol (assistant turns only) */
  attachments?: string[];
  /** Epoch ms */
  t: number;
}

/** Best-effort one-line summary for a tool_use input object */
function summarizeToolInput(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  // Prefer a few common keys that hold the “primary” argument.
  for (const k of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) {
      return v.replace(/\s+/g, " ").slice(0, 160) + (v.length > 160 ? "…" : "");
    }
  }
  const fallback = JSON.stringify(obj);
  return fallback.length > 160 ? fallback.slice(0, 160) + "…" : fallback;
}

/**
 * Read the JSONL transcript and return structured turns suitable for chat-style
 * rendering. Tool-result-only user messages are skipped (those are auto-injected
 * by Claude after tool execution and not user-typed).
 */
export async function getTranscript(id: string): Promise<TranscriptTurn[]> {
  const session = await getSession(id);
  if (!session) return [];

  const projectsDir = join(getClaudeDir(), "projects");
  let projectSlugs: string[];
  try {
    projectSlugs = await readdir(projectsDir);
  } catch {
    return [];
  }

  for (const slug of projectSlugs) {
    const jsonlPath = join(projectsDir, slug, `${session.sessionId}.jsonl`);
    let content: string;
    try {
      content = await readFile(jsonlPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n").filter(Boolean);
    const turns: TranscriptTurn[] = [];

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const t = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Date.now();
      const uuid = (obj.uuid as string) || `t${turns.length}`;

      if (obj.type === "user") {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (!msg) continue;
        const c = msg.content;
        let rawText = "";
        if (typeof c === "string") {
          rawText = c.trim();
        } else if (Array.isArray(c)) {
          // Skip user messages that contain only tool_result blocks
          // (those are Claude's automatic feedback, not user-typed input).
          rawText = c
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text as string)
            .join("\n")
            .trim();
        }
        if (!rawText) continue;
        const { text: cleaned, paths } = extractAttachmentBlock(rawText);
        turns.push({
          uuid,
          role: "user",
          text: cleaned || undefined,
          attachments: paths.length ? paths : undefined,
          t,
        });
      } else if (obj.type === "assistant") {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (!msg) continue;
        const c = msg.content;
        if (!Array.isArray(c)) continue;
        const text = c
          .filter((b: Record<string, unknown>) => b.type === "text")
          .map((b: Record<string, unknown>) => b.text as string)
          .join("\n")
          .trim();
        const tools: TranscriptTool[] = c
          .filter((b: Record<string, unknown>) => b.type === "tool_use")
          .map((b: Record<string, unknown>) => ({
            name: (b.name as string) || "tool",
            summary: summarizeToolInput((b.name as string) || "", b.input),
          }));
        if (!text && tools.length === 0) continue;
        const attachments = text ? extractFilePaths(text) : [];
        const cleaned = text ? stripFilePaths(text) : "";
        turns.push({
          uuid,
          role: "assistant",
          text: cleaned || undefined,
          tools: tools.length ? tools : undefined,
          attachments: attachments.length ? attachments : undefined,
          t,
        });
      }
      // Other types (ai-title, attachment, file-history-snapshot, etc.) are ignored
    }

    return turns;
  }

  return [];
}

// ─── Send message to running session ────────────────────────────────────────

export type SendMessageResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "stopped" | "no_tmux" | "tmux_failed"; detail?: string };

/**
 * Inject a prompt into a running session's tmux pane.
 *
 * Uses tmux's paste-buffer with bracketed paste (-p) so multi-line text and
 * special characters reach Claude's TUI intact, then sends Enter to submit.
 *
 * Requires the session to be in `working` or `waiting` state (i.e. its tmux
 * pane is alive). Stopped sessions return { ok:false, reason:"stopped" }.
 */
export async function sendMessage(
  id: string,
  prompt: string,
): Promise<SendMessageResult> {
  const session = await getSession(id);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.state === "stopped") return { ok: false, reason: "stopped" };

  const tmuxSession = await getTmuxSessionName(session);
  if (!tmuxSession) return { ok: false, reason: "no_tmux" };

  try {
    // Normalize CRLF → LF so paste-buffer sees a single newline per line.
    const normalized = prompt.replace(/\r\n/g, "\n");

    // Use a buffer name unique to this session to avoid collisions.
    const bufName = `csm-msg-${session.shortId}-${Date.now()}`;

    // set-buffer with -b <name> and -- ends option parsing so prompts starting
    // with `-` are not misread as flags. execFile avoids any shell escaping.
    await execFileAsync(TMUX_BIN, ["set-buffer", "-b", bufName, "--", normalized]);
    // -p: bracketed paste; -d: delete buffer after paste; -t: target session
    await execFileAsync(TMUX_BIN, ["paste-buffer", "-p", "-d", "-b", bufName, "-t", tmuxSession]);
    // Submit the message
    await execFileAsync(TMUX_BIN, ["send-keys", "-t", tmuxSession, "Enter"]);

    await logLifecycle(
      session.sessionId,
      session.name,
      "message-sent",
      `len=${normalized.length}`,
    );
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: "tmux_failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Uploads ─────────────────────────────────────────────────────────────────

/**
 * Directory where files uploaded via the web UI are staged. The session-id
 * subdirectory is created lazily on first upload. Paths under this prefix are
 * considered safe to read back via the download endpoint without further
 * authorization checks.
 */
export const UPLOAD_ROOT = "/tmp/csm-uploads";

function sanitizeUploadName(name: string): string {
  // Replace anything that isn't an alnum/dot/dash/underscore with "_".
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Avoid leading dots so the file is visible in `ls` and `Read`.
  return base.replace(/^\.+/, "") || "file";
}

export interface UploadResult {
  ok: true;
  files: Array<{ name: string; path: string; size: number; type?: string }>;
}

export interface UploadFailure {
  ok: false;
  reason: "not_found" | "no_files" | "write_failed";
  detail?: string;
}

/**
 * Persist uploaded files to /tmp/csm-uploads/<sessionId>/ and return their
 * absolute paths so they can be referenced from a follow-up message.
 */
export async function saveUploads(
  id: string,
  files: File[],
): Promise<UploadResult | UploadFailure> {
  const session = await getSession(id);
  if (!session) return { ok: false, reason: "not_found" };
  if (files.length === 0) return { ok: false, reason: "no_files" };

  const dir = join(UPLOAD_ROOT, session.sessionId);
  if (!existsSync(dir)) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      return {
        ok: false,
        reason: "write_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const saved: UploadResult["files"] = [];
  for (const file of files) {
    const ts = Date.now();
    const safe = sanitizeUploadName(file.name || "file");
    const path = join(dir, `${ts}_${safe}`);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await writeFile(path, buf);
      saved.push({
        name: file.name || safe,
        path,
        size: buf.length,
        type: file.type || undefined,
      });
    } catch (e) {
      return {
        ok: false,
        reason: "write_failed",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  await logLifecycle(
    session.sessionId,
    session.name,
    "upload",
    `count=${saved.length} bytes=${saved.reduce((n, f) => n + f.size, 0)}`,
  );
  return { ok: true, files: saved };
}
