/**
 * Report Cleanup — Redis-backed
 *
 * Cycle summaries: auto-expire via Redis TTL (2 days).
 * Backlog done items: pruned by pruneOldDoneItems().
 * Stale Redis keys: cycle/task/metrics keys older than 7 days.
 * Stale inProgress items: returned to queued after 24 hours.
 *
 * This module just orchestrates the scheduled cleanup calls.
 */

import { pruneOldDoneItems } from "./backlog/lanes.ts";
import {
  pruneMetricsIndex,
  getMetricsIndexSize,
  trimMetricsIndex,
} from "./redis/cycle-metrics.ts";

// Prefix shapes used by the stale-key sweep. Kept inline (rather than
// importing from redis/keys.ts) because cleanup.ts is a housekeeping
// orchestrator, not a domain owner — these strings describe what to
// scan for, not how to use the keys.
const CYCLE_KEY_PREFIX = "hydra:cycle:";
const TASK_KEY_PREFIX = "hydra:task:";
const METRICS_KEY_PREFIX = "hydra:metrics:";
const CYCLE_ACTIVE_KEY = "hydra:cycle:active";
const CYCLE_LAST_KEY = "hydra:cycle:last";
import {
  scanKeys,
  getKeyTTL,
  getKeyType,
  hashGet,
  deleteKeysBatch,
} from "./redis/utility.ts";
import {
  getBacklogLaneWithScores,
  getBacklogItem,
  moveBacklogItem,
} from "./redis/backlog.ts";

const STALE_KEY_RETENTION_DAYS = 7;
const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const METRICS_INDEX_MAX_ENTRIES = 500;

async function pruneStaleRedisKeys() {
  const cutoffMs = Date.now() - STALE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalPruned = 0;

  // Prune old metrics from sorted index, then delete orphaned metric keys
  try {
    const removed = await pruneMetricsIndex(cutoffMs);
    if (removed > 0) {
      totalPruned += removed;
      console.log(`[Cleanup] Pruned ${removed} old metrics index entries`);
    }
    // Trim to max entries as a safety cap
    const indexSize = await getMetricsIndexSize();
    if (indexSize > METRICS_INDEX_MAX_ENTRIES) {
      const excess = indexSize - METRICS_INDEX_MAX_ENTRIES;
      await trimMetricsIndex(excess);
      console.log(`[Cleanup] Trimmed metrics index by ${excess} (cap: ${METRICS_INDEX_MAX_ENTRIES})`);
    }
  } catch (err: any) {
    console.error(`[Cleanup] Metrics index prune failed: ${err.message}`);
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
      const keys = await scanKeys(`${prefix}*`);
      const toDelete: string[] = [];

      for (const key of keys) {
        // Skip index/counter keys and active/last pointers
        if (key.endsWith(":index") || key.endsWith(":counter") || key === CYCLE_ACTIVE_KEY || key === CYCLE_LAST_KEY) continue;
        const ttl = await getKeyTTL(key);
        if (ttl !== -1) continue; // Already has TTL, skip

        let keyTime: number | null = null;

        // Try hash timestamp fields first (original logic)
        const type = await getKeyType(key);
        if (type === "hash") {
          const ts = await hashGet(key, "startedAt") || await hashGet(key, "createdAt") || await hashGet(key, "timestamp");
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
        await deleteKeysBatch(toDelete);
        totalPruned += toDelete.length;
        console.log(`[Cleanup] Pruned ${toDelete.length} stale ${prefix}* keys`);
      }
    } catch (err: any) {
      console.error(`[Cleanup] ${prefix}* prune failed: ${err.message}`);
    }
  }

  if (totalPruned > 0) {
    console.log(`[Cleanup] Total stale Redis keys pruned: ${totalPruned}`);
  }
}

async function returnStaleInProgressItems() {
  try {
    const ids = await getBacklogLaneWithScores("inProgress");
    const now = Date.now();
    let returned = 0;

    // ids is [id1, score1, id2, score2, ...]
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i];
      const score = Number(ids[i + 1]);
      if (now - score > STALE_IN_PROGRESS_MS) {
        const raw = await getBacklogItem(id);
        if (!raw) continue;
        const item = JSON.parse(raw);
        item.lane = "queued";
        item.meta = { ...item.meta, returnedReason: "stale_in_progress", returnedAt: new Date().toISOString() };
        await moveBacklogItem(id, JSON.stringify(item), "inProgress", "queued");
        returned++;
        console.log(`[Cleanup] Returned stale inProgress item ${id} ("${item.title?.slice(0, 60)}") to queued`);
      }
    }

    if (returned > 0) {
      console.log(`[Cleanup] Returned ${returned} stale inProgress items to queued`);
    }
  } catch (err: any) {
    console.error(`[Cleanup] Stale inProgress check failed: ${err.message}`);
  }
}

async function runCleanup() {
  try {
    await pruneOldDoneItems();
  } catch (err: any) {
    console.error(`[Cleanup] Backlog prune failed: ${err.message}`);
  }
  await pruneStaleRedisKeys();
  await returnStaleInProgressItems();
}

// Issue #866: capture the daily-prune interval handle so it can be cleared on
// a clean shutdown. Nullable module-level let, mirroring indexerInterval in
// knowledge-indexer.ts.
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanupSchedule() {
  // Run immediately on startup
  runCleanup();

  // Then daily
  cleanupInterval = setInterval(() => {
    runCleanup();
  }, 24 * 60 * 60 * 1000);
  console.log("[Cleanup] Scheduled (daily): backlog prune, stale Redis/inProgress cleanup");
}

// Issue #866: clear the daily-prune interval so it does not survive a clean
// shutdown. Idempotent via null-guard — a double-call is a safe no-op.
function stopCleanupSchedule() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export { startCleanupSchedule, stopCleanupSchedule, runCleanup };
