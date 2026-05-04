/**
 * post-merge.ts — Step 8 of the control loop: reporting, metrics, learning, adversarial
 *
 * Extracted from control-loop.ts (issue #1, Module 6). Contains:
 *   - Post-merge grounding + auto-rollback
 *   - Reality report construction + save to Redis
 *   - Cycle metrics recording
 *   - Calibration outcome recording
 *   - Pattern detection
 *   - OV resource marking
 *   - Kanban state updates (moveToDone / returnToBacklog)
 *   - OV session learning commit
 *   - Adversarial validation + work queue
 *   - Meta analysis triggering
 *   - Cycle completion bookkeeping
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.ts";
import { getTracker, CYCLE_KEY_TTL } from "./task-tracker.ts";
import { groundProject } from "./grounding.ts";
import {
  updateCycleHash, refreshCycleTTL,
  setCycleLast, clearCycleActive,
  saveRealityReport, trimRealityReports,
  pushToWorkQueue,
  markHealthAnchorResolved,
} from "./redis-adapter.ts";
import { recordCycleMetrics } from "./metrics.ts";
import { recordCalibrationOutcome } from "./anchor-scorer.ts";
import { clearProcessingItem, reportOutcome } from "./anchor-selection.ts";
import { clearOutcomes } from "./learning.ts";
import { complete, fail } from "./backlog.ts";
import { detectPatterns } from "./pattern-detector.ts";
import { markTaskComplete } from "./specs.ts";
import { trackMergedCommit, _internal as _verificationInternal } from "./verification.ts";
import { PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

const execFileAsync = promisify(execFile);

export interface PostMergeResult {
  report: any;
}

/**
 * Run all post-merge steps (step 8 and beyond).
 *
 * @param ctx            — shared cycle context
 * @param task           — planner task
 * @param verification   — final verification result
 * @param mergeResult    — result from mergeToMain()
 * @param execResult     — executor result (for metrics)
 * @param complexity     — task complexity classification
 * @param filesInScope   — number of files in scope boundary
 * @param criteriaCount  — number of acceptance criteria
 * @param taskId         — task identifier
 * @param reconciliation — plan vs actual reconciliation
 * @param mutationReport — mutation testing report (may be null)
 * @param jitReport      — JIT testing report (may be null)
 */
