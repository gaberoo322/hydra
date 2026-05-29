/**
 * src/cycle.ts — Read-only cycle state surface.
 *
 * Before PR-3 (issue #383) this module wrapped the in-process control loop:
 * a `startCycle()` would invoke `runControlLoop()`, track an in-memory active
 * cycle, and push completed cycles onto a history array. PR-3 deleted the
 * control loop entirely — autopilot subagents own execution now and write
 * their own cycle records straight to Redis (`hydra:cycle:*`).
 *
 * The vestigial write/trigger stubs (`startCycle()`/`killCycle()`) and the
 * dead `POST /api/cycle/start` route were removed in issue #701. This module
 * is now purely a read-only adapter so the existing `/api/cycle/status` and
 * `/api/cycle/history` endpoints keep working against the Redis-backed records.
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

export { getCycleStatus, getCycleHistory };
