import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.mjs";
import { runAgent, findPersonality } from "./codex-runner.mjs";
import { getTracker } from "./task-tracker.mjs";
import { groundProject, summarizeForPrompt, getDiff, getDiffStat } from "./grounding.mjs";
import { prepareWorkspace } from "./prepare-workspace.mjs";
import { mergeToMain } from "./merge.mjs";
import { runVerification, validateDiffExists, summarizeVerification, defaultVerificationPlan } from "./verifier.mjs";
// sendNotification removed — all notifications go through eventBus → digest system
import { recordCycleMetrics, detectDrift, getCumulativeAccomplishments } from "./metrics.mjs";
import { loadAgentMemory, formatMemoryForPrompt, recordPlannerLesson, recordExecutorLesson, recordSkepticLesson, compoundLearnings } from "./agent-memory.mjs";
import { moveToInProgress, moveToDone, returnToBacklog } from "./backlog.mjs";

const execFileAsync = promisify(execFile);

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const HYDRA_PATH = join(VAULT_PATH, "hydra");
const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

function generateCycleId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `cycle-${date}-${hour}${min}`;
}

// ---------------------------------------------------------------------------
// Anchor selection — choose what to work on from explicit truth sources
// ---------------------------------------------------------------------------

/**
 * Select the next anchor based on priority:
 * 1. Explicit user request (passed in opts)
 * 2. Failing tests (from grounding)
 * 3. Prior failures (stored in Redis)
 * 4. Priorities doc (fall back to operator direction)
 */