export async function runPostMerge(
  ctx: CycleContext,
  task: any,
  verification: any,
  mergeResult: any,
  execResult: any,
  complexity: string,
  filesInScope: number,
  criteriaCount: number,
  taskId: string,
  reconciliation: any,
  mutationReport: any,
  jitReport: any,
): Promise<PostMergeResult> {
  const { cycleId, startTime, grounding, ovSession, eventBus, anchor, anchorConfidence } = ctx;
  const tracker = getTracker();
  let commitSha = "";

  if (mergeResult.ok) {
    commitSha = mergeResult.commitSha;
    if (mergeResult.featureBranch) {
      console.log(`[ControlLoop] Merged ${mergeResult.featureBranch} → main (${commitSha.slice(0, 7)})`);
    } else {
      console.log(`[ControlLoop] Already on main, pushed (${commitSha.slice(0, 7)})`);
    }
    await tracker.transitionTask(taskId, "merged", { commitSha });

    // Restart the web service so it picks up the new build artifacts.
    try {
      await execFileAsync("systemctl", ["--user", "restart", "hydra-betting-web.service"], { timeout: 120_000 });
      console.log(`[ControlLoop] Restarted hydra-betting-web.service after merge`);
    } catch (restartErr: any) {
      console.error(`[ControlLoop] Failed to restart hydra-betting-web.service: ${restartErr.message}`);
    }
  } else {
    console.error(`[ControlLoop] Merge failed: ${mergeResult.error}`);

    // Clean up the dirty working tree
    try {
      const { stdout: stuckBranch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
      const stuck = stuckBranch.trim();
      await execFileAsync("git", ["stash", "--include-untracked"], { cwd: PROJECT_WORKSPACE, timeout: 10000 }).catch(() => {});
      await execFileAsync("git", ["checkout", "main"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
      await execFileAsync("git", ["checkout", "."], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
      if (stuck && stuck !== "main") {
        await execFileAsync("git", ["branch", "-D", stuck], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
        console.log(`[ControlLoop] Cleaned up failed-merge branch ${stuck}`);
      }
    } catch (cleanupErr: any) {
      console.error(`[ControlLoop] Failed-merge cleanup failed (may leave dirty tree): ${cleanupErr.message}`);
    }

    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:merge_failed",
      source: "control-loop",
      correlationId: cycleId,
      payload: { taskId, title: task.title, error: mergeResult.error },
    });
  }

  // =========================================================================
  // Step 8: REPORT — reality report
  // =========================================================================
  console.log(`[ControlLoop] Step 8: Reporting...`);
  const finalGrounding = await groundProject(PROJECT_WORKSPACE);
  const regressionIntroduced = finalGrounding.testReport.passed < grounding.testReport.passed;

  // Auto-rollback: if tests regressed after merge, revert the merge commit
  let rolledBack = false;
  if (regressionIntroduced && commitSha) {
    console.error(`[ControlLoop] REGRESSION: Tests went from ${grounding.testReport.passed} → ${finalGrounding.testReport.passed} passing — auto-reverting`);
    try {
      await execFileAsync("git", ["revert", "--no-edit", "-m", "1", commitSha], { cwd: PROJECT_WORKSPACE, timeout: 30000 });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: PROJECT_WORKSPACE, timeout: 30000 });
      rolledBack = true;
      console.log(`[ControlLoop] Reverted merge commit ${commitSha.slice(0, 7)} and pushed`);

      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "cycle:rollback",
        source: "control-loop",
        correlationId: cycleId,
        payload: {
          cycleId,
          taskId,
          title: task.title,
          revertedCommit: commitSha,
          testsBefore: grounding.testReport.passed,
          testsAfter: finalGrounding.testReport.passed,
        },
      });
    } catch (err: any) {
      console.error(`[ControlLoop] Auto-rollback failed: ${err.message}`);
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "cycle:rollback_failed",
        source: "control-loop",
        correlationId: cycleId,
        payload: {
          cycleId,
          taskId,
          title: task.title,
          commitSha,
          error: err.message,
          testsBefore: grounding.testReport.passed,
          testsAfter: finalGrounding.testReport.passed,
        },
      });
    }
  } else if (regressionIntroduced) {
    console.error(`[ControlLoop] REGRESSION: Tests went from ${grounding.testReport.passed} → ${finalGrounding.testReport.passed} passing (no commit to revert)`);
  }

  // Compute unresolved uncertainty and rollback risk
  const typecheckDegraded = finalGrounding.typecheckReport.exitCode !== 0 && grounding.typecheckReport.exitCode === 0;
  const newDirtyFiles = finalGrounding.dirtyFiles.filter((f: string) => !grounding.dirtyFiles.includes(f));
  const unresolvedUncertainty: string[] = [];
  if (regressionIntroduced) unresolvedUncertainty.push(`Tests regressed: ${grounding.testReport.passed} → ${finalGrounding.testReport.passed}`);
  if (typecheckDegraded) unresolvedUncertainty.push("Typecheck was clean before but has errors now");
  if (newDirtyFiles.length > 0) unresolvedUncertainty.push(`${newDirtyFiles.length} new uncommitted files after merge`);

  const rollbackRisk = regressionIntroduced ? "high" : typecheckDegraded ? "medium" : "low";

  const report: any = {
    cycleId,
    anchor,
    task: {
      taskId,
      title: task.title,
      anchorType: task.anchorType,
      confidence: task.confidence,
      finalState: commitSha ? "merged" : "verified",
    },
    grounding: {
      before: { passed: grounding.testReport.passed, failed: grounding.testReport.failed, typecheckClean: grounding.typecheckReport.exitCode === 0 },
      after: { passed: finalGrounding.testReport.passed, failed: finalGrounding.testReport.failed, typecheckClean: finalGrounding.typecheckReport.exitCode === 0 },
    },
    regressionIntroduced,
    verification: {
      allPassed: verification.allPassed,
      steps: verification.steps.map((s: any) => ({ label: s.label, passed: s.passed, duration: s.durationMs })),
      commandsRun: verification.steps.map((s: any) => s.command),
    },
    commitSha,
    filesChanged: verification.filesChanged,
    reconciliation: {
      aligned: reconciliation.aligned,
      scopeCreep: reconciliation.scopeCreep,
      scopeGaps: reconciliation.scopeGaps,
      warnings: reconciliation.warnings,
    },
    mutationTesting: mutationReport ? {
      totalMutants: mutationReport.totalMutants,
      killed: mutationReport.killed,
      survived: mutationReport.survived,
      killRate: mutationReport.totalMutants > 0
        ? Math.round((mutationReport.killed / (mutationReport.totalMutants - mutationReport.skipped)) * 100)
        : 100,
      timedOut: mutationReport.timedOut,
      durationMs: mutationReport.durationMs,
      survivors: mutationReport.survivors.slice(0, 5).map((s: any) => ({
        file: s.mutation.file,
        line: s.mutation.line,
        type: s.mutation.type,
      })),
    } : null,
    jitTesting: jitReport ? {
      generated: jitReport.generated,
      kept: jitReport.kept,
      discarded: jitReport.discarded,
      caughtBug: jitReport.caughtBug,
      durationMs: jitReport.durationMs,
    } : null,
    adversarialValidation: null as any,
    unresolvedUncertainty,
    rollbackRisk,
    rolledBack,
    durationMs: Date.now() - startTime,
    durations: {
      grounding: grounding.groundingDurationMs,
      planning: 0,
      verification: verification.totalDurationMs,
    },
    recommendedNext: rolledBack
      ? "Regression auto-reverted — investigate root cause before retrying"
      : regressionIntroduced
      ? "URGENT: Fix regression — auto-rollback failed, manual intervention needed"
      : unresolvedUncertainty.length > 0
      ? `Resolve uncertainty: ${unresolvedUncertainty[0]}`
      : "Continue with next priority",
  };

  // If rolled back, update task state and store as prior-failure
  if (rolledBack) {
    report.task.finalState = "rolled-back";
    await tracker.transitionTask(taskId, "failed", { reason: "Regression detected — auto-reverted", rolledBack: true, revertedCommit: commitSha });
    await reportOutcome(anchor, { status: "failed", reason: `Regression: tests ${grounding.testReport.passed} → ${finalGrounding.testReport.passed}`, verification, taskId });
  }

  // Write reality report to Redis
  await saveRealityReport(cycleId, JSON.stringify(report), CYCLE_KEY_TTL);
  await trimRealityReports(50);

  // Publish notification
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "cycle:completed",
    source: "control-loop",
    correlationId: cycleId,
    payload: report,
  });

  console.log(`[ControlLoop] Cycle ${cycleId} complete — ${report.task.finalState} in ${report.durationMs}ms`);

  // Record structured metrics
  await recordCycleMetrics(cycleId, {
    tasksAttempted: 1,
    tasksVerified: commitSha ? 1 : 0,
    tasksMerged: (commitSha && !rolledBack) ? 1 : 0,
    tasksFailed: rolledBack ? 1 : 0,
    tasksRolledBack: rolledBack ? 1 : 0,
    tasksAbandoned: 0,
    testsBefore: grounding.testReport.passed,
    testsAfter: finalGrounding.testReport.passed,
    testsPassingBefore: grounding.testReport.passed,
    testsPassingAfter: finalGrounding.testReport.passed,
    filesChanged: verification.filesChanged.length,
    filesChangedList: verification.filesChanged || [],
    totalDurationMs: Date.now() - startTime,
    groundingDurationMs: grounding.groundingDurationMs,
    verificationDurationMs: verification.totalDurationMs,
    regressionIntroduced,
    rolledBack,
    rollbackRisk,
    unresolvedUncertaintyCount: unresolvedUncertainty.length,
    taskTitle: task.title,
    anchorType: task.anchorType,
    anchorReference: task.anchorReference,
    complexity, filesInScope, criteriaCount,
    plannerModel: task.__plannerModel || "unknown",
    executorModel: execResult?.__executorModel || "unknown",
    jitTestsGenerated: jitReport?.generated || 0,
    jitTestsKept: jitReport?.kept || 0,
    jitTestsCaughtBug: jitReport?.caughtBug ? 1 : 0,
    anchorConfidence: anchorConfidence?.score ?? null,
    anchorSkipped: false,
  });

  // Step 8.0.5: Calibration
  if (anchorConfidence) {
    const calOutcome = (commitSha && !rolledBack) ? "merged" : "failed";
    await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, calOutcome);
  }

  // Step 8.1: Pattern detection
  await detectPatterns(eventBus, cycleId);

  // Step 8.2: Tell OV which resources were used
  if (commitSha && !rolledBack && verification.filesChanged?.length > 0) {
    const usedUris = verification.filesChanged
      .map((f: string) => `viking://resources/hydra/config/${f.replace(/^config\//, "")}`)
      .filter((uri: string) => uri.includes("/"));
    await ovSession.markUsed(usedUris);
  }

  // Kanban updates
  const finalState = rolledBack ? "rolled-back" : (commitSha ? "merged" : "verified");
  if (finalState === "merged") {
    try { await reportOutcome(anchor, { status: "merged" }); } catch { /* intentional: best-effort cleanup */ }
    try { await clearOutcomes(anchor.reference); } catch { /* intentional: best-effort cleanup */ }

    if (anchor.type === "codebase-health") {
      try {
        await markHealthAnchorResolved(anchor.reference);
        console.log(`[ControlLoop] Marked codebase-health anchor as resolved: "${anchor.reference}"`);
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to mark health anchor resolved: ${err.message}`);
      }
    }

    if (anchor.context?.specSlug && anchor.context?.specTaskId) {
      try {
        await markTaskComplete(anchor.context.specSlug, anchor.context.specTaskId, cycleId);
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to update spec "${anchor.context.specSlug}": ${err.message}`);
      }
    }

    await complete(anchor.reference, "merged", { eventBus, cycleId });
  } else {
    await fail(anchor.reference, finalState, { eventBus, cycleId });
  }

  // =========================================================================
  // Step 8.7: ADVERSARIAL VALIDATION
  // =========================================================================
  if (commitSha && !rolledBack && verification.filesChanged?.length > 0) {
    try {
      console.log(`[ControlLoop] Step 8.7: Running adversarial validation...`);
      const advReport = await _verificationInternal.runAdversarialValidation(cycleId, task.title, verification.filesChanged, commitSha);
      if (advReport.findings.length > 0) {
        console.log(`[ControlLoop] Adversarial: ${advReport.findings.length} finding(s) — ${advReport.findings.filter((f: any) => f.severity === "high").length} high, ${advReport.findings.filter((f: any) => f.severity === "medium").length} medium`);
        const queueItems = _verificationInternal.findingsToQueueItems(advReport);
        if (queueItems.length > 0) {
          for (const item of queueItems.slice(0, 3)) {
            await pushToWorkQueue(JSON.stringify(item));
            console.log(`[ControlLoop] Adversarial: queued fix — ${item.reference.slice(0, 80)}`);
          }
        }
        report.adversarialValidation = {
          findings: advReport.findings.length,
          high: advReport.findings.filter((f: any) => f.severity === "high").length,
          medium: advReport.findings.filter((f: any) => f.severity === "medium").length,
          queued: queueItems.length,
          durationMs: advReport.durationMs,
        };
      } else {
        console.log(`[ControlLoop] Adversarial: no findings (${advReport.durationMs}ms)`);
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Adversarial validation failed (non-fatal): ${err.message}`);
    }

    try {
      await trackMergedCommit(cycleId, commitSha, []);
    } catch { /* intentional: tracking is best-effort */ }
  }

  try {
    await _verificationInternal.checkRevertCorrelation(PROJECT_WORKSPACE);
  } catch { /* intentional: correlation check is best-effort */ }

  // Complete the cycle in tracker
  await updateCycleHash(cycleId, { status: "completed", completedAt: new Date().toISOString() });
  await refreshCycleTTL(cycleId, CYCLE_KEY_TTL);
  await setCycleLast(cycleId);
  await clearCycleActive();

  // Trigger Meta analysis
  try {
    const { getMetricsTrend } = await import("./metrics.ts");
    const trend = await getMetricsTrend(20);
    const recentFailures = trend.slice(0, 5).filter((m: any) => m.tasksFailed > 0).length;
    const totalCycles = trend.length;

    if (totalCycles >= 5 && recentFailures >= 2) {
      console.log(`[ControlLoop] Triggering Meta analysis — fast-path (${recentFailures} failures in last 5 cycles)`);
      await eventBus.publish(STREAMS.META, {
        type: "cycle:report",
        source: "control-loop",
        correlationId: cycleId,
        payload: { trigger: "failure_fast_path", recentFailures },
      });
    } else if (totalCycles >= 20 && totalCycles % 20 === 0) {
      console.log(`[ControlLoop] Triggering Meta analysis — periodic review (cycle ${totalCycles})`);
      await eventBus.publish(STREAMS.META, {
        type: "cycle:report",
        source: "control-loop",
        correlationId: cycleId,
        payload: { trigger: "periodic_review", totalCycles },
      });
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Meta trigger check failed: ${err.message}`);
  }

  // Commit OV session
  const cycleOutcome = report.task?.finalState || "unknown";
  await ovSession.logOutcome(cycleOutcome, `${task.title} — ${report.durationMs}ms`);
  await ovSession.commit();

  await clearProcessingItem(anchor);
  return { report };
}
