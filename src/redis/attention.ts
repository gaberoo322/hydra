/**
 * Attention-feed Redis ops (issue #4007, ADR-0034 §4; per-line calibration
 * ledger issue #4627, ADR-0034 §8.4).
 *
 * Owns ALL episode-ledger and calibration-counter access for the attention
 * feed. No other module touches these keys — the typed-accessor convention
 * (ADR-0009 / CLAUDE.md "Redis Adapters"), enforced by
 * `scripts/ci/redis-seam-check.ts`.
 *
 * Key families (see `redisKeys` attention section):
 *
 *   - `hydra:attention:surfaced:<bucket>:<line>` — hash {itemId → firstSeenAt}.
 *   - `hydra:attention:dismissed:<bucket>:<line>` — hash {itemId → dismissedAt}.
 *     The pair is the per-line EPISODE ledger of §8.4: the episode is the
 *     (line key, item id) pair — literally this hash address. The composer
 *     reconciles both on every feed read (`reconcileLedgers`): record new
 *     ids as surfaced (once per episode), and — only when the line's source
 *     fetched OK — delete ids the compose no longer admits.
 *   - `hydra:attention:calib:<YYYY-MM-DD>` — daily counter hash, fields
 *     `<key>:surfaced | :not-a-problem | :handled-elsewhere | :later |
 *     :resolved`, TTL 35 d stamped on every write. The rolling 30-day
 *     verdict folds these (pure logic in src/attention-calibration.ts).
 *   - `hydra:attention:dismissals` — capped audit stream (last ~500 events)
 *     of `{id, key, reason, at}`.
 *
 * The old per-signal INT counters and signal-keyed hashes were RETIRED with
 * this slice (#4444 decision 1: reset, not migrate) — the live keys are
 * inert orphans listed in the PR body for a one-time operator DEL.
 *
 * Counter updates run inside single Lua scripts (`HSETNX` + conditional
 * `HINCRBY`/`XADD`) so the ledger write and the counter increment are atomic
 * — the same eval-based pattern as `redis/alerts.ts` (#3619). Without it,
 * two concurrent feed reads (or a dismiss racing itself) could both see
 * "new" and double-count a single line-crossing.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";
import type { AttentionDismissReason } from "../schemas/attention.ts";
import { ADMISSION_LINE_KEYS } from "../schemas/operator-actions.ts";
import {
  CALIBRATION_TTL_SECONDS,
  calibrationDayDate,
  calibrationDayDates,
  calibrationRows,
  type CalibrationLineRow,
  type DailyCalibrationHash,
} from "../attention-calibration.ts";

/**
 * How long a dismissal suppresses an item: a "don't nag again for a month"
 * snooze, NOT permanent suppression — a genuinely still-crossing item
 * resurfaces after this window (design-concept #4007). Read-side filter on
 * the dismissed hash; it caps ONE continuous episode and nothing else
 * (ADR-0034 §8.4).
 */
const DISMISSAL_SNOOZE_DAYS = 30;
const DISMISSAL_SNOOZE_MS = DISMISSAL_SNOOZE_DAYS * 24 * 60 * 60 * 1000;

/** Audit-stream cap (ADR-0034 §8.4: "last 500" dismiss events). */
const DISMISSALS_STREAM_MAXLEN = 500;

/**
 * What the composer hands `reconcileLedgers` per admission line. `admitted`
 * is the PRE-dismissal-filter id set (a dismissed item is still crossing,
 * just hidden); `healthy` is the line's bucket evidence (the only per-source
 * signal the composer has) — absence from an unhealthy source proves
 * nothing, so its ledgers are not pruned.
 */
export interface AdmittedLine {
  admitted: ReadonlySet<string>;
  healthy: boolean;
}

/**
 * Per-line episode reconcile, atomically. KEYS[1] = surfaced hash,
 * KEYS[2] = dismissed hash, KEYS[3] = calib day hash. ARGV[1] = ISO now,
 * ARGV[2] = calib TTL seconds, ARGV[3] = "<key>:surfaced" field,
 * ARGV[4] = "<key>:resolved" field, ARGV[5] = healthy ("1"/"0"),
 * ARGV[6..] = admitted item ids.
 *
 * 1. Record-once surfaced (unconditional): HSETNX per admitted id; iff new,
 *    HINCRBY `<key>:surfaced` on today's hash. The dashboard's 30s poll
 *    cannot inflate the count; a snooze expiry resurfacing a still-crossing
 *    item is the same episode and does not recount it.
 * 2. Prune on absence from a HEALTHY source only (§8.4): every id in either
 *    hash that is not admitted is HDEL'd from BOTH — so the next crossing of
 *    the same subject is a new episode that resurfaces and recounts. An id
 *    that was surfaced but never dismissed increments `<key>:resolved`.
 */
