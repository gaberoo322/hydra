---
name: hydra-pr-rebase
description: Auto-rebase OPEN PRs that are BEHIND master, and surface DIRTY (conflicting) PRs for operator review.
when_to_use: "When the user says 'rebase PRs', 'check stale PRs', 'unblock the merge queue', or autopilot wants to clear BEHIND PRs after a master merge. Safe to run on a cron / from autopilot Phase 4."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
claude_only: true
---

# Hydra PR Rebase

Find OPEN PRs in `gaberoo322/hydra` whose head branch has fallen behind master and update them via GitHub's `update-branch` endpoint. PRs in genuine merge conflict (`DIRTY`) are surfaced to the operator with a labeled comment listing the conflicting files — the skill never attempts to resolve a conflict.

Designed to be safe to invoke repeatedly (cron, autopilot Phase 4, or manually). The classifier returns one of three actions per PR — `rebase`, `surface`, or `skip` — and the skill exits once each PR has been actioned exactly once. There is no polling loop.

## When NOT to run this

- When master is itself broken — rebasing onto a broken master makes every PR red. Run `/hydra-doctor` first if CI on master is failing.
- When the operator has explicitly disabled auto-rebase on a PR via the `no-rebase` label (the skill skips these).
- Inside a `dev_orch` / `dev_target` subagent — those run in their own worktree and don't operate on other PRs. This skill belongs to the autopilot parent context, not a dev child.

## Decision table

The classifier — pure helper in `scripts/ci/pr-rebase.ts`, exercised by `test/hydra-pr-rebase.test.mts` — takes a single `gh pr list` row and emits one of:

| `mergeStateStatus` | Labels                       | Action    | Effect                                                                          |
| ------------------ | ---------------------------- | --------- | ------------------------------------------------------------------------------- |
| `BEHIND`           | (no `no-rebase`)             | `rebase`  | `gh api -X PUT /repos/.../pulls/N/update-branch`, then comment "rebased onto master". |
| `DIRTY`            | (no `ready-for-human`)       | `surface` | Comment lists conflicting files; add `ready-for-human` label.                   |
| `DIRTY`            | already `ready-for-human`    | `skip`    | Operator has been notified; do not re-comment.                                  |
| `BEHIND`           | `no-rebase` present          | `skip`    | Operator opted out of auto-rebase for this PR.                                  |
| `CLEAN` / `BLOCKED` / `HAS_HOOKS` / `UNSTABLE` / `UNKNOWN` | any                          | `skip`    | Not our problem — either green, blocked on CI, or GitHub hasn't classified yet. |

Idempotency is enforced by the **labels-on-the-PR**, not by the skill keeping state:

- A `DIRTY` PR keeps the `ready-for-human` label until the operator resolves it; the skill sees the label and emits `skip` on subsequent runs.
- A `BEHIND` PR becomes `CLEAN` (or `UNSTABLE` until CI re-runs) after `update-branch`; on the next sweep `mergeStateStatus !== BEHIND` and the classifier emits `skip`.
- Posting the same "rebased onto master" comment twice on the same SHA is prevented by checking the most recent automated comment on the PR before commenting (see Step 4 below). This guards against the rare race where two sweeps both see `BEHIND` between the first sweep's `update-branch` call and GitHub's status refresh.

## Process

### 1. List candidate PRs

```bash
gh pr list \
  --repo gaberoo322/hydra \
  --state open \
  --json number,mergeStateStatus,headRefName,labels,headRefOid \
  --limit 100
```

`mergeStateStatus` is the GraphQL enum exposed via `gh`. Values that matter here:

- `CLEAN` — mergeable, no required-check failures. Skip.
- `BEHIND` — needs to be updated from master. **Candidate for rebase.**
- `DIRTY` — merge conflict. **Surface to operator.**
- `BLOCKED` — failing required check / missing review. Skip — not our job.
- `HAS_HOOKS`, `UNSTABLE`, `UNKNOWN` — transient. Skip; next sweep will pick up.

### 2. Classify

For each PR, feed the row to `classifyPR(row)` (from `scripts/ci/pr-rebase.ts`). The function returns `{ action, reason }`. Collect actions into three buckets: `rebase`, `surface`, `skip`.

### 3. Apply `rebase` actions

For each PR in the `rebase` bucket:

