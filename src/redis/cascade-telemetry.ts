/**
 * Cascade-routing telemetry Redis seam (issue #3284).
 *
 * PR #3274 shipped cascade-routing escalation: `decide.py`'s `_rule_escalation`
 * re-dispatches a cheap-tier class (Haiku `cleanup_orch`) at a stronger model
 * (Sonnet) when the same-turn stop-status verifier reports a no_op/failure, and
 * suppresses that escalation wholesale under the Subscription-Usage-Tracker hard
 * stop (`usageDispatchBlocked`). But the feature shipped BLIND: nothing measured
 * whether cascading actually triggered, how often the usage gate throttled it, or
 * what cost delta it delivered. Architecture-review rec #6 ("cascade routing with
 * a deterministic verifier as the escalation trigger") stayed unverifiable.
 *
 * decide.py now emits two observability events on every routing decision
 * (issue #3284):
 *   - `cascade_routing_escalation` — a realised escalation re-dispatch fired.
 *   - `cascade_routing_blocked`    — an OTHERWISE-eligible escalation the usage
 *                                    hard stop threw away.
 * Both ride `hydra:autopilot:slot-events` alongside the other decide.py turn
 * events. This seam gives those events a durable, bounded home so the metrics
 * surface can answer "how often does cascading trigger / get throttled, and what
 * is the token cost delta?" across restarts — the ephemeral slot-events stream
 * (MAXLEN ~1000, `$`-anchored bridge) is a live animation feed, not a 50-cycle
 * aggregate.
 *
 * Storage: a single bounded-JSON-list ring (ADR-0017 Category C, the shared
 * `boundedJsonList` primitive) of the most recent N cascade records, newest
 * first. The slot-events bridge appends each cascade event as a record
 * (best-effort — a telemetry write must never break the bridge it rides).
 *
 * TWO data planes feed the rollup, joined at read time:
 *   1. This bounded ring of decision-time cascade events (escalation / blocked)
 *      — the source for escalation/block COUNTS, the gate-block rate, and the
 *      per-class + per-trigger breakdowns. These are knowable at the decision
 *      point (before the escalated attempt runs).
 *   2. The durable per-dispatch outcome plane (`DispatchOutcomeRecord`, #2942)
 *      — the source for the token COST-DELTA and the post-escalation MERGE RATE.
 *      An escalated dispatch, when it later reaps, writes its ACTUAL token spend
 *      and its terminal outcome (completed/merged/failed) onto its outcome
 *      record, tagged with `escalationAttempt`/`escalatedModel`. The endpoint
 *      sums those ACTUAL tokens (the authoritative ADR-0016 token plane) rather
 *      than re-estimating a Haiku-vs-Sonnet budget — design-concept invariant 7
 *      explicitly rejects a second, drift-prone estimator.
 *
 * The count-fold (`rollupCascadeTelemetry`) is PURE (exported for tests, no
 * Redis). The token/merge fold (`rollupEscalationOutcomes`) is likewise PURE
 * over a list of dispatch-outcome records. `getCascadeTelemetry` reads both
 * planes and merges them.
 */

import { boundedJsonList } from "./bounded-list.ts";
import { listDispatchOutcomes } from "./dispatch-outcomes.ts";
import type { DispatchOutcomeRecord } from "./dispatch-outcomes.ts";
import { bucketCycleStatus } from "../autopilot/cycle-status.ts";

/**
 * Cap on retained cascade records. Escalations are rare (a cheap-tier no_op /
 * failure on an idle board), so a few hundred rows comfortably covers the last
 * 50-cycle window the metrics card renders, with headroom. Env-overridable via
 * `HYDRA_CASCADE_TELEMETRY_MAX` for a longer dwell.
 */
