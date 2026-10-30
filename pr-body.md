Tier: 3 (operator-review change per the live /api/tier classifier)

Glossary impact: none
ADR impact: ADR-0034 section 10 gets a one-line amendment (inventories record source path, never a line number); ADR-0046 slice S6.

## Summary

One PR, clean commits for #5262 (S6 of epic #5255):

1. Mutation validity decided at generation time in the mutation runner: unparseable mutants are recorded as skipped (new additive skippedUnparseable counter), never run, and swap-comparison keeps looking past a generic angle bracket for a real comparison. typescript is loaded lazily.
2. Generated inventories drop line numbers (schemaVersion 2): serializeInventory is the single emission seam that strips the internal line aid.
3. test-source-read ratchet: a required top-level test plus a kind-tagged fixture seeded from the live tree (heuristic kinds, uncertain files grandfathered), and the STD-TEST-RUN-THE-CODE enforced-by pointer.

MUTATION_GATE_BLOCKING and every killFloor are untouched.

## Files in scope

- `.changelog/5262-mutation-validity-read-ratchet-inventory-lines.md`
- `CODING_STANDARDS.md`
- `dashboard/src/pages/docs/Catalogue.jsx`
- `dashboard/src/pages/docs/RoutesCatalogue.jsx`
- `dashboard/src/pages/docs/inventories.js`
- `docs/adr/0034-orchestrator-dashboard-page-inventory.md`
- `docs/generated/adrs.json`
- `docs/generated/areas.json`
- `docs/generated/chores.json`
- `docs/generated/ci-gates.json`
- `docs/generated/classes.json`
- `docs/generated/config.json`
- `docs/generated/corpus.json`
- `docs/generated/counts.json`
- `docs/generated/env-vars.json`
- `docs/generated/pages.json`
- `docs/generated/redis-keys.json`
- `docs/generated/routes.json`
- `docs/generated/schemas.json`
- `docs/generated/skills.json`
- `docs/generated/streams.json`
- `docs/generated/tier-paths.json`
- `docs/generated/units-scripts.json`
- `scripts/ci/mutation-check.ts`
- `scripts/ci/test-source-read-scan.ts`
- `scripts/docs/generate-inventories.ts`
- `scripts/docs/inventories/adrs.ts`
- `scripts/docs/inventories/areas.ts`
- `scripts/docs/inventories/chores.ts`
- `scripts/docs/inventories/ci-gates.ts`
- `scripts/docs/inventories/classes.ts`
- `scripts/docs/inventories/config.ts`
- `scripts/docs/inventories/corpus.ts`
- `scripts/docs/inventories/env-vars.ts`
- `scripts/docs/inventories/envelope.ts`
- `scripts/docs/inventories/pages.ts`
- `scripts/docs/inventories/redis-keys.ts`
- `scripts/docs/inventories/routes.ts`
- `scripts/docs/inventories/schemas.ts`
- `scripts/docs/inventories/skills.ts`
- `scripts/docs/inventories/streams.ts`
- `scripts/docs/inventories/tier-paths.ts`
- `scripts/docs/inventories/units-scripts.ts`
- `src/mutation.ts`
- `test/docs-adrs.test.mts`
- `test/docs-areas.test.mts`
- `test/docs-classes-skills.test.mts`
- `test/docs-page.test.mts`
- `test/fixtures/adr-area-baseline.json`
- `test/fixtures/coding-standards-baseline.json`
- `test/fixtures/suite-count-baseline.json`
- `test/fixtures/test-source-read-baseline.json`
- `test/generated-inventories-drift.test.mts`
- `test/mutation.test.mts`
- `test/test-source-read-ratchet.test.mts`

## Acceptance criteria

- [ ] ratchet test fails when a new test reads a code path not in the fixture — verified by: `npm run test:file -- test/test-source-read-ratchet.test.mts` exits 0 (unlisted-reader case asserted)
- [ ] unparseable mutants reported as skipped and excluded from kill rate — verified by: `npm run test:file -- test/mutation.test.mts` exits 0
- [ ] docs/generated no longer contains line fields and the drift guard passes — verified by: `npm run test:file -- test/generated-inventories-drift.test.mts` exits 0
- [ ] npm test and tsc pass — verified by: `npm test` exits 0 and `npm run typecheck` and `npm run typecheck:test` exit 0

## Design-concept reconciliation

Artifact: `61101bc42646f157`

- INV-1: "Verifier Core is untouched: no edit to .github/workflows/ci.yml, src/u" — verified by: `manual: the PR file list names none of the four Verifier Core paths; no killFloor or blocking env change`
- INV-2: "The read ratchet runs inside the required `test` job as a top-level no" — verified by: `file-contains: scripts/ci/test-source-read-scan.ts :: STD-TEST-RUN-THE-CODE`
- INV-3: "Detection is per FILE and gates only CODE paths: a test file is a code" — verified by: `test: test/test-source-read-ratchet.test.mts :: "import statements and comments never count as reads"`
- INV-4: "The fixture test/fixtures/test-source-read-baseline.json maps each all" — verified by: `test: test/test-source-read-ratchet.test.mts :: "an unlisted reader, an unknown kind and stale rows are each reported with the rule id"`
- INV-5: "Day one is green: the fixture is seeded from the live tree, kinds assi" — verified by: `test: test/test-source-read-ratchet.test.mts :: "the ratchet test lists itself as invariant-lint"`
- INV-6: "CODING_STANDARDS.md § Tests STD-TEST-RUN-THE-CODE gets `enforced-by: r" — verified by: `file-contains: CODING_STANDARDS.md :: enforced-by: reviewer, test/test-source-read-ratchet.test.mts`
- INV-7: "Mutant validity is decided at GENERATION time in src/mutation.ts: for" — verified by: `test: test/mutation.test.mts :: "a generic-only comparison line yields no runnable mutant and one skipped unparseable result"`
- INV-8: "swap-comparison keeps looking: ===/!== first as today; then every `>`" — verified by: `test: test/mutation.test.mts :: "a line with both a generic and a real comparison yields a parseable swap on the comparison"`
- INV-9: "`typescript` is loaded lazily (dynamic import inside runMutationTests)" — verified by: `file-not-matches: src/mutation.ts :: /^import[^\n]*from "typescript"/m`
- INV-10: "Every generated inventory row's `source` becomes { path } — no `line`" — verified by: `test: test/generated-inventories-drift.test.mts :: "no committed docs/generated file contains a line field"`
- INV-11: "The dashboard /docs catalogues render `source.path` and link via sourc" — verified by: `file-lacks: dashboard/src/pages/docs/Catalogue.jsx :: source.line`
- INV-12: "Order of work follows the CLAUDE.md remove-behaviour rule: first rewri" — verified by: `manual: line pins in the inventory tests were rewritten first (drift comparison went red against the unchanged generator), then the generator and regeneration followed`
- INV-13: "The PR body's `## Files in scope` enumerates every touched path above" — verified by: `manual: this body's Files in scope enumerates every touched path`
- INV-14: "npm test, npm run typecheck:test and tsc pass; the mutation change is" — verified by: `test: test/mutation.test.mts :: "a report with only unparseable mutants reaches the all-skipped no-signal branch"`

Closes #5262

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Note: test/session-block.test.mts has 2 failures (out-of-credits/model-fallback) that also fail on origin/master in this environment (primary-model config); unrelated to this PR.
