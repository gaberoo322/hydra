// ---------------------------------------------------------------------------
// Candidate Suppression Decision — the eligibility-dispatch coordinator.
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #3240), mirroring the
// `src/backlog/candidate-eligibility.ts` (#2066), `src/backlog/candidate-scoring.ts`
// (#2040), `src/backlog/merged-refs.ts` (#1880), and
// `src/backlog/work-queue-hygiene.ts` (#1844) extractions that pulled co-located
// concerns out of the same file.
//
// The `getCandidateFeed` enumeration loop used to evaluate five INDEPENDENT
// eligibility predicates inline, once per candidate, in a fixed priority order,
// and accumulate a matching suppression counter for each — the same cluster
// spelled out twice (once per live lane) and interleaved with enumeration. Those
// predicates are PURE and already have a canonical home in
// `candidate-eligibility.ts`; what had NO named home was the DISPATCH between
// them: the ordered predicate-cascade plus the per-branch counter selection.
//
// This module gives that cascade a name. `candidateSuppressionDecision(input)`
// takes a normalized `SuppressionInput` — the eligibility flags, the item under
// the two shapes the predicates read, the merged-ref token set + blob feed — and
// returns a single `SuppressionDecision`: whether the candidate is suppressed,
// which `SuppressReason` fired, and which `SuppressCounters` key to bump. The
// feed loop calls it ONCE per candidate and increments `counters[decision.counter]`
// on a suppress, instead of five inline `if (…) { counterN++; continue; }` blocks.
//
// ADR-0016 Locality: the ORDER of the eligibility cascade and the reason→counter
// mapping now have exactly ONE home here. The five predicates keep their home in
// `candidate-eligibility.ts` (this module imports them; it never re-implements a
// predicate). The feed module composes this coordinator into its enumeration; the
// predicates stay independently unit-testable, and now the DISPATCH between them
// is unit-testable too — without constructing a full `CandidateFeedDeps` fixture.
//
// This is PURE and side-effect-free: given the same input it returns the same
// decision, no Redis, no I/O, no clock read (the caller passes `now`). That keeps
// the whole suppression cascade on a pinned-clock test surface.

import type { BacklogItemLike } from "./types.ts";
import type { MergedRef } from "./target-pr-feed.ts";
import {
  isInFlightPR,
  requiresSpawnCapableDispatch,
  requiresNonPrDispatch,
  isShippedSubject,
} from "./candidate-eligibility.ts";
import { isMergedWork } from "./merged-refs.ts";

/**
 * Why a candidate was suppressed from the feed. `"eligible"` is the sole
 * non-suppressing outcome (the candidate survives to scoring). Each other value
 * names the eligibility gate that fired, in the order the cascade evaluates them.
 */
export type SuppressReason =
  | "eligible"
  | "in-flight-pr"
  | "spawn-capable"
  | "non-pr-deliverable"
  | "merged-work"
  | "shipped-subject";

/**
 * The five suppression counters the feed surfaces on `CandidateFeed`. The keys
 * are the internal accumulator names inside `getCandidateFeedImpl`; the feed maps
 * them onto the public `*_suppressed` wire fields. `null` (from an `"eligible"`
 * decision) means "bump nothing".
 */
export type SuppressCounter =
  | "inFlightSuppressed"
  | "spawnSuppressed"
  | "nonPrDeliverableSuppressed"
  | "mergedSuppressed"
  | "shippedSubjectSuppressed";

export interface SuppressCounters {
  inFlightSuppressed: number;
  spawnSuppressed: number;
  nonPrDeliverableSuppressed: number;
  mergedSuppressed: number;
  shippedSubjectSuppressed: number;
}

/**
 * The coordinator's verdict for one candidate. `suppressed: false` pairs with
 * `reason: "eligible"` and `counter: null`. `suppressed: true` names the gate
 * that fired and the counter key to increment.
 */
export interface SuppressionDecision {
  suppressed: boolean;
  reason: SuppressReason;
  counter: SuppressCounter | null;
}

/**
 * Normalized inputs to the suppression cascade for one candidate. The two live
 * lanes (kanban, work-queue) build this from their own item shapes:
 *
 *   - `item` is the candidate under a `BacklogItemLike` view — the shape the
 *     three item-reading predicates (`isInFlightPR`, `requiresSpawnCapableDispatch`,
 *     `requiresNonPrDispatch`) consume. The kanban lane passes the raw backlog
 *     item; the work-queue lane passes its parsed `WorkQueueEntry` (which
 *     structurally satisfies `BacklogItemLike`).
 *   - `mergedIdentity` is the `{issue,title,anchorRef}` triple the exact-token
 *     `isMergedWork` gate matches against `mergedRefs`. The two lanes derive it
 *     differently (kanban: item id + title; work-queue: the `reference`), so it
 *     is passed pre-built rather than re-derived here.
 *   - `subjectTitle` is the free-text title the asymmetric `isShippedSubject`
 *     gate covers against `mergedBlobs`.
 *
 * The `exclude*` flags mirror the `GetCandidateFeedOpts` gates: a `false` flag
 * skips that gate entirely (so the raw operator view surfaces everything). The
 * `inlineMode` flag gates the spawn-capable check only.
 */
export interface SuppressionInput {
  item: BacklogItemLike;
  mergedIdentity: { issue: string | number | undefined; title: string; anchorRef: string };
  subjectTitle: string;
  now: number;
  excludeInFlight: boolean;
  inlineMode: boolean;
  excludeNonPrDeliverable: boolean;
  excludeMerged: boolean;
  mergedRefs: Set<string>;
  mergedBlobs: MergedRef[];
}

const ELIGIBLE: SuppressionDecision = { suppressed: false, reason: "eligible", counter: null };

/**
 * Evaluate the five eligibility gates for one candidate, in the same priority
 * order the inline `getCandidateFeed` loop used, and return the first gate that
 * suppresses (or `ELIGIBLE` if none does). This is the coordinator the two lane
 * loops call once per candidate.
 *
 * Order matters for the counter bookkeeping — it is the exact order the loop
 * body used, so the per-counter totals are byte-identical to the pre-#3240 feed:
 *   1. in-flight PR freshness  (kanban only in practice — a work-queue entry
 *      carries no `claimedBy`; the gate is a strict no-op there anyway)
 *   2. spawn-capable + inline mode
 *   3. non-PR-deliverable
 *   4. merged-work (exact identity token)
 *   5. shipped-subject (asymmetric blob cover)
 *
 * Pure: no I/O, no clock read. `now` is a parameter.
 */
export function candidateSuppressionDecision(input: SuppressionInput): SuppressionDecision {
  if (input.excludeInFlight && isInFlightPR(input.item, input.now)) {
    return { suppressed: true, reason: "in-flight-pr", counter: "inFlightSuppressed" };
  }
  if (input.inlineMode && requiresSpawnCapableDispatch(input.item)) {
    return { suppressed: true, reason: "spawn-capable", counter: "spawnSuppressed" };
  }
  if (input.excludeNonPrDeliverable && requiresNonPrDispatch(input.item)) {
    return { suppressed: true, reason: "non-pr-deliverable", counter: "nonPrDeliverableSuppressed" };
  }
  if (input.excludeMerged && isMergedWork(input.mergedIdentity, input.mergedRefs)) {
    return { suppressed: true, reason: "merged-work", counter: "mergedSuppressed" };
  }
  if (input.excludeMerged && isShippedSubject(input.subjectTitle, input.mergedBlobs)) {
    return { suppressed: true, reason: "shipped-subject", counter: "shippedSubjectSuppressed" };
  }
  return ELIGIBLE;
}
