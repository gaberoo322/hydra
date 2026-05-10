/**
 * cost-cap.ts — Per-cycle cost cap circuit breaker (issue #209)
 *
 * Bug: There was no per-cycle cost cap on the build loop. Abandoned cycles
 * could consume up to $56 each before hitting their abandonment gate
 * (Preflight, Auto-decompose, Planner noWork). With ~31 abandoned cycles
 * in 50, this was the dominant cost-leak class.
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
 */

import { getCycleCostMicrodollars } from "./redis-adapter.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { recordOutcome } from "./learning.ts";
import { getTracker } from "./task-tracker.ts";
import { STREAMS } from "./event-bus.ts";
import { handleEarlyExit } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

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
  const costUsd = await getCycleCostUsd(cycleId);
  const exceeded = Number.isFinite(capUsd) && costUsd >= capUsd;
  const capStr = Number.isFinite(capUsd) ? `$${capUsd.toFixed(2)}` : "Infinity";
  const reason = exceeded
    ? `${COST_CAP_REASON_PREFIX}: $${costUsd.toFixed(2)} >= ${capStr}`
    : `${COST_CAP_REASON_PREFIX}: under cap ($${costUsd.toFixed(2)} < ${capStr})`;
  return { costUsd, capUsd, exceeded, reason };
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
