// ---------------------------------------------------------------------------
// Anchor selection — choose what to work on from explicit truth sources
// ---------------------------------------------------------------------------
//
// Extracted from control-loop.ts for modularity.  All functions here are
// pure orchestration (Redis + filesystem reads) with no side-effects on the
// working tree.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { block, _admin } from "./backlog.ts";
import { getNextSpecTask, formatSpecForPrompt } from "./specs.ts";
import { invalidatePlanCacheForAnchor } from "./plan-cache.ts";
import {
  listRange, listRPush, listRem, listLPop, listLen, listMove, listTrim,
  getString, setString, delKey, incrKey, expireKey,
  hashGetAll, zRevRange,
  getRealityReport, getRecentReportIds, getCycleMetrics,
  isHealthAnchorResolved,
} from "./redis-adapter.ts";

const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME, "hydra", "config");

// ---------------------------------------------------------------------------
// Constants — Redis keys & thresholds
// ---------------------------------------------------------------------------

const MAX_PRIOR_FAILURE_RETRIES = 2;
const MAX_CONSECUTIVE_ABANDONMENTS = 3;
const REFRAME_QUEUE = "hydra:anchors:reframe-queue";
const WORK_QUEUE = "hydra:anchors:work-queue";
const PROCESSING_QUEUE = "hydra:anchors:processing";
const PRIOR_FAILURES_KEY = "hydra:anchors:prior-failures";
const ABANDONMENT_COUNTER_PREFIX = "hydra:anchors:abandonment-count:";
const ABANDONMENT_COUNTER_TTL = 86400; // 24h — auto-expire stale counters

// Prior-failure escalation thresholds (issue #18, #93)
const PRIOR_FAILURE_AGE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24h — items older than this are auto-escalated
const PRIOR_FAILURE_CAP = 10; // hard cap — oldest items escalated to reframe when exceeded

// Reframe queue cap + TTL (issue #57)
const REFRAME_QUEUE_CAP = 20;
const REFRAME_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRAME_INTERLEAVE_INTERVAL = 5; // force reframe every Nth cycle when queue non-empty

// Key helpers
const PERM_SKIP_PREFIX = "hydra:anchors:perm-skip:";
const METRICS_INDEX_KEY = "hydra:metrics:index";
const REGRESSION_HUNT_LAST_KEY = "hydra:regression-hunt:last";
function taskKey(id: string) { return `hydra:task:${id}`; }

// ---------------------------------------------------------------------------
// Reframe queue maintenance — prevent unbounded accumulation (issue #57)
// ---------------------------------------------------------------------------

/**
 * Prune stale items (older than 7 days) from the reframe queue and enforce
 * a hard cap of REFRAME_QUEUE_CAP. Oldest items beyond the cap are dropped
 * with a log entry. Called from selectAnchor() before consuming a reframe item.
 *
 * Returns { pruned: number, dropped: number }.
 */
