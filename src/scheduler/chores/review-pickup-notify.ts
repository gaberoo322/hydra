/**
 * /hydra-review pickup-set phone-notify chore (issue #745).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 *
 * Edge-triggered: fires exactly ONE notification when the /hydra-review pickup
 * set (operator-decision-queue + ready-for-human + stale-blocked) transitions
 * from empty -> non-empty, then suppresses repeats while it stays non-empty,
 * and re-arms once it drains to empty. The armed-state flag lives in Redis
 * (`hydra:review:pickup-armed`) so the edge survives an orchestrator restart —
 * a bounce mid-non-empty must NOT re-fire.
 *
 * Reuses the existing notifications stream -> Telegram bridge (no new
 * transport; secrets via env per ADR-0005). Never throws — a failed fetch is
 * treated as "couldn't sample", which leaves the armed-state untouched so the
 * next tick re-evaluates. Better a missed alert than a spurious one.
 */

import {
  getReviewPickupNotified,
  setReviewPickupNotified,
  clearReviewPickupNotified,
} from "../../redis/review.ts";
import { getReviewPickupSet } from "../../review-pickup.ts";
import type { PublishableBus } from "../../api/event-bus-types.ts";

/**
 * External touchpoints of the review-pickup-notify chore. `deps` is injectable
 * so the test suite can stub the pickup-set fetch and the armed-state accessors
 * without a live Redis / `gh`.
 */
export interface ReviewPickupNotifyDeps {
  getPickupSet?: typeof getReviewPickupSet;
  getNotified?: typeof getReviewPickupNotified;
  setNotified?: typeof setReviewPickupNotified;
  clearNotified?: typeof clearReviewPickupNotified;
}

/**
 * Sample the pickup set and fire/suppress the edge-triggered notification.
 *
 * Returns a small summary `{ fired, count, transitioned }` so the housekeeping
 * caller and tests can see what happened. `transitioned` is true on either
 * edge (empty->non-empty fires; non-empty->empty re-arms).
 */
export async function runReviewPickupNotify(
  eventBus: PublishableBus,
  deps: ReviewPickupNotifyDeps = {},
): Promise<{ fired: boolean; count: number; transitioned: boolean }> {
  const getPickupSet = deps.getPickupSet ?? getReviewPickupSet;
  const getNotified = deps.getNotified ?? getReviewPickupNotified;
  const setNotified = deps.setNotified ?? setReviewPickupNotified;
  const clearNotified = deps.clearNotified ?? clearReviewPickupNotified;

  const items = await getPickupSet();
  const count = items.length;
  const alreadyNotified = await getNotified();

  if (count === 0) {
    // Set is empty — re-arm if a prior notification is still suppressing.
    if (alreadyNotified) {
      await clearNotified();
      console.log("[Housekeeping] Review pickup set drained — re-armed notify hook");
      return { fired: false, count: 0, transitioned: true };
    }
    return { fired: false, count: 0, transitioned: false };
  }

  // Set is non-empty.
  if (alreadyNotified) {
    // Already alerted for this non-empty run — suppress.
    return { fired: false, count, transitioned: false };
  }

  // Empty -> non-empty edge: fire exactly one notification, then arm-spent.
  const first = items[0];
  const { STREAMS } = await import("../../event-bus.ts");
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "review:pickup_ready",
    source: "scheduler",
    correlationId: `review-pickup-${first.number}`,
    payload: {
      count,
      firstTitle: first.title,
      firstUrl: first.url,
      firstNumber: first.number,
    },
  });
  await setNotified();
  console.log(`[Housekeeping] Review pickup set non-empty (${count}) — sent notify`);
  return { fired: true, count, transitioned: true };
}

// Issue #745 / #938: legacy name kept as an alias so any out-of-tree caller or
// older test that imported `checkReviewPickupNotify` keeps working. #2067
// renamed it `runReviewPickupNotify` for naming symmetry across the chore set.
export const checkReviewPickupNotify = runReviewPickupNotify;
