// ---------------------------------------------------------------------------
// Prior-failures — persistence, age/retry-cap escalation, and tier selection
// (issues #18, #93, #188)
// ---------------------------------------------------------------------------
//
// One module for the prior-failure lane's full lifecycle:
//
//   - `storePriorFailure` — persist a failed task, enforce retry cap +
//     queue cap, invalidate the plan cache.
//   - `escalateStalePriorFailures` — age-out items past the age limit.
//   - `selectPriorFailureAnchor` — scan the queue, prune orphans, return the
//     next retryable item.

import {
  listRange,
  listRPush,
  listRem,
  listLPop,
  listLen,
  hashGetAll,
  keyExists,
} from "../redis-adapter.ts";
import { invalidatePlanCacheForAnchor } from "../plan-cache.ts";
import {
  REFRAME_QUEUE,
  PRIOR_FAILURES_KEY,
  PRIOR_FAILURE_AGE_LIMIT_MS,
  PRIOR_FAILURE_CAP,
  MAX_PRIOR_FAILURE_RETRIES,
  taskKey,
} from "./constants.ts";

/**
 * Scan all prior-failure items and escalate any that exceed the age threshold
 * to the reframe queue. Called from selectAnchor() before claiming a prior-failure
 * item, so stale items are cleaned up every cycle.
 */
export async function escalateStalePriorFailures(): Promise<number> {
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
          originalTitle: item.title || item.taskId,
          originalDescription: item.description || "",
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

/**
 * Persist a failed task to the prior-failures queue. If retryCount has hit
 * MAX_PRIOR_FAILURE_RETRIES the item is escalated directly to the reframe
 * queue. Enforces a hard cap on the prior-failures queue itself (issue #18).
 */
export async function storePriorFailure(
  taskId: string,
  reason: string,
  verificationResult: any,
  priorRetryCount = 0,
): Promise<void> {
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
    try { return JSON.parse(raw).taskId === taskId; } catch { /* intentional: unparseable prior-failure entry is not a match */ return false; }
  }).length;
  const priorAttempts = Math.max(priorRetryCount, queueMatches);

  // Read task hash now — embed title/description in the prior-failure entry so it
  // remains self-contained after the task hash expires (7-day TTL). (issue #188)
  const task = await hashGetAll(taskKey(taskId));

  if (priorAttempts >= MAX_PRIOR_FAILURE_RETRIES) {
    // Escalate to reframe queue — planner will diagnose and rewrite the task
    console.log(`[ControlLoop] Escalating ${taskId} to reframe queue after ${priorAttempts + 1} failures`);

    // Gather failure history for context
    const failureHistory = existing
      .map(raw => { try { return JSON.parse(raw); } catch { /* intentional: drop unparseable history entries */ return null; } })
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
      failedSteps: verificationResult?.steps?.filter((s: any) => !s.passed).map((s: any) => s.label) || [],
      failureHistory: failureHistory.map(f => ({ reason: f.reason, failedSteps: f.failedSteps, timestamp: f.timestamp })),
      verificationStderr: verificationResult?.steps
        ?.filter((s: any) => !s.passed)
        .map((s: any) => `${s.label}: ${(s.stderr || "").slice(0, 300)}`)
        .join("\n") || "",
      escalatedAt: new Date().toISOString(),
    }));
    return;
  }

  await listRPush(PRIOR_FAILURES_KEY, JSON.stringify({
    taskId,
    title: task?.title || "",
    description: task?.description || "",
    reason,
    failedSteps: verificationResult?.steps?.filter((s: any) => !s.passed).map((s: any) => s.label) || [],
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
            originalTitle: item.title || item.taskId,
            originalDescription: item.description || "",
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

// ---------------------------------------------------------------------------
// Tier selection
// ---------------------------------------------------------------------------

export interface PriorFailureAnchor {
  type: "prior-failure";
  reference: string;
  whyNow: string;
  context: any;
}

/**
 * Return the next retryable prior-failure anchor, or null if none remain.
 * Side-effects: escalates stale/over-cap items to the reframe queue, prunes
 * orphan entries whose task hash has expired (issue #188).
 */
export async function selectPriorFailureAnchor(): Promise<PriorFailureAnchor | null> {
  // First, escalate any stale items so the queue doesn't accumulate unbounded.
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
  // Items whose task hash has expired are pruned silently (issue #188).
  const allPriorFailures = await listRange(PRIOR_FAILURES_KEY, 0, -1);
  for (const raw of allPriorFailures) {
    try {
      const failure = JSON.parse(raw);

      // Prune orphan entries whose task hash has expired from Redis (issue #188).
      // Prior-failure entries have no TTL but task hashes expire after 7 days.
      // Without title/description context the planner can't act on these, so
      // check the self-contained fields first, then fall back to the task hash.
      const hasContext = !!(failure.title && failure.description);
      if (!hasContext) {
        const taskExists = await keyExists(taskKey(failure.taskId));
        if (!taskExists) {
          await listRem(PRIOR_FAILURES_KEY, 1, raw);
          console.log(`[ControlLoop] Pruned orphan prior-failure "${failure.taskId}" — task hash expired, no embedded context`);
          continue;
        }
      }

      if ((failure.retryCount || 0) >= MAX_PRIOR_FAILURE_RETRIES) {
        // Exceeded retry cap — escalate to reframe, don't retry
        await listRem(PRIOR_FAILURES_KEY, 1, raw);
        await listRPush(REFRAME_QUEUE, JSON.stringify({
          originalTaskId: failure.taskId,
          originalTitle: failure.title || failure.taskId,
          originalDescription: failure.description || "",
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

  return null;
}
