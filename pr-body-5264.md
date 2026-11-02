Tier: 3 (operator-review change; classifier /api/tier)

## Summary

P2 of the reversibility-scored QA depth epic (#5255, ADR-0046 D5/D6). Adds a new pure module `src/qa/shadow-fold.ts`: a zero-token A-pair-only counterfactual fold that counts B-only medium/high pair-miss events per shadow PR, the one-way top-up decision for a live pair (reviewer B added in the same round to reach 4), the detector-gap log, and a `QA-Shadow:` line renderer/parser. It re-runs the unchanged `foldReviewFindings` on the A-group subset of the per-reviewer map; `fold.ts` is not edited and nothing here feeds the live verdict.

Named follow-up (not in this issue's scope list): wiring `shadowFold` into the fold phase / playbook shim and asking pair reviewers for a door call. Until then `two-way-pair: shadow` emits no live shadow lines; P3 (#5265) extends the cohort readers to `parseQaShadowLines`.

Glossary impact: none (pair-miss, detector gap, shadow are defined in ADR-0046).
ADR impact: none (implements ADR-0046 D5/D6).

## Files in scope

- `src/qa/shadow-fold.ts`
- `test/qa-shadow-fold.test.mts`
- `test/fixtures/suite-count-baseline.json`
- `test/fixtures/test-subject-baseline.json`
- `.changelog/5264-shadow-counterfactual-fold.md`

## Acceptance criteria

- [x] counterfactual fold emits pair-miss count without changing the verdict — verified by: `npm run test:file -- test/qa-shadow-fold.test.mts` exits 0
- [x] one-way call by a pair reviewer tops up to 4 and logs a detector gap — verified by: `npm run test:file -- test/qa-shadow-fold.test.mts` exits 0
- [x] tests cover miss and no-miss rounds — verified by: `git diff --name-only origin/master...HEAD` includes test/qa-shadow-fold.test.mts
- [x] npm test and tsc pass — verified by: `npm run typecheck` and `npm run typecheck:test` exit 0

Test-subject baseline regenerated (`test/fixtures/test-subject-baseline.json`): the new file's transitive subject resolves to `src/qa/one-way-door.ts`, which already had a test file; a separate file is right because the module under test is the new `shadow-fold.ts`.

## Design-concept reconciliation

Artifact: `f5950ec7c754`

- INV-1: "INV-1 PURE, NEW LEAF-ADJACENT MODULE" — verified by: `file-contains: src/qa/shadow-fold.ts :: import { foldReviewFindings, reviewerGroup, MALFORMED_FINDING_ID } from "./fold.ts"`
- INV-2: "INV-2 VERDICT UNTOUCHED (ADR-0046 D5, AC 1)" — verified by: `file-lacks: src/qa/fold.ts :: shadow`
- INV-3: "INV-3 APPLICABILITY KEY: the counterfactual fold runs iff" — verified by: `test: test/qa-shadow-fold.test.mts :: "not applicable: off"`
- INV-4: "INV-4 PAIR-MISS DEFINITION (ADR-0046 D6)" — verified by: `test: test/qa-shadow-fold.test.mts :: "miss round: B-only medium is a pair-miss, A-only counterfactual PASSes, live FAILs"`
- INV-5: "INV-5 UNMEASURED ON MALFORMED OUTPUT" — verified by: `test: test/qa-shadow-fold.test.mts :: "malformed B output is unmeasured, not a clean round"`
- INV-6: "INV-6 ONE-WAY TOP-UP (ADR-0046 D5, AC 2)" — verified by: `test: test/qa-shadow-fold.test.mts :: "pair live + reviewer one-way: tops up with reviewer B and logs a gap"`
- INV-7: "INV-7 DETECTOR GAP IS A LOG, NOT A FINDING" — verified by: `test: test/qa-shadow-fold.test.mts :: "a detector gap is never a finding: pair-miss count and verdict unchanged"`
- INV-8: "INV-8 SHADOW LINE GRAMMAR AND PARSER" — verified by: `test: test/qa-shadow-fold.test.mts :: "renders one line and round-trips through the parser"`
- INV-9: "INV-9 NAMED FOLLOW-UP, NOT SILENT ASSUMPTION" — verified by: `file-contains: src/qa/shadow-fold.ts :: NAMED FOLLOW-UP: wire shadowFold`
- INV-10: "INV-10 TESTS AND BOOKKEEPING" — verified by: `file-exists: test/qa-shadow-fold.test.mts`

Closes #5264

🤖 Generated with [Claude Code](https://claude.com/claude-code)