const RECONCILE_LINE_LUA = `
local admitted = {}
for i = 6, #ARGV do admitted[ARGV[i]] = true end
local surfaced = 0
for i = 6, #ARGV do
  if redis.call('HSETNX', KEYS[1], ARGV[i], ARGV[1]) == 1 then
    redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
    surfaced = surfaced + 1
  end
end
local resolved = 0
if ARGV[5] == '1' then
  local surfacedAll = redis.call('HKEYS', KEYS[1])
  local dismissedAll = redis.call('HKEYS', KEYS[2])
  local dismissedSet = {}
  for _, id in ipairs(dismissedAll) do dismissedSet[id] = true end
  local delS = {}
  local delD = {}
  for _, id in ipairs(surfacedAll) do
    if not admitted[id] then
      table.insert(delS, id)
      if not dismissedSet[id] then resolved = resolved + 1 end
    end
  end
  for _, id in ipairs(dismissedAll) do
    if not admitted[id] then table.insert(delD, id) end
  end
  for i = 1, #delS, 100 do
    redis.call('HDEL', KEYS[1], unpack(delS, i, math.min(i + 99, #delS)))
  end
  for i = 1, #delD, 100 do
    redis.call('HDEL', KEYS[2], unpack(delD, i, math.min(i + 99, #delD)))
  end
  if resolved > 0 then
    redis.call('HINCRBY', KEYS[3], ARGV[4], resolved)
  end
end
if surfaced > 0 or resolved > 0 then
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))
end
return surfaced
`;

/**
 * Typed dismiss, atomically. KEYS[1] = dismissed hash, KEYS[2] = calib day
 * hash, KEYS[3] = dismissals stream, KEYS[4] = surfaced hash. ARGV[1] = item
 * id, ARGV[2] = ISO at, ARGV[3] = "<key>:<reason>" field, ARGV[4] = TTL
 * seconds, ARGV[5] = line key, ARGV[6] = reason, ARGV[7] = stream MAXLEN,
 * ARGV[8] = ISO snooze cutoff (at - snooze window).
 *
 * - Guard: the id must be in the line's surfaced hash (a live episode of THIS
 *   line); otherwise nothing is written and 0 is returned, so a forged or
 *   stale key cannot falsify a line's not-a-problem count.
 * - First dismissal of the episode: HSETNX, HINCRBY `<key>:<reason>`, EXPIRE,
 *   XADD the audit stream; returns 1.
 * - Repeat dismissal: never counted again. If the prior snooze has lapsed
 *   (stored stamp < cutoff) the stamp is refreshed so the re-dismiss re-snoozes
 *   the SAME episode without recounting it (the dismissed field is only pruned
 *   when the episode clears, in RECONCILE_LINE_LUA); returns 0.
 */
const DISMISS_EPISODE_LUA = `
if redis.call('HEXISTS', KEYS[4], ARGV[1]) == 0 then return 0 end
local wasNew = redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
if wasNew == 1 then
  redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', tonumber(ARGV[7]), '*',
    'id', ARGV[1], 'key', ARGV[5], 'reason', ARGV[6], 'at', ARGV[2])
  return 1
end
local prior = redis.call('HGET', KEYS[1], ARGV[1])
if prior and prior < ARGV[8] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
end
return 0
`;

/**
 * Reconcile the per-line episode ledgers for one compose. Runs BEFORE the
 * dismissed-ledger read on every feed read, so a pruned dismissal can never
 * hide the new episode of a re-crossing (§8.4). One eval per line; feed
 * sizes are dozens, and lines with nothing admitted and an unhealthy source
 * are skipped outright (there is nothing to record and no prune allowed).
 */
