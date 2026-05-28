---
name: hydra-review
description: Interactive operator review of issues needing human attention — drains the overnight `Operator decision queue YYYY-MM-DD` first, then walks `ready-for-human` and stale-blocked issues one at a time with recommended resolutions.
when_to_use: "When the user says 'review issues', 'what needs my attention', 'check blocked issues', or wants to clear the ready-for-human queue. Also the morning hand-off for an overnight `/hydra-autopilot --unattended=true` run."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
claude_only: true
---

# Operator Review

Interactive session to resolve issues needing human judgment. Drains three buckets in order:

1. **Overnight operator-decision queue** — today's `Operator decision queue YYYY-MM-DD` issue, written by `/hydra-autopilot` running in unattended mode (issue #413). One row per Tier-0 / non-mechanical PR that would have called `AskUserQuestion` if the operator had been awake.
2. **`ready-for-human`** — issues requiring operator decisions
3. **Stale-blocked** — `blocked` issues where no linked open issue justifies the block

The queue issue is drained first because each row is already paired with a recommendation from the autopilot — the operator answers fastest there.

## Procedure

### 0. Drain today's operator-decision queue (if present)

```bash
DATE_STAMP=$(date -u +%Y-%m-%d)
QUEUE_TITLE="Operator decision queue ${DATE_STAMP}"
QUEUE_NUMBER=$(gh issue list \
  --repo gaberoo322/hydra \
  --state open \
  --search "in:title \"${QUEUE_TITLE}\"" \
  --json number,title \
  --jq "[.[] | select(.title == \"${QUEUE_TITLE}\")] | first | .number // empty")
```

If `QUEUE_NUMBER` is non-empty:

1. Read the issue body. Parse the markdown table — one decision per row.
2. For each row, present the PR/issue, the autopilot's reason and recommendation, and offer:
   - **Apply recommendation** — execute the autopilot's suggestion (apply `operator-approved` label, merge, revert, etc.)
   - **Override** — operator-supplied action
   - **Defer** — keep the row in the queue for tomorrow
   - **Drop** — discard without action (operator decides it was a false alarm)
3. After every row is decided:
   - If ALL rows were applied/overridden/dropped → **close the queue issue** with a summary comment: `> *Auto-closed by /hydra-review: all N overnight decisions resolved.*`
   - If ANY rows were deferred → **rewrite the issue body** with only the deferred rows remaining (keep the table header) and leave the issue OPEN for tomorrow's `/hydra-review`.

Don't yield to step 1/2 until the queue is drained (or explicitly skipped by the operator).

### 1. Gather

```bash
gh issue list --repo gaberoo322/hydra --label "ready-for-human" --state open --json number,title,labels,createdAt,updatedAt
gh issue list --repo gaberoo322/hydra --label "blocked" --state open --json number,title,labels,body,createdAt,updatedAt
```

For each blocked issue, check body/comments for "blocked by #N", "depends on #N", or links. Referenced issue closed or no blocker referenced → stale-blocked.

### 2. Present

```
## Issues needing attention (N total)

### Overnight decisions (Q in today's queue, from autopilot)
| # | PR | tier | recommendation |
|---|----|------|----------------|

### Ready-for-human (M)
| # | Title | Age | Why here |
|---|-------|-----|----------|

### Stale-blocked (K)
| # | Title | Age | Blocker status |
|---|-------|-----|----------------|
```

Then: "I'll walk through these one at a time, starting with the overnight queue. Ready?"

### 3. Review loop (one issue at a time)

1. Read full issue (body, comments, labels, linked PRs)
2. Identify entry path (queue row / triage / tracking parent / dev failure / blocked)
3. Present concise summary
4. Offer 2–4 resolution options (see below)
5. Include your recommendation with brief reasoning. For queue rows, the autopilot's recommendation is already the default.
6. Wait for operator's choice
7. Execute via `gh` CLI
8. Move on

Explore the codebase before asking obvious questions.

### 4. Resolution options by entry path

#### Overnight queue row (autopilot deferred)
- **Apply** — execute the recommendation (most common; ~85% of the autopilot's suggestions are right)
- **Override** — operator chooses a different action
- **Defer** — keep the row for tomorrow's review (rare; only when more context is needed)
- **Drop** — discard without action

#### Triage origin (judgment/design needed)
- **Make it agent-ready** — write agent brief, relabel `ready-for-agent`
- **Break it down** — create child issues, convert to tracking parent or close
- **Needs more info** — post questions, relabel `needs-info`
- **Won't do** — close, label `wontfix`

#### Tracking parent
- **Close (children done)** — if all children closed AND no open PR references the epic (see Rules; check before closing)
- **Unblock children** — re-triage stuck ones
- **Restructure** — merge/split/reorder children
- **Keep as-is** — active oversight work

#### Dev failure (agent tried, failed)
- **Retry with narrower scope** — simplify criteria, relabel `ready-for-agent`
- **Provide implementation hints** — add comment, relabel `ready-for-agent`
- **Take over manually** — operator implements
- **Abandon** — close `wontfix`

#### Stale-blocked
- **Unblock** — remove `blocked`, apply next state
- **Still blocked (update reference)** — link the actual open blocker
- **No longer relevant** — close `wontfix`

### 5. Wrap-up

```
## Session summary

| # | Title | Was | Resolution | Now |
|---|-------|-----|------------|-----|

Resolved: X | Deferred: Y | Remaining: Z
Overnight queue: applied=A, overridden=O, deferred=D, dropped=R
```

## Rules

- **Drain the overnight queue first.** It's the most time-sensitive bucket; the operator already paid for the autopilot's reasoning. Don't reorder.
- One issue at a time. No batching.
- Every comment posted to GitHub starts with: `> *This was generated by AI during operator review.*`
- Agent briefs (when relabeling to `ready-for-agent`) include: category, summary, current/desired behavior, acceptance criteria, out-of-scope, key interfaces.
- Explore the codebase before asking obvious questions.
- "Skip" / "later" → move on without action (the queue issue stays OPEN for tomorrow if any rows were skipped).
- Track before/after states as you go — don't re-read labels at the end.
- If the queue issue has no rows in it (operator manually emptied it overnight), close it and continue to step 1/2.
- **Before closing any issue, check for open PRs that reference it.** Tracking parents in particular can have in-flight work that supersedes a stale "no plan / no signal" close-comment. Run:
  ```bash
  gh pr list --repo gaberoo322/hydra --state open --search "#<num>" --json number,title,body \
    --jq "[.[] | select(.body | test(\"#<num>\\\\b\"))] | .[] | \"#\(.number) \(.title)\""
  ```
  If any PR references the issue (in body or title), surface it before recommending close. Reason: 2026-05-28 incident — `/hydra-review` closed epic #437 claiming "Phase C has no plan / no signal" while PR #677 (already open, CLEAN, 850 lines) was actively shipping that exact plan. Reopen + correction comment cost more than the 10-second pre-close grep would have.
