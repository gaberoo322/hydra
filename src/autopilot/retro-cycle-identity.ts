/**
 * Retro-bundle **cycle-id dedup + provisional-cycle tracking** — the pure,
 * side-effect-free concern that groups dispatches across a cross-run window by
 * their *canonical cycle identity*. Where the sibling
 * `retro-dispatch-classifier.ts` reasons over an individual dispatch's fields
 * (status, prNumber), this concern reasons over run-level identity keys: the
 * durable `cycleId` transcript handle.
 *
 * Split out of `retro-projections.ts` (issue #3090) so the identity-keyed dedup
 * math lives apart from the dispatch-bucket classification. `retro-projections.ts`
 * remains a thin re-export relay so `retro-bundle.ts` / `retro-enrichment.ts`
 * keep zero import-path changes.
 *
 * This module owns:
 *
 *   - `dedupByCanonicalCycleId` — post-enrichment identity-keyed dedup (#1823)
 *   - `collectProvisionalCycleIds` / `confirmDrillableCycleIds` — the named
 *     PROVISIONAL→CONFIRMED cycle-id confirmation protocol (#1352/#2547): the
 *     pure halves of the "what counts as a drillable transcript handle" rule
 *     that `assembleRetroBundle` used to spread across four inline mutation
 *     sites in its local scope
 *
 * Everything here is pure: zero Redis imports, zero `await`, no clock beyond
 * caller-supplied input. Operates on the shared {@link RetroDispatch} type
 * imported from `retro-dispatch-classifier.ts`.
 */

import type { RetroDispatch } from "./retro-dispatch-classifier.ts";

// ---------------------------------------------------------------------------
// Post-enrichment identity-keyed dedup (pure)
// ---------------------------------------------------------------------------

/**
 * Final identity-keyed dedup over the already-enriched dispatch rows (issue
 * #1823). The projection-time `byIdentity` map in `projectDispatches`
 * dedups on the identity present ON THE ACTION at projection time. But for a
 * multi-turn cycle whose durable `cycleId` only resolves from the cycle-metrics
 * sidecar POST-HOC (the Target-build / sidecar-backfilled-cycleId path), the
 * action-time identity is absent or per-turn, so each turn's action emits its
 * own `RetroDispatch`. After `assembleRetroBundle`'s metrics-sidecar
 * enrichment loop has stamped the canonical `cycleId` (and status/anchor/PR)
 * onto every row, two rows that resolved to the SAME real cycle now share a
 * non-empty `cycleId` — so a SECOND, post-enrichment dedup pass keyed on that
 * backfilled identity collapses them into one row, where the action-time map
 * could not (it never saw the backfilled id).
 *
 * Contract (mirrors the projection-time merge):
 *   - Keyed on the non-empty `cycleId` (the durable transcript handle). An
 *     EMPTY-cycleId row carries no durable identity to dedup on, so it is left
 *     untouched (the undrillable / interrupted-run case stays per its #1184
 *     treatment — two distinct empty-cycleId slots are not merged).
 *   - EARLIEST-turn row is canonical (a `null` turn_n sorts last, so a
 *     turn-bearing row wins over an unknown-turn duplicate). Later same-cycleId
 *     rows are dropped after UNIONING their non-null fields onto the canonical
 *     row — so a field only a later turn resolved (a PR-shaped anchor, a
 *     backfilled abandonReason) is preserved while the row count drops to one.
 *   - `regressionIntroduced` ORs across the merged rows (any turn that saw a
 *     regression makes the merged dispatch a regression).
 *   - Pure + order-stable: returns the surviving rows in first-seen order, so
 *     the bundle's `dispatches[]` ordering is deterministic.
 *
 * Operates in place on the passed array's members for the union, but returns a
 * NEW filtered array (the dropped duplicates are removed). The flagged /
 * undrillable materialisation runs AFTER this pass, so each real cycle is
 * flagged at most once — closing the #1823 double-count.
 */
export function dedupByCanonicalCycleId(dispatches: RetroDispatch[]): RetroDispatch[] {
  const canonical = new Map<string, RetroDispatch>();
  const survivors: RetroDispatch[] = [];
  for (const d of dispatches) {
    // Empty-cycleId rows have no durable identity — never merge them.
    if (!d.cycleId) {
      survivors.push(d);
      continue;
    }
    const prior = canonical.get(d.cycleId);
    if (!prior) {
      canonical.set(d.cycleId, d);
      survivors.push(d);
      continue;
    }
    // A later same-cycleId row: pick the earliest-turn row as canonical (a
    // null turn_n sorts last), then union the dropped row's non-null fields.
    const priorTurn = prior.turn_n ?? Number.POSITIVE_INFINITY;
    const dTurn = d.turn_n ?? Number.POSITIVE_INFINITY;
    // The canonical row is always the one already in `survivors` (first-seen);
    // we only adopt the earlier turn_n onto it so the canonical row reports the
    // dispatching turn, never a later occupancy turn.
    if (dTurn < priorTurn) prior.turn_n = d.turn_n;
    if (!prior.skill && d.skill) prior.skill = d.skill;
    if (!prior.anchorReference && d.anchorReference) prior.anchorReference = d.anchorReference;
    if (!prior.prNumber && d.prNumber) prior.prNumber = d.prNumber;
    if (prior.status === null && d.status !== null) {
      prior.status = d.status;
      prior.bucket = d.bucket;
    }
    if (!prior.abandonReason && d.abandonReason) prior.abandonReason = d.abandonReason;
    if (d.regressionIntroduced) prior.regressionIntroduced = true;
    // `d` is dropped (not pushed to survivors).
  }
  return survivors;
}

