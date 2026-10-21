/**
 * /hydra-review pickup-set phone-notify chore (issue #745).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090).
 *
 * Edge-triggered: fires exactly ONE notification when the /hydra-review pickup
 * set (ready-for-human + stale-blocked) transitions
 * from empty -> non-empty, then suppresses repeats while it stays non-empty,
 * and re-arms once it drains to empty. The armed-state flag lives in Redis
 * (`hydra:review:pickup-armed`) so the edge survives an orchestrator restart —
 * a bounce mid-non-empty must NOT re-fire.
 *
 * The fire edge publishes `review:pickup_ready` on the notifications stream;
 * the notification consumer routes it to the Operator Channel as a Page
 * (ADR-0045 Decision 3 — it is on the closed page list) with the
 * `/hydra-review` action and a link to the first item. The drain edge calls
 * `channel.resolve("review:pickup_ready")` (issue #5047) so the page's
 * edge-trigger state clears with the set: the next empty -> non-empty edge is
 * a fresh page, not a 6h-suppressed repeat or a "still failing" reminder. The
 * chore stays the edge detector (set emptiness is what it observes); the
 * channel's time-based dedup never replaces the armed flag.
 *
 * Never throws — a failed fetch is treated as "couldn't sample", which leaves
 * the armed-state untouched so the next tick re-evaluates. Better a missed
 * alert than a spurious one.
 */

import {
  getReviewPickupNotified,
  setReviewPickupNotified,
  clearReviewPickupNotified,
} from "../../redis/review.ts";
import { getReviewPickupSet } from "../../review-pickup.ts";
import type { PublishableBus } from "../../event-bus-seams.ts";
import { NOTIFICATION_EVENT_TYPES as E } from "../../event-bus-vocabulary.ts";
import { operatorChannel, type OperatorChannel } from "../../operator-channel/channel.ts";
import { logger } from "../../logger.ts";

/**
 * External touchpoints of the review-pickup-notify chore. `deps` is injectable
 * so the test suite can stub the pickup-set fetch, the armed-state accessors
 * and the Operator Channel without a live Redis / `gh` / Telegram.
 */
export interface ReviewPickupNotifyDeps {
  getPickupSet?: typeof getReviewPickupSet;
  getNotified?: typeof getReviewPickupNotified;
  setNotified?: typeof setReviewPickupNotified;
  clearNotified?: typeof clearReviewPickupNotified;
  /** Resolves the `review:pickup_ready` page on the drain edge. Defaults to the singleton. */
  channel?: Pick<OperatorChannel, "resolve">;
}

/**
 * Sample the pickup set and fire/suppress the edge-triggered notification.
 *
 * Returns a small summary `{ fired, count, transitioned }` so the housekeeping
 * caller and tests can see what happened. `transitioned` is true on either
 * edge (empty->non-empty fires; non-empty->empty re-arms and resolves the page).
 */
export async function runReviewPickupNotify(
  eventBus: PublishableBus,
  deps: ReviewPickupNotifyDeps = {},
): Promise<{ fired: boolean; count: number; transitioned: boolean }> {
  const getPickupSet = deps.getPickupSet ?? getReviewPickupSet;
  const getNotified = deps.getNotified ?? getReviewPickupNotified;
  const setNotified = deps.setNotified ?? setReviewPickupNotified;
  const clearNotified = deps.clearNotified ?? clearReviewPickupNotified;
  const channel = deps.channel ?? operatorChannel;

  const items = await getPickupSet();
  const count = items.length;
  const alreadyNotified = await getNotified();

  if (count === 0) {
    // Set is empty — re-arm if a prior notification is still suppressing.
    if (alreadyNotified) {
      await clearNotified();
      // Clear the page's edge state too (one "recovered" message iff it was
      // bad). resolve() never throws for transport or Redis failure.
      await channel.resolve(E.REVIEW_PICKUP_READY, "review pickup set drained");
      logger.info({}, "review-pickup-notify: set drained — re-armed notify hook, resolved page");
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
  const { STREAMS } = await import("../../event-bus-stream-keys.ts");
  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: E.REVIEW_PICKUP_READY,
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
  logger.info({ count }, "review-pickup-notify: set non-empty — sent notify");
  return { fired: true, count, transitioned: true };
}
