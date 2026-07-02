/**
 * Attribution-ledger Redis seam (issue #2629, epic #2628).
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
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`) — no `new Redis()`, no `redis/kv` import
 * outside `src/redis/`. Per CLAUDE.md conventions every function is best-effort:
 * a Redis error is logged with the `[attribution]` prefix and surfaces as a
 * structured result, never a thrown exception (the recorder is read-only with
 * respect to any merge flow).
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Tunables (ADR-0005 — named, env-overridable, not magic literals).
// ---------------------------------------------------------------------------

/**
 * Ledger TTL in seconds. The ledger is append-only and unbounded-by-design;
 * the TTL is the ONLY reaper. 90 days gives the #2630 estimator a comfortably
 * long fitting window while keeping Redis bounded. Env-overridable.
 */
const ATTRIBUTION_LEDGER_TTL_SECONDS = numFromEnv(
  "HYDRA_ATTRIBUTION_LEDGER_TTL_SECONDS",
  90 * 24 * 60 * 60,
);

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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
export function attributionLedgerKey(): string {
  return "hydra:attribution:ledger";
}

/**
 * Open-window state hash (issue #2632). One field per window id, value = JSON
 * {@link AttributionWindow}. A HASH (not a LIST) so an open window is upsertable
 * / removable by id and survives a housekeeping-process restart — the same
 * durability rationale as the pending-enroll registry. This is the ONLY key the
 * window state machine reads/writes; it is NOT part of the append-only ledger
 * (windows are transient — closed windows are DELETED from here after their
 * observation rows land in the ledger).
 */
