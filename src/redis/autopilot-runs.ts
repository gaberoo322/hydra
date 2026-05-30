/**
 * Autopilot run + turn Redis ops.
 *
 * The autopilot writes one hash per long-running session (the "run"), a
 * sorted set indexing runs by started_epoch, and a sorted set of immutable
 * turn records per run. This Module owns key + TTL + index maintenance for
 * the autopilot-runs sub-domain so api/autopilot.ts route handlers stay
 * about HTTP shape and idempotency rather than Redis bookkeeping.
 *
 * Schema (frozen by issue #498 slice-2 AC10):
 *   hydra:autopilot:run:{runId}            — hash, 7d TTL
 *   hydra:autopilot:runs:index             — sorted set, 7d TTL refresh
 *   hydra:autopilot:run:{runId}:turns      — sorted set scored by turn_n, 7d TTL
 *   hydra:autopilot:pr:{prNumber}          — dispatch->PR link hash, 14d TTL (issue #732)
 *   hydra:autopilot:prs:index              — sorted set of PR numbers scored by openedAt (issue #732)
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Dispatch -> PR link (issue #732)
//
// One of the two new persisted Builder-Health signals: when a dispatch opens
// a PR we stamp a link record so the Autonomy Rate + time-to-merge metrics can
// be derived from GitHub on read (the link supplies the PR number + the open
// timestamp; mergedBy / labels / reviews are queried live). Kept independent
// of the cycle-record prNumber (which is for the per-cycle dashboard join) so
// the scorecard reader has a single, time-indexed source for "PRs a dispatch
// opened in the last N", without enumerating every cycle hash.
// ---------------------------------------------------------------------------

/** 14 days — covers any scorecard window plus merge latency tail. */
export const PR_LINK_TTL_SECONDS = 14 * 24 * 60 * 60;

function autopilotPrKey(prNumber: number): string {
  return `hydra:autopilot:pr:${prNumber}`;
}
function autopilotPrsIndexKey(): string {
  return "hydra:autopilot:prs:index";
}

/**
 * Record a dispatch->PR link. Idempotent on `prNumber` — a second call for the
 * same PR refreshes the TTL and keeps the first `openedAtMs` (PR-open time is
 * immutable). `fields` carries the dispatch provenance (runId, dispatchId,
 * skill, issueRef) plus `openedAtMs` as a string.
 */
export async function putAutopilotPrLink(
  prNumber: number,
  fields: Record<string, string>,
  openedAtMs: number,
): Promise<void> {
  const r = getRedisConnection();
  const key = autopilotPrKey(prNumber);
  const existing = await r.hget(key, "openedAtMs");
  // Preserve the first-seen open time across retries.
  const toWrite = existing
    ? { ...fields, openedAtMs: existing }
    : { ...fields, openedAtMs: String(openedAtMs) };
  await r.hset(key, ...Object.entries(toWrite).flat());
  await r.expire(key, PR_LINK_TTL_SECONDS);
  const score = existing ? Number(existing) || openedAtMs : openedAtMs;
  await r.zadd(autopilotPrsIndexKey(), score, String(prNumber));
  await r.expire(autopilotPrsIndexKey(), PR_LINK_TTL_SECONDS);
}

/** List PR-link hashes opened in `[sinceMs, +inf)`, newest-first. */
export async function listAutopilotPrLinksSince(
  sinceMs: number,
): Promise<Array<Record<string, string>>> {
  const r = getRedisConnection();
  const prNumbers: string[] = await r.zrevrangebyscore(
    autopilotPrsIndexKey(),
    "+inf",
    sinceMs,
  );
  const out: Array<Record<string, string>> = [];
  for (const pr of prNumbers) {
    const hash = await r.hgetall(autopilotPrKey(Number(pr)));
    if (hash && Object.keys(hash).length > 0) {
      out.push({ prNumber: pr, ...hash });
    }
  }
  return out;
}

