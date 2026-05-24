/**
 * Anchor calibration Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Record a calibration outcome for an anchor confidence prediction.
 */
export async function setCalibrationOutcome(
  cycleId: string,
  data: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.anchorCalibration(cycleId), data, "EX", ttlSeconds);
  await r.zadd(redisKeys.anchorCalibrationIndex(), Date.now(), cycleId);
}
