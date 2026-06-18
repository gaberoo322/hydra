/**
 * Done-lane pruning chore.
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

import { pruneOldDoneItems } from "../../backlog/lanes.ts";

/** External touchpoints of the done-lane prune chore. */
export interface DoneLanePruneDeps {
  pruneOldDoneItems?: typeof pruneOldDoneItems;
}

/**
 * Prune old done-lane items from the backlog. Lives at the tick level rather
 * than wedged inside `maybeRunResearch` so it still runs when the research path
 * early-exits on any of its skip gates.
 */
export async function runDoneLanePrune(deps: DoneLanePruneDeps = {}): Promise<void> {
  const pruneFn = deps.pruneOldDoneItems ?? pruneOldDoneItems;
  await pruneFn();
}
