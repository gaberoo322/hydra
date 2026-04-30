// ---------------------------------------------------------------------------
// Anchor selection — choose what to work on from explicit truth sources
// ---------------------------------------------------------------------------
//
// Extracted from control-loop.ts for modularity.  All functions here are
// pure orchestration (Redis + filesystem reads) with no side-effects on the
// working tree.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getTracker } from "./task-tracker.ts";
import { peekNextQueuedItem, isWipLimitReached, requeueStaleInProgressItems, moveToBlocked, claimNextQueuedItem } from "./backlog.ts";
import { getNextSpecTask, formatSpecForPrompt } from "./specs.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

// ---------------------------------------------------------------------------
// Constants — Redis keys & thresholds
// ---------------------------------------------------------------------------

export const MAX_PRIOR_FAILURE_RETRIES = 2;
export const MAX_CONSECUTIVE_ABANDONMENTS = 3;
export const REFRAME_QUEUE = "hydra:anchors:reframe-queue";
export const WORK_QUEUE = "hydra:anchors:work-queue";
export const PROCESSING_QUEUE = "hydra:anchors:processing";
export const ABANDONMENT_COUNTER_PREFIX = "hydra:anchors:abandonment-count:";
export const ABANDONMENT_COUNTER_TTL = 86400; // 24h — auto-expire stale counters

// ---------------------------------------------------------------------------
// Anchor selection
// ---------------------------------------------------------------------------

/**
 * Select the next anchor based on priority:
 * 1. Explicit user request (passed in opts)
 * 2. Failing tests (from grounding)
 * 3. Prior failures (stored in Redis)
 * 4. Priorities doc (fall back to operator direction)
 */
