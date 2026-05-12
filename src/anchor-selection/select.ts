// ---------------------------------------------------------------------------
// selectAnchor — the 13-tier priority chain
// ---------------------------------------------------------------------------
//
// Pure orchestration (Redis + filesystem reads) with no side-effects on the
// working tree. Each tier delegates to a dedicated sub-module so this file
// stays a thin dispatcher of "try tier N, otherwise fall through".

import { _admin } from "../backlog.ts";
import { getNextSpecTask, formatSpecForPrompt } from "../specs.ts";
import { getAllStuckness } from "../stuckness.ts";
import {
  listRange,
  listRPush,
  delKey,
} from "../redis-adapter.ts";
import { WORK_QUEUE, PROCESSING_QUEUE } from "./constants.ts";
import { pickStuckOutcome, buildStucknessAnchor } from "./stuckness-routing.ts";
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
  getCyclesSinceSpecServed,
  shouldForceSpecPriority,
  getSpecCapacityFloorN,
} from "./spec-starvation.ts";

const { isWipLimitReached, requeueStaleInProgressItems } = _admin;

/**
 * Build a "user-request" anchor from a spec task. Shared between the
 * natural spec-tier path and the capacity-floor pre-emption path (issue
 * #301) so both paths produce byte-identical anchors.
 */
function buildSpecAnchor(specNext: { spec: any; task: any }) {
  console.log(`[ControlLoop] Picking spec task: "${specNext.task.title}" from spec "${specNext.spec.title}" (task ${specNext.task.id}/${specNext.spec.tasks.length})`);
  return {
    type: "user-request" as const,
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

  // 1.2. Spec-starvation prefetch (issue #301).
  //      Read the cycles-since-spec-served gauge BEFORE the stuckness/kanban
  //      tiers so we can decide whether to force the spec tier ahead of
  //      kanban. Cheap reads only — actual selection happens below.
  let nextSpec: Awaited<ReturnType<typeof getNextSpecTask>> = null;
  let cyclesSinceSpec = 0;
  try {
    [nextSpec, cyclesSinceSpec] = await Promise.all([
      getNextSpecTask(),
      getCyclesSinceSpecServed(),
    ]);
  } catch (err: any) {
    console.error(`[AnchorSelection] spec-starvation prefetch failed: ${err.message}`);
  }
  const hasSpecTask = !!nextSpec;
  const floorN = getSpecCapacityFloorN();
  const forceSpec = shouldForceSpecPriority(cyclesSinceSpec, hasSpecTask, floorN);

  // 1.25. Stuckness-driven research (issue #253, ADR-0003 vision vector 1).
  //       When a Target Outcome has not moved favorably for N cycles, the next
  //       action MUST be research/self-modification — not another pull from the
  //       kanban backlog. Inserted before the kanban lane so a fired outcome
  //       short-circuits queue consumption. Per ADR-0005, no operator
  //       escalation — the autonomous response is research.
  //
  //       Exception (issue #301): when the spec capacity-floor has fired
  //       (>= floorN cycles since a spec was served AND a spec task exists),
  //       the spec tier pre-empts stuckness too — otherwise a perpetually-
  //       stuck outcome would also starve specs. The floor is intentionally
  //       cheap (1 cycle per N), so this only steals at most 1/N of the
  //       stuckness budget.
  if (!forceSpec) {
    try {
      const stucknessRows = await getAllStuckness();
      const stuckPick = await pickStuckOutcome(stucknessRows);
      if (stuckPick) {
        if (hasSpecTask) {
          await recordSpecPassedReason("stuckness_won");
        }
        return await buildStucknessAnchor(stuckPick, eventBus);
      }
    } catch (err: any) {
      console.error(`[AnchorSelection] stuckness check failed: ${err.message}`);
      // Fall through to existing priority chain — stuckness is a *preferred*
      // signal, not load-bearing. Original behavior is the safe default.
    }
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

  // 1.7. Spec capacity-floor pre-emption (issue #301).
  //      If the floor has fired AND a spec task is available, serve the spec
  //      tier BEFORE kanban. This is the only way out of the historical
  //      starvation pattern where kanban perpetually held priority 3.
  if (forceSpec && nextSpec) {
    console.log(`[ControlLoop] Spec capacity-floor fired (${cyclesSinceSpec} cycles since last spec served, floor=${floorN}) — pre-empting kanban with spec task`);
    await recordSpecServed();
    await recordSpecPassedReason("force_floor");
    return buildSpecAnchor(nextSpec);
  }

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
