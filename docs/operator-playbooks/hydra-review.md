---
name: hydra-review
description: The operator's HITL pipeline cockpit — surfaces every in-flight initiative by its stage and walks each one toward AFK-dispatchable: overnight queue, wayfinder maps (chart→approve→resolve→handoff), specs awaiting decomposition, ready-for-human, and stale-blocked.
when_to_use: "When the user says 'review issues', 'what needs my attention', 'what can I do', 'check blocked issues', or wants to advance stuck work toward autopilot. Also the morning hand-off for an overnight `/hydra-autopilot --unattended=true` run."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
claude_only: true
---

# Operator Review — the HITL pipeline cockpit

Interactive session to advance every initiative that needs the operator's hand,
from wherever it sits toward **AFK-dispatchable** — the point where `hydra-autopilot`
can work it with no operator in the loop. Not just a decision-queue drainer: it
classifies each in-flight initiative onto the pipeline ladder and names the single
action that pushes it up a rung.

## The pipeline ladder

Every foggy initiative climbs the same ladder. Each rung has exactly one operator
action; the ✓ rungs are the finish lines where autopilot takes over.

| Rung | State | Operator action here | Then worked by |
|------|-------|----------------------|----------------|
| 0 | uncharted idea | `/hydra-wayfinder` (chart) — offered at wrap-up (§6) | — |
| 1 | destination-pending map | approve the gate (§0.5) | — |
| 2 | map w/ open **HITL** frontier | resolve grilling/prototype via `/wayfinder` (§0.6) | — |
| 3 | map w/ **AFK-only** frontier | *nothing* | **autopilot** `wayfinder_orch` ✓ |
| 4 | map frontier **empty** | **handoff** → `hydra-prd` \| `/to-spec` (§0.7) | — |
| 5 | spec written, un-ticketed | `/to-tickets` slice + quiz (§0.8) | — |
| 6 | tracer-bullet children | *nothing* | **autopilot** `hydra-dev` ✓✓ |

## Buckets, in drain order

1. **Overnight operator-decision queue** (§0) — today's `Operator decision queue YYYY-MM-DD` issue, written by `/hydra-autopilot` running in unattended mode (issue #413). One row per Tier-0 / non-mechanical PR that would have called `AskUserQuestion` if the operator had been awake.
2. **Destination-pending wayfinder maps** (§0.5, rung 1) — open `wayfinder:map` issues carrying the `wayfinder:destination-pending` draft-gate label (ADR-0029 Decision 1). Each is a machine-charted map awaiting operator sign-off on its proposed Destination before its AFK frontier becomes dispatchable.
3. **Wayfinder HITL frontier tickets** (§0.6, rung 2) — open, unblocked, unclaimed `wayfinder:grilling` / `wayfinder:prototype` sub-issues on approved maps (ADR-0029 Decision 3). The `wayfinder_orch` autopilot class never dispatches these; they need operator judgment and resolve via `/wayfinder`.
4. **Handoff-ready wayfinder maps** (§0.7, rung 4) — open approved maps whose frontier is **empty** (every ticket closed): the way is clear and the map is waiting to be converted into an implementation epic (`hydra-prd`) or a spec (`/to-spec`). This is the rung that turns a cleared map into AFK-dispatchable work.
5. **Specs awaiting decomposition** (§0.8, rung 5) — open issues labelled `needs-tickets`: a published spec that has not yet been sliced into tracer-bullet build issues. Run `/to-tickets` to emit the `ready-for-agent` children autopilot's `hydra-dev` picks up.
6. **`ready-for-human`** — issues requiring operator decisions
7. **Stale-blocked** — `blocked` issues where no linked open issue justifies the block

The queue issue is drained first because each row is already paired with a recommendation from the autopilot — the operator answers fastest there. Destination-pending maps drain next: approving one unblocks its whole AFK frontier for autopilot on the following tick, so it is the highest-leverage single decision on the board. Wayfinder HITL tickets drain after that: an unresolved HITL ticket stalls its whole map's AFK frontier (the autopilot cannot advance past a blocking decision), so clearing one is high-leverage too. Handoff-ready maps and un-ticketed specs (§0.7, §0.8) drain after the wayfinder frontier: they are the far end of the pipeline — a single handoff there can emit a whole epic's worth of AFK-dispatchable children in one action.

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

