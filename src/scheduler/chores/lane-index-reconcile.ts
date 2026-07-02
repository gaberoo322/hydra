/**
 * Lane-index reconciler chore (issue #2056).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

import { reconcileLaneIndices as reconcileLaneIndicesImpl } from "../../backlog/index-reconciler.ts";

/** External touchpoints of the lane-index-reconcile chore. */
export interface LaneIndexReconcileDeps {
  reconcileLaneIndices?: () => Promise<unknown>;
}

/**
 * Lane-index reconciler (issue #2056) — repairs the lane sorted-set indices
 * FROM the canonical items hash. Self-heals the #1990 restart desync. No Redis
 * time-guard: it is intrinsically idempotent (a healthy board is a guaranteed
 * no-op).
 */
export async function runLaneIndexReconcile(deps: LaneIndexReconcileDeps = {}): Promise<void> {
  const reconcileLaneIndices = deps.reconcileLaneIndices ?? reconcileLaneIndicesImpl;
  await reconcileLaneIndices();
}
