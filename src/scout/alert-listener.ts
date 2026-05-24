/**
 * Tool-scout alert-driven trigger (issue #486, Phase C of /hydra-tool-scout).
 *
 * The Phase B calendar walk dispatches the scout on a 7-day cadence —
 * effective for steady-state coverage, sluggish for acute pain. Phase C
 * adds a *failure-driven* trigger: when one of the orchestrator's recurring
 * failure-pattern alerts fires (e.g. `pattern:test_decline`), we want the
 * scout to investigate the related taxonomy category within hours, not days.
 *
 * Architecture
 * ------------
 *
 * The orchestrator already publishes alerts to a Redis list at
 * `hydra:alerts` (see `src/index.ts:startConsumers`). Alerts are JSON
 * objects with shape:
 *
 *   { id, type, timestamp, message, severity, dismissed, payload }
 *
 * Of those, the `type` field carries the alert pattern — `pattern:<name>`,
 * `cycle:<event>`, `dlq:<event>`, etc. This module:
 *
 *   1. Reads the alerts list from the high-water-mark cursor stored at
 *      `hydra:scout:alert-cursor` forward (newest-first iteration; we
 *      stop at the cursor timestamp).
 *   2. Filters to types that map to a researchable taxonomy category via
 *      `PATTERN_CATEGORY_MAP`.
 *   3. Applies three anti-burst gates per candidate:
 *      a. Per-pattern dedup (24h): `hydra:scout:pattern-last-fired:<pattern>`.
 *      b. Per-category cooldown (24h for alert-driven; reuses the same
 *         per-category key as the calendar walk but with a 1-day window
 *         since the failure is acute pain).
 *      c. Coalescing — if multiple patterns in this batch map to the
 *         same category, only the first proposes a dispatch.
 *   4. Returns the surviving `AlertDispatchTarget[]` to the caller
 *      (autopilot decide.py via collect-state.sh). The caller dispatches
 *      the scout skill once per target.
 *   5. After a successful dispatch, the caller MUST call
 *      `recordDispatch()` to (a) XADD to the audit-trail stream,
 *      (b) stamp the per-pattern dedup, (c) stamp the per-category
 *      cooldown, (d) advance the alert cursor.
 *
 * Why a list cursor, not a stream consumer
 * ----------------------------------------
 *
 * The issue body asks for "subscribes to `hydra:alerts:*` Redis stream"
 * but the production alerts pipeline writes to a LIST (`hydra:alerts`),
 * not a stream — see `src/index.ts:startConsumers`. We match the live
 * data plane, not the proposal text. The cursor-over-list pattern is
 * a faithful implementation of the same intent: every alert is processed
 * at most once, late writes don't get lost, and the listener is
 * stateless between ticks.
 *
 * Why no infinite-loop guard for scout-induced alerts
 * ---------------------------------------------------
 *
 * Research question #4 in the issue body: can the scout's own activity
 * create alerts that re-trigger the scout? Answer: no.
 *   - The scout files GH issues; filing an issue doesn't publish a
 *     `pattern:*` alert.
 *   - The scout doesn't run cycles, so no `cycle:*` alerts.
 *   - Cost spikes would fire `cost-cap` alerts, but `cost-cap` is NOT
 *     in `PATTERN_CATEGORY_MAP` and so never re-triggers the scout.
 *
 * The map is the chokepoint — only patterns explicitly listed in
 * `PATTERN_CATEGORY_MAP` can drive a dispatch. Adding a new pattern
 * to the map is a deliberate operator action.
 */

import { readRecentAlerts } from "../redis/alerts.ts";
import {
  getScoutAlertCursor,
  getScoutCategoryLastWalked,
  getScoutPatternLastFired,
  setScoutAlertCursor,
  setScoutCategoryLastWalked,
  setScoutPatternLastFired,
  xaddScoutDispatch,
  xrevrangeScoutDispatches,
} from "../redis/scout.ts";

// ---------------------------------------------------------------------------
// Pattern → category map (starter, per issue body)
// ---------------------------------------------------------------------------

