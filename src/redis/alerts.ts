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
 *
 * The LPUSH + LTRIM run inside a single Lua script (issue #3619) so no other
 * client's command can interleave between them — Redis executes a script
 * atomically. The prior two-await sequence left a transient window where the
 * list held `maxLen + 1` items with a concurrent `POST /alerts/:id/dismiss`
 * (`readAllAlerts` → `LSET`) racing on shifted indices — that index desync (not
 * any impossible LRANGE partial read; Redis returns whole list elements
 * atomically) is what let a mis-indexed `LSET` corrupt a neighbouring entry and
 * surface as an `Unexpected end of JSON input` at the scout reader. Collapsing
 * push+trim into one atomic script closes that window: a concurrent
 * reader/dismiss only ever observes the list at or below capacity, never the
 * intermediate over-capacity state.
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
  // Atomic push-and-trim: a Lua script runs atomically in Redis, so no other
  // client's command interleaves between the LPUSH and the LTRIM. The list is
  // never observed in its transient `maxLen + 1` over-capacity state (issue
  // #3619). Matches the existing eval-based atomic pattern in redis/scheduler.ts.
  await r.eval(PUSH_ALERT_LUA, 1, redisKeys.alerts(), alertJson, String(maxLen));
  return true;
}

/**
 * Atomic LPUSH + LTRIM (issue #3619). KEYS[1] = alerts list; ARGV[1] = alert
 * JSON string; ARGV[2] = maxLen. Executed atomically so a concurrent
 * reader/dismiss never observes the intermediate over-capacity list state.
 */
const PUSH_ALERT_LUA = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
return 'OK'
`;

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
