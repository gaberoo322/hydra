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
 * The aggregation lens is PURE (exported for tests, no Redis): it folds a list
 * of records into escalation/block counts, per-class + per-trigger breakdowns,
 * a post-escalation merge/success rate, and an estimated token cost delta. The
 * cost delta is estimated from a static per-model-tier token budget because the
 * exact realised cost is not known at the decision point the event is emitted.
 */

import { boundedJsonList } from "./bounded-list.ts";

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
 * Static per-model-tier token-budget estimate used to derive the cost delta of
 * a cascade escalation. The exact realised cost is not known when decide.py
 * emits the event (the escalated dispatch has not run yet), so the delta is a
 * PRINCIPLED ESTIMATE: `budget(to_model) - budget(from_model)` — the extra token
 * ceiling a cheap→strong escalation opts into. The relative ordering, not the
 * absolute number, is what makes "is cascading paying off?" answerable. Values
 * are order-of-magnitude session token budgets, deliberately coarse.
 */
export const MODEL_TIER_TOKEN_ESTIMATE: Record<string, number> = {
  haiku: 200_000,
  sonnet: 1_000_000,
  opus: 2_000_000,
};

/** Look up a model tier's token estimate; unknown tiers fall back to 0 (honest unknown). */
export function modelTierTokens(model: string | null | undefined): number {
  if (!model) return 0;
  return MODEL_TIER_TOKEN_ESTIMATE[String(model).toLowerCase()] ?? 0;
}

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
   * Estimated total token cost delta of the realised escalations:
   * Σ (tokens(toModel) − tokens(fromModel)) over escalation records. The extra
   * token ceiling cascading opted into — the raw material for "cost per cascade".
   */
  estimatedCostDelta: number;
  /** Estimated per-escalation average cost delta (0 when no escalations). */
  avgCostDeltaPerEscalation: number;
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
 * Fold a list of cascade records into a rollup with derived rates. PURE — no
 * Redis. Rates are 0 (never NaN) when their denominator is 0. Exported for tests.
 */
export function rollupCascadeTelemetry(records: CascadeRecord[]): CascadeTelemetryRollup {
  let escalations = 0;
  let blocked = 0;
  let estimatedCostDelta = 0;
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
    const delta = modelTierTokens(rec.toModel) - modelTierTokens(rec.fromModel);
    if (Number.isFinite(delta)) estimatedCostDelta += delta;
  }

  const decisions = escalations + blocked;
  const gateBlockRate = decisions > 0 ? Math.round((blocked / decisions) * 1000) / 1000 : 0;
  const avgCostDeltaPerEscalation =
    escalations > 0 ? Math.round(estimatedCostDelta / escalations) : 0;

  return {
    sampleSize: records.length,
    escalations,
    blocked,
    gateBlockRate,
    byClass,
    byTrigger,
    estimatedCostDelta,
    avgCostDeltaPerEscalation,
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
 * Read the most recent `limit` cascade records (newest-first) folded into a
 * rollup. `limit` defaults to the full ring and is clamped to >= 1. Never
 * throws for a corrupt entry — the bounded-list read skips unparseable rows.
 */
export async function getCascadeTelemetry(
  limit: number = CASCADE_TELEMETRY_MAX,
): Promise<CascadeTelemetryRollup> {
  const records = await cascadeLedger().read(Math.max(1, Math.floor(limit)));
  return rollupCascadeTelemetry(records);
}

/** Delete the entire cascade ring (test cleanup). */
export async function clearCascadeTelemetry(): Promise<void> {
  await cascadeLedger().clear();
}