// ---------------------------------------------------------------------------
// PROVISIONAL→CONFIRMED cycle-id confirmation protocol (issue #1352 / #2547)
//
// `projectDispatches` recovers a CANDIDATE cycleId from a snapshot-only
// dispatch's slot `task_id` (the crashed/interrupted-run case) — the same id
// reap sends on its durable `cycle-record` write. That candidate is PROVISIONAL:
// it is a real transcript handle ONLY if a terminal cycle record was actually
// written for it (the genuinely-completed-but-interrupted dispatch); a slot
// still in-flight when the run died has a task_id but no terminal record.
//
// Before #2547 this protocol lived as four inline mutation sites inside
// `assembleRetroBundle`'s local scope — a `provisionalCycleIds` Set built from
// the projection, a `confirmedCycleIds` Set accreted during the Redis
// enrichment loop, a confirm-or-drop pass that blanked unconfirmed candidates,
// and the downstream `undrillable` derivation. A caller reading the
// `projectDispatches` → `RetroDispatch[]` seam could not tell that the
// dispatches had to be enriched-then-confirmed in that exact sequence, nor that
// the provisional/confirmed sets even existed. These two pure functions move
// the "what counts as a drillable transcript handle" rule into the Interface:
// the assembler still owns the Redis terminal-record reads (it accretes the
// `confirmed` set during enrichment), but the provisional-set derivation and
// the confirm-or-drop transition are now named, directly-testable stages.
// ---------------------------------------------------------------------------

/**
 * Pure half 1 of the confirmation protocol (issue #1352 / #2547). Collect the
 * set of PROVISIONAL candidate cycleIds from the freshly-projected dispatches —
 * the snapshot-recovered candidates that need a terminal-record confirmation
 * before they can be trusted as transcript handles.
 *
 * A cycleId is provisional iff it is non-empty AND its status is still `null`
 * at projection time. An action/outcome-joined dispatch always carries a
 * resolved `status` alongside its cycleId (a clean transcript handle that needs
 * no confirmation), so only a snapshot-recovered candidate (recovered from the
 * slot's `task_id`, which `projectDispatches` leaves `status: null`) satisfies
 * this predicate. MUST be called on the projection BEFORE the enrichment loop
 * mutates `status`, since the predicate keys on the pre-enrichment `status`.
 *
 * Pure + total: no Redis, no clock, no mutation of the input.
 */
export function collectProvisionalCycleIds(
  dispatches: readonly RetroDispatch[],
): Set<string> {
  return new Set<string>(
    dispatches.filter((d) => d.cycleId && d.status === null).map((d) => d.cycleId),
  );
}

/**
 * Pure half 2 of the confirmation protocol (issue #1352 / #2547). Confirm-or-
 * drop the PROVISIONAL candidate cycleIds: a provisional candidate that the
 * enrichment loop did NOT confirm (no terminal cycle record materialised — the
 * slot was still in-flight when the run was interrupted) has no transcript
 * handle, so its `cycleId` is reset to `""` in place, leaving it
 * {@link RetroDispatch.undrillable}. A CONFIRMED candidate (a
 * genuinely-completed dispatch on an interrupted run — the case #1352
 * unstarves) keeps its cycleId and becomes drillable through the normal flag
 * machinery. A NON-provisional (action-derived) cycleId is never dropped: its
 * handle came from a recorded outcome.
 *
 * `provisional` is the set from {@link collectProvisionalCycleIds} (captured
 * before enrichment); `confirmed` is the set the assembler's enrichment loop
 * accreted (a candidate is confirmed once a terminal cycle record — status,
 * abandonReason, or regression — is seen for it). Mutates the `cycleId` field
 * of unconfirmed-provisional rows in place and returns the same array for
 * chaining; no Redis, no clock.
 */
export function confirmDrillableCycleIds(
  dispatches: RetroDispatch[],
  provisional: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): RetroDispatch[] {
  for (const d of dispatches) {
    if (!d.cycleId) continue;
    if (provisional.has(d.cycleId) && !confirmed.has(d.cycleId)) {
      // Unconfirmed candidate: no terminal cycle record materialised. Drop the
      // handle so the dispatch is recorded undrillable (the pre-#1352 shape).
      d.cycleId = "";
    }
  }
  return dispatches;
}
