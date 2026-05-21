/**
 * Cron-based scheduler that fires CSM session creations on a schedule.
 *
 * Lifecycle:
 *   1. initScheduler() — called once at server startup. Loads all
 *      persisted Schedule files and registers cron tasks for enabled ones.
 *   2. registerSchedule(s) — called by API handlers after create/update.
 *      Replaces any existing cron task for this schedule.
 *   3. unregisterSchedule(id) — called by API handlers on delete/disable.
 *   4. fireSchedule(id) — public so the /run endpoint can trigger an
 *      immediate manual execution.
 */

import cron from "node-cron";
import type { ScheduledTask } from "node-cron";

import * as cli from "./claude-cli.js";
import * as schedulesStore from "./schedules.js";
import type { Schedule, ScheduleRunRecord } from "./schedules.js";

// ─── State ──────────────────────────────────────────────────────────────────

/** Map of schedule.id → registered node-cron task */
const tasks = new Map<string, ScheduledTask>();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format a timestamp suitable for embedding into a session name */
function timestampForName(d: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

/** Sanitize a schedule name for embedding in a session name */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "sched";
}

async function refreshNextRun(id: string): Promise<void> {
  const task = tasks.get(id);
  if (!task) {
    await schedulesStore.setNextRun(id, undefined);
    return;
  }
  try {
    const next = task.getNextRun();
    await schedulesStore.setNextRun(id, next ? next.toISOString() : undefined);
  } catch {
    await schedulesStore.setNextRun(id, undefined);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Validate a cron expression (5-field) */
export function isValidCron(expression: string): boolean {
  try {
    return cron.validate(expression);
  } catch {
    return false;
  }
}

/**
 * Register (or re-register) a schedule. Replaces any existing cron task for
 * the same id. If the schedule is disabled or has an invalid cron expression,
 * no task is created (and any previously-registered task is removed).
 */
export async function registerSchedule(schedule: Schedule): Promise<void> {
  // Always tear down any existing task first
  unregisterSchedule(schedule.id);

  if (!schedule.enabled) {
    await schedulesStore.setNextRun(schedule.id, undefined);
    return;
  }
  if (!isValidCron(schedule.cron)) {
    console.warn(
      `[scheduler] Skipping ${schedule.id} (${schedule.name}): invalid cron "${schedule.cron}"`,
    );
    await schedulesStore.setNextRun(schedule.id, undefined);
    return;
  }

  const task = cron.schedule(
    schedule.cron,
    async () => {
      await fireSchedule(schedule.id, "scheduled");
      await refreshNextRun(schedule.id);
    },
    {
      timezone: schedule.timezone || "Asia/Tokyo",
      name: schedule.name,
      noOverlap: true,
    },
  );

  tasks.set(schedule.id, task);
  await refreshNextRun(schedule.id);
}

/** Remove the cron task for a schedule (no-op if not registered). */
export function unregisterSchedule(id: string): void {
  const task = tasks.get(id);
  if (task) {
    try {
      void task.destroy();
    } catch {
      // best-effort
    }
    tasks.delete(id);
  }
}

/**
 * Immediately fire a schedule, regardless of cron timing.
 * Used by both the cron trigger and the manual /run endpoint.
 *
 * Returns the updated Schedule, or null if the schedule does not exist.
 */
export async function fireSchedule(
  id: string,
  reason: "scheduled" | "manual" = "manual",
): Promise<Schedule | null> {
  const schedule = await schedulesStore.getSchedule(id);
  if (!schedule) return null;
  // Scheduled fires only run when enabled; manual fires bypass that check.
  if (reason === "scheduled" && !schedule.enabled) return schedule;

  const firedAt = new Date();
  const sessionName = `${sanitizeName(schedule.name)}-${timestampForName(firedAt)}`;

  let record: ScheduleRunRecord;
  try {
    const session = await cli.createSession(
      schedule.prompt,
      sessionName,
      schedule.cwd,
      schedule.model,
      schedule.id,
    );
    record = {
      firedAt: firedAt.toISOString(),
      shortId: session.shortId,
      sessionId: session.sessionId,
      status: "ok",
    };
    console.log(
      `[scheduler] Fired "${schedule.name}" (${reason}) → session ${session.shortId}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    record = {
      firedAt: firedAt.toISOString(),
      status: "error",
      error: message,
    };
    console.error(
      `[scheduler] Failed to fire "${schedule.name}" (${reason}): ${message}`,
    );
  }

  return await schedulesStore.recordRun(id, record);
}

/**
 * Load all persisted schedules and register cron tasks for the enabled ones.
 * Called once at server startup.
 */
export async function initScheduler(): Promise<void> {
  const all = await schedulesStore.listSchedules();
  let registered = 0;
  for (const s of all) {
    await registerSchedule(s);
    if (s.enabled && isValidCron(s.cron)) registered++;
  }
  console.log(
    `[scheduler] Initialized: ${all.length} schedule(s) loaded, ${registered} active`,
  );
}

/**
 * Tear down all registered tasks. Intended for tests / graceful shutdown.
 */
export function shutdownScheduler(): void {
  for (const id of Array.from(tasks.keys())) {
    unregisterSchedule(id);
  }
}
