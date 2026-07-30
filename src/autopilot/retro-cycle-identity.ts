/**
 * Retro-dispatch **cycle-id dedup + provisional-tracking** leaf (issue #3090) —
 * the pure logic that groups dispatches across runs by their canonical cycle
 * identity, a different level of abstraction from the per-dispatch bucket
 * classification (now in `retro-dispatch-classifier.ts`). Split out of the
 * combined `retro-projections.ts` (issue #1952) so the cross-run dedup math is
 * separately exercisable over synthetic `{cycleId, status, turn_n}` fixtures.
 *
 * This leaf owns:
 *   - `dedupByCanonicalCycleId` — post-enrichment identity-keyed dedup (#1823)
 *   - `collectProvisionalCycleIds` / `confirmDrillableCycleIds` — the named
 *     PROVISIONAL→CONFIRMED cycle-id confirmation protocol (#1352/#2547): the
 *     pure halves of the "what counts as a drillable transcript handle" rule
 *     that `assembleRetroBundle` used to spread across four inline mutation
 *     sites in its local scope.
 *
 * The shared `RetroDispatch` type is imported DOWN from the zero-IO leaf
 * `retro-dispatch-types.ts` — never sideways from the classifier peer. These
 * functions depend only on the `RetroDispatch` TYPE (fields cycleId / status /
 * turn_n / bucket / …), never on the classification FUNCTIONS: the union merge
 * copies the already-computed `d.bucket`, it never re-derives via `bucketOf`.
 *
 * Everything here is pure: zero Redis imports, zero `await`, no clock beyond
 * caller-supplied input.
 */

import type { RetroDispatch } from "./retro-dispatch-types.ts";

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
 *     EMPTY-cycleId row carries no durable CYCLE identity, so it dedups on its
 *     SLOT key instead (issue #3738): the slots-snapshot fallback can emit one
 *     row per turn a slot stays occupied when the dispatch's task_id was never
 *     confirmed (the #1352 confirm-or-drop blanked it back to ""), and those
 *     duplicates all share the slot — collapsing on it keeps bundle
 *     `dispatches[]` from exceeding the run's recorded dispatch count. A row
 *     with neither a cycleId NOR a recoverable slot is left untouched
 *     (conservative — two distinct empty-cycleId slots are never merged).
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
  // Non-empty-cycleId rows dedup on the cycleId (the durable transcript
  // handle) — the #1823 post-enrichment identity collapse. Empty-cycleId rows
  // carry no durable CYCLE identity, but the slots-snapshot fallback can still
  // emit one row PER TURN a slot stays occupied (the dispatch's task_id was
  // never confirmed, so the #1352 confirm-or-drop blanked it back to ""). Those
  // duplicates all share the SLOT key (the snapshot's own identity), so a
  // SECOND map keys empty-cycleId rows on the slot instead of the blank key,
  // collapsing same-slot occupancy across turns to one row (issue #3738 —
  // bundle `dispatches[]` no longer exceeds the run's recorded dispatch count).
  // A row with neither a cycleId NOR a recoverable slot has no surrogate to
  // match on and is left untouched (conservative — never silently merge two
  // possibly-distinct dispatches).
  const byCycleId = new Map<string, RetroDispatch>();
  const bySlot = new Map<string, RetroDispatch>();
  const survivors: RetroDispatch[] = [];
  /** Adopt the earlier turn_n onto `canonical` and union `dropped`'s non-null
   *  fields onto it. `canonical` is always the first-seen survivor. */
  const unionInto = (canonical: RetroDispatch, dropped: RetroDispatch): void => {
    const cTurn = canonical.turn_n ?? Number.POSITIVE_INFINITY;
    const dTurn = dropped.turn_n ?? Number.POSITIVE_INFINITY;
    // The canonical row is always the one already in `survivors` (first-seen);
    // we only adopt the earlier turn_n onto it so it reports the dispatching
    // turn, never a later occupancy turn.
    if (dTurn < cTurn) canonical.turn_n = dropped.turn_n;
    if (!canonical.skill && dropped.skill) canonical.skill = dropped.skill;
    if (!canonical.anchorReference && dropped.anchorReference)
      canonical.anchorReference = dropped.anchorReference;
    if (!canonical.prNumber && dropped.prNumber) canonical.prNumber = dropped.prNumber;
    if (canonical.status === null && dropped.status !== null) {
      canonical.status = dropped.status;
      canonical.bucket = dropped.bucket;
    }
    if (!canonical.abandonReason && dropped.abandonReason)
      canonical.abandonReason = dropped.abandonReason;
    if (dropped.regressionIntroduced) canonical.regressionIntroduced = true;
  };
  for (const d of dispatches) {
    if (d.cycleId) {
      const prior = byCycleId.get(d.cycleId);
      if (!prior) {
        byCycleId.set(d.cycleId, d);
        survivors.push(d);
      } else {
        unionInto(prior, d);
      }
      continue;
    }
    // Empty-cycleId row: dedup on the slot key (#3738) so a slot occupied for N
    // turns collapses to one row. No slot surrogate → leave untouched.
    if (d.slot) {
      const prior = bySlot.get(d.slot);
      if (!prior) {
        bySlot.set(d.slot, d);
        survivors.push(d);
      } else {
        unionInto(prior, d);
      }
      continue;
    }
    survivors.push(d);
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
