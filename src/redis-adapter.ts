/**
 * Redis Adapter — singleton connection + typed methods.
 *
 * Replaces per-module `new Redis()` and `getTracker().getRedisClient()` calls
 * with a single shared connection and domain-specific methods that use
 * redis-keys.ts for all key generation.
 *
 * Incrementally adoptable: modules can migrate one at a time.
 */

import Redis from "ioredis";
import { redisKeys } from "./redis-keys.ts";

// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let _instance: any = null;

/** Shared Redis connection. Lazy-initialized on first call. */
export function getRedisConnection(): any {
  if (!_instance) _instance = new Redis(REDIS_URL);
  return _instance;
}

// ---------------------------------------------------------------------------
// Workspace operations
// ---------------------------------------------------------------------------

/**
 * Acquire the workspace lock (NX + 60s TTL).
 * Returns true if lock was acquired, false if already held.
 */
export async function acquireWorkspaceLock(pid: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(redisKeys.workspaceLock(), `${pid}`, "NX", "EX", 60);
  return result === "OK";
}

/** Release the workspace lock. */
export async function releaseWorkspaceLock(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.workspaceLock());
}

// ---------------------------------------------------------------------------
// Reality-report lookups (used by preflight duplicate check)
// ---------------------------------------------------------------------------

/**
 * Fetch the most recent N reality-report IDs (newest first).
 */
export async function getRecentReportIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.realityReportIndex(), 0, count - 1);
}

/**
 * Fetch a single reality report by ID.
 * Returns null if missing.
 */
export async function getRealityReport(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.realityReport(id));
}

// ---------------------------------------------------------------------------
// Anchor calibration (used by anchor-scorer)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pattern-detector operations
// ---------------------------------------------------------------------------

/**
 * Get the last alert timestamp for a given pattern name.
 * Returns null if never alerted.
 */
export async function getPatternCooldown(pattern: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.patternDetectorCooldowns(), pattern);
}

/**
 * Set the cooldown timestamp for a pattern name.
 */
export async function setPatternCooldown(pattern: string, timestamp: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.patternDetectorCooldowns(), pattern, timestamp);
}

/**
 * Push an alert to the alerts list (capped at maxLen).
 */
export async function pushAlert(alertJson: string, maxLen: number): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(redisKeys.alerts(), alertJson);
  await r.ltrim(redisKeys.alerts(), 0, maxLen - 1);
}

// ---------------------------------------------------------------------------
// Adversarial-validation operations
// ---------------------------------------------------------------------------

/**
 * Track a merged commit for revert correlation.
 * Maintains a rolling window of maxLen entries.
 */
export async function pushTrackedMerge(entryJson: string, maxLen: number): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(redisKeys.adversarialTracking(), entryJson);
  await r.ltrim(redisKeys.adversarialTracking(), 0, maxLen - 1);
}

/**
 * Get all tracked merge entries (for revert correlation).
 */
export async function getTrackedMerges(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.adversarialTracking(), 0, -1);
}

/**
 * Persist adversarial precision stats.
 */
export async function setAdversarialStats(statsJson: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.adversarialStats(), statsJson);
}

// ---------------------------------------------------------------------------
// Metrics operations
// ---------------------------------------------------------------------------

/**
 * Fetch the list of agent run entries for a cycle.
 */
export async function getCycleAgentRuns(cycleId: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.cycleAgents(cycleId), 0, -1);
}

/**
 * Store a cycle's flattened metrics hash and add to the index.
 */
export async function setCycleMetrics(
  cycleId: string,
  flat: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.metrics(cycleId), ...Object.entries(flat).flat());
  await r.expire(redisKeys.metrics(cycleId), ttlSeconds);
  await r.zadd(redisKeys.metricsIndex(), Date.now(), cycleId);
}

/**
 * Fetch the N most recent cycle IDs from the metrics index.
 */
export async function getRecentMetricIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.metricsIndex(), 0, count - 1);
}

/**
 * Fetch all fields of a cycle's metrics hash.
 */
export async function getCycleMetrics(cycleId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.metrics(cycleId));
}

// ---------------------------------------------------------------------------
// Knowledge-indexer operations
// ---------------------------------------------------------------------------

