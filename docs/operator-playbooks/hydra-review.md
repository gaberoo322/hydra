---
name: hydra-review
description: The operator's HITL cockpit — surfaces everything needing the operator's hand and walks each item toward AFK-dispatchable: overnight decision queue, stalled PRs, ready-for-human, stale-blocked, AND every configured Target project's operator-attention items (ready-for-human, reframe, stale-blocked).
when_to_use: "When the user says 'review issues', 'what needs my attention', 'what can I do', 'check blocked issues', 'review target work', or wants to advance stuck work (orchestrator OR any Target project) toward autopilot. Also the morning hand-off for an overnight `/hydra-autopilot --unattended=true` run."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
claude_only: true
---

# Operator Review — the HITL pipeline cockpit

Interactive session to advance every item that needs the operator's hand toward
**AFK-dispatchable** — the point where `hydra-autopilot` can work it with no
operator in the loop. Not just a decision-queue drainer: it classifies each item,
verifies the classification against the tracker rather than trusting a label, and
names the single action that unsticks it.

**Scope: the Orchestrator plus every configured Target project.** This one cockpit
covers both boards (ADR-0031 unified the Target onto a GitHub-Issues board, exactly
like the Orchestrator's). The overnight decision queue (§0) applies to
`gaberoo322/hydra` only, but stalled PRs (§0.9) and the operator-attention tail
(`ready-for-human`, `reframe`, stale-`blocked`) are walked for the Orchestrator
**and** each Target board in one session (§0.9, §1.5). This retires the separate `/hydra-target-review` skill, which read a
now-dead Redis backlog and was blind to the live Target GitHub board. The Target
enumeration is a **loop** over `target-config.ts` (`getTargetGithubRepo()`), so it is
N-ready; today Hydra is a single swappable Target (ADR-0013), so the loop has one
entry (`gaberoo322/hydra-betting`).

## Buckets, in drain order

1. **Overnight operator-decision queue** (§0) — today's `Operator decision queue YYYY-MM-DD` issue, written by `/hydra-autopilot` running in unattended mode (issue #413). One row per Tier-0 / non-mechanical PR that would have called `AskUserQuestion` if the operator had been awake.
2. **Stalled PRs** (§0.9) — green-but-conflicted and green-but-unshepherded PRs across `gaberoo322/hydra` and every Target repo. A PR is not an issue (so no bucket above walks it), its passing checks alarm nothing, and a merge conflict raises no signal — finished work that is not landing sits invisible until somebody looks.
3. **`ready-for-human`** (Orchestrator) — `gaberoo322/hydra` issues requiring operator decisions
4. **Stale-blocked** (Orchestrator) — `blocked` issues where no linked open issue justifies the block
5. **Per-Target operator-attention items** (§1.5) — for each configured Target board (`target-config.ts`), the Target's `ready-for-human`, `reframe` (a build that failed 2+ times, stamped by `hydra-target-qa`), and stale-`blocked` issues. Deliberately **not** `needs-triage` — that is `hydra-target-sweep`'s autonomous lane (mirroring how the Orchestrator buckets leave triage to `hydra-sweep`).

The queue issue is drained first because each row is already paired with a recommendation from the autopilot — the operator answers fastest there. Stalled PRs drain next: a green-but-stuck PR is finished work that is not landing, and it is the cheapest thing on the board to unstick — usually one command — so clearing it first converts effort into merged work before the session spends judgment on undecided issues. `ready-for-human` and stale-blocked follow: these need real operator thought, and a stale-blocked row in particular is only worth walking after its blocker has been verified against the tracker rather than trusted from the label. Per-Target items drain **last**: the Orchestrator-self board is primary (it builds the machine that builds the Targets), and a Target `reframe`/`ready-for-human` blocks only that one Target build loop, not the whole AFK frontier.

## Procedure

### GLM dev-drainer beachhead report (informational — read once, no draining)

Before touching any bucket, print the GLM dev-drainer's beachhead readout
(issue #3690, ADR-0032 Decision 6's ~2-week/~25-PR keep-or-kill window):

```bash
bash scripts/glm-beachhead-report.sh
```

This is context, not a queue entry: it carries no operator-decision options
and nothing here drains it — it is a single informational line placed ahead
of the operator-decision buckets below because it colors how the operator
reads everything else this session (e.g. a KILL-signal readout is a cue to
look harder at any `glm-authored` PR encountered later in the session). The
script computes window progress, first-pass QA PASS-rate, the live
`percentLast7d` delta against a bootstrapped day-0 baseline, and churn vs a
non-GLM baseline, folding them into a `recommendation:` string. **That
recommendation is advisory prose only** — no code path anywhere auto-flips
keep/kill/expand (ADR-0032 #3671 explicitly rejected an auto-flip
circuit-breaker); acting on it (disabling the timer, changing labels) is
always the operator's own decision, made by hand outside this script.

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

### 0.5. Open wayfinder maps — liveness probe only (issue #4179)

`/hydra-review` no longer carries the wayfinder/spec drain procedure. Three of
its four gating labels (`wayfinder:destination-pending`, `wayfinder:handoff-pending`,
`needs-tickets`) had never been applied to a single issue in the repo's history,
and `needs-tickets` already has an autonomous consumer (`collect-state.sh` emits
`tickets_available`; `decide.py` dispatches `tickets_orch` on it). Deleting a
procedure that has never had an input is free — but silently losing track of a
chartered map is not, because its whole AFK frontier stalls with nothing alarming.
So the detection stays and the procedure goes:

```bash
gh issue list --repo gaberoo322/hydra --state open --label 'wayfinder:map' \
  --json number,title --jq 'if length == 0 then empty else
    "OPEN WAYFINDER MAPS (\(length)) — run /hydra-wayfinder to work them:",
    (.[] | "  #\(.number) \(.title)") end'
```

Report whatever it prints as a single informational line and **move on** — do not
drain it here. Map work (approving a Destination, resolving a `wayfinder:grilling`
or `wayfinder:prototype` ticket, handing a cleared map off, closing it) all belongs
to `/hydra-wayfinder`, which owns the map lifecycle end to end. Empty output means
no open maps: print nothing.

### 0.9. Drain stalled PRs (green-but-stuck pull requests)

A PR that is green but unmergeable — or mergeable and green but never armed for
auto-merge — is invisible to every bucket above: it is not an issue, its passing
checks alarm nothing, and a merge conflict raises no signal at all (four such
PRs sat unexamined on 2026-08-11). This bucket walks every open non-draft PR on
`gaberoo322/hydra` **and** each configured Target repo in the **same** step
(mirroring §1.5's `TARGET_REPOS` loop — Target coverage is not deferred to the
end-of-session phase) and surfaces the two failure modes:

- **`conflicted`** — `mergeable == "CONFLICTING"`. The branch fell behind master
  and nothing re-bases or reports it.
- **`unshepherded`** — `mergeable == "MERGEABLE"` **AND** every *required* check
  passes **AND** `autoMergeRequest == null`. Mergeable and green, but no
  mechanism will ever merge it.

> **`mergeable == "UNKNOWN"` is "no verdict", never conflicted.** GitHub computes
> mergeability asynchronously; a freshly-pushed PR reports `UNKNOWN` for a few
> seconds. Reporting that as a conflict cries wolf on every active PR and gets
> the signal ignored — re-poll once after a short delay, or skip the row for
> this pass.

> **"Required" means the branch-protection set, not "all checks".** For
> `gaberoo322/hydra` that is exactly seven contexts — `test`, `dashboard-build`,
> `tier-gate`, `mutation-test`, `scope-check`, `secret-scan`, `deep-qa-gate`
> (the live set:
> `gh api repos/gaberoo322/hydra/branches/master/protection/required_status_checks`).
> `advisory-checks` (the shrink-only skill-size ratchet) is **ambient red on
> master** and is NOT in branch protection — it must NEVER count toward the
> predicate, or every PR in the repo reports as stalled. Confirm with
> `gh pr checks <PR> --repo <RREPO>` and read only the branch-protection rows.

Gather across the Orchestrator and each Target repo:

```bash
REVIEW_REPOS=("gaberoo322/hydra" "${HYDRA_TARGET_GITHUB_REPO:-gaberoo322/hydra-betting}")

for RREPO in "${REVIEW_REPOS[@]}"; do
  echo "=== stalled PRs: $RREPO ==="
  # conflicted: open, non-draft, mergeable == CONFLICTING (UNKNOWN is never conflicted — see above)
  gh pr list --repo "$RREPO" --state open \
    --json number,title,isDraft,mergeable \
    --jq '[.[] | select(.isDraft | not) | select(.mergeable == "CONFLICTING")]
          | sort_by(.number) | .[] | "CONFLICTED\t\(.number)\t\(.title)"'
  # unshepherded candidates: open, non-draft, mergeable == MERGEABLE, autoMerge not set
  gh pr list --repo "$RREPO" --state open \
    --json number,title,isDraft,mergeable,autoMergeRequest \
    --jq '[.[] | select(.isDraft | not) | select(.mergeable == "MERGEABLE")
              | select(.autoMergeRequest == null)]
          | sort_by(.number) | .[] | "UNSHEPHERDED?\t\(.number)\t\(.title)"'
done
```

`UNSHEPHERDED?` is a candidate, not a verdict — confirm every **required** check
above passes before treating the row as stalled. Walk the combined list
oldest-first, one PR at a time, and offer the canonical four (§4):

- **Land it** — the slot-1 recommended action. **The mechanism is decided by the
  required checks, never guessed:** if every required check already
  passes, `gh pr merge <PR> --squash --repo <RREPO>` (merge now); otherwise
  `gh pr merge <PR> --auto --repo <RREPO>` to arm auto-merge so it lands the
  moment CI goes green. State which one will fire in the option's `description`,
  and put the check table in the `preview` so the operator sees the state that
  decided it. **The collapse is in the operator's CHOICE, not in the commands
  available** — both mechanisms remain, reachable via "Other".
- **Update branch** — `gh pr update-branch <PR> --repo <RREPO>`; if it reports
  conflicts, surface them and move on. **Do not auto-resolve** — a conflict on a
  regenerated file or a modify/delete usually encodes a real design question.
- **Close** — the PR is superseded or wrong.
- **Skip** — leave for tomorrow.

No path here re-bases or merges automatically; a merge fires only when the
operator explicitly picks **Enable auto-merge** or **Merge now** for that row. Do
not yield to the later steps until every stalled PR is resolved or skipped.

### 1. Gather (Orchestrator)

```bash
gh issue list --repo gaberoo322/hydra --label "ready-for-human" --state open --json number,title,labels,createdAt,updatedAt
gh issue list --repo gaberoo322/hydra --label "blocked" --state open --json number,title,labels,body,createdAt,updatedAt
```

For each blocked issue, check body/comments for "blocked by #N", "depends on #N", or links. Referenced issue closed or no blocker referenced → stale-blocked.

### 1.5. Gather (per Target board)

Enumerate the configured Target repos and gather each board's operator-attention
labels. The enumeration mirrors `target-config.ts` (`getTargetGithubRepo()` / the
`HYDRA_TARGET_GITHUB_REPO` env, default `gaberoo322/hydra-betting`) as an **array**,
so this is N-ready — today it resolves to one Target (ADR-0013 single swappable
Target):

```bash
# N-ready: one line to update if/when target-config exposes multiple Targets.
TARGET_REPOS=("${HYDRA_TARGET_GITHUB_REPO:-gaberoo322/hydra-betting}")

for TREPO in "${TARGET_REPOS[@]}"; do
  echo "=== target: $TREPO ==="
  gh issue list --repo "$TREPO" --label "ready-for-human" --state open --json number,title,labels,createdAt,updatedAt
  gh issue list --repo "$TREPO" --label "reframe"         --state open --json number,title,labels,body,createdAt,updatedAt
  gh issue list --repo "$TREPO" --label "blocked"          --state open --json number,title,labels,body,createdAt,updatedAt
done
```

Same stale-blocked test as the Orchestrator: for each Target `blocked` issue, check
body/comments for a "blocked by #N" reference — referenced issue closed, or no
blocker referenced, → stale-blocked. **Do not** gather `needs-triage` (that is
`hydra-target-sweep`'s autonomous lane). A `reframe` item is a Target build that
failed 2+ times (stamped by `hydra-target-qa` alongside `ready-for-human`); surface
its prior-attempt history so the operator decides informed.

### 2. Present

```
## Issues needing attention (N total)

### Overnight decisions (Q in today's queue, from autopilot)
| # | PR | tier | recommendation |
|---|----|------|----------------|

### Stalled PRs (C) — green-but-conflicted / green-but-unshepherded (§0.9)
(both Orchestrator and every Target repo)
| # | Repo | State | Title |
|---|------|-------|-------|

### Ready-for-human (M) — Orchestrator
| # | Title | Age | Why here |
|---|-------|-----|----------|

### Stale-blocked (K) — Orchestrator
| # | Title | Age | Blocker status |
|---|-------|-----|----------------|

### Target: <repo> — ready-for-human / reframe / stale-blocked (T) — §1.5
(one block per configured Target board; omit a Target with nothing needing attention)
| # | Kind | Title | Age | Why here / prior attempts |
|---|------|-------|-----|---------------------------|
```

### 2.5. Classify, then (only if large) filter

**Classification is not optional, and it runs inline.** Before presenting
anything, resolve each gathered row's *cheap* facts with parallel `gh` calls — no
subagents, no `Workflow`:

- **stale-blocked candidates** — does the named blocker still exist, is it CLOSED,
  and does its close event carry a real `commit_id`? A `completed` close with a
  null `commit_id` is not proof a fix shipped, so confirm the change is actually
  on the default branch before calling a row stale.
- **stalled PRs** — the state of each *required* check (branch-protection set
  only; `advisory-checks` is ambient-red and must never count).

~1–2 `gh` calls per row, and what makes the table and the §3 previews truthful.
It is also the real winnowing — report a row confirmed *genuinely* blocked as a
suppressed count, never walk it.

**The multi-select filter is gated.** `multiSelect` does **not** lift the
4-option ceiling (4 × 4 = 16 rows per call), and after classification most boards
have 2–3 actionable rows, where a filter is ceremony. So:

> Fire the filter **only when the post-classification actionable list exceeds 5
> rows.** Chunk it 4-per-question, one question per bucket, and ask the operator
> to select the rows to work this session. At 5 or fewer, skip the filter and
> walk them all.

**Expensive enrichment fans out via `Workflow`, past a floor.** Reading PR failure
logs, full comment histories, prior-attempt histories, or exploring a Target
codebase is agent work. Run it **only on rows that survived the filter**, and
**only when there are ≥4** — below that, inline beats subagent spin-up, so on a
typical 2-row day it never fires. A `Workflow` subagent has **no channel to the operator and cannot call `AskUserQuestion`**;
it returns data, and the main loop does every prompt.

```js
export const meta = {
  name: 'hydra-review-enrich',
  description: 'Deep-read each selected review row in parallel',
  phases: [{ title: 'Enrich', detail: 'one agent per selected row' }],
}
phase('Enrich')
const ROW_SCHEMA = {
  type: 'object',
  required: ['ref', 'finding', 'recommendation'],
  properties: {
    ref: { type: 'string' },
    finding: { type: 'string' },
    recommendation: { type: 'string' },
    evidence: { type: 'string' },
  },
}
const rows = await parallel(args.rows.map((r) => () =>
  agent(
    `Deep-read ${r.repo}#${r.number} ("${r.title}") for an operator review.\n` +
    `Read the issue body, ALL comments, linked PRs, and any failing CI logs.\n` +
    `Report what a decision actually turns on. Verify claims against the tracker ` +
    `and the default branch — never trust a label or a close event alone.`,
    { label: `enrich:${r.repo}#${r.number}`, phase: 'Enrich', schema: ROW_SCHEMA },
  )))
