# CI Quality Gates

These quality gates run on every pull request via `.github/workflows/ci.yml`.
They were re-homed from the in-cycle control loop (steps 6.7 and 6.9 of the
former `src/control-loop.ts`) in [issue #382](https://github.com/gaberoo322/hydra/issues/382)
so that every PR — hydra-dev, hydra-target-build, or manual — gets the same
merge safety net. The codex CLI runtime has since been removed (PR-3 of the
cut-over, parent epic [#380](https://github.com/gaberoo322/hydra/issues/380),
ADR-0006).

## Gates

### `mutation-test`

**What it does.** Runs the in-tree mutation runner (`src/mutation.ts`,
`runMutationTests()`) against the files changed in the PR diff, then fails when
the kill rate is below the configured floor.

**Threshold.** `MUTATION_KILL_RATE_FLOOR` repo variable (integer percent).
Default: `30`. Matches the pre-cut-over in-cycle gate
(`DEFAULT_STANDARD_KILL_THRESHOLD = 30` in `src/mutation.ts`).

**Budget.** `MUTATION_TIME_BUDGET_MS` env var (default `540_000` = 9 minutes).
The CI step itself has a hard 10-minute `timeout-minutes: 10` ceiling.

**Inputs.** Diff vs the base branch (`git diff <base>...HEAD --name-only`),
filtered through `SKIP_PATTERNS` (tests, configs, migrations, `.d.ts`,
`node_modules`).

**No-signal behaviour.** When the diff yields zero compilable mutants
(comment-only / formatting changes, or every generated mutant fails to compile)
the gate exits `0` with a `neutral` status. Mirrors `classifyNoSignalDecision()`
in `src/mutation.ts`.

**Quick-fix bypass.** PR bodies containing the literal token `[quick-fix]` skip
the gate with a `neutral` status. Matches the existing in-cycle exemption for
quick-fix anchors.

### `scope-check`

**What it does.** Reads the PR body and (when linked) the issue body, extracts
the `Files in scope` markdown section, compares it to the diff, and fails when
**more than 80%** of changed files are out-of-scope AND there are **more than 3**
out-of-scope files. Thresholds match the pre-cut-over in-cycle gate
(`outOfScopeRatio > 0.8 && outOfScope.length > 3` in `src/scope-enforcement.ts`).

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
| 6.5 reconcilePlanVsActual | Removed with `src/control-loop.ts` (PR-3). Replacement: hydra-qa eyeball review + the `Files in scope` PR convention enforced by `scope-check`. |
| 6.7 runMutationTests | Re-homed to CI `mutation-test` job. |
| 6.8 jitTestGeneration | Removed with `src/control-loop.ts` (PR-3). Replacement: the 1200+ regression test suite and reviewer judgement. |
| 6.9 scopeEnforcement | Re-homed to CI `scope-check` job. |

See `docs/codex-removal-measurement.md` for the data-driven rollout plan
gating PR-3.
