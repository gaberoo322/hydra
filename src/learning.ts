/**
 * learning.ts — Unified learning facade (issue #73)
 *
 * Thin facade that replaces the 6 separate recording functions callers
 * currently coordinate:
 *   - recordPlannerLesson, recordExecutorLesson, recordSkepticLesson (agent-memory.ts)
 *   - recordReflection (agent-memory.ts — per-anchor)
 *   - recordReflection (reflections.ts — global buffer)
 *
 * `recordOutcome()` internally dispatches to the correct per-agent lesson
 * recorder and both reflection systems based on the agent and result.
 *
 * `clearOutcomes()` clears per-anchor and global reflections after merge.
 *
 * Old modules and their exports remain — this facade delegates to them.
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
// Types
// ---------------------------------------------------------------------------

export type OutcomeAgent = "planner" | "executor" | "skeptic";

export interface OutcomeTask {
  title: string;
  scopeBoundary?: { in?: string[] };
  risk?: string;
  anchorType?: string;
  anchorReference?: string;
  [key: string]: any;
}

export interface OutcomeResult {
  cycleId: string;
  finalState: string;
  anchor: { type: string; reference: string };
  /** Extra context passed to per-agent lesson recorders */
  context?: any;
  /** Skeptic verdict (only relevant for skeptic agent) */
  skepticVerdict?: string;
}

// ---------------------------------------------------------------------------
// recordOutcome — unified entry point
// ---------------------------------------------------------------------------

/**
 * Record a cycle outcome across all learning subsystems.
 *
 * Dispatches to the correct per-agent lesson recorder and both reflection
 * systems (per-anchor + global buffer) based on the agent and result.
 *
 * Never throws — logs errors and continues.
 */
export async function recordOutcome(
  agent: OutcomeAgent,
  task: OutcomeTask,
  result: OutcomeResult,
  eventBus?: any,
): Promise<void> {
  const { cycleId, finalState, anchor, context = {}, skepticVerdict } = result;

  // 1. Per-agent lesson
  try {
    switch (agent) {
      case "planner":
        await recordPlannerLesson(cycleId, task, finalState, context);
        break;
      case "executor":
        await recordExecutorLesson(cycleId, task, finalState, context);
        break;
      case "skeptic":
        await recordSkepticLesson(cycleId, task, skepticVerdict, finalState);
        break;
    }
  } catch (err: any) {
    console.error(`[Learning] Failed to record ${agent} lesson: ${err.message}`);
  }

  // 2. Per-anchor reflection (only on failure-like states)
  const reflectionStates = new Set(["failed", "no-task", "no-diff", "abandoned", "rolled-back", "verification-failed"]);
  if (reflectionStates.has(finalState)) {
    try {
      await recordAnchorReflection({
        cycleId,
        anchorRef: anchor.reference,
        taskTitle: task.title || "Unknown task",
        outcome: finalState,
        reason: context.reason || context.failReason || `${finalState}`,
        filesChanged: context.filesChanged,
        verificationErrors: context.failedSteps || context.verificationErrors,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record anchor reflection: ${err.message}`);
    }

    // 3. Global reflection buffer
    try {
      await recordGlobalReflection({
        cycleId,
        anchorType: anchor.type,
        anchorReference: anchor.reference,
        failureMode: finalState,
        whatFailed: task.title || "Unknown task",
        whyItFailed: context.reason || context.failReason || finalState,
        whatToTryDifferently: context.whatToTryDifferently || generateDefaultAdvice(finalState, context),
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record global reflection: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// clearOutcomes — clear reflections after successful merge
// ---------------------------------------------------------------------------

/**
 * Clear per-anchor and global reflections for a given anchor reference.
 * Called after a successful merge to remove stale failure context.
 *
 * Never throws — logs errors and continues.
 */
export async function clearOutcomes(anchorReference: string): Promise<void> {
  try {
    await clearAnchorReflections(anchorReference);
  } catch (err: any) {
    console.error(`[Learning] Failed to clear anchor reflections: ${err.message}`);
  }

  try {
    await clearReflectionsForAnchor(anchorReference);
  } catch (err: any) {
    console.error(`[Learning] Failed to clear global reflections: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateDefaultAdvice(finalState: string, context: any): string {
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
    return `Task was abandoned: ${context.reason || "unknown reason"}. Consider different approach, narrower scope, or verify prerequisites are met.`;
  }
  return `Previous attempt failed: ${context.reason || context.failReason || finalState}. The next attempt should take a different approach.`;
}
