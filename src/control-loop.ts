import * as Sentry from "@sentry/node";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STREAMS } from "./event-bus.ts";
import { runAgent, findPersonality } from "./codex-runner.ts";
import { getTracker, CYCLE_KEY_TTL } from "./task-tracker.ts";
import { groundProject, summarizeForPrompt, getDiff } from "./grounding.ts";
import {
  registerCycleSource, releaseCycleSource,
  setCycleActive, clearCycleActive, setCycleLast,
  initCycleHash, updateCycleHash, refreshCycleTTL,
  acquireMergeLock, getMergeLockHolder, releaseMergeLock,
  saveRealityReport, trimRealityReports,
  pushToWorkQueue,
} from "./redis-adapter.ts";
import { prepareWorkspace } from "./prepare-workspace.ts";
import { mergeToMain } from "./merge.ts";
import { runVerification, validateDiffExists, summarizeVerification, defaultVerificationPlan } from "./verifier.ts";
import { runMutationTests } from "./mutation-testing.ts";
import { runJitTests } from "./jit-testing.ts";
import { runAdversarialValidation, findingsToQueueItems, trackMergedCommit, checkRevertCorrelation } from "./adversarial-validation.ts";
// sendNotification removed — all notifications go through eventBus → digest system
import { recordCycleMetrics, detectDrift } from "./metrics.ts";
import { loadAgentMemory, formatMemoryForPrompt, recordPlannerLesson, recordExecutorLesson, recordSkepticLesson, recordReflection, clearReflections } from "./agent-memory.ts";
import { recordReflection as recordGlobalReflection, clearReflectionsForAnchor } from "./reflections.ts";
import { runPlannerAgent } from "./planner-prompt.ts";
import { runExecutorAgent } from "./executor-agent.ts";
// priorities-refresh removed — the research-strategist handles refresh inside
// the research loop (Step 5.5). Stale-detection just warns now.
import { moveToInProgress, moveToDone, returnToBacklog, moveToBlocked } from "./backlog.ts";
import { detectPatterns } from "./pattern-detector.ts";
import { createCycleSession } from "./ov-session.ts";
import { markTaskComplete } from "./specs.ts";
import { selectAnchor, trackAbandonment, clearAbandonmentCounter, storePriorFailure, clearProcessingItem } from "./anchor-selection.ts";
import { scoreAnchor, getMinConfidence, recordCalibrationOutcome } from "./anchor-scorer.ts";
import { looksOperatorBlocked, reconcilePlanVsActual, classifyTaskComplexity, preflightCheck, runHighRiskReview } from "./preflight.ts";

const execFileAsync = promisify(execFile);

const PROJECT_WORKSPACE = process.env.HYDRA_PROJECT_WORKSPACE || resolve(process.env.HOME, "hydra-betting");

// ---------------------------------------------------------------------------
// Grounding cache — skip re-running 49s test suite if HEAD hasn't changed
// ---------------------------------------------------------------------------
let _groundingCache: { headCommit: string; result: any; cachedAt: number } | null = null;
const GROUNDING_CACHE_MAX_AGE_MS = 5 * 60_000; // 5 min staleness limit

