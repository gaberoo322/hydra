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

import * as Sentry from "@sentry/node";
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
    await recordOutcome({
      agents: [],
      cycleId, task: { title: "Planner produced no task" }, finalState: "abandoned",
      anchorRef: anchor.reference, anchorType: anchor.type,
      reflection: {
        failureMode: "no-task", whatFailed: "Planner produced no task",
        whyItFailed: "Planner could not produce a valid task from this anchor",
        whatToTryDifferently: "Anchor may be too vague, already completed, or blocked. Consider a more specific formulation.",
      },
    });

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
  await recordOutcome({
    agents: ["planner"],
    cycleId, task, finalState: "abandoned",
    anchorRef: anchor.reference, anchorType: anchor.type,
    // @ts-expect-error — migrate to proper types
    context: { reason: `Drift: ${drift.reason}` },
  });
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
  if (isJudgmentRejection) {
    await recordOutcome({
      agents: ["planner"],
      cycleId, task, finalState: "abandoned",
      anchorRef: anchor.reference, anchorType: anchor.type,
      context: { reason: `Review rejected: ${skepticResult.reason}` },
    });
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
// Scope creep filter — reset out-of-scope files before verification (issue #58)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Identify files changed vs main that are outside the planned scope boundary.
 *
 * Pure function (testable without git). Test files (.test.) are excluded from
 * cleanup — the executor is expected to create tests even if they weren't
 * explicitly listed in scopeBoundary.in.
 *
 * @param changedFiles — list of files from `git diff --name-only main`
 * @param scopeIn     — task.scopeBoundary.in (planned files to modify)
 * @returns files that should be reset (outside scope, not test files)
 */
export function identifyOutOfScopeFiles(changedFiles: string[], scopeIn: string[]): string[] {
  if (!scopeIn || scopeIn.length === 0) return [];

  const scopeSet = new Set(scopeIn);
  // Also normalize without leading "web/" to handle path prefix mismatches
  const scopeNormalized = new Set(scopeIn.map((f) => f.replace(/^web\//, "")));

  return changedFiles.filter((f) => {
    // Test files are always allowed — executor is expected to create/modify tests
    if (f.includes(".test.")) return false;

    // Exact match against scope
    if (scopeSet.has(f)) return false;

    // Normalized match (handles web/ prefix mismatch)
    const normalized = f.replace(/^web\//, "");
    if (scopeNormalized.has(normalized)) return false;

    // Partial match: scope entry is a directory prefix or vice versa
    for (const s of scopeIn) {
      const sNorm = s.replace(/^web\//, "");
      if (normalized.startsWith(sNorm) || sNorm.startsWith(normalized)) return false;
    }

    return true;
  });
}

/**
 * Clean out-of-scope file changes from the working tree before verification.
 *
 * For each file outside the planned scope boundary, runs `git checkout main -- <file>`
 * to discard the executor's changes. This prevents scope creep (auto-formatted files,
 * dirty worktree artifacts, codegen side effects) from leaking into the merge.
 *
 * Never throws — logs errors and returns a result object.
 */
export async function cleanOutOfScopeChanges(
  projectDir: string,
  scopeIn: string[],
): Promise<{ cleaned: string[]; errors: string[] }> {
  if (!scopeIn || scopeIn.length === 0) {
    return { cleaned: [], errors: [] };
  }

  // Get all files changed vs main
  let changedFiles: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "main"], {
      cwd: projectDir,
      timeout: 10000,
    });
    changedFiles = stdout.trim().split("\n").filter(Boolean);
  } catch (err: any) {
    console.error(`[ScopeFilter] Failed to get diff vs main: ${err.message}`);
    return { cleaned: [], errors: [`diff failed: ${err.message}`] };
  }

  // Also include untracked files (new files not yet committed)
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: projectDir,
      timeout: 10000,
    });
    const untracked = stdout.trim().split("\n").filter(Boolean);
    changedFiles = [...new Set([...changedFiles, ...untracked])];
  } catch (err: any) {
    console.error(`[ScopeFilter] Failed to list untracked files: ${err.message}`);
  }

  const outOfScope = identifyOutOfScopeFiles(changedFiles, scopeIn);
  if (outOfScope.length === 0) {
    return { cleaned: [], errors: [] };
  }

  console.log(`[ScopeFilter] Cleaning ${outOfScope.length} out-of-scope file(s): ${outOfScope.slice(0, 5).join(", ")}${outOfScope.length > 5 ? ` (+${outOfScope.length - 5} more)` : ""}`);

  const cleaned: string[] = [];
  const errors: string[] = [];

  for (const file of outOfScope) {
    try {
      // Try to reset the file to main. If the file is new (not in main),
      // this will fail — in that case, remove it from the index and working tree.
      await execFileAsync("git", ["checkout", "main", "--", file], {
        cwd: projectDir,
        timeout: 5000,
      });
      cleaned.push(file);
    } catch {
      // File doesn't exist on main — it's a new file added by the executor outside scope.
      // Remove it from the working tree.
      try {
        await execFileAsync("git", ["rm", "-f", "--", file], {
          cwd: projectDir,
          timeout: 5000,
        });
        cleaned.push(file);
      } catch (rmErr: any) {
        errors.push(`${file}: ${rmErr.message}`);
        console.error(`[ScopeFilter] Failed to clean ${file}: ${rmErr.message}`);
      }
    }
  }

  if (cleaned.length > 0) {
    console.log(`[ScopeFilter] Cleaned ${cleaned.length} out-of-scope file(s)`);
  }

  return { cleaned, errors };
}

