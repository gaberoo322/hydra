---
name: hydra-pr-rebase
description: Auto-rebase OPEN PRs that are BEHIND master, and surface DIRTY (conflicting) PRs for operator review.
when_to_use: "When the operator says 'rebase PRs', 'check stale PRs', or 'unblock the merge queue', or after a master merge leaves PRs behind."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
---

# Hydra PR Rebase

Find OPEN PRs in `gaberoo322/hydra` whose head branch has fallen behind master and update them via GitHub's `update-branch` endpoint. PRs in genuine merge conflict (`DIRTY`) are surfaced to the operator with a labeled comment listing the PR's files; the skill never resolves a conflict.

Safe to invoke repeatedly. Each PR gets one action per pass (`rebase`, `surface` or `skip`) and the skill exits; there is no polling loop.

This is the manual / batch path. The autopilot's PR gate classifies the same states every turn from the Turn Snapshot, and the two share their idempotency key (labels on the PR), so they interleave safely. Run this skill for a full sweep outside the loop, or when the loop is paused and PRs pile up.

## When NOT to run this

- When master is itself broken: rebasing onto a broken master makes every PR red. Run `/hydra-doctor` first.
- On a PR labelled `no-rebase` (the classifier skips it).
- Inside a `dev_orch` / `dev_target` subagent. This skill belongs to the autopilot parent context.

## Decision table

`classifyPR` in `scripts/ci/pr-rebase.ts` takes one `gh pr list` row:

| `mergeStateStatus` | Labels                    | Action    | Effect                                                         |
| ------------------ | ------------------------- | --------- | -------------------------------------------------------------- |
| `BEHIND`           | no `no-rebase`            | `rebase`  | `update-branch`, then a "rebased onto master" comment.         |
| `DIRTY`            | no `ready-for-human`      | `surface` | Comment with the PR's files; add `ready-for-human`.            |
| `DIRTY`            | has `ready-for-human`     | `skip`    | Operator already notified.                                     |
| `BEHIND`           | has `no-rebase`           | `skip`    | Operator opted out.                                            |
| anything else      | any                       | `skip`    | Green, blocked on CI, or unclassified by GitHub.         |

## Process

`scripts/ci/pr-rebase-runner.ts` is the one runner over the classifier; the logic is tested in `test/hydra-pr-rebase.test.mts`. This playbook drives it and applies the plan with `gh`.

### 1. Plan

```bash
gh pr list --repo gaberoo322/hydra --state open --limit 100 \
  --json number,mergeStateStatus,headRefName,labels,headRefOid \
  | npx tsx scripts/ci/pr-rebase-runner.ts > pr-rebase-plan.json
```

The output is `{ report, plan: { rebase, surface, skipped, malformed } }`. Exit 2 means the input was not the `gh` JSON array: stop and say so.

### 2. Apply `plan.rebase`

For each entry, pinned to the SHA the plan observed:

```bash
gh api -X PUT "/repos/gaberoo322/hydra/pulls/${PR_NUMBER}/update-branch" -f expected_head_sha="${HEAD_SHA}"
```

- `422`: the head moved since the plan; leave the PR, the next sweep reclassifies.
- `403`: token permission problem; log and skip.

After a success, read the last comment that starts `> *Automated by `/hydra-pr-rebase`*`. If it already says "Rebased onto master" (`shouldPostRebaseComment`), post nothing. Otherwise comment under that marker line: "Rebased onto master via `update-branch`. CI will re-run on the new head."

### 3. Apply `plan.surface`

Comment under the same marker line: the PR has merge conflicts `update-branch` cannot resolve, then up to 20 paths from `gh pr view N --json files`, and that it is labelled `ready-for-human`. Then:

```bash
gh pr edit "${PR_NUMBER}" --repo gaberoo322/hydra --add-label ready-for-human
```

### 4. Report

Print `report` from the plan file and exit. Do not wait for CI after the rebases.

## Rules

- Never run `git rebase` or `git push --force` locally; use `update-branch`.
- Never resolve conflicts and never remove `ready-for-human`; only the operator does.
- Never re-comment: the label (surface) and the last-comment check (rebase) are the idempotency keys.
- One pass, then exit. A `BEHIND` PR that turns `DIRTY` after an update is surfaced by the next sweep.
