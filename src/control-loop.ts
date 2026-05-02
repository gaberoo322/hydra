/**
 * control-loop.ts — Pipeline orchestrator for the Hydra control loop
 *
 * Refactored from 1,558 lines to ~400 lines (issue #1, Module 6).
 * Each step is now an imported function:
 *   - cycle-helpers.ts     — groundProjectCached, generateCycleId, safeKanban, isAnchorStale, handleEarlyExit, cleanupBrokenBranch
 *   - verification-pipeline.ts — steps 6 through 6.9 (verify → fixer → reconcile → mutation → JIT → scope)
 *   - post-merge.ts        — step 8 (report, metrics, learning, adversarial, pattern detection)
 *
 * The main flow reads as a script of step calls with clear branching.
 */

import { STREAMS } from "./event-bus.ts";
import { getTracker, CYCLE_KEY_TTL } from "./task-tracker.ts";
import { summarizeForPrompt, getDiff } from "./grounding.ts";
import {
  registerCycleSource, releaseCycleSource,
  setCycleActive, clearCycleActive,
  initCycleHash, updateCycleHash,
  acquireMergeLock, getMergeLockHolder, releaseMergeLock,
} from "./redis-adapter.ts";
import { prepareWorkspace } from "./prepare-workspace.ts";
import { mergeToMain } from "./merge.ts";
import { validateDiffExists } from "./verifier.ts";
import { recordCycleMetrics, detectDrift } from "./metrics.ts";
import { recordPlannerLesson, recordExecutorLesson, recordReflection } from "./agent-memory.ts";
import { recordReflection as recordGlobalReflection } from "./reflections.ts";
import { runPlannerAgent } from "./planner-prompt.ts";
import { runExecutorAgent } from "./executor-agent.ts";
import { moveToInProgress, returnToBacklog } from "./backlog.ts";
import { createCycleSession } from "./ov-session.ts";
import { selectAnchor, trackAbandonment, clearProcessingItem, storePriorFailure } from "./anchor-selection.ts";
import { scoreAnchor, getMinConfidence, recordCalibrationOutcome } from "./anchor-scorer.ts";
import { classifyTaskComplexity, preflightCheck, runHighRiskReview } from "./preflight.ts";
import {
  groundProjectCached, generateCycleId, safeKanban, isAnchorStale,
  handleEarlyExit, PROJECT_WORKSPACE,
} from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";
import { runVerificationPipeline } from "./verification-pipeline.ts";
import { runPostMerge } from "./post-merge.ts";

// ---------------------------------------------------------------------------
// The control loop — replaces the 7-agent pipeline
// ---------------------------------------------------------------------------

/**
 * Run one cycle of the evidence-driven control loop.
 *
 * Flow: Ground → Anchor → Plan → Preflight → Execute → Verify → Merge → Report
 *
 * Only 2 codex agent calls (3 for high-risk, 4 if fixer runs):
 *   planner (frontier), executor (codex).
 * Verification and merge are command execution, not agents.
 *
 * @param {EventBus} eventBus
 * @param {object} opts - { anchor?: { type, reference }, maxRetries?: number }
 * @returns {LoopResult}
 */
