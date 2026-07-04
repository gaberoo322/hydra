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
 * This module is the *Redis-cursor coordinator* half of the failure-driven
 * trigger. The *pure alert-classification policy* half — the pattern→category
 * map, the pure per-alert disposition function `classifyAlert`, the pure
 * lookups/predicates, and the `RawAlert` / `AlertDispatchTarget` /
 * `AlertSkipRecord` types — lives in the zero-IO leaf `./alert-classifier.ts`
 * (issue #2785). This coordinator imports that policy and fans it out over a
 * batch of Redis-fetched alerts; the import edge is one-directional
 * (classifier ← listener).
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
 *      `PATTERN_CATEGORY_MAP` (from `./alert-classifier.ts`).
 *   3. Applies three anti-burst gates per candidate (via `classifyAlert`):
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
} from "../redis/scout.ts";
import {
  categoriesForPattern,
  classifyAlert,
  stripPatternPrefix,
  type AlertDispatchTarget,
  type AlertSkipRecord,
  type RawAlert,
} from "./alert-classifier.ts";

// The pure alert-classification policy (PATTERN_CATEGORY_MAP, the cooldown
// constants, classifyAlert, categoriesForPattern, isCooledDownHours,
// stripPatternPrefix, and the RawAlert / AlertDispatchTarget / AlertSkipRecord
// types) was extracted into the zero-IO leaf ./alert-classifier.ts (issue
// #2785). The re-exports below preserve the historical import surface — existing
// callers/tests that import those pure symbols from alert-listener.ts continue
// to resolve during the transition window. New code should import the pure
// policy directly from ./alert-classifier.ts.
export {
  PATTERN_CATEGORY_MAP,
  ALERT_PER_PATTERN_COOLDOWN_HOURS,
  ALERT_PER_CATEGORY_COOLDOWN_HOURS,
  categoriesForPattern,
  classifyAlert,
  isCooledDownHours,
  stripPatternPrefix,
  type AlertDispatchTarget,
  type AlertSkipRecord,
  type RawAlert,
} from "./alert-classifier.ts";

// The dispatch audit stream surface (recordDispatch, listDispatchAudits,
// DispatchAuditEntry, SCOUT_DISPATCHES_MAXLEN) lives in the ScoutDispatchAudit
// module (./dispatch-audit.ts, issue #1972). All importers now resolve those
// symbols directly from there, so the compatibility re-export bridge that used
// to live here has been dropped (issue #2002).

// ---------------------------------------------------------------------------
// Coordinator-local constants
// ---------------------------------------------------------------------------

/** Bound on the alerts-list scan so we don't iterate the whole list every tick. */
const ALERT_SCAN_BATCH = 100;

// ---------------------------------------------------------------------------
// Coordinator-local types
// ---------------------------------------------------------------------------

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

// NOTE: the post-dispatch audit write (`recordDispatch`) lives in the
// ScoutDispatchAudit module (`./dispatch-audit.ts`, issue #1972). Call sites
// import it from there directly.

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
