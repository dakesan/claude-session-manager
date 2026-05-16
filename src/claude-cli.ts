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
  mkdir,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionState =
  | "working"
  | "idle"
  | "stopped"
  | "unknown";

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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
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
      sessions.push({
        sessionId: data.sessionId,
        shortId: shortId(data.sessionId),
        name: data.name,
        state: alive ? "working" : "stopped",
        prompt: data.prompt,
        cwd: data.cwd,
        createdAt: data.createdAt,
        pid: data.pid,
        model: data.model,
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

  // Sort: working first, then by createdAt desc
  sessions.sort((a, b) => {
    if (a.state === "working" && b.state !== "working") return -1;
    if (a.state !== "working" && b.state === "working") return 1;
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

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

export async function createSession(
  prompt: string,
  name?: string,
  cwd?: string,
): Promise<Session> {
  const sessionId = randomUUID();
  const workDir = cwd || process.cwd();

  // Launch claude -p in background
  const args = [
    "-p",
    "--session-id",
    sessionId,
    "--dangerously-skip-permissions",
    prompt,
  ];

  const child = spawn("claude", args, {
    cwd: workDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error("Failed to spawn claude process");
  }

  // Persist session metadata for CSM tracking
  const csmDir = getCsmDir();
  if (!existsSync(csmDir)) {
    await mkdir(csmDir, { recursive: true });
  }

  const meta = {
    sessionId,
    pid,
    name: name || undefined,
    prompt,
    cwd: workDir,
    createdAt: new Date().toISOString(),
    model: undefined,
  };

  await writeFile(
    join(csmDir, `${sessionId}.json`),
    JSON.stringify(meta, null, 2),
  );

  return {
    sessionId,
    shortId: shortId(sessionId),
    name,
    state: "working",
    prompt,
    cwd: workDir,
    createdAt: meta.createdAt,
    pid,
  };
}

export async function stopSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session?.pid) return false;

  // If process is already dead, treat as success
  if (!isProcessAlive(session.pid)) return true;

  try {
    process.kill(session.pid, "SIGTERM");
    return true;
  } catch {
    // ESRCH = process doesn't exist = already stopped
    return true;
  }
}

export async function respawnSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;

  // Can only respawn stopped sessions
  if (session.state === "working") return false;

  try {
    const newSession = await createSession(
      session.prompt || "Continue previous work",
      session.name,
      session.cwd,
    );
    // Update the CSM file to point to the new PID
    const csmFile = join(getCsmDir(), `${session.sessionId}.json`);
    if (existsSync(csmFile)) {
      const raw = JSON.parse(await readFile(csmFile, "utf-8"));
      raw.pid = newSession.pid;
      await writeFile(csmFile, JSON.stringify(raw, null, 2));
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;

  // Stop if still running
  if (session.state === "working" && session.pid) {
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {
      // already dead
    }
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
