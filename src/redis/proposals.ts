/**
 * Proposal Redis ops. Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
import { getRedisConnection } from "./connection.ts";

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
 * Get proposal IDs created within a time range (by index score).
 * Scores are epoch ms timestamps set by saveProposalHash.
 */
export async function getProposalIdsByTimeRange(
  minMs: number,
  maxMs: number,
): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrangebyscore(redisKeys.proposalsIndex(), minMs, maxMs);
}