async function selectAnchor(grounding, opts = {}, eventBus = null) {
  // 1. Explicit user request
  if (opts.anchor) {
    return { ...opts.anchor, whyNow: "Explicit operator request" };
  }

  // 2. Queued work items (from POST /queue or research auto-queue)
  const queued = await getTracker().redis.lpop("hydra:anchors:work-queue");
  if (queued) {
    try {
      const item = JSON.parse(queued);
      // Parse research context if present
      let parsedContext = item.context;
      if (typeof parsedContext === "string") {
        try { parsedContext = JSON.parse(parsedContext); } catch { /* intentional: context stays as string */ }
      }
      return {
        type: item.source === "research" ? "research" : "user-request",
        reference: item.reference || item.description,
        whyNow: `Queued by ${item.source === "research" ? "research system" : "operator"}: ${item.reason || "from work queue"}`,
        context: parsedContext,
      };
    } catch (err) {
      console.error(`[ControlLoop] Corrupt work-queue item dropped: ${err.message} — data: ${queued.slice(0, 200)}`);
    }
  }

  // 3. Failing tests are the highest-priority automatic anchor
  if (grounding.failingTests.length > 0) {
    return {
      type: "failing-test",
      reference: grounding.failingTests[0],
      whyNow: `${grounding.testReport.failed} test(s) currently failing`,
    };
  }

  // 3. Typecheck errors
  if (grounding.typecheckReport.exitCode !== 0) {
    return {
      type: "failing-test",
      reference: "typecheck",
      whyNow: "TypeScript typecheck has errors",
    };
  }

  // 5. Prior failures from Redis
  const priorFailures = await getTracker().redis.lrange("hydra:anchors:prior-failures", 0, 0);
  if (priorFailures.length > 0) {
    try {
      const failure = JSON.parse(priorFailures[0]);
      await getTracker().redis.lpop("hydra:anchors:prior-failures");
      return {
        type: "prior-failure",
        reference: failure.taskId,
        whyNow: `Prior task ${failure.taskId} failed: ${failure.reason || "unknown"}`,
        context: failure,
      };
    } catch (err) {
      console.error(`[ControlLoop] Corrupt prior-failure at head of queue (blocking retries): ${err.message}. Fix with: redis-cli LPOP hydra:anchors:prior-failures`);
    }
  }

  // 5. TODO/FIXME markers in code — developer-written signals of known gaps
  if (grounding.todoMarkers?.length > 0) {
    return {
      type: "issue",
      reference: grounding.todoMarkers[0],
      whyNow: `${grounding.todoMarkers.length} TODO/FIXME marker(s) found in codebase`,
      context: grounding.todoMarkers.slice(0, 5).join("\n"),
    };
  }

  // 6. Fall back to priorities doc — but check if it's stale
  try {
    const priorities = await readFile(join(HYDRA_PATH, "direction", "priorities.md"), "utf-8");

    // Check how many recent cycles used this same anchor
    const recentDocCycles = await (async () => {
      try {
        const { getMetricsTrend } = await import("./metrics.mjs");
        const trend = await getMetricsTrend(10);
        return trend.filter((m) => m.anchorType === "doc" && m.anchorReference === "direction/priorities.md").length;
      } catch (err) {
        console.error(`[ControlLoop] Failed to check recent doc-cycle trend: ${err.message}`);
        return 0;
      }
    })();

    if (recentDocCycles >= 5) {
      console.log(`[ControlLoop] Priorities doc used ${recentDocCycles} times in last 10 cycles — may be stale. Consider updating priorities.`);
      if (eventBus) {
        try {
          await eventBus.publish(STREAMS.NOTIFICATIONS, {
            type: "cycle:stale_priorities",
            source: "control-loop",
            payload: {
              message: `Priorities doc has been the anchor for ${recentDocCycles} of the last 10 cycles. The operator should update priorities or provide a specific anchor.`,
              recentDocCycles,
            },
          });
        } catch (err) {
          console.error(`[ControlLoop] Failed to publish stale_priorities notification: ${err.message}`);
        }
      }
    }

    return {
      type: "doc",
      reference: "direction/priorities.md",
      whyNow: recentDocCycles >= 5
        ? `Priorities doc (used ${recentDocCycles}x recently — consider updating)`
        : "Next priority from operator direction document",
      context: priorities,
    };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[ControlLoop] selectAnchor: failed to read priorities.md: ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scope-adaptive planning — classify task complexity (PAUL pattern)
// ---------------------------------------------------------------------------
//
// PAUL auto-routes by complexity: quick-fix gets compressed ceremony (skip
// skeptic, lighter planner prompt), standard gets full ceremony, complex
// logs a warning. The classification runs AFTER the planner outputs a task
// so we have scopeBoundary and acceptanceCriteria to measure.
//
// Anchor-level pre-routing: failing-test and prior-failure anchors are
// inherently quick-fix (narrow scope, known target). These also get a
// cheaper planner model and compressed prompt (see runPlannerAgent).

function classifyTaskComplexity(task, anchor) {
  // Anchor types that are inherently targeted
  if (anchor.type === "failing-test" || anchor.type === "prior-failure") {
    return "quick-fix";
  }

  const filesInScope = task.scopeBoundary?.in?.length || 0;
  const criteriaCount = task.acceptanceCriteria?.length || 0;

  // Quick-fix: very small scope
  if (filesInScope <= 2 && criteriaCount <= 3) {
    return "quick-fix";
  }

  // Complex: large scope — warn, may benefit from splitting
  if (filesInScope > 5 || criteriaCount > 8) {
    return "complex";
  }

  return "standard";
}

// ---------------------------------------------------------------------------
// Store a prior-failure anchor for the next cycle
// ---------------------------------------------------------------------------

/**
 * Run a Kanban update (moveToInProgress / moveToDone / returnToBacklog) with
 * loud failure handling. Silent failure here caused incident #5 (6 days of
 * drift): log to journald AND publish an event so the digest sees it.
 */
async function safeKanban(eventBus, cycleId, op, reference, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[ControlLoop] Kanban ${op} failed for "${reference}": ${err.message}`);
    try {
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "kanban:update_failed",
        source: "control-loop",
        correlationId: cycleId,
        payload: { op, reference, error: err.message },
      });
    } catch (publishErr) {
      console.error(`[ControlLoop] Failed to publish kanban:update_failed: ${publishErr.message}`);
    }
  }
}

async function storePriorFailure(taskId, reason, verificationResult) {
  await getTracker().redis.rpush("hydra:anchors:prior-failures", JSON.stringify({
    taskId,
    reason,
    failedSteps: verificationResult?.steps?.filter((s) => !s.passed).map((s) => s.label) || [],
    timestamp: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The control loop — replaces the 7-agent pipeline
// ---------------------------------------------------------------------------

/**
 * Run one cycle of the evidence-driven control loop.
 *
 * Flow: Ground → Anchor → Plan → Skeptic → Execute → Verify → Merge → Report
 *
 * Only 3 codex agent calls: planner, executor, skeptic.
 * Verification and merge are command execution, not agents.
 *
 * @param {EventBus} eventBus
 * @param {object} opts - { anchor?: { type, reference }, maxRetries?: number }
 * @returns {LoopResult}
 */
export async function runControlLoop(eventBus, opts = {}) {
  const cycleId = generateCycleId();
  const startTime = Date.now();
  const tracker = getTracker();

  console.log(`[ControlLoop] Starting cycle ${cycleId}`);

  // Publish cycle:start notification
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "cycle:start",
    source: "control-loop",
    correlationId: cycleId,
    payload: { cycleId },
  });

  // =========================================================================
  // Step 1a: PREPARE WORKSPACE — explicit, observable cleanup step
  // (gated on operator safety: skips if on feature branch or has tracked edits)
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
  const grounding = await groundProject(PROJECT_WORKSPACE);
  const groundingSummary = summarizeForPrompt(grounding);
  console.log(`[ControlLoop] Grounded: ${grounding.testReport.passed} tests passing, ${grounding.testReport.failed} failing (${grounding.groundingDurationMs}ms)`);

  // =========================================================================
  // Step 1.5: CONTINUITY — what happened last cycle? What changed since then?
  // =========================================================================
  let continuityContext = "";
  const lastReport = await loadLastCycleReport();
  if (lastReport) {
    // Diff the repo since the last cycle's commit to show what's new
    const lastCycleReport = await loadLastCycleReportFull();
    if (lastCycleReport?.commitSha) {
      try {
        const diffSince = await getDiff(PROJECT_WORKSPACE, lastCycleReport.commitSha);
        const diffLines = diffSince.split("\n").length;
        continuityContext = `## CONTINUITY (what happened since last cycle)\n${lastReport}\n\nRepo changes since last cycle commit (${lastCycleReport.commitSha.slice(0, 7)}): ${diffLines} diff lines\n`;
        if (diffLines > 0 && diffLines < 200) {
          continuityContext += `Diff stat:\n${await getDiffStat(PROJECT_WORKSPACE, lastCycleReport.commitSha)}\n`;
        }
      } catch (err) {
        console.error(`[ControlLoop] Continuity diff failed, using simpler context: ${err.message}`);
        continuityContext = `## CONTINUITY\n${lastReport}\n`;
      }
    } else {
      continuityContext = `## CONTINUITY\n${lastReport}\n`;
    }
    console.log(`[ControlLoop] Continuity loaded from last cycle`);
  }

  // =========================================================================
  // Step 2: SELECT ANCHOR — what are we working on and why?
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
  // Step 3: PLAN — propose one bounded task (codex agent call)
  // =========================================================================
  console.log(`[ControlLoop] Step 3: Planning...`);
  const task = await runPlannerAgent(cycleId, anchor, grounding, groundingSummary, continuityContext);

  if (!task) {
    console.log(`[ControlLoop] Planner produced no valid task — cycle complete`);
    return { cycleId, tasks: [], reason: "Planner produced no task", durationMs: Date.now() - startTime };
  }

  // Initialize task in Redis with v2 schema
  const taskId = `task-${cycleId}-1`;
  task.taskId = taskId;

  // Init cycle tracking
  await tracker.redis.set("hydra:cycle:active", cycleId);
  await tracker.redis.hset(`hydra:cycle:${cycleId}`,
    "status", "running",
    "startedAt", new Date().toISOString(),
    "total", 1,
    "completed", 0,
    "failed", 0,
    "abandoned", 0,
    "timedOut", 0,
  );
  await tracker.initTaskV2(cycleId, task);

  // =========================================================================
  // Step 3.1: CLASSIFY COMPLEXITY — scope-adaptive routing (PAUL pattern)
  // =========================================================================
  const complexity = classifyTaskComplexity(task, anchor);
  const filesInScope = task.scopeBoundary?.in?.length || 0;
  const criteriaCount = task.acceptanceCriteria?.length || 0;
  console.log(`[ControlLoop] Task: "${task.title}" (anchor: ${task.anchorType}, confidence: ${task.confidence}, complexity: ${complexity}, scope: ${filesInScope} files, ${criteriaCount} criteria)`);
  if (complexity === "complex") {
    console.log(`[ControlLoop] COMPLEX task detected (${filesInScope} files, ${criteriaCount} criteria) — consider splitting in future cycles`);
  }

  // =========================================================================
  // Step 3.5: DRIFT DETECTION — reject duplicates (skip for prior-failure retries)
  // =========================================================================
  // Skip drift detection for explicit requests and retries — the operator/system chose this deliberately
  const skipDrift = anchor.type === "prior-failure" || anchor.type === "user-request";
  const drift = skipDrift ? { isDuplicate: false } : await detectDrift(task);
  if (drift.isDuplicate) {
    console.log(`[ControlLoop] DRIFT DETECTED: ${drift.reason}`);
    await tracker.transitionTask(taskId, "abandoned", { drift });
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:drift_detected",
      source: "control-loop",
      correlationId: cycleId,
      payload: { taskId, title: task.title, drift },
    });
    return {
      cycleId,
      tasks: [{ taskId, finalState: "abandoned", reason: `Drift: ${drift.reason}` }],
      durationMs: Date.now() - startTime,
    };
  }

  // =========================================================================
  // Step 4: SKEPTIC GATE — challenge assumptions (codex agent call)
  // Skip for: research-sourced items (already vetted by research strategist)
  //           quick-fix tasks (small scope, low risk — ceremony not worth the cost)
  // =========================================================================
  const skipSkeptic = anchor.type === "research" || complexity === "quick-fix";
  const skepticResult = skipSkeptic
    ? { verdict: "approve", reason: `Skipped — ${anchor.type === "research" ? "research-vetted item" : "quick-fix (scope-adaptive routing)"}`, skipped: true }
    : await (() => {
        console.log(`[ControlLoop] Step 4: Skeptic gate...`);
        return runSkepticAgent(cycleId, task, grounding, groundingSummary);
      })();

  if (skepticResult.verdict === "reject") {
    console.log(`[ControlLoop] Skeptic REJECTED: ${skepticResult.reason}`);
    await tracker.transitionTask(taskId, "abandoned", { skepticVerdict: skepticResult });

    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:rejected",
      source: "control-loop",
      correlationId: cycleId,
      payload: { taskId, title: task.title, reason: skepticResult.reason },
    });

    try {
      await recordPlannerLesson(cycleId, task, "abandoned", { reason: `Skeptic rejected: ${skepticResult.reason}` });
      await recordSkepticLesson(cycleId, task, "reject", "abandoned");
    } catch (err) {
      console.error(`[ControlLoop] Failed to record rejection lessons: ${err.message}`);
    }

    return {
      cycleId,
      tasks: [{ taskId, finalState: "abandoned", reason: skepticResult.reason }],
      durationMs: Date.now() - startTime,
    };
  }

  await tracker.transitionTask(taskId, "approved", { skepticVerdict: skepticResult });
  console.log(`[ControlLoop] Skeptic APPROVED: ${skepticResult.reason || "no objections"}`);

  // =========================================================================
  // Step 5: EXECUTE — make the smallest change (codex agent call)
  // =========================================================================
  console.log(`[ControlLoop] Step 5: Executing...`);
  await tracker.transitionTask(taskId, "in-progress", {});
  await safeKanban(eventBus, cycleId, "moveToInProgress", anchor.reference, () => moveToInProgress(anchor.reference));

  const execResult = await runExecutorAgent(cycleId, task, grounding, groundingSummary);

  // Validate a diff exists
  const hasDiff = await validateDiffExists(PROJECT_WORKSPACE);
  if (!hasDiff) {
    console.log(`[ControlLoop] Executor produced no code changes — failing task`);
    await tracker.transitionTask(taskId, "failed", { reason: "No code changes produced", execResult: { exitCode: execResult.exitCode, duration: execResult.duration } });
    await storePriorFailure(taskId, "No code changes produced", null);
    try {
      await recordPlannerLesson(cycleId, task, "failed", { failReason: "Executor produced no code changes" });
      await recordExecutorLesson(cycleId, task, "failed", { noDiff: true });
    } catch (err) {
      console.error(`[ControlLoop] Failed to record no-diff lessons: ${err.message}`);
    }
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
  // Step 6: VERIFY — run hard checks (command execution, NOT an agent)
  // =========================================================================
  console.log(`[ControlLoop] Step 6: Verifying...`);
  const verificationPlan = task.verificationPlan?.length > 0
    ? task.verificationPlan
    : defaultVerificationPlan(PROJECT_WORKSPACE);

  const verification = await runVerification(PROJECT_WORKSPACE, verificationPlan);

  if (!verification.allPassed) {
    const failedSteps = verification.steps.filter((s) => !s.passed).map((s) => s.label);
    console.log(`[ControlLoop] Verification FAILED: ${failedSteps.join(", ")}`);
    await tracker.transitionTask(taskId, "failed", { verification });

    // Store as prior-failure for retry in next cycle
    await storePriorFailure(taskId, `Verification failed: ${failedSteps.join(", ")}`, verification);

    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:verification_failed",
      source: "control-loop",
      correlationId: cycleId,
      payload: {
        taskId,
        title: task.title,
        failedSteps,
        verificationSummary: summarizeVerification(verification).slice(0, 500),
      },
    });

    // Record failure metrics
    await recordCycleMetrics(cycleId, {
      tasksAttempted: 1, tasksFailed: 1, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
      testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
      testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
      filesChanged: 0, totalDurationMs: Date.now() - startTime,
      groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: verification.totalDurationMs,
      regressionIntroduced: false, taskTitle: task.title,
      anchorType: task.anchorType, anchorReference: task.anchorReference,
      complexity, filesInScope: filesInScope, criteriaCount,
    });

    // Return to backlog on failure — use anchor.reference to match Kanban row
    // (task.title is planner-generated and doesn't match; see incident #5)
    await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "verification failed"));

    // Record failure lessons for agents
    const failedStderr = verification.steps.find(s => !s.passed)?.stderr || "";
    try {
      await recordPlannerLesson(cycleId, task, "failed", { failReason: `Verification failed: ${failedSteps.join(", ")}`, failedSteps });
      await recordExecutorLesson(cycleId, task, "failed", { failedSteps, verificationStderr: failedStderr });
      await recordSkepticLesson(cycleId, task, "approve", "failed");
    } catch (err) {
      console.error(`[ControlLoop] Failed to record verification-failure lessons: ${err.message}`);
    }

    // Discard the broken branch to leave the repo clean for the next cycle
    try {
      const { stdout: branchName } = await execFileAsync("git", ["branch", "--show-current"], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
      const broken = branchName.trim();
      await execFileAsync("git", ["checkout", "main"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
      await execFileAsync("git", ["clean", "-fd"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
      await execFileAsync("git", ["checkout", "."], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
      if (broken && broken !== "main") {
        await execFileAsync("git", ["branch", "-D", broken], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
        console.log(`[ControlLoop] Deleted broken branch ${broken}`);
      }
    } catch (err) {
      console.error(`[ControlLoop] Broken branch cleanup failed (may leave stale branch): ${err.message}`);
    }

    return {
      cycleId,
      tasks: [{ taskId, finalState: "failed", verification }],
      durationMs: Date.now() - startTime,
    };
  }

  await tracker.transitionTask(taskId, "verified", { verification });
  console.log(`[ControlLoop] Verification PASSED (${verification.totalDurationMs}ms)`);

  // =========================================================================
  // Step 7: MERGE — git operation, NOT an agent (extracted to merge.mjs)
  // =========================================================================
  console.log(`[ControlLoop] Step 7: Merging to main...`);
  const mergeResult = await mergeToMain(PROJECT_WORKSPACE, cycleId);
  let commitSha = "";
  if (mergeResult.ok) {
    commitSha = mergeResult.commitSha;
    if (mergeResult.featureBranch) {
      console.log(`[ControlLoop] Merged ${mergeResult.featureBranch} → main (${commitSha.slice(0, 7)})`);
    } else {
      console.log(`[ControlLoop] Already on main, pushed (${commitSha.slice(0, 7)})`);
    }
    await tracker.transitionTask(taskId, "merged", { commitSha });
  } else {
    console.error(`[ControlLoop] Merge failed: ${mergeResult.error}`);
    // Verification passed but merge failed — stays "verified" in tracker state;
    // publish notification so digest surfaces the merge failure.
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
      await execFileAsync("git", ["revert", "--no-edit", commitSha], { cwd: PROJECT_WORKSPACE, timeout: 30000 });
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
    } catch (err) {
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
  const newDirtyFiles = finalGrounding.dirtyFiles.filter((f) => !grounding.dirtyFiles.includes(f));
  const unresolvedUncertainty = [];
  if (regressionIntroduced) unresolvedUncertainty.push(`Tests regressed: ${grounding.testReport.passed} → ${finalGrounding.testReport.passed}`);
  if (typecheckDegraded) unresolvedUncertainty.push("Typecheck was clean before but has errors now");
  if (newDirtyFiles.length > 0) unresolvedUncertainty.push(`${newDirtyFiles.length} new uncommitted files after merge`);

  const rollbackRisk = regressionIntroduced ? "high" : typecheckDegraded ? "medium" : "low";

  const report = {
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
      steps: verification.steps.map((s) => ({ label: s.label, passed: s.passed, duration: s.durationMs })),
      commandsRun: verification.steps.map((s) => s.command),
    },
    commitSha,
    filesChanged: verification.filesChanged,
    unresolvedUncertainty,
    rollbackRisk,
    rolledBack,
    durationMs: Date.now() - startTime,
    durations: {
      grounding: grounding.groundingDurationMs,
      planning: 0, // filled by caller if needed
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
    await storePriorFailure(taskId, `Regression: tests ${grounding.testReport.passed} → ${finalGrounding.testReport.passed}`, verification);
  }

  // Write reality report to vault
  const reportDir = join(HYDRA_PATH, "reports", "reality-reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    join(reportDir, `${cycleId}.json`),
    JSON.stringify(report, null, 2),
  );

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
  });

  // Update Kanban backlog — use anchor.reference (not planner-generated task.title)
  // so the row in Kanban's Queued lane matches for the move. The planner's title
  // almost never matches the original backlog entry, which was leaving rows stuck
  // in Queued forever (2026-04-08 debug session).
  const finalState = rolledBack ? "rolled-back" : (commitSha ? "merged" : "verified");
  if (finalState === "merged") {
    await safeKanban(eventBus, cycleId, "moveToDone", anchor.reference, () => moveToDone(anchor.reference, "merged"));
  } else {
    await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, finalState));
  }

  // =========================================================================
  // Step 8.5: COMPOUND — extract structured prevention rules (Sage pattern)
  // Only records failures, surprises, and pattern violations. Skips noise.
  // =========================================================================
  try {
    await compoundLearnings(report, task, anchor);
  } catch (err) {
    console.error(`[ControlLoop] Compound learning extraction failed: ${err.message}`);
  }

  // Complete the cycle in tracker
  await tracker.redis.hset(`hydra:cycle:${cycleId}`, "status", "completed", "completedAt", new Date().toISOString());
  await tracker.redis.set("hydra:cycle:last", cycleId);
  await tracker.redis.del("hydra:cycle:active");

  // Trigger Meta analysis every 5 cycles (not every cycle — avoid churn)
  try {
    const { getMetricsTrend } = await import("./metrics.mjs");
    const trend = await getMetricsTrend(5);
    const recentFailures = trend.filter((m) => m.tasksFailed > 0).length;
    if (trend.length >= 5 && recentFailures > 0) {
      console.log(`[ControlLoop] Triggering Meta analysis (${recentFailures} failures in last 5 cycles)`);
      await eventBus.publish(STREAMS.META, {
        type: "cycle:report",
        source: "control-loop",
        correlationId: cycleId,
        payload: { trigger: "periodic_with_failures", recentFailures },
      });
    }
  } catch (err) {
    console.error(`[ControlLoop] Meta trigger check failed: ${err.message}`);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Research context formatter — gives the planner rich context from research
// ---------------------------------------------------------------------------

function buildResearchContext(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = ["\n## RESEARCH CONTEXT (from research system — use this to guide your task)"];
  if (ctx.description) parts.push(`\n### What to build\n${ctx.description}`);
  if (ctx.rationale) parts.push(`\n### Why (research rationale)\n${ctx.rationale}`);
  if (ctx.acceptanceCriteria?.length > 0) {
    parts.push("\n### Acceptance Criteria (from research — incorporate into your task)");
    for (const c of ctx.acceptanceCriteria) parts.push(`- ${c}`);
  }
  if (ctx.complexity) parts.push(`\n### Estimated complexity: ${ctx.complexity}`);
  if (ctx.prerequisites?.length > 0) {
    parts.push(`\n### Prerequisites: ${ctx.prerequisites.join(", ")}`);
  }
  if (ctx.category) parts.push(`\n### Focus category: ${ctx.category}`);
  if (ctx.confidence) parts.push(`### Research confidence: ${ctx.confidence}`);
  if (ctx.adjustedScore) parts.push(`### Research score: ${ctx.adjustedScore}`);
  if (ctx.sources?.length > 0) parts.push(`### Identified by: ${ctx.sources.join(", ")} researchers`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Agent runners — each calls codex exec with a specific personality + prompt
// ---------------------------------------------------------------------------

async function runPlannerAgent(cycleId, anchor, grounding, groundingSummary, continuityContext = "") {
  // Scope-adaptive planner routing (PAUL pattern):
  // Quick-fix anchors (failing-test, prior-failure) get a compressed prompt
  // and cheaper model — they don't need priorities, accomplishments, or
  // continuity because the anchor IS the entire scope.
  const isQuickFixAnchor = anchor.type === "failing-test" || anchor.type === "prior-failure";
  const plannerModel = isQuickFixAnchor ? "codex" : "frontier";

  // Load context documents — skip for quick-fix (irrelevant noise)
  const [priorities, feedback, plannerMemory] = isQuickFixAnchor
    ? ["", "", []]
    : await Promise.all([
        readFile(join(HYDRA_PATH, "direction", "priorities.md"), "utf-8").catch(() => ""),
        readFile(join(HYDRA_PATH, "agent-feedback", "to-strategist.md"), "utf-8").catch(() => ""),
        loadAgentMemory("planner"),
      ]);

  const confidence = grounding.testReport.failed > 0 ? "low"
    : (grounding.typecheckReport.exitCode !== 0 || grounding.dirtyFiles.length > 0) ? "medium"
    : "high";

  // Load cumulative accomplishments — skip for quick-fix
  let accomplishmentsContext = "";
  if (!isQuickFixAnchor) {
    try {
      const acc = await getCumulativeAccomplishments(10);
      if (acc.length > 0) {
        accomplishmentsContext = `## ALREADY ACCOMPLISHED (do NOT re-propose these)\n${acc.map((a) => `- "${a.title}"`).join("\n")}\n`;
      }
    } catch (err) {
      console.error(`[ControlLoop] Failed to load cumulative accomplishments: ${err.message}`);
    }
  }

  // JSON output schema (shared by both prompt paths)
  const jsonSchema = [
    `Output ONLY valid JSON:`,
    `{`,
    `  "title": "...",`,
    `  "description": "...",`,
    `  "taskType": "build",`,
    `  "anchorType": "${anchor.type}",`,
    `  "anchorReference": "${anchor.reference}",`,
    `  "whyNow": "...",`,
    `  "confidence": "${confidence}",`,
    `  "scopeBoundary": { "in": ["file1.ts", "file2.ts"], "out": ["unrelated/"] },`,
    `  "acceptanceCriteria": ["criterion 1", "criterion 2"],`,
    `  "verificationPlan": [`,
    `    { "command": "npm test", "expected": "exit code 0", "label": "tests pass" },`,
    `    { "command": "npm run typecheck", "expected": "exit code 0", "label": "typecheck" }`,
    `  ]`,
    `  NOTE: Use simple "npm test" and "npm run typecheck" — the verifier runs them in the correct app directory automatically.`,
    `}`,
  ].join("\n");

  let prompt;
  if (isQuickFixAnchor) {
    // Compressed prompt for quick-fix: just anchor + compact grounding + fix instructions
    const compactGrounding = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
    prompt = [
      `## FIX THIS (quick-fix — targeted repair, minimal scope)`,
      `Type: ${anchor.type}`,
      `Reference: ${anchor.reference}`,
      `Why now: ${anchor.whyNow}`,
      anchor.context ? `\nContext:\n${typeof anchor.context === "string" ? anchor.context.slice(0, 1500) : JSON.stringify(anchor.context).slice(0, 1500)}` : "",
      "",
      compactGrounding,
      "",
      `## INSTRUCTIONS`,
      `This is a targeted fix. Produce exactly 1 task with the SMALLEST change that resolves the issue.`,
      `The task MUST be anchored to "${anchor.reference}".`,
      `Keep scopeBoundary narrow — ideally 1-2 files.`,
      "",
      jsonSchema,
    ].filter(Boolean).join("\n");
    console.log(`[ControlLoop] Planner using quick-fix prompt (${plannerModel} model, ~${prompt.length} chars)`);
  } else {
    // Full prompt for standard/complex tasks
    prompt = [
      `## ANCHOR (this is what you are working on)`,
      `Type: ${anchor.type}`,
      `Reference: ${anchor.reference}`,
      `Why now: ${anchor.whyNow}`,
      anchor.context && anchor.type === "research" ? buildResearchContext(anchor.context) : "",
      anchor.context && anchor.type !== "research" ? `\nContext:\n${typeof anchor.context === "string" ? anchor.context.slice(0, 2000) : JSON.stringify(anchor.context).slice(0, 2000)}` : "",
      "",
      groundingSummary.slice(0, 4000),
      "",
      // Continuity contract — what the last cycle did, what changed since
      continuityContext ? continuityContext.slice(0, 1500) : "",
      "",
      priorities ? `## PRIORITIES\n${priorities.slice(0, 3000)}\n` : "",
      feedback ? `## OPERATOR FEEDBACK\n${feedback.slice(0, 1000)}\n` : "",
      "",
      // Cumulative accomplishments — prevent re-proposing completed work
      accomplishmentsContext,
      "",
      // Agent memory — learn from past outcomes
      formatMemoryForPrompt(plannerMemory, "planner"),
      "",
      `## INSTRUCTIONS`,
      `Confidence: ${confidence.toUpperCase()}. Produce exactly 1 task, or null if no actionable work exists.`,
      `The task MUST be anchored to "${anchor.reference}".`,
      `Prefer the SMALLEST code change that creates verifiable progress.`,
      `Do NOT produce architecture docs, design contracts, or research tasks unless the anchor explicitly requires it.`,
      `If the ALREADY ACCOMPLISHED list covers all priorities and you cannot find a genuine gap, output: { "noWork": true, "reason": "All current priorities appear addressed" }`,
      "",
      jsonSchema,
    ].filter(Boolean).join("\n");
  }

  const personality = await findPersonality("planner") || await findPersonality("strategist");
  const result = await runAgent({
    agentName: "planner",
    personality,
    prompt,
    model: plannerModel,
    taskId: "planner",
    correlationId: cycleId,
  });

  // Parse output — try direct parse, then regex fallback, then fail loud
  let task = null;
  try {
    task = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        task = JSON.parse(match[0]);
      } catch (err) {
        console.error(`[ControlLoop] Planner output unparseable even after regex extraction: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Planner output contained no JSON object`);
    }
  }

  // Handle explicit "no work" response
  if (task?.noWork) {
    console.log(`[ControlLoop] Planner says no work needed: ${task.reason || "all priorities addressed"}`);
    await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "no-work", result.usage, result.costUsd);
    return null;
  }

  // Validate required fields
  if (task && (!task.verificationPlan || !Array.isArray(task.verificationPlan) || task.verificationPlan.length === 0)) {
    console.log(`[ControlLoop] Planner task rejected — missing verificationPlan`);
    return null;
  }

  await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "completed", result.usage, result.costUsd);
  return task;
}

async function runSkepticAgent(cycleId, task, grounding, groundingSummary) {
  // Load skeptic memory and recent cycle history
  const skepticMemory = await loadAgentMemory("skeptic");
  let recentHistory = "";
  try {
    const reportDir = join(HYDRA_PATH, "reports", "reality-reports");
    const { readdir: rd } = await import("node:fs/promises");
    const files = (await rd(reportDir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 5);
    for (const file of files) {
      const content = await readFile(join(reportDir, file), "utf-8");
      const report = JSON.parse(content);
      recentHistory += `- ${report.cycleId}: "${report.task?.title}" (${report.task?.finalState})\n`;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[ControlLoop] Skeptic failed to load recent cycle history: ${err.message}`);
    }
  }

  const prompt = [
    `You are the Skeptic. Your job is to CHALLENGE this proposed task. You have VETO power.`,
    "",
    `## PROPOSED TASK`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Anchor: [${task.anchorType}] ${task.anchorReference}`,
    task.anchorType === "doc" ? `(NOTE: This is a vault document maintained by the operator. It exists outside the workspace but IS a valid anchor.)` : "",
    `Why now: ${task.whyNow}`,
    `Confidence: ${task.confidence}`,
    `Scope: IN=${JSON.stringify(task.scopeBoundary?.in || [])} OUT=${JSON.stringify(task.scopeBoundary?.out || [])}`,
    `Acceptance Criteria: ${JSON.stringify(task.acceptanceCriteria || [])}`,
    `Verification Plan: ${JSON.stringify(task.verificationPlan || [])}`,
    "",
    groundingSummary.slice(0, 2000),
    "",
    recentHistory ? `## RECENT CYCLE HISTORY (check for duplicates)\n${recentHistory}` : "",
    "",
    formatMemoryForPrompt(skepticMemory, "skeptic"),
    "",
    `## YOUR CHALLENGE CHECKLIST`,
    `1. Is this task ANCHORED to real evidence? (not inferred strategy)`,
    `2. Is this a DUPLICATE of recent work? (check history above)`,
    `3. Is the scope BOUNDED? (not too broad, not architecture theater)`,
    `4. Does the verificationPlan actually PROVE completion?`,
    `5. Is this the SMALLEST useful task? (could it be narrower?)`,
    `6. Does the grounding report support this being needed?`,
    "",
    `Output ONLY valid JSON:`,
    `{ "verdict": "approve" | "reject", "reason": "..." }`,
  ].filter(Boolean).join("\n");

  const personality = await findPersonality("skeptic");
  const result = await runAgent({
    agentName: "skeptic",
    personality,
    prompt,
    model: "codex",
    taskId: "skeptic",
    correlationId: cycleId,
  });

  let verdict = { verdict: "reject", reason: "Skeptic produced no parseable output — fail safe" };
  try {
    verdict = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        verdict = JSON.parse(match[0]);
      } catch (err) {
        console.error(`[ControlLoop] Skeptic output unparseable even after regex — failing safe to reject: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Skeptic output contained no JSON object — failing safe to reject`);
    }
  }

  await getTracker().logAgentRun(cycleId, "skeptic", "skeptic", result.duration, verdict.verdict, result.usage, result.costUsd);
  return verdict;
}

async function runExecutorAgent(cycleId, task, grounding, groundingSummary) {
  // Load executor memory
  const executorMemory = await loadAgentMemory("executor");

  // Find a representative test file so executor can match the project's test patterns
  let testPatternHint = "";
  try {
    const testFiles = grounding.fileTree.split("\n").filter((f) => f.match(/\.test\.(ts|tsx|js)$/)).slice(-3);
    if (testFiles.length > 0) {
      const sampleTest = testFiles[0];
      const content = await readFile(join(PROJECT_WORKSPACE, sampleTest), "utf-8");
      testPatternHint = `\n## TEST PATTERN (follow this pattern for new tests)\nFile: ${sampleTest}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\`\n`;
    }
  } catch { /* intentional: test pattern hint is optional context for the executor */ }

  const prompt = [
    `## TASK`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    "",
    `## SCOPE BOUNDARY`,
    `Files to modify: ${JSON.stringify(task.scopeBoundary?.in || [])}`,
    `Files to NOT touch: ${JSON.stringify(task.scopeBoundary?.out || [])}`,
    "",
    `## ACCEPTANCE CRITERIA`,
    ...(task.acceptanceCriteria || []).map((c, i) => `${i + 1}. ${c}`),
    "",
    `## VERIFICATION (these commands will be run AFTER you finish)`,
    ...(task.verificationPlan || []).map((s) => `- ${s.label}: \`${s.command}\` (expected: ${s.expected})`),
    "",
    testPatternHint,
    groundingSummary.slice(0, 3000),
    "",
    formatMemoryForPrompt(executorMemory, "executor"),
    "",
    `## RULES`,
    `1. FIRST: \`git checkout main && git pull origin main\` then create feature branch: \`git checkout -b feature/${cycleId}-slug\``,
    `2. Make the SMALLEST change that satisfies the acceptance criteria`,
    `3. Write or update tests for your changes — RUN THEM before committing: \`npm test\``,
    `4. If tests FAIL, fix your code until they pass. Do not commit failing code.`,
    `5. Commit to the feature branch with clear commit messages`,
    `6. NEVER merge into main — the control loop handles merging after verification`,
    `7. Push your branch when done`,
    `8. NEVER delete or remove files in src/lib/providers/ — these are foundational venue adapters even if not yet imported elsewhere`,
    `9. NEVER create "cleanup" or "remove unused" commits — if code exists with tests, it is intentional`,
    `10. If you create or modify database migrations (drizzle SQL files), you MUST also update drizzle/meta/_journal.json with the new entry. Migration SQL without a journal entry will silently fail.`,
    "",
    `Output ONLY valid JSON:`,
    `{ "summary": "...", "filesChanged": [...], "commits": [...], "branch": "...", "testsRun": { "passed": N, "failed": N } }`,
  ].join("\n");

  const personality = await findPersonality("executor") || await findPersonality("builder");
  const result = await runAgent({
    agentName: "executor",
    personality,
    prompt,
    model: "codex",
    taskId: task.taskId,
    correlationId: cycleId,
    workDir: PROJECT_WORKSPACE,
  });

  let output = {};
  try {
    output = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        output = JSON.parse(match[0]);
      } catch (err) {
        console.error(`[ControlLoop] Executor output unparseable even after regex extraction: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Executor output contained no JSON object`);
    }
  }

  await getTracker().logAgentRun(cycleId, "executor", task.taskId, result.duration, "completed", result.usage, result.costUsd);
  return { ...output, exitCode: result.exitCode, duration: result.duration };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadLastCycleReport() {
  try {
    const report = await loadLastCycleReportFull();
    if (!report) return null;
    return [
      `Last cycle: ${report.cycleId}`,
      `Task: "${report.task?.title}" → ${report.task?.finalState}`,
      `Tests: ${report.grounding?.before?.passed} → ${report.grounding?.after?.passed}`,
      report.regressionIntroduced ? "WARNING: Regression introduced" : "No regression",
      `Commit: ${report.commitSha || "none"}`,
      report.rollbackRisk ? `Rollback risk: ${report.rollbackRisk}` : "",
      report.filesChanged?.length > 0 ? `Files changed: ${report.filesChanged.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  } catch (err) {
    console.error(`[ControlLoop] loadLastCycleReport failed: ${err.message}`);
    return null;
  }
}

/**
 * Load the full JSON reality report from the last completed cycle.
 * Used by the continuity contract to diff the repo since the last commit.
 */
async function loadLastCycleReportFull() {
  try {
    const reportDir = join(HYDRA_PATH, "reports", "reality-reports");
    const { readdir: rd } = await import("node:fs/promises");
    const files = (await rd(reportDir)).filter((f) => f.endsWith(".json")).sort().reverse();
    if (files.length === 0) return null;
    const content = await readFile(join(reportDir, files[0]), "utf-8");
    return JSON.parse(content);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[ControlLoop] loadLastCycleReportFull failed: ${err.message}`);
    }
    return null;
  }
}