return rows.filter(Boolean)
```

Pass the surviving rows as `args.rows`. Results feed the §3 summaries; they never
replace the operator's pick.

Then: "I'll walk through these one at a time, starting with the overnight queue. Ready?"

### 3. Review loop — one issue at a time, via `AskUserQuestion`

Every row is presented as a **single-select `AskUserQuestion`**, never as prose
asking the operator to type a reply.

Per row:

1. Read the full issue (body, comments, labels, linked PRs) — for a Target row,
   against that Target's repo.
2. Identify the entry path (queue row / stalled PR / triage / tracking parent /
   dev failure / stale-blocked / **Target ready-for-human / reframe /
   stale-blocked**).
3. Write a concise summary as ordinary text *above* the prompt — the prompt
   carries the choice, the text carries the reasoning.
4. Call `AskUserQuestion` with **exactly one question** for this row, using that
   bucket's canonical options from §4. One row = one question = one call; never
   batch two rows into one call, and never pre-stage the next row's question.
5. Execute the pick via `gh` — **always pass the row's own repo**
   (`--repo gaberoo322/hydra` for Orchestrator rows, `--repo <TREPO>` for Target
   rows); explore that repo's checkout (`~/hydra` vs `~/hydra-betting/web`)
   before asking obvious questions.
6. Move on.

**Prompt shape.** `header` is the bucket (≤12 chars: `Stalled PR`, `Blocked`,
`Triage`, `Reframe`). `question` names the row by number and title. Each option
carries a `description` saying what will actually happen — the label is the verb,
the description is the consequence.

**Slot 1 is the recommendation**, labelled `<action> (Recommended)`. This is the
whole point: the operator clicks option 1 without reading further when they agree.
Never present a neutral menu — commit to a position and put it first.

**Slot 4 is always Skip.** "Other" is appended automatically by the tool for free
text, so it is never an option you write.

**Evidence `preview` — two buckets only.** `preview` renders monospace markdown
beside the options and is single-select-only, which is exactly this walk. Use it
where **evidence decides the row**:

- **Stale-blocked** — the blocker's number, state, and (if closed) its close-event
  `commit_id`, plus whether that commit is actually on the default branch. A
  `completed` close with a null `commit_id` is NOT proof a fix shipped.
- **Stalled PRs** — the required-check table (name → state), so the operator sees
  the state that decided which mechanism "Land it" will use.

Do **not** attach a preview to judgment rows (triage, `ready-for-human`,
`reframe`). There the decision is prose the summary already carries, and a
preview would compete with the options instead of informing them.

**Transcript deep-link (issue #695).** Whenever a row references a subagent
dispatch — a dev failure naming its dispatching session, a queue row citing a
subagent's run — include a deep-link line in the summary text:

```
- transcript: http://localhost:4000/dispatch/<sessionId>/transcript
```

`<sessionId>` is the harness session id (the unified active-dispatch row's `id`
for `source === "subagent"`). It resolves a known dispatch even after its row
expires from the Now page; a registered dispatch whose JSONL was cleaned up
renders a "transcript not available" state, never a 500. One line per referenced
dispatch; omit it for rows with none.

Explore the codebase before asking obvious questions.

### 4. The canonical option table

One row per bucket. **Slot 1 is the recommended action, slot 4 is always Skip**,
giving three substantive options plus the tool's automatic "Other". This table is
the contract — pinned by `test/hydra-review-option-table.test.mts` — so the same
bucket renders the same choices every session and the operator builds muscle
memory on position, not wording.

| Bucket | 1 (Recommended) | 2 | 3 | 4 |
|---|---|---|---|---|
| Overnight queue row | Apply | Override | Drop | Skip |
| Stalled PR | Land it | Update branch | Close | Skip |
| Triage origin | Make it agent-ready | Needs more info | Won't do | Skip |
| Tracking parent | Close (children done) | Restructure | Unblock children | Skip |
| Dev failure | Retry with narrower scope | Provide implementation hints | Abandon | Skip |
| Stale-blocked | Unblock | Still blocked (update ref) | No longer relevant | Skip |
| Target ready-for-human | Make it agent-ready | Needs more info | Won't do | Skip |
| Target reframe | Narrow scope | Provide implementation approach | Abandon | Skip |
| Target stale-blocked | Unblock | Still blocked (update ref) | No longer relevant | Skip |

**The slot-1 escape hatch.** Slot 1's *label* may be specialised to the row when
the generic action would be wrong — e.g. a stalled PR wedged on a fixable gate
takes **"Fix and push"** instead of "Land it", because arming auto-merge on a PR
that can never go green does nothing. **Slots 2–4 never change.** Without this
carve-out the table would force such a row into an action that cannot work.

**What each option does**

- **Apply** — execute the autopilot's recommendation verbatim (~85% are right).
  **Override** — operator supplies a different action. **Drop** — discard as a
  false alarm. *Deferring is `Skip`* — the row stays for tomorrow either way.
- **Land it** — see §0.9; mechanism decided by required-check state.
  **Update branch** — `gh pr update-branch`; surface conflicts, never auto-resolve.
- **Make it agent-ready** — write the agent brief (category, summary,
  current/desired behavior, acceptance criteria, out-of-scope, key interfaces)
  **including any operator hints**, then relabel `ready-for-agent` (stripping
  `ready-for-human` / `reframe`). Absorbs the former "Provide guidance".
- **Close (children done)** — only after the open-PR check in Rules.
  **Restructure** — merge/split/reorder children. **Unblock children** —
  re-triage the stuck ones. *"Keep as-is" is `Skip`.*
- **Unblock** — remove `blocked`, apply the next state. **Still blocked (update
  ref)** — write the real blocker into the **body** as `## Blocked by`, never a
  comment: the staleness sweep parses bodies only, so a blocker recorded in a
  comment is invisible and the row resurfaces forever.
