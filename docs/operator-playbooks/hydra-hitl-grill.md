---
name: hydra-hitl-grill
description: Drain the hitl-grill park lane on gaberoo322/hydra — classify every parked agent-filed item (premise still true? duplicate? scoped? which cluster?), dismiss moot clusters in one question, then walk the rest one at a time to Promote / Scope-and-promote / Grill-first / Fold / Dismiss through the board routes. Operator-interactive; never an autopilot dispatch class.
when_to_use: "When the operator has time to work through parked ideas and says 'drain hitl-grill', 'work the park lane', 'triage parked ideas', 'what's in the inbox', or /hydra-review points here. Not for ready-for-human or stale-blocked rows — those are /hydra-review."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
claude_only: true
arguments: [cluster]
---

# Hydra HITL Grill — drain the park lane

`hitl-grill` is the **admission valve** of the loop (`hydra-autopilot` § Self-filed
work): every defect an agent notices in Hydra's own machinery is filed here, and
**only the operator** moves it out. Nothing else drains it — not `hydra-sweep`
(the label is excluded from the orphan backstop), not `/hydra-review` (parked
ideas block no AFK work, so they are not attention items), and never the autopilot.
When the lane sits over its cap, producer classes silently *drop* new findings
rather than park them, so an undrained lane is lost signal, not just a long list.

**What the lane actually holds.** Despite the #4025 framing ("speculative ideas"),
the items are mostly concrete, agent-authored **defect reports** with cited files
— many already carry a `## Files in scope` section and could be promoted as-is,
many describe machinery for a mothballed Target, and several duplicate each other
or an open map/epic. So this skill is a **triage drain**, not a grilling session:
it settles the facts itself, asks you only for the judgment, and lets a whole
moot cluster go in one question.

## Rules — read first

1. **Operator-interactive only.** This skill is never named in
   `scripts/autopilot/classes.json` and never dispatched by `/hydra-autopilot` or
   any AFK session. It *is* the human in the loop; automating it recreates the
   churn buffer the admission rule exists to prevent.
2. **Facts are yours, decisions are the operator's.** Premise checks, duplicate
   detection, cluster assignment and the scope-section draft are facts — settle
   them by reading the codebase and the tracker. Promote / dismiss is a decision
   — always a question. **Ambiguous means Skip**, never a guessed verdict.
3. **One write path: the board routes.** Promote and dismiss go through
   `POST /api/autopilot/board/promote` and `POST /api/autopilot/board/close`,
   exactly as the Work page's HITL grill inbox does — a promote strips
   `hitl-grill` in the same verified write that adds `ready-for-agent`; a dismiss
   closes `not planned` and **retains** `hitl-grill` as the producers' dedup
   baseline. Never `gh issue edit --add-label/--remove-label` the park or
   ready labels by hand (half-written states are exactly what the routes prevent).
4. **Cluster verdicts are for Dismiss only.** Promotes are always per item.
5. **Every verdict leaves a comment** starting
   `> *Verdict via /hydra-hitl-grill: <verdict> — <one-line reason>*` so the
   producers (and future you) can see why.
6. **Slot 1 is the recommendation, slot 4 is always Skip** — the same walk
   contract as `/hydra-review` §3–§4, pinned by
   `test/hydra-hitl-grill-option-table.test.mts`.

## Arguments

- `cluster` (optional) — restrict the session to one cluster name from §2
  (e.g. `target-machinery`, `glm-drainer`, `architecture-scan`, `autopilot-signals`,
  `docs`). Default: all clusters, oldest first.
- `--dry-run` as the first argument — run §1–§2 only and print the classification
  table; no questions, no writes. Use it to preview a big lane before committing an hour.

## Procedure

### 1. Read the lane

Read from the same source the Work page renders, so the two surfaces never
disagree on the count:

```bash
curl -sf http://localhost:4000/api/autopilot/hitl-grill \
  | jq -r '.items[] | "#\(.number)\t\(.provenance|join(","))\t\(.reason)\t\(.title)"'
```

If the service is down, fall back to `gh issue list --repo gaberoo322/hydra
--label hitl-grill --state open --limit 200 --json number,title,labels,body,createdAt`
— `--limit 200` is load-bearing; the default page of 30 under-counts this lane.
Sort oldest first. Print the open count and the cap
(`hydra-autopilot` § admission rule — 10 today) up front.

### 2. Classify before asking anything (facts, inline, parallel `gh`)

For every item resolve four facts. No subagents — a handful of `gh`/`grep` calls
per row is cheaper than a fan-out.

