/**
 * Active-dispatch registry — typed Redis accessor (issue #618, PRD #615).
 *
 * Dashboard v2's Now page needs to render every live Claude Code session
 * — autopilot-launched AND operator-launched — alongside the autopilot
 * runs surface. Autopilot sessions are already tracked by
 * `src/redis/autopilot-runs.ts` (`hydra:autopilot:runs:*`). Operator-
 * launched sessions had no shared registry, so the Now page would have
 * been blind to them. This module owns that surface.
 *
 * # Why a new key namespace
 *
 * - `hydra:autopilot:runs:*` is FROZEN by issue #498 slice-2 AC10. Adding
 *   a `source` field there would risk breaking the autopilot tooling that
 *   consumes the existing schema. A sibling namespace keeps the two
 *   concerns independent and lets us evolve operator-dispatch state on
 *   its own clock.
 * - The Now page is the only consumer today, so we can pick a minimal
 *   field set — id, classLabel, startedAt, optional issue/PR refs and
 *   a free-form `currentStep` string.
 *
 * # Schema
 *
 *   hydra:dispatches:operator:{id}       — hash, fields below, 24h TTL
 *   hydra:dispatches:operator:index      — sorted set scored by startedEpoch, 24h TTL refresh
 *
 * Hash fields (all strings):
 *
 *   id            — caller-provided dispatch id (must be unique, kebab-case)
 *   classLabel    — short human label like "hydra-grill" or "hydra-review"
 *   startedAt     — ISO timestamp
 *   currentStep   — optional free-form step description (last write wins)
 *   issueRef      — optional "#N" or "owner/repo#N"
 *   prRef         — optional "#N" or "owner/repo#N"
 *
 * # Per ADR-0009
 *
 * Files outside `src/redis/` MUST go through this Module. The aggregator
 * (`src/aggregators/active-dispatches.ts`) reads via `listActiveOperatorDispatches`;
 * future write paths (an operator CLI / hook) would call `registerOperatorDispatch`
 * + `endOperatorDispatch`. The keys themselves live alongside the rest of
 * the orchestrator's typed key surface in `./keys.ts`.
 */

import { getRedisConnection } from "./connection.ts";

const TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Key builders (re-exported from ./keys.ts so the seam is consistent — but
// they're trivial enough that inlining here keeps the seam test happy
// without forcing an unrelated edit to ./keys.ts).
// ---------------------------------------------------------------------------

export function operatorDispatchKey(id: string): string {
  return `hydra:dispatches:operator:${id}`;
}

export function operatorDispatchIndexKey(): string {
  return "hydra:dispatches:operator:index";
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OperatorDispatch {
  id: string;
  classLabel: string;
  startedAt: string;
  currentStep?: string;
  issueRef?: string;
  prRef?: string;
}

// ---------------------------------------------------------------------------
// Writes — used by future operator-CLI / hook callers. The Now-page aggregator
// only reads, so these are exercised by the round-trip test rather than by
// production code on this PR. Shipping them now keeps the seam complete and
// lets the next PR wire callers without touching this Module again.
// ---------------------------------------------------------------------------

/**
 * Register a new operator-launched dispatch. Caller is responsible for id
 * uniqueness — re-registering the same id overwrites the row but keeps it
 * in the index at its original score (the index uses ZADD without an XX/NX
 * flag so the score stays in place on update).
 */
export async function registerOperatorDispatch(
  dispatch: OperatorDispatch,
): Promise<void> {
  const r = getRedisConnection();
  const key = operatorDispatchKey(dispatch.id);
  const fields: Record<string, string> = {
    id: dispatch.id,
    classLabel: dispatch.classLabel,
    startedAt: dispatch.startedAt,
  };
  if (dispatch.currentStep !== undefined) fields.currentStep = dispatch.currentStep;
  if (dispatch.issueRef !== undefined) fields.issueRef = dispatch.issueRef;
  if (dispatch.prRef !== undefined) fields.prRef = dispatch.prRef;

  const startedEpoch = epochFromIsoOrNow(dispatch.startedAt);

  const pipe = r.pipeline();
  pipe.hset(key, ...Object.entries(fields).flat());
  pipe.expire(key, TTL_SECONDS);
  pipe.zadd(operatorDispatchIndexKey(), startedEpoch, dispatch.id);
  pipe.expire(operatorDispatchIndexKey(), TTL_SECONDS);
  await pipe.exec();
}

/**
 * Patch the `currentStep` field of an in-flight dispatch and refresh the
 * TTL so a slow run doesn't disappear mid-flight.
 */
export async function setOperatorDispatchStep(id: string, step: string): Promise<void> {
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.hset(operatorDispatchKey(id), "currentStep", step);
  pipe.expire(operatorDispatchKey(id), TTL_SECONDS);
  pipe.expire(operatorDispatchIndexKey(), TTL_SECONDS);
  await pipe.exec();
}

/**
 * Mark a dispatch as ended — drops the hash AND removes it from the
 * index. Idempotent: calling on an unknown id is a no-op.
 */
export async function endOperatorDispatch(id: string): Promise<void> {
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.del(operatorDispatchKey(id));
  pipe.zrem(operatorDispatchIndexKey(), id);
  await pipe.exec();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List the currently-registered operator dispatches, newest first.
 *
 * The index ZSET is scored by startedEpoch, so ZREVRANGE gives newest-first
 * without any client-side sort. Returns the projected `OperatorDispatch[]`
 * shape — callers don't need to know about hash fields.
 *
 * Best-effort: a row referenced by the index but whose hash has already
 * expired is skipped (rather than throwing) so a partially-expired index
 * can't poison the entire list.
 */
export async function listActiveOperatorDispatches(): Promise<OperatorDispatch[]> {
  const r = getRedisConnection();
  const ids = await r.zrevrange(operatorDispatchIndexKey(), 0, -1);
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const out: OperatorDispatch[] = [];
  for (const id of ids) {
    const row = await r.hgetall(operatorDispatchKey(id));
    if (!row || !row.id || !row.startedAt || !row.classLabel) continue;
    const dispatch: OperatorDispatch = {
      id: row.id,
      classLabel: row.classLabel,
      startedAt: row.startedAt,
    };
    if (row.currentStep) dispatch.currentStep = row.currentStep;
    if (row.issueRef) dispatch.issueRef = row.issueRef;
    if (row.prRef) dispatch.prRef = row.prRef;
    out.push(dispatch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Parses an ISO string into seconds-since-epoch,
 * falling back to "now" when the input is missing or unparseable. The Now-page
 * aggregator doesn't rely on this directly; it's exposed for the round-trip test
 * that asserts the index score lands in a stable place.
 */
export function epochFromIsoOrNow(iso: string | undefined): number {
  if (!iso) return Math.floor(Date.now() / 1000);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}