/**
 * Closed map from alert pattern names (the suffix after `pattern:` in the
 * alert `type` field) to one-or-more researchable taxonomy categories.
 *
 * The starter set is pinned by the issue body:
 *
 *   - `consecutive_failures` → broad — agent-quality / harness improvements.
 *     Maps to multiple categories; the listener coalesces but the calendar
 *     walk picks them up over time anyway. We surface `verification-tooling`
 *     as the single best-fit category because consecutive failures usually
 *     mean tests/verification are missing the regression.
 *
 *   - `test_decline` → `testing-tooling` (mutation, property-based, snapshot
 *     infrastructure).
 *
 *   - `file_rework` → `refactoring-tooling` (code search infra, LSP).
 *     Note: `file_rework` is NOT in the current alert taxonomy — see
 *     `src/index.ts:ALERT_TYPES`. Adding it is on the discover/research
 *     roadmap. The map entry lives here as a forward-compat hook so that
 *     when `file_rework` patterns start firing, the wiring just works.
 *
 *   - `rollback_cluster` → `verification-tooling` (canary, observability).
 *     Likewise not yet in `ALERT_TYPES`; forward-compat.
 *
 *   - `recurring_regressions` → `testing-tooling` (this IS in
 *     `ALERT_TYPES`; mapping here so it fires on day one).
 *
 *   - `anchor_stuck` → `refactoring-tooling`. Stuck anchors often mean the
 *     agent can't find the right entrypoint; better code-search would
 *     help.
 *
 *   - `low_merge_rate` → `verification-tooling`. Low merge-rate is
 *     usually CI flake or scope-creep; better verification tooling
 *     helps both.
 *
 *   - `high_abandonment` → `agent-tooling`. High abandonment usually
 *     means agent context limits / harness friction — research the
 *     category that covers harness improvements.
 *
 * Patterns NOT in this map are deliberately silent — `cost-cap` and
 * `consumer:dead` are infra concerns, not researchable categories.
 *
 * Keys are bare pattern names (no `pattern:` prefix); the listener
 * strips the `pattern:` prefix before consulting the map so the same
 * map serves both `pattern:test_decline` and a hypothetical raw
 * `test_decline` alert type.
 */
export const PATTERN_CATEGORY_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  consecutive_failures: Object.freeze(["verification-tooling"]),
  test_decline: Object.freeze(["testing-tooling"]),
  file_rework: Object.freeze(["refactoring-tooling"]),
  rollback_cluster: Object.freeze(["verification-tooling"]),
  recurring_regressions: Object.freeze(["testing-tooling"]),
  anchor_stuck: Object.freeze(["refactoring-tooling"]),
  low_merge_rate: Object.freeze(["verification-tooling"]),
  high_abandonment: Object.freeze(["agent-tooling"]),
});

// ---------------------------------------------------------------------------
// Cooldown / debounce constants
// ---------------------------------------------------------------------------

/**
 * Failure-driven dispatches need faster response than calendar
 * cadence — 24h is the operator-chosen "acute pain window" (issue body).
 * Per-pattern AND per-category both use this default. The 7d/30d
 * calendar-walk cooldowns are deliberately bypassed for alert-driven
 * dispatches; the rationale is that an acute failure pattern shouldn't
 * have to wait a month even if we calendar-walked the category recently.
 */
export const ALERT_PER_PATTERN_COOLDOWN_HOURS = 24;
export const ALERT_PER_CATEGORY_COOLDOWN_HOURS = 24;

/** TTL on per-pattern dedup keys — twice the cooldown so forgotten patterns self-clean. */
export const ALERT_PATTERN_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

/** Bound on the alerts-list scan so we don't iterate the whole list every tick. */
export const ALERT_SCAN_BATCH = 100;

/** Bound the audit stream — keep last 1000 dispatches. */
export const SCOUT_DISPATCHES_MAXLEN = 1000;

const MS_PER_HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw alert shape as written by `src/index.ts:startConsumers`. */
export interface RawAlert {
  id?: string;
  type?: string;
  timestamp?: string;
  message?: string;
  severity?: string;
  dismissed?: boolean;
  payload?: unknown;
}

/** A surviving alert that should drive a scout dispatch. */
export interface AlertDispatchTarget {
  /** Bare pattern name (no `pattern:` prefix). */
  pattern: string;
  /** Category slug the dispatch will research. */
  category: string;
  /** Alert.id that triggered this target — for audit trail. */
  alertId: string;
  /** ISO-8601 timestamp of the source alert. */
  alertTimestamp: string;
  /** Human-readable source message (alert.message). */
  reason: string;
}

/** Disposition for an alert candidate during planning. Used for diagnostics. */
export interface AlertSkipRecord {
  pattern: string;
  category: string | null;
  alertId: string;
  alertTimestamp: string;
  reason:
    | "unmapped-pattern"
    | "pattern-cooldown"
    | "category-cooldown"
    | "coalesced"
    | "dismissed"
    | "before-cursor"
    | "malformed";
}

/** Output of the planning step. Pure data so callers can log + audit. */
export interface AlertPlan {
  /** Targets that survived all anti-burst gates. */
  eligible: AlertDispatchTarget[];
  /** Candidates filtered out, with reason. */
  skipped: AlertSkipRecord[];
  /** Newest alert timestamp the planner observed — caller advances cursor to this. */
  newestTimestamp: string | null;
  /** Wall-clock the plan was computed at. */
  computedAt: string;
}

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

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

/** Strip the `pattern:` prefix if present, otherwise return the input. */
export function stripPatternPrefix(type: string): string {
  if (typeof type !== "string") return "";
  return type.startsWith("pattern:") ? type.slice("pattern:".length) : type;
}

