/**
 * learning.ts — Unified learning facade for the control loop
 *
 * Provides two public functions:
 *   - recordOutcome(agent, task, opts) — dispatches to the correct per-agent
 *     lesson recorder and both reflection systems (per-anchor + global buffer)
 *   - clearOutcomes(anchorRef) — clears per-anchor + global reflections on merge
 *
 * Delegates to agent-memory.ts (per-agent lessons + per-anchor reflections) and
 * reflections.ts (global bounded buffer). Old modules and exports are preserved
 * for backward compatibility.
 */

import {
  recordPlannerLesson,
  recordExecutorLesson,
  recordSkepticLesson,
  recordReflection as recordAnchorReflection,
  clearReflections as clearAnchorReflections,
} from "./agent-memory.ts";
import {
  recordReflection as recordGlobalReflection,
  clearReflectionsForAnchor,
} from "./reflections.ts";

// ---------------------------------------------------------------------------
// recordOutcome — unified recording facade
// ---------------------------------------------------------------------------

/**
 * Record the outcome of an agent's work in the learning system.
 *
 * Dispatches to the correct per-agent lesson recorder and (on failure) records
 * both per-anchor and global reflections so future cycles can learn.
 *
 * @param agent   — "planner" | "executor" | "skeptic"
 * @param task    — the planner task object (needs at least .title)
 * @param opts    — structured outcome details
 */
export async function recordOutcome(
  agent: "planner" | "executor" | "skeptic",
  task: any,
  opts: {
    cycleId: string;
    finalState: string;
    anchor: { type: string; reference: string };
    context?: Record<string, any>;
    skepticVerdict?: string;
  },
): Promise<void> {
  const { cycleId, finalState, anchor, context = {}, skepticVerdict } = opts;

  // 1. Dispatch to the per-agent lesson recorder
  if (agent === "planner") {
    await recordPlannerLesson(cycleId, task, mapFinalState(finalState), context);
  } else if (agent === "executor") {
    await recordExecutorLesson(cycleId, task, mapFinalState(finalState), context);
  } else if (agent === "skeptic") {
    await recordSkepticLesson(cycleId, task, skepticVerdict || "approve", mapFinalState(finalState));
  }

  // 2. On failure states, record reflections (per-anchor + global buffer)
  const isFailure = ["failed", "no-task", "no-diff", "verification-failed", "abandoned"].includes(finalState);
  if (isFailure && agent !== "skeptic") {
    const reason = context.failReason || context.reason || `${finalState}`;
    const taskTitle = task?.title || "Unknown task";

    await recordAnchorReflection({
      cycleId,
      anchorRef: anchor.reference,
      taskTitle,
      outcome: finalState,
      reason,
      verificationErrors: context.verificationErrors || context.failedSteps,
    }).catch((err: any) => console.error(`[Learning] Failed to record anchor reflection: ${err.message}`));

    await recordGlobalReflection({
      cycleId,
      anchorType: anchor.type,
      anchorReference: anchor.reference,
      failureMode: finalState,
      whatFailed: taskTitle,
      whyItFailed: reason,
      whatToTryDifferently: generateAdvice(finalState, context),
    }).catch((err: any) => console.error(`[Learning] Failed to record global reflection: ${err.message}`));
  }
}

/**
 * Map facade finalState values to the states expected by the per-agent recorders.
 * The recorders expect: "merged", "failed", "rolled-back", "abandoned".
 * The facade also accepts: "no-task", "no-diff", "verification-failed".
 */
function mapFinalState(finalState: string): string {
  if (finalState === "no-task" || finalState === "no-diff" || finalState === "verification-failed") {
    return "failed";
  }
  return finalState;
}

/**
 * Generate advice for the reflection based on failure mode.
 */
function generateAdvice(finalState: string, context: Record<string, any>): string {
  if (finalState === "no-task") {
    return "Anchor may be too vague, already completed, or blocked. Consider a more specific formulation.";
  }
  if (finalState === "no-diff") {
    return "Provide more specific scope boundary and acceptance criteria. Ensure the task is actionable.";
  }
  if (finalState === "verification-failed") {
    const steps = context.failedSteps || context.verificationErrors || [];
    return `Address these specific verification failures: ${steps.join(", ")}. Consider narrower scope or fixing verification errors before adding new behavior.`;
  }
  if (finalState === "abandoned") {
    return `Task was abandoned: ${context.reason || "unknown"}. Consider a different approach, narrower scope, or verify prerequisites are met.`;
  }
  return `Previous attempt failed: ${context.reason || context.failReason || finalState}. The next attempt should take a different approach.`;
}

// ---------------------------------------------------------------------------
// clearOutcomes — unified cleanup on successful merge
// ---------------------------------------------------------------------------

/**
 * Clear all reflections for an anchor after a successful merge.
 * Wraps both per-anchor reflections (agent-memory.ts) and global buffer
 * reflections (reflections.ts).
 */
export async function clearOutcomes(anchorRef: string): Promise<void> {
  await clearAnchorReflections(anchorRef);
  await clearReflectionsForAnchor(anchorRef);
}
