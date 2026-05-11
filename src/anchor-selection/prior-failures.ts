// ---------------------------------------------------------------------------
// Prior-failure escalation — prevent unbounded accumulation (issue #18, #93)
// ---------------------------------------------------------------------------

import {
  listRange,
  listRPush,
  listRem,
  listLPop,
  listLen,
  hashGetAll,
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
