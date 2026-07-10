/**
 * Retro-bundle **pure projections** — the stable public entry surface of the
 * side-effect-free derivation logic that powers the per-run retrospective
 * bundle (issue #918, epic #917).
 *
 * Issue #3090 split the former 604-line combined module into two focused concern
 * leaves plus a shared type leaf, then reduced this file to a pure re-export
 * relay (the same pattern as `run-health.ts` / `health-signals/`) so the
 * consumers — `retro-bundle.ts`, `retro-enrichment.ts`, and the two test files
 * — keep importing every symbol from `./retro-projections.ts` with ZERO
 * import-path churn. The relay holds no logic of its own.
 *
 * The pure surface now lives in three leaves under `src/autopilot/`:
 *   - `retro-dispatch-types.ts`      — the zero-IO `RetroDispatch` type leaf,
 *     the ONLY surface shared by the two concern modules. Both import it DOWN
 *     from here; there is no lateral classifier ⇄ cycle-identity import edge.
 *   - `retro-dispatch-classifier.ts` — dispatch-bucket classification:
 *     `projectDispatches`, `flagDispatchesForDrill`, `bucketOf` (+ the private
 *     slot helpers). Characterizes an *individual* dispatch's outcome.
 *   - `retro-cycle-identity.ts`      — cross-run cycle-id dedup + the
 *     PROVISIONAL→CONFIRMED confirmation protocol: `dedupByCanonicalCycleId`,
 *     `collectProvisionalCycleIds`, `confirmDrillableCycleIds`. Groups
 *     dispatches across runs by canonical identity.
 *
 * Everything relayed here is pure: zero Redis imports, zero `await`, no clock
 * beyond caller-supplied input — purity is enforced by the import boundary of
 * each leaf, not merely documented (issue #2341 retired the older back-compat
 * relay through `retro-bundle.ts`; this relay preserves the public surface at
 * this path while the concerns each get a single, individually-testable home).
 */

// Shared type leaf — the RetroDispatch shape both concern modules import DOWN.
export type { RetroDispatch } from "./retro-dispatch-types.ts";

// Dispatch-bucket classification concern.
export {
  bucketOf,
  flagDispatchesForDrill,
  projectDispatches,
} from "./retro-dispatch-classifier.ts";

// Cross-run cycle-id dedup + provisional-tracking concern.
export {
  dedupByCanonicalCycleId,
  collectProvisionalCycleIds,
  confirmDrillableCycleIds,
} from "./retro-cycle-identity.ts";