async function groundProjectCached(projectDir: string): Promise<any> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, timeout: 5000 });
  const currentHead = stdout.trim();

  if (
    _groundingCache &&
    _groundingCache.headCommit === currentHead &&
    Date.now() - _groundingCache.cachedAt < GROUNDING_CACHE_MAX_AGE_MS
  ) {
    console.log(`[ControlLoop] Grounding cache HIT (HEAD ${currentHead.slice(0, 7)} unchanged)`);
    return _groundingCache.result;
  }

  const result = await groundProject(projectDir);
  _groundingCache = { headCommit: currentHead, result, cachedAt: Date.now() };
  return result;
}

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
  const grounding = await groundProjectCached(PROJECT_WORKSPACE);
  const groundingSummary = summarizeForPrompt(grounding);
  console.log(`[ControlLoop] Grounded: ${grounding.testReport.passed} tests passing, ${grounding.testReport.failed} failing (${grounding.groundingDurationMs}ms)`);

  // =========================================================================
  // Step 2: SELECT ANCHOR — what are we working on and why?
  // (Continuity context loading moved to context-builder.ts —
  //  buildPlannerContext handles last-cycle report, repo diff, and reflections)
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
  // Saves frontier-model inference cost on anchors that will produce no task.
  // =========================================================================
  const anchorStale = await isAnchorStale(anchor);
  if (anchorStale) {
    console.log(`[ControlLoop] Anchor pre-validation SKIPPED: ${anchorStale}`);
    await clearProcessingItem(anchor);
    await ovSession.logOutcome("skipped", `Anchor stale: ${anchorStale}`);
    await ovSession.commit();
    await recordCycleMetrics(cycleId, {
      tasksAttempted: 0, tasksFailed: 0, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
      testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
      testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
      filesChanged: 0, totalDurationMs: Date.now() - startTime,
      groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: 0,
      regressionIntroduced: false, taskTitle: `Skipped: ${anchorStale}`,
      anchorType: anchor.type, anchorReference: anchor.reference,
      plannerModel: "none", planCacheHit: "false",
    });
    return { cycleId, tasks: [], reason: `Anchor stale: ${anchorStale}`, durationMs: Date.now() - startTime };
  }

  // =========================================================================
  // Step 2.7: CONFIDENCE SCORING — predict whether this anchor will produce work
  // Lightweight two-tier scorer: heuristic first, nano-model for ambiguous cases.
  // Skips anchors below ANCHOR_MIN_CONFIDENCE to reduce empty cycles.
  // =========================================================================
  let anchorConfidence: { score: number; reason: string; tier: "heuristic" | "classifier" } | null = null;
  let anchorSkipped = false;
  try {
    anchorConfidence = await scoreAnchor(anchor, grounding);
    const minConf = getMinConfidence();
    console.log(`[ControlLoop] Anchor confidence: ${anchorConfidence.score.toFixed(2)} (${anchorConfidence.tier}) — ${anchorConfidence.reason}`);

    if (anchorConfidence.score < minConf) {
      anchorSkipped = true;
      console.log(`[ControlLoop] Anchor confidence ${anchorConfidence.score.toFixed(2)} < threshold ${minConf} — skipping`);
      await clearProcessingItem(anchor);
      await ovSession.logOutcome("skipped", `Low confidence: ${anchorConfidence.score.toFixed(2)} — ${anchorConfidence.reason}`);
      await ovSession.commit();
      await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, "no-task");
      await recordCycleMetrics(cycleId, {
        tasksAttempted: 0, tasksFailed: 0, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
        testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
        testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
        filesChanged: 0, totalDurationMs: Date.now() - startTime,
        groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: 0,
        regressionIntroduced: false, taskTitle: `Skipped (low confidence): ${anchorConfidence.reason}`,
        anchorType: anchor.type, anchorReference: anchor.reference,
        plannerModel: "none", planCacheHit: "false",
        anchorConfidence: anchorConfidence.score,
        anchorSkipped: true,
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
    // Record episodic reflection for future retries (per-anchor + global buffer)
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
      anchorConfidence: anchorConfidence?.score ?? null,
      anchorSkipped: false,
    });
    if (anchorConfidence) {
      await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, "no-task");
    }
    return { cycleId, tasks: [], reason: "Planner produced no task", durationMs: Date.now() - startTime };
  }

  await ovSession.logPlanner(anchor, task);

  // Initialize task in Redis with v2 schema
  const taskId = `task-${cycleId}-1`;
  task.taskId = taskId;

  // Register this Codex cycle — informational, not a blocking mutex.
  // Claude Code cycles register under hydra:cycle:active:claude via the API.
  // The old global hydra:cycle:lock is replaced by a short-lived merge lock
  // (hydra:merge:lock, 60s TTL) acquired only during git merge+push.
  const CYCLE_SOURCE_TTL = 900; // 15-minute auto-expire (crash safety)
  await registerCycleSource("codex", cycleId, CYCLE_SOURCE_TTL);

  // Init cycle tracking
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

    // Record episodic reflection for future retries (per-anchor + global buffer)
    await recordReflection({
      cycleId, anchorRef: anchor.reference, taskTitle: task.title,
      outcome: "verification-failed", reason: `Verification failed: ${failedSteps.join(", ")}`,
      verificationErrors: failedSteps,
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record reflection: ${err.message}`));
    await recordGlobalReflection({
      cycleId, anchorType: anchor.type, anchorReference: anchor.reference,
      failureMode: "verification-failed", whatFailed: task.title,
      whyItFailed: `Verification failed: ${failedSteps.join(", ")}`,
      whatToTryDifferently: `Address these specific verification failures: ${failedSteps.join(", ")}. Consider narrower scope or fixing verification errors before adding new behavior.`,
    }).catch((err: any) => console.error(`[ControlLoop] Failed to record global reflection: ${err.message}`));

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
  // Step 6.7: MUTATION TESTING — coverage quality gate
  // For standard/complex tasks: block merge when kill rate < 30%.
  // For quick-fix: informational only (skip gate).
  // Survivors feed into the reality report and planner memory.
  // =========================================================================
  let mutationReport: any = null;
  if (verification.filesChanged?.length > 0) {
    console.log(`[ControlLoop] Step 6.7: Running mutation tests on ${verification.filesChanged.length} changed files...`);
    try {
      mutationReport = await runMutationTests(PROJECT_WORKSPACE, verification.filesChanged, {
        timeBudgetMs: 60_000,
        testCommand: "npm test",
      });
      const testable = mutationReport.totalMutants - mutationReport.skipped;
      const killRate = testable > 0
        ? Math.round((mutationReport.killed / testable) * 100)
        : 100;
      console.log(`[ControlLoop] Mutation testing: ${killRate}% kill rate (${mutationReport.killed}/${testable} killed, ${mutationReport.survived} survived)`);
      if (mutationReport.survived > 0) {
        console.log(`[ControlLoop] ${mutationReport.survived} surviving mutants — executor's tests may not cover changed behavior`);
        for (const s of mutationReport.survivors.slice(0, 3)) {
          console.log(`[ControlLoop]   ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]`);
        }
      }

      // Hard gate: block merge when kill rate is critically low on non-trivial tasks
      const MUTATION_KILL_THRESHOLD = 30;
      if (complexity !== "quick-fix" && testable >= 3 && killRate < MUTATION_KILL_THRESHOLD) {
        console.error(`[ControlLoop] MUTATION GATE: kill rate ${killRate}% < ${MUTATION_KILL_THRESHOLD}% threshold — blocking merge`);
        await tracker.transitionTask(taskId, "failed", { reason: `Mutation gate: ${killRate}% kill rate (${mutationReport.survived} survivors)` });
        await storePriorFailure(taskId, `Mutation gate: tests don't cover changed behavior (${killRate}% kill rate)`, verification);
        await recordPlannerLesson(cycleId, task, "failed", { failReason: `Mutation gate: ${killRate}% kill rate`, failedSteps: ["mutation-testing"] });
        await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "mutation gate blocked merge"));

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
          console.error(`[ControlLoop] Mutation-gate branch cleanup failed: ${cleanErr.message}`);
        }

        await clearProcessingItem(anchor);
        await ovSession.logOutcome("failed", `Mutation gate: ${killRate}% kill rate`);
        await ovSession.commit();
        await recordCycleMetrics(cycleId, {
          tasksAttempted: 1, tasksFailed: 1, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
          testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
          testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
          filesChanged: verification.filesChanged.length, totalDurationMs: Date.now() - startTime,
          groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: verification.totalDurationMs,
          regressionIntroduced: false, taskTitle: task.title,
          anchorType: task.anchorType, anchorReference: task.anchorReference,
          complexity, filesInScope, criteriaCount,
          plannerModel: task.__plannerModel || "unknown",
          executorModel: execResult?.__executorModel || "unknown",
          mutationKillRate: killRate,
        });
        return {
          cycleId,
          tasks: [{ taskId, finalState: "failed", reason: `Mutation gate: ${killRate}% kill rate` }],
          durationMs: Date.now() - startTime,
        };
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Mutation testing failed (non-fatal): ${err.message}`);
    }
  }

  // =========================================================================
  // Step 6.8: DIFF-AWARE TEST GENERATION (JIT testing pattern)
  // When mutation testing found survivors on standard/complex tasks, generate
  // targeted tests for the uncovered code paths. Uses codex-tier model.
  // Only runs when: survivors > 0, complexity != quick-fix, kill rate < 80%.
  // =========================================================================
  if (mutationReport?.survived > 0 && complexity !== "quick-fix") {
    const testable = mutationReport.totalMutants - mutationReport.skipped;
    const killRate = testable > 0 ? Math.round((mutationReport.killed / testable) * 100) : 100;

    if (killRate < 80) {
      console.log(`[ControlLoop] Step 6.8: Generating diff-aware tests for ${mutationReport.survived} surviving mutants...`);
      try {
        const survivorDetails = mutationReport.survivors.slice(0, 5).map((s) =>
          `- ${s.mutation.file}:${s.mutation.line} [${s.mutation.type}]: ${s.mutation.description || "mutation survived"}`
        ).join("\n");

        const jitPrompt = [
          `## GENERATE TESTS FOR UNCOVERED CODE`,
          ``,
          `The executor just implemented: "${task.title}"`,
          `Mutation testing found ${mutationReport.survived} surviving mutants — the existing tests don't cover these code paths.`,
          ``,
          `### Surviving mutants (tests needed for these):`,
          survivorDetails,
          ``,
          `### Changed files:`,
          verification.filesChanged.map((f: string) => `- ${f}`).join("\n"),
          ``,
          `## YOUR JOB`,
          `Write tests that would FAIL if these mutations were applied. Each test should:`,
          `1. Target a specific surviving mutant`,
          `2. Assert the correct behavior that the mutation would break`,
          `3. Follow the project's existing test patterns`,
          ``,
          `Do NOT modify implementation code. Only add/modify test files.`,
          `Run \`npm test\` after writing tests to verify they pass.`,
          `Commit with message: "test: add diff-aware tests for [description]"`,
          ``,
          `Output JSON: { "summary": "what tests you added", "filesChanged": [...], "testsAdded": N }`,
        ].join("\n");

        const jitPersonality = await findPersonality("executor");
        const jitResult = await runAgent({
          agentName: "jit-tester",
          personality: jitPersonality,
          prompt: jitPrompt,
          model: "codex",
          taskId: `${taskId}-jit`,
          correlationId: cycleId,
          workDir: PROJECT_WORKSPACE,
        });

        await tracker.logAgentRun(cycleId, "jit-tester", taskId, jitResult.duration, jitResult.exitCode === 0 ? "tests-generated" : "generation-failed", jitResult.usage, jitResult.costUsd);
        console.log(`[ControlLoop] JIT test generation: ${Math.round(jitResult.duration / 1000)}s, exit ${jitResult.exitCode}`);

        // Re-verify after adding tests — don't merge if new tests break
        if (jitResult.exitCode === 0) {
          console.log(`[ControlLoop] Re-verifying after JIT test generation...`);
          const jitVerification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
          if (!jitVerification.allPassed) {
            console.log(`[ControlLoop] JIT tests introduced failures — reverting test changes`);
            try {
              await execFileAsync("git", ["checkout", "HEAD~1", "--", "."], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
            } catch { /* intentional: revert best-effort */ }
          } else {
            console.log(`[ControlLoop] JIT tests pass — included in merge`);
            // Update verification and filesChanged for the report
            verification = jitVerification;
          }
        }
      } catch (err: any) {
        console.error(`[ControlLoop] JIT test generation failed (non-fatal): ${err.message}`);
      }
    }
  }

  // =========================================================================
  // Step 6.85: JIT TEST GENERATION — adversarial regression tests from diff
  // For standard/complex tasks, generate tests targeting the diff itself.
  // Independent of mutation testing — runs on every non-quick-fix diff.
  // Tests that pass are kept; failing ones discarded; bug-catchers block merge.
  // =========================================================================
  let jitReport: any = null;
  if (complexity !== "quick-fix" && diff && verification.filesChanged?.length > 0) {
    console.log(`[ControlLoop] Step 6.85: Running JiT test generation on diff...`);
    try {
      jitReport = await runJitTests(
        PROJECT_WORKSPACE,
        diff,
        verification.filesChanged,
        task.title,
        cycleId,
        taskId,
      );
      console.log(`[ControlLoop] JiT tests: ${jitReport.generated} generated, ${jitReport.kept} kept, ${jitReport.discarded} discarded${jitReport.caughtBug ? " — BUG DETECTED" : ""}`);

      if (jitReport.caughtBug) {
        console.error(`[ControlLoop] JIT GATE: generated test caught a bug — blocking merge`);
        console.error(`[ControlLoop] Bug details: ${jitReport.bugDetails?.slice(0, 300)}`);
        await tracker.transitionTask(taskId, "failed", { reason: `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}` });
        await storePriorFailure(taskId, `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}`, verification);
        await recordPlannerLesson(cycleId, task, "failed", { failReason: "JiT test caught a regression bug", failedSteps: ["jit-testing"] });
        await safeKanban(eventBus, cycleId, "returnToBacklog", anchor.reference, () => returnToBacklog(anchor.reference, "JiT test caught bug"));

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
          console.error(`[ControlLoop] JiT-gate branch cleanup failed: ${cleanErr.message}`);
        }

        await clearProcessingItem(anchor);
        await ovSession.logOutcome("failed", `JiT test caught bug: ${jitReport.bugDetails?.slice(0, 200)}`);
        await ovSession.commit();
        await recordCycleMetrics(cycleId, {
          tasksAttempted: 1, tasksFailed: 1, tasksMerged: 0, tasksVerified: 0, tasksAbandoned: 0,
          testsBefore: grounding.testReport.passed, testsAfter: grounding.testReport.passed,
          testsPassingBefore: grounding.testReport.passed, testsPassingAfter: grounding.testReport.passed,
          filesChanged: verification.filesChanged.length, totalDurationMs: Date.now() - startTime,
          groundingDurationMs: grounding.groundingDurationMs, verificationDurationMs: verification.totalDurationMs,
          regressionIntroduced: false, taskTitle: task.title,
          anchorType: task.anchorType, anchorReference: task.anchorReference,
          complexity, filesInScope, criteriaCount,
          plannerModel: task.__plannerModel || "unknown",
          executorModel: execResult?.__executorModel || "unknown",
          jitTestsGenerated: jitReport.generated,
          jitTestsKept: jitReport.kept,
          jitTestsCaughtBug: 1,
        });
        return {
          cycleId,
          tasks: [{ taskId, finalState: "failed", reason: `JiT test caught bug` }],
          durationMs: Date.now() - startTime,
        };
      }

      // If JiT tests were kept, re-verify to make sure full test suite still passes
      if (jitReport.kept > 0) {
        console.log(`[ControlLoop] Re-verifying after JiT test generation (${jitReport.kept} tests added)...`);
        const jitVerification = await runVerification(PROJECT_WORKSPACE, verificationPlan);
        if (!jitVerification.allPassed) {
          console.log(`[ControlLoop] JiT tests caused verification failure — reverting JiT test commits`);
          // Revert the JiT test commits
          for (let i = 0; i < jitReport.kept; i++) {
            try {
              await execFileAsync("git", ["revert", "--no-edit", "HEAD"], { cwd: PROJECT_WORKSPACE, timeout: 10000 });
            } catch { /* intentional: revert best-effort */ }
          }
          jitReport.kept = 0;
          jitReport.discarded = jitReport.generated;
        } else {
          verification = jitVerification;
        }
      }
    } catch (err: any) {
      console.error(`[ControlLoop] JiT test generation failed (non-fatal): ${err.message}`);
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

  // Acquire short-lived merge lock — serializes merges across Codex and Claude Code.
  // Retry up to 3 times with backoff (5s, 10s, 15s) if another merge is in progress.
  const MERGE_LOCK_TTL = 60; // 60 seconds — auto-release if merge crashes
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
  await saveRealityReport(cycleId, JSON.stringify(report), CYCLE_KEY_TTL);
  // Trim to 50 most recent
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

  // Step 8.0.5: Calibration — record predicted confidence vs actual outcome
  if (anchorConfidence) {
    const calOutcome = (commitSha && !rolledBack) ? "merged" : (rolledBack ? "failed" : "failed");
    await recordCalibrationOutcome(cycleId, anchor, anchorConfidence, calOutcome);
  }

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
    // Clear abandonment counter and failure reflections on success
    try { await clearAbandonmentCounter(anchor.reference); } catch { /* intentional: best-effort cleanup */ }
    try { await clearReflections(anchor.reference); } catch { /* intentional: best-effort cleanup */ }
    try { await clearReflectionsForAnchor(anchor.reference); } catch { /* intentional: best-effort cleanup */ }

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
          for (const item of queueItems.slice(0, 3)) { // max 3 per cycle
            await pushToWorkQueue(JSON.stringify(item));
            console.log(`[ControlLoop] Adversarial: queued fix — ${item.reference.slice(0, 80)}`);
          }
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
  await updateCycleHash(cycleId, { status: "completed", completedAt: new Date().toISOString() });
  // Refresh TTL so the 7-day window starts from cycle completion
  await refreshCycleTTL(cycleId, CYCLE_KEY_TTL);
  await setCycleLast(cycleId);
  await clearCycleActive();

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
    // Release per-source cycle registration + safety-net merge lock cleanup
    await releaseCycleSource("codex").catch((err: any) =>
      console.error(`[ControlLoop] Failed to release codex cycle registration: ${err.message}`)
    );
    await releaseMergeLock().catch((err: any) =>
      console.error(`[ControlLoop] Failed to release merge lock (safety net): ${err.message}`)
    );
  }
}

