/**
 * pipeline-steps.ts — Step functions for the control loop pipeline
 *
 * Each step follows the (context) → StepResult interface:
 *   - { continue: true, ...data } — pipeline proceeds to next step
 *   - { continue: false, result: LoopResult } — pipeline stops, return result
 *
 * Steps extracted from control-loop.ts (issue #13):
 *   - handlePlanResult — null-task / usage-limit handling + circuit breaker
 *   - runDriftCheck — reject near-duplicates of recent work
 *   - runPreflightGate — deterministic preflight + high-risk review
 *   - runExecuteStep — executor call + no-diff validation
 *   - runMergeStep — merge lock acquisition + merge to main
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.ts";
import { getTracker } from "./task-tracker.ts";
import { getDiff } from "./grounding.ts";
import { recordOutcome } from "./learning.ts";
import { recordCycleMetrics, detectDrift } from "./metrics.ts";
import { claim, fail } from "./backlog.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { recordCalibrationOutcome } from "./anchor-scorer.ts";
import { preflightCheck, runHighRiskReview } from "./preflight.ts";
import { runExecutorAgent } from "./executor-agent.ts";
import {
  acquireMergeLock, getMergeLockHolder, releaseMergeLock,
} from "./redis-adapter.ts";
import { mergeToMain } from "./merge.ts";
import {
  handleEarlyExit, PROJECT_WORKSPACE,
} from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

// ---------------------------------------------------------------------------
// StepResult — consistent return type for all pipeline steps
// ---------------------------------------------------------------------------

export interface StepContinue {
  continue: true;
  [key: string]: any;
}

export interface StepStop {
  continue: false;
  result: any;
}

export type StepResult = StepContinue | StepStop;

// ---------------------------------------------------------------------------
// handlePlanResult — process planner output (null task, usage-limit, success)
// ---------------------------------------------------------------------------

export async function handlePlanResult(
  ctx: CycleContext,
  task: any,
  anchorConfidence: { score: number; reason: string; tier: "heuristic" | "classifier" } | null,
): Promise<StepResult> {
  const { cycleId, startTime, grounding, ovSession, anchor } = ctx;

  // Check for usage-limit sentinel
  if (task?.__usageLimitHit) {
    console.error(`[ControlLoop] Codex usage limit reached — pausing scheduler for 30 minutes`);
    await reportOutcome(anchor, { status: "abandoned", reason: "Codex usage limit hit — scheduler paused" });
    await ovSession.logOutcome("usage-limit", "Codex usage limit hit — scheduler paused");
    await ovSession.commit();
    return { continue: false, result: { cycleId, tasks: [], reason: "Codex usage limit hit — scheduler paused", durationMs: Date.now() - startTime, __usageLimitHit: true } };
  }

  if (!task) {
    console.log(`[ControlLoop] Planner produced no valid task — cycle complete`);

    // Circuit breaker: planner null counts as an abandonment
    try {
      await reportOutcome(anchor, { status: "abandoned", reason: "Planner produced no valid task (schema validation or parse failure)", task: { title: anchor.reference, taskId: "none" } });
    } catch (err: any) {
      console.error(`[ControlLoop] Circuit breaker tracking failed on null task: ${err.message}`);
    }

    await ovSession.logPlanner(anchor, null);
    await recordOutcome("planner", { title: "Planner produced no task" }, {
      cycleId, finalState: "no-task", anchor,
      context: { reason: "Planner could not produce a valid task from this anchor" },
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record outcome: ${err.message}`));

    if (anchorConfidence) {
      await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, "no-task");
    }
    await handleEarlyExit({
      cycleId, startTime, grounding, ovSession, anchor,
      outcome: "no-work", reason: "Planner produced no task",
      clearProcessing: false, // reportOutcome already called above
      metricsOverrides: {
        tasksAbandoned: 1, taskTitle: "Planner produced no task",
        anchorType: anchor.type, anchorReference: anchor.reference,
        plannerModel: "unknown", abandonReason: "Planner produced no task",
        anchorConfidence: anchorConfidence?.score ?? null, anchorSkipped: false,
      },
    });
    return { continue: false, result: { cycleId, tasks: [], reason: "Planner produced no task", durationMs: Date.now() - startTime } };
  }

  return { continue: true };
}

// ---------------------------------------------------------------------------
// runDriftCheck — reject near-duplicates of recent work
// ---------------------------------------------------------------------------

export async function runDriftCheck(
  ctx: CycleContext,
  task: any,
  taskId: string,
): Promise<StepResult> {
  const { cycleId, startTime, grounding, eventBus, anchor } = ctx;

  const skipDrift = anchor.type === "prior-failure" || anchor.type === "user-request" || anchor.type === "reframe" || anchor.type === "codebase-health";
  const drift = skipDrift ? { isDuplicate: false } : await detectDrift(task);
  if (!drift.isDuplicate) {
    return { continue: true };
  }

  const tracker = getTracker();
  // @ts-expect-error — migrate to proper types
  console.log(`[ControlLoop] DRIFT DETECTED: ${drift.reason}`);
  await tracker.transitionTask(taskId, "abandoned", { drift });
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "task:drift_detected",
    source: "control-loop",
    correlationId: cycleId,
    payload: { taskId, title: task.title, drift },
  });
  try {
    // @ts-expect-error — migrate to proper types
    await recordOutcome("planner", task, { cycleId, finalState: "abandoned", anchor, context: { reason: `Drift: ${drift.reason}` } });
  } catch (err: any) {
    console.error(`[ControlLoop] Failed to record drift lesson: ${err.message}`);
  }
  try {
    // @ts-expect-error — migrate to proper types
    await reportOutcome(anchor, { status: "abandoned", reason: `Drift: ${drift.reason}`, task });
  } catch { /* intentional: best-effort tracking */ }
  await recordCycleMetrics(cycleId, {
    tasksAttempted: 1, tasksFailed: 0, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 1,
    testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
    testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
    filesChanged: 0, totalDurationMs: Date.now() - startTime,
    groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: 0,
    regressionIntroduced: false, taskTitle: task.title,
    anchorType: task.anchorType, anchorReference: task.anchorReference,
    plannerModel: task.__plannerModel || "unknown",
    planCacheHit: task.__planCacheHit ? "true" : "false",
    // @ts-expect-error — migrate to proper types
    abandonReason: `Drift: ${drift.reason}`,
  });
  return {
    continue: false,
    result: {
      cycleId,
      // @ts-expect-error — migrate to proper types
      tasks: [{ taskId, finalState: "abandoned", reason: `Drift: ${drift.reason}` }],
      durationMs: Date.now() - startTime,
    },
  };
}

