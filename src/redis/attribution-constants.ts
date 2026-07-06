/**
 * Shared internal tunables for the attribution Redis seams (issue #2916).
 *
 * Extracted so the ledger adapter (`attribution-ledger.ts`) and the
 * reverted-merge registry (`attribution-reverted.ts`) share ONE TTL policy
 * without one importing the other's keyspace (issue #2632 originally colocated
 * these in the single 516-line `attribution.ts`; the split keeps the value
 * DRY rather than duplicating it by hand). This module holds NO Redis keys and
 * touches NO connection — it is a pure tunables constant, so it does not create
 * a cross-module keyspace coupling.
 *
 * The window hash (`attribution-windows.ts`) deliberately does NOT use this TTL:
 * open windows are transient and self-draining (closed windows are `hdel`'d
 * after their observation rows land), so the window hash keeps its no-TTL
 * policy on purpose.
 */

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Ledger TTL in seconds. The ledger is append-only and unbounded-by-design;
 * the TTL is the ONLY reaper. 90 days gives the #2630 estimator a comfortably
 * long fitting window while keeping Redis bounded. Env-overridable. Also stamps
 * the reverted-merge registry so a drained-but-not-removed entry can't linger.
 */
export const ATTRIBUTION_LEDGER_TTL_SECONDS = numFromEnv(
  "HYDRA_ATTRIBUTION_LEDGER_TTL_SECONDS",
  90 * 24 * 60 * 60,
);
