/**
 * cost-cap.ts — Per-cycle cost cap circuit breaker (issue #209, #286)
 *
 * Bug: There was no per-cycle cost cap on the build loop. Abandoned cycles
 * could consume up to $56 each before hitting their abandonment gate
 * (Preflight, Auto-decompose, Planner noWork). With ~31 abandoned cycles
 * in 50, this was the dominant cost-leak class.
 *
 * Issue #286: Even with the inter-step `runCostCapCheck` gate, a *single*
 * planner call can stream past the cap (one observed cycle burned $60+ in
 * one shot). The cap previously fired only AFTER the call completed, so
 * the spend was already gone. This module now exposes `StreamingBudget`,
 * a mid-stream projector wired into `codex-runner.runAgent` that aborts
 * the SDK call once projected total cost exceeds the cap.
 *
 * Fix: Track accumulated agent cost per cycle (via the existing
 * `costMicrodollars` Redis field that `task-tracker.logAgentRun` already
 * maintains). After every agent invocation in `control-loop.ts`, check if
 * the cumulative spend has exceeded `HYDRA_PER_CYCLE_COST_CAP_USD`
 * (default $25). If so, abandon the cycle with reason
 * `Cost cap exceeded: $X.XX >= $Y` so it shows up as a distinct
 * abandonment category in `/api/metrics/abandonment`.
 *
 * Design notes
 * ------------
 * - This module is environment-driven and side-effect-free aside from
 *   reading from Redis. The check is cheap (one HGET).
 * - The abort happens BEFORE the executor — the most expensive call —
 *   if the planner + preflight already burned through the budget. This
 *   is the bail-out that saves the most money.
 * - We still record cycle metrics on abort so we keep observability
 *   into how much each abort cost.
 * - Honors `Infinity` semantics consistent with `HYDRA_DAILY_COST_CAP_USD`:
 *   absent or non-finite env value → cap is `Infinity` (effectively off).
 * - Mid-stream projection (issue #286) uses a conservative chars/token
 *   ratio of 4 (≈OpenAI tokenizer average for English prose + JSON). The
 *   estimate is intentionally an OVER-estimate so we trip slightly early
 *   rather than slightly late: better to abandon a marginally-under-cap
 *   cycle than to bleed past it.
 */

import { getCycleCostMicrodollars } from "./redis-adapter.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { recordOutcome } from "./learning.ts";
import { getTracker } from "./task-tracker.ts";
import { STREAMS } from "./event-bus.ts";
import { handleEarlyExit } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";
import { getCycleSubagentCostUsd } from "./cost-surrogate.ts";

/**
 * Stable abandonment reason prefix. Tests assert on this; do NOT change
 * without bumping the reason category in `metrics.ts` consumers.
 */
export const COST_CAP_REASON_PREFIX = "Cost cap exceeded";

/**
 * Resolve the per-cycle cost cap from env. Returns Infinity if unset
 * or non-finite (matches `DAILY_COST_CAP_USD` semantics).
 *
 * Pure function — re-reads env each call so tests can mutate and
 * production callers see config-reload changes (e.g. via systemd
 * `EnvironmentFile=` reload + service restart).
 */
export function getPerCycleCostCapUsd(): number {
  const raw = process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
  if (raw === undefined || raw === "") {
    return 25; // default $25
  }
  // Allow operators to disable via "Infinity" or "0" (treat 0 as off too).
  if (raw === "Infinity" || raw === "infinity") return Infinity;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return Infinity;
  return parsed;
}

/**
 * Read the current accumulated cost (in USD) for the given cycle.
 * Returns 0 if the cycle has no recorded spend yet (e.g. fresh cycle
 * before the first agent run, or Redis read fails — fail-open since
 * the cap is a safety net, not a correctness guarantee).
 */
export async function getCycleCostUsd(cycleId: string): Promise<number> {
  try {
    const micro = await getCycleCostMicrodollars(cycleId);
    if (!micro) return 0;
    const parsed = parseInt(micro);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed / 1_000_000;
  } catch (err: any) {
    console.error(`[CostCap] Failed to read cycle cost for ${cycleId}: ${err.message}`);
    return 0;
  }
}

