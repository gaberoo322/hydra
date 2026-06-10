/**
 * Scope-violation counter Redis seam (issue #732).
 *
 * The CI `scope-check` gate (`scripts/ci/scope-check.ts`) trips when a PR
 * touches files outside its declared scope (hard out-of-scope or the
 * >80% ratio breach). Today that trip is observable only in the CI run
 * log — there is no trended signal of how often the **Pre-merge Gate**'s
 * scope arm fires. The Builder-Health Scorecard's scope-violation-rate
 * metric needs a durable, day-bucketed count.
 *
 * This is one of the only TWO new persisted signals the scorecard adds
 * (the other being the dispatch->PR link on the autopilot-run hash). Every
 * other scorecard metric is composed read-only from existing state.
 *
 * Storage: a per-UTC-day INT counter, 90-day TTL so a rolling-window read
 * always has at least a quarter of history without unbounded growth. The
 * counter is incremented best-effort from `scope-check.ts` over HTTP
 * (`POST /api/builder-health/scope-violation`) so the CI gate stays
 * dependency-free of ioredis — it already shells `gh`/`git` and runs in an
 * Actions runner, not in-process. Key shape lives here per ADR-0009.
 */

import { getRedisConnection } from "./connection.ts";

/** 90 days — comfortably covers any scorecard rolling window. */
export const SCOPE_VIOLATION_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Daily scope-violation counter key. INT string, one per UTC day. */
function scopeViolationsDailyKey(date: string): string {
  return `hydra:metrics:scope-violations:daily:${date}`;
}

/**
 * Increment the scope-violation counter for `date` (UTC YYYY-MM-DD) and
 * stamp the TTL. Returns the new total. Best-effort: callers treat a thrown
 * Redis error as "not recorded" rather than failing their own flow.
 */
export async function incrScopeViolation(date: string, by = 1): Promise<number> {
  const r = getRedisConnection();
  const key = scopeViolationsDailyKey(date);
  const total = await r.incrby(key, by);
  await r.expire(key, SCOPE_VIOLATION_TTL_SECONDS);
  return total;
}

/**
 * Read the scope-violation counts for the last `days` UTC days ending at
 * `now`, newest-first. Missing days read as 0. Pipelined into a single
 * round-trip.
 */
export async function getScopeViolationsByDay(
  days: number,
  now: Date = new Date(),
): Promise<Array<{ date: string; count: number }>> {
  const n = Math.max(1, Math.floor(days));
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(utcDateKey(d));
  }
  const r = getRedisConnection();
  const pipe = r.pipeline();
  for (const date of dates) pipe.get(scopeViolationsDailyKey(date));
  const results = await pipe.exec();
  const out: Array<{ date: string; count: number }> = [];
  for (let i = 0; i < dates.length; i++) {
    const res = Array.isArray(results) ? results[i] : null;
    const raw = Array.isArray(res) && res[0] == null ? res[1] : null;
    const count = typeof raw === "string" ? Number(raw) || 0 : 0;
    out.push({ date: dates[i], count });
  }
  return out;
}

/** Pure helper — exported for tests. UTC YYYY-MM-DD for a Date. */
export function utcDateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
