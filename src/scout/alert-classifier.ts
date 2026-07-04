/**
 * scout/alert-classifier.ts — pure alert-classification policy leaf
 *
 * Extracted from alert-listener.ts (issue #2785). This module owns the *policy*
 * half of the failure-driven scout trigger — the pattern→category map, the pure
 * cooldown predicate, the pure lookups, and the pure per-alert disposition
 * function `classifyAlert` — separated from the Redis-cursor *coordinator*
 * (`planAlertDispatches`, `advanceAlertCursor`, `getAlertCursor`, and the
 * `../redis/*` reads/writes behind them), which stays in alert-listener.ts.
 *
 * Why the split: `classifyAlert` is a pure function of a pre-fetched `state`
 * bag — it takes that bag as an argument precisely so the decision is decoupled
 * from the I/O fetch. A caller that only needs the classification policy (a
 * direct unit test of the 7 skip/target branches, an eval, a simulate-dispatch
 * script) no longer pulls in `readRecentAlerts`, `getScoutAlertCursor`,
 * `getScoutCategoryLastWalked`, etc. — the entire Redis seam — at module-load
 * time. This mirrors the cue-policy.ts / escalation.ts split (issue #2569):
 * pure logic in a zero-IO leaf, Redis-or-IO work in the caller. The parallel is
 * exact — `classifyAlert` : `planAlertDispatches` ≈ `canonicalizeCue` /
 * `shouldEscalateAtHitCount` : `escalateIfNeeded`.
 *
 * A leaf module: no Redis, no filesystem, no async, and — crucially — NO import
 * of `../redis/*`. Import direction is one-way — alert-listener.ts imports from
 * here; this module imports from no scout sibling.
 */

// ---------------------------------------------------------------------------
// Pattern → category map (starter, per issue #486 body)
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