export interface CostCapStatus {
  /** Current accumulated spend for the cycle. */
  costUsd: number;
  /** Configured cap (Infinity if disabled). */
  capUsd: number;
  /** True if accumulated cost has met or exceeded the cap. */
  exceeded: boolean;
  /** Human-readable abandonment reason (only meaningful when `exceeded`). */
  reason: string;
  /** Issue #394: which writers contributed to costUsd. `"codex-recorded"`
   *  means only the legacy codex `costMicrodollars` path is active;
   *  `"autopilot-surrogate"` means only post-cut subagent tokens contributed;
   *  `"mixed"` means both. Allows operators to tell whether a cap trip
   *  was caused by surrogate-only inflation. */
  source?: "codex-recorded" | "autopilot-surrogate" | "mixed" | "none";
  /** Surrogate-only USD contribution (subset of costUsd). */
  surrogateUsd?: number;
}

/**
 * Read the cycle's combined spend — legacy codex `costMicrodollars` PLUS
 * the post-cut subagent-token surrogate (issue #394).
 *
 * Codex was removed in PR-3 (issue #383). The legacy field will be 0 in
 * any post-cut cycle; the surrogate is the only spend signal left for
 * cap purposes. The legacy reader is preserved so historical pre-cut
 * cycles, and any cross-over period, still report correctly.
 */
export async function getCycleCostWithSurrogateUsd(cycleId: string): Promise<{
  costUsd: number;
  legacyUsd: number;
  surrogateUsd: number;
  source: "codex-recorded" | "autopilot-surrogate" | "mixed" | "none";
}> {
  const legacyUsd = await getCycleCostUsd(cycleId);
  let surrogateUsd = 0;
  try {
    const surrogate = await getCycleSubagentCostUsd(cycleId);
    surrogateUsd = surrogate.costUsd;
  } catch (err: any) {
    console.error(`[CostCap] surrogate read failed for ${cycleId}: ${err?.message || err}`);
  }
  const total = legacyUsd + surrogateUsd;
  let source: "codex-recorded" | "autopilot-surrogate" | "mixed" | "none";
  if (legacyUsd > 0 && surrogateUsd > 0) source = "mixed";
  else if (surrogateUsd > 0) source = "autopilot-surrogate";
  else if (legacyUsd > 0) source = "codex-recorded";
  else source = "none";
  return { costUsd: total, legacyUsd, surrogateUsd, source };
}

/**
 * Check whether the cycle has exceeded its cost cap.
 *
 * Returns the current cost, configured cap, and a stable reason string
 * suitable for use as `abandonReason` in cycle metrics. The reason
 * always begins with `COST_CAP_REASON_PREFIX` so the abandonment-metrics
 * categorizer buckets it consistently.
 */
export async function checkCostCap(cycleId: string): Promise<CostCapStatus> {
  const capUsd = getPerCycleCostCapUsd();
  // Issue #394: cap now considers BOTH the legacy codex per-cycle cost
  // (read from `costMicrodollars`) AND the post-cut subagent surrogate
  // (`hydra:metrics:tokens:by-cycle:<id>`). Pre-cut cycles still report
  // identical numbers because the surrogate is zero unless tokens were
  // recorded. Post-cut cycles see the surrogate where they used to see 0.
  const { costUsd, surrogateUsd, source } = await getCycleCostWithSurrogateUsd(cycleId);
  const exceeded = Number.isFinite(capUsd) && costUsd >= capUsd;
  const capStr = Number.isFinite(capUsd) ? `$${capUsd.toFixed(2)}` : "Infinity";
  const reason = exceeded
    ? `${COST_CAP_REASON_PREFIX}: $${costUsd.toFixed(2)} >= ${capStr}`
    : `${COST_CAP_REASON_PREFIX}: under cap ($${costUsd.toFixed(2)} < ${capStr})`;
  return { costUsd, capUsd, exceeded, reason, source, surrogateUsd };
}

/**
 * Pipeline step result mirroring StepResult in pipeline-steps.ts. Kept local
 * to avoid a circular import (cost-cap is imported by control-loop, which
 * orchestrates pipeline-steps).
 */
export type CostCapStepResult =
  | { continue: true; status: CostCapStatus }
  | { continue: false; result: any; status: CostCapStatus };

