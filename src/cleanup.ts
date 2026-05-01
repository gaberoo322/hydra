/**
 * Report Cleanup — Redis-backed
 *
 * Reality reports: trimmed to 50 most recent inline during writes.
 * Cycle summaries: auto-expire via Redis TTL (2 days).
 * Proposals: old approved/rejected cleaned by archiveApprovedProposals().
 * Backlog done items: pruned by pruneOldDoneItems().
 * Stale Redis keys: cycle/task/metrics keys older than 7 days.
 * Stale inProgress items: returned to queued after 24 hours.
 *
 * This module just orchestrates the scheduled cleanup calls.
 */

import { archiveApprovedProposals } from "./proposals.ts";
import { pruneOldDoneItems } from "./backlog.ts";
import { getTracker } from "./task-tracker.ts";
import { redisKeys } from "./redis-keys.ts";

const STALE_KEY_RETENTION_DAYS = 7;
const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const METRICS_INDEX_MAX_ENTRIES = 500;

async function pruneStaleRedisKeys() {
  const redis = getTracker().redis;
  const cutoffMs = Date.now() - STALE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let totalPruned = 0;

  // Prune old metrics from sorted index, then delete orphaned metric keys
  try {
    const removed = await redis.zremrangebyscore(redisKeys.metricsIndex(), "-inf", cutoffMs);
    if (removed > 0) {
      totalPruned += removed;
      console.log(`[Cleanup] Pruned ${removed} old metrics index entries`);
    }
    // Trim to max entries as a safety cap
    const indexSize = await redis.zcard(redisKeys.metricsIndex());
    if (indexSize > METRICS_INDEX_MAX_ENTRIES) {
      const excess = indexSize - METRICS_INDEX_MAX_ENTRIES;
      await redis.zremrangebyrank(redisKeys.metricsIndex(), 0, excess - 1);
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
  for (const prefix of [redisKeys.cycle(""), redisKeys.task(""), redisKeys.metrics("")]) {
    try {
      let cursor = "0";
      const toDelete: string[] = [];
      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
        cursor = nextCursor;
        for (const key of keys) {
          // Skip index/counter keys and active/last pointers
          if (key.endsWith(":index") || key.endsWith(":counter") || key === redisKeys.cycleActive() || key === redisKeys.cycleLast()) continue;
          const ttl = await redis.ttl(key);
          if (ttl !== -1) continue; // Already has TTL, skip

          let keyTime: number | null = null;

          // Try hash timestamp fields first (original logic)
          const type = await redis.type(key);
          if (type === "hash") {
            const ts = await redis.hget(key, "startedAt") || await redis.hget(key, "createdAt") || await redis.hget(key, "timestamp");
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
      } while (cursor !== "0");
      if (toDelete.length > 0) {
        // Delete in batches of 500 to avoid huge DEL commands
        for (let i = 0; i < toDelete.length; i += 500) {
          const batch = toDelete.slice(i, i + 500);
          await redis.del(...batch);
        }
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
    const redis = getTracker().redis;
    const ids = await redis.zrange(redisKeys.backlogLane("inProgress"), 0, -1, "WITHSCORES");
    const now = Date.now();
    let returned = 0;

    // ids is [id1, score1, id2, score2, ...]
    for (let i = 0; i < ids.length; i += 2) {
      const id = ids[i];
      const score = Number(ids[i + 1]);
      if (now - score > STALE_IN_PROGRESS_MS) {
        const raw = await redis.hget(redisKeys.backlogItems(), id);
        if (!raw) continue;
        const item = JSON.parse(raw);
        item.lane = "queued";
        item.meta = { ...item.meta, returnedReason: "stale_in_progress", returnedAt: new Date().toISOString() };
        await redis.hset(redisKeys.backlogItems(), id, JSON.stringify(item));
        await redis.zrem(redisKeys.backlogLane("inProgress"), id);
        await redis.zadd(redisKeys.backlogLane("queued"), now, id);
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

function startCleanupSchedule() {
  // Run immediately on startup
  runCleanup();
  archiveApprovedProposals();

  // Then daily
  setInterval(() => {
    runCleanup();
    archiveApprovedProposals();
  }, 24 * 60 * 60 * 1000);
  console.log("[Cleanup] Scheduled (daily): backlog prune, proposal archive, stale Redis/inProgress cleanup");
}

export { startCleanupSchedule, runCleanup };