function attributionWindowsKey(): string {
  return "hydra:attribution:windows";
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

// ---------------------------------------------------------------------------
// Open-window state (issue #2632)
// ---------------------------------------------------------------------------

/**
 * One OPEN per-metric attribution window persisted in Redis so it survives a
 * housekeeping-process restart (issue #2632). Opened when a merge lands, closed
 * when its own `closesAt` elapses. The window carries the BASELINE snapshot
 * captured at open time (mirrors `enrollHoldback`'s per-merge baseline) plus the
 * producer-class merge counts / scope / tier / merge-identity for the closed
 * window's observation rows. One window per LIVE leading metric so each metric
 * closes on its own duration (fast metric ≠ slow metric).
 */
export interface AttributionWindow {
  /** Stable id: `<metric>:<sourceCommitSha|prNumber>` (upsert key in the hash). */
  id: string;
  /** Leading-outcome name this window watches. */
  metric: string;
  /** Baseline value of `metric` captured at window open (null = dark at open). */
  baselineValue: number | null;
  /** Epoch ms the window opened. */
  openedAt: number;
  /** Epoch ms the window closes (open + this metric's configured duration). */
  closesAt: number;
  /** Producer-class → merge count over the window (`{}` = empty window). */
  classCounts: Record<string, number>;
  /** Scope tag of the window's activity. */
  scopeTouched: string;
  /** Representative tier of the window's merges, or null. */
  tier: number | null;
  /** PR numbers whose landing opened this window (for later voiding). */
  sourcePrNumbers: number[];
  /** Representative landing commit SHA, if known. */
  sourceCommitSha: string | null;
}

export type OpenWindowResult = { ok: true } | { ok: false; error: string };
export type ListWindowsResult =
  | { ok: true; windows: AttributionWindow[] }
  | { ok: false; error: string };

/**
 * Open (or upsert) a window, keyed by `window.id`. Idempotent on id: a second
 * open for the same metric+merge overwrites in place, never duplicates. Best-
 * effort — returns a structured result, never throws.
 */
export async function openWindow(window: AttributionWindow): Promise<OpenWindowResult> {
  if (!window.id) return { ok: false, error: "openWindow: id is required" };
  try {
    const r = getRedisConnection();
    await r.hset(attributionWindowsKey(), window.id, JSON.stringify(window));
    return { ok: true };
  } catch (err: any) {
    const msg = `[attribution] openWindow failed for ${window.id}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * List every open window, sorted by `closesAt` ascending for a stable read. A
 * malformed field is skipped (logged) rather than sinking the whole read. Best-
 * effort — returns a structured result, never throws.
 */
export async function listOpenWindows(): Promise<ListWindowsResult> {
  try {
    const r = getRedisConnection();
    const hash = await r.hgetall(attributionWindowsKey());
    const windows: AttributionWindow[] = [];
    for (const [field, raw] of Object.entries(hash) as Array<[string, string]>) {
      try {
        windows.push(JSON.parse(raw) as AttributionWindow);
      } catch (err: any) {
        console.error(
          `[attribution] listOpenWindows: skipping malformed field ${field}: ${err?.message || String(err)}`,
        );
      }
    }
    windows.sort((a, b) => a.closesAt - b.closesAt);
    return { ok: true, windows };
  } catch (err: any) {
    const msg = `[attribution] listOpenWindows failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Remove a window once it has closed (its observation rows have landed in the
 * ledger). Best-effort cleanup — a stale field is harmless (a later close is a
 * no-op) and TTL-free because the hash is small and self-draining.
 */
export async function closeWindow(id: string): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.hdel(attributionWindowsKey(), id);
  } catch (err: any) {
    /* intentional: removing a closed window is best-effort cleanup; a stale
       field just gets re-closed as a no-op on the next tick. */
    console.error(`[attribution] closeWindow failed for ${id}: ${err?.message || String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Reverted-merge registry (issue #2632)
// ---------------------------------------------------------------------------

/**
 * Reverted-merge registry (issue #2632). A single Redis HASH, one field per
 * reverted merge (field = commit SHA when known, else `pr-<n>`), value = JSON
 * {@link RevertedMerge}. This is the DURABLE revert signal the recorder chore
 * consumes to VOID a reverted PR's attribution rows.
 *
 * It is deliberately a registry rather than a live `holdback.reverted` event
 * subscriber: the design (issue #2632) rejects a long-lived EventBus.consume()
 * loop (ADR-0006/0010/0012 — no orphaned recorder). Outcome Holdback marks a
 * merge reverted here (writer side) and the Housekeeping-cadence chore drains it
 * (reader side), appending a compensating void tombstone for each — the same
 * write-a-registry / drain-at-cadence shape the pending-enroll registry uses.
 * TTL-stamped so a drained-but-not-removed entry can't linger forever.
 */
export function attributionRevertedKey(): string {
  return "hydra:attribution:reverted";
}

/**
 * A merge Outcome Holdback reverted (issue #2632). The recorder chore drains
 * these and appends one {@link VoidMarker} per entry, then removes it.
 */
export interface RevertedMerge {
  /** PR number of the reverted merge, if known. */
  prNumber: number | null;
  /** Commit SHA of the reverted merge, if known. */
  commitSha: string | null;
  /** Epoch ms the revert was recorded. */
  revertedAt: number;
}

export type MarkRevertedResult = { ok: true } | { ok: false; error: string };
export type ListRevertedResult =
  | { ok: true; reverts: RevertedMerge[] }
  | { ok: false; error: string };

/** Registry-entry field key for a reverted merge (SHA preferred, else `pr-<n>`). */
function revertedField(entry: { commitSha: string | null; prNumber: number | null }): string | null {
  if (entry.commitSha && entry.commitSha.length > 0) return entry.commitSha;
  if (entry.prNumber != null) return `pr-${entry.prNumber}`;
  return null;
}

/**
 * Register a merge as reverted so the recorder chore voids its attribution rows
 * (issue #2632). Idempotent on the merge key. Best-effort — returns a structured
 * result, never throws (this only records intent; it never reverts anything).
 */
export async function markMergeReverted(entry: RevertedMerge): Promise<MarkRevertedResult> {
  const field = revertedField(entry);
  if (field == null) {
    return { ok: false, error: "markMergeReverted: commitSha or prNumber is required" };
  }
  try {
    const r = getRedisConnection();
    const key = attributionRevertedKey();
    await r.hset(key, field, JSON.stringify(entry));
    await r.expire(key, ATTRIBUTION_LEDGER_TTL_SECONDS);
    return { ok: true };
  } catch (err: any) {
    const msg = `[attribution] markMergeReverted failed for ${field}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * List every pending reverted-merge entry. A malformed field is skipped
 * (logged). Best-effort — returns a structured result, never throws.
 */
export async function listRevertedMerges(): Promise<ListRevertedResult> {
  try {
    const r = getRedisConnection();
    const hash = await r.hgetall(attributionRevertedKey());
    const reverts: RevertedMerge[] = [];
    for (const [field, raw] of Object.entries(hash) as Array<[string, string]>) {
      try {
        reverts.push(JSON.parse(raw) as RevertedMerge);
      } catch (err: any) {
        console.error(
          `[attribution] listRevertedMerges: skipping malformed field ${field}: ${err?.message || String(err)}`,
        );
      }
    }
    return { ok: true, reverts };
  } catch (err: any) {
    const msg = `[attribution] listRevertedMerges failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Remove a reverted-merge entry once its void tombstone has been appended.
 * Best-effort cleanup — a stale entry just re-appends an (idempotent) void on
 * the next tick, which the estimator dedupes by merge identity.
 */
export async function removeRevertedMerge(
  entry: { commitSha: string | null; prNumber: number | null },
): Promise<void> {
  const field = revertedField(entry);
  if (field == null) return;
  try {
    const r = getRedisConnection();
    await r.hdel(attributionRevertedKey(), field);
  } catch (err: any) {
    /* intentional: removing a drained revert entry is best-effort cleanup; a
       stale entry re-appends an idempotent void next tick. */
    console.error(`[attribution] removeRevertedMerge failed for ${field}: ${err?.message || String(err)}`);
  }
}

/** Test-only: clear the ledger. */
export async function _resetLedger(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionLedgerKey());
}

/** Test-only: clear the open-window state. */
export async function _resetWindows(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionWindowsKey());
}

/** Test-only: clear the reverted-merge registry. */
export async function _resetReverted(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionRevertedKey());
}