export async function reconcileLedgers(
  admittedByLine: ReadonlyMap<string, AdmittedLine>,
  now: Date = new Date(),
): Promise<void> {
  const r = getRedisConnection();
  const dayHash = redisKeys.attentionCalibrationDay(calibrationDayDate(now));
  const nowIso = now.toISOString();
  for (const [key, line] of admittedByLine) {
    const ids = [...line.admitted];
    if (ids.length === 0 && !line.healthy) continue;
    await r.eval(
      RECONCILE_LINE_LUA,
      3,
      redisKeys.attentionSurfaced(key),
      redisKeys.attentionDismissed(key),
      dayHash,
      nowIso,
      String(CALIBRATION_TTL_SECONDS),
      `${key}:surfaced`,
      `${key}:resolved`,
      line.healthy ? "1" : "0",
      ...ids,
    );
  }
}

/**
 * Suppressed episode ids per admission line, for every registry line (a
 * clean line reads as an empty set). A dismissal older than the 30-day
 * snooze window no longer suppresses, but its hash field is deliberately NOT
 * pruned here: it is the episode tombstone that keeps a re-dismissal of the
 * same still-continuous episode from recounting not-a-problem. It is removed
 * only when the episode clears (RECONCILE_LINE_LUA). A failed per-line
 * read degrades to "no suppressions" for that line (fail-open) and logs.
 */
export async function loadDismissed(
  now: Date = new Date(),
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const r = getRedisConnection();
  const pipeline = r.pipeline();
  for (const key of ADMISSION_LINE_KEYS) {
    pipeline.hgetall(redisKeys.attentionDismissed(key));
  }
  const replies = (await pipeline.exec()) ?? [];
  const active = new Map<string, Set<string>>();
  const nowMs = now.getTime();
  ADMISSION_LINE_KEYS.forEach((key, i) => {
    const ids = new Set<string>();
    active.set(key, ids);
    const [err, ledger] = replies[i] as [unknown, Record<string, string> | null];
    if (err || !ledger) {
      logger.error(
        { err: err ?? null, key },
        "[redis/attention] dismissed-ledger read failed — line reads as unsuppressed",
      );
      return;
    }
    for (const [id, dismissedAt] of Object.entries(ledger)) {
      const atMs = Date.parse(dismissedAt);
      if (Number.isFinite(atMs) && nowMs - atMs < DISMISSAL_SNOOZE_MS) {
        ids.add(id);
      }
    }
  });
  return active;
}

/**
 * Dismiss one episode durably with a typed reason. Records `{id → now}` in
 * the line's dismissed ledger, increments `<key>:<reason>` on today's daily
 * hash and appends to the audit stream — all atomically. Returns `true` iff
 * this call was the FIRST dismissal of this episode; a repeat dismissal is a
 * no-op that does not double-count the line or the stream.
 */
export async function dismissAttentionItem(
  id: string,
  key: string,
  reason: AttentionDismissReason,
  now: Date = new Date(),
): Promise<boolean> {
  const r = getRedisConnection();
  const at = now.toISOString();
  const wasNew = await r.eval(
    DISMISS_EPISODE_LUA,
    4,
    redisKeys.attentionDismissed(key),
    redisKeys.attentionCalibrationDay(calibrationDayDate(now)),
    redisKeys.attentionDismissals(),
    redisKeys.attentionSurfaced(key),
    id,
    at,
    `${key}:${reason}`,
    String(CALIBRATION_TTL_SECONDS),
    key,
    reason,
    String(DISMISSALS_STREAM_MAXLEN),
    new Date(now.getTime() - DISMISSAL_SNOOZE_MS).toISOString(),
  );
  return wasNew === 1;
}

/**
 * The rolling per-line calibration read: one pipelined sweep of the window's
 * 30 daily hashes, folded (pure, src/attention-calibration.ts) into one row
 * per registry line in ADMISSION_LINE_KEYS order — zeros asserted for
 * never-written lines. A missing day reads as zeros; a failed day read
 * degrades to zeros for that day and logs.
 */
export async function readCalibrationLines(
  now: Date = new Date(),
): Promise<CalibrationLineRow[]> {
  const r = getRedisConnection();
  const dates = calibrationDayDates(now);
  const pipeline = r.pipeline();
  for (const date of dates) {
    pipeline.hgetall(redisKeys.attentionCalibrationDay(date));
  }
  const replies = (await pipeline.exec()) ?? [];
  const hashes: DailyCalibrationHash[] = dates.map((date, i) => {
    const [err, hash] = replies[i] as [unknown, Record<string, string> | null];
    if (err || !hash) {
      logger.error(
        { err: err ?? null, date },
        "[redis/attention] calibration day read failed — day reads as zeros",
      );
      return {};
    }
    return hash;
  });
  return calibrationRows(hashes);
}
