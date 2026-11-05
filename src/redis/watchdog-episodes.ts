/**
 * Watchdog episode-tracker Redis seam (issue #5097, epic #5094).
 *
 * The watchdog's streak/dedup rule ("anchor the first qualifying tick, fire
 * once at the threshold, clear on recovery") is written ONCE in
 * `src/watchdog/episode.ts` over a `{since, fired}` key pair. This module is
 * the Redis side of that port: signal-agnostic accessors over whatever key
 * pair a `src/redis/` builder hands in (launch-flow today; the brief-missing
 * block and slice 4 reuse it without edits).
 *
 * Every accessor THROWS on a Redis failure: the tracker turns a thrown read
 * into "skip this signal, mutate nothing", and logs a thrown write and
 * continues (the bash `rc_write ... || true` discipline).
 */

import { getRedisConnection } from "./connection.ts";

export interface EpisodeKeyPair {
  since: string;
  fired: string;
}

/** `SET since <ms> NX` — locks the anchor on the first qualifying tick, no-op after. */
export async function anchorEpisodeSince(keys: EpisodeKeyPair, nowMs: number): Promise<void> {
  await getRedisConnection().set(keys.since, String(nowMs), "NX");
}

/** The anchored epoch-ms, or `null` when absent / non-numeric. */
export async function readEpisodeSince(keys: EpisodeKeyPair): Promise<number | null> {
  const raw = await getRedisConnection().get(keys.since);
  if (raw === null) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  return /^[0-9]+$/.test(digits) ? Number(digits) : null;
}

/** Whether the fired marker for the current episode exists. */
export async function episodeFiredExists(keys: EpisodeKeyPair): Promise<boolean> {
  return (await getRedisConnection().exists(keys.fired)) === 1;
}

/** Set the fired marker (value is unimportant; presence is the signal). */
export async function markEpisodeFired(keys: EpisodeKeyPair): Promise<void> {
  await getRedisConnection().set(keys.fired, "1");
}

/** DEL both keys (idempotent stateless recovery). */
export async function clearEpisodeKeys(keys: EpisodeKeyPair): Promise<void> {
  await getRedisConnection().del(keys.since, keys.fired);
}

/** Key-template prefix of the Redis-backup freshness episode (issue #5098; the bash block held the same literal). */
export const REDIS_BACKUP_KEY_PREFIX = "hydra:autopilot:redis-backup-freshness";

/** The `{since, fired}` pair for the Redis-backup staleness episode. */
export function redisBackupEpisodeKeys(): EpisodeKeyPair {
  return { since: `${REDIS_BACKUP_KEY_PREFIX}:since`, fired: `${REDIS_BACKUP_KEY_PREFIX}:fired` };
}

/** Key-template prefix of the Morning-Brief-missing episode (issue #5048; unchanged by the #5099 port so a deploy mid-episode neither re-pages nor loses the cold-start anchor). */
export const BRIEF_MISSING_KEY_PREFIX = "hydra:autopilot:brief-missing";

/** The pair for the brief-missing block: `since` is the cold-start `absent-since` anchor. */
export function briefMissingEpisodeKeys(): EpisodeKeyPair {
  return { since: `${BRIEF_MISSING_KEY_PREFIX}:absent-since`, fired: `${BRIEF_MISSING_KEY_PREFIX}:fired` };
}

/** Whether the `since` anchor key exists (brief-missing gates its DEL on this so a healthy tick writes nothing). */
export async function episodeSinceExists(keys: EpisodeKeyPair): Promise<boolean> {
  return (await getRedisConnection().exists(keys.since)) === 1;
}

/** DEL only the `since` anchor. */
export async function clearEpisodeSince(keys: EpisodeKeyPair): Promise<void> {
  await getRedisConnection().del(keys.since);
}

/** DEL only the fired marker. */
export async function clearEpisodeFired(keys: EpisodeKeyPair): Promise<void> {
  await getRedisConnection().del(keys.fired);
}