// ---------------------------------------------------------------------------
// validateDiffExists — simple git check (moved from verifier.ts, issue #66)
// ---------------------------------------------------------------------------

/**
 * Validate that a git diff exists (actual code changes were made).
 * Used to gate the transition from in-progress to changed-code.
 * When featureBranch is provided, also checks committed changes on that branch
 * vs base — this handles the case where worktree checkout back to main workspace failed.
 */
async function validateDiffExists(projectDir: string, baseBranch = "main", featureBranch?: string) {
  try {
    // Check for uncommitted changes
    const { stdout: status } = await execFileAsync("git", ["status", "--short"], {
      cwd: projectDir,
      timeout: 5000,
    });
    if (status.trim()) return true;

    // Check for committed changes vs base branch (current HEAD)
    const { stdout: diff } = await execFileAsync("git", ["diff", "--stat", baseBranch], {
      cwd: projectDir,
      timeout: 10000,
    });
    if (diff.trim().length > 0) return true;

    // If workspace checkout failed, check the feature branch directly
    if (featureBranch) {
      const { stdout: branchDiff } = await execFileAsync(
        "git", ["diff", "--stat", `${baseBranch}...${featureBranch}`],
        { cwd: projectDir, timeout: 10000 },
      );
      if (branchDiff.trim().length > 0) {
        console.log(`[ControlLoop] Diff found on ${featureBranch} (workspace checkout may have failed — recovering)`);
        // Attempt checkout recovery so verification can run against the branch
        await execFileAsync("git", ["checkout", featureBranch], {
          cwd: projectDir, timeout: 10000,
        }).catch((err) => { console.warn(`[ControlLoop] Recovery checkout failed: ${err.message}`); });
        return true;
      }
    }

    return false;
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

  // Step 5.5: SCOPE CREEP FILTER — reset out-of-scope changes before verification
  if (task.scopeBoundary?.in?.length > 0) {
    const scopeClean = await cleanOutOfScopeChanges(PROJECT_WORKSPACE, task.scopeBoundary.in);
    if (scopeClean.cleaned.length > 0) {
      console.log(`[ControlLoop] Step 5.5: Scope filter cleaned ${scopeClean.cleaned.length} out-of-scope file(s)`);
    }
  }

  // Validate a diff exists
  // Pass executor branch so we can detect changes even if worktree checkout failed
  const hasDiff = await validateDiffExists(PROJECT_WORKSPACE, "main", execResult.branch || undefined);
  if (!hasDiff) {
    console.log(`[ControlLoop] Executor produced no code changes — failing task`);
    await tracker.transitionTask(taskId, "failed", { reason: "No code changes produced", execResult: { exitCode: execResult.exitCode, duration: execResult.duration } });
    await recordOutcome({
      agents: ["planner", "executor"],
      cycleId, task, finalState: "failed",
      anchorRef: anchor.reference, anchorType: anchor.type,
      context: { failReason: "Executor produced no code changes", noDiff: true },
      reflection: {
        failureMode: "no-diff", whatFailed: task.title,
        whyItFailed: "Executor ran but produced no code changes",
        whatToTryDifferently: "Provide more specific scope boundary and acceptance criteria. Ensure the task is actionable.",
      },
    });
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
  await releaseMergeLock().catch((err: any) => {
    console.error(`[MergeStep] Failed to release merge lock: ${err.message}`);
    Sentry.addBreadcrumb({ category: "pipeline", message: `Merge lock release failed: ${err.message}`, level: "error" });
  });

  return { continue: true, mergeResult };
}

// ---------------------------------------------------------------------------
// mergeToMain — inlined from merge.ts
// Git merge + push. Never throws — returns a result object.
// ---------------------------------------------------------------------------

async function mergeToMain(projectDir: string, cycleId: string) {
  try {
    const { stdout: branchOut } = await execFileAsync(
      "git", ["branch", "--show-current"],
      { cwd: projectDir, timeout: 5000 },
    );
    const featureBranch = branchOut.trim();

    if (featureBranch && featureBranch !== "main") {
      await execFileAsync("git", ["checkout", "main"], { cwd: projectDir, timeout: 10000 });
      await execFileAsync("git", ["pull", "origin", "main"], { cwd: projectDir, timeout: 30000 })
        .catch((err) => console.error(`[Merge] git pull before merge failed (continuing with local main): ${err.message}`));
      await execFileAsync(
        "git",
        ["merge", "--no-ff", featureBranch, "-m", `merge: ${featureBranch} into main for ${cycleId}`],
        { cwd: projectDir, timeout: 30000 },
      );
      try {
        await execFileAsync("git", ["push", "origin", "main"], { cwd: projectDir, timeout: 30000 });
      } catch (pushErr: any) {
        const msg = pushErr?.message || "";
        if (msg.includes("non-fast-forward") || msg.includes("rejected") || msg.includes("failed to push")) {
          console.log(`[Merge] Push rejected — pulling and retrying once`);
          await execFileAsync("git", ["pull", "--rebase", "origin", "main"], { cwd: projectDir, timeout: 30000 });
          await execFileAsync("git", ["push", "origin", "main"], { cwd: projectDir, timeout: 30000 });
        } else {
          throw pushErr;
        }
      }
      const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, timeout: 5000 });

      // Delete merged feature branch (non-fatal)
      try {
        await execFileAsync("git", ["branch", "-d", featureBranch], { cwd: projectDir, timeout: 5000 });
      } catch (err: any) {
        console.error(`[Merge] Failed to delete local branch ${featureBranch}: ${err.message}`);
      }
      try {
        await execFileAsync("git", ["push", "origin", "--delete", featureBranch], { cwd: projectDir, timeout: 15000 });
      } catch { /* intentional: remote branch may not exist or already be deleted */ }

      return { ok: true, commitSha: sha.trim(), featureBranch, error: null };
    }

    // Already on main — push
    await execFileAsync("git", ["push", "origin", "main"], { cwd: projectDir, timeout: 30000 });
    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, timeout: 5000 });
    return { ok: true, commitSha: sha.trim(), featureBranch: null, error: null };
  } catch (err: any) {
    return { ok: false, commitSha: "", featureBranch: null, error: err?.message || String(err) };
  }
}
