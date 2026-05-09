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
  pushToWorkQueue, findWorkQueueDuplicate,
  getRecentReportIds, getRealityReport,
  markHealthAnchorResolved,
  getPatternCooldown, setPatternCooldown, pushAlert,
  indexWorkItem,
} from "./redis-adapter.ts";
import { recordCycleMetrics, getMetricsTrend } from "./metrics.ts";
import { recordCalibrationOutcome } from "./anchor-scorer.ts";
import { reportOutcome } from "./anchor-selection.ts";
import { clearOutcomes } from "./learning.ts";
import { complete, fail } from "./backlog.ts";
import { markTaskComplete } from "./specs.ts";
import { trackMergedCommit, _internal as _verificationInternal } from "./verification.ts";
import { PROJECT_WORKSPACE } from "./cycle-helpers.ts";
import type { CycleContext } from "./cycle-helpers.ts";

const execFileAsync = promisify(execFile);

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
const TARGET_PRIORITIES_PATH = resolve(PROJECT_WORKSPACE, "direction", "priorities.md");
const SOURCE_PRIORITIES_PATH = resolve(CONFIG_PATH, "direction", "priorities.md");

/**
 * Sync the orchestrator's priorities.md to the target project's direction/ folder.
 * This keeps ~/hydra-betting/direction/priorities.md current without requiring
 * a separate refresh agent run.
 */
async function syncTargetPriorities(): Promise<void> {
  const source = await readFile(SOURCE_PRIORITIES_PATH, "utf-8");
  if (!source || source.trim().length < 50) return;

  // Ensure target directory exists
  await mkdir(dirname(TARGET_PRIORITIES_PATH), { recursive: true });

  // Read current target to avoid unnecessary writes
  let current = "";
  try { current = await readFile(TARGET_PRIORITIES_PATH, "utf-8"); } catch { /* file may not exist */ }

  // Only write if content has actually changed (ignore frontmatter timestamp diffs)
  const stripFrontmatter = (s: string) => s.replace(/^---[\s\S]*?---\n*/m, "").trim();
  if (stripFrontmatter(source) === stripFrontmatter(current)) return;

  await writeFile(TARGET_PRIORITIES_PATH, source);
  console.log(`[ControlLoop] Synced priorities.md to target project`);
}

/**
 * Check if an adversarial finding overlaps a recently-merged task title.
 * Prevents queueing fix items for work already completed in a prior cycle.
 */
