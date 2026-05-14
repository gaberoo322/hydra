/**
 * src/cycle.ts — Read-only cycle state surface.
 *
 * Before PR-3 (issue #383) this module wrapped the in-process control loop:
 * `startCycle()` would invoke `runControlLoop()`, track an in-memory active
 * cycle, and push completed cycles onto a history array. PR-3 deleted the
 * control loop entirely — autopilot subagents own execution now and write
 * their own cycle records straight to Redis (`hydra:cycle:*`).
 *
 * This module survives as a thin read-only adapter so the existing
 * `/api/cycle/status` and `/api/cycle/history` endpoints keep working
 * against the same Redis-backed records. `startCycle()` is preserved as a
 * stub that immediately reports the in-process loop is gone; nothing in
 * `src/` calls it any more, only the legacy `POST /api/cycle/start` route
 * does, and operators who hit it should get a clear error message.
 *
 * Keep this module dumb. Real cycle tracking lives in the autopilot.
 */

import { redisKeys } from "./redis-keys.ts";
import { getString, hashGetAll, findKeys } from "./redis-adapter.ts";

interface CycleRecord {
  id: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  total?: number;
  completed?: number;
  failed?: number;
  abandoned?: number;
  timedOut?: number;
}

/**
 * Legacy entry point. The in-process control loop was removed in PR-3
 * (issue #383). Returns an error so the operator-facing
 * `POST /api/cycle/start` route reports a clear failure instead of
 * silently no-oping.
 */
async function startCycle(_eventBus: unknown, _opts: any = {}) {
  return {
    error: "In-process control loop removed (issue #383). Execution runs via autopilot subagents — see `hydra-autopilot` skill.",
    cycle: { status: "removed" },
  };
}

async function getCycleStatus(): Promise<CycleRecord | { status: string }> {
  const activeId = await getString(redisKeys.cycleActive());
  if (!activeId) return { status: "idle" };

  const cycle = await hashGetAll(redisKeys.cycle(activeId));
  if (!cycle || !cycle.status) return { status: "idle" };

  return {
    id: activeId,
    status: cycle.status,
    startedAt: cycle.startedAt || null,
    completedAt: cycle.completedAt || null,
    total: parseInt(cycle.total || "0"),
    completed: parseInt(cycle.completed || "0"),
    failed: parseInt(cycle.failed || "0"),
    abandoned: parseInt(cycle.abandoned || "0"),
    timedOut: parseInt(cycle.timedOut || "0"),
  };
}

async function getCycleHistory(limit = 10): Promise<CycleRecord[]> {
  let ids: string[] = [];

  try {
    ids = await findKeys(redisKeys.cycle("cycle-*"));
  } catch (err: any) {
    console.error(`[Cycle] Failed to list cycle keys from Redis: ${err.message}`);
  }

  const seen = new Set<string>();
  const records: CycleRecord[] = [];

  for (const id of ids.filter((k: string) => !k.endsWith(":agents") && !k.endsWith(":costs") && !k.endsWith(":tasks")).sort().reverse()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cycleId = id.replace(new RegExp(`^${redisKeys.cycle("")}`), "");
    const cycle = await hashGetAll(id);
    if (!cycle || !cycle.status) continue;
    records.push({
      id: cycleId,
      status: cycle.status,
      startedAt: cycle.startedAt || null,
      completedAt: cycle.completedAt || null,
      total: parseInt(cycle.total || "0"),
      completed: parseInt(cycle.completed || "0"),
      failed: parseInt(cycle.failed || "0"),
      abandoned: parseInt(cycle.abandoned || "0"),
      timedOut: parseInt(cycle.timedOut || "0"),
    });
    if (records.length >= limit) break;
  }

  return records;
}

/**
 * Legacy entry point. The in-process control loop was removed in PR-3
 * (issue #383). There is no in-memory active cycle to kill. Returns the
 * no-op shape callers used to expect when the scheduler was already idle.
 */
async function killCycle(_eventBus: unknown) {
  return { killed: false, reason: "In-process control loop removed (issue #383)" };
}

export { startCycle, getCycleStatus, getCycleHistory, killCycle };
