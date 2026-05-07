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

let _instance: any = null;

/** Shared Redis connection. Lazy-initialized on first call. */
export function getRedisConnection(): any {
  if (!_instance) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    _instance = new Redis(url);
  }
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

// ---------------------------------------------------------------------------
// Generic key operations (used by many modules)
// ---------------------------------------------------------------------------

/** Get a string value by key. */
export async function getString(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(key);
}

/** Set a string value by key (optional EX ttl). */
export async function setString(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const r = getRedisConnection();
  if (ttlSeconds != null) {
    await r.set(key, value, "EX", ttlSeconds);
  } else {
    await r.set(key, value);
  }
}

/** Delete one or more keys. */
export async function delKey(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const r = getRedisConnection();
  await r.del(...keys);
}

/** Set a key only if it does not exist (NX), with TTL. Returns true if set. */
export async function setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(key, value, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Increment a key and return the new value. */
export async function incrKey(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.incr(key);
}

/** Set TTL on a key. */
export async function expireKey(key: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.expire(key, ttlSeconds);
}

/** Get all fields of a hash. */
export async function hashGetAll(key: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(key);
}

/** Set multiple fields on a hash. */
export async function hashSet(key: string, ...fieldsAndValues: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.hset(key, ...fieldsAndValues);
}

/** Set a single field on a hash. */
export async function hashSetField(key: string, field: string, value: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(key, field, value);
}

/** Delete a field from a hash. */
export async function hashDel(key: string, field: string): Promise<void> {
  const r = getRedisConnection();
  await r.hdel(key, field);
}

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

/** Get the length of a list. */
export async function listLen(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.llen(key);
}

/** Get a range of list elements. */
export async function listRange(key: string, start: number, stop: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(key, start, stop);
}

/** Push to the right end of a list. */
export async function listRPush(key: string, ...values: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(key, ...values);
}

/** Pop from the left end of a list. */
export async function listLPop(key: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.lpop(key);
}

/** Remove count occurrences of value from list. */
export async function listRem(key: string, count: number, value: string): Promise<number> {
  const r = getRedisConnection();
  return r.lrem(key, count, value);
}

/** Atomically move an element from source list to dest list. */
export async function listMove(source: string, dest: string, srcDir: "LEFT" | "RIGHT", destDir: "LEFT" | "RIGHT"): Promise<string | null> {
  const r = getRedisConnection();
  return r.lmove(source, dest, srcDir, destDir);
}

// ---------------------------------------------------------------------------
// Sorted set operations
// ---------------------------------------------------------------------------

/** Get range of sorted set members. */
export async function zRange(key: string, start: number, stop: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(key, start, stop);
}

/** Get reverse range of sorted set members. */
export async function zRevRange(key: string, start: number, stop: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(key, start, stop);
}

/** Add a member to a sorted set. */
export async function zAdd(key: string, score: number, member: string): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(key, score, member);
}

/** Remove a member from a sorted set. */
export async function zRem(key: string, member: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(key, member);
}

/** Get sorted set cardinality. */
export async function zCard(key: string): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(key);
}

// ---------------------------------------------------------------------------
// Backlog operations (used by backlog.ts)
// ---------------------------------------------------------------------------

/** Increment the backlog counter and return new ID. */
export async function incrBacklogCounter(): Promise<string> {
  const r = getRedisConnection();
  const id = await r.incr(redisKeys.backlogCounter());
  return `item-${id}`;
}

/** Get a backlog item by ID (raw JSON string). */
export async function getBacklogItemRaw(id: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(redisKeys.backlogItems(), id);
}

/** Save a backlog item. */
export async function saveBacklogItem(id: string, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.backlogItems(), id, json);
}

/** Delete a backlog item from hash and all lane sorted sets. */
export async function removeBacklogItem(id: string, lanes: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.hdel(redisKeys.backlogItems(), id);
  for (const lane of lanes) {
    await r.zrem(redisKeys.backlogLane(lane), id);
  }
}

/** Get all IDs in a backlog lane. */
export async function getBacklogLaneIds(lane: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrange(redisKeys.backlogLane(lane), 0, -1);
}

/** Get cardinality of a backlog lane. */
export async function getBacklogLaneCount(lane: string): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(redisKeys.backlogLane(lane));
}

/** Add an item to a backlog lane sorted set. */
export async function addToBacklogLane(lane: string, score: number, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.backlogLane(lane), score, id);
}

