/**
 * Wrapper around Claude Code CLI for session management.
 * Reads session state directly from ~/.claude/jobs/ and delegates
 * actions to the `claude` CLI via child_process.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SessionState =
  | "working"
  | "needs_input"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

export interface Session {
  shortId: string;
  sessionId?: string;
  name?: string;
  state: SessionState;
  prompt?: string;
  cwd?: string;
  remoteControlUrl?: string;
  createdAt?: string;
}

function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function parseState(raw: string): SessionState {
  const valid: SessionState[] = [
    "working",
    "needs_input",
    "idle",
    "completed",
    "failed",
    "stopped",
  ];
  const lower = raw.toLowerCase();
  return valid.includes(lower as SessionState)
    ? (lower as SessionState)
    : "unknown";
}

function parseSession(shortId: string, data: Record<string, unknown>): Session {
  return {
    shortId,
    sessionId: data.sessionId as string | undefined,
    name: data.name as string | undefined,
    state: parseState((data.state as string) || ""),
    prompt: data.prompt as string | undefined,
    cwd: data.cwd as string | undefined,
    createdAt: data.createdAt as string | undefined,
  };
}

export async function listSessions(): Promise<Session[]> {
  const jobsDir = join(getClaudeDir(), "jobs");
  let entries: string[];
  try {
    entries = await readdir(jobsDir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const entry of entries.sort()) {
    const stateFile = join(jobsDir, entry, "state.json");
    try {
      const raw = await readFile(stateFile, "utf-8");
      const data = JSON.parse(raw);
      sessions.push(parseSession(entry, data));
    } catch {
      sessions.push({ shortId: entry, state: "unknown" });
    }
  }
  return sessions;
}

export async function getSession(
  shortId: string,
): Promise<Session | undefined> {
  const stateFile = join(getClaudeDir(), "jobs", shortId, "state.json");
  try {
    const raw = await readFile(stateFile, "utf-8");
    const data = JSON.parse(raw);
    return parseSession(shortId, data);
  } catch {
    return undefined;
  }
}

export async function getRoster(): Promise<Record<string, unknown>> {
  const rosterFile = join(getClaudeDir(), "daemon", "roster.json");
  try {
    const raw = await readFile(rosterFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Parse short ID from `claude --bg` output.
 * Expected: "backgrounded · 7c5dcf5d"
 */
function parseBgOutput(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("backgrounded") && trimmed.includes("·")) {
      const parts = trimmed.split("·");
      if (parts.length >= 2) {
        return parts[parts.length - 1].trim();
      }
    }
  }
  return undefined;
}

export async function createSession(
  prompt: string,
  name?: string,
  cwd?: string,
): Promise<Session> {
  const args = ["--bg"];
  if (name) args.push("--name", name);
  args.push(prompt);

  const { stdout, stderr } = await execFileAsync("claude", args, {
    cwd: cwd || undefined,
  });

  const shortId = parseBgOutput(stdout);
  if (!shortId) {
    throw new Error(
      `Failed to parse session ID from output: ${stdout}\n${stderr}`,
    );
  }

  // Give Claude a moment to write state.json
  await new Promise((r) => setTimeout(r, 500));

  const session = await getSession(shortId);
  return session || { shortId, state: "working", prompt, name };
}

export async function stopSession(shortId: string): Promise<boolean> {
  try {
    await execFileAsync("claude", ["stop", shortId]);
    return true;
  } catch {
    return false;
  }
}

export async function respawnSession(shortId: string): Promise<boolean> {
  try {
    await execFileAsync("claude", ["respawn", shortId]);
    return true;
  } catch {
    return false;
  }
}

export async function removeSession(shortId: string): Promise<boolean> {
  try {
    await execFileAsync("claude", ["rm", shortId]);
    return true;
  } catch {
    return false;
  }
}

export async function getLogs(shortId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("claude", ["logs", shortId]);
    return stdout;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
