// ---------------------------------------------------------------------------
// selectAnchor — the 13-tier priority chain
// ---------------------------------------------------------------------------
//
// Pure orchestration (Redis + filesystem reads) with no side-effects on the
// working tree. Each tier delegates to a dedicated sub-module so this file
// stays a thin dispatcher of "try tier N, otherwise fall through".

import { _admin } from "../backlog.ts";
import {
  listRange,
  listRPush,
  delKey,
} from "../redis-adapter.ts";
import { WORK_QUEUE, PROCESSING_QUEUE } from "./constants.ts";
import { selectKanbanAnchor } from "./kanban-tier.ts";
import { selectWorkQueueAnchor } from "./work-queue-tier.ts";
import {
  selectReframeAnchor,
  hasReframeCandidate,
} from "./reframe-queue-tier.ts";
import { selectPriorFailureAnchor } from "./prior-failures-tier.ts";
import { selectRegressionHuntAnchor } from "./regression-hunt-tier.ts";
import { selectCodebaseHealthAnchor } from "./codebase-health-tier.ts";
import { selectPrioritiesDocAnchor } from "./priorities-doc-tier.ts";
import {
  recordReframePassedReason,
  recordReframeServed,
  type ReframePassedReason,
} from "./reframe-starvation.ts";
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

  // Reframe-starvation bookkeeping (issue #377): if a non-reframe tier wins
  // below, we'll record the reason so operators can see whether reframe is
  // shadowed because it has nothing to serve or because a higher tier keeps
  // pre-empting it. We snapshot the "has candidate" flag once here so the
  // recording at every branch below is consistent within a cycle, and is
  // also cheap (single LLEN). When false, every recording path below
  // collapses to `no_reframe_candidate`.
  let reframeHasCandidate = false;
  try {
    reframeHasCandidate = await hasReframeCandidate();
  } catch (err: any) {
    console.error(`[AnchorSelection] reframe candidate probe failed: ${err.message}`);
  }
  const recordReframeLoss = async (winnerReason: ReframePassedReason) => {
    const reason: ReframePassedReason = reframeHasCandidate
      ? winnerReason
      : "no_reframe_candidate";
    await recordReframePassedReason(reason);
  };

  // 1. Explicit user request — operator override is out-of-band, so we
  //    deliberately don't increment the reframe pass-over gauge here. The
  //    cyclesSinceReframeServed counter only advances on normal selection
  //    cycles.
  if (opts.anchor) {
    return { ...opts.anchor, whyNow: "Explicit operator request" };
  }

  // 1.2. Capacity-floor dispatcher (issue #321; spec floor retired in #513).
  //      Two floors remain: self-improvement (stuckness-driven research)
  //      and the reframe-queue floor (issue #377). The dispatcher fires at
  //      most one floor per cycle; when none are ready we fall through to
  //      the existing tier chain (kanban → failing tests → …).
  try {
    const dispatch = await dispatchCapacityFloor(defaultCapacityFloors(), eventBus);
    if (dispatch.anchor) {
      // If the reframe floor fired, its buildAnchor() already recorded
      // recordReframeServed + recordReframePassedReason("force_floor").
      // For any other floor winning, the floor's onPassedOver hook handled
      // the reframe pass-over recording (see reframeFloorDecl). No
      // further bookkeeping needed here.
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

  // 2. Kanban queued lane — priority-sorted backlog items take precedence
  //    when the capacity floor has not yet fired.
  if (!wipBlocked) {
    const kanban = await selectKanbanAnchor();
    if (kanban.anchor) {
      await recordReframeLoss("kanban_won");
      return kanban.anchor;
    }
    if (kanban.wipBlocked) wipBlocked = true;
  }

  // 2.7. Failing tests — must be fixed before other work proceeds.
  //      Checked before the work queue because the preflight gate blocks all
  //      non-test-fix tasks when tests are red. Without this ordering, work
  //      queue items get selected, pass planning, then get rejected by preflight
  //      — wasting cycles.
  if (grounding.failingTests.length > 0) {
    await recordReframeLoss("failing_tests_won");
    return {
      type: "failing-test",
      reference: grounding.failingTests[0],
      whyNow: `${grounding.testReport.failed} test(s) currently failing`,
    };
  }

  // 2.8. Typecheck errors
  if (grounding.typecheckReport.exitCode !== 0) {
    await recordReframeLoss("failing_tests_won");
    return {
      type: "failing-test",
      reference: "typecheck",
      whyNow: "TypeScript typecheck has errors",
    };
  }

  // 3. Work queue items (from POST /queue or research auto-queue) — NOT WIP-gated.
  const workQueueAnchor = await selectWorkQueueAnchor();
  if (workQueueAnchor) {
    await recordReframeLoss("work_queue_won");
    return workQueueAnchor;
  }

  // 4.5. Reframe queue — tasks that failed repeatedly and need a fresh approach
  const reframeAnchor = await selectReframeAnchor();
  if (reframeAnchor) {
    // This is the natural-priority win (reframe lane reached without
    // capacity-floor pre-emption). Reset the starvation gauge and stamp
    // the last-served timestamp. We do NOT also call
    // recordReframePassedReason("force_floor") here — that's reserved
    // for the floor-driven path so operators can distinguish "served
    // because no one else had work" from "served because the floor
    // forced pre-emption."
    await recordReframeServed();
    return reframeAnchor;
  }

  // 5. Prior failures from Redis
  const priorFailureAnchor = await selectPriorFailureAnchor();
  if (priorFailureAnchor) {
    await recordReframeLoss("prior_failure_won");
    return priorFailureAnchor;
  }

  // 5. TODO/FIXME markers in code — developer-written signals of known gaps
  if (grounding.todoMarkers?.length > 0) {
    await recordReframeLoss("codebase_health_won");
    return {
      type: "issue",
      reference: grounding.todoMarkers[0],
      whyNow: `${grounding.todoMarkers.length} TODO/FIXME marker(s) found in codebase`,
      context: grounding.todoMarkers.slice(0, 5).join("\n"),
    };
  }

  // 5.5. Regression hunt — every 10 merges, test recent features for edge cases
  const regressionHunt = await selectRegressionHuntAnchor();
  if (regressionHunt) {
    await recordReframeLoss("regression_hunt_won");
    return regressionHunt;
  }

  // 6. Codebase health — reductive improvements (split, consolidate, document)
  const healthAnchor = await selectCodebaseHealthAnchor(grounding);
  if (healthAnchor) {
    await recordReframeLoss("codebase_health_won");
    return healthAnchor;
  }

  // 7. Fall back to priorities doc — with saturation/staleness gates
  await recordReframeLoss("priorities_doc_won");
  return await selectPrioritiesDocAnchor(grounding);
}
