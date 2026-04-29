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
// sendNotification removed — all notifications go through eventBus → digest system
import { recordCycleMetrics, detectDrift, getCumulativeAccomplishments } from "./metrics.ts";
import { loadAgentMemory, formatMemoryForPrompt, recordPlannerLesson, recordExecutorLesson, recordSkepticLesson } from "./agent-memory.ts";
// priorities-refresh removed — the research-strategist handles refresh inside
// the research loop (Step 5.5). Stale-detection just warns now.
import { moveToInProgress, moveToDone, returnToBacklog, moveToBlocked, peekNextQueuedItem, isWipLimitReached, requeueStaleInProgressItems } from "./backlog.ts";
import { detectPatterns } from "./pattern-detector.ts";
import { createCycleSession } from "./ov-session.ts";

const execFileAsync = promisify(execFile);

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");
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
    // @ts-expect-error — migrate to proper types
  if (opts.anchor) {
    // @ts-expect-error — migrate to proper types
    return { ...opts.anchor, whyNow: "Explicit operator request" };
  }

  // 1.5. WIP limit enforcement — requeue stale items, then check limit
  // When too many items are in-progress, skip picking NEW work from the
  // queue/backlog. Fixes (failing tests, prior failures, reframes) still
  // proceed because they address existing work, not start new work.
  let wipBlocked = false;
  try {
    // First, requeue any items that have been in-progress too long
    const requeued = await requeueStaleInProgressItems();
    if (requeued.length > 0) {
      console.log(`[ControlLoop] Requeued ${requeued.length} stale in-progress items`);
    }

    const wip = await isWipLimitReached();
    if (wip.atLimit) {
      wipBlocked = true;
      console.log(`[ControlLoop] WIP limit reached (${wip.count}/${wip.limit} in-progress) — skipping new work from queue/backlog`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] WIP limit check failed: ${err.message}`);
  }

  // 2. Kanban queued lane — priority-sorted backlog items take precedence
  //    GATED by WIP limit: skip if too many items already in-progress.
  if (!wipBlocked) {
    try {
      const queuedItem = await peekNextQueuedItem();
      if (queuedItem) {
        console.log(`[ControlLoop] Picking queued backlog item: ${queuedItem.id} (priority ${queuedItem.priority || 0}) — "${queuedItem.title}"`);
        return {
          type: "user-request",
          reference: queuedItem.title,
          whyNow: `Queued backlog item ${queuedItem.id} (priority ${queuedItem.priority || 0})`,
          context: queuedItem.description || null,
          description: queuedItem.description || null,
        };
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to check queued backlog: ${err.message}`);
    }
  }

  // 2.5. Work queue items (from POST /queue or research auto-queue)
  //      GATED by WIP limit: skip if too many items already in-progress.
  const queued = wipBlocked ? null : await getTracker().redis.lpop("hydra:anchors:work-queue");
  if (queued) {
    try {
      const item = JSON.parse(queued);
      // Parse research context if present
      let parsedContext = item.context;
      if (typeof parsedContext === "string") {
        try { parsedContext = JSON.parse(parsedContext); } catch { /* intentional: context stays as string */ }
      }
      // Include description from backlog item context if available
      const description = typeof parsedContext === "object" ? parsedContext?.description : null;
      const contextWithDescription = description
        ? (typeof parsedContext === "object"
          ? { ...parsedContext, _description: description }
          : parsedContext)
        : parsedContext;

      return {
        type: item.source === "research" ? "research" : "user-request",
        reference: item.reference || item.description,
        whyNow: `Queued by ${item.source === "research" ? "research system" : "operator"}: ${item.reason || "from work queue"}`,
        context: contextWithDescription,
        description,
      };
    } catch (err: any) {
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

  // 4.5. Reframe queue — tasks that failed repeatedly and need a fresh approach
  const reframeItems = await getTracker().redis.lrange(REFRAME_QUEUE, 0, 0);
  if (reframeItems.length > 0) {
    try {
      const item = JSON.parse(reframeItems[0]);
      await getTracker().redis.lpop(REFRAME_QUEUE);
      return {
        type: "reframe",
        reference: item.originalTitle,
        whyNow: `Task "${item.originalTitle}" failed ${item.totalAttempts} times. Needs diagnosis and a new approach.`,
        context: item,
      };
    } catch (err: any) {
      console.error(`[ControlLoop] Corrupt reframe item: ${err.message}`);
      await getTracker().redis.lpop(REFRAME_QUEUE);
    }
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
    } catch (err: any) {
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

  // 6. Codebase health — reductive improvements (split, consolidate, document)
  try {
    const { analyzeCodebaseHealth } = await import("./codebase-health.ts");
    const healthReport = await analyzeCodebaseHealth(grounding.fileTree || "", undefined);
    if (healthReport.topIssue) {
      console.log(`[ControlLoop] Codebase health anchor: ${healthReport.topIssue.category} — ${healthReport.topIssue.file} (${healthReport.topIssue.metric})`);
      return {
        type: "codebase-health",
        reference: `codebase-health: ${healthReport.topIssue.category} in ${healthReport.topIssue.file}`,
        whyNow: healthReport.summary,
        context: healthReport.topIssue.suggestion,
        description: healthReport.topIssue.suggestion,
      };
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Codebase health analysis failed: ${err.message}`);
  }

  // 7. Fall back to priorities doc — but check if it's stale
  try {
    const priorities = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");

    // Check how many recent cycles used this same anchor
    const recentDocCycles = await (async () => {
      try {
        const { getMetricsTrend } = await import("./metrics.ts");
        const trend = await getMetricsTrend(10);
        return trend.filter((m) => m.anchorType === "doc" && m.anchorReference === "direction/priorities.md").length;
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to check recent doc-cycle trend: ${err.message}`);
        return 0;
      }
    })();

    if (recentDocCycles >= 5) {
      // Priorities doc is stale — too many cycles using the same doc.
      // Trigger a lightweight refresh using accomplishments + vision.
      console.log(`[ControlLoop] Priorities doc used ${recentDocCycles}x in last 10 — triggering inline refresh`);
      try {
        const { refreshPriorities } = await import("./priorities-refresh.ts");
        const refreshResult = await refreshPriorities({ grounding, trigger: "stale" });
        if (refreshResult.ok) {
          console.log(`[ControlLoop] Priorities refreshed inline (${refreshResult.priorities?.split("\n").length || 0} lines)`);
          // Re-read the updated file
          const updated = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
          return {
            type: "doc",
            reference: "direction/priorities.md",
            whyNow: "Freshly refreshed priorities (stale doc detected)",
            context: updated,
          };
        }
      } catch (err: any) {
        console.error(`[ControlLoop] Inline priorities refresh failed: ${err.message}`);
      }
    }

    return {
      type: "doc",
      reference: "direction/priorities.md",
      whyNow: recentDocCycles >= 5
        ? `Priorities doc (used ${recentDocCycles}x recently)`
        : "Next priority from operator direction document",
      context: priorities,
    };
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[ControlLoop] selectAnchor: failed to read priorities.md: ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Operator-blocked detection
// ---------------------------------------------------------------------------
//
// When a cycle fails, check if the failure pattern suggests the operator
// needs to intervene (missing API key, auth failure, etc.) rather than
// retrying the same work. If detected, route to the Blocked lane instead
// of returning to Backlog where it would just fail again.

const BLOCKED_PATTERNS = [
  /api[_ ]?key/i,
  /unauthorized/i,
  /authentication.*fail/i,
  /EACCES/,
  /permission denied/i,
  /credentials/i,
  /secret.*missing/i,
  /token.*expired/i,
  /env.*not set/i,
  /missing.*env/i,
  /CORS.*blocked/i,
  /rate.*limit.*exceeded/i,
  /quota.*exceeded/i,
  /subscription.*required/i,
  /DATABASE_URL/,
  /KALSHI_API/,
  /POLYMARKET_API/,
  /ODDS_API/,
  /expected string.*received undefined/i,
  /Invalid input.*expected.*string/i,
  /ECONNREFUSED.*5432/,  // Postgres connection refused
  /connection.*refused.*database/i,
];

function looksOperatorBlocked(verification) {
  if (!verification?.steps) return null;
  for (const step of verification.steps) {
    if (step.passed) continue;
    const output = (step.stderr || "") + " " + (step.stdout || "");
    for (const pattern of BLOCKED_PATTERNS) {
      const match = output.match(pattern);
      if (match) {
        return `${step.label}: ${match[0]}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan-vs-actual reconciliation (PAUL UNIFY pattern)
// ---------------------------------------------------------------------------
//
// After verification passes, diff the planned scope (task.scopeBoundary.in)
// against the actual files changed (verification.filesChanged). This catches:
//   - Scope creep: executor touched files outside the plan
//   - Scope gaps: planned files that weren't modified (potentially incomplete)
//
// Test files (.test.) are excluded from both checks: test creation is always
// expected and test gaps are benign (test files may not need modification).
//
// Results are informational (logged + included in reality report), not
// blocking — the merge proceeds regardless. If scope creep is detected,
// a prevention rule is recorded for the planner.

function reconcilePlanVsActual(task, verification) {
  const plannedFiles = new Set(task.scopeBoundary?.in || []);
  const actualFiles = new Set(verification.filesChanged || []);

  const result = {
    scopeCreep: [],
    scopeGaps: [],
    aligned: true,
    warnings: [],
  };

  // Skip reconciliation if planner didn't specify a scope (nothing to compare)
  if (plannedFiles.size === 0) {
    return result;
  }

  // Scope creep: actual files not in planned scope (test files excluded — always OK)
  for (const f of actualFiles) {
    if (plannedFiles.has(f)) continue;
    // @ts-expect-error — migrate to proper types
    if (f.includes(".test.")) continue;
    result.scopeCreep.push(f);
  }

  // Scope gaps: planned source files (not test files) that weren't changed
  for (const f of plannedFiles) {
    if (actualFiles.has(f)) continue;
    // @ts-expect-error — migrate to proper types
    if (f.includes(".test.")) continue;
    result.scopeGaps.push(f);
  }

  if (result.scopeCreep.length > 0) {
    result.warnings.push(`Scope creep: ${result.scopeCreep.length} file(s) changed outside planned scope: ${result.scopeCreep.join(", ")}`);
    result.aligned = false;
  }
  if (result.scopeGaps.length > 0) {
    result.warnings.push(`Potentially incomplete: ${result.scopeGaps.length} planned file(s) not modified: ${result.scopeGaps.join(", ")}`);
    result.aligned = false;
  }

  return result;
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
// Anchor-level pre-routing: only failing-test anchors are inherently
// quick-fix (narrow scope, known target, deterministic fix). Prior-failure
// anchors get full ceremony since the previous approach already failed.
// These also get a cheaper planner model and compressed prompt (see runPlannerAgent).

function classifyTaskComplexity(task, anchor) {
  // Only genuinely targeted anchors skip ceremony
  if (anchor.type === "failing-test") {
    return "quick-fix";
  }

  const filesInScope = task.scopeBoundary?.in?.length || 0;
  const criteriaCount = task.acceptanceCriteria?.length || 0;

  // Quick-fix: single-file, minimal criteria only
  if (filesInScope <= 1 && criteriaCount <= 2) {
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

const MAX_PRIOR_FAILURE_RETRIES = 2;
const REFRAME_QUEUE = "hydra:anchors:reframe-queue";

async function storePriorFailure(taskId, reason, verificationResult) {
  const r = getTracker().redis;

  // Count how many times this task (or its anchor) has already been retried
  const existing = await r.lrange("hydra:anchors:prior-failures", 0, -1);
  const priorAttempts = existing.filter(raw => {
    try { return JSON.parse(raw).taskId === taskId; } catch { return false; }
  }).length;

  if (priorAttempts >= MAX_PRIOR_FAILURE_RETRIES) {
    // Escalate to reframe queue — planner will diagnose and rewrite the task
    console.log(`[ControlLoop] Escalating ${taskId} to reframe queue after ${priorAttempts + 1} failures`);

    // Gather failure history for context
    const task = await r.hgetall(`hydra:task:${taskId}`);
    const failureHistory = existing
      .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(f => f?.taskId === taskId);

    await r.rpush(REFRAME_QUEUE, JSON.stringify({
      originalTaskId: taskId,
      originalTitle: task?.title || taskId,
      originalDescription: task?.description || "",
      anchorType: task?.anchorType || "unknown",
      anchorReference: task?.anchorReference || "",
      scopeBoundary: task?.scopeBoundary ? JSON.parse(task.scopeBoundary) : null,
      totalAttempts: priorAttempts + 1,
      lastReason: reason,
      failedSteps: verificationResult?.steps?.filter((s) => !s.passed).map((s) => s.label) || [],
      failureHistory: failureHistory.map(f => ({ reason: f.reason, failedSteps: f.failedSteps, timestamp: f.timestamp })),
      verificationStderr: verificationResult?.steps
        ?.filter(s => !s.passed)
        .map(s => `${s.label}: ${(s.stderr || "").slice(0, 300)}`)
        .join("\n") || "",
      escalatedAt: new Date().toISOString(),
    }));
    return;
  }

  await r.rpush("hydra:anchors:prior-failures", JSON.stringify({
    taskId,
    reason,
    failedSteps: verificationResult?.steps?.filter((s) => !s.passed).map((s) => s.label) || [],
    retryCount: priorAttempts + 1,
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
    await ovSession.logPlanner(anchor, null);
    await ovSession.logOutcome("no-work", "Planner produced no task");
    await ovSession.commit();
    return { cycleId, tasks: [], reason: "Planner produced no task", durationMs: Date.now() - startTime };
  }

  await ovSession.logPlanner(anchor, task);

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
  await tracker.redis.expire(`hydra:cycle:${cycleId}`, CYCLE_KEY_TTL);
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
    return {
      cycleId,
    // @ts-expect-error — migrate to proper types
      tasks: [{ taskId, finalState: "abandoned", reason: `Drift: ${drift.reason}` }],
      durationMs: Date.now() - startTime,
    };
  }

  // =========================================================================
  // Step 4: SKEPTIC GATE — challenge assumptions (codex agent call)
  // Skip only for quick-fix tasks (single-file, deterministic fixes).
  // Research items now go through the skeptic — research vets the *what*,
  // the skeptic vets the *how* (scope, feasibility, duplication).
  // =========================================================================
  const skipSkeptic = complexity === "quick-fix";
  const skepticResult = skipSkeptic
    ? { verdict: "approve", reason: "Skipped — quick-fix (scope-adaptive routing)", skipped: true }
    : await (() => {
        console.log(`[ControlLoop] Step 4: Skeptic gate...`);
        return runSkepticAgent(cycleId, task, grounding, groundingSummary, ovSession);
      })();

  await ovSession.logSkeptic(skepticResult.verdict, skepticResult.reason);

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
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to record rejection lessons: ${err.message}`);
    }

    await ovSession.logOutcome("abandoned", `Skeptic rejected: ${skepticResult.reason}`);
    await ovSession.commit();
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

  const execResult = await runExecutorAgent(cycleId, task, grounding, groundingSummary, ovSession);
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

    // @ts-expect-error — migrate to proper types
    await ovSession.logExecutor({ summary: `[Fixer] ${fixerResult.output?.slice(0, 200)}`, filesChanged: [] });
    // @ts-expect-error — migrate to proper types
    await tracker.logAgentRun(cycleId, "fixer", taskId, fixerResult.duration, fixerResult.exitCode === 0 ? "fix-attempted" : "fix-failed", fixerResult.usage, fixerResult.costUsd);
    // @ts-expect-error — migrate to proper types
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

async function runPlannerAgent(cycleId, anchor, grounding, groundingSummary, continuityContext = "", ovSession = null) {
  // Scope-adaptive planner routing (PAUL pattern):
  // Quick-fix anchors (failing-test, prior-failure) get a compressed prompt
  // and cheaper model — they don't need priorities, accomplishments, or
  // continuity because the anchor IS the entire scope.
  const isQuickFixAnchor = anchor.type === "failing-test" || anchor.type === "prior-failure";
  const isReframe = anchor.type === "reframe";
  const plannerModel = isQuickFixAnchor ? "codex" : "frontier";

  // Load context — OV compiled context + file fallbacks
  let priorities = "", feedback = "", plannerMemory = "", ovContext = "";

  if (!isQuickFixAnchor) {
    const results = await Promise.all([
      readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8").catch(() => ""),
      readFile(join(CONFIG_PATH, "feedback", "to-planner.md"), "utf-8").catch(() => ""),
      loadAgentMemory("planner"),
      ovSession?.getAgentContext?.("planner", anchor) || Promise.resolve({ formatted: "" }),
    ]);
    priorities = results[0];
    feedback = results[1];
    plannerMemory = results[2];
    ovContext = results[3].formatted || "";
  }

  const confidence = grounding.testReport.failed > 0 ? "low"
    : (grounding.typecheckReport.exitCode !== 0 || grounding.dirtyFiles.length > 0) ? "medium"
    : "high";

  // Load milestone progress — skip for quick-fix
  let milestoneContext = "";
  if (!isQuickFixAnchor) {
    try {
      const { getCurrentMilestoneProgress } = await import("./backlog.ts");
      const milestone = await getCurrentMilestoneProgress();
      if (milestone) {
        const remaining = milestone.remainingTitles.slice(0, 5).join(", ");
        milestoneContext = `## CURRENT MILESTONE\n${milestone.name} — ${milestone.pctComplete}% complete (${milestone.done}/${milestone.total} epics done, ${milestone.blocked} blocked)\nRemaining epics: ${remaining}\nFocus your task on completing this milestone's remaining epics.\n`;
      }
    } catch {}
  }

  // Load cumulative accomplishments — skip for quick-fix
  let accomplishmentsContext = "";
  if (!isQuickFixAnchor) {
    try {
      const acc = await getCumulativeAccomplishments(10);
      if (acc.length > 0) {
        accomplishmentsContext = `## ALREADY ACCOMPLISHED (do NOT re-propose these)\n${acc.map((a) => `- "${a.title}"`).join("\n")}\n`;
      }
    } catch (err: any) {
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
  if (isReframe) {
    // Reframe prompt — a task failed multiple times, planner must diagnose and rewrite
    const ctx = anchor.context || {};
    const compactGrounding = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
    prompt = [
      `## REFRAME THIS TASK (previous approach failed ${ctx.totalAttempts || "multiple"} times)`,
      "",
      `### Original task that kept failing`,
      `Title: ${ctx.originalTitle || anchor.reference}`,
      ctx.originalDescription ? `Description: ${ctx.originalDescription}` : "",
      ctx.scopeBoundary ? `Scope: ${JSON.stringify(ctx.scopeBoundary)}` : "",
      "",
      `### Failure history`,
      `Total attempts: ${ctx.totalAttempts || "unknown"}`,
      `Last failure reason: ${ctx.lastReason || "unknown"}`,
      ctx.failedSteps?.length > 0 ? `Failed verification steps: ${ctx.failedSteps.join(", ")}` : "",
      ctx.verificationStderr ? `\nVerification error output:\n\`\`\`\n${ctx.verificationStderr.slice(0, 1000)}\n\`\`\`` : "",
      ctx.failureHistory?.length > 0 ? `\nAll attempts:\n${ctx.failureHistory.map((f, i) => `  ${i + 1}. ${f.reason} (${f.failedSteps?.join(", ") || "no details"})`).join("\n")}` : "",
      "",
      compactGrounding,
      "",
      `## INSTRUCTIONS`,
      `The previous task kept failing verification. You must DIAGNOSE why and propose a DIFFERENT approach.`,
      ``,
      `Possible root causes to consider:`,
      `- The original scope was too broad or touched files that interact in unexpected ways`,
      `- There was a pre-existing test failure unrelated to the task`,
      `- The acceptance criteria were impossible to satisfy with the verification plan`,
      `- The executor's approach was correct but a different file or test needed updating`,
      ``,
      `Your job:`,
      `1. Analyze the failure pattern — what specifically went wrong each time?`,
      `2. Propose a REFRAMED task with a different scope, approach, or decomposition`,
      `3. If the original goal is still valid, find a smaller or different path to achieve it`,
      `4. If the original goal is blocked by something outside the executor's control (e.g. pre-existing test failures, missing credentials), output { "noWork": true, "reason": "..." } explaining what the operator needs to fix`,
      ``,
      `The reframed task must be meaningfully different from the original — not just a retry with the same scope.`,
      "",
      jsonSchema,
    ].filter(Boolean).join("\n");
    console.log(`[ControlLoop] Planner using REFRAME prompt for "${ctx.originalTitle}" (${ctx.totalAttempts} prior failures)`);
  } else if (isQuickFixAnchor) {
    // Compressed prompt for quick-fix: just anchor + compact grounding + fix instructions
    const compactGrounding = summarizeForPrompt(grounding, { compact: true }).slice(0, 2000);
    prompt = [
      `## FIX THIS (quick-fix — targeted repair, minimal scope)`,
      `Type: ${anchor.type}`,
      `Reference: ${anchor.reference}`,
      `Why now: ${anchor.whyNow}`,
      anchor.description ? `\nDescription:\n${anchor.description.slice(0, 1500)}` : "",
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
      anchor.description ? `\nDescription:\n${anchor.description.slice(0, 2000)}` : "",
      anchor.context && anchor.type === "research" ? buildResearchContext(anchor.context) : "",
      anchor.context && anchor.type !== "research" ? `\nContext:\n${typeof anchor.context === "string" ? anchor.context.slice(0, 2000) : JSON.stringify(anchor.context).slice(0, 2000)}` : "",
      anchor.type === "codebase-health" ? [
        "",
        "## CODEBASE HEALTH GUIDELINES",
        "This is a maintainability task. Your goal is REDUCTIVE — make the codebase smaller, more modular, and better documented.",
        "Rules:",
        "- Split large files into focused modules with clear single responsibilities",
        "- Add a brief JSDoc header to every new module explaining: what it does, what depends on it, key constraints",
        "- Use index.ts re-exports to maintain existing import paths (no breaking changes)",
        "- Do NOT add new functionality, features, or abstractions beyond what exists",
        "- Do NOT add error handling, validation, or defensive code that wasn't there before",
        "- The test count should stay the same or decrease (consolidate redundant tests, don't add new ones)",
        "- Keep every existing import path working — consumers should not need to change",
      ].join("\n") : "",
      "",
      groundingSummary.slice(0, 4000),
      "",
      // Continuity contract — what the last cycle did, what changed since
      continuityContext ? continuityContext.slice(0, 1500) : "",
      "",
      priorities ? `## PRIORITIES\n${priorities.slice(0, 3000)}\n` : "",
      feedback ? `## OPERATOR FEEDBACK\n${feedback.slice(0, 1000)}\n` : "",
      "",
      // Milestone context — focus on active milestone epics
      milestoneContext,
      // Cumulative accomplishments — prevent re-proposing completed work
      accomplishmentsContext,
      "",
      // Agent memory — learn from past outcomes
      formatMemoryForPrompt(plannerMemory, "planner"),
      "",
      // OpenViking compiled context (resources + memories relevant to this anchor)
      ovContext,
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

  const personality = await findPersonality("planner");

  const result = await runAgent({
    agentName: "planner",
    personality,
    prompt,
    model: plannerModel,
    taskId: "planner",
    correlationId: cycleId,
  });

  // Detect Codex usage-limit errors — signal the caller to pause instead of retrying
  // @ts-expect-error — migrate to proper types
  if (result.usageLimitHit) {
    console.error(`[ControlLoop] Codex usage limit hit during planning — signaling pause`);
    // Return a sentinel object that the caller can detect
    return { __usageLimitHit: true } as any;
  }

  // Parse output — try direct parse, then regex fallback, then fail loud
  let task = null;
  try {
    // @ts-expect-error — migrate to proper types
    task = JSON.parse(result.output);
  } catch {
    // @ts-expect-error — migrate to proper types
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        task = JSON.parse(match[0]);
      } catch (err: any) {
        console.error(`[ControlLoop] Planner output unparseable even after regex extraction: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Planner output contained no JSON object`);
    }
  }

  // Handle explicit "no work" response
  if (task?.noWork) {
    console.log(`[ControlLoop] Planner says no work needed: ${task.reason || "all priorities addressed"}`);
    // @ts-expect-error — migrate to proper types
    await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "no-work", result.usage, result.costUsd);
    return null;
  }

  // Validate required fields
  if (task && (!task.verificationPlan || !Array.isArray(task.verificationPlan) || task.verificationPlan.length === 0)) {
    console.log(`[ControlLoop] Planner task rejected — missing verificationPlan`);
    return null;
  }

    // @ts-expect-error — migrate to proper types
  await getTracker().logAgentRun(cycleId, "planner", "planner", result.duration, "completed", result.usage, result.costUsd);
  return task;
}

async function runSkepticAgent(cycleId, task, grounding, groundingSummary, ovSession = null) {
  // Load skeptic memory + OV context in parallel
  const [skepticMemory, ovCtx] = await Promise.all([
    loadAgentMemory("skeptic"),
    ovSession?.getAgentContext?.("skeptic", { reference: task.title, whyNow: task.anchorReference }) || Promise.resolve({ formatted: "" }),
  ]);
  const skepticKnowledge = ovCtx.formatted || "";
  let recentHistory = "";
  try {
    const Redis = (await import("ioredis")).default;
    const rConn = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
    const recentIds = await rConn.zrevrange("hydra:reports:reality:index", 0, 4);
    for (const id of recentIds) {
      const raw = await rConn.get(`hydra:reports:reality:${id}`);
      if (raw) {
        const report = JSON.parse(raw);
        recentHistory += `- ${report.cycleId}: "${report.task?.title}" (${report.task?.finalState})\n`;
      }
    }
    rConn.disconnect();
  } catch (err: any) {
    console.error(`[ControlLoop] Skeptic failed to load recent cycle history: ${err.message}`);
  }

  const prompt = [
    `You are the Skeptic. Your job is to CHALLENGE this proposed task. You have VETO power.`,
    "",
    `## PROPOSED TASK`,
    `Title: ${task.title}`,
    `Description: ${task.description}`,
    `Anchor: [${task.anchorType}] ${task.anchorReference}`,
    task.anchorType === "doc" ? `(NOTE: This is a config document maintained by the operator. It exists outside the workspace but IS a valid anchor.)` : "",
    task.anchorType === "codebase-health" ? `(NOTE: This is a codebase health task. The goal is REDUCTIVE — make the codebase smaller, more modular, or better documented. Do NOT add new functionality. Validate that the proposed change genuinely improves maintainability.)` : "",
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
    skepticKnowledge,
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
    // @ts-expect-error — migrate to proper types
    verdict = JSON.parse(result.output);
  } catch {
    // @ts-expect-error — migrate to proper types
    const match = result.output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        verdict = JSON.parse(match[0]);
      } catch (err: any) {
        console.error(`[ControlLoop] Skeptic output unparseable even after regex — failing safe to reject: ${err.message}`);
      }
    } else {
      console.error(`[ControlLoop] Skeptic output contained no JSON object — failing safe to reject`);
    }
  }

    // @ts-expect-error — migrate to proper types
  await getTracker().logAgentRun(cycleId, "skeptic", "skeptic", result.duration, verdict.verdict, result.usage, result.costUsd);
  return verdict;
}

async function runExecutorAgent(cycleId, task, grounding, groundingSummary, ovSession = null) {
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

  const personality = await findPersonality("executor");
  const result = await runAgent({
    agentName: "executor",
    personality,
    prompt,
    model: "codex",
    taskId: task.taskId,
    correlationId: cycleId,
    workDir: PROJECT_WORKSPACE,
  });

  let output: Record<string, any> = {};
  try {
    // @ts-expect-error — migrate to proper types
    output = JSON.parse(result.output);
  } catch {
    // @ts-expect-error — migrate to proper types
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

    // @ts-expect-error — migrate to proper types
  await getTracker().logAgentRun(cycleId, "executor", task.taskId, result.duration, "completed", result.usage, result.costUsd);
    // @ts-expect-error — migrate to proper types
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
