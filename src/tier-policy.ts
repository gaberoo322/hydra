/**
 * Tier → merge-policy predicates (ADR-0019).
 *
 * The merge-policy boundary — "which tier values auto-merge, and which
 * are heavy enough that a breaking change is permitted" — is defined
 * here, ONCE. Three callers previously re-derived it inline as bare
 * integer comparisons (`tier < 2`, `tier <= 2`), and that scattering is
 * exactly how the calibration-trend Tier-0 mismodel crept in: a private
 * copy drifted from the others. Centralizing the boundary as a named
 * predicate is what makes the boundary auditable and the eventual
 * renumber (ADR-0015 T1–T4) a one-file change.
 *
 * NUMBERING (ADR-0019 decision 4): these predicates intentionally stay
 * on the legacy `0|1|2|3` numbering — the numbering the autopilot's
 * `decide.py` and the persisted calibration records actually carry — and
 * do NOT anticipate the monotonic T1–T4 ladder. They accept a plain
 * `number` because their callers (the design-concept gate, the
 * calibration aggregator) work with raw integer tier values, including
 * `0`, which the live `Tier` type (`1 | 2 | 3 | 4`) cannot express.
 *
 * This module deliberately carries NO dependency on the Verifier Core —
 * `tier-classifier.ts` (home of the live `Tier` type) and
 * `untouchable.ts` are untouched — which is what keeps a PR that adds
 * this file at Tier 3 rather than Verifier Core / Tier 0. (ADR-0019
 * decision 3.)
 */

/**
 * The auto-merge boundary in the legacy `0|1|2|3` numbering.
 *
 * `0` = Verifier Core / operator-only (requires `operator-approved`);
 * `1|2|3` = auto-mergeable tiers. `decide.py` never auto-merges a
 * Tier-0 PR — it requires the `operator-approved` label or routes the
 * PR to the operator queue. This predicate is the single canonical
 * referent for that rule.
 *
 * Equivalent to `tier in {1, 2, 3}`. NOT `tier <= 2` — that was the
 * calibration-trend mismodel (it scored a Tier-0 record as
 * predicted-auto-merge, counting the classifier wrong on an
 * operator-merged Tier-0 PR). (ADR-0019 decision 5.)
 */
export function isAutoMergeTier(tier: number): boolean {
  return tier >= 1 && tier <= 3;
}

/**
 * Whether a change classified at `tier` is heavy enough that an
 * `interfaceImpact: 'breaking'` declaration is permitted.
 *
 * Equivalent to `tier >= 2`, preserving the design-concept gateCheck
 * rule 4: a breaking change on a path that classifies to `tier < 2`
 * (the shallowest, lowest-blast-radius tier) is a contradiction and is
 * rejected. (ADR-0019.)
 */
export function permitsBreakingChange(tier: number): boolean {
  return tier >= 2;
}
