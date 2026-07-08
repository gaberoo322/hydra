/**
 * Per-dispatch outcome-record Redis seam (issue #2942, follow-on to the
 * Outcome Attribution Spine epic #2628).
 *
 * The **dispatch-outcome record** is the durable join the run/turn writers and
 * the cycle-close coordinator never persisted together: one row per
 * cycle-record-bearing dispatch — `{cycleId, runIdPrefix, turn, class, skill,
 * outcome, tokens, durationMs, recordedAt}` — written at reap time by
 * `recordCycle` (`src/autopilot/cycle-close.ts`), so "class X merges Y% of its
 * dispatches at Z tokens each" is answerable from a durable store instead of
 * being re-derived per read (`fetchTurnsWithJoins`) or re-inferred per retro.
 *
 * Storage shape (mirrors `cycle-tracking.ts`, NOT the append-only
 * `attribution-ledger.ts` LIST — this record needs one in-place
 * completed→merged outcome upgrade, and the issue requires capped length +
 * TTL, the opposite invariant of the ledger's never-trim rule):
 *
 *   - `hydra:autopilot:dispatch-outcome:<cycleId>` — HASH, one per record.
 *     Hash-per-record gives natural per-record addressability for the
 *     issue-2860 completed→merged upgrade (an atomic additive HSET, no
 *     scan+ZREM+ZADD race).
 *   - `hydra:autopilot:dispatch-outcomes:index` — ZSET scored by `recordedAt`
 *     epoch-ms, capped to the newest {@link DISPATCH_OUTCOMES_INDEX_MAX}
 *     members via ZREMRANGEBYRANK at write time.
 *
 * Bounded growth (issue AC2): both keys carry a 14-day TTL (the top of the
 * issue's 7–14d band, so a record comfortably outlives the 7d run/cycle TTLs
 * it joins against and gives the #2943 scoreboard a two-week scoring window).
 * TTL is the primary reaper; the index cap is a runaway safety valve
 * (~10–40 dispatches/day observed, so ~2 weeks of records is well under the
 * cap in normal operation).
 *
 * Dark-tolerant fields: an unparseable cycleId, absent tokens, or unknown
 * class record as `null` — a record is never dropped and never fabricated
 * (mirrors the spine's no-write-time-credit-split discipline, epic #2628).
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`); key shapes live here, in the seam. Every
 * function is best-effort: a Redis error is logged with the
 * `[dispatch-outcomes]` prefix and surfaces as a structured result, never a
 * thrown exception (the writer sits on the reap path, which must never block).
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One durable per-dispatch outcome record. Nullable fields are the
 * dark-tolerant arms: a bare-UUID cycleId (the qa_orch relay write) parses no
 * run/turn/class; tokens are null when neither the cycle-record POST nor the
 * per-cycle token hash knew a figure.
 */
export interface DispatchOutcomeRecord {
  /** The cycle id the record is keyed on (the autopilot dispatch task_id). */
  cycleId: string;
  /**
   * First 8 hex chars of the DISPATCHING run's run_id, parsed from the
   * cycleId (`worktree-agent-<prefix>-t<N>-<class>`). Null when unparseable.
   * The cycleId-embedded prefix — not the currently-active run — attributes
   * the record to the run whose DECISION is being scored (the #1903 handoff
   * baton-pass routinely has the next run reap a prior run's dispatch).
   */
  runIdPrefix: string | null;
  /** Autopilot turn number the dispatch was made on. Null when unparseable. */
  turn: number | null;
  /** Dispatch class (`dev_orch`, ...). Null when unparseable. */
  className: string | null;
  /** Skill the class dispatches (taxonomy join). Null when class unknown. */
  skill: string | null;
  /**
   * The cycle-hash `status` verbatim (completed/merged/failed/abandoned/...),
   * kept in lockstep with the hash including the issue-2860 completed→merged
   * upgrade. Consumers bucket via `bucketCycleStatus` or their own
   * class-appropriate policy — recordCycle never invents a write-time
   * judgment (epic #2628 rejects biased write-time splits).
   */
  outcome: string;
  /** Total tokens the dispatch consumed, when known. Null = unknown. */
  tokens: number | null;
  /** Wall-clock dispatch span in ms, when known. Null = unknown. */
  durationMs: number | null;
  /** Epoch ms the record was written. */
  recordedAt: number;
}

