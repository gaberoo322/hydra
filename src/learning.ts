/**
 * learning.ts — Unified facade for the learning subsystem
 *
 * Provides:
 *   recordOutcome(agent, task, result, eventBus) — dispatches to per-agent
 *     lesson recorders + both reflection systems (per-anchor and global buffer)
 *   clearOutcomes(anchor) — clears reflections from both stores after merge
 *
 * Delegates to agent-memory.ts (per-agent lessons + per-anchor reflections)
 * and reflections.ts (global reflection buffer). Old modules and their exports
 * remain — this is a thin coordination layer.
 *
 * Issue #73
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
// recordOutcome — single entry point for recording learning from a cycle step
// ---------------------------------------------------------------------------

export interface OutcomeResult {
  /** Final state: "merged" | "failed" | "abandoned" | "rolled-back" | "no-task" | "no-diff" */
  finalState: string;
  /** Human-readable reason for the outcome */
  reason?: string;
  /** Extra context passed through to per-agent recorders */
  context?: Record<string, any>;
  /** Anchor info for reflection recording */
  anchor?: { type: string; reference: string };
  /** Task title for reflections */
  taskTitle?: string;
}

/**
 * Record learning outcome: dispatches to the correct per-agent lesson recorder
 * and both reflection systems based on agent and result.
 *
 * @param agent     — "planner" | "executor" | "skeptic" (determines which lesson recorder)
 * @param cycleId   — current cycle identifier
 * @param task      — planner task object
 * @param result    — outcome info (finalState, reason, context, anchor)
 */
export async function recordOutcome(
  agent: string,
  cycleId: string,
  task: any,
  result: OutcomeResult,
): Promise<void> {
  const { finalState, reason, context = {}, anchor, taskTitle } = result;

  // 1. Dispatch to per-agent lesson recorder
  try {
    switch (agent) {
      case "planner":
        await recordPlannerLesson(cycleId, task, finalState, context);
        break;
      case "executor":
        await recordExecutorLesson(cycleId, task, finalState, context);
        break;
      case "skeptic":
        await recordSkepticLesson(cycleId, task, context.skepticVerdict, finalState);
        break;
      default:
        console.error(`[Learning] Unknown agent "${agent}" — skipping lesson recording`);
    }
  } catch (err: any) {
    console.error(`[Learning] Failed to record ${agent} lesson: ${err.message}`);
  }

  // 2. Record per-anchor reflection (for failure outcomes only)
  const failureStates = new Set(["failed", "abandoned", "rolled-back", "no-task", "no-diff"]);
  if (failureStates.has(finalState) && anchor?.reference) {
    try {
      await recordAnchorReflection({
        cycleId,
        anchorRef: anchor.reference,
        taskTitle: taskTitle || task?.title || "Unknown task",
        outcome: finalState,
        reason: reason || "Unknown reason",
        filesChanged: context.filesChanged,
        verificationErrors: context.failedSteps,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record anchor reflection: ${err.message}`);
    }
  }

  // 3. Record global reflection (for failure outcomes only)
  if (failureStates.has(finalState) && anchor) {
    try {
      await recordGlobalReflection({
        cycleId,
        anchorType: anchor.type,
        anchorReference: anchor.reference,
        failureMode: finalState,
        whatFailed: taskTitle || task?.title || "Unknown task",
        whyItFailed: reason || "Unknown reason",
        whatToTryDifferently: context.whatToTryDifferently || `Previous attempt failed: ${reason || finalState}. The next attempt should take a different approach.`,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record global reflection: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// clearOutcomes — clear reflections from both stores after successful merge
// ---------------------------------------------------------------------------

/**
 * Clear reflections for an anchor from both the per-anchor store and the
 * global buffer. Called after a successful merge.
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
