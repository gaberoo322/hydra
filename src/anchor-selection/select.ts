// ---------------------------------------------------------------------------
// selectAnchor — the 13-tier priority chain
// ---------------------------------------------------------------------------
//
// Pure orchestration (Redis + filesystem reads) with no side-effects on the
// working tree. Each tier delegates to a dedicated sub-module so this file
// stays a thin dispatcher of "try tier N, otherwise fall through".

import { _admin } from "../backlog.ts";
import { getNextSpecTask } from "../specs.ts";
import {
  listRange,
  listRPush,
  delKey,
} from "../redis-adapter.ts";
import { WORK_QUEUE, PROCESSING_QUEUE } from "./constants.ts";
import { selectKanbanAnchor } from "./kanban-tier.ts";
import { selectWorkQueueAnchor } from "./work-queue-tier.ts";
import { selectReframeAnchor } from "./reframe-queue-tier.ts";
import { selectPriorFailureAnchor } from "./prior-failures-tier.ts";
import { selectRegressionHuntAnchor } from "./regression-hunt-tier.ts";
import { selectCodebaseHealthAnchor } from "./codebase-health-tier.ts";
import { selectPrioritiesDocAnchor } from "./priorities-doc-tier.ts";
import {
  recordSpecPassedReason,
  recordSpecServed,
} from "./spec-starvation.ts";
import { buildSpecAnchor } from "./build-spec-anchor.ts";
import {
  dispatchCapacityFloor,
  defaultCapacityFloors,
} from "./capacity-floors.ts";

const { isWipLimitReached, requeueStaleInProgressItems } = _admin;

/**
 * Select the next anchor based on priority:
 * 1. Explicit user request (passed in opts)
 * 2. Failing tests (from grounding)
 * 3. Prior failures (stored in Redis)
 * 4. Priorities doc (fall back to operator direction)
 */
export async function selectAnchor(grounding: any, opts: any = {}, eventBus: any = null) {
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
  if (opts.anchor) {
    return { ...opts.anchor, whyNow: "Explicit operator request" };
  }

  // 1.2. Unified capacity-floor dispatcher (issue #321).
  //      Was: two independent branches (stuckness-driven research, spec
  //      capacity-floor) that stole cycles from kanban without seeing each
  //      other's state. They've been collapsed into a single declarative
  //      dispatcher in capacity-floors.ts. At most one floor fires per
  //      cycle; ties go to the floor with the largest deficit, then by
  //      declared priority. When no floor is ready we fall through to the
  //      existing tier chain (kanban → specs → failing tests → …).
  //
  //      Behavior preservation:
  //        - When ONLY the stuckness floor is ready → fires stuckness anchor,
  //          identical to the pre-refactor `pickStuckOutcome` path.
  //        - When ONLY the spec floor is ready → fires spec anchor, identical
  //          to the pre-refactor `forceSpec && nextSpec` path.
  //        - When BOTH are ready → spec floor wins (priority 1 < 2),
  //          matching the pre-refactor `if (!forceSpec)` gating of stuckness.
  try {
    const dispatch = await dispatchCapacityFloor(defaultCapacityFloors(), eventBus);
    if (dispatch.anchor) {
      return dispatch.anchor;
    }
  } catch (err: any) {
    console.error(`[AnchorSelection] capacity-floor dispatch failed: ${err.message}`);
    // Fall through — floors are *preferred* signals, not load-bearing.
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

  // The spec-tier prefetch is still needed for the *non-pre-empting* spec
  // selection path below (priority 4 in CLAUDE.md). When the capacity-floor
  // dispatcher already served a spec we never reach this point.
  let nextSpec: Awaited<ReturnType<typeof getNextSpecTask>> = null;
  try {
    nextSpec = await getNextSpecTask();
  } catch (err: any) {
    console.error(`[AnchorSelection] spec prefetch failed: ${err.message}`);
  }
  const hasSpecTask = !!nextSpec;

  // 2. Kanban queued lane — priority-sorted backlog items take precedence
  //    when the capacity floor has not yet fired.
  if (!wipBlocked) {
    const kanban = await selectKanbanAnchor();
    if (kanban.anchor) {
      if (hasSpecTask) await recordSpecPassedReason("kanban_won");
      return kanban.anchor;
    }
    if (kanban.wipBlocked) wipBlocked = true;
  }

  // 2.5. Active specs — persistent multi-cycle task decompositions.
  //      Created by research (complex opportunities) or the operator.
  //      Picks the next unchecked task from the oldest active spec.
  //      NOT gated by WIP limit — specs represent committed multi-cycle plans.
  if (!wipBlocked) {
    if (nextSpec) {
      await recordSpecServed();
      return buildSpecAnchor(nextSpec);
    }
    // hasSpecTask was false during prefetch — record the reason.
    await recordSpecPassedReason("no_active_spec");
  } else if (hasSpecTask) {
    // WIP blocked AND we had a spec — record wip_full so operators see why
    // specs aren't running even though they exist.
    await recordSpecPassedReason("wip_full");
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

  // 3. Work queue items (from POST /queue or research auto-queue) — NOT WIP-gated.
  const workQueueAnchor = await selectWorkQueueAnchor();
  if (workQueueAnchor) return workQueueAnchor;

  // 4.5. Reframe queue — tasks that failed repeatedly and need a fresh approach
  const reframeAnchor = await selectReframeAnchor();
  if (reframeAnchor) return reframeAnchor;

  // 5. Prior failures from Redis
  const priorFailureAnchor = await selectPriorFailureAnchor();
  if (priorFailureAnchor) return priorFailureAnchor;

  // 5. TODO/FIXME markers in code — developer-written signals of known gaps
  if (grounding.todoMarkers?.length > 0) {
    return {
      type: "issue",
      reference: grounding.todoMarkers[0],
      whyNow: `${grounding.todoMarkers.length} TODO/FIXME marker(s) found in codebase`,
      context: grounding.todoMarkers.slice(0, 5).join("\n"),
    };
  }

  // 5.5. Regression hunt — every 10 merges, test recent features for edge cases
  const regressionHunt = await selectRegressionHuntAnchor();
  if (regressionHunt) return regressionHunt;

  // 6. Codebase health — reductive improvements (split, consolidate, document)
  const healthAnchor = await selectCodebaseHealthAnchor(grounding);
  if (healthAnchor) return healthAnchor;

  // 7. Fall back to priorities doc — with saturation/staleness gates
  return await selectPrioritiesDocAnchor(grounding);
}
