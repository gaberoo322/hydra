/**
 * Redis seam for autopilot recommendations (issue #674, slice F of #667).
 *
 * Owns the storage shape for the LLM-driven recommendation engine and the
 * Recommendations tab in Oak's town crier. Per-run scoped — all keys live
 * under `hydra:autopilot:recs:{run_id}` and share the run's 7d TTL so
 * recommendations expire alongside the run hash they describe.
 *
 * Three Redis objects per run:
 *
 *   hydra:autopilot:recs:{run_id}                 — hash, field=rec.id, value=JSON
 *   hydra:autopilot:recs:{run_id}:dismissed       — set of rec.ids the operator dismissed
 *   hydra:autopilot:recs:{run_id}:muted-classes   — set of severity strings the operator muted
 *
 * Plus three globals for the engine's internal bookkeeping:
 *
 *   hydra:autopilot:recs:last-call:{run_id}       — string epoch-seconds of last Haiku call
 *   hydra:autopilot:recs:last-signature:{run_id}  — string material-change signature
 *   hydra:autopilot:recs:daily-spend:{YYYY-MM-DD} — INT string, USD * 1e6 (micro-USD)
 *
 * Cost is tracked in micro-USD (USD * 1_000_000) so INCRBY stays integer-safe
 * — Redis INCRBY rejects floats. The default cap is $1/day = 1_000_000
 * micro-USD; well inside Redis's 64-bit integer range.
 *
 * Per CLAUDE.md, all Redis access from outside `src/redis/` MUST go through
 * a typed accessor here — never `new Redis()` directly.
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Key shapes — exported so tests can assert against them by name
// ---------------------------------------------------------------------------

function recsHashKey(runId: string): string {
  return `hydra:autopilot:recs:${runId}`;
}

function recsDismissedKey(runId: string): string {
  return `hydra:autopilot:recs:${runId}:dismissed`;
}

function recsMutedClassesKey(runId: string): string {
  return `hydra:autopilot:recs:${runId}:muted-classes`;
}

function recsLastCallKey(runId: string): string {
  return `hydra:autopilot:recs:last-call:${runId}`;
}

function recsLastSignatureKey(runId: string): string {
  return `hydra:autopilot:recs:last-signature:${runId}`;
}

function recsDailySpendKey(date: string): string {
  return `hydra:autopilot:recs:daily-spend:${date}`;
}

// ---------------------------------------------------------------------------
// Rec hash CRUD
// ---------------------------------------------------------------------------

/**
 * Append a recommendation to the run's hash. Caller is responsible for
 * stable rec.id allocation (the engine derives a deterministic id so retries
 * dedupe). `ttlSeconds` is refreshed on every write to keep recs alive as
 * long as new ones are being emitted.
 */
export async function appendRecommendation(
  runId: string,
  recId: string,
  recJson: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  const key = recsHashKey(runId);
  await r.hset(key, recId, recJson);
  await r.expire(key, ttlSeconds);
}

/** Read every recommendation in the run as a {id: jsonString} map. */
export async function getAllRecommendations(
  runId: string,
): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(recsHashKey(runId));
}

// ---------------------------------------------------------------------------
// Dismissed set
// ---------------------------------------------------------------------------

/** Mark a single recommendation id as dismissed. */
export async function dismissRecommendation(
  runId: string,
  recId: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  const key = recsDismissedKey(runId);
  await r.sadd(key, recId);
  await r.expire(key, ttlSeconds);
}

/** Read the full dismissed-id set. */
export async function getDismissedSet(runId: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.smembers(recsDismissedKey(runId));
}

// ---------------------------------------------------------------------------
// Muted-classes set
// ---------------------------------------------------------------------------

/** Mute every recommendation with `severity === <severity>` for this run. */
export async function muteSeverityClass(
  runId: string,
  severity: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  const key = recsMutedClassesKey(runId);
  await r.sadd(key, severity);
  await r.expire(key, ttlSeconds);
}

/** Read the full muted-severities set. */
export async function getMutedClassesSet(runId: string): Promise<string[]> {
  const r = getRedisConnection();
  return r.smembers(recsMutedClassesKey(runId));
}

// ---------------------------------------------------------------------------
// Engine internals: last-call + last-signature
// ---------------------------------------------------------------------------

/** Read the epoch-seconds of the last LLM call for this run. Null if never. */
export async function getLastCallEpoch(runId: string): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(recsLastCallKey(runId));
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Stamp the last-call epoch (caller passes the value to make tests deterministic). */
export async function setLastCallEpoch(
  runId: string,
  epoch: number,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(recsLastCallKey(runId), String(Math.floor(epoch)), "EX", ttlSeconds);
}

/** Read the previous material-change signature for the run. Null if unset. */
export async function getLastSignature(runId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(recsLastSignatureKey(runId));
}

/** Stamp the latest material-change signature. */
export async function setLastSignature(
  runId: string,
  signature: string,
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  await r.set(recsLastSignatureKey(runId), signature, "EX", ttlSeconds);
}

// ---------------------------------------------------------------------------
// Daily spend (micro-USD, INT)
// ---------------------------------------------------------------------------

/** Read the recs-engine USD spend for `date` (YYYY-MM-DD). Returns 0 if unset. */
export async function getDailySpendUsd(date: string): Promise<number> {
  const r = getRedisConnection();
  const raw = await r.get(recsDailySpendKey(date));
  if (!raw) return 0;
  const microUsd = Number(raw);
  if (!Number.isFinite(microUsd)) return 0;
  return microUsd / 1_000_000;
}

/**
 * Add `usd` to the day's recs-engine spend. The Redis value is in micro-USD
 * (INT) so INCRBY stays integer-safe; we round at the boundary. Returns the
 * new total in USD.
 *
 * TTL is 48h so yesterday's spend lingers long enough for diagnostics but
 * eventually expires.
 */
export async function incrDailySpendUsd(
  date: string,
  usd: number,
): Promise<number> {
  if (!Number.isFinite(usd) || usd <= 0) {
    return getDailySpendUsd(date);
  }
  const r = getRedisConnection();
  const key = recsDailySpendKey(date);
  const microUsd = Math.round(usd * 1_000_000);
  const newMicroUsd = await r.incrby(key, microUsd);
  await r.expire(key, 48 * 3600);
  return newMicroUsd / 1_000_000;
}
