/**
 * Schedule definitions and persistence.
 *
 * A schedule represents a recurring job that creates a CSM session at a
 * cron-expressed time. Schedules are stored as JSON files under
 * ~/.claude/csm-schedules/<id>.json — one file per schedule.
 *
 * The scheduler (src/scheduler.ts) consumes these objects and registers
 * node-cron tasks.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG } from "./config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScheduleRunRecord {
  /** ISO timestamp when the fire happened (or was attempted) */
  firedAt: string;
  /** Short ID of the session created (if any) */
  shortId?: string;
  /** Full sessionId of the session created (if any) */
  sessionId?: string;
  /** "ok" if createSession succeeded, "error" otherwise */
  status: "ok" | "error";
  /** Error message if status === "error" */
  error?: string;
}

export interface Schedule {
  /** UUID v4 */
  id: string;
  /** Human-readable name */
  name: string;
  /** 5-field cron expression (e.g. "0 9 * * *") */
  cron: string;
  /** IANA timezone (e.g. "Asia/Tokyo") */
  timezone: string;
  /** Prompt to send to the spawned session */
  prompt: string;
  /** Working directory for the spawned session */
  cwd?: string;
  /** Model override */
  model?: string;
  /** Whether this schedule fires */
  enabled: boolean;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
  /** Most recent run (mirrors history[0]) */
  lastRun?: ScheduleRunRecord;
  /** Next scheduled fire time (ISO timestamp); computed by scheduler */
  nextRun?: string;
  /** Recent run history, newest first; capped to HISTORY_LIMIT */
  history: ScheduleRunRecord[];
}

export const HISTORY_LIMIT = 20;

/** Fields a client may supply when creating a schedule */
export interface ScheduleCreateInput {
  name: string;
  cron: string;
  timezone?: string;
  prompt: string;
  cwd?: string;
  model?: string;
  enabled?: boolean;
}

/** Fields a client may modify on an existing schedule */
export interface ScheduleUpdateInput {
  name?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  cwd?: string;
  model?: string;
  enabled?: boolean;
}

// ─── Storage ────────────────────────────────────────────────────────────────

function getSchedulesDir(): string {
  return join(CONFIG.paths.claudeConfigDir, "csm-schedules");
}

async function ensureDir(): Promise<void> {
  const dir = getSchedulesDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

function schedulePath(id: string): string {
  return join(getSchedulesDir(), `${id}.json`);
}

async function writeSchedule(s: Schedule): Promise<void> {
  await ensureDir();
  await writeFile(schedulePath(s.id), JSON.stringify(s, null, 2));
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listSchedules(): Promise<Schedule[]> {
  const dir = getSchedulesDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const schedules: Schedule[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, entry), "utf-8");
      const data = JSON.parse(raw) as Schedule;
      // Backward-compat: ensure history is an array
      if (!Array.isArray(data.history)) data.history = [];
      schedules.push(data);
    } catch {
      // Skip corrupt files
    }
  }
  // Sort: enabled first, then by createdAt desc
  schedules.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });
  return schedules;
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  try {
    const raw = await readFile(schedulePath(id), "utf-8");
    const data = JSON.parse(raw) as Schedule;
    if (!Array.isArray(data.history)) data.history = [];
    return data;
  } catch {
    return null;
  }
}

export async function createSchedule(input: ScheduleCreateInput): Promise<Schedule> {
  const now = new Date().toISOString();
  const schedule: Schedule = {
    id: randomUUID(),
    name: input.name,
    cron: input.cron,
    timezone: input.timezone || "Asia/Tokyo",
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.model,
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  await writeSchedule(schedule);
  return schedule;
}

export async function updateSchedule(
  id: string,
  patch: ScheduleUpdateInput,
): Promise<Schedule | null> {
  const existing = await getSchedule(id);
  if (!existing) return null;

  const updated: Schedule = {
    ...existing,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.cron !== undefined && { cron: patch.cron }),
    ...(patch.timezone !== undefined && { timezone: patch.timezone }),
    ...(patch.prompt !== undefined && { prompt: patch.prompt }),
    ...(patch.cwd !== undefined && { cwd: patch.cwd }),
    ...(patch.model !== undefined && { model: patch.model }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    updatedAt: new Date().toISOString(),
  };
  await writeSchedule(updated);
  return updated;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  try {
    await unlink(schedulePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a run result on a schedule.  Updates lastRun, history, and persists.
 * Returns the updated schedule, or null if the schedule no longer exists.
 */
export async function recordRun(
  id: string,
  record: ScheduleRunRecord,
): Promise<Schedule | null> {
  const existing = await getSchedule(id);
  if (!existing) return null;
  const history = [record, ...existing.history].slice(0, HISTORY_LIMIT);
  const updated: Schedule = {
    ...existing,
    lastRun: record,
    history,
  };
  await writeSchedule(updated);
  return updated;
}

/**
 * Update only the cached nextRun field; does not bump updatedAt.
 * Used by the scheduler after registering a task.
 */
export async function setNextRun(id: string, nextRun: string | undefined): Promise<void> {
  const existing = await getSchedule(id);
  if (!existing) return;
  if (existing.nextRun === nextRun) return;
  existing.nextRun = nextRun;
  await writeSchedule(existing);
}
