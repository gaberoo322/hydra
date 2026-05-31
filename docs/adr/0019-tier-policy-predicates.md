---
status: accepted
---

# Tier→merge-policy is a named predicate, not a magic integer scattered across callers

"What does tier N permit" — may a breaking interface change ride this tier, is this tier auto-merge-eligible — is **policy derived from a tier**, distinct from **classification** (path → tier). Classification is owned by `src/tier-classifier.ts`. Policy had no owner: it was re-derived as a bare integer comparison wherever it was needed, and the copies already disagreed.

| Caller | Encoding | Means |
|---|---|---|
| `src/design-concept.ts` (`gateCheck`) | `cls.tier < 2` → reject | breaking allowed iff tier ∈ {2,3} |
| `src/aggregators/calibration-trend.ts` | `tier <= 2` → `predictedAutoMerge` | auto-merge iff tier ∈ {0,1,2} |
| `scripts/autopilot/decide.py` (`should_auto_merge`) | `tier in {1,2}` (+ conditional 3); `0` → operator-approved/queue | auto-merge iff {1,2}; **never plain 0** |

The `calibration-trend` copy is a live defect: `tier <= 2` scores a **Tier-0** PR as predicted-auto-merge, but decide.py never auto-merges Tier 0 (it requires the `operator-approved` label or routes to queue-decision). So the calibration accuracy metric marks the classifier "wrong" every time a Tier-0 PR is operator-merged — its private copy of the rule contradicts the actual rule. This is the exact failure the architecture vocabulary predicts when a policy is smeared across callers instead of owned at one seam. And every magic comparison is coupled to the `0|1|2|3` numbering that ADR-0015 is mid-migrating to T1–T4, so each one silently changes meaning the day the renumber lands.

## Decision

1. **A `src/tier-policy.ts` module owns the tier→policy predicates.** It exports `permitsBreakingChange(tier)` (the gate's `tier >= 2` rule) and `isAutoMergeTier(tier)` (decide.py's auto-merge boundary: tiers {1,2,3} eligible, tier 0 not). The merge-policy boundary is defined once, in one place.

2. **Callers use the predicates, not literals.** `gateCheck` calls `permitsBreakingChange(cls.tier)` (still calling `classifyChange` for the path→tier step); `calibration-trend` calls `isAutoMergeTier(tier)`, which corrects the Tier-0 mismodel as a consequence — the predicate makes the correct answer the only answer.

3. **`tier-policy.ts` is its own module, not added to `tier-classifier.ts`.** `tier-classifier.ts` is Untouchable (Verifier Core under ADR-0015). Folding policy in would make every future policy tweak a Tier-0 operator-approval and would grow Verifier Core against ADR-0015's "shrink" principle. `tier-policy.ts` imports only the `Tier` **type** from the classifier, leaving `tier-classifier.ts` and `untouchable.ts` unedited — so the change is **Tier 3**. Classification (path→tier) stays Untouchable because a bad classification neuters the gate; policy (tier→permission) does not need that protection — `permitsBreakingChange` feeds the design-concept gate (not yet merge-wired), and `isAutoMergeTier` feeds only a metric.

4. **Predicates stay on the current `0|1|2|3` numbering.** This does not anticipate ADR-0015's T1–T4. Centralizing the policy is precisely what turns the eventual renumber into a one-file change: whoever migrates the classifier updates `tier-policy.ts` and every consumer follows.

5. **`isAutoMergeTier` is the canonical TS statement of the auto-merge policy.** `scripts/autopilot/decide.py` carries its own Python copy (ADR-0009 fences Python tooling as out-of-scope for shared imports). It is not unified here, but a future cross-language parity test has a referent.

## Considered options

- **Add the predicates to `tier-classifier.ts`.** Rejected per decision 3 — Tier-0 escalation on every touch and grows Verifier Core.
- **Add `tier-policy.ts` to the Untouchable list.** Rejected: splits the files *and* still escalates, giving protection without the locality. The gating-power audit (only the not-yet-wired gate consumes a policy predicate; the metric has none) does not justify Verifier-Core protection today. If `permitsBreakingChange` later gates live merges, revisit.
- **Keep deduplicating in each caller (status quo, tidied).** Rejected: leaves three private copies free to diverge again — which is how the `calibration-trend` Tier-0 defect arose.
- **Unify with decide.py now.** Rejected: cross-language, out of ADR-0009 scope; a parity test is the lighter follow-up.

## Consequences

- The merge-policy boundary is one fact in `tier-policy.ts`, not three divergent literals. The `calibration-trend` Tier-0 scoring defect is fixed.
- **Locality / leverage:** the predicate pays back across `gateCheck` and `calibration-trend`, and future-proofs the ADR-0015 renumber (one-file change).
- **Test surface:** policy is testable as `tier → bool` directly, plus the gate boundary is pinned at Tier-0 and Tier-3 (today's gate test covers only the 1/2 boundary).
- Blast radius: new `src/tier-policy.ts` + edits to `src/design-concept.ts` and `src/aggregators/calibration-trend.ts`; `tier-classifier.ts`/`untouchable.ts` untouched → **Tier 3** (ADR-0015).
- Implementation tracked in #799.

## Related

- ADR-0004 / ADR-0015 — the tier model and its T1–T4 reshape (this isolates the policy so that migration is cheap).
- ADR-0001 — Untouchable Core; `tier-classifier.ts` is protected, which is *why* policy lives in a separate Tier-3 module.
- ADR-0008 — the design-concept gate that consumes `permitsBreakingChange`.