Don't yield to the later steps until the queue is drained (or explicitly skipped by the operator).

### 0.5. Drain destination-pending wayfinder maps

ADR-0029: `hydra-research` / `hydra-architecture-scan` can chart a foggy initiative as a **destination-pending map** — a `wayfinder:map` issue carrying the `wayfinder:destination-pending` draft-gate label, holding only a proposed **Destination** + fog sketch (no tickets yet). The frontier collector treats such a map as an unapproved draft: its AFK tickets are **not** dispatchable while the gate label is present. This bucket is where the operator clears that gate.

```bash
gh issue list --repo gaberoo322/hydra --state open \
  --label 'wayfinder:map' --label 'wayfinder:destination-pending' \
  --json number,title,body,createdAt --jq 'sort_by(.createdAt)'
```

Walk the maps **oldest-first**, one at a time. For each, read the body's `## Destination` section (the proposed destination + its handoff type — implementation-epic / decision-ADR-only / in-place-change) and the fog sketch, then present a concise summary and offer:

- **Approve** — the Destination is right as written. Remove the gate label; the map's AFK frontier becomes dispatchable on autopilot's next tick:
  ```bash
  gh issue edit <map> --repo gaberoo322/hydra --remove-label 'wayfinder:destination-pending'
  ```
- **Amend** — the Destination needs a wording/scope change first. Edit the map body's `## Destination` section, **then** remove the gate label (a destination-pending map holds no tickets yet, so an amendment strands nothing — ADR-0029 Decision 1):
  ```bash
  gh issue edit <map> --repo gaberoo322/hydra --body-file <edited-body>
  gh issue edit <map> --repo gaberoo322/hydra --remove-label 'wayfinder:destination-pending'
  ```
- **Reject** — the map should not be charted. Close it (a false map proposal costs one rejection, not wasted work):
  ```bash
  gh issue close <map> --repo gaberoo322/hydra --comment '> *This was generated by AI during operator review.*
  > Rejected at the destination gate: <reason>.'
  ```
- **Defer** — leave the gate label in place; the map re-surfaces in tomorrow's review. The staleness sweep (issue #3355) flags a never-approved map once its age passes the staleness threshold (see the **Staleness sweep** note below), so a repeatedly-deferred map is surfaced distinctly as *stalled* rather than blending into the fresh backlog.

Do not yield to the later steps until every destination-pending map is decided or explicitly skipped.

> HITL frontier tickets (`wayfinder:grilling` / `wayfinder:prototype`) are a **separate** bucket — the next step (§0.6); they are resolved via `/wayfinder <map> <ticket>`, not here.

### 0.6. Drain wayfinder HITL frontier tickets