/** Remove an item from a backlog lane sorted set. */
export async function removeFromBacklogLane(lane: string, id: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(redisKeys.backlogLane(lane), id);
}

/** Execute a Lua script (for atomic backlog operations). */
export async function evalScript(script: string, numKeys: number, ...args: (string | number)[]): Promise<any> {
  const r = getRedisConnection();
  return r.eval(script, numKeys, ...args);
}

// ---------------------------------------------------------------------------
// Cycle tracking operations (used by control-loop.ts)
// ---------------------------------------------------------------------------

/** Set the active cycle ID. */
export async function setCycleActive(cycleId: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleActive(), cycleId);
}

/** Clear the active cycle. */
export async function clearCycleActive(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.cycleActive());
}

/** Set the last completed cycle ID. */
export async function setCycleLast(cycleId: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleLast(), cycleId);
}

/** Init cycle hash fields and set TTL. */
export async function initCycleHash(cycleId: string, fields: Record<string, string>, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.cycle(cycleId), ...Object.entries(fields).flat());
  await r.expire(redisKeys.cycle(cycleId), ttlSeconds);
}

/** Update cycle hash fields. */
export async function updateCycleHash(cycleId: string, fields: Record<string, string>): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.cycle(cycleId), ...Object.entries(fields).flat());
}

/** Refresh cycle hash TTL. */
export async function refreshCycleTTL(cycleId: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.expire(redisKeys.cycle(cycleId), ttlSeconds);
}

/** Register a cycle source (codex/claude) with TTL. */
export async function registerCycleSource(source: string, cycleId: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.cycleActiveSource(source), cycleId, "EX", ttlSeconds);
}

/** Release a cycle source registration. */
export async function releaseCycleSource(source: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.cycleActiveSource(source));
}

// ---------------------------------------------------------------------------
// Merge lock operations (used by control-loop.ts)
// ---------------------------------------------------------------------------

/** Try to acquire the merge lock. Returns true if acquired. */
export async function acquireMergeLock(cycleId: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(redisKeys.mergeLock(), cycleId, "EX", ttlSeconds, "NX");
  return result === "OK";
}

/** Get current merge lock holder. */
export async function getMergeLockHolder(): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.mergeLock());
}

/** Release the merge lock. */
export async function releaseMergeLock(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.mergeLock());
}

// ---------------------------------------------------------------------------
// Reality report operations (used by control-loop.ts)
// ---------------------------------------------------------------------------

/** Save a reality report with TTL and add to index. */
export async function saveRealityReport(cycleId: string, json: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.realityReport(cycleId), json, "EX", ttlSeconds);
  await r.zadd(redisKeys.realityReportIndex(), Date.now(), cycleId);
}

/** Trim reality report index to keep only the most recent N entries. */
export async function trimRealityReports(maxCount: number): Promise<void> {
  const r = getRedisConnection();
  const count = await r.zcard(redisKeys.realityReportIndex());
  if (count > maxCount) {
    const old = await r.zrange(redisKeys.realityReportIndex(), 0, count - maxCount - 1);
    for (const id of old) {
      await r.del(redisKeys.realityReport(id));
      await r.zrem(redisKeys.realityReportIndex(), id);
    }
  }
}

// ---------------------------------------------------------------------------
// Research report operations (used by research-loop.ts)
// ---------------------------------------------------------------------------

/** Save a research report and add to index. */
export async function saveResearchReport(researchId: string, json: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(redisKeys.researchReport(researchId), json);
  await r.zadd(redisKeys.researchReportIndex(), Date.now(), researchId);
}

/** Get a research report by ID. */
export async function getResearchReport(researchId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.researchReport(researchId));
}

/** Get the N most recent research report IDs (newest first). */
export async function getRecentResearchIds(count: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.researchReportIndex(), 0, count - 1);
}