| Fact | How | Values |
|---|---|---|
| **Premise** | Open the cited file(s) on `origin/master`; search closed PRs/issues for the same symptom (`gh search prs --repo gaberoo322/hydra --merged "<key phrase>"`). Does the defect still exist? | `holds` / `fixed (#PR)` / `superseded (#issue)` / `moot (subsystem retired)` |
| **Duplicate** | Same symptom in another OPEN `hitl-grill` item, an open epic/map ticket, or a CLOSED `not planned` item still carrying `hitl-grill` (the producers' dedup baseline). | `none` / `dup of #N` / `belongs to map/epic #N` |
| **Scoped** | Body contains a `## Files in scope` section (the promote route refuses without it). | `yes` / `no` |
| **Cluster** | By subject. Seeds: `target-machinery` (hydra-target-*, dev_target, Target CI/QA), `glm-drainer`, `architecture-scan` (provenance label), `autopilot-signals` (collect-state / decide.py / reap.py), `docs`. Add a cluster when three or more items share a subject. | cluster name |

Print the table (number, age, cluster, premise, duplicate, scoped, title). This is
the whole output of `--dry-run`. When the operator passed a `cluster`, drop every
other row now.

A **moot premise** is the common case for `target-machinery` items after a
Target mothball — but check each: machinery that the successor Target will reuse
(`hydra-target-build`, `hydra-target-qa`) is *not* moot just because the
current Target is.

### 3. Cluster verdicts — Dismiss only

For each cluster where classification recommends **dismiss for every item**
(premise `moot`/`fixed`/`superseded`, or `dup`), ask **one** `multiSelect`
`AskUserQuestion`: header = the cluster name, question = "Dismiss these N as
moot — uncheck any to keep", one option per item (label `#N <short title>`,
description = the classification reason). Checked items are dismissed (§5);
unchecked items fall through to the per-item walk in §4.

Never batch a promote this way, and never put an item whose premise `holds` into
a cluster question.

### 4. Per-item walk — one row, one question, one call

Take the remaining items oldest first. For each: read the full issue (body,
comments, labels, linked PRs), write a 2–4 line summary *above* the prompt
(what it claims, what classification found, why slot 1), then call
`AskUserQuestion` with **exactly one question** using the row's situation from
the canonical table below. `header` = the situation (≤12 chars: `Scoped`,
`Unscoped`, `Premise off`, `Overlaps`); `question` names the row by number and
title; each option's `description` says what will actually happen.

For **Unscoped** rows, draft the `## Files in scope` section from the files the
body cites and show it as the slot-1 option's `preview`, so confirming the
recommendation also confirms the scope. For **Premise off** and **Overlaps**
rows, put the evidence (fixing PR, owning issue, retired subsystem) in the
`preview`. No preview on **Scoped** rows — the summary carries it.

## The canonical option table

One row per situation. **Slot 1 is the recommended action, slot 4 is always
Skip**; "Other" is appended automatically by the tool — never write it as an
option. **Slots 2–4 never change**; slot 1's *label* may be specialised to the
row when the generic verb would be wrong (the same escape hatch `/hydra-review`
§4 carries), e.g. `Promote (T1 doc fix)`.

| Situation | 1 (Recommended) | 2 | 3 | 4 |
|---|---|---|---|---|
| Scoped, premise holds | Promote | Grill first | Dismiss | Skip |
| Unscoped, premise holds | Scope and promote | Grill first | Dismiss | Skip |
| Premise false or superseded | Dismiss | Fold into owner | Promote anyway | Skip |
| Overlaps a map or epic | Fold into owner | Promote | Dismiss | Skip |

### 5. Execute the verdict

All writes target `gaberoo322/hydra`. Check `.ok` on every route response and
show the operator the post-write state the route returns — never render success
you have not read back.

- **Promote**
  ```bash
  curl -sf -X POST http://localhost:4000/api/autopilot/board/promote \
    -H 'content-type: application/json' -d '{"issue":<N>,"confirm":true}' | jq .
  ```
  The route refuses `closed`, `already-ready`, `missing-scope-section`, or
  `blocked` (an open strict blocker) — report the `reason` and Skip the row rather
  than working around it.
- **Scope and promote** — write the confirmed `## Files in scope` section into the
  body first (`gh issue edit <N> --repo gaberoo322/hydra --body-file <tmp>` with
  the full amended body — never `-f body@=`), then run Promote. Keep the section
  plain paths, one per line: `scope-check` turns every code-span into an entry.
- **Grill first** — add `needs-design-concept` (a plain label add, not a
  park/ready transition: `gh api -X POST repos/gaberoo322/hydra/issues/<N>/labels
  -f 'labels[]=needs-design-concept'`), then run Promote. The autopilot's
  design-concept gate then routes it through `hydra-grill` before any dev
  dispatch. Requires a scope section like Promote does.
- **Fold into owner** — comment the owner link on the parked issue and a
  back-link on the owner (map ticket, epic child, or the surviving duplicate),
  then Dismiss it. The owner carries the work; the parked copy is a dup.
- **Dismiss**
  ```bash
  curl -sf -X POST http://localhost:4000/api/autopilot/board/close \
    -H 'content-type: application/json' -d '{"issue":<N>,"reason":"not planned"}' | jq .
  ```
  `hitl-grill` stays on the closed issue on purpose — producers grep it before
  re-filing.
- **Promote anyway** — the operator disagrees with the premise check; say so in
  the verdict comment, then run Promote (or Scope and promote if unscoped).

Then post the verdict comment (Rule 5) and move on.

### 6. Session cap and wrap-up

Stop after **10 per-item verdicts or one full cluster**, whichever comes first,
unless the operator asks to continue. End with:

```
## Session summary — hitl-grill

| # | Cluster | Was | Verdict | Now |
|---|---------|-----|---------|-----|

Lane: <open before> → <open after> (cap 10). Skipped: <n>. Next cluster to drain: <name>.
```

## Skill files

The canonical source is `docs/operator-playbooks/hydra-hitl-grill.md`. The deployed
copy at `~/.claude/skills/hydra-hitl-grill/SKILL.md` is machine-generated by
`scripts/sync-skills.sh` on every master deploy — never edit it by hand.