export async function selectAnchor(grounding, opts = {}, eventBus = null) {
  // 0. Recover items stuck in processing queue from a prior crash
  try {
    const stuckItems = await getTracker().redis.lrange(PROCESSING_QUEUE, 0, -1);
    if (stuckItems.length > 0) {
      console.log(`[ControlLoop] Recovering ${stuckItems.length} items from processing queue`);
      for (const item of stuckItems) {
        await getTracker().redis.rpush(WORK_QUEUE, item);
      }
      await getTracker().redis.del(PROCESSING_QUEUE);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Processing queue recovery failed: ${err.message}`);
  }

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

  // 2. Kanban queued lane — priority-sorted backlog items take precedence.
  //    Uses atomic claim (Lua script) so concurrent Claude Code cycles can't
  //    grab the same item. GATED by WIP limit (checked inside the Lua script).
  if (!wipBlocked) {
    try {
      const claimResult = await claimNextQueuedItem("codex");
      if (claimResult.claimed && claimResult.item) {
        const queuedItem = claimResult.item;
        console.log(`[ControlLoop] Claimed queued backlog item: ${queuedItem.id} (priority ${queuedItem.priority || 0}) — "${queuedItem.title}"`);
        return {
          type: "user-request",
          reference: queuedItem.title,
          whyNow: `Queued backlog item ${queuedItem.id} (priority ${queuedItem.priority || 0})`,
          context: queuedItem.description || null,
          description: queuedItem.description || null,
        };
      }
      if (claimResult.reason === "wip-limit") {
        wipBlocked = true;
        console.log(`[ControlLoop] WIP limit reached via atomic claim (${claimResult.count} in-progress)`);
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to claim queued backlog: ${err.message}`);
    }
  }

  // 2.5. Active specs — persistent multi-cycle task decompositions.
  //      Created by research (complex opportunities) or the operator.
  //      Picks the next unchecked task from the oldest active spec.
  //      NOT gated by WIP limit — specs represent committed multi-cycle plans.
  if (!wipBlocked) {
    try {
      const specNext = await getNextSpecTask();
      if (specNext) {
        console.log(`[ControlLoop] Picking spec task: "${specNext.task.title}" from spec "${specNext.spec.title}" (task ${specNext.task.id}/${specNext.spec.tasks.length})`);
        return {
          type: "user-request",
          reference: specNext.task.title,
          whyNow: `Spec "${specNext.spec.title}" task ${specNext.task.id}/${specNext.spec.tasks.length}: ${specNext.task.title}`,
          context: {
            specSlug: specNext.spec.slug,
            specTaskId: specNext.task.id,
            specTitle: specNext.spec.title,
            specRationale: specNext.spec.rationale,
            _specPromptContext: formatSpecForPrompt(specNext.spec, specNext.task),
          },
          description: specNext.task.description || specNext.task.title,
        };
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to check active specs: ${err.message}`);
    }
  }

  // 2.7. Failing tests — must be fixed before other work proceeds.
  //      Checked before the work queue because the preflight gate blocks all
  //      non-test-fix tasks when tests are red. Without this ordering, work
  //      queue items get selected, pass planning, then get rejected by preflight
  //      — wasting cycles.
  if (grounding.failingTests.length > 0) {
    return {
      type: "failing-test",
      reference: grounding.failingTests[0],
      whyNow: `${grounding.testReport.failed} test(s) currently failing`,
    };
  }

  // 2.8. Typecheck errors
  if (grounding.typecheckReport.exitCode !== 0) {
    return {
      type: "failing-test",
      reference: "typecheck",
      whyNow: "TypeScript typecheck has errors",
    };
  }

  // 3. Work queue items (from POST /queue or research auto-queue)
  //    NOT gated by WIP: research items should be consumed before falling
  //    to priorities doc. Kanban queued + specs are still WIP-gated since
  //    they represent heavier new-work intake.
  //    Uses LMOVE to atomically move the item to a processing list so it can
  //    be recovered if the cycle crashes before completing.
  const queued = await getTracker().redis.lmove(WORK_QUEUE, PROCESSING_QUEUE, "LEFT", "RIGHT");
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
        _workQueueRaw: queued,
      };
    } catch (err: any) {
      console.error(`[ControlLoop] Corrupt work-queue item dropped: ${err.message} — data: ${queued.slice(0, 200)}`);
      // Remove corrupt item from processing queue — it cannot be recovered
      await getTracker().redis.lrem(PROCESSING_QUEUE, 1, queued);
    }
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

  // 5.5. Regression hunt — every 10 merges, run a self-play adversarial cycle
  //      that tests recent features with edge cases instead of building new work.
  try {
    const r = getTracker().redis;
    const recentMetrics = await r.zrevrange("hydra:metrics:index", 0, 9);
    let recentMergeCount = 0;
    let lastRegressionHunt: string | null = null;
    for (const id of recentMetrics) {
      const raw = await r.hgetall(`hydra:metrics:${id}`);
      if (parseInt(raw.tasksMerged || "0") > 0) recentMergeCount++;
    }
    lastRegressionHunt = await r.get("hydra:regression-hunt:last");
    const huntInterval = 10;
    if (recentMergeCount >= huntInterval && !lastRegressionHunt) {
      // Time for a regression hunt
      console.log(`[ControlLoop] Regression hunt triggered (${recentMergeCount} merges since last hunt)`);

      // Get the last 10 merged task titles and files for context
      const mergedTasks: string[] = [];
      const reportIds = await r.zrevrange("hydra:reports:reality:index", 0, 9);
      for (const rid of reportIds) {
        const raw = await r.get(`hydra:reports:reality:${rid}`);
        if (!raw) continue;
        try {
          const report = JSON.parse(raw);
          if (report.task?.finalState === "merged") {
            mergedTasks.push(`- "${report.task.title}" (${report.filesChanged?.length || 0} files, commit ${report.commitSha?.slice(0, 7) || "?"})`);
          }
        } catch { /* intentional */ }
      }

      await r.set("hydra:regression-hunt:last", new Date().toISOString(), "EX", 86400 * 3); // 3-day cooldown

      return {
        type: "regression-hunt",
        reference: "Periodic regression hunt — test recent merges for edge cases",
        whyNow: `${recentMergeCount} merges since last hunt. Time for self-play validation.`,
        context: `Test these recently merged features for edge cases, missed error handling, and integration issues:\n${mergedTasks.join("\n")}\n\nWrite FAILING tests for any real bugs found. Do not write tests that already pass — only tests that expose actual defects.`,
        description: "Run adversarial testing on recently merged features. Write failing tests for any real bugs found.",
      };
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Regression hunt check failed: ${err.message}`);
  }

  // 6. Codebase health — reductive improvements (split, consolidate, document)
  //    Skip issues that were already abandoned — they loop endlessly when the
  //    planner sees them as resolved but the health analyzer keeps re-detecting.
  try {
    const { analyzeCodebaseHealth } = await import("./codebase-health.ts");
    const healthReport = await analyzeCodebaseHealth(grounding.fileTree || "", undefined);
    for (const issue of healthReport.issues) {
      const ref = `codebase-health: ${issue.category} in ${issue.file}`;
      const abandonCount = parseInt(
        await getTracker().redis.get(anchorKey(ref)) || "0",
      );
      if (abandonCount > 0) {
        console.log(`[ControlLoop] Skipping codebase-health issue "${ref}" (abandoned ${abandonCount}x) — falling through`);
        continue;
      }
      console.log(`[ControlLoop] Codebase health anchor: ${issue.category} — ${issue.file} (${issue.metric})`);
      return {
        type: "codebase-health",
        reference: ref,
        whyNow: healthReport.summary,
        context: issue.suggestion,
        description: issue.suggestion,
      };
    }
    if (healthReport.issues.length > 0) {
      console.log(`[ControlLoop] All ${healthReport.issues.length} codebase-health issues previously abandoned — skipping to priorities doc`);
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
// Circuit breaker: track consecutive abandonments per anchor reference.
// After MAX_CONSECUTIVE_ABANDONMENTS, escalate to reframe queue so the
// planner gets a fresh diagnostic prompt instead of looping forever.
// ---------------------------------------------------------------------------

export function anchorKey(anchorRef) {
  // Normalize anchor reference to a stable Redis key
  return ABANDONMENT_COUNTER_PREFIX + (anchorRef || "unknown").replace(/\s+/g, "-").slice(0, 120);
}

export async function trackAbandonment(anchorRef, task, reason) {
  const r = getTracker().redis;
  const key = anchorKey(anchorRef);
  const count = await r.incr(key);
  await r.expire(key, ABANDONMENT_COUNTER_TTL);

  if (count >= MAX_CONSECUTIVE_ABANDONMENTS) {
    console.log(`[ControlLoop] Circuit breaker: anchor "${anchorRef}" abandoned ${count}x — escalating to reframe queue`);
    await r.rpush(REFRAME_QUEUE, JSON.stringify({
      originalTaskId: task.taskId || "unknown",
      originalTitle: task.title || anchorRef,
      originalDescription: task.description || "",
      anchorType: task.anchorType || "unknown",
      anchorReference: task.anchorReference || anchorRef,
      scopeBoundary: task.scopeBoundary || null,
      totalAttempts: count,
      lastReason: reason,
      failedSteps: [],
      failureHistory: [],
      verificationStderr: "",
      escalatedAt: new Date().toISOString(),
      escalationSource: "abandonment-circuit-breaker",
    }));
    // Block the Kanban item so selectAnchor stops picking it.
    // Without this, peekNextQueuedItem() returns the same item every cycle
    // because it's a pure peek — the item stays in the queued lane.
    // Blocking it lets the reframe queue item (lower priority in selectAnchor)
    // get processed instead.
    try {
      await moveToBlocked(anchorRef, `Circuit breaker: abandoned ${count}x — escalated to reframe queue`);
      console.log(`[ControlLoop] Blocked Kanban item "${anchorRef}" to unblock reframe processing`);
    } catch (err: any) {
      // Not all anchors have a Kanban item (e.g. work queue items, failing tests)
      // — this is expected and safe to ignore
      console.log(`[ControlLoop] No Kanban item to block for "${anchorRef}" (${err.message})`);
    }
    // Reset counter so the reframe gets one clean shot
    await r.del(key);
    return true; // escalated
  }
  return false; // not yet escalated
}

export async function clearAbandonmentCounter(anchorRef) {
  const r = getTracker().redis;
  await r.del(anchorKey(anchorRef));
}

export async function storePriorFailure(taskId, reason, verificationResult) {
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

/**
 * Remove a work-queue item from the processing list after a cycle completes
 * (success, failure, or abandon). No-op if the anchor didn't come from the
 * work queue. Idempotent — safe to call multiple times.
 */
export async function clearProcessingItem(anchor) {
  if (anchor?._workQueueRaw) {
    try {
      await getTracker().redis.lrem(PROCESSING_QUEUE, 1, anchor._workQueueRaw);
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to clear processing queue item: ${err.message}`);
    }
  }
}
