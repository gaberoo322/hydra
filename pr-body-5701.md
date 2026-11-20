Replaces every `|| true` swallowed exit in the four sibling advisory workflows with the #5702 shape (`rc=0; cmd || rc=$?` then `::error` + `exit 1` when the tool did not run). Findings stay advisory (warning annotation / artifact).

Tier: 3 (core src/ and demoted infra; /api/tier verified)
Merge danger: two-way — workflow-only YAML plus a test; git revert restores the prior behaviour.

## Files in scope

- .github/workflows/audit-nightly.yml
- .github/workflows/deps-check.yml
- .github/workflows/osv-scan.yml
- .github/workflows/stryker-check.yml

scope-justification: test/advisory-workflows-fail-loud.test.mts (INV-8 drift guard), test/fixtures/suite-count-baseline.json, test/fixtures/test-pools.json (rows for the new test), .changelog/5701-advisory-fail-loud.md

Baseline-raise: test/fixtures/suite-count-baseline.json test/advisory-workflows-fail-loud.test.mts — new drift-guard test file (INV-8)
Baseline-raise: test/fixtures/test-pools.json test/advisory-workflows-fail-loud.test.mts — new parallel-pool row for the same file
Baseline-raise: test/fixtures/test-source-read-baseline.json test/advisory-workflows-fail-loud.test.mts — new drift-guard row (reads workflow YAML by design)

Glossary impact: none
ADR impact: none

## Design-concept reconciliation

Artifact: `95d30e7b18e7`

- INV-1: "INV-1 Zero `|| true` in the four workflows" — verified by: `file-lacks: .github/workflows/deps-check.yml :: || true`
- INV-2: "INV-2 Every former `|| true` site becomes the #5702 shape" — verified by: `file-contains: .github/workflows/deps-check.yml :: || rc=$?`
- INV-3: "INV-3 osv-scan.yml exit classification" — verified by: `file-contains: .github/workflows/osv-scan.yml :: jq -e 'type == "object" and has("results")'`
- INV-4: "INV-4 deps-check.yml: any non-zero exit from" — verified by: `file-contains: .github/workflows/deps-check.yml :: jq -e 'type == "object" and has("packages")' deps-staleness.json`
- INV-5: "INV-5 stryker-check.yml: a non-zero exit from" — verified by: `file-contains: .github/workflows/stryker-check.yml :: stryker-comparison.json missing or empty`
- INV-6: "INV-6 audit-nightly.yml: both run steps switch from" — verified by: `test: test/advisory-workflows-fail-loud.test.mts :: "audit-nightly run steps use errexit"`
- INV-7: "INV-7 Scope fence: none of the four workflows is added" — verified by: `file-lacks: .github/workflows/stryker-check.yml :: continue-on-error`
- INV-8: "INV-8 Drift guard in the required `test` job" — verified by: `file-exists: test/advisory-workflows-fail-loud.test.mts`
- INV-9: "INV-9 The comby rule `scripts/comby-rules/workflow-no-swallowed-exit.toml`" — verified by: `file-lacks: .github/workflows/audit-nightly.yml :: || true`

## Acceptance

- [ ] No swallowed exit — verified by: `npm run test:file -- test/advisory-workflows-fail-loud.test.mts` exits 0

Closes #5701

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Deviation from INV-4: taze --json emits an object with a `packages` array (verified locally), not a bare array, so the validity check is `type == "object" and has("packages")`.