async function pruneReframeQueue(): Promise<{ pruned: number; dropped: number }> {
  let pruned = 0;
  let dropped = 0;

  try {
    const all = await listRange(REFRAME_QUEUE, 0, -1);
    if (all.length === 0) return { pruned, dropped };

    const now = Date.now();
    const kept: string[] = [];

    // Pass 1: filter out items older than 7 days
    for (const raw of all) {
      try {
        const item = JSON.parse(raw);
        const escalatedAt = item.escalatedAt ? new Date(item.escalatedAt).getTime() : 0;
        if (escalatedAt > 0 && now - escalatedAt > REFRAME_QUEUE_MAX_AGE_MS) {
          pruned++;
          console.log(`[ControlLoop] Reframe queue: pruned stale item "${item.originalTitle || item.originalTaskId}" (age: ${Math.round((now - escalatedAt) / 86400000)}d)`);
          continue;
        }
      } catch (err: any) {
        // Corrupt item — drop it
        pruned++;
        console.error(`[ControlLoop] Reframe queue: dropped corrupt item: ${err.message}`);
        continue;
      }
      kept.push(raw);
    }

    // Pass 2: enforce hard cap — drop oldest items beyond cap
    if (kept.length > REFRAME_QUEUE_CAP) {
      const overflow = kept.length - REFRAME_QUEUE_CAP;
      for (let i = 0; i < overflow; i++) {
        try {
          const item = JSON.parse(kept[i]);
          console.log(`[ControlLoop] Reframe queue: dropped overflow item "${item.originalTitle || item.originalTaskId}" (queue: ${kept.length}/${REFRAME_QUEUE_CAP})`);
        } catch {
          console.log(`[ControlLoop] Reframe queue: dropped overflow item (unparseable)`);
        }
        dropped++;
      }
      kept.splice(0, overflow);
    }

    // Only rewrite the list if something changed
    if (pruned > 0 || dropped > 0) {
      await delKey(REFRAME_QUEUE);
      if (kept.length > 0) {
        await listRPush(REFRAME_QUEUE, ...kept);
      }
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Reframe queue pruning failed: ${err.message}`);
  }

  return { pruned, dropped };
}

// ---------------------------------------------------------------------------
// Prior-failure escalation — prevent unbounded accumulation (issue #18)
// ---------------------------------------------------------------------------

/**
 * Scan all prior-failure items and escalate any that exceed the age threshold
 * to the reframe queue. Called from selectAnchor() before claiming a prior-failure
 * item, so stale items are cleaned up every cycle.
 */
async function escalateStalePriorFailures(): Promise<number> {
  const key = PRIOR_FAILURES_KEY;
  const all = await listRange(key, 0, -1);
  if (all.length === 0) return 0;

  const now = Date.now();
  let escalated = 0;

  for (const raw of all) {
    try {
      const item = JSON.parse(raw);
      const age = now - new Date(item.timestamp).getTime();
      if (age > PRIOR_FAILURE_AGE_LIMIT_MS) {
        // Escalate to reframe queue with age reason
        await listRPush(REFRAME_QUEUE, JSON.stringify({
          originalTaskId: item.taskId,
          originalTitle: item.taskId,
          originalDescription: "",
          anchorType: "prior-failure",
          anchorReference: item.taskId,
          scopeBoundary: null,
          totalAttempts: item.retryCount || 1,
          lastReason: item.reason,
          failedSteps: item.failedSteps || [],
          failureHistory: [],
          verificationStderr: "",
          escalatedAt: new Date().toISOString(),
          escalationSource: "prior-failure-age-limit",
          escalationReason: `Auto-escalated: item aged ${Math.round(age / 3600000)}h, exceeds ${PRIOR_FAILURE_AGE_LIMIT_MS / 3600000}h limit`,
        }));
        await listRem(key, 1, raw);
        escalated++;
        console.log(`[ControlLoop] Prior-failure "${item.taskId}" auto-escalated to reframe (age: ${Math.round(age / 3600000)}h)`);
      }
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to parse prior-failure for age check: ${err.message}`);
    }
  }

  return escalated;
}

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
    const stuckItems = await listRange(PROCESSING_QUEUE, 0, -1);
    if (stuckItems.length > 0) {
      console.log(`[ControlLoop] Recovering ${stuckItems.length} items from processing queue`);
      for (const item of stuckItems) {
        await listRPush(WORK_QUEUE, item);
      }
      await delKey(PROCESSING_QUEUE);
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
    const requeued = await _admin.requeueStaleInProgressItems();
    if (requeued.length > 0) {
      console.log(`[ControlLoop] Requeued ${requeued.length} stale in-progress items`);
    }

    const wip = await _admin.isWipLimitReached();
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
      const claimResult = await _admin.claimNextQueuedItem("codex");
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
  const queued = await listMove(WORK_QUEUE, PROCESSING_QUEUE, "LEFT", "RIGHT");
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
      await listRem(PROCESSING_QUEUE, 1, queued);
    }
  }

  // 4.5. Reframe queue — tasks that failed repeatedly and need a fresh approach
  //      Prune stale (>7d) and overflow (>20) items before consuming (issue #57).
  try {
    const { pruned, dropped } = await pruneReframeQueue();
    if (pruned > 0 || dropped > 0) {
      console.log(`[ControlLoop] Reframe queue maintenance: pruned=${pruned}, dropped=${dropped}`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Reframe queue maintenance failed: ${err.message}`);
  }
  const reframeItems = await listRange(REFRAME_QUEUE, 0, 0);
  if (reframeItems.length > 0) {
    try {
      const item = JSON.parse(reframeItems[0]);
      await listLPop(REFRAME_QUEUE);
      return {
        type: "reframe",
        reference: item.originalTitle,
        whyNow: `Task "${item.originalTitle}" failed ${item.totalAttempts} times. Needs diagnosis and a new approach.`,
        context: item,
      };
    } catch (err: any) {
      console.error(`[ControlLoop] Corrupt reframe item: ${err.message}`);
      await listLPop(REFRAME_QUEUE);
    }
  }

  // 5. Prior failures from Redis
  //    First, escalate any stale items so the queue doesn't accumulate unbounded.
  try {
    const escalatedCount = await escalateStalePriorFailures();
    if (escalatedCount > 0) {
      console.log(`[ControlLoop] Escalated ${escalatedCount} stale prior-failure(s) to reframe queue`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Prior-failure age escalation failed: ${err.message}`);
  }
  // Scan prior-failure queue, skipping items that have exceeded the retry cap (issue #93).
  // Items with retryCount >= MAX_PRIOR_FAILURE_RETRIES are escalated to reframe immediately
  // instead of burning another cycle.
  const allPriorFailures = await listRange(PRIOR_FAILURES_KEY, 0, -1);
  for (const raw of allPriorFailures) {
    try {
      const failure = JSON.parse(raw);
      if ((failure.retryCount || 0) >= MAX_PRIOR_FAILURE_RETRIES) {
        // Exceeded retry cap — escalate to reframe, don't retry
        await listRem(PRIOR_FAILURES_KEY, 1, raw);
        await listRPush(REFRAME_QUEUE, JSON.stringify({
          originalTaskId: failure.taskId,
          originalTitle: failure.taskId,
          originalDescription: "",
          anchorType: "prior-failure",
          anchorReference: failure.taskId,
          scopeBoundary: null,
          totalAttempts: failure.retryCount || 1,
          lastReason: failure.reason,
          failedSteps: failure.failedSteps || [],
          failureHistory: [],
          verificationStderr: "",
          escalatedAt: new Date().toISOString(),
          escalationSource: "prior-failure-retry-cap",
          escalationReason: `Auto-escalated: retryCount ${failure.retryCount} >= cap ${MAX_PRIOR_FAILURE_RETRIES}`,
        }));
        console.log(`[ControlLoop] Prior-failure "${failure.taskId}" escalated to reframe (retryCount ${failure.retryCount} >= cap ${MAX_PRIOR_FAILURE_RETRIES})`);
        continue;
      }
      // Found a retryable item — pop it and return as anchor
      await listRem(PRIOR_FAILURES_KEY, 1, raw);
      return {
        type: "prior-failure",
        reference: failure.taskId,
        whyNow: `Prior task ${failure.taskId} failed: ${failure.reason || "unknown"} (retry ${(failure.retryCount || 0) + 1}/${MAX_PRIOR_FAILURE_RETRIES})`,
        context: failure,
      };
    } catch (err: any) {
      console.error(`[ControlLoop] Corrupt prior-failure in queue: ${err.message}. Removing.`);
      await listRem(PRIOR_FAILURES_KEY, 1, raw);
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
    const recentMetrics = await zRevRange(METRICS_INDEX_KEY, 0, 9);
    let recentMergeCount = 0;
    let lastRegressionHunt: string | null = null;
    for (const id of recentMetrics) {
      const raw = await getCycleMetrics(id);
      if (parseInt(raw.tasksMerged || "0") > 0) recentMergeCount++;
    }
    lastRegressionHunt = await getString(REGRESSION_HUNT_LAST_KEY);
    const huntInterval = 10;
    if (recentMergeCount >= huntInterval && !lastRegressionHunt) {
      // Time for a regression hunt
      console.log(`[ControlLoop] Regression hunt triggered (${recentMergeCount} merges since last hunt)`);

      // Get the last 10 merged task titles and files for context
      const mergedTasks: string[] = [];
      const reportIds = await getRecentReportIds(10);
      for (const rid of reportIds) {
        const raw = await getRealityReport(rid);
        if (!raw) continue;
        try {
          const report = JSON.parse(raw);
          if (report.task?.finalState === "merged") {
            mergedTasks.push(`- "${report.task.title}" (${report.filesChanged?.length || 0} files, commit ${report.commitSha?.slice(0, 7) || "?"})`);
          }
        } catch { /* intentional */ }
      }

      await setString(REGRESSION_HUNT_LAST_KEY, new Date().toISOString(), 86400 * 3); // 3-day cooldown

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
  //    Skip issues that have been permanently deprioritized (failed 2+ times).
  //    Uses a separate permanent counter that doesn't reset on reframe escalation.
  try {
    const { analyzeCodebaseHealth } = await import("./codebase-health.ts");
    const healthReport = await analyzeCodebaseHealth(grounding.fileTree || "", undefined);
    for (const issue of healthReport.issues) {
      const ref = `codebase-health: ${issue.category} in ${issue.file}`;
      // Check if this health anchor was recently resolved (issue #25)
      const resolved = await isHealthAnchorResolved(ref);
      if (resolved) {
        console.log(`[ControlLoop] Skipping resolved codebase-health issue "${ref}" — already merged within 24h`);
        continue;
      }
      // Check both the circuit-breaker counter AND a permanent skip counter
      const abandonCount = parseInt(
        await getString(anchorKey(ref)) || "0",
      );
      const permSkipKey = PERM_SKIP_PREFIX + (ref.replace(/\s+/g, "-").slice(0, 120));
      const permSkipCount = parseInt(await getString(permSkipKey) || "0");
      if (abandonCount > 0 || permSkipCount >= 2) {
        console.log(`[ControlLoop] Skipping codebase-health issue "${ref}" (abandoned=${abandonCount}, permSkip=${permSkipCount}) — falling through`);
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

function anchorKey(anchorRef) {
  // Normalize anchor reference to a stable Redis key
  return ABANDONMENT_COUNTER_PREFIX + (anchorRef || "unknown").replace(/\s+/g, "-").slice(0, 120);
}

async function trackAbandonment(anchorRef, task, reason) {
  const key = anchorKey(anchorRef);
  const count = await incrKey(key);
  await expireKey(key, ABANDONMENT_COUNTER_TTL);

  if (count >= MAX_CONSECUTIVE_ABANDONMENTS) {
    console.log(`[ControlLoop] Circuit breaker: anchor "${anchorRef}" abandoned ${count}x — escalating to reframe queue`);
    await listRPush(REFRAME_QUEUE, JSON.stringify({
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
      const blockResult = await block(anchorRef, `Circuit breaker: abandoned ${count}x — escalated to reframe queue`);
      if (blockResult.ok) {
        console.log(`[ControlLoop] Blocked Kanban item "${anchorRef}" to unblock reframe processing`);
      } else {
        console.log(`[ControlLoop] No Kanban item to block for "${anchorRef}" (${blockResult.error || "not found"})`);
      }
    } catch (err: any) {
      // Not all anchors have a Kanban item (e.g. work queue items, failing tests)
      // — this is expected and safe to ignore
      console.log(`[ControlLoop] No Kanban item to block for "${anchorRef}" (${err.message})`);
    }
    // Reset counter so the reframe gets one clean shot
    await delKey(key);
    return true; // escalated
  }
  return false; // not yet escalated
}

async function clearAbandonmentCounter(anchorRef) {
  await delKey(anchorKey(anchorRef));
}

async function storePriorFailure(taskId, reason, verificationResult, priorRetryCount = 0) {
  // Invalidate plan cache — a plan that led to failure should not be reused.
  // Try all cacheable anchor types since we don't know the original type here.
  const cacheableTypes = ["user-request", "codebase-health", "failing-test", "research"];
  for (const type of cacheableTypes) {
    try {
      await invalidatePlanCacheForAnchor({ type, reference: taskId });
    } catch (err: any) {
      console.error(`[ControlLoop] Plan cache invalidation failed for ${type}:${taskId}: ${err.message}`);
    }
  }

  // Count total attempts: prior retryCount (from popped item) + any still in queue (issue #93).
  // Before issue #93, the popped item's retryCount was lost because selectAnchor removed it
  // from the queue before storePriorFailure scanned. Now we accept priorRetryCount from the
  // caller so the count accumulates correctly.
  const existing = await listRange(PRIOR_FAILURES_KEY, 0, -1);
  const queueMatches = existing.filter(raw => {
    try { return JSON.parse(raw).taskId === taskId; } catch { return false; }
  }).length;
  const priorAttempts = Math.max(priorRetryCount, queueMatches);

  if (priorAttempts >= MAX_PRIOR_FAILURE_RETRIES) {
    // Escalate to reframe queue — planner will diagnose and rewrite the task
    console.log(`[ControlLoop] Escalating ${taskId} to reframe queue after ${priorAttempts + 1} failures`);

    // Gather failure history for context
    const task = await hashGetAll(taskKey(taskId));
    const failureHistory = existing
      .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(f => f?.taskId === taskId);

    await listRPush(REFRAME_QUEUE, JSON.stringify({
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

  await listRPush(PRIOR_FAILURES_KEY, JSON.stringify({
    taskId,
    reason,
    failedSteps: verificationResult?.steps?.filter((s) => !s.passed).map((s) => s.label) || [],
    retryCount: priorAttempts + 1,
    timestamp: new Date().toISOString(),
  }));

  // Enforce hard cap — escalate oldest items when queue exceeds limit (issue #18)
  try {
    const queueLen = await listLen(PRIOR_FAILURES_KEY);
    if (queueLen > PRIOR_FAILURE_CAP) {
      const overflow = queueLen - PRIOR_FAILURE_CAP;
      for (let i = 0; i < overflow; i++) {
        const raw = await listLPop(PRIOR_FAILURES_KEY);
        if (!raw) break;
        try {
          const item = JSON.parse(raw);
          await listRPush(REFRAME_QUEUE, JSON.stringify({
            originalTaskId: item.taskId,
            originalTitle: item.taskId,
            originalDescription: "",
            anchorType: "prior-failure",
            anchorReference: item.taskId,
            scopeBoundary: null,
            totalAttempts: item.retryCount || 1,
            lastReason: item.reason,
            failedSteps: item.failedSteps || [],
            failureHistory: [],
            verificationStderr: "",
            escalatedAt: new Date().toISOString(),
            escalationSource: "prior-failure-cap-overflow",
            escalationReason: `Auto-escalated: prior-failures queue exceeded cap of ${PRIOR_FAILURE_CAP}`,
          }));
          console.log(`[ControlLoop] Prior-failure "${item.taskId}" escalated to reframe (cap overflow: ${queueLen}/${PRIOR_FAILURE_CAP})`);
        } catch (parseErr: any) {
          console.error(`[ControlLoop] Corrupt prior-failure dropped during cap enforcement: ${parseErr.message}`);
        }
      }
    }
  } catch (capErr: any) {
    console.error(`[ControlLoop] Prior-failure cap enforcement failed: ${capErr.message}`);
  }
}

/**
 * Remove a work-queue item from the processing list after a cycle completes
 * (success, failure, or abandon). No-op if the anchor didn't come from the
 * work queue. Idempotent — safe to call multiple times.
 */
async function clearProcessingItem(anchor) {
  if (anchor?._workQueueRaw) {
    try {
      await listRem(PROCESSING_QUEUE, 1, anchor._workQueueRaw);
    } catch (err: any) {
      console.error(`[ControlLoop] Failed to clear processing queue item: ${err.message}`);
    }
  }
}

/**
 * Get the current length of the reframe queue.
 * Used by the scheduler for interleaving logic (issue #57).
 */
async function getReframeQueueLen(): Promise<number> {
  return listLen(REFRAME_QUEUE);
}

// ---------------------------------------------------------------------------
// reportOutcome — unified post-cycle anchor bookkeeping (issue #69)
// ---------------------------------------------------------------------------

export interface OutcomeResult {
  status: "merged" | "failed" | "abandoned" | "skipped";
  reason?: string;
  verification?: any;
  task?: any;
  taskId?: string;
}

/**
 * Unified post-cycle anchor bookkeeping. Dispatches to the correct combination
 * of trackAbandonment, clearAbandonmentCounter, storePriorFailure, and
 * clearProcessingItem based on outcome status.
 *
 * - **merged**: clears abandonment counter + clears processing item
 * - **failed**: stores prior failure (with escalation logic) + clears processing item
 * - **abandoned**: tracks abandonment (circuit breaker) + clears processing item
 */
export async function reportOutcome(anchor: any, result: OutcomeResult): Promise<void> {
  const { status, reason, verification, task, taskId } = result;

  switch (status) {
    case "merged":
      await clearAbandonmentCounter(anchor.reference);
      await clearProcessingItem(anchor);
      break;

    case "failed": {
      // Pass prior retryCount from the anchor context so storePriorFailure
      // can accumulate correctly even though the item was already popped (issue #93).
      const priorRetryCount = anchor?.context?.retryCount || 0;
      await storePriorFailure(
        taskId ?? "unknown",
        reason ?? "Unknown failure",
        verification ?? null,
        priorRetryCount,
      );
      await clearProcessingItem(anchor);
      break;
    }

    case "abandoned":
      await trackAbandonment(
        anchor.reference,
        task ?? { title: anchor.reference, taskId: "none" },
        reason ?? "Unknown abandonment",
      );
      await clearProcessingItem(anchor);
      break;

    case "skipped":
      // Early-exit scenarios (no-work, skipped, usage-limit) — just clear processing
      await clearProcessingItem(anchor);
      break;
  }
}

// ---------------------------------------------------------------------------
// _testing — escape hatch for tests that need access to internals
// ---------------------------------------------------------------------------

export const _testing = {
  MAX_PRIOR_FAILURE_RETRIES,
  MAX_CONSECUTIVE_ABANDONMENTS,
  REFRAME_QUEUE,
  WORK_QUEUE,
  PROCESSING_QUEUE,
  PRIOR_FAILURES_KEY,
  ABANDONMENT_COUNTER_PREFIX,
  ABANDONMENT_COUNTER_TTL,
  PRIOR_FAILURE_AGE_LIMIT_MS,
  PRIOR_FAILURE_CAP,
  REFRAME_QUEUE_CAP,
  REFRAME_QUEUE_MAX_AGE_MS,
  REFRAME_INTERLEAVE_INTERVAL,
  trackAbandonment,
  clearAbandonmentCounter,
  storePriorFailure,
  clearProcessingItem,
  anchorKey,
  escalateStalePriorFailures,
  pruneReframeQueue,
  getReframeQueueLen,
};