export const CASCADE_TELEMETRY_MAX = (() => {
  const raw = Number(process.env.HYDRA_CASCADE_TELEMETRY_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
})();

/**
 * Rolling window (ms) over which escalated dispatch OUTCOMES are read for the
 * cost-delta + post-escalation merge-rate fold. 14 days matches the
 * dispatch-outcome record TTL (`DISPATCH_OUTCOME_TTL_SECONDS`), so the window
 * never asks for records the plane has already reaped. Env-overridable via
 * `HYDRA_CASCADE_OUTCOME_WINDOW_MS`.
 */
export const CASCADE_OUTCOME_WINDOW_MS = (() => {
  const raw = Number(process.env.HYDRA_CASCADE_OUTCOME_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 14 * 24 * 3600 * 1000;
})();

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

/** The single capped-list key holding the cascade-telemetry ring. */
function cascadeTelemetryKey(): string {
  return "hydra:autopilot:cascade-telemetry:ledger";
}

/** The shared bounded-JSON-list handle for the cascade ring (ADR-0017 Category C). */
function cascadeLedger() {
  return boundedJsonList<CascadeRecord>(cascadeTelemetryKey(), CASCADE_TELEMETRY_MAX);
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
 * marker) participate; every other outcome record is ignored. Exported for
 * tests.
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
 * still meaningful before any escalated dispatch has reaped). Exported for tests.
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

/**
 * Translate a raw slot-events cascade event (string field/value payload) into a
 * `CascadeRecord`, or `null` when the event is not a cascade event. PURE —
 * exported for the bridge + tests. The two discriminators are
 * `cascade_routing_escalation` and `cascade_routing_blocked`; anything else
 * returns null so the bridge can cheaply skip non-cascade events.
 */
export function cascadeRecordFromEvent(
  fields: Record<string, unknown> | null | undefined,
): CascadeRecord | null {
  if (!fields || typeof fields !== "object") return null;
  const event = String((fields as any).event ?? "");
  if (event === "cascade_routing_escalation") {
    return {
      kind: "escalation",
      cls: String((fields as any).class ?? "unknown"),
      triggerReason: String((fields as any).trigger_reason ?? "unknown"),
      fromModel: String((fields as any).from_model ?? ""),
      toModel: String((fields as any).to_model ?? ""),
      attempt: intOr((fields as any).attempt, 0),
      blockReason: "",
      ts: intOr((fields as any).ts_epoch, 0),
      runId: String((fields as any).run_id ?? ""),
    };
  }
  if (event === "cascade_routing_blocked") {
    return {
      kind: "blocked",
      cls: String((fields as any).class ?? "unknown"),
      triggerReason: String((fields as any).trigger_reason ?? "unknown"),
      fromModel: "",
      toModel: String((fields as any).to_model ?? ""),
      attempt: 0,
      blockReason: String((fields as any).block_reason ?? "unknown"),
      ts: intOr((fields as any).ts_epoch, 0),
      runId: String((fields as any).run_id ?? ""),
    };
  }
  return null;
}

/** Coerce a stringly-typed numeric field to an int, defaulting to `dflt`. */
function intOr(raw: unknown, dflt: number): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/**
 * Append one cascade record to the bounded ring (newest-first, lpush + ltrim).
 * Best-effort: the caller (slot-events bridge) wraps this so a Redis error never
 * breaks the animation broadcast it rides.
 */
export async function recordCascade(rec: CascadeRecord): Promise<void> {
  await cascadeLedger().push(rec);
}

/**
 * Read escalation-tagged dispatch-outcome records over the rolling window and
 * fold them into the ACTUAL-token cost delta + post-escalation merge rate.
 * Dark-tolerant: a failed outcome-plane read (`{ok:false}`) yields the empty
 * fold, so the count-only view still renders — never throws (invariant: the
 * cascade endpoint's Redis reads are structured, never a 500).
 */
async function readEscalationOutcomeFold(nowMs: number): Promise<EscalationOutcomeFold> {
  const res = await listDispatchOutcomes({ sinceMs: nowMs - CASCADE_OUTCOME_WINDOW_MS });
  if (!res.ok) return EMPTY_ESCALATION_OUTCOME_FOLD;
  return rollupEscalationOutcomes(res.records);
}

/**
 * Read the most recent `limit` cascade records (newest-first) plus the durable
 * escalated-dispatch outcome plane, folded into a combined rollup. `limit`
 * defaults to the full ring and is clamped to >= 1. Never throws for a corrupt
 * entry — the bounded-list read skips unparseable rows, and a failed
 * outcome-plane read degrades to the count-only view (empty cost/merge fold).
 */
export async function getCascadeTelemetry(
  limit: number = CASCADE_TELEMETRY_MAX,
  nowMs: number = Date.now(),
): Promise<CascadeTelemetryRollup> {
  const [records, outcomeFold] = await Promise.all([
    cascadeLedger().read(Math.max(1, Math.floor(limit))),
    readEscalationOutcomeFold(nowMs),
  ]);
  return rollupCascadeTelemetry(records, outcomeFold);
}

/** Delete the entire cascade ring (test cleanup). */
export async function clearCascadeTelemetry(): Promise<void> {
  await cascadeLedger().clear();
}
