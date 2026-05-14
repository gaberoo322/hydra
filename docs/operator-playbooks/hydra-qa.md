---
name: hydra-qa
description: Automated QA verification for Hydra orchestrator PRs — checks acceptance criteria, runs tests, and auto-approves or rejects.
when_to_use: "When the user says 'QA issue #N', 'verify', 'check the PR', or an issue has the needs-qa label."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
claude_only: true
---

# Hydra QA

Automated QA verification for PRs against the Hydra orchestrator. Checks each acceptance criterion against the diff, runs tests, classifies the verdict in **one pass over the PR**, then exits.

## Verdict tiers (issue #405)

The skill **never loops waiting on CI**. After the code-review pass it emits exactly one of four verdicts and returns:

| Verdict | Meaning | Autopilot behaviour |
|---|---|---|
| `PASS` | Review passed AND every required CI check has concluded successfully. | Approve and merge immediately. |
| `FAIL` | Review failed for any criterion, OR a required check has already failed/errored/timed-out. | Re-label `ready-for-agent`, comment failing criteria. |
| `PASS-pending-CI` | Review passed, no required check has failed, but at least one check (required or optional) is still `queued` / `in_progress` / `pending`. | Re-poll CI on the autopilot tick; merge once green or downgrade to `FAIL` if a required check later fails. The `hydra-qa` subagent has already exited. |
| `FAIL-pending-CI` | Reserved tier — currently unused by the classifier. Documented so operators / future playbooks can route a "review passed but a non-required check is in a soft-failure tier that we want to surface" case without re-running QA. | Treat as `PASS-pending-CI` for merge gating; surface in the verdict body. |

**Why this matters:** before #405 the subagent looped on `mutation-test: QUEUED` for hours. PR #403 auto-merged before a (correct) `FAIL` verdict landed. The single-pass exit pattern is non-negotiable: autopilot polls CI; this skill does not.

Pure helpers backing the classifier live in `scripts/ci/qa-verdict.ts`. The regression test `test/hydra-qa-prompt-verdict.test.mts` locks in the smoking-gun case: `mutation-test: QUEUED` + everything-else-green → `PASS-pending-CI` (not a wait).

## Pre-flight (parent context)

### 1. Select issue

If `$issue_number` provided, use it. Otherwise:
```bash
gh issue list --repo gaberoo322/hydra --label "needs-qa" --state open --json number,title --jq '.[0]'
```
None → report and stop.

### 2. Find linked PR

```bash
gh pr list --repo gaberoo322/hydra --state open --json number,title,body \
  --jq '.[] | select(.body | test("closes #'$issue_number'|Closes #'$issue_number'|fixes #'$issue_number'|Fixes #'$issue_number'"; "i"))'
```

If no PR, check linked branches:
```bash
gh issue develop --list $issue_number --repo gaberoo322/hydra
```

If still no PR → comment on issue and stop.

### 3. Collect current CI state (single GraphQL call, no looping)

```bash
gh pr view $pr_number --repo gaberoo322/hydra --json statusCheckRollup \
  --jq '.statusCheckRollup | map({name: (.name // .context), status: (.status // "completed"), conclusion: .conclusion, required: (.isRequired // false)})'
```

Pass this list to the subagent verbatim. The subagent does **not** re-query CI mid-run.

### 4. Spawn worktree agent

- **Claude:** `Agent(isolation: "worktree", prompt: <see below>)`
- **Codex:** `codex exec --skill hydra-qa-child --json '{"issue":N,"pr":M,"checks":[...]}'`

Child receives: issue body, acceptance criteria, PR number, **and the checks snapshot**. Child:
1. Checks out the PR branch into the worktree
2. Verifies each acceptance criterion against the diff (use `gh pr diff $pr_number`)
3. Runs `npm test` and `npm run typecheck`
4. Calls `classifyVerdict(reviewVerdict, checks)` from `scripts/ci/qa-verdict.ts` to produce the final verdict
5. Returns the verdict + the rendered `checks:` block

The child **must not** call `gh pr checks --watch`, `sleep`-loop over `gh pr view`, or otherwise block waiting for CI. If a required check is still pending, emit `PASS-pending-CI` and exit.

### 5. Post-agent verdict routing

**Verdict `PASS`** (review PASS + all required checks green):
```bash
gh pr review $pr_number --repo gaberoo322/hydra --approve --body "> *Automated QA*

All acceptance criteria verified. Tests pass. Merging.

$CHECKS_BLOCK"
gh pr merge $pr_number --repo gaberoo322/hydra --squash --delete-branch
```
Issue auto-closes via `closes #N` in PR body.

**Verdict `PASS-pending-CI`** (review PASS + at least one check still queued/in_progress):
```bash
# Do NOT approve yet — branch protection will block merge anyway, and we want
# the autopilot poll loop to see the canonical "pending" state.
gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — pending CI*

Code review **PASS**. Awaiting CI:

$CHECKS_BLOCK

Verdict: \`PASS-pending-CI\`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**"
# Leave the needs-qa label in place so autopilot re-dispatches on the next tick.
```

**Verdict `FAIL` or `FAIL-pending-CI`** (any criterion unmet, tests fail, or a required check has already failed):
```bash
gh pr review $pr_number --repo gaberoo322/hydra --request-changes --body "> *Automated QA*

$FINDINGS

$CHECKS_BLOCK"
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" --add-label "ready-for-agent"
gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated QA failed*

**Failed criteria:**
$FAILED_CRITERIA

**Details:** See PR #$pr_number review comments.

Returning to ready-for-agent for retry."
```

### 6. Lesson capture on FAIL (issue #392)

After a FAIL verdict — before relaying the report — record a planner pattern
so the agent-memory write path keeps producing durable rules in
`config/feedback/to-planner.md`. This is the only post-cycle writer to
`hydra:memory:planner:patterns` for Claude-driven QA after #383 deletes
codex-runner.

```bash
# One call per failed criterion (the endpoint dedupes on cue).
for failed in "${FAILED_CRITERIA[@]}"; do
  curl -fsS -X POST http://localhost:4000/api/memory/subagent-lesson \
    -H 'content-type: application/json' \
    -d "$(jq -n \
      --arg skill "hydra-qa" \
      --arg outcome "qa-fail" \
      --arg cue "acceptance-criterion-unmet" \
      --arg context "PR #${pr_number}: ${failed}" \
      --arg cycleId "hydra-qa-${issue_number}-$(date +%s)" \
      '{skill: $skill, outcome: $outcome, cue: $cue, context: $context, cycleId: $cycleId}')" \
    || echo "WARN: lesson capture failed (non-fatal)"
done
```

API failures are non-fatal — log and continue. The endpoint validates inputs
and forwards to `recordPattern()` so the existing 3-hit auto-promotion
pipeline still applies. Don't call this on PASS / PASS-pending-CI (positive
QA outcomes currently don't train a memory).

Relay the QA report to the user.