/**
 * Pipeline step: check cumulative cost against the cap. If under the cap,
 * returns `continue: true` and the caller proceeds to the next step. If
 * exceeded, this performs the full abandonment-flow side effects:
 *   - mark the task abandoned in the tracker
 *   - publish a `task:cost_cap_exceeded` notification
 *   - record an OV reflection
 *   - report outcome (circuit-breaker accounting)
 *   - record cycle metrics with `abandonReason` starting with
 *     `Cost cap exceeded` so it surfaces in `/api/metrics/abandonment`
 *
 * @param ctx Cycle context shared across pipeline steps.
 * @param task The current task (may be undefined if cap trips between
 *   steps where no task object is available — callers can pass `null`).
 * @param taskId Tracker task id, for marking abandoned.
 * @param checkpoint Short label of where in the pipeline we are
 *   ("post-planner", "post-preflight", "post-executor", etc.) — included
 *   in the reason string for forensic visibility.
 */
export async function runCostCapCheck(
  ctx: CycleContext,
  task: any,
  taskId: string | null,
  checkpoint: string,
): Promise<CostCapStepResult> {
  const status = await checkCostCap(ctx.cycleId);
  if (!status.exceeded) {
    return { continue: true, status };
  }

  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;
  const reason = `${status.reason} (after ${checkpoint})`;
  console.error(`[ControlLoop] COST CAP TRIPPED at ${checkpoint}: ${reason}`);

  // Mark task abandoned in tracker if we have a task id
  if (taskId) {
    try {
      await getTracker().transitionTask(taskId, "abandoned", { costCap: status });
    } catch (err: any) {
      console.error(`[CostCap] Failed to transition task to abandoned: ${err.message}`);
    }
  }

  // Notify so dashboards can show the trip
  try {
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:cost_cap_exceeded",
      source: "control-loop",
      correlationId: cycleId,
      payload: {
        taskId,
        checkpoint,
        costUsd: status.costUsd,
        capUsd: Number.isFinite(status.capUsd) ? status.capUsd : null,
        title: task?.title || anchor?.reference || "(no task)",
      },
    });
  } catch (err: any) {
    console.error(`[CostCap] Failed to publish cost_cap_exceeded event: ${err.message}`);
  }

  // Learning: record reflection so future cycles for this anchor see it.
  try {
    await recordOutcome({
      agents: task ? ["planner"] : [],
      cycleId,
      task: task || { title: `Cost cap tripped: ${anchor?.reference || "unknown"}` },
      finalState: "abandoned",
      anchorRef: anchor?.reference,
      anchorType: anchor?.type,
      reflection: {
        failureMode: "cost-cap",
        whatFailed: `Cycle exceeded per-cycle cost cap at ${checkpoint}`,
        whyItFailed: reason,
        whatToTryDifferently:
          "Anchor likely too expensive — narrow scope, prefer quick-fix routing, or raise HYDRA_PER_CYCLE_COST_CAP_USD if the anchor genuinely needs more budget.",
      },
    });
  } catch (err: any) {
    console.error(`[CostCap] Failed to record outcome: ${err.message}`);
  }

  // Circuit-breaker accounting (so the same anchor doesn't keep tripping)
  try {
    await reportOutcome(anchor, { status: "abandoned", reason, task });
  } catch (err: any) {
    console.error(`[CostCap] Circuit breaker tracking failed: ${err.message}`);
  }

  // Record cycle metrics with the abandonment reason so it shows up under
  // a stable category in /api/metrics/abandonment.
  await handleEarlyExit({
    cycleId,
    startTime,
    grounding,
    ovSession,
    anchor,
    outcome: "abandoned",
    reason,
    clearProcessing: false, // reportOutcome already called above
    task,
    metricsOverrides: {
      tasksAttempted: 1,
      tasksAbandoned: 1,
      taskTitle: task?.title || `Cost cap tripped (${checkpoint})`,
      anchorType: anchor?.type ?? "unknown",
      anchorReference: anchor?.reference ?? "unknown",
      plannerModel: task?.__plannerModel || "unknown",
      planCacheHit: task?.__planCacheHit ? "true" : "false",
      abandonReason: reason,
      costCapTrippedAt: checkpoint,
      costUsd: status.costUsd,
    },
  });

  return {
    continue: false,
    status,
    result: {
      cycleId,
      tasks: taskId
        ? [{ taskId, finalState: "abandoned", reason }]
        : [],
      reason,
      durationMs: Date.now() - startTime,
      costCap: { costUsd: status.costUsd, capUsd: status.capUsd, checkpoint },
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming budget (issue #286)
// ---------------------------------------------------------------------------
//
// `StreamingBudget` projects the in-flight cost of a single agent call by
// counting input tokens (known up-front from the prompt) and accumulating
// streamed output tokens (estimated from character deltas). When the
// projected total cycle spend would exceed the per-cycle cap, the budget
// reports "abort" — the caller (codex-runner.runAgent) then fires its
// AbortController, killing the SDK turn before more output streams in.
//
// Why a projector and not a hard token meter:
//   The Codex SDK only emits authoritative `usage` on `turn.completed`
//   (sdk 0.125.0). Mid-stream we receive `item.updated` events whose
//   ThreadItem payload contains the assistant message / reasoning text
//   accumulated so far. Counting characters and dividing by 4 yields a
//   conservative upper bound on output tokens — good enough to circuit-
//   break a runaway response before the bill arrives.
//
// Why conservative (over-estimate) is the right tuning:
//   The cost-per-merge regression at $142 was caused by single calls
//   spending $60+ in one shot. Tripping at $24 of *projected* spend when
//   the true number is $20 is a tiny over-correction; tripping at $30
//   when the true number is $40 is the failure mode we're fixing. So we
//   round UP on tokens-per-char.

/** Default chars-per-token estimate. OpenAI tokenizer averages ~4 chars
 *  per token for English prose; for JSON / code the ratio drops to ~3.5.
 *  We use 3.5 to OVER-count output tokens (and therefore cost) so the
 *  projector trips slightly early. */
const CHARS_PER_TOKEN_OUTPUT = 3.5;

/** Env flag to disable streaming projection without disabling the
 *  inter-step cap. Off by default in tests; on by default in prod. */
export function isStreamingBudgetEnabled(): boolean {
  const raw = process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
  if (raw === undefined || raw === "") return true; // default ON
  return raw !== "false" && raw !== "0";
}

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface StreamingBudgetOpts {
  /** Spend already accumulated on the cycle BEFORE this call started. */
  baselineUsd: number;
  /** Per-cycle cost cap. Pass Infinity to disable. */
  capUsd: number;
  /** Input tokens for this call (from the composed prompt). May be 0 if
   *  unknown; the projector handles it as zero input cost. */
  inputTokens?: number;
  /** Pricing for the model in use. Source from MODEL_PRICING. */
  pricing: ModelPricing;
  /** Diagnostic label included in the abort reason. */
  agentName: string;
  /** Chars-per-token override (mostly for tests). */
  charsPerTokenOutput?: number;
}

/**
 * Mid-stream cost projector. Stateful but tiny; constructed once per
 * `runAgent` call. Not concurrent-safe — assumed to be called from a
 * single async event loop.
 */
export class StreamingBudget {
  readonly baselineUsd: number;
  readonly capUsd: number;
  readonly inputCostUsd: number;
  readonly pricing: ModelPricing;
  readonly agentName: string;
  readonly charsPerTokenOutput: number;
  /** Highest output-char count seen across all in-flight items.
   *  Items can both grow (item.updated) and reset (new items in a turn);
   *  we track the SUM of completed items + the max of any in-flight one
   *  per type so abandonment of one item doesn't lose its accumulated
   *  cost projection. */
  private completedOutputChars = 0;
  private inFlightByItem = new Map<string, number>();
  private aborted = false;
  private abortReason: string | null = null;

  constructor(opts: StreamingBudgetOpts) {
    this.baselineUsd = Math.max(0, opts.baselineUsd || 0);
    this.capUsd = opts.capUsd;
    this.pricing = opts.pricing;
    this.agentName = opts.agentName;
    this.charsPerTokenOutput = opts.charsPerTokenOutput ?? CHARS_PER_TOKEN_OUTPUT;
    const inputTokens = Math.max(0, opts.inputTokens || 0);
    this.inputCostUsd = (inputTokens / 1_000_000) * this.pricing.input;
  }

  /**
   * Update the running output-char count for a given item id. Both
   * `item.updated` and `item.completed` carry the FULL accumulated text
   * (not a delta), so callers pass the latest text length each time.
   *
   * When an item completes, the caller should call `completeItem(id)` so
   * the in-flight slot is moved into the completed pool — that way a
   * new item starting on the same id (rare, but possible across turns)
   * doesn't double-count.
   */
  updateItemChars(itemId: string, charsSoFar: number): void {
    if (this.aborted) return;
    const safe = Math.max(0, charsSoFar | 0);
    this.inFlightByItem.set(itemId, safe);
  }

  /** Move an in-flight item into completed-sum. */
  completeItem(itemId: string, finalChars: number): void {
    if (this.aborted) return;
    const safe = Math.max(0, finalChars | 0);
    this.completedOutputChars += safe;
    this.inFlightByItem.delete(itemId);
  }

  /** Estimated output tokens, ceiling-rounded. */
  estimatedOutputTokens(): number {
    let inFlight = 0;
    for (const c of this.inFlightByItem.values()) inFlight += c;
    const totalChars = this.completedOutputChars + inFlight;
    if (totalChars <= 0) return 0;
    return Math.ceil(totalChars / this.charsPerTokenOutput);
  }

  /** Estimated USD cost of THIS call so far (input + projected output). */
  projectedCallCostUsd(): number {
    const outputCost = (this.estimatedOutputTokens() / 1_000_000) * this.pricing.output;
    return this.inputCostUsd + outputCost;
  }

  /** Estimated total cycle spend (baseline + this call). */
  projectedTotalUsd(): number {
    return this.baselineUsd + this.projectedCallCostUsd();
  }

  /** True if projected total has crossed the cap. */
  shouldAbort(): boolean {
    if (this.aborted) return true;
    if (!Number.isFinite(this.capUsd)) return false;
    return this.projectedTotalUsd() >= this.capUsd;
  }

  /** Mark this budget as having fired an abort. Subsequent updates are no-ops. */
  markAborted(checkpoint: string): string {
    if (this.aborted) return this.abortReason || "";
    this.aborted = true;
    const projected = this.projectedTotalUsd();
    const capStr = Number.isFinite(this.capUsd) ? `$${this.capUsd.toFixed(2)}` : "Infinity";
    this.abortReason =
      `${COST_CAP_REASON_PREFIX}: projected $${projected.toFixed(2)} >= ${capStr} ` +
      `mid-${this.agentName} (after ${checkpoint})`;
    return this.abortReason;
  }

  /** Has this budget already aborted? */
  hasAborted(): boolean {
    return this.aborted;
  }

  /** Human-readable abort reason, or null if not yet aborted. */
  getAbortReason(): string | null {
    return this.abortReason;
  }

  /** Snapshot of completed + in-flight chars, mostly for forensics. */
  snapshot() {
    const inFlightChars = Array.from(this.inFlightByItem.values()).reduce((a, b) => a + b, 0);
    return {
      baselineUsd: this.baselineUsd,
      capUsd: this.capUsd,
      inputCostUsd: this.inputCostUsd,
      completedOutputChars: this.completedOutputChars,
      inFlightOutputChars: inFlightChars,
      estimatedOutputTokens: this.estimatedOutputTokens(),
      projectedCallCostUsd: this.projectedCallCostUsd(),
      projectedTotalUsd: this.projectedTotalUsd(),
      aborted: this.aborted,
      abortReason: this.abortReason,
    };
  }
}

/**
 * Convenience constructor — builds a StreamingBudget for the given cycle.
 *
 * Returns `null` when streaming projection is disabled (cap = Infinity OR
 * `HYDRA_STREAM_COST_CHECK_ENABLED=false`). Callers should treat null as
 * "skip mid-stream checks", which is the historical pre-#286 behavior.
 */
export async function createStreamingBudget({
  cycleId,
  pricing,
  agentName,
  inputTokens,
}: {
  cycleId: string | null | undefined;
  pricing: ModelPricing;
  agentName: string;
  inputTokens?: number;
}): Promise<StreamingBudget | null> {
  if (!isStreamingBudgetEnabled()) return null;
  const capUsd = getPerCycleCostCapUsd();
  if (!Number.isFinite(capUsd)) return null;
  // No cycleId → manual / out-of-band call; skip projection.
  if (!cycleId) return null;
  const baselineUsd = await getCycleCostUsd(cycleId);
  return new StreamingBudget({
    baselineUsd,
    capUsd,
    pricing,
    agentName,
    inputTokens: inputTokens || 0,
  });
}