async function isAdversarialFindingAlreadyMerged(reference: string): Promise<boolean> {
  try {
    const reportIds = await getRecentReportIds(15);
    const refWords = new Set(reference.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length > 2));
    if (refWords.size === 0) return false;

    for (const rid of reportIds) {
      const raw = await getRealityReport(rid);
      if (!raw) continue;
      try {
        const report = JSON.parse(raw);
        if (!report.taskTitle || parseInt(report.tasksMerged || "0") === 0) continue;
        const mergedWords = new Set(report.taskTitle.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length > 2));
        const overlap = Array.from(refWords).filter((w: string) => mergedWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, mergedWords.size);
        if (similarity > 0.5) return true;
      } catch { /* intentional: skip unparseable reports */ }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Adversarial merge-dedup check failed (proceeding): ${err.message}`);
  }
  return false;
}

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
      await execFileAsync("git", ["stash", "--include-untracked"], { cwd: PROJECT_WORKSPACE, timeout: 10000 }).catch((err: any) =>
        console.error(`[ControlLoop] git stash during merge cleanup failed: ${err.message}`)
      );
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

  // If rolled back, record in report and prior-failure queue — but do NOT
  // transition the task state. "merged" is terminal in the task machine, so
  // attempting merged → failed is an illegal transition (issue #112).
  // The rollback is tracked via metrics (rolledBack: true, tasksRolledBack: 1)
  // and the prior-failure queue via reportOutcome.
  if (rolledBack) {
    report.task.finalState = "rolled-back";
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

    // Index merged task title into OV for semantic dedup of future queue items
    if (task?.title) {
      indexWorkItem(task.title, "merged").catch((err: any) => {
        console.error(`[ControlLoop] Failed to index merged title into OV: ${err.message}`);
      });
    }

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
  // Step 8.6: SYNC TARGET PRIORITIES
  // Keep ~/hydra-betting/direction/priorities.md in sync with the orchestrator's
  // canonical priorities after every merge. This ensures the target repo's
  // direction doc stays current for operator visibility.
  // =========================================================================
  if (finalState === "merged") {
    try {
      await syncTargetPriorities();
    } catch (err: any) {
      console.error(`[ControlLoop] Target priorities sync failed (non-fatal): ${err.message}`);
    }
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
          let queued = 0;
          for (const item of queueItems.slice(0, 3)) {
            // Dedup against existing work queue items
            const existingMatch = await findWorkQueueDuplicate(item.reference);
            if (existingMatch) {
              console.log(`[ControlLoop] Adversarial: skipped (queue dedup) — ${item.reference.slice(0, 80)}`);
              continue;
            }
            // Dedup against recently-merged tasks
            if (await isAdversarialFindingAlreadyMerged(item.reference)) {
              console.log(`[ControlLoop] Adversarial: skipped (already merged) — ${item.reference.slice(0, 80)}`);
              continue;
            }
            await pushToWorkQueue(JSON.stringify(item));
            queued++;
            console.log(`[ControlLoop] Adversarial: queued fix — ${item.reference.slice(0, 80)}`);
          }
          if (queued === 0) {
            console.log(`[ControlLoop] Adversarial: all ${queueItems.length} finding(s) already in queue — skipped`);
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

  await reportOutcome(anchor, { status: "skipped" });
  return { report };
}

// ---------------------------------------------------------------------------
// Pattern detection — inlined from pattern-detector.ts
// Runs after every cycle, checks for systemic issues across recent cycles.
// Cooldown-deduped: won't re-alert for the same pattern within 1 hour.
// ---------------------------------------------------------------------------

const PATTERN_WINDOW = 10;
const PATTERN_COOLDOWN_MS = 60 * 60 * 1000;

async function detectPatterns(eventBus: any, cycleId: string) {
  try {
    const trend = await getMetricsTrend(PATTERN_WINDOW);
    if (trend.length < 3) return;

    const alerts: { pattern: string; severity: string; message: string }[] = [];

    // 1. Low merge rate
    const merged = trend.filter(m => parseInt(m.tasksMerged) > 0).length;
    const mergeRate = Math.round(merged / trend.length * 100);
    if (mergeRate < 50) {
      alerts.push({
        pattern: "low_merge_rate",
        severity: "error",
        message: `Merge rate is ${mergeRate}% over last ${trend.length} cycles (${merged}/${trend.length} merged). Something is systematically failing.`,
      });
    }

    // 2. Consecutive failures (last 3+ cycles all non-merged)
    let consecutive = 0;
    for (let i = trend.length - 1; i >= 0; i--) {
      if (parseInt(trend[i].tasksMerged) > 0) break;
      consecutive++;
    }
    if (consecutive >= 3) {
      alerts.push({
        pattern: "consecutive_failures",
        severity: "error",
        message: `${consecutive} consecutive cycles without a merge. Last merged: ${trend.find(m => parseInt(m.tasksMerged) > 0)?.cycleId || "unknown"}.`,
      });
    }

    // 3. Recurring regressions
    const regressions = trend.filter(m => m.regressionIntroduced === "true" || m.regressionIntroduced === true).length;
    if (regressions >= 2) {
      alerts.push({
        pattern: "recurring_regressions",
        severity: "error",
        message: `${regressions} regressions in last ${trend.length} cycles. The executor is introducing test failures that get auto-reverted.`,
      });
    }

    // 4. Same anchor type failing repeatedly
    const failedAnchors = trend
      .filter(m => parseInt(m.tasksFailed) > 0 || parseInt(m.tasksAbandoned) > 0)
      .map(m => m.anchorReference)
      .filter(Boolean);
    const anchorCounts: Record<string, number> = {};
    for (const a of failedAnchors) {
      anchorCounts[a] = (anchorCounts[a] || 0) + 1;
    }
    for (const [anchor, count] of Object.entries(anchorCounts)) {
      if (count >= 3) {
        alerts.push({
          pattern: "anchor_stuck",
          severity: "warning",
          message: `Anchor "${anchor}" has failed ${count} times in last ${trend.length} cycles. The system may be stuck on this work item.`,
        });
      }
    }

    // 5. Test count declining
    const recent = trend.slice(-10);
    if (recent.length >= 5) {
      const highWater = Math.max(...recent.map(m => parseInt(m.testsAfter) || 0));
      const last = parseInt(recent[recent.length - 1].testsAfter) || 0;
      if (highWater > 0 && last < highWater - 20) {
        alerts.push({
          pattern: "test_decline",
          severity: "warning",
          message: `Test count dropped ${highWater - last} below peak: ${highWater} → ${last} over last ${recent.length} cycles.`,
        });
      }
    }

    // 6. High abandonment rate
    const abandoned = trend.filter(m => parseInt(m.tasksAbandoned) > 0).length;
    if (abandoned >= 4) {
      alerts.push({
        pattern: "high_abandonment",
        severity: "warning",
        message: `${abandoned}/${trend.length} cycles abandoned. The planner may be proposing work the skeptic keeps rejecting, or drift detection is too aggressive.`,
      });
    }

    // 7. File-level rework
    const fileCounts: Record<string, number> = {};
    for (const m of trend) {
      let files = m.filesChangedList;
      if (typeof files === "string") {
        try { files = JSON.parse(files); } catch { files = []; }
      }
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        if (typeof f !== "string" || f.includes(".test.")) continue;
        fileCounts[f] = (fileCounts[f] || 0) + 1;
      }
    }
    const hotFiles = Object.entries(fileCounts)
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]);
    if (hotFiles.length > 0) {
      const top3 = hotFiles.slice(0, 3).map(([file, count]) => `${file} (${count}x)`).join(", ");
      alerts.push({
        pattern: "file_rework",
        severity: "warning",
        message: `Rework detected: ${hotFiles.length} file(s) touched in 3+ of last ${trend.length} cycles. Hotspots: ${top3}. Consider architectural review.`,
      });
    }

    // 8. Rollback clustering
    const rollbacks = trend.filter(m => m.rolledBack === true || m.rolledBack === "true").length;
    if (rollbacks >= 3) {
      alerts.push({
        pattern: "rollback_cluster",
        severity: "error",
        message: `${rollbacks} rollbacks in last ${trend.length} cycles. The executor is repeatedly introducing regressions. Consider pausing and investigating.`,
      });
    }

    // 9. Disk space check
    try {
      const { stdout: dfOut } = await execFileAsync("df", ["--output=avail", "-B1", "/"]);
      const availBytes = parseInt(dfOut.trim().split("\n").pop() || "0");
      const availGB = availBytes / (1024 ** 3);
      if (availGB < 20) {
        alerts.push({
          pattern: "disk_low",
          severity: "error",
          message: `NVMe has only ${availGB.toFixed(1)}GB free (floor: 20GB). Move large files to /mnt/hydra-ssd or clean up.`,
        });
      }
    } catch { /* intentional: disk check is best-effort */ }

    // Publish alerts (with cooldown dedup)
    for (const alert of alerts) {
      const lastAlerted = await getPatternCooldown(alert.pattern);
      if (lastAlerted && Date.now() - parseInt(lastAlerted) < PATTERN_COOLDOWN_MS) {
        continue;
      }

      await setPatternCooldown(alert.pattern, Date.now().toString());

      const fullAlert = {
        id: `pattern-${alert.pattern}-${Date.now()}`,
        type: `pattern:${alert.pattern}`,
        timestamp: new Date().toISOString(),
        message: alert.message,
        severity: alert.severity,
        dismissed: false,
        payload: { pattern: alert.pattern, cycleId, window: PATTERN_WINDOW },
      };
      await pushAlert(JSON.stringify(fullAlert), 100);

      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: `pattern:${alert.pattern}`,
        source: "pattern-detector",
        correlationId: cycleId,
        payload: { message: alert.message, severity: alert.severity },
      });

      console.log(`[PatternDetector] ALERT: ${alert.message}`);
    }
  } catch (err: any) {
    console.error(`[PatternDetector] Failed: ${err.message}`);
  }
}