export async function runControlLoop(eventBus: any, opts: Record<string, any> = {}) {
  const cycleId = generateCycleId();
  const startTime = Date.now();
  const tracker = getTracker();

  console.log(`[ControlLoop] Starting cycle ${cycleId}`);

  // Create OpenViking session for this cycle
  const ovSession = await createCycleSession(cycleId);

  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "cycle:start",
    source: "control-loop",
    correlationId: cycleId,
    payload: { cycleId },
  });

  // =========================================================================
  // Step 1a: PREPARE WORKSPACE
  // =========================================================================
  console.log(`[ControlLoop] Step 1a: Preparing workspace...`);
  const prep = await prepareWorkspace(PROJECT_WORKSPACE);
  if (!prep.cleaned) {
    console.log(`[ControlLoop] Workspace prep skipped: ${prep.reason}`);
  } else if (prep.staleBranchesDeleted > 0) {
    console.log(`[ControlLoop] Workspace prep deleted ${prep.staleBranchesDeleted} stale feature branches`);
  }

  // =========================================================================
  // Step 1b: GROUND — know the truth before planning (read-only)
  // =========================================================================
  console.log(`[ControlLoop] Step 1b: Grounding...`);
  const grounding = await groundProjectCached(PROJECT_WORKSPACE);
  const groundingSummary = summarizeForPrompt(grounding);
  console.log(`[ControlLoop] Grounded: ${grounding.testReport.passed} tests passing, ${grounding.testReport.failed} failing (${grounding.groundingDurationMs}ms)`);

  // =========================================================================
  // Step 2: SELECT ANCHOR
  // =========================================================================
  console.log(`[ControlLoop] Step 2: Selecting anchor...`);
  const anchor = await selectAnchor(grounding, opts, eventBus);

  if (!anchor) {
    console.log(`[ControlLoop] No actionable anchor found — cycle complete (no work needed)`);
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "cycle:completed",
      source: "control-loop",
      correlationId: cycleId,
      payload: { reason: "No actionable anchor found", tasksAttempted: 0 },
    });
    return { cycleId, tasks: [], reason: "No actionable anchor", durationMs: Date.now() - startTime };
  }
  console.log(`[ControlLoop] Anchor: [${anchor.type}] ${anchor.reference}`);

  // =========================================================================
  // Step 2.5: PRE-VALIDATE ANCHOR — skip stale/completed items before planner
  // =========================================================================
  const anchorStaleReason = await isAnchorStale(anchor);
  if (anchorStaleReason) {
    console.log(`[ControlLoop] Anchor pre-validation SKIPPED: ${anchorStaleReason}`);
    await handleEarlyExit({
      cycleId, startTime, grounding, ovSession, anchor,
      outcome: "skipped", reason: `Anchor stale: ${anchorStaleReason}`,
      metricsOverrides: { taskTitle: `Skipped: ${anchorStaleReason}`, anchorType: anchor.type, anchorReference: anchor.reference },
    });
    return { cycleId, tasks: [], reason: `Anchor stale: ${anchorStaleReason}`, durationMs: Date.now() - startTime };
  }

  // =========================================================================
  // Step 2.7: CONFIDENCE SCORING
  // =========================================================================
  let anchorConfidence: { score: number; reason: string; tier: "heuristic" | "classifier" } | null = null;
  try {
    anchorConfidence = await scoreAnchor(anchor, grounding);
    const minConf = getMinConfidence();
    console.log(`[ControlLoop] Anchor confidence: ${anchorConfidence.score.toFixed(2)} (${anchorConfidence.tier}) — ${anchorConfidence.reason}`);

    if (anchorConfidence.score < minConf) {
      console.log(`[ControlLoop] Anchor confidence ${anchorConfidence.score.toFixed(2)} < threshold ${minConf} — skipping`);
      await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, "no-task");
      await handleEarlyExit({
        cycleId, startTime, grounding, ovSession, anchor,
        outcome: "skipped", reason: `Low confidence: ${anchorConfidence.score.toFixed(2)} — ${anchorConfidence.reason}`,
        metricsOverrides: {
          taskTitle: `Skipped (low confidence): ${anchorConfidence.reason}`,
          anchorType: anchor.type, anchorReference: anchor.reference,
          anchorConfidence: anchorConfidence.score, anchorSkipped: true,
        },
      });
      return { cycleId, tasks: [], reason: `Anchor below confidence threshold (${anchorConfidence.score.toFixed(2)} < ${minConf})`, durationMs: Date.now() - startTime };
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Anchor scoring failed (proceeding anyway): ${err.message}`);
  }

  // =========================================================================
  // Step 3: PLAN — propose one bounded task (codex agent call)
  // =========================================================================
  console.log(`[ControlLoop] Step 3: Planning...`);
  const task = await runPlannerAgent(cycleId, anchor, grounding, ovSession);

  // Check for usage-limit sentinel
  if (task?.__usageLimitHit) {
    console.error(`[ControlLoop] Codex usage limit reached — pausing scheduler for 30 minutes`);
    await clearProcessingItem(anchor);
    await ovSession.logOutcome("usage-limit", "Codex usage limit hit — scheduler paused");
    await ovSession.commit();
    return { cycleId, tasks: [], reason: "Codex usage limit hit — scheduler paused", durationMs: Date.now() - startTime, __usageLimitHit: true };
  }

  if (!task) {
    console.log(`[ControlLoop] Planner produced no valid task — cycle complete`);

    // Circuit breaker: planner null counts as an abandonment
    try {
      const escalated = await trackAbandonment(anchor.reference, { title: anchor.reference, taskId: "none" }, "Planner produced no valid task (schema validation or parse failure)");
      if (escalated) {
        console.log(`[ControlLoop] Anchor "${anchor.reference}" escalated to reframe queue after repeated planner failures`);
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Circuit breaker tracking failed on null task: ${err.message}`);
    }

    await ovSession.logPlanner(anchor, null);
    // Record episodic reflections
    await recordReflection({
      cycleId, anchorRef: anchor.reference, taskTitle: "Planner produced no task",
      outcome: "no-task", reason: "Planner could not produce a valid task from this anchor",
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record reflection: ${err.message}`));
    await recordGlobalReflection({
      cycleId, anchorType: anchor.type, anchorReference: anchor.reference,
      failureMode: "no-task", whatFailed: "Planner produced no task",
      whyItFailed: "Planner could not produce a valid task from this anchor",
      whatToTryDifferently: "Anchor may be too vague, already completed, or blocked. Consider a more specific formulation.",
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record global reflection: ${err.message}`));

    if (anchorConfidence) {
      await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, "no-task");
    }
    await handleEarlyExit({
      cycleId, startTime, grounding, ovSession, anchor,
      outcome: "no-work", reason: "Planner produced no task",
      metricsOverrides: {
        tasksAbandoned: 1, taskTitle: "Planner produced no task",
        anchorType: anchor.type, anchorReference: anchor.reference,
        plannerModel: "unknown", abandonReason: "Planner produced no task",
        anchorConfidence: anchorConfidence?.score ?? null, anchorSkipped: false,
      },
    });
    return { cycleId, tasks: [], reason: "Planner produced no task", durationMs: Date.now() - startTime };
  }

  await ovSession.logPlanner(anchor, task);

  // Initialize task in Redis
  const taskId = `task-${cycleId}-1`;
  task.taskId = taskId;

  const CYCLE_SOURCE_TTL = 900;
  await registerCycleSource("codex", cycleId, CYCLE_SOURCE_TTL);

  await setCycleActive(cycleId);
  await initCycleHash(cycleId, {
    status: "running",
    startedAt: new Date().toISOString(),
    source: "codex",
    total: "1",
    completed: "0",
    failed: "0",
    abandoned: "0",
    timedOut: "0",
  }, CYCLE_KEY_TTL);
  await tracker.initTaskV2(cycleId, task);

  // All code after lock acquisition is wrapped in try/finally to guarantee
  // the distributed lock is released on every exit path.
  try {

  // =========================================================================
  // Step 3.1: CLASSIFY COMPLEXITY
  // =========================================================================
  const complexity = classifyTaskComplexity(task, anchor);
  const filesInScope = task.scopeBoundary?.in?.length || 0;
  const criteriaCount = task.acceptanceCriteria?.length || 0;
  console.log(`[ControlLoop] Task: "${task.title}" (anchor: ${task.anchorType}, confidence: ${task.confidence}, complexity: ${complexity}, scope: ${filesInScope} files, ${criteriaCount} criteria)`);
  if (complexity === "complex") {
    console.log(`[ControlLoop] COMPLEX task detected (${filesInScope} files, ${criteriaCount} criteria) — consider splitting in future cycles`);
  }

  // =========================================================================
  // Step 3.5: DRIFT DETECTION
  // =========================================================================
  const skipDrift = anchor.type === "prior-failure" || anchor.type === "user-request" || anchor.type === "reframe" || anchor.type === "codebase-health";
  const drift = skipDrift ? { isDuplicate: false } : await detectDrift(task);
  if (drift.isDuplicate) {
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
      await recordPlannerLesson(cycleId, task, "abandoned", { reason: `Drift: ${drift.reason}` });
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to record drift lesson: ${err.message}`);
    }
    try {
      // @ts-expect-error — migrate to proper types
      await trackAbandonment(anchor.reference, task, `Drift: ${drift.reason}`);
    } catch { /* intentional: best-effort tracking */ }
    await clearProcessingItem(anchor);
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
      cycleId,
    // @ts-expect-error — migrate to proper types
      tasks: [{ taskId, finalState: "abandoned", reason: `Drift: ${drift.reason}` }],
      durationMs: Date.now() - startTime,
    };
  }

  // =========================================================================
  // Step 4: PREFLIGHT GATE
  // =========================================================================
  let skepticResult;
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

  if (skepticResult.verdict === "reject") {
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
        await recordPlannerLesson(cycleId, task, "abandoned", { reason: `Review rejected: ${skepticResult.reason}` });
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to record rejection lessons: ${err.message}`);
    }

    try {
      await trackAbandonment(anchor.reference, task, skepticResult.reason);
    } catch (err: any) {
      console.error(`[ControlLoop] Circuit breaker tracking failed: ${err.message}`);
    }

    await handleEarlyExit({
      cycleId, startTime, grounding, ovSession, anchor,
      outcome: "abandoned", reason: `Rejected: ${skepticResult.reason}`,
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
      cycleId,
      tasks: [{ taskId, finalState: "abandoned", reason: skepticResult.reason }],
      durationMs: Date.now() - startTime,
    };
  }

  await tracker.transitionTask(taskId, "approved", { skepticVerdict: skepticResult });
  console.log(`[ControlLoop] APPROVED: ${skepticResult.reason || "no objections"}`);

  // =========================================================================
  // Step 5: EXECUTE — make the smallest change (codex agent call)
  // =========================================================================
  console.log(`[ControlLoop] Step 5: Executing...`);
  await tracker.transitionTask(taskId, "in-progress", {});
  await safeKanban(eventBus, cycleId, "moveToInProgress", anchor.reference, () => moveToInProgress(anchor.reference));

  const execResult = await runExecutorAgent(cycleId, task, grounding, groundingSummary, ovSession, complexity);
  await ovSession.logExecutor(execResult);

  // Validate a diff exists
  const hasDiff = await validateDiffExists(PROJECT_WORKSPACE);
  if (!hasDiff) {
    console.log(`[ControlLoop] Executor produced no code changes — failing task`);
    await tracker.transitionTask(taskId, "failed", { reason: "No code changes produced", execResult: { exitCode: execResult.exitCode, duration: execResult.duration } });
    await recordReflection({
      cycleId, anchorRef: anchor.reference, taskTitle: task.title,
      outcome: "no-diff", reason: "Executor ran but produced no code changes",
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record reflection: ${err.message}`));
    await recordGlobalReflection({
      cycleId, anchorType: anchor.type, anchorReference: anchor.reference,
      failureMode: "no-diff", whatFailed: task.title,
      whyItFailed: "Executor ran but produced no code changes",
      whatToTryDifferently: "Provide more specific scope boundary and acceptance criteria. Ensure the task is actionable.",
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record global reflection: ${err.message}`));
    await storePriorFailure(taskId, "No code changes produced", null);
    try {
      await recordPlannerLesson(cycleId, task, "failed", { failReason: "Executor produced no code changes" });
      await recordExecutorLesson(cycleId, task, "failed", { noDiff: true });
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to record no-diff lessons: ${err.message}`);
    }
    await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "no code changes"));
    await clearProcessingItem(anchor);
    await ovSession.logOutcome("failed", "Executor produced no code changes");
    await ovSession.commit();
    return {
      cycleId,
      tasks: [{ taskId, finalState: "failed", reason: "No code changes" }],
      durationMs: Date.now() - startTime,
    };
  }

  const diff = await getDiff(PROJECT_WORKSPACE, "main");
  await tracker.transitionTask(taskId, "changed-code", { diffLength: diff.length, filesChanged: execResult.filesChanged || [] });
  console.log(`[ControlLoop] Code changed (${diff.split("\n").length} diff lines)`);

  // =========================================================================
  // Steps 6–6.9: VERIFICATION PIPELINE
  // =========================================================================
  const ctx: CycleContext = { cycleId, startTime, grounding, groundingSummary, ovSession, eventBus, anchor, anchorConfidence };
  const vResult = await runVerificationPipeline(ctx, task, diff, execResult, complexity, filesInScope, criteriaCount, taskId);

  if (!vResult.passed) {
    return vResult.earlyReturn;
  }

  const { verification, reconciliation, mutationReport, jitReport } = vResult;

  // =========================================================================
  // Step 7: MERGE — git operation, NOT an agent
  // =========================================================================
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

  // =========================================================================
  // Step 8+: POST-MERGE — report, metrics, learning, adversarial, cleanup
  // =========================================================================
  const { report } = await runPostMerge(
    ctx, task, verification, mergeResult, execResult,
    complexity, filesInScope, criteriaCount, taskId,
    reconciliation, mutationReport, jitReport,
  );

  return report;

  } finally {
    // Commit OV session on crash paths
    if (ovSession.active) {
      await ovSession.logOutcome("crashed", "Cycle terminated by unhandled exception").catch(() => {});
      await ovSession.commit().catch((err: any) =>
        console.error(`[ControlLoop] OV session crash-commit failed: ${err.message}`)
      );
    }
    // Release per-source cycle registration + safety-net merge lock cleanup
    await releaseCycleSource("codex").catch((err: any) =>
      console.error(`[ControlLoop] Failed to release codex cycle registration: ${err.message}`)
    );
    await releaseMergeLock().catch((err: any) =>
      console.error(`[ControlLoop] Failed to release merge lock (safety net): ${err.message}`)
    );
  }
}
