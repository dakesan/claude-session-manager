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
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";

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
      });
    } catch {
      // skip
    }
  }
  return sessions;
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
        const content = await readFile(join(slugDir, f), "utf-8");
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

// ─── Public API ──────────────────────────────────────────────────────────────

export async function listSessions(): Promise<Session[]> {
  // Merge native sessions and CSM-launched sessions
  const [native, csm] = await Promise.all([
    readNativeSessions(),
    readCsmSessions(),
  ]);

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
    } else {
      byId.set(s.sessionId, s);
    }
  }

  const sessions = Array.from(byId.values());

  // Enrich with titles from JSONL transcripts
  await enrichWithTitles(sessions);

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

  // Wait for the claude TUI to be ready (poll for the input prompt)
  await waitForTuiReady(tmuxSession, 15);

  // Extract PID of the claude process running inside the tmux pane
  const pid = await extractClaudePid(tmuxSession);

  // Send the initial prompt after claude TUI is ready
  try {
    // Escape the prompt for tmux send-keys
    const escapedPrompt = prompt.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
    await execAsync(
      `${TMUX_BIN} send-keys -t '${tmuxSession}' '${escapedPrompt}' Enter`,
    );
  } catch {
    // Prompt sending failed — the session is still running, user can interact via RC
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
  };

  await writeFile(
    join(csmDir, `${sessionId}.json`),
    JSON.stringify(meta, null, 2),
  );

  // Log session creation
  await logLifecycle(sessionId, rcName, "created", `pid=${pid || "?"} tmux=${tmuxSession}`);

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
  const interval = 1000;
  const maxAttempts = Math.ceil((maxWaitSec * 1000) / interval);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { stdout } = await execAsync(
        `${TMUX_BIN} capture-pane -t '${tmuxSession}' -p -S -10`,
      );
      // Claude TUI shows ">" prompt when ready for input, or the
      // text "What can I help you with?" or similar greeting
      if (
        stdout.includes(">") ||
        stdout.includes("What can I help") ||
        stdout.includes("claude.ai/code")
      ) {
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

  // Build the claude command with --resume to restore the exact session
  const resumeArgs = [
    CLAUDE_BIN,
    "--resume",
    session.sessionId,
    "--remote-control",
    rcName,
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

    // Wait for TUI to be ready
    await waitForTuiReady(tmuxSession, 15);

    // Extract PID
    const pid = await extractClaudePid(tmuxSession);

    // Capture RC URL (always overwrite — old URL is invalid after respawn)
    const rcUrl = await captureRcUrl(tmuxSession, 10);

    // Update the CSM metadata file
    const csmFile = join(getCsmDir(), `${session.sessionId}.json`);
    if (existsSync(csmFile)) {
      const raw = JSON.parse(await readFile(csmFile, "utf-8"));
      if (pid) raw.pid = pid;
      raw.tmuxSession = tmuxSession;
      if (rcUrl) raw.rcUrl = rcUrl;
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