ADR-0029 Decision 3: a `wayfinder:map`'s frontier holds two kinds of ticket.
**AFK** tickets (`wayfinder:research` / `wayfinder:task`) are worked autonomously by
the `wayfinder_orch` autopilot class. **HITL** tickets (`wayfinder:grilling` /
`wayfinder:prototype`) need the operator's judgment — `wayfinder_orch` NEVER
dispatches them (the machine must not synthesize the human's side of a decision).
They sit inert on the frontier until the operator resolves them here. This is the
single surface where the operator sees them.

List the open, **unblocked** (all blocked-by closed), **unclaimed** (unassigned),
HITL-typed frontier tickets across every open **approved** map (a `wayfinder:map`
that does NOT carry the `wayfinder:destination-pending` gate label — a
destination-pending map holds no tickets yet, ADR-0029 Decision 1):

```bash
# 1. Approved maps: open wayfinder:map issues WITHOUT the destination-pending gate.
APPROVED_MAPS=$(gh issue list --repo gaberoo322/hydra --state open --label 'wayfinder:map' \
  --json number,labels --jq '
    [ .[] | select((.labels | map(.name) | index("wayfinder:destination-pending")) | not) | .number ]
    | sort | .[]')

# 2. Per approved map, walk its frontier for HITL-typed, unblocked, unclaimed tickets.
for m in $APPROVED_MAPS; do
  gh api graphql -F n="$m" -f query='query($n:Int!){
    repository(owner:"gaberoo322", name:"hydra"){ issue(number:$n){
      subIssues(first:100){ nodes { number title state
        labels(first:20){nodes{ name }}
        assignees(first:1){totalCount}
        blockedBy(first:20){nodes{ number state }} } } } } }' \
    --jq --arg map "$m" '.data.repository.issue.subIssues.nodes
          | map(select(.state=="OPEN" and .assignees.totalCount==0
              and ([.blockedBy.nodes[]? | select(.state=="OPEN")] | length)==0))
          | map(. + {type: ([.labels.nodes[].name
              | select(. == "wayfinder:grilling" or . == "wayfinder:prototype")] | .[0])})
          | map(select(.type != null))
          | .[] | "\($map)\t\(.number)\t\(.type)\t\(.title)"'
done
```

Walk them one at a time. For each HITL ticket, present the parent map, the ticket
title, and its type (`grilling` = a decision to stress-test; `prototype` = a
state/logic/UI shape to sanity-check), then offer:

- **Resolve now** — run the interactive resolver on it: `/wayfinder <map> <ticket>`.
  That session grills / prototypes the question, records the resolution comment,
  closes the ticket, and appends to the map's `## Decisions so far`. Autopilot's
  next tick then sees the advanced frontier and resumes AFK dispatch.
- **Defer** — leave it on the frontier; it re-surfaces in tomorrow's review. The
  staleness sweep (issue #3355) flags a never-picked-up HITL ticket once its age
  passes the staleness threshold (see the **Staleness sweep** note below), so a
  repeatedly-deferred ticket is surfaced distinctly as *stalled*.
- **Reframe** — the ticket is mis-typed or no longer a real decision. Fix its type
  label (or close it with a comment) so the frontier advances.

Never `--add-assignee`, never relabel `ready-for-agent`, never auto-answer an HITL
ticket — the off-radar rule keeps these off the ordinary board, and the HITL
contract keeps the machine out of the human's decision.

> **Staleness sweep (issue #3355, epic #3350).** Both of the wayfinder buckets
> above (§0.5 destination-pending maps and §0.6 HITL frontier tickets) are
> operator-only surfaces with *no* autopilot working path — a map/ticket the
> operator keeps deferring sits inert forever, and its whole map's AFK frontier
> stalls with it. To keep a repeatedly-deferred item from blending into the fresh
> backlog, `scripts/autopilot/collect-state.sh` runs a read-only **staleness
> sweep** that counts the items aged past a threshold
> (`HYDRA_WAYFINDER_STALENESS_SEC`, default **48h** = two review cadences) and
> emits two signals:
>
> - `wayfinder_stale_maps` — open `wayfinder:destination-pending` maps whose
>   `createdAt` is older than the threshold (never-approved drafts).
> - `wayfinder_stale_hitl` — open, unblocked, unclaimed
>   `wayfinder:grilling` / `wayfinder:prototype` frontier tickets on APPROVED maps
>   whose `createdAt` is older than the threshold (never-picked-up decisions).
>
> A map/ticket **within** the threshold is *not* flagged — it is still in the
> normal §0.5 / §0.6 review cadence. Age is measured from `createdAt` (the item
> stays inert from creation until the operator acts, so that is the true
> "how long stuck" clock — mirroring the `stale_blocked` age precedent). The sweep
> is best-effort and read-only: a `gh` / GraphQL outage degrades both counts to
> `0` (the suppressing direction), so a transient failure never spuriously flags a
> stall. When either count is > 0, mark the corresponding §0.5 / §0.6 rows below
> in the **Stale?** column (the row's `Age` shows how long) so the operator
> prioritises the genuinely stalled ones first.

### 0.7. Drain handoff-ready wayfinder maps (rung 4 → epic/spec)

A map whose frontier has gone **empty** — every ticket CLOSED — has reached its
destination: the way is clear and nothing is left to decide. It is now waiting on
the one operator action the whole map was building toward: **handoff**, which
converts the map's Decisions-so-far into AFK-dispatchable work. This is the bucket
the pre-cockpit `/hydra-review` was missing — cleared maps used to sit inert until
the operator remembered to hand them off by hand.

**Lifecycle (ADR-0029 + cockpit).** `hydra-epic-close` **no longer auto-GCs
`wayfinder:map` issues** (see `hydra-epic-close` decision table) — the handoff flow
owns a map's death, so there is no race where a map is closed before it can be
handed off. When a map's frontier empties, this step marks it
`wayfinder:handoff-pending` (the board-visible "waiting on you" signal) and drives
the handoff; the map is closed **here**, as the final handoff step, or kept as a
reference with `keep-open`.

List open **approved** maps (no `wayfinder:destination-pending` gate) with **zero
open sub-issues** — the empty-frontier condition:

```bash
APPROVED_MAPS=$(gh issue list --repo gaberoo322/hydra --state open --label 'wayfinder:map' \
  --json number,labels --jq '
    [ .[] | select((.labels | map(.name) | index("wayfinder:destination-pending")) | not) | .number ]
    | sort | .[]')

for m in $APPROVED_MAPS; do
  gh api graphql -F n="$m" -f query='query($n:Int!){
    repository(owner:"gaberoo322", name:"hydra"){ issue(number:$n){
      title createdAt
      subIssues(first:100){ nodes { state } } } } }' \
    --jq '.data.repository.issue as $i
      | ($i.subIssues.nodes | length) as $total
      | ([$i.subIssues.nodes[] | select(.state=="OPEN")] | length) as $open
      # handoff-ready = at least one ticket ever, and none still open
      | select($total > 0 and $open == 0)
      | "'$m'\t\($i.createdAt)\t\($i.title)"'
done
```

> A map with **zero** sub-issues ever is *not* handoff-ready — it is under-charted
> (charted but no tickets). Surface it under §0.5/§0.6 handling or send it back to
> `/hydra-wayfinder`; do not hand off an empty map.

Walk the handoff-ready maps oldest-first, one at a time. Read the map body's
`## Destination` section — its **handoff-type** decides the route. Mark the map
`wayfinder:handoff-pending` when you begin so the board shows it is mid-handoff:

```bash
gh issue edit <map> --repo gaberoo322/hydra --add-label 'wayfinder:handoff-pending'
```

Present the map's Destination + a two-line gist of its `## Decisions so far`, then
offer the route that matches the handoff-type:

- **Handoff → implementation epic** (Destination handoff-type = *implementation-epic*).
  The Hydra-native route is **`hydra-prd`** (NOT `/to-spec` — ADR-0029 Decision 4).
  A capstone synthesises the map's Decisions-so-far (each closed ticket is a primary
  source) into an ADR + structured PRD JSON, then `hydra-prd --apply` emits the
  parent epic + dependency-ordered tracer-bullet children stamped `Expected tier: N`
  and `ready-for-agent`. Those children are **rung 6 — AFK-dispatchable**. Then close
  the map (below).
- **Handoff → spec** (Destination handoff-type = *spec*). Run **`/to-spec`**,
  synthesising the map's Decisions-so-far into a spec issue. **Then relabel that spec
  so it lands in §0.8, not the AFK board** — `/to-spec` stamps its output
  `ready-for-agent`, which would let `hydra-dev` grab an un-sliced spec as one issue:

  ```bash
  gh issue edit <spec> --repo gaberoo322/hydra --add-label 'needs-tickets' --remove-label 'ready-for-agent'
  ```

  The spec now surfaces in §0.8 for `/to-tickets`. Then close the map (below).
- **Handoff → locked decision** (Destination handoff-type = *decision-ADR-only*).
  Record the decision as an ADR (`docs/adr/NNNN-*.md`) if it governs future work.
  Then close the map.
- **Handoff → in-place change** (Destination handoff-type = *in-place-change*). The
  map's tickets are the plan; file the build as a `ready-for-agent` issue (or an
  epic via `hydra-prd` if multi-slice) and close the map.
- **Not ready** — the frontier looks empty but a decision is actually still open
  (a fog patch never got ticketed). Remove `wayfinder:handoff-pending`, send it back
  to `/hydra-wayfinder` to chart the remaining fog, and move on.

**Close the map** as the final handoff step (unless it should persist as a
reference — then add `keep-open` instead of closing):

```bash
gh issue edit <map> --repo gaberoo322/hydra --remove-label 'wayfinder:handoff-pending'
gh issue close <map> --repo gaberoo322/hydra --comment '> *This was generated by AI during operator review.*
> Handed off: <epic #N | spec #N | ADR-NNNN | build #N>. Destination reached; closing the map.'
```

Do not yield to the later steps until every handoff-ready map is routed or explicitly skipped.

### 0.8. Drain specs awaiting decomposition (rung 5 → tracer-bullet tickets)

A spec produced by the §0.7 spec route (or written directly) is a **decompose-me**
artifact, not a tracer bullet — `hydra-dev` must not build it whole. It carries
`needs-tickets` until it is sliced. This step runs the slice.

```bash
gh issue list --repo gaberoo322/hydra --state open --label 'needs-tickets' \
  --json number,title,createdAt --jq 'sort_by(.createdAt) | .[] | "\(.number)\t\(.createdAt)\t\(.title)"'
```

Walk them oldest-first, one at a time. For each spec:

- **Slice now** — run **`/to-tickets <spec#>`**: it reads the spec, drafts
  tracer-bullet vertical slices with native blocking edges, quizzes the operator on
  granularity, and (on approval) publishes the children in dependency order,
  labelling each `ready-for-agent`. Those children are **rung 6 — AFK-dispatchable**.
  When the children exist, drop `needs-tickets` from the spec (leave the spec open as
  the parent, or close it if the children fully carry it):
  ```bash
  gh issue edit <spec> --repo gaberoo322/hydra --remove-label 'needs-tickets'
  ```
- **Defer** — leave `needs-tickets`; it re-surfaces tomorrow.
- **Reframe** — the spec is too big or mis-scoped; send it back to `/hydra-wayfinder`
  to chart, or edit it before slicing.

Do not yield to the later steps until every `needs-tickets` spec is sliced or explicitly skipped.

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

### Destination-pending wayfinder maps (P) — flag past-threshold rows STALE (§0.5)
| # | Map title | Age | Stale? | Proposed Destination |
|---|-----------|-----|--------|----------------------|

### Wayfinder HITL frontier tickets (H) — flag past-threshold rows STALE (§0.6)
| # | Map | Type | Age | Stale? | Title |
|---|-----|------|-----|--------|-------|

### Handoff-ready wayfinder maps (F) — frontier cleared, awaiting handoff (§0.7)
| # | Map title | Age | Handoff-type | Destination gist |
|---|-----------|-----|--------------|------------------|

### Specs awaiting decomposition (S) — needs-tickets (§0.8)
| # | Spec title | Age | Route |
|---|------------|-----|-------|

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

**Transcript deep-link (issue #695).** Whenever a row references a subagent
dispatch — e.g. a dev failure that names the dispatching session, or a queue
row whose recommendation cites a subagent's run — include a transcript
deep-link line so the operator can read the full conversation in one click:

```
- transcript: http://localhost:4000/dispatch/<sessionId>/transcript
```

`<sessionId>` is the harness session id (the unified active-dispatch row's
`id` for `source === "subagent"`). The link resolves a known dispatch even
after its row expires from the Now page; a registered dispatch whose JSONL was
cleaned up renders a "transcript not available" state with metadata, never a
500. Emit one line per dispatch the row references; omit the line for rows
with no associated subagent dispatch.

Explore the codebase before asking obvious questions.

### 4. Resolution options by entry path

#### Overnight queue row (autopilot deferred)
- **Apply** — execute the recommendation (most common; ~85% of the autopilot's suggestions are right)
- **Override** — operator chooses a different action
- **Defer** — keep the row for tomorrow's review (rare; only when more context is needed)
- **Drop** — discard without action

#### Wayfinder HITL frontier ticket (grilling / prototype)
- **Resolve now** — run `/wayfinder <map> <ticket>`; it records the resolution comment, closes the ticket, and appends to the map's `## Decisions so far`
- **Defer** — leave it on the frontier for tomorrow (the #3355 staleness sweep backstops a never-picked ticket)
- **Reframe** — fix a mis-typed ticket's `wayfinder:*` label, or close it if it is no longer a real decision, so the frontier advances
- Never assign, never relabel `ready-for-agent`, never auto-answer — the HITL contract keeps the machine out of the human's decision (ADR-0029 Decision 3)

#### Handoff-ready wayfinder map (frontier empty, §0.7)
- **Handoff → epic** — run `hydra-prd` (implementation-epic destination); emits `ready-for-agent` tracer children, then close the map
- **Handoff → spec** — run `/to-spec`, then relabel the spec `needs-tickets` (remove `ready-for-agent`) so it enters §0.8, then close the map
- **Handoff → decision / in-place** — record the ADR / file the build, then close the map
- **Not ready** — a fog patch is still open; remove `wayfinder:handoff-pending`, send back to `/hydra-wayfinder`
- Close the map here as the final handoff step (or `keep-open` to keep it as a reference) — `hydra-epic-close` no longer GCs maps

#### Spec awaiting decomposition (needs-tickets, §0.8)
- **Slice now** — run `/to-tickets <spec#>`; publishes `ready-for-agent` tracer children, then drop `needs-tickets` from the spec
- **Defer** — leave `needs-tickets` for tomorrow
- **Reframe** — send back to `/hydra-wayfinder`, or edit the spec before slicing

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
Pipeline: maps-handed-off=H (→ E epics, P specs), specs-sliced=T (→ C tracer children)
```

Report how much work crossed the AFK line this session: every handed-off map and
sliced spec turns operator judgment into `ready-for-agent` children that autopilot
picks up on its next tick. That is the point of the cockpit — count it.

### 6. Offer to chart something new (rung 0)

The buckets above are grounded in existing tracker artifacts, so an **uncharted**
initiative (a foggy idea with no map yet) can't be surfaced — only offered. At
wrap-up, ask once:

> "Anything new too big for one session you want to chart? I can start a
> `/hydra-wayfinder` map for it."

If yes, launch `/hydra-wayfinder` (chart mode) on the operator's initiative — the
top of the ladder. If no, end the session.

## Rules

- **Drain order: overnight queue → destination-pending maps → wayfinder HITL tickets → handoff-ready maps → un-ticketed specs → ready-for-human → stale-blocked.** The queue is the most time-sensitive bucket (the operator already paid for the autopilot's reasoning); destination-pending maps are the highest-leverage single decision (approving one unblocks its whole AFK frontier — ADR-0029); an unresolved HITL ticket then stalls its own map's AFK frontier; handoff-ready maps and un-ticketed specs sit at the far end of the pipeline where one action emits a whole epic's worth of AFK children. Don't reorder any of the wayfinder/spec buckets ahead of the overnight queue, or behind `ready-for-human` / stale-blocked.
- **The handoff flow owns a map's death, not `hydra-epic-close`.** A cleared map is closed in §0.7 as the final handoff step (or kept with `keep-open`). `hydra-epic-close` excludes `wayfinder:map` from auto-GC precisely so a map is never closed before it can be handed off. Mark a map `wayfinder:handoff-pending` when you begin its handoff; remove it when you close/keep the map.
- **A spec is a decompose-me artifact, never a tracer bullet.** After `/to-spec`, always relabel the spec `needs-tickets` and remove `ready-for-agent`, so `hydra-dev` can't grab the whole spec as one issue. The spec becomes AFK-dispatchable only via its `/to-tickets` children (§0.8), each of which carries `ready-for-agent`.
- **A destination-pending map amendment edits the Destination, THEN removes the gate label.** Never remove the label without first landing the operator's edit — the gate is the only thing holding an unwanted destination out of autopilot's frontier. A rejection **closes** the map; it does not just leave the label on (that would strand it for the staleness sweep).
- **Never resolve a wayfinder HITL ticket for the machine.** `wayfinder_orch` structurally never dispatches `wayfinder:grilling` / `wayfinder:prototype` tickets (ADR-0029 Decision 3 — no autopilot answer-ingestion path); the operator resolves them via `/wayfinder`. Never `--add-assignee` (assignment is the AFK-worker claim signal), never relabel `ready-for-agent` (the off-radar rule keeps `wayfinder:*` off the ordinary board).
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
