/**
 * ScoutDispatchAudit — the named boundary for the `hydra:scout:dispatches`
 * audit stream (issue #1972, extracted from `alert-listener.ts`).
 *
 * Both scout trigger paths (alert-driven via `recordDispatch`, and any future
 * calendar-driven audit write) record a dispatch outcome to this stream. This
 * module concentrates the audit concern — wire-field serialisation, the MAXLEN
 * policy, the XREVRANGE parse, and the at-most-once `recordDispatch` write —
 * behind one named interface so callers don't have to reach into the
 * alert-classification module to read or write the audit trail.
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
  setScoutPatternLastFired,
  xaddScoutDispatch,
  xrevrangeScoutDispatches,
} from "../redis/scout.ts";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * TTL on per-pattern dedup keys stamped by `recordDispatch` — twice the
 * alert-listener cooldown (24h) so forgotten patterns self-clean. This const
 * is used ONLY by `recordDispatch`, so it lives with `recordDispatch` here
 * (single source of truth — do NOT re-declare it in `alert-listener.ts`).
 */
const ALERT_PATTERN_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Bound the audit stream — keep last 1000 dispatches. */
export const SCOUT_DISPATCHES_MAXLEN = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Audit-trail entry written to `hydra:scout:dispatches`. */
export interface DispatchAuditEntry {
  triggeredBy: "calendar" | `alert:${string}`;
  category: string;
  dispatchedAt: string;
  /** Cost in fractional dollars; null if not measured by caller. */
  cost: number | null;
  outcome: "filed" | "dropped" | "error";
  /** Optional free-form details — alert.id, error message, issueNum, etc. */
  detail: string;
}

/**
 * Shape `recordDispatch` needs from the caller's dispatch target — the pattern
 * (for the `alert:${pattern}` triggeredBy + per-pattern dedup), the category
 * (for the audit entry + per-category cooldown), and the alertId (audit detail
 * fallback). A structural subset of `AlertDispatchTarget`, declared here so
 * this module does not depend back on `alert-listener.ts`.
 */
export interface DispatchAuditTarget {
  /** Bare pattern name (no `pattern:` prefix). */
  pattern: string;
  /** Category slug the dispatch researched. */
  category: string;
  /** Alert.id that triggered this target — audit-detail fallback. */
  alertId: string;
}

// ---------------------------------------------------------------------------
// Post-dispatch bookkeeping (the shared audit write path)
// ---------------------------------------------------------------------------

/**
 * After the caller successfully dispatches a scout for a dispatch target,
 * call this to:
 *
 *   1. XADD an audit entry to `hydra:scout:dispatches`.
 *   2. Stamp the per-pattern dedup key (24h debounce).
 *   3. Stamp the per-category cooldown (shares the calendar-walk key —
 *      one cooldown surface for both triggers).
 *
 * Idempotent w.r.t. stamping (Redis SET overwrites) — but XADD always
 * appends, so a re-call will leave two audit entries. Don't call twice
 * for the same dispatch.
 */
export async function recordDispatch(
  target: DispatchAuditTarget,
  outcome: "filed" | "dropped" | "error",
  detail: string,
  now: Date = new Date(),
  cost: number | null = null,
): Promise<void> {
  const nowIso = now.toISOString();

  // 1. Audit stream.
  await xaddDispatchAudit({
    triggeredBy: `alert:${target.pattern}`,
    category: target.category,
    dispatchedAt: nowIso,
    cost,
    outcome,
    detail: detail || target.alertId,
  });

  // Only stamp dedup on filed/dropped — errors should be re-tried, not
  // suppressed. The pattern is still "we tried", but the operator may
  // want another shot after fixing the infra error.
  if (outcome === "error") return;

  // 2. Per-pattern dedup, 48h TTL (twice the cooldown — see ALERT_PATTERN_KEY_TTL_SECONDS).
  await setScoutPatternLastFired(target.pattern, nowIso, ALERT_PATTERN_KEY_TTL_SECONDS);

  // 3. Per-category cooldown — shares the calendar walk's key so both
  // triggers honor each other.
  await setScoutCategoryLastWalked(target.category, nowIso);
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
