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
 * This file is the I/O seam ONLY: it reads/writes the bounded ring, joins the
 * dispatch-outcome plane, and DELEGATES the numeric fold to the pure aggregator
 * leaf `src/aggregators/cascade-routing.ts` (issue #3638). The count/score folds
 * (`rollupCascadeTelemetry`, `rollupEscalationOutcomes`) and their record/rollup
 * types live in the aggregator and are imported here for internal use by the
 * I/O operations, but NOT re-exported (callers must import from the aggregator).
 */

import { boundedJsonList } from "./bounded-list.ts";
import { listDispatchOutcomes } from "./dispatch-outcomes.ts";
import {
  rollupCascadeTelemetry,
  rollupEscalationOutcomes,
  EMPTY_ESCALATION_OUTCOME_FOLD,
} from "../aggregators/cascade-routing.ts";
import type {
  CascadeRecord,
  CascadeTelemetryRollup,
  EscalationOutcomeFold,
} from "../aggregators/cascade-routing.ts";

// The pure aggregator surface (rollupCascadeTelemetry, rollupEscalationOutcomes,
// EMPTY_ESCALATION_OUTCOME_FOLD) and their types now live in
// src/aggregators/cascade-routing.ts. Callers MUST import them directly from the
// aggregator, not from the redis seam. The redis seam is I/O only.
export type { CascadeRecord, CascadeTelemetryRollup };

/**
 * Cap on retained cascade records. Escalations are rare (a cheap-tier no_op /
 * failure on an idle board), so a few hundred rows comfortably covers the last
 * 50-cycle window the metrics card renders, with headroom. Env-overridable via
 * `HYDRA_CASCADE_TELEMETRY_MAX` for a longer dwell.
 */
const CASCADE_TELEMETRY_MAX = (() => {
  const raw = Number(process.env.HYDRA_CASCADE_TELEMETRY_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
})();

/**
 * Rolling window (ms) over which escalated dispatch OUTCOMES are read for the
 * cost-delta + post-escalation merge-rate fold. 14 days. This MUST stay `<=`
 * the dispatch-outcome record TTL (`DISPATCH_OUTCOME_TTL_SECONDS`, now 90d per
 * issue #3962), so the window never asks for records the plane has already
 * reaped — the invariant is window ≤ TTL, NOT equality: the TTL was widened to
 * 90d in #3962 while this window deliberately stayed at 14d (widening it would
 * change cascade's cost-delta/merge-rate fold semantics and is out of scope).
 * Env-overridable via `HYDRA_CASCADE_OUTCOME_WINDOW_MS`.
 */
const CASCADE_OUTCOME_WINDOW_MS = (() => {
  const raw = Number(process.env.HYDRA_CASCADE_OUTCOME_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 14 * 24 * 3600 * 1000;
})();

/** The single capped-list key holding the cascade-telemetry ring. */
function cascadeTelemetryKey(): string {
  return "hydra:autopilot:cascade-telemetry:ledger";
}

/** The shared bounded-JSON-list handle for the cascade ring (ADR-0017 Category C). */
function cascadeLedger() {
  return boundedJsonList<CascadeRecord>(cascadeTelemetryKey(), CASCADE_TELEMETRY_MAX);
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