/**
 * Fetch reality report IDs with scores above a minimum.
 */
export async function getReportIdsByScore(minScore: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrangebyscore(redisKeys.realityReportIndex(), minScore + 1, "+inf");
}

/**
 * Get the score of a specific reality report ID in the index.
 */
export async function getReportScore(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.zscore(redisKeys.realityReportIndex(), id);
}

/**
 * Fetch memory patterns string for a given agent.
 */
export async function getMemoryPatterns(agent: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.memoryPatterns(agent));
}

// ---------------------------------------------------------------------------
// Plan-cache operations
// ---------------------------------------------------------------------------

/**
 * Get a cached plan entry by full key.
 */
export async function getPlanCacheEntry(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(key);
}

/**
 * Store a plan cache entry with TTL.
 */
export async function setPlanCacheEntry(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(key, value, "EX", ttlSeconds);
}

/**
 * Delete a plan cache entry by key.
 */
export async function deletePlanCacheEntry(key: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(key);
}

/**
 * Find all keys matching the plan cache prefix.
 */
export async function findPlanCacheKeys(prefix: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.keys(`${prefix}*`);
}

/**
 * Delete multiple keys at once.
 */
export async function deleteKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const r = getRedisConnection();
  await r.del(...keys);
}

// ---------------------------------------------------------------------------
// Reflections-buffer operations
// ---------------------------------------------------------------------------

/**
 * Append a reflection to the global buffer list and cap at maxSize.
 */
export async function pushReflection(json: string, maxSize: number): Promise<void> {
  const r = getRedisConnection();
  await r.rpush("hydra:reflections:buffer", json);
  const len = await r.llen("hydra:reflections:buffer");
  if (len > maxSize) {
    await r.ltrim("hydra:reflections:buffer", len - maxSize, -1);
  }
}

/**
 * Fetch all entries from the reflections buffer.
 */
export async function getReflectionBuffer(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange("hydra:reflections:buffer", 0, -1);
}

/**
 * Atomically replace the reflections buffer with a filtered list.
 */
export async function replaceReflectionBuffer(entries: string[]): Promise<void> {
  const r = getRedisConnection();
  const pipeline = r.pipeline();
  pipeline.del("hydra:reflections:buffer");
  if (entries.length > 0) {
    pipeline.rpush("hydra:reflections:buffer", ...entries);
  }
  await pipeline.exec();
}

// ---------------------------------------------------------------------------
// Cleanup operations
// ---------------------------------------------------------------------------

/**
 * Remove metrics index entries below a score cutoff.
 * Returns the number of entries removed.
 */
export async function pruneMetricsIndex(cutoffMs: number): Promise<number> {
  const r = getRedisConnection();
  return r.zremrangebyscore(redisKeys.metricsIndex(), "-inf", cutoffMs);
}

/**
 * Get the cardinality of the metrics index.
 */
export async function getMetricsIndexSize(): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(redisKeys.metricsIndex());
}

/**
 * Trim the metrics index to keep only the top maxEntries (by score).
 * Removes the lowest-scored entries.
 */
export async function trimMetricsIndex(excess: number): Promise<void> {
  const r = getRedisConnection();
  await r.zremrangebyrank(redisKeys.metricsIndex(), 0, excess - 1);
}

/**
 * Scan for keys matching a pattern with cursor-based iteration.
 * Returns all matching keys.
 */
export async function scanKeys(pattern: string): Promise<string[]> {
  const r = getRedisConnection();
  const allKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = nextCursor;
    allKeys.push(...keys);
  } while (cursor !== "0");
  return allKeys;
}

/**
 * Get the TTL of a key. Returns -1 if no TTL, -2 if key does not exist.
 */
export async function getKeyTTL(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.ttl(key);
}

/**
 * Get the Redis type of a key.
 */
export async function getKeyType(key: string): Promise<string> {
  const r = getRedisConnection();
  return r.type(key);
}

/**
 * Get a hash field value.
 */
export async function hashGet(key: string, field: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(key, field);
}

/**
 * Delete keys in batches.
 */
export async function deleteKeysBatch(keys: string[], batchSize = 500): Promise<void> {
  const r = getRedisConnection();
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    await r.del(...batch);
  }
}

