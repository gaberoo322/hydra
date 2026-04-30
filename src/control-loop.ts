import * as Sentry from "@sentry/node";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.ts";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker, CYCLE_KEY_TTL } from "./task-tracker.ts";
import { groundProject, summarizeForPrompt, getDiff, getDiffStat } from "./grounding.ts";
import { prepareWorkspace } from "./prepare-workspace.ts";
import { mergeToMain } from "./merge.ts";
import { runVerification, validateDiffExists, summarizeVerification, defaultVerificationPlan } from "./verifier.ts";
import { runMutationTests } from "./mutation-testing.ts";
import { runAdversarialValidation, findingsToQueueItems, trackMergedCommit, checkRevertCorrelation } from "./adversarial-validation.ts";
// sendNotification removed — all notifications go through eventBus → digest system
import { recordCycleMetrics, detectDrift } from "./metrics.ts";
import { loadAgentMemory, formatMemoryForPrompt, recordPlannerLesson, recordExecutorLesson, recordSkepticLesson } from "./agent-memory.ts";
import { runPlannerAgent } from "./planner-prompt.ts";
// priorities-refresh removed — the research-strategist handles refresh inside
// the research loop (Step 5.5). Stale-detection just warns now.
import { moveToInProgress, moveToDone, returnToBacklog, moveToBlocked } from "./backlog.ts";
import { detectPatterns } from "./pattern-detector.ts";
import { createCycleSession } from "./ov-session.ts";
import { markTaskComplete } from "./specs.ts";
import { selectAnchor, trackAbandonment, clearAbandonmentCounter, storePriorFailure, clearProcessingItem } from "./anchor-selection.ts";
import { looksOperatorBlocked, reconcilePlanVsActual, classifyTaskComplexity, preflightCheck, runHighRiskReview } from "./preflight.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

function generateCycleId() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `cycle-${date}-${hour}${min}`;
}

/**
 * Run a Kanban update (moveToInProgress / moveToDone / returnToBacklog) with
 * loud failure handling. Silent failure here caused incident #5 (6 days of
 * drift): log to journald AND publish an event so the digest sees it.
 */
