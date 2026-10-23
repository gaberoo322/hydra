# Merge Gate (issue #249, removed in PR-3 / #383)

> **Retired by / replaced by.** Moved verbatim from `docs/reference.md` (issue #4599, audit REF-16). The in-process gate was deleted with the codex-CLI cut-over (ADR-0006); GitHub branch protection plus the CI quality gates (`docs/quality-gates.md`) replace it.


The in-process `src/gate.ts` facade and its delegates (`verification.ts`,
`scope-enforcement.ts`, `runMutationGate` in `mutation.ts`,
`pipeline-steps.ts`, `post-merge.ts`, `control-loop.ts`) were deleted with
the codex-CLI cut-over (PR-3, issue #383). The merge gate is now
out-of-process: GitHub branch protection + CI quality gates
(`.github/workflows/ci.yml`, `scripts/ci/scope-check.ts`,
`scripts/ci/mutation-check.ts`, `tier-gate`) enforce the same proofs at PR
time. See [ADR-0006](../adr/0006-codex-cli-removed-autopilot-only.md) and
[`docs/quality-gates.md`](../quality-gates.md).

Issue #476 finished the residual cleanup: `src/scope-enforcement.ts` and
the in-cycle gate orchestration in `src/mutation.ts` (`runMutationGate`,
`MUTATION_DECISION`, `classifyNoSignalDecision`, `summarizeMutationTests`,
`getQuickFixKillThreshold`) were deleted. The CI gate keeps importing the
pure helpers (`runMutationTests`, `shouldSkipMutation`, `SKIP_PATTERNS`)
from `src/mutation.ts`.
