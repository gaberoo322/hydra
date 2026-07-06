/**
 * Stale-Redis-key sweep chore (issue #1876).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 *
 * Folded out of the cleanup.ts module-level 24h `setInterval` into a
 * housekeeping chore (#1876) so all periodic maintenance lives behind the one
 * idempotent `POST /api/maintenance/housekeeping` Seam. The work body is
 * unchanged from cleanup.ts; only the dispatch path moved. `pruneStaleRedisKeys`
 * gets a daily Redis time-guard (`getCleanupLastDaily`/`setCleanupLastDaily`,
 * applied by `runHousekeeping` at the composition level) because housekeeping
 * runs hourly.
 */

import {
  pruneMetricsIndex,
  getMetricsIndexSize,
  trimMetricsIndex,
} from "../../redis/cycle-metrics.ts";
import {
  scanKeys,
  getKeyTTL,
  getKeyType,
  hashGet,
  deleteKeysBatch,
} from "../../redis/utility.ts";
import { setCleanupLastDaily } from "../../redis/housekeeping.ts";

// Prefix shapes used by the stale-key sweep. Kept inline (rather than importing
// from redis/keys.ts) because this is a housekeeping sweep, not a domain owner —
// these strings describe what to scan for, not how to use the keys.
const CYCLE_KEY_PREFIX = "hydra:cycle:";
const TASK_KEY_PREFIX = "hydra:task:";
const METRICS_KEY_PREFIX = "hydra:metrics:";
const CYCLE_ACTIVE_KEY = "hydra:cycle:active";
const CYCLE_LAST_KEY = "hydra:cycle:last";

/**
 * Legacy bare metrics list key (issue #2927). A fossil of an earlier metrics
 * implementation with no active writer or reader — the live metrics plane is
 * `hydra:metrics:index` (a zset) + `hydra:metrics:<cycleId>` (hashes). The bare
 * key has no trailing colon, so the `hydra:metrics:*` scan below never matches
 * it and it accumulates forever with no TTL, tripping false-positive discover
 * alerts. Deleted by a dedicated existence-guarded branch that only fires when
 * the key is genuinely the legacy `list` type (never the live index/hashes).
 */
const LEGACY_METRICS_LIST_KEY = "hydra:metrics";

const STALE_KEY_RETENTION_DAYS = 7;
const METRICS_INDEX_MAX_ENTRIES = 500;

/** External touchpoints of the stale-Redis-key sweep chore. */
export interface PruneStaleRedisKeysDeps {
  pruneMetricsIndex?: typeof pruneMetricsIndex;
  getMetricsIndexSize?: typeof getMetricsIndexSize;
  trimMetricsIndex?: typeof trimMetricsIndex;
  scanKeys?: typeof scanKeys;
  getKeyTTL?: typeof getKeyTTL;
  getKeyType?: typeof getKeyType;
  hashGet?: typeof hashGet;
  deleteKeysBatch?: typeof deleteKeysBatch;
  now?: () => number;
  /**
   * Stamps the daily cadence guard key on success. Injectable for unit tests.
   *
   * Issue #2461: moved from the composition level in `housekeeping.ts` into
   * this chore so stamp placement is consistent across all guarded chores —
   * the chore that does the work also owns its own success stamp.
   */
  setLastDaily?: typeof setCleanupLastDaily;
}

/**
 * Prune stale cycle/task/metrics Redis keys older than 7 days with no TTL.
 * The same body that ran on the cleanup.ts timer; deps are injectable so it is
 * exercisable without standing up real Redis.
 */
