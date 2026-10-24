/**
 * ScoutDispatchAudit — the named boundary for the `hydra:scout:dispatches`
 * audit stream (issue #1972). The alert-driven trigger was retired in
 * #5054; the calendar walk (`recordCalendarDispatch`, issue #4556) is the
 * only writer of this stream.
 *
 * This module concentrates the audit
 * concern — wire-field serialisation, the MAXLEN policy, the XREVRANGE
 * parse, and the at-most-once write helpers — behind one named interface
 * so callers don't have to reach into the scout internals to
 * read or write the audit trail.
 *
 * The write helper also accepts an OPTIONAL per-candidate counts map that
 * is forwarded to `stats.ts:incrStat`, so `GET /api/scout/stats` reflects
 * the calendar trigger (issue #4556 root cause: the per-day counters were
 * written by nobody at all — totals read 0 after a calendar walk that
 * evaluated 5 candidates). The dispatch outcome itself is never
 * auto-translated into a count; only explicit counts move the rollup.
 *
 * Domain placement (ADR-0017 Category B): the underlying Redis Streams
 * primitives (`xaddScoutDispatch` / `xrevrangeScoutDispatches`) and the
 * cooldown setters live in `src/redis/scout.ts` and are UNCHANGED. This is a
 * scout-DOMAIN module wrapping those typed accessors with field serialisation
 * and the `DispatchAuditEntry` type — it is NOT a new Redis seam. It must never
 * call `getRedisConnection` or import `redis/keys` / `redis/kv` directly.
 */

import {
  setScoutCategoryLastWalked,
  xaddScoutDispatch,
  xrevrangeScoutDispatches,
} from "../redis/scout.ts";
import { incrStat, SCOUT_METRICS, type ScoutMetric } from "./stats.ts";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Bound the audit stream — keep last 1000 dispatches. */
export const SCOUT_DISPATCHES_MAXLEN = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Audit-trail entry written to `hydra:scout:dispatches`. */
export interface DispatchAuditEntry {
  triggeredBy: "calendar";
  category: string;
  dispatchedAt: string;
  /** Cost in fractional dollars; null if not measured by caller. */
  cost: number | null;
  outcome: "filed" | "dropped" | "error";
  /** Optional free-form details — error message, issueNum, etc. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Calendar-trigger bookkeeping (issue #4556)
// ---------------------------------------------------------------------------

/**
 * After the caller dispatches a scout for a calendar-walked category, call this to:
 *
 *   1. XADD exactly one audit entry (`triggeredBy: "calendar"`) to
 *      `hydra:scout:dispatches`.
 *   2. On a non-error outcome, stamp the per-category cooldown — the SAME
 *      key the calendar walk's `stampCategoryWalk` writes, so the two
 *      triggers honor each other and a separate stamp call is redundant
 *      (not wrong). It does NOT stamp the class walk (that stays
 *      once-per-sweep via `stampClassWalk`) and does NOT stamp a
 *      per-pattern dedup key (calendar walks have no pattern).
 *   3. Increment the per-day stat counters from the per-candidate
 *      `counts` map so `/api/scout/stats` reflects calendar-driven
 *      activity (issue #4556 — previously invisible).
 *
 * The outcome is never auto-translated into a count — pass explicit counts
 * (e.g. `{candidates: 5, filtered: 2, filed: 1}`) to move the rollup.
 *
 * Error outcomes XADD the audit entry but stamp no cooldown (errors are
 * retried, not suppressed; they stay visible
 * via `/api/scout/dispatches`).
 */
export async function recordCalendarDispatch(
  category: string,
  outcome: "filed" | "dropped" | "error",
  counts: Partial<Record<ScoutMetric, number>> = {},
  detail: string = "",
  now: Date = new Date(),
  cost: number | null = null,
): Promise<void> {
  if (!category) {
    throw new TypeError("recordCalendarDispatch: category required");
  }
  const nowIso = now.toISOString();

  // 1. Audit stream.
  await xaddDispatchAudit({
    triggeredBy: "calendar",
    category,
    dispatchedAt: nowIso,
    cost,
    outcome,
    detail: detail || `calendar walk of ${category}`,
  });

  // 3. Per-day stat counters (unconditional: candidates were evaluated
  // regardless of the dispatch outcome).
  await applyCounts(category, counts, now);

  // 2. Per-category cooldown — non-error outcomes only.
  if (outcome === "error") return;
  await setScoutCategoryLastWalked(category, nowIso);
}

// ---------------------------------------------------------------------------
// Shared stats wiring (issue #4556) — one helper both triggers route through
// ---------------------------------------------------------------------------

/**
 * Increment the per-day stat counters for a category from a per-candidate
 * counts map. Entries whose key is not a `ScoutMetric` or whose value is
 * not a finite number > 0 are SKIPPED, not thrown (design-concept #4556:
 * a malformed count must never fail the audit write that already landed).
 */
async function applyCounts(
  category: string,
  counts: Partial<Record<ScoutMetric, number>>,
  now: Date,
): Promise<void> {
  for (const [metric, n] of Object.entries(counts)) {
    const m = metric as ScoutMetric;
    if (!SCOUT_METRICS.includes(m)) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    await incrStat(category, m, n, now);
  }
}

// ---------------------------------------------------------------------------
// Audit stream readers (for /api/scout/dispatches)
// ---------------------------------------------------------------------------

/**
 * Read the last `limit` dispatch audit entries newest-first. Defaults to 50,
 * clamped to [1, 1000].
 */
export async function listDispatchAudits(limit: number = 50): Promise<DispatchAuditEntry[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(limit) || 50));
  // XREVRANGE returns newest-first.
  const entries = await xrevrangeScoutDispatches(n);
  const out: DispatchAuditEntry[] = [];
  for (const [, fields] of entries) {
    out.push(parseAuditFields(fields));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function xaddDispatchAudit(entry: DispatchAuditEntry): Promise<void> {
  const fields: string[] = [
    "triggeredBy", entry.triggeredBy,
    "category", entry.category,
    "dispatchedAt", entry.dispatchedAt,
    "cost", entry.cost == null ? "" : String(entry.cost),
    "outcome", entry.outcome,
    "detail", entry.detail,
  ];
  // MAXLEN ~ N keeps the stream bounded; ~ is approximate (faster trim).
  await xaddScoutDispatch(SCOUT_DISPATCHES_MAXLEN, fields);
}

function parseAuditFields(fields: string[]): DispatchAuditEntry {
  // ioredis returns ["k","v","k","v",...]; pair them up.
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  const costRaw = map.cost ?? "";
  const cost = costRaw === "" ? null : Number.parseFloat(costRaw);
  const triggeredBy = (map.triggeredBy ?? "calendar") as DispatchAuditEntry["triggeredBy"];
  const outcome = (map.outcome ?? "error") as DispatchAuditEntry["outcome"];
  return {
    triggeredBy,
    category: map.category ?? "",
    dispatchedAt: map.dispatchedAt ?? "",
    cost: Number.isFinite(cost as number) ? (cost as number) : null,
    outcome,
    detail: map.detail ?? "",
  };
}
