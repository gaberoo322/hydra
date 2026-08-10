# CI Quality Gates

These quality gates run on every pull request via `.github/workflows/ci.yml`.
They were re-homed from the in-cycle control loop (steps 6.7 and 6.9 of the
former `src/control-loop.ts`) in [issue #382](https://github.com/gaberoo322/hydra/issues/382)
so that every PR — hydra-dev, hydra-target-build, or manual — gets the same
merge safety net. The codex CLI runtime has since been removed (PR-3 of the
cut-over, parent epic [#380](https://github.com/gaberoo322/hydra/issues/380),
ADR-0006).

## Gates

### npm audit (advisory — orchestrator + dashboard)

> **Demoted from a required gate to an advisory surface** in
> [issue #3650](https://github.com/gaberoo322/hydra/issues/3650). Originally
> ([#479](https://github.com/gaberoo322/hydra/issues/479)) these were two
> **required** `ci.yml` jobs listed in `deploy.needs`. Because they run
> `npm audit` against the **live** advisory DB, a newly-published CVE against
> an already-installed dependency reddened them repo-wide with **zero code
> change** — freezing every merge and deploy (the "ambient poison pill", two
> instances 2026-07-24). They no longer block.

**What it does.** Runs `npm audit --omit=dev --audit-level=high` (via
`scripts/ci/npm-audit-scan.ts`, using `--package-lock-only` so no `npm ci` is
needed) against the orchestrator (`./`) and dashboard (`./dashboard/`)
production dep trees. Only `high`/`critical` advisories are considered; `low`
and `moderate` are ignored.

**Where it runs now (two surfaces, neither blocking):**
- **`advisory-checks.yml`** — a non-blocking step per tree on every PR. A
  non-allowlisted high/critical shows a red X for visibility, but the
  `advisory-checks` workflow is not a required branch-protection context, so it
  never blocks auto-merge.
- **`audit-nightly.yml`** — a daily scheduled scan that files (or updates) a
  single `ready-for-agent` dep-bump issue on a new non-allowlisted
  high/critical, so a fresh CVE becomes tracked work instead of a freeze.

**Fail-closed allowlist.** `scripts/ci/npm-audit-scan.ts` is the single tested
source of the pass/fail logic (`test/npm-audit-scan.test.mts`): a package
blocks only if it carries an advisory whose GHSA id is **not** in
`AUDIT_ALLOWLIST`; pure-transitive entries are skipped (their advisory-bearing
parent is judged directly); anything not provably waived blocks. The dashboard
surface waives `GHSA-qwww-vcr4-c8h2` (react-router RSC CSRF — inapplicable to
the Vite SPA, no forward fix).

**No-fix policy.** `npm audit fix` is **not** run automatically. Remediation is
a forward dep-bump (or, only when no forward fix exists, an operator-reviewed
`AUDIT_ALLOWLIST` entry).

### `mutation-test`

**What it does.** Runs the in-tree mutation runner (`src/mutation.ts`,
`runMutationTests()`) against the **`src/**/*.ts` files changed in the
PR diff**, then fails when the kill rate is below the configured floor.

**Diff scoping (issue #653).** The gate is diff-only — it never mutates
the full source tree. The workflow computes the changed-file set as
`git diff --name-only $(git merge-base origin/master HEAD)...HEAD`
(falling back from `gh pr diff --name-only` when GH is unreachable).
`scripts/ci/mutation-check.ts::filterMutationCandidates()` then:

1. Keeps only paths that start with `src/` and end in `.ts` (positive
   allowlist — `dashboard/**`, `scripts/**`, `test/**`, `docs/**`,
   `config/**`, asset files, lockfile bumps all drop out).
2. Re-applies `shouldSkipMutation()` from `src/mutation.ts` to strip
   co-located `*.test.ts` / `*.spec.ts` / `*.d.ts` files that pass the
   `src/.../*.ts` prefix but aren't real source.

**Empty-set skip (NOT a silent pass).** When the filtered list is empty
the gate writes `status: "skipped"` with a clear reason (`"no
src/**/*.ts files changed"`) to stdout and a `mutation-gate: skipped —
…` line to stderr, and exits 0. The CI step summary surfaces the
skipped status so reviewers see exactly why the gate didn't run.
Common skip scenarios:

- Asset-only PRs (PNG sprites, JSON fixtures, lockfile bumps)
- Doc-only PRs (`.md`, `docs/**`, ADRs)
- Dashboard-only PRs (`dashboard/**` — the dashboard has its own
  build / typecheck step)
- Test-only PRs (test additions live under `test/**`, never in `src/`)

The kill-rate threshold itself is unchanged. A PR that touches even one
`src/**/*.ts` file runs the full gate against that file's mutants.

**Threshold (tier-dependent — issue #778).** The floor the kill rate must
clear depends on the PR's **Modification Tier** (computed by the workflow
via `scripts/tier-classify.ts` → `classifyChange()`, the single tier
authority, and passed to the gate as `PR_TIER`):

| Tier band | Repo variable | Default | Applies to |
|-----------|---------------|---------|------------|
| T1 / T2   | `MUTATION_KILL_RATE_FLOOR`    | `30` | Prompt / skill / dashboard diffs |
| T3 / T4   | `MUTATION_KILL_RATE_FLOOR_T3` | `55` | Core `src/` + demoted infra (T3) and Verifier Core (T4) |

The predicate is `tier >= 3` (in `selectKillFloor()` in
`scripts/ci/mutation-check.ts`), so **T4 / Verifier-Core diffs inherit the
T3 floor and can never drop below it** — consistent with ADR-0015's
monotonic ladder (T4 inherits T3's verification depth). The base `30`
still matches the pre-cut-over in-cycle gate
(`DEFAULT_STANDARD_KILL_THRESHOLD = 30` in `src/mutation.ts`).

Floor selection is pure and deterministic from the tier integer — there is
**no per-path hardcoding** in the gate. Both floors are repo-variable
configurable, not buried magic numbers; if `PR_TIER` is missing or garbled
the gate falls back to the conservative T3 band rather than silently
relaxing. Issue #653 (diff scoping) changed only WHAT is mutated; issue
#778 raises the acceptance bar for deep diffs.

**Budget.** `MUTATION_TIME_BUDGET_MS` env var (default `540_000` = 9 minutes).
The CI step itself has a hard 10-minute `timeout-minutes: 10` ceiling.

**No-signal behaviour (tier-aware — issue #1120).** When the diff yields zero
**testable** mutants (`testable = totalMutants - skipped === 0` — comment-only /
formatting changes that generate nothing, or every generated mutant fails to
compile and is skipped) the gate exits `0` (non-blocking) but does **not**
report a clean `pass`. The pre-#1120 gate fabricated `killRate = 100` here,
which let a T3/T4 diff clear the raised kill-floor with **no fault-detection
signal at all** — a silent merge-gate bypass. The status is now tier-aware:

| Tier | No-signal status | `killRate` | Blocks merge? |
|------|------------------|-----------|---------------|
| T1 / T2 | `neutral` | `null` | no (preserved historical behaviour) |
| T3 / T4 | `warn` | `null` | no — surfaces the gap in the step-summary JSON |

The `reason` field distinguishes the two sub-cases: **no mutants generated**
(`candidatesGenerated === 0` — comment-only / trivial diff) vs **all generated
mutants skipped** (`totalMutants > 0 && skipped === totalMutants` — every
candidate uncompilable). `killRate` is `null` on both no-signal branches — the
gate never synthesises a 100% kill rate where there was no signal. A
non-finite/missing `PR_TIER` classifies conservatively as `warn` (mirrors the
floor fallback). The all-killed path (`testable > 0`, `killed === testable`)
still reports `pass` with `killRate: 100`, and a below-floor kill rate still
exits `2` and blocks.

This is distinct from `skipped`: `skipped` means "no src/**/*.ts files in diff,
runner never invoked"; `neutral`/`warn` mean "runner ran, couldn't produce a
signal." The status derivation lives in the pure exported `classifyNoSignal`
helper in `scripts/ci/mutation-check.ts` (unit-tested via the same seam as
`selectKillFloor` / `filterMutationCandidates`; the historical in-cycle helper
`classifyNoSignalDecision` in `src/mutation.ts` was removed by issue #476 along
with the rest of the orphaned gate orchestration).

**Quick-fix bypass.** PR bodies containing the literal token `[quick-fix]` skip
the gate with a `neutral` status. Matches the existing in-cycle exemption for
quick-fix anchors and the `scope-check` gate's `[quick-fix]` semantics
(symmetric — issue #653 acceptance criterion 4).

### stryker-check (advisory — comparison-only, tool-scout #3835)

**What it does.** Runs Stryker (`@stryker-mutator/core`) *alongside* the
required `mutation-test` gate and emits a **comparison**: which surviving
mutants Stryker surfaces that the homegrown gate does not attempt at all,
grouped by Stryker mutator category. The homegrown gate mutates per-line by
regex with an essentially four-entry mutator list (`negate-boolean-return`,
`swap-comparison`, `negate-condition`, `remove-early-return` in
`src/mutation.ts`); Stryker mutates at AST level across a far broader catalog
(`ArithmeticOperator`, `StringLiteral`, `LogicalOperator`, …). Only
`EqualityOperator` and `BooleanLiteral` have a homegrown counterpart (and only
as a subset); every other Stryker category is one the homegrown gate does not
attempt — survivors there are the signal this scan exists to surface.

**Advisory — never gates a merge.** This runs in its own workflow
(`.github/workflows/stryker-check.yml`), a Tier-3 sibling that is **not** a
required branch-protection context and is never referenced from `ci.yml`. The
run step always exits 0 — the wrapper `scripts/ci/stryker-scan.ts` never exits
non-zero and the workflow `|| true`s — so a red Stryker run, a crash, or a low
mutation score surfaces only via the uploaded artifact and step summary, never
by blocking. Promotion to a required gate is a separate, operator-gated
follow-up (the issue's out-of-scope list).

**Tool lane (ADR-0005).** Stryker is invoked through a pinned
`npx --yes -p @stryker-mutator/core@9.6.1` with **no `package.json` dependency
entry** (runtime or dev) — the same no-dependency lane as ast-grep / comby /
promptfoo / taze / osv-scanner. The pin lives in `scripts/ci/stryker-scan.ts`,
not in `package.json`.

**Diff scoping (issue #653 — same as the required gate).** Stryker mutates
only the PR's diff-changed `src/**/*.ts` files, computed the same way
`scripts/ci/mutation-check.ts::filterMutationCandidates()` does — the wrapper
REUSES that filter. A full-tree Stryker run is a regression against #653 and is
not acceptable. Asset / doc / test-only PRs skip cleanly (the wrapper emits a
`status: "skipped"` row with a reason).

**Comparison output.** `scripts/ci/stryker-scan.ts` writes
`stryker-comparison.json` (uploaded as the `stryker-comparison-*` artifact),
carrying:

- `comparison.survivorsNotAttemptedByHomegrown` — surviving mutants grouped by
  Stryker category with **no** homegrown counterpart (`totalSurvivors` +
  `distinctCategories` is the headline number).
- `comparison.survivorsInAttemptedCategories` — survivors in categories the
  homegrown gate does cover (`EqualityOperator`, `BooleanLiteral`).
- `recommendationSignal` — a one-line conclusion, e.g. *"Stryker surfaced N
  surviving mutant(s) across M category/categories the homegrown gate does not
  attempt (ArithmeticOperator, StringLiteral)"*. When that number is 0 it states
  the run supports a **drop** recommendation.

**Budget.** A Stryker `commandRunner` run executes the full `npm test` suite
once per mutant, so the job carries a hard `timeout-minutes: 20` ceiling and the
wrapper caps the mutated file count (`STRYKER_MAX_FILES`, default 3, mirroring
the homegrown gate's `MUTATION_MAX_MUTANTS`). The run is best-effort within
budget; a timeout uploads whatever artifact exists and never blocks.

**Keep / replace / drop.** This workflow is the instrument for a decision, not
a permanent ratchet. A written keep / replace / drop recommendation — citing
the measured comparison — is filed as a follow-up issue after the workflow has
run on at least 10 PRs. If the broader Stryker catalog surfaces no survivors the
homegrown gate misses, the correct recommendation is **drop**, and that is a
success outcome for the experiment, not a failure.

### `scope-check`

**What it does.** Reads the PR body and (when linked) the issue body, extracts
the `Files in scope` markdown section, compares it to the diff, and fails when
**more than 80%** of changed files are out-of-scope AND there are **more than 3**
out-of-scope files. Thresholds match the historical in-cycle gate
(`outOfScopeRatio > 0.8 && outOfScope.length > 3`); the original
`src/scope-enforcement.ts` was removed by issue #476 and the CI script is
now the single source of truth.

**Thresholds.**
- `SCOPE_OUT_OF_SCOPE_THRESHOLD` env var, float `0..1`, default `0.8`
- `SCOPE_MIN_OUT_OF_SCOPE_COUNT` env var, int, default `3`

**Defining scope.** Add a markdown section to the PR body or linked issue:

```markdown
## Files in scope

- `src/foo.ts`
- `src/foo/`
- `docs/quality-gates.md`
```

The matcher accepts either backticked code spans or bullet text. Paths are
substring/prefix matched, so a directory like `src/foo/` covers every file
beneath it. If no `Files in scope` section is present anywhere, every changed
file is treated as out-of-scope and the gate will fire as soon as the count
threshold is reached.

**Quick-fix bypass.** Same `[quick-fix]` token as the mutation gate.

**Hard out-of-scope block (issue #396).** Issues and PRs may declare a `## Files out of scope` section. Any changed file matching an entry there fails the gate immediately, regardless of the ratio thresholds. This is the subagent-side replacement for the in-cycle `reconcilePlanVsActual` step deleted in PR #400.

**Scope-justification escape hatch (issue #396).** When a subagent legitimately needs to touch an out-of-scope file (e.g. a shared test fixture), it includes a `scope-justification:` block in the PR body listing each affected path with a one-line reason. The gate excludes justified files from both the hard-block and the ratio count, and echoes the justification in the CI step summary so reviewers can audit the override. Example:

```markdown
scope-justification: `test/helpers/fixtures.ts` — shared fixture used by the new test
```

The justification only counts if it's in the PR body — issue bodies don't get to pre-authorise scope violations.

## Required vs advisory

Both jobs run on `pull_request` and post a check status. Branch protection
needs to be updated so they're **required for merge** — that's an operator
manual step on `gh api repos/.../branches/master/protection` since GitHub
Actions PRs can't modify branch protection.

If a gate goes flaky, an operator can downgrade it to advisory by marking it
non-required in branch protection. The job itself can be made advisory by
inverting the final `exit $STATUS` line in `ci.yml` (e.g. `exit 0 # advisory`).

## Overriding the gate

There is **no per-PR bypass label**. The accepted escapes are:

1. **Tag the PR with `[quick-fix]`** — sets both gates to neutral. Use only for
   small, low-risk diffs (the in-cycle gate used this for ≤2-file changes).
2. **Add a `Files in scope` section** — declare the intended blast radius
   explicitly. The scope gate respects it; the mutation gate runs unchanged.
3. **Operator-only** — temporarily lower `MUTATION_KILL_RATE_FLOOR` or raise
   `SCOPE_OUT_OF_SCOPE_THRESHOLD` via repo variables, then revert. Document the
   reason in a follow-up issue.

## What was removed

The former in-cycle control loop ran four checks that are now either CI gates
or accepted as gone:

| Former in-cycle step | Status (post-cut-over) |
|---|---|
| 6.5 reconcilePlanVsActual | Removed with `src/control-loop.ts` (PR-3). Replacement (issue #396): the per-issue `Files in scope` / `Files out of scope` contract, the label-validation workflow that gates `ready-for-agent`, and the subagent playbook step that mirrors the contract into the PR body — all enforced by the `scope-check` job below. `scope-justification:` PR-body blocks are the explicit per-file escape hatch. hydra-qa eyeball review remains the backstop. |
| 6.7 runMutationTests | Re-homed to CI `mutation-test` job. |
| 6.8 jitTestGeneration | Removed with `src/control-loop.ts` (PR-3). Replacement: the 1200+ regression test suite and reviewer judgement. |
| 6.9 scopeEnforcement | Re-homed to CI `scope-check` job. |

See `docs/codex-removal-measurement.md` for the data-driven rollout plan
gating PR-3.