/**
 * Get backlog lane entries with scores (for stale-check).
 * Returns [id1, score1, id2, score2, ...].
 */
export async function getBacklogLaneWithScores(lane: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.backlogLane(lane), 0, -1, "WITHSCORES");
}

/**
 * Get a backlog item by ID.
 */
export async function getBacklogItem(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogItems(), id);
}

/**
 * Update a backlog item and move it between lanes atomically.
 */
export async function moveBacklogItem(
  id: string,
  itemJson: string,
  fromLane: string,
  toLane: string,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogItems(), id, itemJson);
  await r.zrem(redisKeys.backlogLane(fromLane), id);
  await r.zadd(redisKeys.backlogLane(toLane), Date.now(), id);
}

// ---------------------------------------------------------------------------
// Proposals operations
// ---------------------------------------------------------------------------

/**
 * Get all fields of a proposal hash.
 */
export async function getProposalHash(proposalId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.proposal(proposalId));
}

/**
 * Store a proposal hash and update the index.
 */
export async function saveProposalHash(
  proposalId: string,
  fields: Record<string, string>,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.proposal(proposalId), fields);
  await r.zadd(redisKeys.proposalsIndex(), Date.now(), proposalId);
}

/**
 * Get all proposal IDs, newest first.
 */
export async function getProposalIdsDesc(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.proposalsIndex(), 0, -1);
}

/**
 * Get all proposal IDs, oldest first.
 */
export async function getProposalIdsAsc(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.proposalsIndex(), 0, -1);
}

/**
 * Delete a proposal hash and remove from index.
 */
export async function deleteProposal(proposalId: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.proposal(proposalId));
  await r.zrem(redisKeys.proposalsIndex(), proposalId);
}

/**
 * Remove a proposal ID from the index (without deleting the hash).
 */
export async function removeProposalFromIndex(proposalId: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(redisKeys.proposalsIndex(), proposalId);
}

/**
 * Get the cost microdollars field from a cycle's costs hash.
 */
export async function getCycleCostMicrodollars(cycleId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.cycleCosts(cycleId), "costMicrodollars");
}

/**
 * Fetch recent report IDs from the reality-report index (newest first).
 */
export async function getRecentReportIdsDesc(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.realityReportIndex(), 0, count - 1);
}

/**
 * Fetch recent metric cycle IDs from the metrics index (newest first).
 */
export async function getRecentMetricIdsDesc(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.metricsIndex(), 0, count - 1);
}

// ---------------------------------------------------------------------------
// Agent-memory operations
// ---------------------------------------------------------------------------

/**
 * Load raw patterns JSON for an agent.
 */
export async function loadPatternsRaw(agent: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.memoryPatterns(agent));
}

/**
 * Save patterns JSON for an agent.
 */
export async function savePatternsRaw(agent: string, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.memoryPatterns(agent), json);
}

/**
 * Get the length of old rules list for an agent.
 */
export async function getOldRulesCount(agent: string): Promise<number> {
  const r = getRedisConnection();
  return r.llen(redisKeys.memoryRules(agent));
}

/**
 * Check if patterns key exists for an agent.
 */
export async function patternsExist(agent: string): Promise<boolean> {
  const r = getRedisConnection();
  const val = await r.exists(redisKeys.memoryPatterns(agent));
  return val === 1;
}

/**
 * Get all old rules for an agent.
 */
export async function getOldRules(agent: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.memoryRules(agent), 0, -1);
}

/**
 * Delete old rules key for an agent.
 */
export async function deleteOldRules(agent: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.memoryRules(agent));
}

/**
 * Push a reflection entry for a specific anchor and set TTL.
 * Trims to maxEntries.
 */
export async function pushAnchorReflection(
  key: string,
  json: string,
  ttlSeconds: number,
  maxEntries: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(key, json);
  await r.expire(key, ttlSeconds);
  const len = await r.llen(key);
  if (len > maxEntries) {
    await r.ltrim(key, len - maxEntries, -1);
  }
}

/**
 * Fetch all entries from a reflection list.
 */
export async function getAnchorReflections(key: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(key, 0, -1);
}

/**
 * Delete a reflection key.
 */
export async function deleteReflectionKey(key: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(key);
}
