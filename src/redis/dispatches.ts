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

// ===========================================================================
// Subagent dispatch namespace (issue #692, PRD #690)
// ===========================================================================
//
// Sibling to the operator namespace above. Where the operator namespace
// tracks human-launched `claude` sessions, this tracks every *subagent*
// session the autopilot (or an operator) dispatches via the Agent tool. The
// SessionStart hook (`scripts/hooks/session-start-capture.sh`) scrapes a
// hidden sentinel out of the session JSONL's first user message and POSTs it
// to `POST /api/dispatches/subagent`, which lands here.
//
// # Why a separate namespace (not a `source` field on the operator one)
//
// - The operator namespace is keyed on a caller-chosen `id`; the subagent
//   namespace is keyed on the harness-assigned `sessionId`. Mixing the two
//   keying schemes into one index would make the dedup/expiry semantics
//   ambiguous.
// - Subagent rows carry extra fields the operator rows don't (`skill`,
//   `dispatchId`, `runId`, `projectDir`) that join a session back to the
//   autopilot turn that launched it. Keeping them in their own hash shape
//   avoids polluting the operator row contract.
//
// # Schema
//
//   hydra:dispatches:subagent:{sessionId}  — hash, fields below, 24h TTL
//   hydra:dispatches:subagent:index        — sorted set scored by startedEpoch
//
// Hash fields (all strings):
//
//   sessionId    — harness session id (the JSONL filename stem) — the key
//   skill        — dispatched skill name ("hydra-dev", "hydra-grill", ...)
//   dispatchId   — stable per-dispatch id (the synthesised worktree branch)
//   runId        — optional autopilot run id (omitted for operator launches)
//   startedAt    — ISO timestamp
//   projectDir   — optional cwd / worktree path
//   currentStep  — optional free-form step (last write wins)
//   issueRef     — optional "#N" or "owner/repo#N"
//   prRef        — optional "#N" or "owner/repo#N"
//
// The keys are inlined here (rather than `./keys.ts`) for exactly the same
// reason the operator builders above are — the seam-check is happy with
// builders that live in `src/redis/`, and inlining keeps the sibling pattern
// symmetric. `keys.ts` reserves the namespace prefix in a comment so the two
// stay coordinated.

export function subagentDispatchKey(sessionId: string): string {
  return `hydra:dispatches:subagent:${sessionId}`;
}

export function subagentDispatchIndexKey(): string {
  return "hydra:dispatches:subagent:index";
}

export interface SubagentDispatch {
  sessionId: string;
  skill: string;
  dispatchId: string;
  startedAt: string;
  runId?: string;
  projectDir?: string;
  currentStep?: string;
  issueRef?: string;
  prRef?: string;
}

/**
 * Register (or overwrite) a subagent dispatch row. Keyed on `sessionId`.
 * Re-registering the same sessionId is idempotent — the hook may fire more
 * than once for a session (SessionStart + resume), and a re-register lands
 * the same row and keeps the index score in place (ZADD without XX/NX), so
 * the "hook is idempotent" acceptance criterion holds.
 */
export async function registerSubagentDispatch(
  dispatch: SubagentDispatch,
): Promise<void> {
  const r = getRedisConnection();
  const key = subagentDispatchKey(dispatch.sessionId);
  const fields: Record<string, string> = {
    sessionId: dispatch.sessionId,
    skill: dispatch.skill,
    dispatchId: dispatch.dispatchId,
    startedAt: dispatch.startedAt,
  };
  if (dispatch.runId !== undefined) fields.runId = dispatch.runId;
  if (dispatch.projectDir !== undefined) fields.projectDir = dispatch.projectDir;
  if (dispatch.currentStep !== undefined) fields.currentStep = dispatch.currentStep;
  if (dispatch.issueRef !== undefined) fields.issueRef = dispatch.issueRef;
  if (dispatch.prRef !== undefined) fields.prRef = dispatch.prRef;

  const startedEpoch = epochFromIsoOrNow(dispatch.startedAt);

  const pipe = r.pipeline();
  pipe.hset(key, ...Object.entries(fields).flat());
  pipe.expire(key, TTL_SECONDS);
  pipe.zadd(subagentDispatchIndexKey(), startedEpoch, dispatch.sessionId);
  pipe.expire(subagentDispatchIndexKey(), TTL_SECONDS);
  await pipe.exec();
}

/**
 * Patch the `currentStep` of an in-flight subagent dispatch and refresh the
 * TTL. Idempotent on an unknown sessionId — the HSET simply creates the
 * field on a (possibly already-expired) hash; callers that care about
 * existence should `getSubagentDispatch` first. We intentionally do NOT
 * re-add to the index here: a step update on a row whose hash expired
 * shouldn't resurrect an index entry that `endSubagentDispatch` removed.
 */
export async function setSubagentDispatchStep(
  sessionId: string,
  step: string,
): Promise<void> {
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.hset(subagentDispatchKey(sessionId), "currentStep", step);
  pipe.expire(subagentDispatchKey(sessionId), TTL_SECONDS);
  pipe.expire(subagentDispatchIndexKey(), TTL_SECONDS);
  await pipe.exec();
}

/**
 * Mark a subagent dispatch ended — drops the hash AND removes it from the
 * index. Idempotent: calling on an unknown sessionId is a no-op.
 */
export async function endSubagentDispatch(sessionId: string): Promise<void> {
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.del(subagentDispatchKey(sessionId));
  pipe.zrem(subagentDispatchIndexKey(), sessionId);
  await pipe.exec();
}

/**
 * Fetch a single subagent dispatch by sessionId, or null if absent/expired.
 */
export async function getSubagentDispatch(
  sessionId: string,
): Promise<SubagentDispatch | null> {
  const r = getRedisConnection();
  const row = await r.hgetall(subagentDispatchKey(sessionId));
  return projectSubagentRow(row);
}

/**
 * List the currently-registered subagent dispatches, newest first.
 * Mirrors `listActiveOperatorDispatches`: index ZSET scored by startedEpoch,
 * ZREVRANGE for newest-first, partial-row tolerant (an index entry whose hash
 * expired is skipped rather than throwing).
 */
export async function listActiveSubagentDispatches(): Promise<SubagentDispatch[]> {
  const r = getRedisConnection();
  const ids = await r.zrevrange(subagentDispatchIndexKey(), 0, -1);
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const out: SubagentDispatch[] = [];
  for (const id of ids) {
    const row = await r.hgetall(subagentDispatchKey(id));
    const projected = projectSubagentRow(row);
    if (projected) out.push(projected);
  }
  return out;
}

/**
 * Pure helper — exported for tests. Projects a raw Redis hash into the
 * `SubagentDispatch` shape, returning null when the row is missing the
 * required identity fields (so a partially-expired hash is skipped on read).
 */
export function projectSubagentRow(
  row: Record<string, string> | null | undefined,
): SubagentDispatch | null {
  if (!row || !row.sessionId || !row.skill || !row.dispatchId || !row.startedAt) {
    return null;
  }
  const dispatch: SubagentDispatch = {
    sessionId: row.sessionId,
    skill: row.skill,
    dispatchId: row.dispatchId,
    startedAt: row.startedAt,
  };
  if (row.runId) dispatch.runId = row.runId;
  if (row.projectDir) dispatch.projectDir = row.projectDir;
  if (row.currentStep) dispatch.currentStep = row.currentStep;
  if (row.issueRef) dispatch.issueRef = row.issueRef;
  if (row.prRef) dispatch.prRef = row.prRef;
  return dispatch;
}
