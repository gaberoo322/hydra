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

import {
  getActiveCycleId,
  getCycleHash,
  listCycleIds,
} from "./redis/cycle-tracking.ts";

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
  const activeId = await getActiveCycleId();
  if (!activeId) return { status: "idle" };

  const cycle = await getCycleHash(activeId);
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
    ids = await listCycleIds();
  } catch (err: any) {
    console.error(`[Cycle] Failed to list cycle IDs from Redis: ${err.message}`);
  }

  const records: CycleRecord[] = [];

  for (const cycleId of ids) {
    const cycle = await getCycleHash(cycleId);
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
