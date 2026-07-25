/**
 * Cascade-routing pure aggregator leaf (issue #3638).
 *
 * The count-and-score folds for cascade-routing telemetry (issue #3284). These
 * are PURE domain logic — they consume already-read scalars (decision-time
 * `CascadeRecord`s and durable `DispatchOutcomeRecord`s) and produce a numeric
 * rollup. They were extracted out of the `src/redis/cascade-telemetry.ts` Redis
 * adapter, which now owns only the I/O seam (the bounded ring read/write and the
 * dispatch-outcome plane join) and delegates the fold to this leaf.
 *
 * TWO data planes feed the rollup, joined at read time in the redis adapter:
 *   1. A bounded ring of decision-time cascade events (escalation / blocked)
 *      — the source for escalation/block COUNTS, the gate-block rate, and the
 *      per-class + per-trigger breakdowns. Folded by `rollupCascadeTelemetry`.
 *   2. The durable per-dispatch outcome plane (`DispatchOutcomeRecord`, #2942)
 *      — the source for the token COST-DELTA and the post-escalation MERGE RATE.
 *      Folded by `rollupEscalationOutcomes`.
 *
 * Only the `DispatchOutcomeRecord` TYPE is imported from the redis seam here (a
 * type-only import, the same shape `src/autopilot/class-stats-math.ts` and
 * siblings use) — no I/O function is pulled in, so a test that asserts count
 * behaviour imports zero Redis runtime surface.
 */

import type { DispatchOutcomeRecord } from "../redis/dispatch-outcomes.ts";
import { bucketCycleStatus } from "../autopilot/cycle-status.ts";

/**
 * One recorded cascade routing decision (issue #3284). Written once per
 * `cascade_routing_escalation` / `cascade_routing_blocked` event the slot-events
 * bridge observes. Every field is derived from the event's string payload.
 *
 * - `kind`          — "escalation" (fired) | "blocked" (usage-gate suppressed).
 * - `cls`           — the dispatch class that escalated / would have escalated.
 * - `triggerReason` — the stop-status→pattern that drove it (`subagent_noop` /
 *                     `subagent_failure`).
 * - `fromModel`     — cheap tier the class ran at (escalation only; "" for blocked).
 * - `toModel`       — strong tier it escalated to / would have escalated to.
 * - `attempt`       — the escalated attempt number (escalation only; 0 for blocked).
 * - `blockReason`   — the gate verdict (blocked only; "" for escalation).
 * - `ts`            — epoch seconds the decision was made (from the event ts_epoch).
 * - `runId`         — the autopilot run the decision belonged to (for scoping).
 */
export interface CascadeRecord {
  kind: "escalation" | "blocked";
  cls: string;
  triggerReason: string;
  fromModel: string;
  toModel: string;
  attempt: number;
  blockReason: string;
  ts: number;
  runId: string;
}

/** Aggregate rollup over a window of cascade records (issue #3284). */
export interface CascadeTelemetryRollup {
  /** Records folded (the window size actually read). */
  sampleSize: number;
  /** Realised escalation re-dispatches. */
  escalations: number;
  /** Usage-gate-suppressed would-be escalations. */
  blocked: number;
  /**
   * Fraction of routing decisions the gate threw away:
   * blocked / (escalations + blocked). 0 when there were no decisions.
   */
  gateBlockRate: number;
  /** Per-class escalation counts, newest-first insertion order not guaranteed. */
  byClass: Record<string, { escalations: number; blocked: number }>;
  /** Per-trigger-reason escalation counts (subagent_noop / subagent_failure / …). */
  byTrigger: Record<string, number>;
  /**
   * Realised token cost delta of the escalations, derived from the ACTUAL
   * per-dispatch tokens recorded on the escalated dispatch's DispatchOutcomeRecord
   * (#2942) — the authoritative ADR-0016 token plane, NOT a re-estimated
   * per-model budget (design-concept invariant 7). Σ tokens over the escalated
   * dispatches whose outcome records fell in the read window. 0 when no escalated
   * dispatch has reaped a token figure yet.
   */
  costDeltaTokens: number;
  /**
   * Escalated dispatches whose ACTUAL tokens were summed into `costDeltaTokens`
   * (i.e. escalation-tagged outcome records with a non-null `tokens`). The
   * denominator for a meaningful per-escalation average; also the honest
   * "how many escalations have we actually measured the cost of?" figure, which
   * lags the decision-time `escalations` count until the escalated attempts reap.
   */
  measuredEscalations: number;
  /** Mean measured token cost per escalated dispatch (0 when none measured). */
  avgCostDeltaPerEscalation: number;
  /**
   * Post-escalation MERGE RATE (design-concept invariant 8): the fraction of
   * TERMINAL escalated dispatches whose outcome bucketed as `merged`
   * (merged/completed/succeeded). The endpoint REPORTS this — it is the
   * measurement of the issue's ">85% escalation-triggered cycles still merge"
   * success criterion, NOT a gate. 0 when no escalated dispatch has reached a
   * terminal (merged|failed) outcome yet.
   */
  postEscalationMergeRate: number;
  /**
   * Escalated dispatches that reached a TERMINAL outcome (merged or failed) —
   * the denominator of `postEscalationMergeRate`. Escalations still in flight
   * (an `unaccounted`/in-progress outcome) are excluded so the rate is not
   * diluted by not-yet-settled attempts.
   */
  terminalEscalations: number;
}