export async function pruneStaleRedisKeys(deps: PruneStaleRedisKeysDeps = {}): Promise<void> {
  const pruneMetricsIndexFn = deps.pruneMetricsIndex ?? pruneMetricsIndex;
  const getMetricsIndexSizeFn = deps.getMetricsIndexSize ?? getMetricsIndexSize;
  const trimMetricsIndexFn = deps.trimMetricsIndex ?? trimMetricsIndex;
  const scanKeysFn = deps.scanKeys ?? scanKeys;
  const getKeyTTLFn = deps.getKeyTTL ?? getKeyTTL;
  const getKeyTypeFn = deps.getKeyType ?? getKeyType;
  const hashGetFn = deps.hashGet ?? hashGet;
  const deleteKeysBatchFn = deps.deleteKeysBatch ?? deleteKeysBatch;
  const nowFn = deps.now ?? Date.now;
  const setLastDailyFn = deps.setLastDaily ?? setCleanupLastDaily;

  const cutoffMs = nowFn() - STALE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalPruned = 0;

  // Prune old metrics from sorted index, then delete orphaned metric keys
  try {
    const removed = await pruneMetricsIndexFn(cutoffMs);
    if (removed > 0) {
      totalPruned += removed;
      console.log(`[Housekeeping] Pruned ${removed} old metrics index entries`);
    }
    // Trim to max entries as a safety cap
    const indexSize = await getMetricsIndexSizeFn();
    if (indexSize > METRICS_INDEX_MAX_ENTRIES) {
      const excess = indexSize - METRICS_INDEX_MAX_ENTRIES;
      await trimMetricsIndexFn(excess);
      console.log(`[Housekeeping] Trimmed metrics index by ${excess} (cap: ${METRICS_INDEX_MAX_ENTRIES})`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Metrics index prune failed: ${err.message}`);
  }

  // Prune old cycle/task/metrics keys by scanning and checking timestamps.
  // Keys come in two forms:
  //   1. Parent hashes (hydra:cycle:cycle-2026-04-03-1447) — have startedAt field
  //   2. Sub-keys (hydra:cycle:cycle-2026-04-03-1447:tasks, :agents, :costs) — set/list/hash without timestamp
  //   3. Task evidence (hydra:task:task-cycle-2026-04-03-1447-1:evidence:merged) — string type
  // For non-hash keys and hashes without a timestamp field, extract the date from
  // the key name pattern (YYYY-MM-DD) and use that as the age indicator.
  const dateInKeyPattern = /(\d{4}-\d{2}-\d{2})/;
  for (const prefix of [CYCLE_KEY_PREFIX, TASK_KEY_PREFIX, METRICS_KEY_PREFIX]) {
    try {
      const keys = await scanKeysFn(`${prefix}*`);
      const toDelete: string[] = [];

      for (const key of keys) {
        // Skip index/counter keys and active/last pointers
        if (key.endsWith(":index") || key.endsWith(":counter") || key === CYCLE_ACTIVE_KEY || key === CYCLE_LAST_KEY) continue;
        const ttl = await getKeyTTLFn(key);
        if (ttl !== -1) continue; // Already has TTL, skip

        let keyTime: number | null = null;

        // Try hash timestamp fields first (original logic)
        const type = await getKeyTypeFn(key);
        if (type === "hash") {
          const ts = await hashGetFn(key, "startedAt") || await hashGetFn(key, "createdAt") || await hashGetFn(key, "timestamp");
          if (ts) {
            const parsed = new Date(ts).getTime();
            if (Number.isFinite(parsed)) keyTime = parsed;
          }
        }

        // Fallback: extract date from key name (handles sub-keys, strings, sets, lists)
        if (keyTime === null) {
          const match = key.match(dateInKeyPattern);
          if (match) {
            const parsed = new Date(match[1] + "T00:00:00Z").getTime();
            if (Number.isFinite(parsed)) keyTime = parsed;
          }
        }

        if (keyTime !== null && keyTime < cutoffMs) {
          toDelete.push(key);
        }
      }

      if (toDelete.length > 0) {
        await deleteKeysBatchFn(toDelete);
        totalPruned += toDelete.length;
        console.log(`[Housekeeping] Pruned ${toDelete.length} stale ${prefix}* keys`);
      }
    } catch (err: any) {
      console.error(`[Housekeeping] ${prefix}* prune failed: ${err.message}`);
    }
  }

  // Issue #2927: one-time targeted removal of the legacy bare `hydra:metrics`
  // list key. The `hydra:metrics:*` scan above never matches it (no trailing
  // colon), so it is invisible to the age-based sweep and accumulates with no
  // TTL, tripping false-positive discover alerts. Guard on the Redis type being
  // exactly "list" so the live metrics plane is untouchable:
  //   - `hydra:metrics:index` is a zset  → type "zset"  → skipped
  //   - `hydra:metrics:<cycleId>` are hashes → type "hash" → skipped
  //   - the fossil is a "list" → deleted
  //   - an already-absent fossil → type "none" → no-op (idempotent).
  try {
    const legacyType = await getKeyTypeFn(LEGACY_METRICS_LIST_KEY);
    if (legacyType === "list") {
      await deleteKeysBatchFn([LEGACY_METRICS_LIST_KEY]);
      totalPruned += 1;
      console.log(`[Housekeeping] Removed legacy metrics list key ${LEGACY_METRICS_LIST_KEY} (issue #2927)`);
    }
  } catch (err: any) {
    console.error(`[Housekeeping] Legacy metrics list prune failed: ${err.message}`);
  }

  if (totalPruned > 0) {
    console.log(`[Housekeeping] Total stale Redis keys pruned: ${totalPruned}`);
  }
  // Stamp the daily guard key so an immediate second housekeeping invocation
  // skips this chore. Consistent with `runWeeklyDigest`, `runMemoryConsolidation`,
  // and `runUsageWeeklySnapshot`, which all own their own stamp.
  // Issue #2461: this stamp was previously applied in `housekeeping.ts` after
  // calling `pruneStaleRedisKeys()` — moved here so all guarded chores follow
  // the same pattern: the chore that does the work stamps its own guard key.
  await setLastDailyFn(Date.now().toString());
}