/** The in-place upgradeable subset (the issue-2860 completed→merged path). */
export interface DispatchOutcomePatch {
  outcome?: string;
  tokens?: number;
  durationMs?: number;
}

export type DispatchOutcomeWriteResult = { ok: true } | { ok: false; error: string };

export type DispatchOutcomeListResult =
  | { ok: true; records: DispatchOutcomeRecord[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Key builders + bounds (ADR-0009 — key shape lives in the seam)
// ---------------------------------------------------------------------------

/** Per-record hash key. */
export function dispatchOutcomeKey(cycleId: string): string {
  return `hydra:autopilot:dispatch-outcome:${cycleId}`;
}

/** The recordedAt-scored ZSET index of record cycleIds. */
export function dispatchOutcomesIndexKey(): string {
  return "hydra:autopilot:dispatch-outcomes:index";
}

/** 14-day TTL on both the per-record hash and the index (issue AC2). */
export const DISPATCH_OUTCOME_TTL_SECONDS = 14 * 24 * 3600;

/** Index hard cap — newest N members survive the write-time trim. */
const DISPATCH_OUTCOMES_INDEX_MAX = 2000;

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/** Hash-field encoding: null fields are OMITTED (truthful "unknown"). */
function encodeRecord(record: DispatchOutcomeRecord): Record<string, string> {
  const fields: Record<string, string> = {
    cycleId: record.cycleId,
    outcome: record.outcome,
    recordedAt: String(record.recordedAt),
  };
  if (record.runIdPrefix !== null) fields.runIdPrefix = record.runIdPrefix;
  if (record.turn !== null) fields.turn = String(record.turn);
  if (record.className !== null) fields.class = record.className;
  if (record.skill !== null) fields.skill = record.skill;
  if (record.tokens !== null) fields.tokens = String(record.tokens);
  if (record.durationMs !== null) fields.durationMs = String(record.durationMs);
  return fields;
}

function intOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * Decode a stored hash back into a record. `cycleId` comes from the INDEX
 * member (authoritative), so a partial hash (e.g. an upgrade that recreated
 * an expired record) still decodes with its identity intact. Returns null for
 * an empty hash (expired record whose index member outlived it).
 */
function decodeRecord(
  cycleId: string,
  hash: Record<string, string>,
): DispatchOutcomeRecord | null {
  if (!hash || Object.keys(hash).length === 0) return null;
  return {
    cycleId,
    runIdPrefix: hash.runIdPrefix ?? null,
    turn: intOrNull(hash.turn),
    className: hash.class ?? null,
    skill: hash.skill ?? null,
    outcome: hash.outcome ?? "unknown",
    tokens: intOrNull(hash.tokens),
    durationMs: intOrNull(hash.durationMs),
    recordedAt: intOrNull(hash.recordedAt) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Persist one dispatch-outcome record: hash write + index ZADD + write-time
 * index trim + TTLs, in a single pipeline. Idempotency is the CALLER's
 * concern (`recordCycle` only puts on its first-write path, so duplicate
 * cycle-record posts never create a second record).
 *
 * `indexMax` is injectable so tests can exercise the trim without 2000 rows.
 * Best-effort — returns a structured result, never throws.
 */
export async function putDispatchOutcome(
  record: DispatchOutcomeRecord,
  indexMax: number = DISPATCH_OUTCOMES_INDEX_MAX,
): Promise<DispatchOutcomeWriteResult> {
  try {
    const r = getRedisConnection();
    const key = dispatchOutcomeKey(record.cycleId);
    const indexKey = dispatchOutcomesIndexKey();
    const pipe = r.pipeline();
    pipe.hset(key, ...Object.entries(encodeRecord(record)).flat());
    pipe.expire(key, DISPATCH_OUTCOME_TTL_SECONDS);
    pipe.zadd(indexKey, record.recordedAt, record.cycleId);
    // Cap the index to the newest `indexMax` members (rank 0 is the OLDEST in
    // a ZSET, so trimming ranks [0, -(max+1)] keeps the newest max members).
    pipe.zremrangebyrank(indexKey, 0, -(indexMax + 1));
    pipe.expire(indexKey, DISPATCH_OUTCOME_TTL_SECONDS);
    await pipe.exec();
    return { ok: true };
  } catch (err: any) {
    const msg = `[dispatch-outcomes] putDispatchOutcome failed for cycle=${record.cycleId}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Additive HSET upgrade of an existing record — the issue-2860
 * completed→merged path (and its tokens/duration enrichment). Never
 * re-initialises the record and never touches the index score (the record's
 * recordedAt identity is its FIRST write).
 *
 * TTL leak backstop (mirrors `updateCycleHash`, issue #2926): a bare HSET on
 * a key whose TTL already lapsed would recreate it expiry-less, so after the
 * write we re-apply the standard window only when the key has none
 * (`ttl === -1`). A live TTL is left untouched so upgrades never extend the
 * record's lifetime.
 *
 * Best-effort — returns a structured result, never throws.
 */
export async function upgradeDispatchOutcome(
  cycleId: string,
  patch: DispatchOutcomePatch,
): Promise<DispatchOutcomeWriteResult> {
  try {
    const fields: Record<string, string> = {};
    if (patch.outcome !== undefined) fields.outcome = patch.outcome;
    if (patch.tokens !== undefined) fields.tokens = String(patch.tokens);
    if (patch.durationMs !== undefined) fields.durationMs = String(patch.durationMs);
    if (Object.keys(fields).length === 0) return { ok: true };
    const r = getRedisConnection();
    const key = dispatchOutcomeKey(cycleId);
    await r.hset(key, ...Object.entries(fields).flat());
    const ttl = await r.ttl(key);
    if (ttl === -1) {
      await r.expire(key, DISPATCH_OUTCOME_TTL_SECONDS);
    }
    return { ok: true };
  } catch (err: any) {
    const msg = `[dispatch-outcomes] upgradeDispatchOutcome failed for cycle=${cycleId}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Pipelined decode of the index members in `cycleIds` order, skipping index
 * members whose hash already expired (TTL-reaped records).
 */
async function readRecords(cycleIds: string[]): Promise<DispatchOutcomeRecord[]> {
  if (cycleIds.length === 0) return [];
  const r = getRedisConnection();
  const pipe = r.pipeline();
  for (const cid of cycleIds) pipe.hgetall(dispatchOutcomeKey(cid));
  const results = await pipe.exec();
  const records: DispatchOutcomeRecord[] = [];
  cycleIds.forEach((cid, i) => {
    const entry = results?.[i];
    const hash = entry && Array.isArray(entry) ? entry[1] : null;
    if (hash && typeof hash === "object") {
      const decoded = decodeRecord(cid, hash as Record<string, string>);
      if (decoded) records.push(decoded);
    }
  });
  return records;
}

/**
 * All records attributed to `runId` — matched on the record's cycleId-embedded
 * 8-char run prefix (`runId.slice(0, 8)`), newest-first. Records with a null
 * `runIdPrefix` (unparseable cycleIds) never match a run read; they remain
 * reachable via {@link listDispatchOutcomes}. Best-effort — never throws.
 */
export async function getDispatchOutcomesForRun(
  runId: string,
): Promise<DispatchOutcomeListResult> {
  try {
    const prefix = runId.slice(0, 8).toLowerCase();
    const r = getRedisConnection();
    // Newest-first walk of the (capped, ≤ DISPATCH_OUTCOMES_INDEX_MAX) index.
    const cycleIds: string[] = await r.zrevrange(dispatchOutcomesIndexKey(), 0, -1);
    const records = await readRecords(cycleIds);
    return { ok: true, records: records.filter((rec) => rec.runIdPrefix === prefix) };
  } catch (err: any) {
    const msg = `[dispatch-outcomes] getDispatchOutcomesForRun failed for run=${runId}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Rolling-window read: every record with `recordedAt >= sinceMs`, newest-first
 * — the cross-run surface the #2943 class scoreboard consumes. Best-effort —
 * never throws.
 */
export async function listDispatchOutcomes(opts: {
  sinceMs: number;
}): Promise<DispatchOutcomeListResult> {
  try {
    const r = getRedisConnection();
    const cycleIds: string[] = await r.zrevrangebyscore(
      dispatchOutcomesIndexKey(),
      "+inf",
      opts.sinceMs,
    );
    const records = await readRecords(cycleIds);
    return { ok: true, records };
  } catch (err: any) {
    const msg = `[dispatch-outcomes] listDispatchOutcomes failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}