/**
 * Look up the categories for a normalized pattern name. Returns an empty
 * array (NOT null) for unknown patterns so callers can iterate without
 * a null-check.
 */
export function categoriesForPattern(pattern: string): readonly string[] {
  return PATTERN_CATEGORY_MAP[pattern] ?? [];
}

/**
 * Pure cooldown predicate over (lastIso, hours, now). Mirrors
 * `calendar-walk.ts:isCooledDown` but in hours not days, so the two
 * call sites can stay readable side-by-side.
 *
 *  - null/empty → cooled (no prior fire)
 *  - unparseable → cooled (corrupt-record fallback)
 *  - elapsed ≥ hours → cooled
 */
export function isCooledDownHours(
  lastIso: string | null,
  hours: number,
  now: Date = new Date(),
): boolean {
  if (!lastIso) return true;
  const lastMs = Date.parse(lastIso);
  if (!Number.isFinite(lastMs)) return true;
  const ageH = (now.getTime() - lastMs) / MS_PER_HOUR;
  return ageH >= hours;
}

/**
 * Decide an alert's disposition given the current cooldown state + the
 * categories already proposed in THIS batch (for coalescing).
 *
 * Pure function — caller pre-fetches the Redis state and threads it in.
 * Returns either a `target` (eligible) or a `skip` reason.
 */
export function classifyAlert(
  alert: RawAlert,
  state: {
    /** Per-pattern last-fired timestamps (from Redis). */
    patternLastFired: Record<string, string | null>;
    /** Per-category last-walked timestamps (calendar-walk + alert use the same key). */
    categoryLastWalked: Record<string, string | null>;
    /** Categories ALREADY scheduled in this batch (for coalescing). */
    alreadyScheduled: Set<string>;
    /** Cursor — alerts older than this were already processed. */
    cursorIso: string | null;
    now: Date;
  },
): { target: AlertDispatchTarget } | { skip: AlertSkipRecord } {
  const alertId = alert.id || "";
  const alertTs = alert.timestamp || "";

  // Drop malformed entries up front — better than carrying empty strings
  // into the dedup keys.
  if (!alert.type || !alertId || !alertTs) {
    return {
      skip: {
        pattern: "",
        category: null,
        alertId,
        alertTimestamp: alertTs,
        reason: "malformed",
      },
    };
  }

  // Cursor check — alerts older than the cursor were already processed.
  if (state.cursorIso) {
    const cursorMs = Date.parse(state.cursorIso);
    const alertMs = Date.parse(alertTs);
    if (Number.isFinite(cursorMs) && Number.isFinite(alertMs) && alertMs <= cursorMs) {
      return {
        skip: {
          pattern: stripPatternPrefix(alert.type),
          category: null,
          alertId,
          alertTimestamp: alertTs,
          reason: "before-cursor",
        },
      };
    }
  }

  // Dismissed alerts don't drive new work.
  if (alert.dismissed === true) {
    return {
      skip: {
        pattern: stripPatternPrefix(alert.type),
        category: null,
        alertId,
        alertTimestamp: alertTs,
        reason: "dismissed",
      },
    };
  }

  const pattern = stripPatternPrefix(alert.type);
  const categories = categoriesForPattern(pattern);
  if (categories.length === 0) {
    return {
      skip: {
        pattern,
        category: null,
        alertId,
        alertTimestamp: alertTs,
        reason: "unmapped-pattern",
      },
    };
  }

  // Per-pattern dedup (24h).
  const patternLast = state.patternLastFired[pattern] ?? null;
  if (!isCooledDownHours(patternLast, ALERT_PER_PATTERN_COOLDOWN_HOURS, state.now)) {
    return {
      skip: {
        pattern,
        category: categories[0] ?? null,
        alertId,
        alertTimestamp: alertTs,
        reason: "pattern-cooldown",
      },
    };
  }

  // Walk categories in declared order — first one that survives cooldown
  // + coalescing wins. (Most patterns map to a single category anyway.)
  for (const category of categories) {
    if (state.alreadyScheduled.has(category)) {
      return {
        skip: {
          pattern,
          category,
          alertId,
          alertTimestamp: alertTs,
          reason: "coalesced",
        },
      };
    }
    const categoryLast = state.categoryLastWalked[category] ?? null;
    if (!isCooledDownHours(categoryLast, ALERT_PER_CATEGORY_COOLDOWN_HOURS, state.now)) {
      // Don't return immediately — maybe a *later* category in the list
      // is still cooled down. But our starter map has 1 category per
      // pattern, so this loop almost always exits on the first iteration.
      continue;
    }
    return {
      target: {
        pattern,
        category,
        alertId,
        alertTimestamp: alertTs,
        reason: alert.message || `pattern ${pattern}`,
      },
    };
  }

  // Every mapped category was cooled out.
  return {
    skip: {
      pattern,
      category: categories[0] ?? null,
      alertId,
      alertTimestamp: alertTs,
      reason: "category-cooldown",
    },
  };
}

