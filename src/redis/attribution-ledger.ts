/**
 * Attribution-ledger Redis seam (issue #2629, epic #2628; split out of the
 * former mixed-concern `attribution.ts` in issue #2916).
 *
 * The **outcome-attribution spine** records ONE raw observation per live leading
 * outcome per closed watch-window: `{metric, delta, classCounts, scopeTouched,
 * tier}`. Those rows are the raw input the later marginal-effect estimator
 * (#2630) fits a ridge regression over to assign per-producer-class credit — so
 * the ledger MUST be append-only and retain the full history: no row is ever
 * mutated, trimmed, or deleted.
 *
 * This seam therefore exposes exactly two operations — append (`rpush`) and
 * read-all (`lrange key 0 -1`) — mirroring `src/redis/reflections.ts`
 * (`pushAnchorReflection` / `getAnchorReflections`), NOT the bounded-list
 * primitive (ADR-0017 `boundedJsonList`), which `ltrim`s to a max length and
 * would silently drop the oldest observations the estimator needs. There is no
 * `lset` / `ltrim` / `lrem` here by design; a generous TTL is the only reaper.
 *
 * This module owns ONLY the append-only observation ledger (a Redis LIST). The
 * per-metric window hash lives in `attribution-windows.ts`; the reverted-merge
 * registry lives in `attribution-reverted.ts`. The void tombstone stays here
 * because a `VoidMarker` IS a ledger row (the void/observation discrimination is
 * ledger-internal semantics, not a cross-module concern).
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`) — no `new Redis()`, no `redis/kv` import
 * outside `src/redis/`. Per CLAUDE.md conventions every function is best-effort:
 * a Redis error is logged with the `[attribution]` prefix and surfaces as a
 * structured result, never a thrown exception (the recorder is read-only with
 * respect to any merge flow).
 */

import { getRedisConnection } from "./connection.ts";
import { ATTRIBUTION_LEDGER_TTL_SECONDS } from "./attribution-constants.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One raw attribution observation: a single leading metric's window delta,
 * tagged with the producer-class merge counts and diff metadata for that
 * window. This is the estimator's raw input row (#2630) — intentionally RAW:
 * no write-time credit split (the parent epic rejects biased write-time splits;
 * credit is assigned later by ridge regression over many rows).
 */
export interface AttributionObservation {
  /** Leading-outcome name this delta belongs to. */
  metric: string;
  /** `current - baseline` for `metric` over the window. */
  delta: number;
  /**
   * Producer-class → merge count in the window. `{}` for an empty (zero-merge)
   * window — the null-model / exogenous-drift baseline the estimator needs.
   */
  classCounts: Record<string, number>;
  /** Scope tag of the window's activity. */
  scopeTouched: string;
  /** Representative tier of the window's merges, or null (e.g. empty window). */
  tier: number | null;
  /** Epoch ms the observation was recorded. */
  recordedAt: number;
  /**
   * Merge-identity of the contributing merge(s) that opened this window
   * (issue #2632). Needed so a later Outcome-Holdback REVERT of that merge can
   * VOID this row by name (see {@link VoidMarker}). Optional to stay
   * backward-compatible with the #2629 rows that predate this field: an
   * observation with no source identity simply cannot be voided (it was never
   * merge-scoped). `sourcePrNumbers` is the set of PRs whose landing opened the
   * window. Additive — the raw-delta / no-write-time-credit-split invariant is
   * unchanged.
   */
  sourcePrNumbers?: number[];
  /** Representative landing commit SHA of the contributing merge, if known. */
  sourceCommitSha?: string | null;
}

/**
 * A compensating VOID tombstone appended to the ledger (issue #2632) when
 * Outcome Holdback REVERTS a merge whose window already produced observation
 * rows. The ledger is append-only by design (#2629 forbids lset/ltrim/lrem/del
 * so the #2630 estimator keeps full history), so a reverted PR's rows are NOT
 * deleted — instead this marker is APPENDED, naming the reverted PR / commit so
 * the estimator can EXCLUDE the matching observations when it fits. Discriminated
 * from an observation by `kind: "void"`.
 */
export interface VoidMarker {
  /** Discriminant separating a tombstone from an {@link AttributionObservation}. */
  kind: "void";
  /** PR number of the reverted merge whose observation rows this voids. */
  voidedPrNumber: number | null;
  /** Commit SHA of the reverted merge, if known. */
  voidedCommitSha: string | null;
  /** Why the void was appended (e.g. "holdback-revert"). */
  reason: string;
  /** Epoch ms the void marker was recorded. */
  recordedAt: number;
}

/**
 * A ledger row is either a raw observation or a compensating void tombstone.
 * Discriminate on `kind`: a {@link VoidMarker} carries `kind:"void"`; an
 * {@link AttributionObservation} has no `kind`. Kept a union so `getLedger`
 * returns the full append-only history and the estimator (#2630) applies the
 * tombstones itself.
 */
export type LedgerRow = AttributionObservation | VoidMarker;

