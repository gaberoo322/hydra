/**
 * Attention-feed Redis ops (issue #4007, ADR-0034 §4).
 *
 * Owns ALL dismissal-state and calibration-counter access for the attention
 * feed. No other module touches these keys — the typed-accessor convention
 * (ADR-0009 / CLAUDE.md "Redis Adapters"), enforced by
 * `scripts/ci/redis-seam-check.ts`.
 *
 * Key families (see `redisKeys` attention section):
 *
 *   - `hydra:attention:dismissed:{signal}`    — hash {itemId → dismissedAt}.
 *     Durable per-item dismissal. Feed reads filter members younger than the
 *     30-day snooze window and lazily HDEL the expired ones, so the "don't
 *     nag again for a month" semantics live on the read side (a Redis hash
 *     cannot TTL individual members) while a still-crossing item can
 *     legitimately resurface later.
 *   - `hydra:attention:surfaced:{signal}`     — hash {itemId → firstSeenAt}.
 *     The once-per-item dedup behind the surfaced counter, so the dashboard's
 *     30s poll cadence cannot inflate the calibration count.
 *   - `hydra:attention:counts:{signal}:surfaced` / `:dismissed` — INT counters
 *     keyed per THRESHOLD (signal), not per item: the calibration signal is
 *     about the line, not the item (ADR-0034 §4's falsifiability rule — a
 *     line whose items are always dismissed unread is miscalibrated and says
 *     so in the data).
 *
 * Counter updates run inside a single Lua script (`HSETNX` + conditional
 * `INCRBY`) so the ledger write and the counter increment are atomic — the
 * same eval-based pattern as `redis/alerts.ts` (#3619). Without it, two
 * concurrent feed reads (or a dismiss racing itself) could both see "new" and
 * double-count a single line-crossing.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";
import type {
  AttentionFeedItem,
  AttentionSignal,
  AttentionThresholdCount,
} from "../schemas/attention.ts";

/** The three feed signals, as the counters are keyed. */
const ATTENTION_SIGNALS: readonly AttentionSignal[] = [
  "blocked-on-human",
  "breakage",
  "repetition",
];

/**
 * How long a dismissal suppresses an item: a "don't nag again for a month"
 * snooze, NOT permanent suppression (design-concept #4007) — a genuinely
 * still-crossing item resurfaces after this window.
 */
const DISMISSAL_SNOOZE_DAYS = 30;
const DISMISSAL_SNOOZE_MS = DISMISSAL_SNOOZE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Atomic record-once: HSETNX the ledger hash; if (and only if) the field was
 * NEW, increment the paired counter. KEYS[1] = ledger hash, KEYS[2] = counter,
 * ARGV[1] = item id, ARGV[2] = ISO timestamp.
 */
const RECORD_ONCE_LUA = `
local wasNew = redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
if wasNew == 1 then
  redis.call('INCRBY', KEYS[2], 1)
end
return wasNew
`;

/**
 * Ids currently suppressed for `signal`. A dismissal older than the 30-day
 * snooze window no longer suppresses; its hash field is lazily pruned here so
 * the ledger self-cleans without a housekeeping job. Never throws upward
 * beyond Redis transport errors (callers treat those as fail-loud).
 */
export async function loadDismissedIds(signal: AttentionSignal): Promise<string[]> {
  const r = getRedisConnection();
  const key = redisKeys.attentionDismissed(signal);
  const ledger = await r.hgetall(key);
  const nowMs = Date.now();
  const active: string[] = [];
  const expired: string[] = [];
  for (const [id, dismissedAt] of Object.entries(ledger)) {
    const atMs = Date.parse(dismissedAt);
    if (Number.isFinite(atMs) && nowMs - atMs < DISMISSAL_SNOOZE_MS) {
      active.push(id);
    } else {
      expired.push(id);
    }
  }
  if (expired.length > 0) {
    // Lazy prune — the snooze expired, so the field is dead weight.
    await r.hdel(key, ...expired);
  }
  return active;
}

/**
 * Dismiss one item durably. Records `{id → now}` in the per-signal dismissed
 * ledger and increments the per-threshold dismissed counter atomically.
 * Returns `true` iff this call was the FIRST dismissal of this item id — a
 * repeat dismissal is a no-op that does not double-count the line.
 */
export async function dismissAttentionItem(
  id: string,
  signal: AttentionSignal,
): Promise<boolean> {
  const r = getRedisConnection();
  const wasNew = await r.eval(
    RECORD_ONCE_LUA,
    2,
    redisKeys.attentionDismissed(signal),
    redisKeys.attentionCountDismissed(signal),
    id,
    new Date().toISOString(),
  );
  return wasNew === 1;
}

/**
 * Count `items` against their line's surfaced counter, once per item id (the
 * surfaced ledger dedupes). Grouped by signal so each line gets ONE eval per
 * batch. Calibration is best-effort by design: callers degrade a counter
 * failure to a log line, never a failed feed read.
 */
export async function recordSurfacedItems(items: readonly AttentionFeedItem[]): Promise<void> {
  if (items.length === 0) return;
  const bySignal = new Map<AttentionSignal, string[]>();
  for (const item of items) {
    const ids = bySignal.get(item.signal) ?? [];
    ids.push(item.id);
    bySignal.set(item.signal, ids);
  }
  const r = getRedisConnection();
  const now = new Date().toISOString();
  for (const [signal, ids] of bySignal) {
    // One eval per id: the atomic HSETNX+INCR pair must see each field
    // individually, and feed sizes are dozens, not thousands.
    for (const id of ids) {
      await r.eval(
        RECORD_ONCE_LUA,
        2,
        redisKeys.attentionSurfaced(signal),
        redisKeys.attentionCountSurfaced(signal),
        id,
        now,
      );
    }
  }
}

/**
 * The per-threshold calibration read: `{surfaced, dismissed}` per signal.
 * Counters are plain INT strings (0 when never written — a fresh install
 * reads as three honest zeros, matching the ATTENTION_SIGNALS order).
 */
export async function readAttentionCounts(): Promise<AttentionThresholdCount[]> {
  const r = getRedisConnection();
  const out: AttentionThresholdCount[] = [];
  for (const signal of ATTENTION_SIGNALS) {
    const [surfaced, dismissed] = await Promise.all([
      r.get(redisKeys.attentionCountSurfaced(signal)),
      r.get(redisKeys.attentionCountDismissed(signal)),
    ]);
    out.push({
      signal,
      surfaced: surfaced === null ? 0 : Number.parseInt(surfaced, 10) || 0,
      dismissed: dismissed === null ? 0 : Number.parseInt(dismissed, 10) || 0,
    });
  }
  return out;
}