/** Trim research reports to keep only the most recent N. */
export async function trimResearchReports(maxCount: number): Promise<void> {
  const r = getRedisConnection();
  const count = await r.zcard(redisKeys.researchReportIndex());
  if (count > maxCount) {
    const old = await r.zrange(redisKeys.researchReportIndex(), 0, count - maxCount - 1);
    for (const id of old) {
      await r.del(redisKeys.researchReport(id));
      await r.zrem(redisKeys.researchReportIndex(), id);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolved health-anchor operations (issue #25)
// ---------------------------------------------------------------------------

const RESOLVED_HEALTH_TTL = 86400; // 24h

/**
 * Mark a codebase-health anchor as resolved after a successful merge.
 * Uses a per-reference key with 24h TTL so stale entries auto-expire.
 */
export async function markHealthAnchorResolved(ref: string): Promise<void> {
  const r = getRedisConnection();
  const key = redisKeys.anchorResolvedHealth(ref.replace(/\s+/g, "-").slice(0, 120));
  await r.set(key, new Date().toISOString(), "EX", RESOLVED_HEALTH_TTL);
}

/**
 * Check whether a codebase-health anchor was recently resolved.
 */
export async function isHealthAnchorResolved(ref: string): Promise<boolean> {
  const r = getRedisConnection();
  const key = redisKeys.anchorResolvedHealth(ref.replace(/\s+/g, "-").slice(0, 120));
  const val = await r.exists(key);
  return val === 1;
}

// ---------------------------------------------------------------------------
// Anchor queue operations (used by anchor-selection.ts, scheduler.ts)
// ---------------------------------------------------------------------------

/** Get the length of the work queue. */
export async function getWorkQueueLen(): Promise<number> {
  const r = getRedisConnection();
  return r.llen(redisKeys.anchorWorkQueue());
}

/** Get all items from the work queue. */
export async function getWorkQueueItems(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.anchorWorkQueue(), 0, -1);
}

/** Push an item to the work queue. */
export async function pushToWorkQueue(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(redisKeys.anchorWorkQueue(), json);
}

/** Remove an item from the work queue. */
export async function removeFromWorkQueue(value: string): Promise<number> {
  const r = getRedisConnection();
  return r.lrem(redisKeys.anchorWorkQueue(), 1, value);
}

// ---------------------------------------------------------------------------
// Work queue dedup utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a string for fuzzy comparison: lowercase, collapse whitespace, trim.
 */
export function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Check if two references are fuzzy duplicates.
 * Returns true if either is a case-insensitive substring of the other
 * (after whitespace normalization).
 */
export function isFuzzyDuplicate(a: string, b: string): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Check if a reference already exists in the work queue (fuzzy match).
 * Returns the matched reference if found, or null if no duplicate.
 */
export async function findWorkQueueDuplicate(reference: string): Promise<string | null> {
  const items = await getWorkQueueItems();
  for (const raw of items) {
    try {
      const item = JSON.parse(raw);
      const existing = item.reference || "";
      if (isFuzzyDuplicate(reference, existing)) {
        return existing;
      }
    } catch { /* intentional: skip corrupt items */ }
  }
  return null;
}

/**
 * Clean the work queue on startup:
 * - Remove items with "COMPLETED:" prefix in their reference
 * - Deduplicate remaining items (keep first occurrence)
 */
export async function cleanWorkQueue(): Promise<{ removedCompleted: number; removedDuplicates: number }> {
  const r = getRedisConnection();
  const items = await getWorkQueueItems();
  let removedCompleted = 0;
  let removedDuplicates = 0;

  const toRemove: string[] = [];
  const seen: string[] = []; // normalized references we've seen

  for (const raw of items) {
    let ref = "";
    try {
      const item = JSON.parse(raw);
      ref = item.reference || "";
    } catch { /* intentional: unparseable item — use raw string as reference */
      ref = raw;
    }

    // Remove COMPLETED: items
    if (ref.startsWith("COMPLETED:") || ref.startsWith("completed:")) {
      toRemove.push(raw);
      removedCompleted++;
      continue;
    }

    // Dedup against previously seen items
    const normalized = normalizeForDedup(ref);
    const isDup = seen.some(s => isFuzzyDuplicate(ref, s));
    if (isDup) {
      toRemove.push(raw);
      removedDuplicates++;
    } else {
      seen.push(normalized);
    }
  }

  // Remove flagged items
  for (const val of toRemove) {
    await r.lrem(redisKeys.anchorWorkQueue(), 1, val);
  }

  if (removedCompleted > 0 || removedDuplicates > 0) {
    console.log(`[WorkQueue] Cleanup: removed ${removedCompleted} completed, ${removedDuplicates} duplicates`);
  }

  return { removedCompleted, removedDuplicates };
}

// ---------------------------------------------------------------------------
// Pipeline support (used by task-tracker.ts for batched operations)
// ---------------------------------------------------------------------------

/**
 * Create a Redis pipeline for batched commands.
 * Caller must call `.exec()` on the returned pipeline.
 */
export function createPipeline(): any {
  const r = getRedisConnection();
  return r.pipeline();
}

// ---------------------------------------------------------------------------
// Set operations (used by task-tracker.ts for dependency tracking)
// ---------------------------------------------------------------------------

/** Get all members of a set. */
export async function setMembers(key: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.smembers(key);
}

/** Add member(s) to a set. */
export async function setAdd(key: string, ...members: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.sadd(key, ...members);
}

/** Remove member(s) from a set. */
export async function setRem(key: string, ...members: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.srem(key, ...members);
}

// ---------------------------------------------------------------------------
// Hash numeric operations
// ---------------------------------------------------------------------------

/** Increment a hash field by an integer amount. */
export async function hashIncrBy(key: string, field: string, increment: number): Promise<number> {
  const r = getRedisConnection();
  return r.hincrby(key, field, increment);
}

// ---------------------------------------------------------------------------
// Key existence check
// ---------------------------------------------------------------------------

/** Check if a key exists. Returns true if the key exists. */
export async function keyExists(key: string): Promise<boolean> {
  const r = getRedisConnection();
  const val = await r.exists(key);
  return val === 1;
}

// ---------------------------------------------------------------------------
// Keys pattern search (use sparingly — prefer SCAN for large keyspaces)
// ---------------------------------------------------------------------------

/** Find all keys matching a pattern. */
export async function findKeys(pattern: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.keys(pattern);
}

// ---------------------------------------------------------------------------
// Redis info (used by health checks)
// ---------------------------------------------------------------------------

/** Get Redis INFO for a section. */
export async function redisInfo(section: string): Promise<string> {
  const r = getRedisConnection();
  return r.info(section);
}

// ---------------------------------------------------------------------------
// List set-by-index (used by alert dismiss)
// ---------------------------------------------------------------------------

/** Set a list element at a given index. */
export async function listSet(key: string, index: number, value: string): Promise<void> {
  const r = getRedisConnection();
  await r.lset(key, index, value);
}

/** Push to the left end of a list. */
export async function listLPush(key: string, ...values: string[]): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(key, ...values);
}

/** Trim a list to the specified range. */
export async function listTrim(key: string, start: number, stop: number): Promise<void> {
  const r = getRedisConnection();
  await r.ltrim(key, start, stop);
}

// ---------------------------------------------------------------------------
// Cycle cost operations (used by metrics spending endpoint)
// ---------------------------------------------------------------------------

/** Get all cost fields for a cycle. */
export async function getCycleCosts(cycleId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.cycleCosts(cycleId));
}

// ---------------------------------------------------------------------------
// Research-to-build ratio tracking (issue #84)
// ---------------------------------------------------------------------------

/** Record a research cycle event (timestamp-scored sorted set, rolling 24h). */
export async function recordResearchEvent(): Promise<void> {
  const r = getRedisConnection();
  const now = Date.now();
  const key = redisKeys.schedulerResearchEvents();
  await r.zadd(key, now, `${now}`);
  // Prune entries older than 24h
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
}

/** Record a build cycle event (timestamp-scored sorted set, rolling 24h). */
export async function recordBuildEvent(): Promise<void> {
  const r = getRedisConnection();
  const now = Date.now();
  const key = redisKeys.schedulerBuildEvents();
  await r.zadd(key, now, `${now}`);
  // Prune entries older than 24h
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
}

/** Get count of research events in the last 24h. */
export async function getResearchEventCount24h(): Promise<number> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerResearchEvents();
  const now = Date.now();
  // Prune old entries first
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
  return r.zcard(key);
}

/** Get count of build events in the last 24h. */
export async function getBuildEventCount24h(): Promise<number> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerBuildEvents();
  const now = Date.now();
  // Prune old entries first
  await r.zremrangebyscore(key, "-inf", now - 86400_000);
  return r.zcard(key);
}

/** Set the force-research-once flag (consumed on next maybeRunResearch). */
export async function setResearchForceOnce(): Promise<void> {
  const r = getRedisConnection();
  // TTL of 1 hour — if not consumed by then, it expires
  await r.set(redisKeys.schedulerResearchForceOnce(), "1", "EX", 3600);
}

/** Consume the force-research-once flag. Returns true if it was set. */
export async function consumeResearchForceOnce(): Promise<boolean> {
  const r = getRedisConnection();
  const key = redisKeys.schedulerResearchForceOnce();
  const val = await r.get(key);
  if (val) {
    await r.del(key);
    return true;
  }
  return false;
}
