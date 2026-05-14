---
name: hydra-epic-close
description: Auto-close epic issues in gaberoo322/hydra once every referenced sub-issue has been CLOSED.
when_to_use: "When the user says 'close completed epics', 'sweep epics', or autopilot wants to garbage-collect epics whose sub-issues have all merged. Safe to run on a cron / from autopilot Phase 4."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*)
arguments: [apply]
---

<!-- DO NOT EDIT. Generated from docs/operator-playbooks/hydra-epic-close.md. Run scripts/sync-skills.sh after editing the playbook. -->


# Hydra Epic Close

Find OPEN epic issues in `gaberoo322/hydra` whose body references sub-issues via `closes #N`, `blocked-by #N`, or markdown `- [x] #N` checklists, and close the epic when every referenced sub-issue is itself CLOSED. Designed to garbage-collect lingering epics after the last sub-issue merges — the codex-removal epic (#380) sat OPEN for hours after all four sub-issues closed because no automation was looking.

The skill is **dry-run by default**. To actually close epics, pass `--apply` (or `apply=true` as a Skill argument). Re-running on a freshly-closed epic is a no-op — the candidate scan filters to `state:open` *before* the classifier runs.

## When NOT to run this

- When the epic body is a vague feature request with no machine-parseable references. The classifier emits `skip` for those rather than guessing.
- When the operator wants the epic to stay OPEN as a tracking issue even after all sub-issues land. Add the `keep-open` label (this skill treats `keep-open` as opt-out — see Decision table).
- Inside a `dev_orch` / `dev_target` subagent — those work on a single issue and don't operate on the epic board. This skill belongs to the autopilot parent context or a manual operator invocation.

## Decision table

The classifier — pure helper in `scripts/ci/epic-close.ts`, exercised by `test/hydra-epic-close.test.mts` — takes one epic row plus the resolved state of each referenced sub-issue and emits one of:

| Epic body has refs | All refs CLOSED | Action  | Effect                                                                      |
| ------------------ | --------------- | ------- | --------------------------------------------------------------------------- |
| yes                | yes             | `close` | Post summary comment; transition epic to CLOSED with reason=completed.      |
| yes                | no              | `wait`  | Log open sub-issues; do nothing.                                            |
| no                 | n/a             | `skip`  | No parseable references — never close on no evidence.                       |

Idempotency is enforced by the **state of the parent issue**, not by the skill keeping state:

- A closed epic is filtered out of the candidate scan in Step 1 (`gh issue list --state open`); re-running on it never reaches the classifier.
- An epic with at least one OPEN sub-issue stays in `wait` on every run until the last sub-issue closes.
- A no-refs epic stays in `skip` forever (or until an operator edits the body to add references).

## Process

### 1. List candidate epics

Two filters: open issues labeled `enhancement`, OR open issues whose body contains a `## Sub-issues` / `## Children` marker. Union, deduplicate by number.

```bash
# 1a) enhancement-labeled open issues
gh issue list --repo gaberoo322/hydra --state open --label enhancement \
  --json number,title,body,labels,state --limit 200 > /tmp/epic-cands-a.json

# 1b) open issues that look epic-shaped via body marker (search via gh)
gh issue list --repo gaberoo322/hydra --state open \
  --search '"## Sub-issues" in:body OR "## Children" in:body' \
  --json number,title,body,labels,state --limit 200 > /tmp/epic-cands-b.json

# 1c) union by .number, drop any labeled keep-open
jq -s '
  (.[0] + .[1])
  | unique_by(.number)
  | map(select((.labels | map(.name) | index("keep-open")) | not))
' /tmp/epic-cands-a.json /tmp/epic-cands-b.json > /tmp/epic-cands.json
```

### 2. Parse references and resolve sub-issue states

For each candidate, call `parseEpicReferences(body)` (from `scripts/ci/epic-close.ts`) to get the list of referenced sub-issue numbers. Then resolve each to its current state via `gh issue view N --json number,state,title`.

Cache sub-issue states across the run — many epics share children. A tiny in-memory `Map<number, "OPEN"|"CLOSED">` is enough.

### 3. Classify

For each (epic, subStates) pair, call `classifyEpic(epic, subStates)`. The function returns `{ action, references, openReferences, reason }`. Collect actions into three buckets: `close`, `wait`, `skip`.

### 4. Apply `close` actions — **only when `--apply` is set**

For each epic in the `close` bucket:

```bash
# 4a) Render the summary comment via renderClosingComment(epic, references, subTitles, mergedPRs).
#     Best-effort: subTitles populated from the sub-state fetch in Step 2; mergedPRs
#     pulled via `gh issue view N --json closedByPullRequestsReferences` when available.
gh issue comment "${EPIC_NUMBER}" --repo gaberoo322/hydra --body "${RENDERED_COMMENT}"

# 4b) Close with reason=completed (this is what an operator would do manually).
gh issue close "${EPIC_NUMBER}" --repo gaberoo322/hydra --reason completed
```

In dry-run (default), Step 4 is skipped entirely; the report just lists what *would* close.

### 5. Report

Emit a single-pass summary, then exit:

```
## Hydra Epic Close — <date> (dry-run|apply)

Scanned: N candidate epics

### Would close (all sub-issues resolved) — dry-run, no action taken
- #380 codex-removal — 4 sub-issues

### Waiting (some sub-issues still OPEN)
- #391 mutation-testing roll-out — open: #393, #395

### Skipped (no parseable sub-issue references)
- #410 vague feature ask
```

`renderSummary(buckets, when, mode)` in `scripts/ci/epic-close.ts` produces this exact format — see `test/hydra-epic-close.test.mts` for fixtures.

## Tier classification — live API

This skill ships entirely as new files under `.claude/skills/`, `docs/operator-playbooks/`, `scripts/ci/`, and `test/`. None of those are in the untouchable list; the live `/api/tier` classifier rates the change as **Tier 3** (`operator-review change`). A future PR that wires `hydra-epic-close` into autopilot Phase 4 will need its own tier check — touching `~/.claude/skills/hydra-autopilot/SKILL.md` is Tier 1, but adding a Bash invocation block to the autopilot dispatch loop in this repo would land at Tier 3 again.

## Rules

- Never close an epic with zero parseable references. The safety net in `classifyEpic` enforces this even if the caller passes a mismatched sub-state map.
- Never close an epic with at least one OPEN sub-issue. The classifier surfaces `wait` and the apply branch never reaches it.
- Never remove the `keep-open` label — that is the operator's opt-out signal.
- One pass over the candidate list, then exit. The dispatch loop can re-run this skill on the next tick if more epics' sub-issues close.
- Dry-run is the default. The `--apply` flag (or `apply=true` argument) is the only path that actually closes anything.

## Failure modes

- **`gh issue view` returns 404** (deleted sub-issue): treat as OPEN so the epic stays in `wait`. Better to over-wait than to close an epic referencing a sub-issue we can't verify.
- **`gh issue close` returns 422**: epic was already closed between Step 1 and Step 4. Drop into the skip bucket and continue.
- **GitHub search index lag**: an epic that was just edited to add `## Sub-issues` may not show up in Step 1b for ~30s. The next sweep picks it up.