/** Test-only: clear all PR-link state. */
export async function _resetAutopilotPrLinks(): Promise<void> {
  const r = getRedisConnection();
  const prNumbers: string[] = await r.zrange(autopilotPrsIndexKey(), 0, -1);
  for (const pr of prNumbers) await r.del(autopilotPrKey(Number(pr)));
  await r.del(autopilotPrsIndexKey());
}

// ---------------------------------------------------------------------------
// Run hash CRUD
// ---------------------------------------------------------------------------

/** Read the full run hash. Returns {} when absent. */
export async function getAutopilotRun(runId: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(redisKeys.autopilotRun(runId));
}

/**
 * Init a run row with `fields` and stamp the TTL. Used by /autopilot/run-start.
 * Caller is responsible for idempotency (check getAutopilotRun first).
 */
export async function initAutopilotRun(
  runId: string,
  fields: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.autopilotRun(runId), ...Object.entries(fields).flat());
  await r.expire(redisKeys.autopilotRun(runId), ttlSeconds);
}

/**
 * Partial update of multiple fields + TTL refresh. Used by /autopilot/run-end
 * and the read-time sweeper.
 */
export async function updateAutopilotRunFields(
  runId: string,
  fields: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.autopilotRun(runId), ...Object.entries(fields).flat());
  await r.expire(redisKeys.autopilotRun(runId), ttlSeconds);
}

/** Single-field write. */
export async function setAutopilotRunField(
  runId: string,
  field: string,
  value: string,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(redisKeys.autopilotRun(runId), field, value);
}

/** HINCRBY a numeric field on the run hash. */
export async function incrAutopilotRunField(
  runId: string,
  field: string,
  by: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.hincrby(redisKeys.autopilotRun(runId), field, by);
}

/** Refresh the run hash TTL. */
export async function refreshAutopilotRunTTL(runId: string, ttlSeconds: number): Promise<void> {
  const r = getRedisConnection();
  await r.expire(redisKeys.autopilotRun(runId), ttlSeconds);
}

// ---------------------------------------------------------------------------
// Runs index (ZSET scored by started_epoch)
// ---------------------------------------------------------------------------

/** Add a run to the index and stamp the index TTL. */
export async function addAutopilotRunToIndex(
  runId: string,
  score: number,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.autopilotRunsIndex(), score, runId);
  await r.expire(redisKeys.autopilotRunsIndex(), ttlSeconds);
}

/** List recent run IDs, newest-first (ZREVRANGE 0 limit-1). */
export async function listRecentAutopilotRunIds(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.zrevrange(redisKeys.autopilotRunsIndex(), 0, limit - 1);
}

// ---------------------------------------------------------------------------
// Turn records (ZSET scored by turn_n)
// ---------------------------------------------------------------------------

/**
 * Append a turn record. Idempotency on (runId, turnN) is the caller's job —
 * use `hasAutopilotRunTurnAt(runId, turnN)` first.
 */
export async function addAutopilotRunTurn(
  runId: string,
  turnN: number,
  member: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.zadd(redisKeys.autopilotRunTurns(runId), turnN, member);
  await r.expire(redisKeys.autopilotRunTurns(runId), ttlSeconds);
}

/** Idempotency probe — true iff a turn member already exists at this score. */
export async function hasAutopilotRunTurnAt(runId: string, turnN: number): Promise<boolean> {
  const r = getRedisConnection();
  const existing: string[] = await r.zrangebyscore(
    redisKeys.autopilotRunTurns(runId),
    turnN,
    turnN,
  );
  return Array.isArray(existing) && existing.length > 0;
}

/**
 * List turn members in descending turn_n order, up to `limit`.
 * Used by the /runs/current and /runs/:id endpoints to render the turn timeline.
 */
export async function listAutopilotRunTurnsDesc(
  runId: string,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.zrevrangebyscore(
    redisKeys.autopilotRunTurns(runId),
    "+inf",
    "-inf",
    "LIMIT",
    0,
    limit,
  );
}
