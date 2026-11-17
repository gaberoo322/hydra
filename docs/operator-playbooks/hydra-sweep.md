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
2. **NEVER modify files in `~/hydra` directly**; code changes go through worktree agents that open PRs. Check repo state read-only (`git status` / `git log`).
3. **The sweep never merges a PR itself.** A PR lands only through `/hydra-qa`'s PASS path (invoked from the `needs-qa` lane) or the autopilot's guarded `auto-merge` action. If a sweep ever does land or arm a PR, it first runs the QA merge guard from `~/hydra` — `node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr <N>` (exit 0 allowed, 1 denied, 2 bad args) — and on any non-zero exit skips the PR and reports the guard's `reason`. The sweep **never** posts a `QA-Override:`; overriding a denial is an operator choice made in `/hydra-review`.

## Context management

On `/loop`, run `/compact` at the START of each sweep. Sweeps are stateless: state lives in GitHub labels and comments, so re-scan everything each time.

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

Exit `0` = written (report any `wouldRefuse:<code>` in the run summary, never retry); `1` = refused or failed (leave the label as is, report the code, NEVER fall back to `gh issue edit` / `gh api .../labels`); `2` = playbook bug. `--reason` is a closed enum from `src/lifecycle/reasons.ts` (`ready-for-agent` <- `scoped` | `unblocked`; `blocked` <- `blocked-by-issue`; `needs-triage` <- `rerouted`; `parked` <- `off-list-escalation`); `-> needs-triage` from a zero-state issue is gate-free and takes no reason; `closed` takes exactly one of two shapes: `--evidence pr=<M>` (M MERGED and its body closes #N, `Closes|Fixes|Resolves`) or `--close-reason "not planned" --evidence superseded-by=#<M>` (M covers every acceptance criterion of #N; a merged PR that closes a DIFFERENT issue is this shape, never `pr=`). `--reason` is not close evidence. A close refusal (`evidence-required:pr`, `evidence-required:superseded-by`, `pr-does-not-close-issue`, `pr-not-merged`, `illegal-transition`) is final: report the code and stop; never retry with other evidence, edit a merged PR body, or fall back to `gh issue close`. Flag labels (`needs-design-concept`, `enhancement`, `bug`, `sentry`) stay plain `gh` writes. The sweep never writes `ready-for-human` and never exits a human-hold state (`needs-info`, `ready-for-human`, `hitl-grill`, `parked`) - those are report-only here; the operator exits them via `/hydra-review`.

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

Tracking parents are NOT directly implementable.

##### Is a tracking parent STUCK? (gate before parking)

A tracking parent belongs in `parked` only when it is **stuck**: no autonomous path forward, so it needs an operator decision. Parking a progressing epic churns against `/hydra-review` and dilutes its Parked bucket.

An epic is **PROGRESSING** if **any** of these hold across its children:

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

- **PROGRESSING** (any hold) → never park it. From the `ready-for-agent` lane, `advance <N> needs-triage --reason rerouted --rationale "<why progressing>"` (where PROGRESSING parents sit); from `needs-triage`, do not touch its labels. Optional non-routing note:
  ```
  > *<lane header>*

  Tracking parent — children are the implementation units. Progressing (active child / open PR), so leaving as-is, not routing to operator.
  ```
- **STUCK** (none hold) → `advance <N> parked --reason off-list-escalation --rationale "<WHY>"` (a STUCK tracking parent is not an ADR-0005 reason, so it parks, not `ready-for-human`), and comment naming WHY — the comment is what the operator reads in `/hydra-review`'s Parked bucket:
  ```
  > *<lane header>*

  Tracking parent with no autonomous path forward — STUCK: <reason, e.g. "all children closed but epic still open" / "no progressing child, no open PR, no clearing blocker">. Parked for the operator.
  ```

`<lane header>` is `Automated sweep` from the `ready-for-agent` lane and `This was generated by AI during triage.` from the `needs-triage` lane.

#### Score `ready-for-agent` candidates by downstream impact

For each `ready-for-agent` issue N, count how many `blocked` issues reference `#N` in "Blocked by", plus their transitive blockers. Pick highest unblock count first (tie → oldest), NOT oldest-first.

#### Open-PR pre-promotion gate (mandatory at every edge that writes `ready-for-agent`)

Before applying `ready-for-agent` to ANY issue `#N`, check whether an **OPEN** PR already references it; if so do NOT promote (the autopilot would dispatch a duplicate `dev_orch` build). Run the query once per sweep:

```bash
OPEN_PRS=$(gh pr list --repo gaberoo322/hydra --state open \
  --json number,body,title,mergeable)

# For a candidate issue #N about to be promoted to ready-for-agent:
#   referencing OPEN PR #M found?  -> DIVERT: no ready-for-agent write; report
#     `has-open-pr: PR #M` (the PR arms own the PR; the sweep writes neither
#     needs-qa nor ready-for-human for it)
#   no referencing OPEN PR  -> PROMOTE
```

Gate strictly on `--state open`: a **closed-unmerged** PR means the attempt was abandoned (promote); a **merged** PR means the work is done, but it is closable only when its body closes #N (step 2a of the `in-progress` lane). The report MUST name every suppression and its PR number.

### 2. Group and process

#### `needs-qa` — verify completed work
Invoke `/hydra-qa $number`.
Process all QA before new dev.

#### `blocked` — check resolution
1. Read body for "Blocked by #N".
2. `gh issue view $blocker --json state` and `gh pr list --search "closes #$blocker" --state merged`.
3. All blockers closed → `advance $number needs-triage --reason rerouted --rationale "<blockers closed>"`; the `needs-triage` lane below promotes it in the same pass (`blocked` → `ready-for-agent` directly is a reconcile-fired row, so the sweep takes two hops).
4. Still blocked → skip; report which blockers remain.

#### `ready-for-agent` — develop

Skip tracking parents: apply the stuck-ness gate above instead.

Pick by that score; invoke `/hydra-dev $number`, one at a time.

Once dev leaves the issue `needs-qa`, run QA in the same sweep.

#### `needs-research`
Invoke `/hydra-issue-research $number`. Multiple in parallel OK (read-only).

#### `in-progress` — check for stale work
1. PR exists? `gh pr list --search "closes #$number"`
2a. PR merged, its body closes #$number (`Closes|Fixes|Resolves`), issue still open: `advance $number closed --evidence pr=<PR> --rationale "PR merged, issue still open" --actor hydra-sweep`.
2b. Only merged PR carries `Refs #$number` with no closing reference (or the seam answers `pr-does-not-close-issue` / `pr-not-merged`): write NO state. Post one issue comment whose first line is exactly `merged-no-closing-ref: PR #<M>` and repeat that line under **Needs operator attention**; the operator closes via `POST /autopilot/board/close`.
3. PR open: skip.
4. No PR + updated >12h ago: **report only** (stale in-progress). The re-queue and its cap arm belong to the deterministic writer (`recover-stale.sh`); the sweep writes nothing.

#### `needs-info` — check for new activity
Human-hold: a reporter/operator reply is **report-only** under "Needs operator attention" - the seam refuses `human-hold-exit` for every caller, and the operator moves it via `/hydra-review`.

#### (no label) — apply initial state
`npx tsx scripts/lifecycle.ts advance $number needs-triage --actor hydra-sweep` (gate-free from a zero-state issue). Skip epics (`## Sub-issues` or keep-open) and `wayfinder:*` issues, exactly as reconcile does.

#### `needs-design-concept` (without `ready-for-agent`) — restore reachability

`needs-design-concept` is a flag valid only ALONGSIDE `ready-for-agent`: the grill selector's walk (`src/autopilot/turn-snapshot/`) sources candidates only from `ready-for-agent`. Without it nothing consumes the flag, so the orphan backstop counts the issue (`untriaged_orphans > 0`) and dispatches this sweep.

- Also carrying `ready-for-agent` → already in the grill walk; change nothing.
- No state label, or `needs-triage` → a zero-state issue ALWAYS first takes `advance $number needs-triage --actor hydra-sweep` (gate-free, the only move the seam allows from zero state), even on `has-open-pr`: `needs-triage` is in `UNTRIAGED_ORPHAN_EXCLUDED_LABELS` (`src/autopilot/turn-snapshot/orch-board.ts`) but `needs-design-concept` is not (#4096), so an issue left in zero state is recounted every Turn and re-fires `sweep_orch`. Then run the **Open-PR pre-promotion gate** (above). On PROMOTE, `advance $number ready-for-agent --reason scoped --rationale "<why promotable>" --actor hydra-sweep` (the `## Files in scope` precondition of the `needs-triage` lane applies). KEEP `needs-design-concept` — the grill it records is still owed, and the paired labels are what `design_concept_orch` consumes. On `has-open-pr`, report it and write no `ready-for-agent`; the issue stays at `needs-triage`.
- Any other state label → that state's lane owns the issue; write nothing here.

Once paired, the issue leaves the orphan count.

#### `needs-triage` — auto-triage if well-structured

Skip tracking parents: apply the stuck-ness gate above before routing.

Well-structured = "What to build" or clear problem + acceptance criteria + parent ref or standalone scope + a `## Files in scope` section that `npx tsx scripts/ci/scope-check.ts --validate-issue-body` accepts (the parser `issue-label-validation.yml` runs, #4571).

Auto-triage:
1. Apply category label (`bug`/`enhancement`) if missing.
2. Scope + blockers check. If the sweep can name the files, author the `## Files in scope` section on the issue body BEFORE any `ready-for-agent` write; if it cannot, `advance $number needs-research --reason <judgment reason>` and never write `ready-for-agent`. A seam refusal `scope-section-missing` is reported, never worked around with `gh issue edit --add-label`.
   Blockers:
   - Open blockers → `advance $number blocked --reason blocked-by-issue --rationale "<open blockers>"`.
   - All closed (or none) → run the **Open-PR pre-promotion gate** (above); on PROMOTE `advance $number ready-for-agent --reason scoped --rationale "<why promotable>"` (or `--reason unblocked --rationale "<blockers closed>"` for an issue the `blocked` lane rerouted), otherwise report `has-open-pr` and leave it at `needs-triage`.
   - A verdict of "needs a design concept" applies BOTH `needs-design-concept` AND `ready-for-agent`, never the flag alone (see the `needs-design-concept` lane above).
3. Comment:
   ```
   > *This was generated by AI during triage.*

   Auto-triaged: structured description and acceptance criteria. Routed to `<state>`.
   ```

Unstructured: leave in `needs-triage` for the operator (`/hydra-review`). Do NOT auto-triage.

#### `ready-for-human` — report only

### 3. Report

Print summary table using captured before/after values:

```
| # | Title | Before | Action | After | Outcome |
|---|-------|--------|--------|-------|---------|
| 18 | Prior-failures bug | ready-for-agent | /hydra-dev + /hydra-qa | closed | PR #42 merged |
```

Also report:
- **Auto-triaged**, **Tracking parents identified**, **Critical path** (which RFA was picked and why), **Needs operator attention** (including each `merged-no-closing-ref: PR #<M>` line), **Still blocked**, **Labels cleaned**, **Errors**.

@include _fragments/slot-lifecycle-hook.md
