/**
 * control-loop.ts — Pipeline orchestrator for the Hydra control loop
 *
 * Each Build Cycle step is an imported function with a consistent
 * (context) → StepResult interface. This file orchestrates the pipeline:
 *   load context → chain steps → handle transitions.
 *
 * Step functions live in:
 *   - pipeline-steps.ts       — plan handling, drift, preflight, execute, merge
 *   - cycle-helpers.ts        — grounding cache, anchor staleness, early exit
 *   - verification-pipeline.ts — steps 6 through 6.9
 *   - post-merge.ts           — step 8 (report, metrics, learning, adversarial)
 *
 * Only 2 codex agent calls per cycle (3 for high-risk, 4 if fixer runs):
 *   planner (frontier), executor (codex).
 */

import { STREAMS } from "./event-bus.ts";
import { getTracker, CYCLE_KEY_TTL } from "./task-tracker.ts";
import { summarizeForPrompt } from "./grounding.ts";
import {
  registerCycleSource, releaseCycleSource,
  setCycleActive,
  initCycleHash,
  releaseMergeLock,
} from "./redis-adapter.ts";
import { prepareWorkspace } from "./prepare-workspace.ts";
import { runPlannerAgent } from "./planner-prompt.ts";
import { selectAnchor, markLowConfidenceSkip } from "./anchor-selection.ts";
import { scoreAnchor, getMinConfidence, recordCalibrationOutcome } from "./anchor-scorer.ts";
import { classifyTaskComplexity } from "./preflight.ts";
import { autoDecomposeComplexTask } from "./auto-decompose.ts";
import { createCycleSession } from "./learning.ts";
import {
  groundProjectCached, generateCycleId, isAnchorStale,
  handleEarlyExit, PROJECT_WORKSPACE,
} from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";
import { runVerificationPipeline } from "./verification.ts";
import { runPostMerge } from "./post-merge.ts";
import {
  handlePlanResult,
  runDriftCheck,
  runPreflightGate,
  runExecuteStep,
  runMergeStep,
} from "./pipeline-steps.ts";
import { runCostCapCheck, getPerCycleCostCapUsd } from "./cost-cap.ts";

// ---------------------------------------------------------------------------
// The control loop — evidence-driven pipeline
// ---------------------------------------------------------------------------

/**
 * Run one cycle of the evidence-driven control loop.
 *
 * Flow: Ground → Anchor → Plan → Preflight → Execute → Verify → Merge → Report
 */