// ---------------------------------------------------------------------------
// runPreflightGate — deterministic preflight + high-risk review
// ---------------------------------------------------------------------------

export async function runPreflightGate(
  ctx: CycleContext,
  task: any,
  complexity: string,
  groundingSummary: string,
  taskId: string,
): Promise<StepResult> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;

  let skepticResult: { verdict: string; reason: string; skipped?: boolean };
  if (complexity === "quick-fix") {
    skepticResult = { verdict: "approve", reason: "Skipped — quick-fix (scope-adaptive routing)", skipped: true };
  } else {
    console.log(`[ControlLoop] Step 4: Preflight gate...`);
    const preflight = await preflightCheck(task, grounding, groundingSummary);
    if (!preflight.pass) {
      skepticResult = { verdict: "reject", reason: `Preflight: ${preflight.flags.join("; ")}` };
    } else if (task.risk === "high") {
      console.log(`[ControlLoop] High-risk task — running nano-model review...`);
      skepticResult = await runHighRiskReview(cycleId, task, grounding, groundingSummary, ovSession);
    } else {
      skepticResult = { verdict: "approve", reason: `Preflight passed (${preflight.flags.length} flags, risk: ${task.risk})` };
    }
  }

  await ovSession.logSkeptic(skepticResult.verdict, skepticResult.reason);

  if (skepticResult.verdict !== "reject") {
    const tracker = getTracker();
    await tracker.transitionTask(taskId, "approved", { skepticVerdict: skepticResult });
    console.log(`[ControlLoop] APPROVED: ${skepticResult.reason || "no objections"}`);
    return { continue: true, skepticResult };
  }

  // Rejection path
  const tracker = getTracker();
  console.log(`[ControlLoop] Preflight REJECTED: ${skepticResult.reason}`);
  await tracker.transitionTask(taskId, "abandoned", { skepticVerdict: skepticResult });
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "task:rejected",
    source: "control-loop",
    correlationId: cycleId,
    payload: { taskId, title: task.title, reason: skepticResult.reason },
  });

  const isJudgmentRejection = !skepticResult.reason.startsWith("Preflight:");
  try {
    if (isJudgmentRejection) {
      await recordOutcome("planner", task, { cycleId, finalState: "abandoned", anchor, context: { reason: `Review rejected: ${skepticResult.reason}` } });
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Failed to record rejection lessons: ${err.message}`);
  }

  try {
    await reportOutcome(anchor, { status: "abandoned", reason: skepticResult.reason, task });
  } catch (err: any) {
    console.error(`[ControlLoop] Circuit breaker tracking failed: ${err.message}`);
  }

  await handleEarlyExit({
    cycleId, startTime, grounding, ovSession, anchor,
    outcome: "abandoned", reason: `Rejected: ${skepticResult.reason}`,
    clearProcessing: false, // reportOutcome already called above
    metricsOverrides: {
      tasksAttempted: 1, tasksAbandoned: 1,
      taskTitle: task.title,
      anchorType: task.anchorType, anchorReference: task.anchorReference,
      plannerModel: task.__plannerModel || "unknown",
      planCacheHit: task.__planCacheHit ? "true" : "false",
      abandonReason: skepticResult.reason,
    },
  });
  return {
    continue: false,
    result: {
      cycleId,
      tasks: [{ taskId, finalState: "abandoned", reason: skepticResult.reason }],
      durationMs: Date.now() - startTime,
    },
  };
}

// ---------------------------------------------------------------------------
// validateDiffExists — simple git check (moved from verifier.ts, issue #66)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Validate that a git diff exists (actual code changes were made).
 * Used to gate the transition from in-progress to changed-code.
 */
async function validateDiffExists(projectDir: string, baseBranch = "main") {
  try {
    // Check for uncommitted changes
    const { stdout: status } = await execFileAsync("git", ["status", "--short"], {
      cwd: projectDir,
      timeout: 5000,
    });
    if (status.trim()) return true;

    // Check for committed changes vs base branch
    const { stdout: diff } = await execFileAsync("git", ["diff", "--stat", baseBranch], {
      cwd: projectDir,
      timeout: 10000,
    });
    return diff.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// runExecuteStep — run executor agent + validate diff exists
// ---------------------------------------------------------------------------

export async function runExecuteStep(
  ctx: CycleContext,
  task: any,
  groundingSummary: string,
  complexity: string,
  taskId: string,
): Promise<StepResult> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor } = ctx;
  const tracker = getTracker();

  console.log(`[ControlLoop] Step 5: Executing...`);
  await tracker.transitionTask(taskId, "in-progress", {});
  await claim(anchor.reference, { eventBus, cycleId });

  const execResult = await runExecutorAgent(cycleId, task, grounding, groundingSummary, ovSession, complexity);
  await ovSession.logExecutor(execResult);

  // Validate a diff exists
  const hasDiff = await validateDiffExists(PROJECT_WORKSPACE);
  if (!hasDiff) {
    console.log(`[ControlLoop] Executor produced no code changes — failing task`);
    await tracker.transitionTask(taskId, "failed", { reason: "No code changes produced", execResult: { exitCode: execResult.exitCode, duration: execResult.duration } });
    await recordOutcome("planner", task, {
      cycleId, finalState: "no-diff", anchor,
      context: { failReason: "Executor produced no code changes", reason: "Executor ran but produced no code changes" },
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record planner outcome: ${err.message}`));
    await recordOutcome("executor", task, {
      cycleId, finalState: "failed", anchor,
      context: { noDiff: true },
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record executor outcome: ${err.message}`));
    await fail(anchor.reference, "no code changes", { eventBus, cycleId });
    await reportOutcome(anchor, { status: "failed", reason: "No code changes produced", taskId });
    await ovSession.logOutcome("failed", "Executor produced no code changes");
    await ovSession.commit();
    return {
      continue: false,
      result: {
        cycleId,
        tasks: [{ taskId, finalState: "failed", reason: "No code changes" }],
        durationMs: Date.now() - startTime,
      },
    };
  }

  const { diff } = await getDiff(PROJECT_WORKSPACE, "main");
  await tracker.transitionTask(taskId, "changed-code", { diffLength: diff.length, filesChanged: execResult.filesChanged || [] });
  console.log(`[ControlLoop] Code changed (${diff.split("\n").length} diff lines)`);

  return { continue: true, execResult, diff };
}

// ---------------------------------------------------------------------------
// runMergeStep — acquire merge lock + merge to main
// ---------------------------------------------------------------------------

export async function runMergeStep(
  ctx: CycleContext,
  task: any,
  taskId: string,
): Promise<StepResult> {
  const { cycleId, eventBus } = ctx;

  console.log(`[ControlLoop] Step 7: Merging to main...`);

  const MERGE_LOCK_TTL = 60;
  let mergeLockAcquired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const acquired = await acquireMergeLock(cycleId, MERGE_LOCK_TTL);
    if (acquired) {
      mergeLockAcquired = true;
      break;
    }
    const holder = await getMergeLockHolder();
    console.log(`[ControlLoop] Merge lock held by ${holder} — retry ${attempt + 1}/3`);
    await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
  }

  if (!mergeLockAcquired) {
    console.error(`[ControlLoop] Failed to acquire merge lock after 3 attempts`);
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:merge_failed",
      source: "control-loop",
      correlationId: cycleId,
      payload: { taskId, title: task.title, error: "Merge lock contention — another merge in progress" },
    });
  }

  const mergeResult = mergeLockAcquired
    ? await mergeToMain(PROJECT_WORKSPACE, cycleId)
    : { ok: false, commitSha: "", featureBranch: null, error: "Merge lock not acquired" };

  // Always release merge lock after merge attempt
  await releaseMergeLock().catch(() => {});

  return { continue: true, mergeResult };
}
