---
name: hydra-wire-or-retire
description: Non-interactive resolver for the Target's wire-or-retire decision queue. Reads the open `wire-or-retire`-labelled items sitting in the Target (~/hydra-betting) triage lane — modules built with intent that either stalled or died, filed by /hydra-target-cleanup — and turns each into a verdict: WIRE (rewrite into a concrete ready-for-agent wiring task, move to queued), RETIRE (rewrite into a ready-for-agent retirement task citing the deadcode scan, move to queued), or UNCLEAR (route ready-for-human and stop). Recovers intent via git-log archaeology + a cross-ref of config/direction vision/priorities/roadmap + the Target backlog open AND done lanes. Resolves at most 2 items per run. Hard carve-out — modules under web/src/lib/risk/ or live-execution paths ALWAYS route ready-for-human. Ambiguity never resolves to deletion. Zero AskUserQuestion.
when_to_use: "When the Target triage lane holds open `wire-or-retire` decision items and the autopilot wants to actually make the wire-vs-retire call, or when the operator says 'resolve wire-or-retire', '/hydra-wire-or-retire', or 'make the wiring decisions'. Dispatched by the autopilot `wire_or_retire_target` signal class on the `wire_or_retire_target_available` signal, at a 24h cooldown (issue #2722, epic #2720)."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
claude_only: true
---

# Hydra Wire-or-Retire (headless Target decision resolver)

`hydra-wire-or-retire` is the **judgment counterpart** to `/hydra-target-cleanup`'s
mechanical demote-only sweep. `/hydra-target-cleanup` files **`wire-or-retire`**-labelled,
`needs-triage` Redis backlog items for Target (`~/hydra-betting`) modules that are past the
45-day wiring grace with no runtime importer — modules Hydra built with intent that either
stalled (wire it) or died (retire it). Those items are the **decision queue**; deciding which
requires **recovering the intent**, which a static tool cannot do. This skill makes the call.

The prompt-shaped resolver protocol was already drafted inside each item's body, but a
prompt-only rule is what failed: two items (`item-685`, `item-687`) were laundered into the
`backlog` lane where no sweep looks — so issue **#2721** added a code-level lane guard
(`moveItemToLane` rejects `triage → backlog` for a `wire-or-retire`-labelled item; the only
exits are a WIRE/RETIRE `queued` task or a `ready-for-human` `blocked` item). This skill is
issue **#2722**: the class that *dispatches a resolver* so the queue actually drains.

## What it is vs. what it is not

| | `/hydra-target-cleanup` (mechanical) | `/hydra-wire-or-retire` (judgment) |
|---|---|---|
| Input | knip report + wiring-status ledger | the open `wire-or-retire` items in the **triage** lane |
| Decision | deterministic (demote-only, self-checking) | an **opinion** — recover intent, then decide |
| Output | `ready-for-agent` demote items → `queued` | per item: a rewritten WIRE/RETIRE task → `queued`, OR `ready-for-human` → `blocked` |
| Deletes anything? | never | never (it rewrites items into tasks; the *follow-up* task may delete) |
| Cadence | 1h (`target_backfill_idle`) | 24h (`wire_or_retire_target_available`) |

This skill **never edits the Target working tree** and **never deletes a module**. It only
reads (`git log`, `rg`, config/direction, the backlog) and **rewrites backlog items** into the
next actionable task via the backlog API. The deletion, if any, happens later inside the
`ready-for-agent` retirement task a human/agent picks up.

## Trigger

