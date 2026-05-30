/**
 * Review Redis ops (issue #745).
 *
 * Owns the edge-trigger armed-state for the /hydra-review pickup-set
 * phone-notify hook. The hook fires exactly one notification when the pickup
 * set transitions from empty -> non-empty, then suppresses further alerts
 * while the set stays non-empty, and re-arms once it drains back to empty.
 *
 * State model — a single string flag at `hydra:review:pickup-armed`:
 *   - present ("1") => the set is currently NON-EMPTY; a notification has
 *     already fired and is suppressed (hook is "armed-spent").
 *   - absent         => the set is empty; the hook is re-armed and will fire
 *     on the next non-empty transition.
 *
 * Modelled as set/clear/read rather than a JSON blob because the only thing
 * that matters is the edge: callers read the current armed state, compare it
 * to the freshly-sampled pickup-set size, and set or clear accordingly.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Read whether the pickup-notify hook is currently "armed-spent" (a
 * notification has already fired for the current non-empty run).
 *
 * Returns true when the flag is present, false when absent.
 */
export async function getReviewPickupNotified(): Promise<boolean> {
  const r = getRedisConnection();
  const val = await r.get(redisKeys.reviewPickupArmed());
  return val === "1";
}

/**
 * Mark the hook as "armed-spent" — the pickup set is non-empty and a
 * notification has fired. Suppresses repeats until cleared.
 */
export async function setReviewPickupNotified(): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.reviewPickupArmed(), "1");
}

/**
 * Re-arm the hook — the pickup set has drained to empty, so the next
 * empty -> non-empty transition should fire again.
 */
export async function clearReviewPickupNotified(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.reviewPickupArmed());
}
