Adds two ratchet shapes to the playbook vocabulary ratchet: `mktemp-no-trap` (a `mktemp` in a fenced shell block with no `trap` in the block) and `count-before-const` (a cardinal or digit run before a SCREAMING_SNAKE constant in prose). Burns down the three master `mktemp` lines (architecture-scan, discover, research) with a `trap ... EXIT` form.

Tier: 3 (operator-review change (scripts/ci/playbook-vocabulary-ratchet.ts, scripts/ci/playbook-vocabulary-baseline.json, test/playbook-vocabulary-ratchet.test.mts, +4 more))
Merge danger: two-way — a ratchet shape, baseline rows and playbook shell snippets; git revert restores the prior state.
Glossary impact: none
ADR impact: none

## Files in scope

- scripts/ci/playbook-vocabulary-ratchet.ts
- scripts/ci/playbook-vocabulary-baseline.json
- test/playbook-vocabulary-ratchet.test.mts
- docs/operator-playbooks/hydra-architecture-scan.md
- docs/operator-playbooks/hydra-discover.md
- docs/operator-playbooks/hydra-research.md

## Design-concept reconciliation

Artifact: `a1d55f631aef5964`

- INV-1: "Both checks are two new members of SHAPES in playbook-vocabulary-ratchet.ts" — verified by: `file-contains: scripts/ci/playbook-vocabulary-ratchet.ts :: "mktemp-no-trap", "count-before-const"] as const`
- INV-2: "mktemp-no-trap: one hit per `mktemp` command word" — verified by: `test: test/playbook-vocabulary-ratchet.test.mts :: "a mktemp call in a fenced shell block with no trap is one hit per call"`
- INV-3: "count-before-const: prose only (outside fences" — verified by: `test: test/playbook-vocabulary-ratchet.test.mts :: "a fenced block and a Historical: line are skipped"`
- INV-4: "Baselines are seeded to the exact current per-file counts" — verified by: `file-contains: scripts/ci/playbook-vocabulary-baseline.json :: mktemp-no-trap": 4`
- INV-5: "The three master mktemp lines named in the issue" — verified by: `file-contains: docs/operator-playbooks/hydra-discover.md :: trap 'rm -f $BASELINE_TMP' EXIT`
- INV-6: "Shape C (retired term / article in frontmatter) is out of scope" — verified by: `manual: no frontmatter shape or avoid-term scan change in the diff`
- INV-7: "Unit tests assert each new shape fires on a synthetic positive" — verified by: `test: test/playbook-vocabulary-ratchet.test.mts :: "a trap anywhere in the same block discharges every mktemp, including mktemp -d"`

Baseline-raise: scripts/ci/playbook-vocabulary-baseline.json docs/operator-playbooks/_fragments/hydra-dev-child-flow.md	mktemp-no-trap — new shape row seeded at current count (burn-down later)
Baseline-raise: scripts/ci/playbook-vocabulary-baseline.json docs/operator-playbooks/_fragments/hydra-qa-reference.md	mktemp-no-trap — new shape row seeded at current count
Baseline-raise: scripts/ci/playbook-vocabulary-baseline.json docs/operator-playbooks/hydra-qa.md	mktemp-no-trap — new shape row seeded at current count
Baseline-raise: scripts/ci/playbook-vocabulary-baseline.json docs/operator-playbooks/hydra-target-incident.md	mktemp-no-trap — new shape row seeded at current count
(Also seeded at 1: hydra-grill, hydra-review, hydra-skill-prune, hydra-target-build, hydra-target-discover, hydra-target-qa, hydra-target-research, hydra-target-sweep; count-before-const has zero live hits so no rows.)

## Acceptance

- [ ] Ratchet green — verified by: `npx tsx scripts/ci/playbook-vocabulary-ratchet.ts` exits 0
- [ ] New shapes tested — verified by: `npm run test:file -- test/playbook-vocabulary-ratchet.test.mts` exits 0

Closes #5719