export async function runControlLoop(eventBus: any, opts: Record<string, any> = {}) {
  const cycleId = generateCycleId();
  const startTime = Date.now();
  const tracker = getTracker();

  console.log(`[ControlLoop] Starting cycle ${cycleId}`);
  const perCycleCostCapUsd = getPerCycleCostCapUsd();
  if (Number.isFinite(perCycleCostCapUsd)) {
    console.log(`[ControlLoop] Per-cycle cost cap: $${perCycleCostCapUsd.toFixed(2)} (HYDRA_PER_CYCLE_COST_CAP_USD)`);
  } else {
    console.log(`[ControlLoop] Per-cycle cost cap: disabled (HYDRA_PER_CYCLE_COST_CAP_USD=Infinity)`);
  }

  const ovSession = await createCycleSession(cycleId);

  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "cycle:start",
    source: "control-loop",
    correlationId: cycleId,
    payload: { cycleId },
  });

  // Step 1a: PREPARE WORKSPACE
  console.log(`[ControlLoop] Step 1a: Preparing workspace...`);
  const prep = await prepareWorkspace(PROJECT_WORKSPACE);
  if (!prep.cleaned) {
    console.log(`[ControlLoop] Workspace prep skipped: ${prep.reason}`);
  } else if (prep.staleBranchesDeleted > 0) {
    console.log(`[ControlLoop] Workspace prep deleted ${prep.staleBranchesDeleted} stale feature branches`);
  }

  // Step 1b: GROUND — know the truth before planning (read-only)
  console.log(`[ControlLoop] Step 1b: Grounding...`);
  const grounding = await groundProjectCached(PROJECT_WORKSPACE);
  const groundingSummary = summarizeForPrompt(grounding);
  console.log(`[ControlLoop] Grounded: ${grounding.testReport.passed} tests passing, ${grounding.testReport.failed} failing (${grounding.groundingDurationMs}ms)`);

  // Step 2: SELECT ANCHOR
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

  // Step 2.5: PRE-VALIDATE ANCHOR — skip stale/completed items before planner
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

  // Step 2.7: CONFIDENCE SCORING
  let anchorConfidence: { score: number; reason: string; tier: "heuristic" | "classifier" } | null = null;
  try {
    anchorConfidence = await scoreAnchor(anchor, grounding);
    const minConf = getMinConfidence();
    console.log(`[ControlLoop] Anchor confidence: ${anchorConfidence.score.toFixed(2)} (${anchorConfidence.tier}) — ${anchorConfidence.reason}`);

    if (anchorConfidence.score < minConf) {
      console.log(`[ControlLoop] Anchor confidence ${anchorConfidence.score.toFixed(2)} < threshold ${minConf} — skipping`);
      await markLowConfidenceSkip(anchor);
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

  // Step 3: PLAN — propose one bounded task (codex agent call)
  console.log(`[ControlLoop] Step 3: Planning...`);
  let task: any = await runPlannerAgent(cycleId, anchor, grounding, ovSession);

  const planResult = await handlePlanResult(
    { cycleId, startTime, grounding, groundingSummary, ovSession, eventBus, anchor, anchorConfidence },
    task,
    anchorConfidence,
  );
  if (!planResult.continue) return planResult.result;

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

  // Build the shared cycle context for pipeline steps
  const ctx: CycleContext = { cycleId, startTime, grounding, groundingSummary, ovSession, eventBus, anchor, anchorConfidence };

  // Step 3.1: CLASSIFY COMPLEXITY
  let complexity = classifyTaskComplexity(task, anchor);
  let filesInScope = task.scopeBoundary?.in?.length || 0;
  let criteriaCount = task.acceptanceCriteria?.length || 0;
  console.log(`[ControlLoop] Task: "${task.title}" (anchor: ${task.anchorType}, confidence: ${task.confidence}, complexity: ${complexity}, scope: ${filesInScope} files, ${criteriaCount} criteria)`);

  // Step 3.2: AUTO-DECOMPOSE — complex tasks (>5 files) are auto-split into specs
  // instead of being sent to the executor, which has a 0% merge rate on 5+ file tasks.
  //
  // Issue #194: Previously we returned early after creating the spec, abandoning
  // the cycle. That wasted the planner cost and accounted for ~30% of recent
  // abandoned cycles. We now continue execution with the first sub-task in the
  // SAME cycle so the planner spend produces a merged change.
  if (complexity === "complex") {
    const decomposeResult = await autoDecomposeComplexTask(task);
    if (decomposeResult) {
      console.log(`[ControlLoop] Complex task auto-decomposed into spec "${decomposeResult.spec.slug}" with ${decomposeResult.taskCount} tasks — continuing cycle with first sub-task`);
      // Carry planner attribution from the parent so cost/cache metrics
      // remain accurate for the cycle.
      const parentMeta = {
        __plannerModel: task.__plannerModel,
        __planCacheHit: task.__planCacheHit,
        taskId: task.taskId,
      };
      task = { ...decomposeResult.firstTask, ...parentMeta };
      // Refresh the tracker hash so downstream readers (metrics, dashboard,
      // event bus consumers) see the sub-task title/scope, not the parent.
      await tracker.initTaskV2(cycleId, task);
      // Re-classify the sub-task (it should be quick-fix or standard now).
      complexity = classifyTaskComplexity(task, anchor);
      filesInScope = task.scopeBoundary?.in?.length || 0;
      criteriaCount = task.acceptanceCriteria?.length || 0;
      console.log(`[ControlLoop] Continuing with sub-task: "${task.title}" (complexity: ${complexity}, scope: ${filesInScope} files, ${criteriaCount} criteria)`);

      // Infinite-recursion guard: if the first sub-task ALSO classifies as
      // complex (e.g. parent had ~12 files and the 1-2-file split somehow
      // ended up being judged complex by criteria count), do NOT decompose
      // again — log and proceed to preflight/executor anyway. Quality gates
      // downstream will still block a bad merge.
      if (complexity === "complex") {
        console.warn(`[ControlLoop] WARN: first sub-task of decomposed spec still classifies as complex — proceeding without further decomposition to avoid recursion`);
      }
    } else {
      // If decomposition failed (e.g. spec already exists), proceed normally
      console.log(`[ControlLoop] COMPLEX task detected (${filesInScope} files, ${criteriaCount} criteria) — decomposition skipped, proceeding to executor`);
    }
  }

  // Step 3.5: DRIFT DETECTION
  const driftResult = await runDriftCheck(ctx, task, taskId);
  if (!driftResult.continue) return driftResult.result;

  // Step 4: PREFLIGHT GATE
  const preflightResult = await runPreflightGate(ctx, task, complexity, groundingSummary, taskId);
  if (!preflightResult.continue) return preflightResult.result;

  // Step 4.5: COST CAP — bail BEFORE executor (cheapest exit) if planner +
  // preflight already burned the per-cycle budget. Issue #209: top abandoned
  // cycles consumed up to $56 each; this is the dominant cost-leak class.
  const preExecCapCheck = await runCostCapCheck(ctx, task, taskId, "post-preflight");
  if (preExecCapCheck.continue === false) return preExecCapCheck.result;

  // Step 5: EXECUTE — make the smallest change (codex agent call)
  const executeResult = await runExecuteStep(ctx, task, groundingSummary, complexity, taskId);
  if (!executeResult.continue) return executeResult.result;

  // Step 5.5: COST CAP — re-check after executor. Even though we bailed
  // pre-executor, an expensive executor call can blow past the cap and we
  // shouldn't pay for fixer / mutation / jit on top.
  const postExecCapCheck = await runCostCapCheck(ctx, task, taskId, "post-executor");
  if (postExecCapCheck.continue === false) return postExecCapCheck.result;

  const { execResult, diff, scopeFilterCleaned } = executeResult;

  // Steps 6–6.9: VERIFICATION PIPELINE
  const vResult = await runVerificationPipeline(ctx, task, diff, execResult, complexity, filesInScope, criteriaCount, taskId);

  if (!vResult.passed) {
    return vResult.earlyReturn;
  }

  const { verification, reconciliation, mutationReport, jitReport, fixerUsed, fixerResolved } = vResult;

  // Step 7: MERGE — git operation, NOT an agent
  const mergeStepResult = await runMergeStep(ctx, task, taskId);
  const mergeResult = mergeStepResult.continue ? (mergeStepResult as any).mergeResult : { ok: false, commitSha: "", featureBranch: null, error: "Merge step stopped" };

  // Step 8+: POST-MERGE — report, metrics, learning, adversarial, cleanup
  const { report } = await runPostMerge(
    ctx, task, verification, mergeResult, execResult,
    complexity, filesInScope, criteriaCount, taskId,
    reconciliation, mutationReport, jitReport,
    scopeFilterCleaned || 0, fixerUsed || false, fixerResolved || false,
  );

  return report;

  } finally {
    // Commit OV session on crash paths
    if (ovSession.active) {
      await ovSession.logOutcome("crashed", "Cycle terminated by unhandled exception").catch((err: any) =>
        console.error(`[ControlLoop] OV session crash-logOutcome failed: ${err.message}`)
      );
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