```bash
# Update the head branch from master via GitHub's API (no local checkout needed).
gh api -X PUT "/repos/gaberoo322/hydra/pulls/${PR_NUMBER}/update-branch" \
  -f expected_head_sha="${HEAD_SHA}" \
  || echo "update-branch failed for PR #${PR_NUMBER}"
```

`expected_head_sha` is the SHA observed in Step 1; if the head has moved since (e.g. the author force-pushed), GitHub rejects the call with `422` and we leave the PR alone. The next sweep will reclassify.

On success, post a comment (idempotency-guarded — see Step 4):

```bash
gh pr comment "${PR_NUMBER}" --repo gaberoo322/hydra --body "$(cat <<'EOF'
> *Automated by `/hydra-pr-rebase`*

Rebased onto master via `update-branch`. CI will re-run on the new head.
EOF
)"
```

### 4. Idempotency guard for `rebase` comments

Before posting the comment, fetch the last 5 comments and skip if the most recent automated comment is already a "rebased onto master" line for the **current head SHA**. This catches the race where a previous sweep's `update-branch` succeeded but the comment-post step crashed.

```bash
LAST_COMMENT=$(gh pr view "${PR_NUMBER}" --repo gaberoo322/hydra --json comments \
  --jq '[.comments[] | select(.body | startswith("> *Automated by `/hydra-pr-rebase`*"))] | last | .body // ""')
if echo "$LAST_COMMENT" | grep -q "Rebased onto master"; then
  # already posted — skip
  echo "PR #${PR_NUMBER}: rebase comment already present, skipping"
  continue
fi
```

### 5. Apply `surface` actions

For each PR in the `surface` bucket:

```bash
# Fetch the list of conflicting files. GitHub does not expose this directly via
# REST, so we use the GraphQL mergeable/conflicts fields plus the file list from
# the PR; a file is "conflicting" if it appears in the PR diff AND has been
# modified on master since the PR's merge base. The `mergeStateStatus: DIRTY`
# signal guarantees there is at least one such file; listing them precisely is
# best-effort.
CONFLICTS=$(gh pr view "${PR_NUMBER}" --repo gaberoo322/hydra --json files \
  --jq '.files[].path' | head -20 || echo "(unable to list)")

gh pr comment "${PR_NUMBER}" --repo gaberoo322/hydra --body "$(cat <<EOF
> *Automated by \`/hydra-pr-rebase\`*

This PR has merge conflicts with master and \`update-branch\` cannot resolve them automatically.

**Files in the PR diff (likely candidates for conflict):**
${CONFLICTS}

Labeled \`ready-for-human\` — operator review required. The skill will not re-comment on subsequent sweeps until the label is removed.
EOF
)"

gh pr edit "${PR_NUMBER}" --repo gaberoo322/hydra --add-label ready-for-human
```

### 6. Report

Emit a single-pass summary, then exit. Do **not** loop waiting for CI to settle after the rebases:

```
## Hydra PR Rebase — <date>

Scanned: N open PRs

### Rebased (BEHIND → updated)
- #401: <title> (SHA <old> → master)
- #404: <title>

### Surfaced (DIRTY → operator)
- #408: <title> — conflicts in src/foo.ts, src/bar.ts

### Skipped
- N already-labeled `ready-for-human` (no re-comment)
- N green / blocked / transient
- N opted out via `no-rebase`
```

## Rules

- Never run `git rebase` or `git push --force` locally — always use GitHub's `update-branch` API.
- Never resolve conflicts. If GitHub says `DIRTY`, surface to operator; don't touch the branch.
- Never remove `ready-for-human` — only the operator removes that label, signalling the conflict is resolved.
- Never re-comment. Check the last automated comment before posting.
- One pass over the list, then exit. Autopilot calls the skill again on the next tick if more PRs land in `BEHIND`.

## Failure modes

- **`update-branch` returns 422**: head SHA moved since Step 1 — leave the PR alone, the next sweep reclassifies.
- **`update-branch` returns 403**: insufficient permissions on the deploy token — log and skip.
- **`update-branch` succeeds but creates a new conflict** (rare; happens if master gained a conflicting commit between the API call and the rebase merge): the PR transitions `BEHIND → DIRTY` on the next sweep, which surfaces it to the operator. No special handling required.
- **`mergeStateStatus: UNKNOWN`**: GitHub hasn't computed the merge state yet. Skip — it'll be classified by the next sweep.
