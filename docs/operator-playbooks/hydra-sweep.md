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
4. **The sweep never merges a PR itself (issue #4738).** A PR lands only through `/hydra-qa`'s PASS path (invoked from the `needs-qa` lane) or the autopilot's guarded `auto-merge` action. If a sweep ever does land or arm a PR, it first runs the QA merge guard from `~/hydra` — `node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr <N>` (exit 0 allowed, 1 denied, 2 bad args) — and on any non-zero exit skips the PR and reports the guard's `reason`. The sweep **never** posts a `QA-Override:`; overriding a denial is an operator choice made in `/hydra-review`.

## Context management

When running on `/loop`, context accumulates. At the START of each sweep:

1. Run `/compact` to shed previous iteration's tool results.
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

## State writes — the one idiom (ADR-0047)

Every ISSUE state change in this playbook is exactly one command, run from `~/hydra`:

```bash
npx tsx scripts/lifecycle.ts advance <N> <to> --reason <enum> --rationale "<one line>" --actor hydra-sweep
```

Exit `0` = written (report any `wouldRefuse:<code>` in the run summary, never retry); `1` = refused or failed (leave the label as is, report the code, NEVER fall back to `gh issue edit` / `gh api .../labels`); `2` = playbook bug. `--reason` is a closed enum from `src/lifecycle/reasons.ts` (`ready-for-agent` <- `scoped` | `unblocked`; `blocked` <- `blocked-by-issue`; `needs-triage` <- `rerouted`; `parked` <- `off-list-escalation`); `-> needs-triage` from a zero-state issue is gate-free and takes no reason; `closed` takes `--evidence pr=<MERGED PR>`. Flag labels (`needs-design-concept`, `enhancement`, `bug`, `sentry`) stay plain `gh` writes. The sweep never writes `ready-for-human` and never exits a human-hold state (`needs-info`, `ready-for-human`, `hitl-grill`, `parked`) - those are report-only here; the operator exits them via `/hydra-review`.

## Process

### 0. Housekeeping

Stale state labels on CLOSED issues are count-only: every reader filters `--state open`, and a closed `hitl-grill` issue is the producers' dedup baseline, so the sweep does not strip them (the seam refuses `issue-closed` writes). Report the count under **Labels cleaned**:

```bash
for label in needs-qa ready-for-agent in-progress needs-triage blocked needs-research; do
  gh issue list --repo gaberoo322/hydra --state closed --label "$label" --json number --jq '.[].number'
done
```

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

##### Is a tracking parent STUCK? (gate before parking)

A tracking parent only belongs in `parked` when it is **stuck** — no autonomous path forward, so it genuinely needs an operator decision. A healthy/progressing epic must be left as a plain tracking parent (do NOT park it) — otherwise the sweep churns against `/hydra-review`, and the operator's hold buckets fill with every open epic, diluting the "needs a decision" signal (the 2026-05-30 #735/#690 incident → issue #777).

An epic is **PROGRESSING** (→ leave alone) if **any** of these hold across its children:

```bash
# Extract child issue numbers: open issues whose body's "## Parent" points at #$PARENT
CHILDREN=$(gh issue list --repo gaberoo322/hydra --state open --json number,body \
  --jq "[.[] | select(.body != null) | select(.body | test(\"Parent[\\\\s\\\\S]*?#${PARENT}\\\\b\")) | .number] | .[]")

# 1. ≥1 child is actively in a working lane
gh issue list --repo gaberoo322/hydra --state open \
  --json number,labels \
  --jq "[.[] | select(.number as \$n | [${CHILDREN// /,}] | index(\$n)) | select(.labels[].name | test(\"^(ready-for-agent|in-progress|needs-qa|needs-research)$\"))] | length"
# 2. ≥1 open PR references the epic or any child (body or title)
gh pr list --repo gaberoo322/hydra --state open --json number,body,title \
  --jq "[.[] | select((.body + \" \" + .title) | test(\"#(${PARENT}$(for c in $CHILDREN; do printf '|%s' "$c"; done))\\\\b\"))] | length"
# 3. ≥1 `blocked` child whose blocker is still open AND itself progressing (a clearing path exists)
```

If **none** hold → the epic is **STUCK** → `advance <N> parked --reason off-list-escalation --rationale "<WHY>"` (a STUCK tracking parent is not an ADR-0005 reason, so it parks, not `ready-for-human`) with a comment naming WHY (see the two branches below). If **any** hold → PROGRESSING → skip silently (or a non-routing note); do **not** touch its labels.

#### Score `ready-for-agent` candidates by downstream impact

For each `ready-for-agent` issue N, count how many `blocked` issues reference `#N` in "Blocked by", plus their transitive blockers. Pick highest unblock count first, NOT oldest.

#### Open-PR pre-promotion gate (issue #772 — MANDATORY at every edge that writes `ready-for-agent`)

Before applying `ready-for-agent` to ANY issue `#N` — whether from the `needs-triage` auto-triage lane or the `blocked`-cleared lane — check whether an **OPEN** PR already references it. If one does, do NOT promote: an open PR means a build is already in flight, and promoting would let the autopilot dispatch a duplicate `dev_orch` build (the 2026-05-30 #750→#754/#770 incident).

The routing decision is a pure predicate over the issue number and the live open-PR list — apply it at every promotion edge. Run the live query once per sweep, then apply this decision at every promotion edge:

```bash
# One query per sweep is enough — reuse this list across all promotion edges.
OPEN_PRS=$(gh pr list --repo gaberoo322/hydra --state open \
  --json number,body,title,mergeable)

# For a candidate issue #N about to be promoted to ready-for-agent:
#   referencing OPEN PR found?  -> DIVERT (do not promote), NO label write:
#     report `has-open-pr: PR #N` - the PR arms (red-resume, dirty fix-forward,
#     QA recheck) own the PR; neither needs-qa nor ready-for-human is a legal
#     agent transition from needs-triage / blocked
#   no referencing OPEN PR  -> PROMOTE normally to ready-for-agent
```

Gate strictly on `--state open`. A **closed-unmerged** PR means the prior attempt was abandoned, so the issue SHOULD become `ready-for-agent` again (exactly the #754→#770 handoff); a **merged** PR means the work is done. The sweep report MUST name every suppression and the referencing PR number (e.g. `has-open-pr: PR #754`). The decision is idempotent: re-running the sweep on the same board reaches the same outcome because state is read live from GitHub. This gate is independent of (and does not modify) the merge gate or the autopilot candidate selection — those remain separate defense layers.

### 2. Group and process

#### `needs-qa` — verify completed work
Invoke `/hydra-qa $number`.
Process all QA before new dev.

#### `blocked` — check resolution
1. Read body for "Blocked by #N".
2. `gh issue view $blocker --json state` and `gh pr list --search "closes #$blocker" --state merged`.
3. All blockers closed → `advance $number needs-triage --reason rerouted --rationale "<blockers closed>"`, and the `needs-triage` lane below promotes it in the same pass (it runs the **Open-PR pre-promotion gate**; `blocked` → `ready-for-agent` directly is a reconcile-fired row, the two-hop route is legal). If the gate reports `has-open-pr`, leave it at `needs-triage`.
4. Still blocked → skip; report which blockers remain.

#### `ready-for-agent` — develop

Skip tracking parents - run the stuck-ness gate above. A tracking parent should never sit in `ready-for-agent` (it's not directly implementable):

- **PROGRESSING** (≥1 child in `ready-for-agent`/`in-progress`/`needs-qa`/`needs-research`, OR an open PR referencing it/a child, OR a `blocked` child with a clearing path) → `advance $number needs-triage --reason rerouted --rationale "<why progressing>"` (where PROGRESSING parents already sit); do **NOT** park it. Optional non-routing note:
  ```
  > *Automated sweep*

  Tracking parent — children are the implementation units. Progressing (active child / open PR), so leaving as-is, not routing to operator.
  ```
- **STUCK** (none of the above) → `advance $number parked --reason off-list-escalation --rationale "<WHY>"`, and comment naming WHY (the comment stays - it is what the operator reads in `/hydra-review`'s Parked bucket):
  ```
  > *Automated sweep*

  Tracking parent with no autonomous path forward — STUCK: <reason, e.g. "all children closed but epic still open" / "no progressing child, no open PR, no clearing blocker">. Parked for the operator.
  ```

Pick by downstream impact (highest unblock count first; tie → oldest). Invoke `/hydra-dev $number`. One at a time — worktree isolation.

After dev completes and issue is `needs-qa`, immediately run QA in the same sweep — do NOT defer.

#### `needs-research`
Invoke `/hydra-issue-research $number`. Multiple in parallel OK (read-only).

#### `in-progress` — check for stale work
1. PR exists? `gh pr list --search "closes #$number"`
2. PR merged and the issue still open: `advance $number closed --evidence pr=<PR>` (post-merge `needs-qa` is retired: `needs-qa` needs an OPEN PR).
3. PR open: skip.
4. No PR + updated >12h ago: **report only** (stale in-progress). The re-queue and its cap arm belong to the deterministic writer (`recover-stale.sh`); the sweep writes nothing.

#### `needs-info` — check for new activity
Human-hold: a reporter/operator reply is **report-only** under "Needs operator attention" - the seam refuses `human-hold-exit` for every caller, and the operator moves it via `/hydra-review`.

#### (no label) — apply initial state
`npx tsx scripts/lifecycle.ts advance $number needs-triage --actor hydra-sweep` (gate-free from a zero-state issue). Skip epics (`## Sub-issues` or keep-open) and `wayfinder:*` issues, exactly as reconcile does.

#### `needs-design-concept` (without `ready-for-agent`) — restore reachability (issue #4096)

`needs-design-concept` is only ever valid ALONGSIDE `ready-for-agent`. The grill
selector's walk (the Turn Snapshot collectors (`src/autopilot/turn-snapshot/`)) sources candidates
exclusively from the `ready-for-agent` label; within that walk
`needs-design-concept` only forces a grill (never suppresses one). On an issue
without `ready-for-agent` the label is an unreachable lane — no AFK selector and
no HITL surface consumes it — so the orphan backstop counts the issue
(`untriaged_orphans > 0`) and dispatches this sweep as its recovery path.

- Also carrying `ready-for-agent` → already routed into the grill walk; change
  nothing.
- Without `ready-for-agent` → run the **Open-PR pre-promotion gate** (above). On
  `promote: true`, `advance $number ready-for-agent --reason scoped --rationale "<why promotable>"` and KEEP `needs-design-concept` — the
  sweep MUST NOT strip `needs-design-concept`: the grill obligation the label
  records is still owed, and the paired labels are exactly what
  `design_concept_orch` consumes. On a `has-open-pr` verdict, report it and
  write nothing.
- The recovery is additive and idempotent: once paired, the issue leaves the
  orphan count — one fire, one fix, no churn.

Write-path rule (why this lane exists): a triage verdict of "needs a design
concept" MUST apply BOTH labels — `needs-design-concept` AND `ready-for-agent` —
never the parking label alone. A `needs-design-concept`-only issue is the #4093
sink: promoted out of `needs-triage` into a lane nothing reads.

#### `needs-triage` — auto-triage if well-structured

Skip tracking parents — run the stuck-ness gate above before routing. Only a **STUCK** parent is parked; a **PROGRESSING** one stays a plain tracking parent (no churn):

- **PROGRESSING** → leave as a tracking parent; do not park it. Optional non-routing note:
  ```
  > *This was generated by AI during triage.*

  Tracking parent — progressing (active child / open PR). Leaving as-is; not routing to operator.
  ```
- **STUCK** → `advance $number parked --reason off-list-escalation --rationale "<WHY>"` + comment naming WHY:
  ```
  > *This was generated by AI during triage.*

  Tracking parent with no autonomous path forward — STUCK: <reason>. Parked for the operator.
  ```

Well-structured = "What to build" or clear problem + acceptance criteria + parent ref or standalone scope.

Auto-triage:
1. Apply category label (`bug`/`enhancement`) if missing.
2. Blockers check:
   - Open blockers → `advance $number blocked --reason blocked-by-issue --rationale "<open blockers>"`.
   - All closed (or none) → run the **Open-PR pre-promotion gate** (above); on `promote: true` `advance $number ready-for-agent --reason scoped --rationale "<why promotable>"` (or `--reason unblocked --rationale "<blockers closed>"` for a formerly blocked issue), otherwise report `has-open-pr` and leave it at `needs-triage`.
   - A verdict of "needs a design concept" routes to BOTH `needs-design-concept` AND `ready-for-agent` (see the `needs-design-concept` lane above) — never the parking label alone (#4096).
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