/**
 * Cost-delta + post-escalation merge-rate folded from the durable per-dispatch
 * outcome plane (issue #2942). The cross-plane join surface the rollup mixes in.
 */
export interface EscalationOutcomeFold {
  costDeltaTokens: number;
  measuredEscalations: number;
  avgCostDeltaPerEscalation: number;
  postEscalationMergeRate: number;
  terminalEscalations: number;
}

/** A zero fold — the honest "no escalated dispatch has reaped yet" default. */
export const EMPTY_ESCALATION_OUTCOME_FOLD: EscalationOutcomeFold = {
  costDeltaTokens: 0,
  measuredEscalations: 0,
  avgCostDeltaPerEscalation: 0,
  postEscalationMergeRate: 0,
  terminalEscalations: 0,
};

/**
 * Fold escalation-tagged dispatch-outcome records into the ACTUAL token cost
 * delta + post-escalation merge rate. PURE — no Redis. Only records with a
 * non-null `escalationAttempt` (the "this dispatch WAS a cascade escalation"
 * marker) participate; every other outcome record is ignored.
 *
 * - `costDeltaTokens` sums the ACTUAL recorded `tokens` of those escalated
 *   dispatches (design-concept invariant 7 — authoritative token plane, no
 *   static re-estimate). A null-tokens escalation record contributes to neither
 *   the sum nor `measuredEscalations` (truthful "cost unknown", never a 0).
 * - `postEscalationMergeRate` = merged / (merged + failed) over escalated
 *   dispatches that reached a TERMINAL outcome (invariant 8). In-flight
 *   escalations (unaccounted/unknown status) are excluded from the denominator
 *   so a not-yet-settled attempt never dilutes the rate.
 */
export function rollupEscalationOutcomes(
  records: readonly DispatchOutcomeRecord[],
): EscalationOutcomeFold {
  let costDeltaTokens = 0;
  let measuredEscalations = 0;
  let merged = 0;
  let terminalEscalations = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.escalationAttempt === null || rec.escalationAttempt === undefined) continue;
    if (typeof rec.tokens === "number" && Number.isFinite(rec.tokens)) {
      costDeltaTokens += rec.tokens;
      measuredEscalations += 1;
    }
    const bucket = bucketCycleStatus(rec.outcome);
    if (bucket === "merged") {
      merged += 1;
      terminalEscalations += 1;
    } else if (bucket === "failed") {
      terminalEscalations += 1;
    }
  }

  const avgCostDeltaPerEscalation =
    measuredEscalations > 0 ? Math.round(costDeltaTokens / measuredEscalations) : 0;
  const postEscalationMergeRate =
    terminalEscalations > 0 ? Math.round((merged / terminalEscalations) * 1000) / 1000 : 0;

  return {
    costDeltaTokens,
    measuredEscalations,
    avgCostDeltaPerEscalation,
    postEscalationMergeRate,
    terminalEscalations,
  };
}

/**
 * Fold a list of decision-time cascade records into a rollup. PURE — no Redis.
 * Rates are 0 (never NaN) when their denominator is 0. The cost-delta + merge-
 * rate arm derives from the ACTUAL dispatch-outcome token/status plane (#2942),
 * passed in as `outcomeFold` (default: an empty fold, so the count-only view is
 * still meaningful before any escalated dispatch has reaped).
 */
export function rollupCascadeTelemetry(
  records: CascadeRecord[],
  outcomeFold: EscalationOutcomeFold = EMPTY_ESCALATION_OUTCOME_FOLD,
): CascadeTelemetryRollup {
  let escalations = 0;
  let blocked = 0;
  const byClass: Record<string, { escalations: number; blocked: number }> = {};
  const byTrigger: Record<string, number> = {};

  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const cls = String(rec.cls || "unknown");
    const bucket = byClass[cls] ?? (byClass[cls] = { escalations: 0, blocked: 0 });
    if (rec.kind === "blocked") {
      blocked += 1;
      bucket.blocked += 1;
      continue;
    }
    // Treat anything that is not an explicit "blocked" as a realised escalation
    // (the ledger only ever holds the two kinds; default-to-escalation is safe).
    escalations += 1;
    bucket.escalations += 1;
    const trigger = String(rec.triggerReason || "unknown");
    byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
  }

  const decisions = escalations + blocked;
  const gateBlockRate = decisions > 0 ? Math.round((blocked / decisions) * 1000) / 1000 : 0;

  return {
    sampleSize: records.length,
    escalations,
    blocked,
    gateBlockRate,
    byClass,
    byTrigger,
    costDeltaTokens: outcomeFold.costDeltaTokens,
    measuredEscalations: outcomeFold.measuredEscalations,
    avgCostDeltaPerEscalation: outcomeFold.avgCostDeltaPerEscalation,
    postEscalationMergeRate: outcomeFold.postEscalationMergeRate,
    terminalEscalations: outcomeFold.terminalEscalations,
  };
}