/** True when a ledger row is a compensating void tombstone (issue #2632). */
export function isVoidMarker(row: LedgerRow): row is VoidMarker {
  return (row as VoidMarker).kind === "void";
}

export type AppendObservationResult =
  | { ok: true }
  | { ok: false; error: string };

export type LoadObservationsResult =
  | { ok: true; observations: AttributionObservation[] }
  | { ok: false; error: string };

/** Result of reading the full ledger history (observations + void markers). */
export type LoadLedgerResult =
  | { ok: true; rows: LedgerRow[] }
  | { ok: false; error: string };

/**
 * The append-only ledger seam the recorder writes through. Extracted as an
 * interface so the recorder's policy (deriving rows from two snapshots) can be
 * unit-tested against a fake seam without a live Redis.
 *
 * Issue #2632 extends the seam with {@link appendVoidMarker} — still an APPEND
 * (never a delete/trim), so the append-only invariant holds — so the recorder
 * chore can void a reverted PR's rows by appending a tombstone.
 */
export interface AttributionLedger {
  appendObservation(obs: AttributionObservation): Promise<AppendObservationResult>;
  getObservations(): Promise<LoadObservationsResult>;
  /** Append a compensating void tombstone (issue #2632). Still append-only. */
  appendVoidMarker(marker: VoidMarker): Promise<AppendObservationResult>;
}

// ---------------------------------------------------------------------------
// Key builder (ADR-0009 — key shape lives in the seam).
// ---------------------------------------------------------------------------

/** The single append-only ledger list key. JSON {@link LedgerRow} rows. */
function attributionLedgerKey(): string {
  return "hydra:attribution:ledger";
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Append one observation row to the ledger (rpush) and re-stamp the TTL.
 * Append-only: no trim, no overwrite. Best-effort — returns a structured
 * result, never throws.
 */
export async function appendObservation(
  obs: AttributionObservation,
): Promise<AppendObservationResult> {
  try {
    const r = getRedisConnection();
    const key = attributionLedgerKey();
    await r.rpush(key, JSON.stringify(obs));
    await r.expire(key, ATTRIBUTION_LEDGER_TTL_SECONDS);
    return { ok: true };
  } catch (err: any) {
    const msg = `[attribution] appendObservation failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Append a compensating VOID tombstone to the ledger (issue #2632). Still an
 * `rpush` — append-only, no trim/overwrite — so the #2629 invariant holds: a
 * reverted PR's observation rows stay in place; this marker names them so the
 * #2630 estimator excludes them. Best-effort — returns a structured result,
 * never throws.
 */
export async function appendVoidMarker(
  marker: VoidMarker,
): Promise<AppendObservationResult> {
  try {
    const r = getRedisConnection();
    const key = attributionLedgerKey();
    await r.rpush(key, JSON.stringify(marker));
    await r.expire(key, ATTRIBUTION_LEDGER_TTL_SECONDS);
    return { ok: true };
  } catch (err: any) {
    const msg = `[attribution] appendVoidMarker failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Read the full ledger history (`lrange key 0 -1`) — observations AND void
 * tombstones, in append order. Never a bounded slice; malformed rows are skipped
 * (logged). Best-effort — returns a structured result, never throws.
 */
export async function getLedger(): Promise<LoadLedgerResult> {
  try {
    const r = getRedisConnection();
    const raw: string[] = await r.lrange(attributionLedgerKey(), 0, -1);
    const rows: LedgerRow[] = [];
    for (const entry of raw) {
      try {
        rows.push(JSON.parse(entry) as LedgerRow);
      } catch (parseErr: any) {
        /* intentional: skip a single malformed row rather than fail the whole
           read — the ledger is append-only, so a bad row can't be repaired
           here and must not block the estimator from reading the good rows. */
        console.error(
          `[attribution] getLedger: skipping malformed row: ${parseErr?.message || String(parseErr)}`,
        );
      }
    }
    return { ok: true, rows };
  } catch (err: any) {
    const msg = `[attribution] getLedger failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Read the observation rows only (`lrange key 0 -1`, void tombstones filtered
 * out). Preserves the #2629 `getObservations` contract — callers that only want
 * the raw observation rows are unaffected by the #2632 void-marker addition.
 * Malformed rows are skipped (logged). Best-effort — never throws.
 */
export async function getObservations(): Promise<LoadObservationsResult> {
  const loaded = await getLedger();
  if (loaded.ok === false) return { ok: false, error: loaded.error };
  const observations = loaded.rows.filter(
    (row): row is AttributionObservation => !isVoidMarker(row),
  );
  return { ok: true, observations };
}

/**
 * The live Redis-backed ledger. Passed into the recorder in production; tests
 * pass a fake implementing {@link AttributionLedger}.
 */
export const redisAttributionLedger: AttributionLedger = {
  appendObservation,
  getObservations,
  appendVoidMarker,
};

/** Test-only: clear the ledger. */
export async function _resetLedger(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionLedgerKey());
}