- **Retry with narrower scope** / **Narrow scope** — rewrite smaller, relabel
  `ready-for-agent`. **Abandon** — repeated failure means infeasible; close
  `wontfix`. *"Take over manually" is `Skip`* — the operator doing it themselves
  needs no machine action.

**Reachable only via "Other" (deliberate).** *Break it down* (triage) and *Split
into steps* (Target reframe) — both create child issues, both are rare here, and
both lose to keeping slot 4 free for Skip.

**Target rows resolve against the Target repo.** Every `gh` call for a Target row
carries `--repo <TREPO>`, and exploration uses that Target's workspace
(`~/hydra-betting/web`). A `reframe` row is a build that failed 2+ times: surface
the prior attempts, with transcript deep-links, *before* the prompt.

### 5. Wrap-up

```
## Session summary

| # | Title | Was | Resolution | Now |
|---|-------|-----|------------|-----|

Resolved: X | Deferred: Y | Remaining: Z
Overnight queue: applied=A, overridden=O, deferred=D, dropped=R
Targets: <repo> — agent-ready=G, reframed=F, unblocked=U, abandoned=B (one line per Target board touched)
```

Report how much work crossed the AFK line this session: every row relabelled
`ready-for-agent` and every PR landed turns operator judgment into work autopilot
carries on its next tick. That is the point of the cockpit — count it.

