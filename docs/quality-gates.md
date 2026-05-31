# CI Quality Gates

These quality gates run on every pull request via `.github/workflows/ci.yml`.
They were re-homed from the in-cycle control loop (steps 6.7 and 6.9 of the
former `src/control-loop.ts`) in [issue #382](https://github.com/gaberoo322/hydra/issues/382)
so that every PR — hydra-dev, hydra-target-build, or manual — gets the same
merge safety net. The codex CLI runtime has since been removed (PR-3 of the
cut-over, parent epic [#380](https://github.com/gaberoo322/hydra/issues/380),
ADR-0006).

## Gates

### `npm-audit-orchestrator` / `npm-audit-dashboard`

**What it does.** Runs `npm audit --omit=dev --audit-level=high` against the
installed lockfile after `npm ci`. Fails the workflow on any `high` or
`critical` advisory in a production dependency. The orchestrator (`./`) and
the dashboard (`./dashboard/`) get their own jobs so each tree fails
independently and the step summary names the offending package set
explicitly. Added in [issue #479](https://github.com/gaberoo322/hydra/issues/479).

**Threshold.** `--audit-level=high` — only `high` and `critical` block. `low`
and `moderate` advisories are intentionally ignored on the first cut (per
issue #479's "start strict on high+ only"). Tighten via `--audit-level=moderate`
in `ci.yml` if/when the operator chooses.

**Inputs.** `package-lock.json` plus the locally-resolved `node_modules` from
`npm ci`. Transitive deps in the lockfile are scanned; dev deps are excluded
via `--omit=dev`.

**Step summary.** Each job emits a `GITHUB_STEP_SUMMARY` table listing every
high/critical advisory: package name, severity, vulnerable range, and the
advisory URLs pulled from the npm advisory DB. Empty findings render as
"No high or critical advisories found." The human-readable `npm audit`
output is also echoed to the step log via a second invocation so the raw
report is one click away.

**No-fix policy.** `npm audit fix` is **not** run automatically. Advisory
remediation is an operator decision — a high-severity bump may itself
require a version-pin discussion. This gate only blocks merge; it does not
upgrade deps.

**Deploy linkage.** Both jobs are listed in `deploy.needs` so a failing
audit also blocks the master-branch auto-deploy job, mirroring how `test`
and `dashboard-build` gate deployment.

**No bypass.** Unlike `mutation-test` and `scope-check`, the audit gate has
no `[quick-fix]` bypass — a known-vulnerable production dependency is
never a quick-fix. Operator override is to either upgrade the dep or
relax `--audit-level` in the workflow (and then revert).

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

**No-signal behaviour.** When the diff yields zero compilable mutants
(comment-only / formatting changes, or every generated mutant fails to compile)
the gate exits `0` with a `neutral` status. This is distinct from `skipped`:
`skipped` means "no src/**/*.ts files in diff, runner never invoked";
`neutral` means "runner ran, couldn't produce a signal." Implemented in
`scripts/ci/mutation-check.ts` (the historical in-cycle helper
`classifyNoSignalDecision` in `src/mutation.ts` was removed by issue #476
along with the rest of the orphaned gate orchestration).

**Quick-fix bypass.** PR bodies containing the literal token `[quick-fix]` skip
the gate with a `neutral` status. Matches the existing in-cycle exemption for
quick-fix anchors and the `scope-check` gate's `[quick-fix]` semantics
(symmetric — issue #653 acceptance criterion 4).

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
