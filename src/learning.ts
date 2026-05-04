/**
 * learning.ts — Unified recording facade for the learning system
 *
 * Replaces direct calls to per-agent lesson recorders + both reflection
 * systems with a single `recordOutcome()` entry point. Internally dispatches
 * to:
 *   - recordPlannerLesson / recordExecutorLesson / recordSkepticLesson (agent-memory.ts)
 *   - recordReflection (agent-memory.ts — per-anchor episodic reflections)
 *   - recordReflection (reflections.ts — global bounded buffer)
 *
 * Also provides `clearOutcomes(anchor)` which delegates to both clear
 * functions after a successful merge.
 */

import {
  recordPlannerLesson,
  recordExecutorLesson,
  recordSkepticLesson,
  recordReflection as recordAnchorReflection,
  clearReflections,
  loadAgentMemory,
  formatMemoryForPrompt,
  loadReflections,
} from "./agent-memory.ts";
import {
  recordReflection as recordGlobalReflection,
  clearReflectionsForAnchor,
  loadRelevantReflections,
  formatReflectionsForPrompt,
} from "./reflections.ts";

// ---------------------------------------------------------------------------
// getContext — unified context loader for agent prompts
// ---------------------------------------------------------------------------

/**
 * Load all learning context for an agent + anchor in one call.
 *
 * Combines:
 *   - Agent memory (loadAgentMemory + formatMemoryForPrompt)
 *   - Per-anchor reflections (loadReflections from agent-memory)
 *   - Global relevant reflections (loadRelevantReflections + formatReflectionsForPrompt)
 *
 * Returns a single formatted string ready for prompt injection.
 * Never throws — individual sources degrade gracefully.
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string },
): Promise<string> {
  const parts: string[] = [];

  // 1. Agent memory patterns (formatted for prompt)
  try {
    const memory = await loadAgentMemory(agent);
    const formatted = formatMemoryForPrompt(memory, agent);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: agent memory load failed for ${agent}: ${err.message}`);
  }

  // 2. Per-anchor episodic reflections
  try {
    const reflections = await loadReflections(anchor.reference);
    if (reflections) parts.push(reflections);
  } catch (err: any) {
    console.error(`[Learning] getContext: per-anchor reflections failed for "${anchor.reference}": ${err.message}`);
  }

  // 3. Global relevant reflections (Reflexion pattern)
  try {
    const relevant = await loadRelevantReflections(anchor);
    const formatted = formatReflectionsForPrompt(relevant);
    if (formatted) parts.push(formatted);
  } catch (err: any) {
    console.error(`[Learning] getContext: global reflections failed for "${anchor.reference}": ${err.message}`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutcomeAgent = "planner" | "executor" | "skeptic";

export interface OutcomeOpts {
  /** Which agent(s) to record lessons for */
  agents: OutcomeAgent[];

  /** Cycle ID */
  cycleId: string;

  /** The planner task object */
  task: any;

  /** Final state: "merged" | "failed" | "abandoned" | "rolled-back" */
  finalState: string;

  /** Anchor reference (for per-anchor reflections) */
  anchorRef: string;

  /** Anchor type (for global reflections) */
  anchorType: string;

  /** Per-agent lesson context — passed through to the lesson recorders */
  context?: any;

  /** Skeptic verdict — only needed when agents includes "skeptic" */
  skepticVerdict?: string;

  /**
   * Reflection details — if provided, both per-anchor and global reflections
   * are recorded. If omitted, no reflections are recorded.
   */
  reflection?: {
    /** e.g. "no-task", "no-diff", "verification-failed", "abandoned" */
    failureMode: string;
    /** Short description of what failed */
    whatFailed: string;
    /** Why it failed */
    whyItFailed: string;
    /** What to try differently */
    whatToTryDifferently: string;
    /** Verification errors (for per-anchor advice generation) */
    verificationErrors?: string[];
  };
}

// ---------------------------------------------------------------------------
// recordOutcome — unified entry point
// ---------------------------------------------------------------------------

/**
 * Record outcome for one or more agents + optional reflections.
 *
 * Never throws — all errors are logged with context.
 */
export async function recordOutcome(opts: OutcomeOpts): Promise<void> {
  const {
    agents, cycleId, task, finalState, anchorRef, anchorType,
    context = {}, skepticVerdict, reflection,
  } = opts;

  // Record per-agent lessons
  for (const agent of agents) {
    try {
      switch (agent) {
        case "planner":
          await recordPlannerLesson(cycleId, task, finalState, context);
          break;
        case "executor":
          await recordExecutorLesson(cycleId, task, finalState, context);
          break;
        case "skeptic":
          await recordSkepticLesson(cycleId, task, skepticVerdict ?? "approve", finalState);
          break;
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to record ${agent} lesson for ${cycleId}: ${err.message}`);
    }
  }

  // Record reflections (both per-anchor and global) if provided
  if (reflection) {
    try {
      await recordAnchorReflection({
        cycleId,
        anchorRef,
        taskTitle: reflection.whatFailed,
        outcome: reflection.failureMode,
        reason: reflection.whyItFailed,
        verificationErrors: reflection.verificationErrors,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record per-anchor reflection for ${cycleId}: ${err.message}`);
    }

    try {
      await recordGlobalReflection({
        cycleId,
        anchorType,
        anchorReference: anchorRef,
        failureMode: reflection.failureMode,
        whatFailed: reflection.whatFailed,
        whyItFailed: reflection.whyItFailed,
        whatToTryDifferently: reflection.whatToTryDifferently,
      });
    } catch (err: any) {
      console.error(`[Learning] Failed to record global reflection for ${cycleId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// clearOutcomes — clear both reflection stores after successful merge
// ---------------------------------------------------------------------------

/**
 * Clear per-anchor and global reflections for an anchor reference.
 * Called after a successful merge.
 *
 * Never throws — errors are logged.
 */
export async function clearOutcomes(anchorRef: string): Promise<void> {
  try {
    await clearReflections(anchorRef);
  } catch (err: any) {
    console.error(`[Learning] Failed to clear per-anchor reflections for "${anchorRef}": ${err.message}`);
  }

  try {
    await clearReflectionsForAnchor(anchorRef);
  } catch (err: any) {
    console.error(`[Learning] Failed to clear global reflections for "${anchorRef}": ${err.message}`);
  }
}