## Rules

- **Drain order: overnight queue → stalled PRs (§0.9) → Orchestrator ready-for-human → Orchestrator stale-blocked → per-Target items (§1.5).** The queue is the most time-sensitive bucket (the operator already paid for the autopilot's reasoning). Stalled PRs come next because they are the cheapest conversion of effort into merged work on the board. Don't reorder anything ahead of the overnight queue. **Per-Target items always drain last** (the Orchestrator-self board is primary); within the Target phase, finish one Target board fully before starting the next.
- **Target rows resolve against the Target repo, never `gaberoo322/hydra`.** Every `gh` command for a Target row carries `--repo <TREPO>` (the row's own repo from the §1.5 enumeration), and codebase exploration uses that Target's workspace (e.g. `~/hydra-betting/web`, not `~/hydra`). Never gather or resolve a Target `needs-triage` item here — that is `hydra-target-sweep`'s autonomous lane.
- **One issue at a time. No batching.** This survives `AskUserQuestion` intact:
  one row = one question = one call. The multi-select filter (§2.5) batches only
  the *choice of which rows to work*, never a resolution — and it fires only above
  5 post-classification rows. Filtering is cheap; resolution is where the
  verification lives — see the pre-close PR check below for what batching cost
  once.
- **Classify before presenting, and verify rather than trust a label.** A
  `blocked` row is only stale once its blocker is confirmed closed AND its fix
  confirmed on the default branch — a `completed` close with a null `commit_id`
  ships nothing. A stalled PR is only unshepherded once every *required* check is
  confirmed green; `advisory-checks` is ambient-red on master and must never
  count toward that predicate.
- **Never present a neutral menu.** Slot 1 is a committed recommendation labelled
  `(Recommended)`, so agreeing costs one click. Slot 4 is always Skip. "Other" is
  appended by the tool — never write it as an option.
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