// ---------------------------------------------------------------------------
// Planner agent extracted to planner-prompt.ts
// runPlannerAgent, buildResearchContext, validateTaskSchema, PLANNER_OUTPUT_SCHEMA
// are imported from ./planner-prompt.ts above.
// ---------------------------------------------------------------------------

// Executor agent extracted to executor-agent.ts
// runExecutorAgent is imported from ./executor-agent.ts above.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pre-validate an anchor before invoking the planner. Returns a skip reason
 * string if the anchor is stale/completed, or null if it should proceed.
 *
 * Checks:
 * 1. Reference matches a completed item in priorities.md
 * 2. Queue item is marked COMPLETED: in its reference
 * 3. Reference is a duplicate of another item already in the work queue
 */
async function isAnchorStale(anchor): Promise<string | null> {
  const ref = (anchor.reference || "").toLowerCase().trim();
  if (!ref) return null;

  // Check for COMPLETED: prefix in queue items
  if (ref.startsWith("completed:")) {
    return "Queue item already marked as completed";
  }

  // Check against completed items in priorities.md
  try {
    const CONFIG_DIR = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
    const priorities = await readFile(join(CONFIG_DIR, "direction", "priorities.md"), "utf-8");

    // Extract the "What's been completed" section
    const completedMatch = priorities.match(/# What's been completed[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (completedMatch) {
      const completedLines = completedMatch[1]
        .split("\n")
        .map(l => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
        .filter(l => l.length > 10);

      for (const completed of completedLines) {
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const compWords = new Set<string>(completed.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || compWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => compWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, compWords.size);
        if (similarity > 0.6) {
          return `Matches completed item: "${completed.slice(0, 80)}"`;
        }
      }
    }

    // Also check "What NOT to work on" section
    const notWorkMatch = priorities.match(/# What NOT to work on[^\n]*\n([\s\S]*?)(?=\n#|$)/i);
    if (notWorkMatch) {
      const notWorkLines = notWorkMatch[1]
        .split("\n")
        .map(l => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
        .filter(l => l.length > 10);

      for (const blocked of notWorkLines) {
        const refWords = new Set<string>(ref.split(/\s+/).filter(w => w.length > 3));
        const blockWords = new Set<string>(blocked.split(/\s+/).filter(w => w.length > 3));
        if (refWords.size === 0 || blockWords.size === 0) continue;
        const overlap = Array.from(refWords).filter((w: string) => blockWords.has(w)).length;
        const similarity = overlap / Math.min(refWords.size, blockWords.size);
        if (similarity > 0.6) {
          return `Matches 'do not work on': "${blocked.slice(0, 80)}"`;
        }
      }
    }
  } catch {
    // priorities.md not readable — proceed without this check
  }

  return null;
}

// loadLastCycleReport / loadLastCycleReportFull moved to context-builder.ts
