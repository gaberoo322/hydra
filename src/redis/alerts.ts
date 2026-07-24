/**
 * Alert list Redis ops. Extracted from redis-adapter.ts (issue #269);
 * extended in ADR-0009 slice 5 to cover the dismiss + clear flows so
 * api/alerts.ts no longer touches the raw key.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

/**
 * Push an alert to the alerts list (capped at maxLen).
 *
 * Pre-validates `alertJson` as parseable JSON before storing (issue #3609).
 * The scout alert-listener (`src/scout/alert-listener.ts:planAlertDispatches`)
 * consumes this list with `JSON.parse` and silently drops any entry it can't
 * parse — a truncated / malformed entry there costs a scout dispatch
 * opportunity with only a log line. Rejecting an unparseable string at the
 * write boundary keeps the list an invariant of parseable objects, so a
 * corrupt / truncated string never reaches (and never poisons) the reader.
 *
 * This is a fail-loud reject: the bad alert is logged with its raw payload and
 * dropped, never stored. Returns `false` when the alert was rejected, `true`
 * when stored, so callers/tests can discriminate without re-reading Redis.
 */
export async function pushAlert(alertJson: string, maxLen: number): Promise<boolean> {
  if (typeof alertJson !== "string" || alertJson.length === 0) {
    logger.error(
      { rawJson: alertJson },
      "[alerts] rejecting non-string/empty alert before store",
    );
    return false;
  }
  try {
    JSON.parse(alertJson); // pre-validate — the scout listener re-parses this
  } catch (err) {
    logger.error(
      { rawJson: alertJson, err },
      "[alerts] rejecting unparseable alert before store",
    );
    return false;
  }
  const r = getRedisConnection();
  await r.lpush(redisKeys.alerts(), alertJson);
  await r.ltrim(redisKeys.alerts(), 0, maxLen - 1);
  return true;
}

/** Read the most recent alerts (LPUSH-ed list — index 0 is newest). */
export async function readRecentAlerts(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.lrange(redisKeys.alerts(), 0, limit - 1);
}

/** Read every alert in the list (used by dismiss-by-id scan). */
export async function readAllAlerts(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.alerts(), 0, -1);
}

/** Overwrite a specific position in the alerts list. */
export async function setAlertAt(index: number, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.lset(redisKeys.alerts(), index, json);
}

/** Drop every alert. */
export async function clearAlerts(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.alerts());
}
