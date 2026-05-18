# Issue tracker conventions

Issues are tracked in GitHub Issues on `gaberoo322/hydra` via the `gh` CLI. Subagents (`hydra-dev`, `hydra-target-build`, `hydra-qa`) read and write issues directly — there is no in-repo issue store.

## Issue lifecycle

```
needs-triage  →  needs-info       (asked for more detail; back to operator)
              →  ready-for-agent  (fully specified; subagent may pick up)
              →  in-progress      (claimed by a subagent)
              →  needs-qa         (PR open, awaiting QA)
              →  blocked          (depends on another open issue)
              →  ready-for-human  (subagent gave up; operator decision)
              →  wontfix          (closed without implementation)
              →  target-backlog   (about ~/hydra-betting, queued to target board)
```

See `docs/agents/triage-labels.md` for the canonical label semantics.

## Scope contract (issue #396)

Every issue labelled `ready-for-agent` MUST include a `## Files in scope` section, and SHOULD include a `## Files out of scope` section. This is the subagent-side replacement for the deleted in-cycle `reconcilePlanVsActual()` step.

### Why

After PR #400 (issue #383) deleted the in-process planner and the deterministic plan-vs-actual diff that ran in `src/control-loop.ts:reconcilePlanVsActual()`, the only thing standing between a subagent and arbitrary file edits was `hydra-qa`'s eyeball review. The scope-creep auto-promoted planner rule had 231 hits before the deletion — it was the single most-recorded failure mode. Pushing the scope contract into the issue body re-establishes the gate at the entry point that the subagents actually consult.

### What the sections do

| Section | Effect |
|---|---|
| `## Files in scope` | Soft boundary. Files matching the listed entries (backticked code spans or bullet text; prefix match, so `src/foo/` covers everything beneath) are fair game. Files outside this list count toward the ratio-based scope gate (`>80% out-of-scope` blocks merge). |
| `## Files out of scope` | Hard boundary. ANY changed file matching this list fails CI's `scope-check` job regardless of ratio — unless explicitly justified (see below). |
| `scope-justification:` block in the PR body | Per-file escape hatch. Whitelists a specific out-of-scope file with a one-line rationale. Loud (logged in the CI step summary) but allowed. |

### Example

```markdown
## Files in scope

- `scripts/ci/scope-check.ts`
- `test/ci-scope-check.test.mts`
- `docs/operator-playbooks/hydra-dev.md`

## Files out of scope

- `src/control-loop.ts`
- `src/preflight.ts`
```

And in the resulting PR body, if the subagent had to touch a shared fixture:

```markdown
scope-justification: `test/helpers/fixtures.ts` — shared test fixture required by the new test
```

### Enforcement

- `.github/ISSUE_TEMPLATE/feature-or-bug.yml` — GitHub form template surfaced at issue-creation time. Prefills `Problem Statement`, `Evidence`, `Files in scope`, and `Files out of scope` so structurally-correct issues are the default rather than a convention triage has to remember. `.github/ISSUE_TEMPLATE/config.yml` controls whether blank issues stay available alongside the form.
- `.github/workflows/issue-label-validation.yml` — runs on three triggers:
  - `issues: labeled` — when `ready-for-agent` is applied, blocks the transition if `## Files in scope` is missing (moves the label to `needs-info` and comments).
  - `issues: edited` — when a `ready-for-agent` issue's body is edited, re-validates so removing the scope section after the label is applied still demotes the issue (issue #505).
  - `schedule: nightly cron` — audits every open `ready-for-agent` issue and demotes any that drift out of compliance. Catches grandfathered issues that pre-date the workflow + race-condition bypasses of the per-event triggers (issue #505).

  Operator override is unchanged: "fix the body and re-apply the label".
- `.github/workflows/ci.yml`, `scope-check` job — parses both sections from the PR body and the linked issue body; fails the PR if drift is detected. See `docs/quality-gates.md`.
- Subagent playbooks (`docs/operator-playbooks/hydra-dev.md`, `hydra-target-build.md`) embed a scope-respect block in the child prompt so the subagent reads the contract before writing code.

## Standard fetch / edit commands

```bash
# Fetch an issue including body + labels
gh issue view <N> --repo gaberoo322/hydra --json number,title,body,labels,state

# List ready-for-agent issues
gh issue list --repo gaberoo322/hydra --label ready-for-agent --state open

# Transition labels
gh issue edit <N> --repo gaberoo322/hydra --remove-label ready-for-agent --add-label in-progress
gh issue edit <N> --repo gaberoo322/hydra --remove-label in-progress --add-label needs-qa

# Close with a reason
gh issue close <N> --repo gaberoo322/hydra --comment "Resolved by #<PR>" --reason completed
```

## See also

- `docs/agents/triage-labels.md` — full label vocabulary + transitions
- `docs/quality-gates.md` — the CI gates that consume the scope contract
- `docs/operator-playbooks/hydra-dev.md` — subagent that consumes ready-for-agent issues
- ADR-0005 — operator escalation is narrow (closed list of cases that warrant `ready-for-human`)
