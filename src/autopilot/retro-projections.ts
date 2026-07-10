/**
 * Retro-bundle **pure projections** — thin re-export relay (issue #3090).
 *
 * This module was a single 604-line file bundling two distinct, internally
 * cohesive concerns. Issue #3090 split it into two focused sibling leaves,
 * mirroring the established `run-health.ts` / `health-signals/` relay pattern:
 *
 *   - `retro-dispatch-classifier.ts` — **dispatch-bucket classification**:
 *     characterizes an *individual dispatch's outcome*. Owns the
 *     `RetroDispatch` type, `projectDispatches`, `flagDispatchesForDrill`, and
 *     `bucketOf` (plus their pure slot-reconciliation helpers).
 *   - `retro-cycle-identity.ts` — **cycle-id dedup + provisional tracking**:
 *     groups dispatches across a cross-run window by *canonical cycle
 *     identity*. Owns `dedupByCanonicalCycleId`, `collectProvisionalCycleIds`,
 *     and `confirmDrillableCycleIds`.
 *
 * The two concerns share the same `RetroDispatch` type but operate at different
 * levels of abstraction — classification touches individual fields (status,
 * prNumber); dedup-tracking reasons over run-level identity keys. Splitting
 * them concentrates each concern (and its test surface) into a single,
 * individually-testable leaf.
 *
 * This relay preserves the public surface so the two callers (`retro-bundle.ts`,
 * `retro-enrichment.ts`) — and their tests — need zero import-path changes. New
 * callers that want only one concern SHOULD import the focused module directly.
 *
 * Everything re-exported here is pure: zero Redis imports, zero `await`, no
 * clock beyond caller-supplied input.
 */

export {
  type RetroDispatch,
  projectDispatches,
  flagDispatchesForDrill,
  bucketOf,
} from "./retro-dispatch-classifier.ts";

export {
  dedupByCanonicalCycleId,
  collectProvisionalCycleIds,
  confirmDrillableCycleIds,
} from "./retro-cycle-identity.ts";
