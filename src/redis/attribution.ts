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
}

export type AppendObservationResult =
  | { ok: true }
  | { ok: false; error: string };

export type LoadObservationsResult =
  | { ok: true; observations: AttributionObservation[] }
  | { ok: false; error: string };

/**
 * The append-only ledger seam the recorder writes through. Extracted as an
 * interface so the recorder's policy (deriving rows from two snapshots) can be
 * unit-tested against a fake seam without a live Redis.
 */
export interface AttributionLedger {
  appendObservation(obs: AttributionObservation): Promise<AppendObservationResult>;
  getObservations(): Promise<LoadObservationsResult>;
}

// ---------------------------------------------------------------------------
// Key builder (ADR-0009 — key shape lives in the seam).
// ---------------------------------------------------------------------------

/** The single append-only ledger list key. JSON `AttributionObservation` rows. */
export function attributionLedgerKey(): string {
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
 * Read the full ledger history (`lrange key 0 -1`) — never a bounded slice.
 * Malformed rows are skipped (logged), so one corrupt entry can't sink a read.
 * Best-effort — returns a structured result, never throws.
 */
export async function getObservations(): Promise<LoadObservationsResult> {
  try {
    const r = getRedisConnection();
    const raw: string[] = await r.lrange(attributionLedgerKey(), 0, -1);
    const observations: AttributionObservation[] = [];
    for (const entry of raw) {
      try {
        observations.push(JSON.parse(entry) as AttributionObservation);
      } catch (parseErr: any) {
        /* intentional: skip a single malformed row rather than fail the whole
           read — the ledger is append-only, so a bad row can't be repaired
           here and must not block the estimator from reading the good rows. */
        console.error(
          `[attribution] getObservations: skipping malformed row: ${parseErr?.message || String(parseErr)}`,
        );
      }
    }
    return { ok: true, observations };
  } catch (err: any) {
    const msg = `[attribution] getObservations failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * The live Redis-backed ledger. Passed into the recorder in production; tests
 * pass a fake implementing {@link AttributionLedger}.
 */
export const redisAttributionLedger: AttributionLedger = {
  appendObservation,
  getObservations,
};

/** Test-only: clear the ledger. */
export async function _resetLedger(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionLedgerKey());
}
