/**
 * Tool-scout statistics (issue #485, Phase B).
 *
 * Persists per-day per-category counters and exposes a "last N days" rollup
 * for the `/api/scout/stats` endpoint. The counters are written by the
 * scout itself (Phase A skill, extended in Phase B) — this module owns the
 * Redis schema and the rollup query.
 *
 * Storage: one Redis hash per UTC day at
 *   `hydra:scout:stats:<YYYY-MM-DD>`
 *
 * Hash fields are flat `<category>:<metric>` pairs so the entire day's
 * counts can be incremented and read in a single round-trip. `<metric>` is
 * one of: candidates, filtered, filed, dropped, rejected. Keys carry a
 * 14-day TTL — the rollup window is "last week" so two weeks of retention
 * is enough headroom for late writes / clock drift.
 */

import {
  getScoutStatsHash,
  incrScoutStatsField,
} from "../redis/scout.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Metrics the scout increments per dispatch. */
export type ScoutMetric =
  | "candidates" // surfaced by discovery
  | "filtered"   // survived the AI-leverage + maintenance gates
  | "filed"      // GitHub issue created
  | "dropped"    // dedup cooldown skip
  | "rejected";  // failed a gate, recorded to seen-list

export const SCOUT_METRICS: readonly ScoutMetric[] = [
  "candidates",
  "filtered",
  "filed",
  "dropped",
  "rejected",
];

/** TTL on per-day hashes — 14 days. */
const STATS_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Maximum lookback window for `getStatsRollup` — 14 days (matches TTL). */
export const MAX_ROLLUP_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Increment a single (category, metric) counter for the given day. Idempotent
 * w.r.t. ordering — incrementing twice with `delta=1` and once with `delta=2`
 * yield the same final count. Refreshes the 14d TTL on every write.
 *
 * `now` defaults to `new Date()`; tests pass a fixed clock.
 */
export async function incrStat(
  category: string,
  metric: ScoutMetric,
  delta: number = 1,
  now: Date = new Date(),
): Promise<number> {
  if (!category) throw new TypeError("incrStat: category required");
  if (!SCOUT_METRICS.includes(metric)) {
    throw new RangeError(`incrStat: unknown metric ${metric}`);
  }
  if (!Number.isFinite(delta)) {
    throw new TypeError(`incrStat: delta must be finite, got ${delta}`);
  }
  const day = toIsoDay(now);
  const field = `${category}:${metric}`;
  // Refresh TTL on every write — a hash that hasn't been touched in 14d
  // will expire naturally.
  return incrScoutStatsField(day, field, delta, STATS_TTL_SECONDS);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Roll up the last `windowDays` UTC days into a single
 * `{ category: { metric: count } }` view. `now` is INCLUSIVE — a 7-day
 * window with `now = 2026-05-19` covers 2026-05-13..2026-05-19.
 *
 * Clamps `windowDays` to `[1, MAX_ROLLUP_WINDOW_DAYS]`.
 */
export async function getStatsRollup(
  windowDays: number = 7,
  now: Date = new Date(),
): Promise<Record<string, Record<ScoutMetric, number>>> {
  const w = Math.max(1, Math.min(MAX_ROLLUP_WINDOW_DAYS, Math.floor(windowDays)));
  const out: Record<string, Record<ScoutMetric, number>> = {};
  for (let i = 0; i < w; i++) {
    const day = toIsoDay(addDays(now, -i));
    const raw = await getScoutStatsHash(day);
    if (!raw) continue;
    for (const [field, val] of Object.entries(raw)) {
      const idx = field.lastIndexOf(":");
      if (idx <= 0) continue;
      const category = field.slice(0, idx);
      const metric = field.slice(idx + 1) as ScoutMetric;
      if (!SCOUT_METRICS.includes(metric)) continue;
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n)) continue;
      const bucket =
        out[category] ?? makeEmptyBucket();
      bucket[metric] += n;
      out[category] = bucket;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptyBucket(): Record<ScoutMetric, number> {
  return {
    candidates: 0,
    filtered: 0,
    filed: 0,
    dropped: 0,
    rejected: 0,
  };
}

/** YYYY-MM-DD in UTC. Pure. */
export function toIsoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const c = new Date(d.getTime());
  c.setUTCDate(c.getUTCDate() + days);
  return c;
}
