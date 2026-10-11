/**
 * Post-quota admission cooldown hint Redis ops (issue #4836).
 *
 * Owns the "do not admit a new run until <t>" instant at
 * `hydra:autopilot:post-quota-until`. The OAuth 5h meter LAGS a just-dispatched
 * wave by minutes (up to ~25 min observed), so when a run ends
 * `term_reason=quota` the reading the Pace Gate sees right afterwards can still
 * sit below the throttle band — and the gate admits a fresh run into a window
 * that cannot hold a wave (runs 6d8c8193 -> f41ad704 and 9fc0aeb8 -> e938e037
 * both crashed into the session limit this way).
 *
 * {@link endRun} stamps this hint on the transition that sets
 * `term_reason=quota`; while it is a FUTURE instant the pace-gate skips launch
 * (tick reason `post-quota-cooldown`), giving the meter time to catch up.
 *
 * **Launcher-only, NOT a hard stop** — same contract as `workless-hint.ts`: it
 * never flips `allow` (decide.py drains on `!allow`), it is surfaced as
 * `reasons.postQuotaUntil` and acted on ONLY by pace-gate.sh.
 *
 * **Self-clearing by TTL** (instant + buffer); a corrupt / past value reads as
 * `null` (no hint) so a bad write can never wedge the launcher off.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

/**
 * Default cooldown: 30 minutes after a quota exit. Covers the worst observed
 * meter lag (~25 min) and costs at most two ~15-min gate ticks. Overridable via
 * `HYDRA_POST_QUOTA_BACKOFF_SEC`.
 */
export const POST_QUOTA_BACKOFF_DEFAULT_SEC = 30 * 60;

/** Extra TTL seconds beyond the hint instant (host-vs-Redis clock skew). */
export const POST_QUOTA_TTL_BUFFER_SEC = 60;

/**
 * Resolve the configured cooldown window in seconds. A missing / non-positive /
 * unparseable `HYDRA_POST_QUOTA_BACKOFF_SEC` falls back to the default — never a
 * zero or negative window, which would make the hint a no-op.
 */
export function postQuotaBackoffSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_POST_QUOTA_BACKOFF_SEC;
  if (raw === undefined) return POST_QUOTA_BACKOFF_DEFAULT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return POST_QUOTA_BACKOFF_DEFAULT_SEC;
  return Math.floor(n);
}

/**
 * Read the recorded post-quota-until instant (epoch-ms), or `null` when absent,
 * unparseable, or already past (fail SAFE to no hint).
 */
export async function getPostQuotaUntil(nowMs: number = Date.now()): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.autopilotPostQuotaUntil());
  if (!raw) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    logger.error(
      { raw },
      "[post-quota-hint] unparseable post-quota-until value, treating as no cooldown",
    );
    return null;
  }
  if (ms <= nowMs) return null;
  return ms;
}

/**
 * Record a post-quota-until instant (epoch-ms) with a TTL of
 * `(untilMs - now) + buffer`. A non-finite / already-past instant is a logged
 * no-op. Returns the stored instant, or `null` when nothing was stored.
 */
export async function setPostQuotaUntil(
  untilMs: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    logger.error(
      { untilMs, now: nowMs },
      "[post-quota-hint] refusing to record non-future post-quota hint",
    );
    return null;
  }
  const ttlSec = Math.ceil((untilMs - nowMs) / 1000) + POST_QUOTA_TTL_BUFFER_SEC;
  const r = getRedisConnection();
  await r.set(redisKeys.autopilotPostQuotaUntil(), String(untilMs), "EX", ttlSec);
  return untilMs;
}

/** Clear the post-quota hint. Idempotent. */
export async function clearPostQuotaUntil(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.autopilotPostQuotaUntil());
}