// ---------------------------------------------------------------------------
// Redis-touching: planning step
// ---------------------------------------------------------------------------

/**
 * Read recent alerts + cooldown state from Redis and return the planning
 * result. Doesn't dispatch anything — the caller (autopilot decide.py via
 * collect-state.sh, or the dev exerciser) decides whether to act on
 * `eligible`.
 *
 * `now` is injectable for deterministic tests.
 */
export async function planAlertDispatches(
  now: Date = new Date(),
): Promise<AlertPlan> {
  // 1. Read the cursor (high-water-mark over the alert list).
  const cursorIso = await getScoutAlertCursor();

  // 2. Read the most recent ALERT_SCAN_BATCH alerts. The list is LPUSH-ed
  //    (newest at index 0).
  const rawAlerts = await readRecentAlerts(ALERT_SCAN_BATCH);

  // Parse + drop unparseable entries.
  const parsed: RawAlert[] = [];
  for (const raw of rawAlerts) {
    try {
      const a = JSON.parse(raw);
      if (a && typeof a === "object") parsed.push(a as RawAlert);
    } catch (err) {
      // Log + continue — a corrupt entry shouldn't poison the whole tick.
      console.error("alert-listener: failed to parse alert:", err);
    }
  }

  // Iterate OLDEST-to-NEWEST so per-pattern dedup uses arrival order (the
  // first alert wins, later duplicates are debounced).
  parsed.reverse();

  // 3. Batch-load per-pattern + per-category state. Distinct patterns and
  //    categories present in this batch only — keeps the round-trips bounded.
  const distinctPatterns = new Set<string>();
  const distinctCategories = new Set<string>();
  for (const a of parsed) {
    const p = stripPatternPrefix(a.type ?? "");
    if (!p) continue;
    distinctPatterns.add(p);
    for (const c of categoriesForPattern(p)) distinctCategories.add(c);
  }

  const patternLastFired: Record<string, string | null> = {};
  for (const p of distinctPatterns) {
    patternLastFired[p] = await getScoutPatternLastFired(p);
  }

  const categoryLastWalked: Record<string, string | null> = {};
  for (const c of distinctCategories) {
    categoryLastWalked[c] = await getScoutCategoryLastWalked(c);
  }

  // 4. Classify each alert.
  const eligible: AlertDispatchTarget[] = [];
  const skipped: AlertSkipRecord[] = [];
  const scheduled = new Set<string>();
  let newest: string | null = null;

  for (const alert of parsed) {
    if (alert.timestamp && (!newest || alert.timestamp > newest)) {
      newest = alert.timestamp;
    }
    const result = classifyAlert(alert, {
      patternLastFired,
      categoryLastWalked,
      alreadyScheduled: scheduled,
      cursorIso,
      now,
    });
    if ("target" in result) {
      eligible.push(result.target);
      scheduled.add(result.target.category);
    } else {
      skipped.push(result.skip);
    }
  }

  return {
    eligible,
    skipped,
    newestTimestamp: newest,
    computedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Redis-touching: post-dispatch bookkeeping
// ---------------------------------------------------------------------------

/**
 * After the caller successfully dispatches a scout for an
 * `AlertDispatchTarget`, call this to:
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
  target: AlertDispatchTarget,
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

/**
 * Record a calendar-driven dispatch in the audit stream. Used by Phase B's
 * calendar walk caller so the audit trail covers BOTH triggers from one
 * source. Doesn't touch the dedup/cooldown keys — calendar walk owns its
 * own stamps via `stampClassWalk` / `stampCategoryWalk`.
 */
export async function recordCalendarDispatch(
  category: string,
  outcome: "filed" | "dropped" | "error",
  detail: string,
  now: Date = new Date(),
  cost: number | null = null,
): Promise<void> {
  await xaddDispatchAudit({
    triggeredBy: "calendar",
    category,
    dispatchedAt: now.toISOString(),
    cost,
    outcome,
    detail,
  });
}

/**
 * Advance the alert cursor to `iso`. Caller (typically the autopilot) does
 * this once at the end of the planning tick, AFTER all dispatches have
 * been recorded — so a crash mid-tick re-processes the same alerts on the
 * next tick rather than silently dropping them.
 */
export async function advanceAlertCursor(iso: string): Promise<void> {
  if (!iso || typeof iso !== "string") {
    throw new TypeError("advanceAlertCursor: iso required");
  }
  await setScoutAlertCursor(iso);
}

/** Read the current cursor. Diagnostic helper. */
export async function getAlertCursor(): Promise<string | null> {
  return getScoutAlertCursor();
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