Dispatched by the autopilot `wire_or_retire_target` signal class (issue #2722) when
`collect-state.sh` emits **`wire_or_retire_target_available`** — true when ≥1 open item
carrying the `wire-or-retire` label sits in the Target **triage** lane. The class carries a
**24h cooldown** (`SIGNAL_COOLDOWNS["wire_or_retire_target"]`, seeded in `bootstrap.sh`'s
`signal_last_fired` so it survives the pace-gate relaunch — the #2575 cooldown-bootstrap bug
class), and this skill **resolves at most 2 items per run**. The dispatch **omits the model
param** so the resolver inherits the parent session's model (the #1093 fallback): this is
judgment work, and the documented Haiku-premature-exit failure mode (a low-tier model narrates
"standing by" and exits in seconds, files nothing) makes a low tier unsafe here.

## The resolution loop

Read the triage lane, pick the up-to-2 oldest open `wire-or-retire` items, and for **each**:

### 1. Verify first (the ledger / triage snapshot may be a regeneration behind)

- The module path is in the item title (`cleanup(target): wire-or-retire web/src/lib/<path>`).
- Confirm the module still exists on current `main` in `~/hydra-betting` AND still has **no
  runtime importer** — `rg` its import path under `web/src`, excluding test files.
- If the module was wired or removed since the scan, **close this item as stale** (rewrite the
  body to say so; move to `done`) and go to the next item. Do **not** regenerate the ledger.

### 2. Hard carve-out — risk / live-execution modules ALWAYS route ready-for-human

Before recovering intent, check the module path against the carve-out. If the path is under
**`web/src/lib/risk/`** OR is a **live-execution path** (the interim hardcoded list below),
route **`ready-for-human`** immediately and STOP for this item — do not attempt a
wire-vs-retire verdict, do not queue a retirement.

Interim hardcoded carve-out list (until issue **#2701**'s `classifyTargetRisk` exists, at
which point this skill switches to calling it):

- anything under `web/src/lib/risk/`
- anything under `web/src/lib/execution/` (order placement, venue order proofs, fills)
- `web/src/lib/wagers/` record-* modules (money-movement records)

Rationale: retiring or rewiring a money-critical module is an operator-escalation-class
decision (ADR-0005). Ambiguity here is not a judgment call — it is a fail-closed route to a
human. (Target `CLAUDE.md` rule 6: ambiguity never resolves to deletion.)

### 3. Recover the intent

- **`git log --follow`** the module in `~/hydra-betting`: who created it, in which cycle,
  alongside what feature. Read the commit messages of the introducing PR.
- Cross-reference **`~/hydra/config/direction/`** (vision, priorities, roadmap, outcomes): is
  the feature this module belongs to a **current** priority, a **superseded** one, or absent?
- Search the **Target backlog** (`GET /api/backlog`) **open AND done** lanes for the feature:
  a `done` item that superseded / retired the feature is decisive evidence for RETIRE; an
  open queued item that needs this module is decisive evidence for WIRE.
- Note the ADR context: e.g. cross-venue arbitrage was **retired** (hydra-betting ADR-0002);
  a module in `lib/arbitrage/` for cross-venue residual risk is almost certainly RETIRE.

### 4. Decide — exactly one of

- **(a) WIRE** — the intent is live (matches a current `config/direction` priority, or an
  obvious runtime seam exists to wire it into). **Rewrite the item** into a concrete wiring
  task: name the entry point / route / runner to wire the module into, state the acceptance
  criteria ("module is imported from a runtime entry point; `npm test` + `npm run typecheck`
  pass; the wiring-status ledger no longer lists it"). Set labels to **`ready-for-agent`**
  (drop `needs-triage`) and **move the item to `queued`**.
- **(b) RETIRE** — the intent is gone (superseded, venue dropped, experiment concluded).
  **Rewrite the item** into a retirement task: delete the module AND its test file, run
  `npm run deadcode:update-baseline` (refreshes baseline + ledger), commit citing this scan
  (module path, the original scan date from the item body, Target `CLAUDE.md` rule 3). Set
  labels to **`ready-for-agent`** (drop `needs-triage`) and **move the item to `queued`**.
- **(c) UNCLEAR** — the intent cannot be established either way. Set labels to
  **`ready-for-human`** (drop `needs-triage`), **move the item to `blocked`**, and STOP for
  this item. **Ambiguity never resolves to deletion** (Target `CLAUDE.md` rule 6, fail closed).

## The backlog API seam

The Target's tracker is the Redis backlog; go through the API, never the internals.

```bash
# Read the board (triage lane holds the decision queue):
curl -sf http://localhost:4000/api/backlog

# Rewrite an item's title / body / labels (WIRE or RETIRE task, or stale note):
curl -sf -X PATCH http://localhost:4000/api/backlog/<item-id> \
  -H 'content-type: application/json' \
  -d '{"title":"...","description":"...","labels":["ready-for-agent"]}'

# Move the lane (the transition is guarded by #2721 — the ONLY exits from
# triage for a wire-or-retire item are queued and blocked):
curl -sf -X PATCH http://localhost:4000/api/backlog/<item-id>/move \
  -H 'content-type: application/json' \
  -d '{"toLane":"queued"}'    # WIRE / RETIRE
  # or {"toLane":"blocked"} for UNCLEAR (ready-for-human)
```

The lane guard (#2721) rejects `triage → backlog`, returning
`{ok:false, error:"wire-or-retire items leave triage only as a WIRE task, a RETIRE task, or ready-for-human"}`
— if a move is rejected, you tried the wrong exit; re-check the verdict (WIRE/RETIRE → `queued`,
UNCLEAR → `blocked`).

## Report

```
hydra-wire-or-retire — Target (~/hydra-betting) — <ISO>
triage wire-or-retire items open: <N>
resolved this run (cap 2):
• item-685 web/src/lib/compliance/cftc-rulemaking-watch.ts → RETIRE (arbitrage-era, ADR-0002) → queued
• item-687 web/src/lib/opticodds.ts                        → WIRE (odds-ingestion priority live) → queued
skipped: item-6xx web/src/lib/risk/...  → CARVE-OUT → ready-for-human (blocked)
```

## Rules

- **Zero `AskUserQuestion`.** Non-interactive; decide from the evidence or route to a human.
- **At most 2 items per run.** The 24h cooldown + this cap keep the queue draining steadily
  rather than resolving a large batch in one under-examined pass.
- **Verify first.** A stale item (module already wired/removed) is closed as stale, not decided.
- **Risk / live-execution → ready-for-human, always.** The carve-out is checked BEFORE intent
  recovery. Interim hardcoded list until #2701's `classifyTargetRisk`.
- **Ambiguity never resolves to deletion** (Target `CLAUDE.md` rule 6). UNCLEAR is
  `ready-for-human` / `blocked`, never a RETIRE task.
- **Never touch the Target working tree.** This skill reads and rewrites backlog items; the
  module change happens in the follow-up `ready-for-agent` task.
- **One pass, then exit.**

## Manual smoke test

```bash
/hydra-wire-or-retire
```

Expected: reads the Target triage lane, resolves ≤2 open `wire-or-retire` items into
`queued` WIRE/RETIRE tasks (or `blocked` ready-for-human on UNCLEAR / carve-out), leaves the
rest for the next 24h tick, and reports the verdicts. A triage lane with no open
`wire-or-retire` items is a no-op (the `wire_or_retire_target_available` signal is false, so
the autopilot never dispatches this in the first place).
