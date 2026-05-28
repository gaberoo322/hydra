---
name: hydra-sweep
description: Scan the Hydra issue board and autonomously advance every issue that can be progressed — triage routing, research, development, QA, blocker checks. Can be used with /loop for continuous processing.
when_to_use: "When the user says 'sweep the board', 'process issues', 'what needs attention', or wants to advance all issues."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
---

# Hydra Sweep

Fully autonomous board processor. Scans all open issues, groups by label, and takes the appropriate action for each state.

## Critical safety rules

1. **NEVER run `git stash`, `git checkout`, `git reset`, or `git clean` on the main `~/hydra` working tree.** Operator may have uncommitted work. All development happens in isolated worktrees.
2. **NEVER modify files in `~/hydra` directly** — only read. All code changes go through worktree agents that create PRs.
3. To check repo state, use `git status` / `git log` — read-only commands only.

## Context management

When running on `/loop`, context accumulates. At the START of each sweep:

1. Run `/compact` (Claude) or restart context (Codex) to shed previous iteration's tool results.
2. Then proceed.

Sweeps are stateless by design. State lives in GitHub issue labels and comments. Re-scan everything each time.

## Report tracking

Build a report log in memory. For each issue processed:
- `number`, `title`
- `before`: label state at first inspection (capture BEFORE any action)
- `action`: what was done (e.g., `/hydra-dev`, `/hydra-qa`, `blocker check`, `auto-triage`, `cleanup`)
- `after`: label state after action
- `outcome`: short description

Do NOT re-read issue labels at the end — labels change during processing.

## Process

### 0. Housekeeping

Clean stale workflow labels from closed issues:

```bash
for label in needs-qa ready-for-agent in-progress needs-triage blocked needs-research target-backlog; do
  gh issue list --repo gaberoo322/hydra --state closed --label "$label" --json number --jq '.[].number'
done
```

For each result: remove the stale workflow label(s). Don't remove category labels (`bug`, `enhancement`, `sentry`). Log each as action: `cleanup`.

### 1. Scan

```bash
gh issue list --repo gaberoo322/hydra --state open --json number,title,labels,updatedAt \
  --jq '.[] | {number, title, labels: [.labels[].name], updatedAt}'
```

#### Identify tracking parents

```bash
gh issue list --state open --json number,body \
  --jq '[.[] | select(.body != null) | select(.body | test("## Parent")) | .body | capture("Parent[\\s\\S]*?#(?<num>[0-9]+)") | .num] | unique | .[]'
```

Tracking parents need special handling — they are NOT directly implementable.

#### Score `ready-for-agent` candidates by downstream impact

For each `ready-for-agent` issue N, count how many `blocked` issues reference `#N` in "Blocked by", plus their transitive blockers. Pick highest unblock count first, NOT oldest.

### 2. Group and process

#### `target-backlog` — queue to orchestrator
For each issue:
1. Read body, extract concise work description.
2. Push to work queue: `hydra queue add "<short ref>" -d "From GitHub issue #N. <key details>"`
3. Comment on issue:
   ```
   > *Automated sweep*

   Queued to Hydra work queue. The orchestrator will pick this up as an anchor.
   ```
4. Close: `gh issue close $number`
5. Log action: `target-queue`.

Process all target-backlog before dev work.

#### `needs-qa` — verify completed work
Invoke `/hydra-qa $number` (Claude) or `codex exec --skill hydra-qa <<< $number` (Codex).
Process all QA before new dev.

#### `blocked` — check resolution
1. Read body for "Blocked by #N".
2. `gh issue view $blocker --json state` and `gh pr list --search "closes #$blocker" --state merged`.
3. All blockers closed → remove `blocked`, add `ready-for-agent`.
4. Still blocked → skip; report which blockers remain.

#### `ready-for-agent` — develop

Skip tracking parents:
```
> *Automated sweep*

Skipping: tracking parent with child issues. Children are the implementation units.
```
Label `ready-for-human`, remove `ready-for-agent`.

Pick by downstream impact (highest unblock count first; tie → oldest). Invoke `/hydra-dev $number` (or `codex exec --skill hydra-dev`). One at a time — worktree isolation.

After dev completes and issue is `needs-qa`, immediately run QA in the same sweep — do NOT defer.

#### `needs-research`
Invoke `/hydra-issue-research $number` (or `codex exec --skill hydra-issue-research`). Multiple in parallel OK (read-only).

#### `in-progress` — check for stale work
1. PR exists? `gh pr list --search "closes #$number"`
2. No PR + updated >12h ago: comment, relabel `ready-for-agent`.
3. PR merged: relabel `needs-qa`.
4. PR open: skip.

#### `needs-info` — check for new activity
Reporter/operator replied since last triage note → relabel `needs-triage`.

#### (no label) — apply initial label
`gh issue edit $number --add-label "needs-triage"`

#### `needs-triage` — auto-triage if well-structured

Skip tracking parents → `ready-for-human` + comment:
```
> *This was generated by AI during triage.*

Tracking parent with child implementation issues. Routing to operator.
```

Well-structured = "What to build" or clear problem + acceptance criteria + parent ref or standalone scope.

Auto-triage:
1. Apply category label (`bug`/`enhancement`) if missing.
2. Blockers check:
   - Open blockers → `blocked`, remove `needs-triage`.
   - All closed (or none) → `ready-for-agent`, remove `needs-triage`.
3. Comment:
   ```
   > *This was generated by AI during triage.*

   Auto-triaged: structured description and acceptance criteria. Routed to `<state>`.
   ```

Unstructured: leave for operator (`/triage`). Do NOT auto-triage.

#### `ready-for-human` — report only

### 3. Report

Print summary table using captured before/after values:

```
| # | Title | Before | Action | After | Outcome |
|---|-------|--------|--------|-------|---------|
| 18 | Prior-failures bug | ready-for-agent | /hydra-dev + /hydra-qa | closed | PR #42 merged |
```

Also report:
- **Auto-triaged**, **Tracking parents identified**, **Critical path** (which RFA was picked and why), **Needs operator attention**, **Still blocked**, **Labels cleaned**, **Errors**.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
