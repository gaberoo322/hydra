---
status: accepted
---

# ADR-0046: Two-pass code factory: implement makes it work, the reviewer makes it good

Source: wayfinder map #5182 (Matt Pocock, "Fixing the PR Bottleneck"), whose twelve decision tickets
(#5183-#5193, #5216, #5222) are each a primary source for one Decision below. Baselines at filing time:
09-28 QA audit (1.55 rounds/PR, 35% first FAIL, ~185k tokens/review) and the 10-01 throughput audit
(quota-bound, not CI-bound). Goal: fewer review rounds and dev-resume dispatches, fewer tokens per
merged PR, higher code quality, **without weakening any required gate**. Re-measure; do not trust
those numbers (slice S0 does).

## Decision

### Decision 1 — Two passes: the implementer makes it work, the reviewer makes it good and commits

`dev_orch` is asked only to make the change work. Coding standards are reviewer-only (Decision 3).
The QA reviewer may **commit** fixes to the PR branch, but only the fixes in Decision 2. Research
(#5183, #5192) bounds the win: in-place fixing removes 8% (docs/baseline/PR-body) to 16% (+tests) of
FAIL rounds; 64% of FAIL rounds carry an implementer-only blocker. Deterministic checks beat reviewer
authority for PR-body drift, baseline regen and missing pins.

### Decision 2 — Reviewer commit contract (#5184)

- Classes A (non-executable docs, PR body, baselines) and B (tests) only. Never production code,
  never T4 / Verifier Core, never a one-way or unknown-door PR. No provenance rule.
- All-or-nothing per round: a round fully fixable in A/B becomes PASS at the new head; otherwise
  commit nothing.
- Every reviewer commit carries a `QA-Fix:` trailer and the PASS carries `qa-fixes=`. A T3 sibling
  workflow `qa-fix-proof` verifies it (path allowlist; new tests fail at the merge-base by
  assertion) and `qa-merge-guard` requires it green. Edit the PR body before pushing; never
  force-push. #5036 (forward-fix without a guard test) is independent.

### Decision 3 — One reviewer-only standards file (#5185, #5186, #5189, #5222)

- Root `CODING_STANDARDS.md`, sectioned by area, stable rule IDs, is the full catalog. CLAUDE.md
  keeps one-line fences only for rules whose breach needs production-code rework; reviewer-fixable
  test-authoring rules and other-role prose leave CLAUDE.md.
- It is inlined into the Standards packet (absorbing hydra-qa's hardcoded checks; Fowler stays
  vendored; Spec never sees it). The Target uses its own repo's root file via a repo-agnostic loader.
- A required test enforces a ratchet, a ~2,000-word ceiling and `enforced-by:` / fence-ID integrity;
  CLAUDE.md is ratcheted too. Retro routes code-shaped lessons here by the ladder
  **check > standard > fence**.
- § Tests: five `STD-TEST-*` rules (RUN-THE-CODE, PIN-PHRASE, NO-TAUTOLOGY, CAN-FAIL, OWN-FEATURE;
  dashboard JSX pins are a named exception). § Design: only `STD-DESIGN-TWO-ADAPTERS`, `-NO-REIMPLEMENT`,
  `-DEEPEN`; existing-module depth and cross-module seams stay `architecture_orch`'s. Design findings
  default low; medium only for a must-stay-in-sync re-implemented rule.

### Decision 4 — Test quality: one deterministic check, the rest standards (#5188, #5189)

A required `test-source-read-ratchet` test gates test reads of code paths against a kind-tagged
fixture (grandfathered rows only shrink). The mutation gate counts unparseable mutants as `skipped`
(removes the ~28.7% free kills); it stays advisory (`MUTATION_GATE_BLOCKING` unset; turning it on is a
separate T4 decision). The 20 runnable structure-sensitive pins convert in ~4 cluster issues;
`docs/generated/` inventories drop `"line"` fields.

### Decision 5 — Review depth is set by reversibility, not tier alone (#5190, #5191)

- One-way = revert plus redeploy does not restore the world: persistent state, external side effects,
  breaking the way back, out-of-repo contracts. Detected as escalate-only
  max(content-based detector, required `Merge danger:` PR field, reviewer). A mismatch is a medium
  finding; detector gaps go to retro.
- Floor is ADR-0015's Standards+Spec pair; nothing goes below it. Two-way T3 code drops from
  adversarial to the pair; one-way or unknown code goes adversarial at every tier; non-code stays
  single unless the detector fires. A pair reviewer's one-way call tops up to 4 reviewers in the same
  round and is logged as a detector gap (not a finding). One-way gets a class way-back checklist
  (a "no" is medium). Fold and verdict logic (`qa-verdict.ts`) are untouched: code that narrows or
  demotes findings is a fail-open magnet (#4734/#4735).
- The axis never lowers depth below the tier floor and never applies inside Verifier Core.

### Decision 6 — Rollout order and switches (#5216)

Two switches, `two-way-pair: off|shadow|on` and `reviewer-commits: off|A|A+B`, live in one
git-tracked config file; missing = off; the cohort script's trip overrides to off at read time. Only
depth *reduction* is switched; fan-out increases ship ungated. The pair runs a zero-token shadow first
(adversarial still decides; an A-pair-only counterfactual fold counts B-only medium/high "pair-miss"
events; graduate after ~20 two-way T3 PRs with none). Reviewer commits skip shadow and stage A, then
A+B (after the assertion-failure proof and ~10 clean class-A fixes). Guard: a deterministic 14-day
escaped-defect cohort comparison; fail-safe trips after 30 or more pair PRs (shadow PRs do not count;
the cohort starts at the `on` flip). Depth-lowering flips are operator-merged `ready-for-human` items.
Slice order: S0 measurement+baseline, S1 detector, S2 `Merge danger:` field, S3 config+trip, then the
independent pair (P1-P3) and commit (C1-C3) tracks.

### Decision 7 — Playbook plumbing moves into scripts (#5187)

About 55% of hydra-qa.md is deterministic plumbing. Five script contracts (preflight, packet, fold,
route, poll) cut the loaded playbook ~63%. `deep-qa-gate.yml` imports `hasFreshDeepQaPass` from
`qa-verdict.ts` and the `qa-merge-guard-callsites` tests pin step 10's call sites: those exports and
call sites are frozen.

### Decision 8 — The review-findings retro (#5193)

A zero-token extractor (new `review-findings` Redis seam; rows appended by QA's route step, weekly
reconcile from GitHub trailers) plus a `hydra-retro` review-findings mode that `retro_orch` dispatches
on a Redis-only `review_retro_due` signal; no new class. Arms count distinct PRs: a rule or file on 3+
PRs in 30 days, the same rule or file in 3+ rounds of one PR, any medium/high pair-miss, 2+ same-class
detector gaps. Mechanical emits: the `architecture_orch` hot-spot feed (3+ low design follow-ups per
file in 30 days) and one issue per cohort trip. Review mode emits at most 2 `needs-triage` check
issues and 1 PR limited to `CODING_STANDARDS.md` (incl. 90-day prune) or production-code fences; it
never edits QA prompts, the fold, `qa-verdict.ts` or rollout config. Cues are namespaced `review:` in
`retro-seen`; re-trip only after the emit closes, climbing one rung of the ladder.

## Alternatives considered

- **Let the reviewer fix production code or demote findings.** Rejected: fail-open magnet (#4734/#4735),
  and 64% of FAIL rounds need the implementer anyway.
- **Move all of CLAUDE.md's standards out.** Rejected: extraction saves only ~8-13%; fences stay where
  breach needs prod-code rework. The 2.7k-word pitfalls section is a separate lever (#5218).
- **Turn on `MUTATION_GATE_BLOCKING` now.** Deferred until ~30 `src/` PRs of validity-fixed kill rates.
- **Third-party review services.** Out of scope; Hydra already builds its own.