async function safeKanban(eventBus, cycleId, op, reference, fn) {
  try {
    await fn();
  } catch (err: any) {
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
export async function runControlLoop(eventBus,  opts: Record<string, any> = {}) {
  const cycleId = generateCycleId();
  const startTime = Date.now();
  const tracker = getTracker();

  console.log(`[ControlLoop] Starting cycle ${cycleId}`);

  // Create OpenViking session for this cycle — tracks context and extracts memories
  const ovSession = await createCycleSession(cycleId);

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
      } catch (err: any) {
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
  const task = await runPlannerAgent(cycleId, anchor, grounding, groundingSummary, continuityContext, ovSession);

  // Check for usage-limit sentinel — pause scheduler instead of retrying
  if (task?.__usageLimitHit) {
    console.error(`[ControlLoop] Codex usage limit reached — pausing scheduler for 30 minutes`);
    await clearProcessingItem(anchor);
    await ovSession.logOutcome("usage-limit", "Codex usage limit hit — scheduler paused");
    await ovSession.commit();
    return {
      cycleId,
      tasks: [],
      reason: "Codex usage limit hit — scheduler paused",
      durationMs: Date.now() - startTime,
      __usageLimitHit: true,
    };
  }

  if (!task) {
    console.log(`[ControlLoop] Planner produced no valid task — cycle complete`);

    // Circuit breaker: planner null counts as an abandonment for this anchor.
    // Without this, Kanban queued items loop forever when the planner can't
    // produce valid output (e.g. keeps omitting required fields).
    try {
      const escalated = await trackAbandonment(anchor.reference, { title: anchor.reference, taskId: "none" }, "Planner produced no valid task (schema validation or parse failure)");
      if (escalated) {
        console.log(`[ControlLoop] Anchor "${anchor.reference}" escalated to reframe queue after repeated planner failures`);
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Circuit breaker tracking failed on null task: ${err.message}`);
    }

    await clearProcessingItem(anchor);
    await ovSession.logPlanner(anchor, null);
    await ovSession.logOutcome("no-work", "Planner produced no task");
    await ovSession.commit();
    await recordCycleMetrics(cycleId, {
      tasksAttempted: 0, tasksFailed: 0, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 1,
      testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
      testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
      filesChanged: 0, totalDurationMs: Date.now() - startTime,
      groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: 0,
      regressionIntroduced: false, taskTitle: "Planner produced no task",
      anchorType: anchor.type, anchorReference: anchor.reference,
      plannerModel: "unknown", planCacheHit: "false",
      abandonReason: "Planner produced no task",
    });
    return { cycleId, tasks: [], reason: "Planner produced no task", durationMs: Date.now() - startTime };
  }

  await ovSession.logPlanner(anchor, task);

  // Initialize task in Redis with v2 schema
  const taskId = `task-${cycleId}-1`;
  task.taskId = taskId;

  // Acquire exclusive cycle lock — prevents concurrent cycles from Claude Code and Codex
  const CYCLE_LOCK_KEY = "hydra:cycle:lock";
  const CYCLE_LOCK_TTL = 900; // 15 minutes — auto-release if cycle crashes
  const lockAcquired = await tracker.redis.set(CYCLE_LOCK_KEY, cycleId, "EX", CYCLE_LOCK_TTL, "NX");
  if (!lockAcquired) {
    const existingCycle = await tracker.redis.get(CYCLE_LOCK_KEY);
    console.log(`[ControlLoop] Cycle lock held by ${existingCycle} — skipping this cycle`);
    await clearProcessingItem(anchor);
    return { cycleId, tasks: [], reason: `Cycle lock held by ${existingCycle}`, durationMs: Date.now() - startTime };
  }

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
  await tracker.redis.expire(`hydra:cycle:${cycleId}`, CYCLE_KEY_TTL);
  await tracker.initTaskV2(cycleId, task);

  // All code after lock acquisition is wrapped in try/finally to guarantee
  // the distributed lock is released on every exit path (success, failure, error).
  try {

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
    // Circuit breaker: drift counts as an abandonment too
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
  // Step 4: PREFLIGHT GATE — deterministic checks + nano-model review for high-risk
  //
  // Replaces the full skeptic agent call with:
  //   a) Deterministic preflight checklist (free, instant) for all tasks
  //   b) Lightweight nano-model review for high-risk tasks only ($0.20/1M tokens)
  //   c) Quick-fix tasks skip both (existing behavior)
  //
  // Schema validation (risk, scope, anchor, criteria) is already handled by
  // validateTaskSchema() in the planner return path — tasks that reach here
  // are structurally valid.
  // =========================================================================
  let skepticResult;
  if (complexity === "quick-fix") {
    skepticResult = { verdict: "approve", reason: "Skipped — quick-fix (scope-adaptive routing)", skipped: true };
  } else {
    console.log(`[ControlLoop] Step 4: Preflight gate...`);

    // 4a. Deterministic checklist — catches duplicates, scope issues, grounding contradictions
    const preflight = await preflightCheck(task, grounding, groundingSummary);
    if (!preflight.pass) {
      skepticResult = { verdict: "reject", reason: `Preflight: ${preflight.flags.join("; ")}` };
    } else if (task.risk === "high") {
      // 4b. High-risk tasks get a lightweight nano-model review
      console.log(`[ControlLoop] High-risk task — running nano-model review...`);
      skepticResult = await runHighRiskReview(cycleId, task, grounding, groundingSummary, ovSession);
    } else {
      // Low/medium risk with passing preflight — approve without agent call
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

    // Record lesson only for judgment-based rejections (nano-model), not preflight structural ones
    const isJudgmentRejection = !skepticResult.reason.startsWith("Preflight:");
    try {
      if (isJudgmentRejection) {
        await recordPlannerLesson(cycleId, task, "abandoned", { reason: `Review rejected: ${skepticResult.reason}` });
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to record rejection lessons: ${err.message}`);
    }

    // Circuit breaker: track consecutive abandonments for this anchor
    try {
      await trackAbandonment(anchor.reference, task, skepticResult.reason);
    } catch (err: any) {
      console.error(`[ControlLoop] Circuit breaker tracking failed: ${err.message}`);
    }

    await clearProcessingItem(anchor);
    await ovSession.logOutcome("abandoned", `Rejected: ${skepticResult.reason}`);
    await ovSession.commit();
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
      abandonReason: skepticResult.reason,
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
    // @ts-expect-error — migrate to proper types
  await tracker.transitionTask(taskId, "changed-code", { diffLength: diff.length, filesChanged: execResult.filesChanged || [] });
  console.log(`[ControlLoop] Code changed (${diff.split("\n").length} diff lines)`);

  // =========================================================================
  // Step 6: VERIFY — run hard checks (command execution, NOT an agent)
  // =========================================================================
  console.log(`[ControlLoop] Step 6: Verifying...`);
  let verificationPlan = task.verificationPlan?.length > 0
    ? task.verificationPlan
    // @ts-expect-error — migrate to proper types
    : defaultVerificationPlan(PROJECT_WORKSPACE);

  // Always include build check — catches Vercel deploy failures before merge
  const hasBuild = verificationPlan.some(s => s.command?.includes("build"));
  if (!hasBuild) {
    verificationPlan = [...verificationPlan, { command: "npm run build", expected: "exit code 0", label: "build" }];
  }

  let verification = await runVerification(PROJECT_WORKSPACE, verificationPlan);

  await ovSession.logVerification(verification, verification.allPassed);

  // =========================================================================
  // Step 6.5: FIXER — if verification failed, give a fixer agent one shot
  // at the specific errors before abandoning the cycle.
  // =========================================================================
  if (!verification.allPassed) {
    const failedSteps = verification.steps.filter((s) => !s.passed);
    const failedLabels = failedSteps.map(s => s.label);
    console.log(`[ControlLoop] Verification FAILED: ${failedLabels.join(", ")} — running fixer agent`);

    // Build a focused prompt with the exact error output
    const errorDetails = failedSteps.map(s => {
      const stderr = (s.stderr || "").trim();
      const stdout = (s.stdout || "").trim();
      const output = stderr || stdout;
      return `### ${s.label} (${s.command})\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\``;
    }).join("\n\n");

    const fixerPrompt = [
      `## FIX VERIFICATION ERRORS`,
      ``,
      `The executor just wrote code for: "${task.title}"`,
      `Verification ran and these steps FAILED:`,
      ``,
      errorDetails,
      ``,
      `## YOUR JOB`,
      `Fix ONLY the errors shown above. Do not refactor, do not add features, do not change anything unrelated.`,
      ``,
      `Common fixes:`,
      `- Test failures: update test expectations to match the new behavior, or fix the implementation bug`,
      `- TypeScript errors: add missing types, fix type mismatches`,
      `- Build errors: fix import paths, add missing exports, mark server-only pages as dynamic`,
      ``,
      `After fixing:`,
      `1. Run \`npm test\` to verify tests pass`,
      `2. Run \`npm run typecheck\` to verify no type errors`,
      `3. Run \`npm run build\` to verify build succeeds`,
      `4. Commit your fixes with a clear message`,
      ``,
      `Output JSON: { "summary": "what you fixed", "filesChanged": [...] }`,
    ].join("\n");

    const fixerPersonality = await findPersonality("executor");
    const fixerResult = await runAgent({
      agentName: "fixer",
      personality: fixerPersonality,
      prompt: fixerPrompt,
      model: "codex",
      taskId: `${taskId}-fix`,
      correlationId: cycleId,
      workDir: PROJECT_WORKSPACE,
    });

    await ovSession.logExecutor({ summary: `[Fixer] ${fixerResult.output?.slice(0, 200)}`, filesChanged: [] });
    await tracker.logAgentRun(cycleId, "fixer", taskId, fixerResult.duration, fixerResult.exitCode === 0 ? "fix-attempted" : "fix-failed", fixerResult.usage, fixerResult.costUsd);
    console.log(`[ControlLoop] Fixer completed (${Math.round(fixerResult.duration / 1000)}s, exit ${fixerResult.exitCode})`);

    // Re-verify after fixer
    console.log(`[ControlLoop] Re-verifying after fixer...`);
    verification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
    await ovSession.logVerification(verification, verification.allPassed);

    if (verification.allPassed) {
      console.log(`[ControlLoop] Fixer resolved all verification errors!`);
    }
  }

  if (!verification.allPassed) {
    const failedSteps = verification.steps.filter((s) => !s.passed).map((s) => s.label);
    console.log(`[ControlLoop] Verification STILL FAILED after fixer: ${failedSteps.join(", ")}`);
    Sentry.captureMessage(`Cycle ${cycleId} failed verification: ${failedSteps.join(", ")}`, {
      level: "warning",
      tags: { cycleId, taskTitle: task.title, anchorType: task.anchorType },
    });
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
      plannerModel: task.__plannerModel || "unknown",
      planCacheHit: task.__planCacheHit ? "true" : "false",
      executorModel: execResult?.__executorModel || "unknown",
    });

    // Route to Blocked if the failure looks like it needs operator intervention
    // (missing API keys, auth failures, etc.) — otherwise return to Backlog for retry.
    const blockedReason = looksOperatorBlocked(verification);
    if (blockedReason) {
      console.log(`[ControlLoop] Detected operator-blocked failure: ${blockedReason}`);
      await safeKanban(eventBus, cycleId, "moveToBlocked", anchor.reference, () => moveToBlocked(anchor.reference, blockedReason));
      // Alert operator — this needs human intervention
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type: "cycle:operator_blocked",
        source: "control-loop",
        correlationId: cycleId,
        payload: { taskId, title: task.title, blockedReason },
      });
    } else {
      await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "verification failed"));
    }

    // Record failure lessons for agents
    const failedStderr = verification.steps.find(s => !s.passed)?.stderr || "";
    try {
      await recordPlannerLesson(cycleId, task, "failed", { failReason: `Verification failed: ${failedSteps.join(", ")}`, failedSteps });
      await recordExecutorLesson(cycleId, task, "failed", { failedSteps, verificationStderr: failedStderr });
      await recordSkepticLesson(cycleId, task, "approve", "failed");
    } catch (err: any) {
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
    } catch (err: any) {
      console.error(`[ControlLoop] Broken branch cleanup failed (may leave stale branch): ${err.message}`);
    }

    await clearProcessingItem(anchor);
    await ovSession.logOutcome("failed", `Verification failed: ${failedSteps.join(", ")}`);
    await ovSession.commit();
    return {
      cycleId,
      tasks: [{ taskId, finalState: "failed", verification }],
      durationMs: Date.now() - startTime,
    };
  }

  await tracker.transitionTask(taskId, "verified", { verification });
  console.log(`[ControlLoop] Verification PASSED (${verification.totalDurationMs}ms)`);

  // =========================================================================
  // Step 6.5: RECONCILE — plan vs actual diff (PAUL UNIFY pattern)
  // Informational only — does not block merge. Findings go into the reality
  // report and trigger prevention rules for future cycles.
  // =========================================================================
  const reconciliation = reconcilePlanVsActual(task, verification);
  if (!reconciliation.aligned) {
    for (const w of reconciliation.warnings) {
      console.log(`[ControlLoop] RECONCILE: ${w}`);
    }
    // Record scope creep as a planner prevention rule
    if (reconciliation.scopeCreep.length > 0) {
      try {
        await recordPlannerLesson(cycleId, task, "merged", {
          filesChanged: verification.filesChanged.length,
          scopeCreep: reconciliation.scopeCreep,
        });
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to record scope-creep lesson: ${err.message}`);
      }
    }
  } else if (task.scopeBoundary?.in?.length > 0) {
    console.log(`[ControlLoop] RECONCILE: plan-vs-actual aligned (${verification.filesChanged.length} files)`);
  }

  // =========================================================================
  // Step 6.7: MUTATION TESTING — lightweight coverage check
  // Informational only — does not block merge. Survivors feed into the
  // reality report and planner memory so future cycles improve coverage.
  // =========================================================================
  let mutationReport: any = null;
  if (verification.filesChanged?.length > 0) {
    console.log(`[ControlLoop] Step 6.7: Running mutation tests on ${verification.filesChanged.length} changed files...`);
    try {
      mutationReport = await runMutationTests(PROJECT_WORKSPACE, verification.filesChanged, {
        timeBudgetMs: 60_000,
        testCommand: "npm test",
      });
      const killRate = mutationReport.totalMutants > 0
        ? Math.round((mutationReport.killed / (mutationReport.totalMutants - mutationReport.skipped)) * 100)
        : 100;
      console.log(`[ControlLoop] Mutation testing: ${killRate}% kill rate (${mutationReport.killed}/${mutationReport.totalMutants - mutationReport.skipped} killed, ${mutationReport.survived} survived)`);
      if (mutationReport.survived > 0) {
        console.log(`[ControlLoop] ⚠ ${mutationReport.survived} surviving mutants — executor's tests may not cover changed behavior`);
        for (const s of mutationReport.survivors.slice(0, 3)) {
          console.log(`[ControlLoop]   ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]`);
        }
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Mutation testing failed (non-fatal): ${err.message}`);
    }
  }

  // =========================================================================
  // Step 6.9: SCOPE ENFORCEMENT — hard gate on out-of-scope changes
  // If >80% of changed files are outside planned scope, reject the merge.
  // =========================================================================
  if (task.scopeBoundary?.in?.length > 0 && verification.filesChanged?.length > 0) {
    const inScope = new Set((task.scopeBoundary.in as string[]).map((f: string) => f.replace(/^web\//, "")));
    const outOfScope = verification.filesChanged.filter((f: string) => {
      const normalized = f.replace(/^web\//, "");
      return !inScope.has(normalized) && ![...inScope].some((s: string) => normalized.startsWith(s) || normalized.endsWith(s));
    });
    const outOfScopeRatio = outOfScope.length / verification.filesChanged.length;
    if (outOfScopeRatio > 0.8 && outOfScope.length > 3) {
      console.error(`[ControlLoop] SCOPE GATE: ${outOfScope.length}/${verification.filesChanged.length} files (${Math.round(outOfScopeRatio * 100)}%) outside scope — blocking merge`);
      console.error(`[ControlLoop] Out-of-scope files: ${outOfScope.slice(0, 5).join(", ")}${outOfScope.length > 5 ? ` (+${outOfScope.length - 5} more)` : ""}`);

      await tracker.transitionTask(taskId, "failed", { reason: `Scope gate: ${outOfScope.length}/${verification.filesChanged.length} files outside planned scope` });
      await storePriorFailure(taskId, `Scope gate blocked merge: ${Math.round(outOfScopeRatio * 100)}% out of scope`, verification);
      await recordPlannerLesson(cycleId, task, "failed", { failReason: `Scope gate: ${outOfScope.length} files outside scope`, failedSteps: ["scope-enforcement"] });
      await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "scope gate blocked merge"));

      // Clean up the branch
      try {
        const { stdout: branchName } = await execFileAsync("git", ["branch", "--show-current"], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
        const broken = branchName.trim();
        await execFileAsync("git", ["checkout", "main"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
        await execFileAsync("git", ["clean", "-fd"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
        await execFileAsync("git", ["checkout", "."], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
        if (broken && broken !== "main") {
          await execFileAsync("git", ["branch", "-D", broken], { cwd: PROJECT_WORKSPACE, timeout: 5000 });
        }
      } catch (cleanErr: any) {
        console.error(`[ControlLoop] Scope-gate branch cleanup failed: ${cleanErr.message}`);
      }

      await clearProcessingItem(anchor);
      await ovSession.logOutcome("failed", `Scope gate: ${outOfScope.length} files outside scope`);
      await ovSession.commit();
      return {
        cycleId,
        tasks: [{ taskId, finalState: "failed", reason: `Scope gate: ${Math.round(outOfScopeRatio * 100)}% out of scope` }],
        durationMs: Date.now() - startTime,
      };
    }
  }

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

    // Restart the web service so it picks up the new build artifacts.
    // Without this, `next start` serves stale HTML referencing CSS/JS chunk
    // hashes from the previous build, causing 404s on every asset.
    try {
      await execFileAsync("systemctl", ["--user", "restart", "hydra-betting-web.service"], { timeout: 120_000 });
      console.log(`[ControlLoop] Restarted hydra-betting-web.service after merge`);
    } catch (restartErr: any) {
      console.error(`[ControlLoop] Failed to restart hydra-betting-web.service: ${restartErr.message}`);
    }
  } else {
    console.error(`[ControlLoop] Merge failed: ${mergeResult.error}`);

    // Clean up the dirty working tree so the next cycle can start fresh.
    // Without this, a failed merge leaves uncommitted changes on a feature
    // branch, causing prepareWorkspace to skip cleanup every subsequent cycle
    // (the "dirty tree death spiral" — see post-mortem 2026-04-22).
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
      // -m 1 is required because Hydra always merges with --no-ff, making
      // every merge commit a two-parent commit. Without -m 1, git revert
      // fails with "commit is a merge but no -m option was given."
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
      survivors: mutationReport.survivors.slice(0, 5).map((s) => ({
        file: s.mutation.file,
        line: s.mutation.line,
        type: s.mutation.type,
      })),
    } : null,
    adversarialValidation: null as any,
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

  // Write reality report to Redis
  const reportRedis = (await import("ioredis")).default;
  const reportConn = new reportRedis(process.env.REDIS_URL || "redis://localhost:6379");
  try {
    await reportConn.set(`hydra:reports:reality:${cycleId}`, JSON.stringify(report), "EX", CYCLE_KEY_TTL);
    await reportConn.zadd("hydra:reports:reality:index", Date.now(), cycleId);
    // Trim to 50 most recent
    const count = await reportConn.zcard("hydra:reports:reality:index");
    if (count > 50) {
      const old = await reportConn.zrange("hydra:reports:reality:index", 0, count - 51);
      for (const id of old) {
        await reportConn.del(`hydra:reports:reality:${id}`);
        await reportConn.zrem("hydra:reports:reality:index", id);
      }
    }
  } finally {
    reportConn.disconnect();
  }

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
  });

  // Step 8.1: Pattern detection — check for systemic issues across recent cycles
  await detectPatterns(eventBus, cycleId);

  // Step 8.2: Tell OV which resources were used — feeds relevance weighting
  if (commitSha && !rolledBack && verification.filesChanged?.length > 0) {
    const usedUris = verification.filesChanged
      .map(f => `viking://resources/hydra/config/${f.replace(/^config\//, "")}`)
      .filter(uri => uri.includes("/")); // only meaningful URIs
    await ovSession.markUsed(usedUris);
  }

  // Update Kanban backlog — use anchor.reference (not planner-generated task.title)
  // so the row in Kanban's Queued lane matches for the move. The planner's title
  // almost never matches the original backlog entry, which was leaving rows stuck
  // in Queued forever (2026-04-08 debug session).
  const finalState = rolledBack ? "rolled-back" : (commitSha ? "merged" : "verified");
  if (finalState === "merged") {
    // Clear abandonment counter on success — this anchor is no longer stuck
    try { await clearAbandonmentCounter(anchor.reference); } catch { /* intentional: best-effort cleanup */ }

    // If this task came from a spec, mark the spec task complete
    if (anchor.context?.specSlug && anchor.context?.specTaskId) {
      try {
        await markTaskComplete(anchor.context.specSlug, anchor.context.specTaskId, cycleId);
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to update spec "${anchor.context.specSlug}": ${err.message}`);
      }
    }

    await safeKanban(eventBus, cycleId, "moveToDone", anchor.reference, () => moveToDone(anchor.reference, "merged"));
  } else {
    await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, finalState));
  }

  // =========================================================================
  // Step 8.5: LEARNING — handled by OV session commit
  // The session commit (at cycle end) triggers automatic memory extraction
  // from the full cycle conversation. This replaces manual compoundLearnings.
  // Redis prevention rules are kept as a bootstrap fallback via loadAgentMemory.
  // =========================================================================

  // =========================================================================
  // Step 8.7: ADVERSARIAL VALIDATION — self-play quality gate
  // After a successful merge (no rollback), run a nano-model adversary to
  // find edge cases and untested code paths. Findings are queued as work.
  // =========================================================================
  if (commitSha && !rolledBack && verification.filesChanged?.length > 0) {
    try {
      console.log(`[ControlLoop] Step 8.7: Running adversarial validation...`);
      const advReport = await runAdversarialValidation(cycleId, task.title, verification.filesChanged, commitSha);
      if (advReport.findings.length > 0) {
        console.log(`[ControlLoop] Adversarial: ${advReport.findings.length} finding(s) — ${advReport.findings.filter(f => f.severity === "high").length} high, ${advReport.findings.filter(f => f.severity === "medium").length} medium`);
        // Queue medium+ findings as work items
        const queueItems = findingsToQueueItems(advReport);
        if (queueItems.length > 0) {
          const Redis = (await import("ioredis")).default;
          const advRedis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
          for (const item of queueItems.slice(0, 3)) { // max 3 per cycle
            await advRedis.rpush("hydra:anchors:work-queue", JSON.stringify(item));
            console.log(`[ControlLoop] Adversarial: queued fix — ${item.reference.slice(0, 80)}`);
          }
          advRedis.disconnect();
        }
        report.adversarialValidation = {
          findings: advReport.findings.length,
          high: advReport.findings.filter(f => f.severity === "high").length,
          medium: advReport.findings.filter(f => f.severity === "medium").length,
          queued: queueItems.length,
          durationMs: advReport.durationMs,
        };
      } else {
        console.log(`[ControlLoop] Adversarial: no findings (${advReport.durationMs}ms)`);
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Adversarial validation failed (non-fatal): ${err.message}`);
    }

    // Track this merge for revert correlation
    try {
      await trackMergedCommit(cycleId, commitSha, []);
    } catch { /* intentional: tracking is best-effort */ }
  }

  // Check revert correlation on merged cycles (updates adversarial precision stats)
  try {
    await checkRevertCorrelation(PROJECT_WORKSPACE);
  } catch { /* intentional: correlation check is best-effort */ }

  // Complete the cycle in tracker
  await tracker.redis.hset(`hydra:cycle:${cycleId}`, "status", "completed", "completedAt", new Date().toISOString());
  // Refresh TTL so the 7-day window starts from cycle completion
  await tracker.redis.expire(`hydra:cycle:${cycleId}`, CYCLE_KEY_TTL);
  await tracker.redis.set("hydra:cycle:last", cycleId);
  await tracker.redis.del("hydra:cycle:active");

  // Trigger Meta analysis: every 20 cycles (strategic review) OR when failures detected (fast-path)
  try {
    const { getMetricsTrend } = await import("./metrics.ts");
    const trend = await getMetricsTrend(20);
    const recentFailures = trend.slice(0, 5).filter((m) => m.tasksFailed > 0).length;
    const totalCycles = trend.length;

    // Fast-path: 2+ failures in last 5 cycles — something is going wrong
    if (totalCycles >= 5 && recentFailures >= 2) {
      console.log(`[ControlLoop] Triggering Meta analysis — fast-path (${recentFailures} failures in last 5 cycles)`);
      await eventBus.publish(STREAMS.META, {
        type: "cycle:report",
        source: "control-loop",
        correlationId: cycleId,
        payload: { trigger: "failure_fast_path", recentFailures },
      });
    // Regular interval: every 20 cycles — strategic review
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

  // Commit OV session — triggers automatic memory extraction from this cycle
  const cycleOutcome = report.task?.finalState || "unknown";
  await ovSession.logOutcome(cycleOutcome, `${task.title} — ${report.durationMs}ms`);
  await ovSession.commit();

  await clearProcessingItem(anchor);
  return report;

  } finally {
    // Commit OV session on crash paths — without this, any unhandled
    // exception loses the cycle's agent conversation and OV never
    // extracts memories from it. The happy path commits above, so
    // this is a no-op (session already inactive) in the normal case.
    if (ovSession.active) {
      await ovSession.logOutcome("crashed", "Cycle terminated by unhandled exception").catch(() => {});
      await ovSession.commit().catch((err: any) =>
        console.error(`[ControlLoop] OV session crash-commit failed: ${err.message}`)
      );
    }
    // Release the distributed cycle lock on every exit path
    await tracker.redis.del(CYCLE_LOCK_KEY).catch((err: any) =>
      console.error(`[ControlLoop] Failed to release cycle lock: ${err.message}`)
    );
  }
}

// ---------------------------------------------------------------------------
// Planner agent extracted to planner-prompt.ts
// runPlannerAgent, buildResearchContext, validateTaskSchema, PLANNER_OUTPUT_SCHEMA
// are imported from ./planner-prompt.ts above.
// ---------------------------------------------------------------------------

async function runExecutorAgent(cycleId, task, grounding, groundingSummary, ovSession = null, complexity = "standard") {
  // Create an isolated worktree for the executor to prevent scope creep
  // from shared workspace state (formatting artifacts, operator changes).
  const branchName = `feature/${cycleId}-slug`;
  const worktreePath = join(PROJECT_WORKSPACE, "..", `hydra-betting-worktree-${cycleId}`);
  let useWorktree = false;
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branchName, worktreePath, "main"], {
      cwd: PROJECT_WORKSPACE,
      timeout: 15000,
    });
    useWorktree = true;
    console.log(`[ControlLoop] Created worktree at ${worktreePath} on branch ${branchName}`);
  } catch (err: any) {
    console.error(`[ControlLoop] Worktree creation failed (falling back to shared workspace): ${err.message}`);
  }
  const executorWorkDir = useWorktree ? worktreePath : PROJECT_WORKSPACE;

  // Load executor memory + OV context in parallel
  const [executorMemory, ovCtx] = await Promise.all([
    loadAgentMemory("executor"),
    ovSession?.getAgentContext?.("executor", { reference: task.title, whyNow: (task.scopeBoundary?.in || []).join(" ") }) || Promise.resolve({ formatted: "" }),
  ]);
  const executorKnowledge = ovCtx.formatted || "";

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
    executorKnowledge,
    "",
    `## RULES`,
    ...(useWorktree ? [
      `1. You are in an isolated worktree on branch \`${branchName}\`. The workspace is clean. Start working immediately — do NOT run git checkout or create branches.`,
    ] : [
      `1. FIRST: \`git checkout main && git pull origin main\` then create feature branch: \`git checkout -b ${branchName}\``,
    ]),
    ...(complexity !== "quick-fix" ? [
      `2. **TEST-FIRST**: Before writing any implementation code, write failing tests that verify each acceptance criterion. Run \`npm test\` to confirm they fail for the right reason.`,
      `3. Then implement the SMALLEST change that makes all tests pass.`,
      `4. Run \`npm test\` again — all tests (old and new) must pass before committing.`,
      `4b. **MUTATION SELF-CHECK**: Pick one key condition or return value in your implementation. Temporarily negate it (e.g. change \`===\` to \`!==\`, \`true\` to \`false\`). Run \`npm test\`. If tests STILL PASS, your tests don't cover that behavior — improve them. Restore the original code after.`,
    ] : [
      `2. Make the SMALLEST change that satisfies the acceptance criteria`,
      `3. Write or update tests for your changes — RUN THEM before committing: \`npm test\``,
      `4. If tests FAIL, fix your code until they pass. Do not commit failing code.`,
    ]),
    `5. **SCOPE CLEANUP**: Before committing, run \`git diff --name-only main\` and \`git checkout main -- <file>\` for ANY file NOT listed in your scopeBoundary.in. Do NOT commit formatting, linting, or other changes to files outside your scope.`,
    `6. Commit to the feature branch with clear commit messages`,
    `7. NEVER merge into main — the control loop handles merging after verification`,
    `8. Push your branch when done`,
    `9. NEVER delete or remove files in src/lib/providers/ — these are foundational venue adapters even if not yet imported elsewhere`,
    `10. NEVER create "cleanup" or "remove unused" commits — if code exists with tests, it is intentional`,
    `11. If you create or modify database migrations (drizzle SQL files), you MUST also update drizzle/meta/_journal.json with the new entry. Migration SQL without a journal entry will silently fail.`,
    "",
    `Output ONLY valid JSON:`,
    `{ "summary": "...", "filesChanged": [...], "commits": [...], "branch": "...", "testsRun": { "passed": N, "failed": N } }`,
  ].join("\n");

  const personality = await findPersonality("executor");
  const result = await runAgent({
    agentName: "executor",
    personality,
    prompt,
    model: "codex",
    taskId: task.taskId,
    correlationId: cycleId,
    workDir: executorWorkDir,
  });

  // If using worktree, push the branch and clean up the worktree
  if (useWorktree) {
    try {
      // Push the branch from the worktree so it's available in the main repo
      await execFileAsync("git", ["push", "origin", branchName], {
        cwd: executorWorkDir,
        timeout: 30000,
      }).catch(() => { /* intentional: push may fail if no commits */ });

      // Fetch the branch into the main repo
      await execFileAsync("git", ["fetch", "origin", branchName], {
        cwd: PROJECT_WORKSPACE,
        timeout: 15000,
      }).catch(() => {});

      // Checkout the executor's branch in the main workspace for verification
      await execFileAsync("git", ["checkout", branchName], {
        cwd: PROJECT_WORKSPACE,
        timeout: 10000,
      }).catch(() => {});
    } catch (err: any) {
      console.error(`[ControlLoop] Worktree branch sync failed: ${err.message}`);
    }

    // Remove the worktree
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: PROJECT_WORKSPACE,
        timeout: 15000,
      });
      console.log(`[ControlLoop] Cleaned up worktree at ${worktreePath}`);
    } catch (err: any) {
      console.error(`[ControlLoop] Worktree cleanup failed (manual cleanup needed): ${err.message}`);
    }
  }

  let output: Record<string, any> = {};
  try {
    output = JSON.parse(result.output);
  } catch {
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        output = JSON.parse(match[0]);
      } catch (err: any) {
        console.error(`[ControlLoop] Executor output unparseable even after regex extraction: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Executor output contained no JSON object`);
    }
  }

  await getTracker().logAgentRun(cycleId, "executor", task.taskId, result.duration, "completed", result.usage, result.costUsd);
  return { ...output, exitCode: result.exitCode, duration: result.duration, __executorModel: result.model, __worktreeUsed: useWorktree };
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
  } catch (err: any) {
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
    const Redis = (await import("ioredis")).default;
    const rConn = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
    const recentIds = await rConn.zrevrange("hydra:reports:reality:index", 0, 0);
    if (recentIds.length === 0) { rConn.disconnect(); return null; }
    const raw = await rConn.get(`hydra:reports:reality:${recentIds[0]}`);
    rConn.disconnect();
    return raw ? JSON.parse(raw) : null;
  } catch (err: any) {
    console.error(`[ControlLoop] loadLastCycleReportFull failed: ${err.message}`);
    return null;
  }
}
