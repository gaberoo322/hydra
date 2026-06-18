/**
 * Merge→done reconciler health Redis ops (issue #2057).
 *
 * The merged-item reconciler (src/backlog/reconciler.ts) runs hourly from the
 * Housekeeping chore set. Before #2057 a stalled reconciler was indistinguishable
 * from "nothing merged today" — the only signal was a `console.error` line in
 * the service journal. This adapter persists a single last-run snapshot so the
 * scheduler-status endpoint can surface feed liveness + batch metrics without
 * re-running the sweep.
 *
 * Single JSON blob behind the Redis seam (ADR-0017): the chore is the sole
 * writer, the status endpoint the sole reader. A 2-day TTL means a stopped
 * scheduler leaves a record that first looks stale (an old `ranAt`) and then
 * disappears, rather than reporting permanently-fresh health.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/** TTL on the health record — 2 days, longer than the hourly run cadence so a
 * present record is always the genuine last run, but short enough that a
 * long-stopped scheduler's record ages out instead of lingering forever. */
const RECONCILER_HEALTH_TTL_SEC = 2 * 24 * 60 * 60;

/**
 * Structured last-run snapshot persisted by the merged-item-reconciler chore.
 * Mirrors the reconciler's own result shape plus a wall-clock `ranAt` stamp so
 * the status endpoint can compute staleness.
 */
export interface ReconcilerHealthRecord {
  /** ISO timestamp of the run that wrote this record. */
  ranAt: string;
  /** Per-feed liveness. `failed` is the (truncated) error reason or absent on success. */
  feed: {
    prs: { examined: number; failed?: string };
    commits: { examined: number; failed?: string };
  };
  /** Batch metrics for the run. */
  metrics: {
    referencesFound: number;
    movesFailed: number;
    itemsReconciled: number;
    itemsEscalated: number;
    scanned: number;
    durationMs: number;
  };
  /** Present only on a critical failure (e.g. both feeds down). */
  alert?: { code: string; message: string };
}

/** Persist the last reconciler run's health snapshot (best-effort; the caller
 * already logs, so a write failure here must never abort the chore). */
export async function setReconcilerHealth(record: ReconcilerHealthRecord): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.reconcilerHealth(), JSON.stringify(record), "EX", RECONCILER_HEALTH_TTL_SEC);
}

/** Read the last reconciler run's health snapshot, or `null` if none/expired or
 * the stored value is unparseable. */
export async function getReconcilerHealth(): Promise<ReconcilerHealthRecord | null> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.reconcilerHealth());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReconcilerHealthRecord;
  } catch (err: any) {
    console.error(`[Redis] getReconcilerHealth: unparseable health record: ${err?.message ?? err}`);
    return null;
  }
}
