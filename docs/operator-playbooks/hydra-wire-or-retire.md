---
name: hydra-wire-or-retire
description: Non-interactive resolver that turns the Target's open wire-or-retire decision items into WIRE, RETIRE, or UNCLEAR verdicts, recovering intent from git history and vision docs; risk and live-execution modules always route to a human, and ambiguity never deletes.
when_to_use: "When the Target triage lane holds open wire-or-retire decision items, or the operator says 'resolve wire-or-retire' or 'make the wiring decisions'."
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
  **Rewrite the item** into a retirement task using the **standard RETIRE-task body template**
  below (delete the module AND its test files, sweep orphaned imports, run
  `npm run deadcode:update-baseline`, verify with `npm run test:raw` + typecheck, commit citing
  the scan per Target `CLAUDE.md` rule 3). Set labels to **`ready-for-agent`** (drop
  `needs-triage`) and **move the item to `queued`**.
- **(c) UNCLEAR** — the intent cannot be established either way. Set labels to
  **`ready-for-human`** (drop `needs-triage`), **move the item to `blocked`**, and STOP for
  this item. **Ambiguity never resolves to deletion** (Target `CLAUDE.md` rule 6, fail closed).

## Standard RETIRE-task body template (issue #2723)

When step 4(b) rewrites an item into a RETIRE task, use the template below verbatim as the
item's description (substituting the bracketed values). It is the **only sanctioned deletion
path** in the Target — it exists so `hydra-target-build` executes the deletion *safely*:
deleting a module without sweeping its now-orphaned imports leaves the build red, and verifying
against the wrong test script gives a false green. Both are documented Target failure modes the
template forecloses.

The template also encodes the two hard preconditions from this playbook: a RETIRE task is only
ever written for a module that **passed the carve-out** (step 2 — nothing under
`web/src/lib/risk/`, `web/src/lib/execution/`, or the money-movement record modules ever
receives a RETIRE task; those route `ready-for-human`), and only after the module was
**verified still dead** (step 1 — exists on `main`, no runtime importer). Do not emit this
template for a module that failed either check.

```markdown
## RETIRE: delete `[web/src/lib/<path>.ts]`

Verdict from `/hydra-wire-or-retire` ([ISO date]): the intent behind this module is gone
([one-line reason — e.g. "cross-venue arbitrage retired, hydra-betting ADR-0002"]). Retire it.

### Preconditions (already checked by the resolver — do NOT re-decide)
- NOT a protected-provider / risk / live-execution path (rule 1 carve-out passed): the module
  is not under web/src/lib/risk/, web/src/lib/execution/, web/src/lib/providers/, or a
  web/src/lib/wagers/ record-* module. If your deletion would touch any of those, STOP and route
  ready-for-human — protected paths NEVER receive a RETIRE task.
- Verified still dead on current `main`: the module exists and has no runtime importer
  (test-only importers do not count).

### Steps
1. **Delete the module AND its test file(s).** Remove `[web/src/lib/<path>.ts]` and every
   co-located test that exercises only it (e.g. `[web/src/lib/<path>.test.ts]`,
   `[<path>.spec.ts]`). A test that also exercises surviving code stays — excise only the
   deleted module's cases from it.
2. **Sweep orphaned imports.** Deleting the module orphans every `import` of it. **Both `knip`
   and `tsc` miss these** — `knip` reports unused *exports/files*, not the dangling *import
   statements* left behind, and `tsc` with `noUnusedLocals` off does not flag a now-unused
   import (documented lesson: cleanup-leaves-orphaned-imports / "Cleanup leaves orphaned
   imports"). So sweep them by hand: `rg` the deleted module's import path across `web/src`,
   remove each dead `import` line, and remove any symbol that was only used to call into the
   deleted module.
3. **Tighten the ratchet + regenerate the ledger.** Run `npm run deadcode:update-baseline`.
   This tightens `deadcode-baseline.json` (the baseline must end up strictly smaller — a
   retirement that does not shrink it did not actually remove dead code) AND regenerates the
   wiring-status ledger so this module no longer appears in the wire-or-retire queue.
4. **Verify with the REAL suite + typecheck.** Run `npm run test:raw` and `npm run typecheck`.
   NOTE: bare `npm test` in the Target `web/` is a count-gate plus 3 named sentinels, NOT the
   suite (documented lesson: "In `~/hydra-betting/web`, `npm test` is a count-gate + 3
   sentinels, NOT the full suite — the real suite is `test:raw`"). `npm run test:raw`
   (`vitest run --config ./vitest.config.ts --dir ./src`) is the actual full vitest suite; a
   green bare `npm test` proves nothing about the untested modules a deletion can break. Let CI's
   vitest job be the merge gate.
5. **Commit citing the scan (Target `CLAUDE.md` rule 3).** The commit message MUST cite the
   deadcode scan that justified the deletion: the module path, the original scan date from this
   item's body ([ISO date]), and this RETIRE verdict. Example:
   `chore(deadcode): retire web/src/lib/<path> — dead since <scan-date> scan, wire-or-retire RETIRE (item-<N>)`.
6. **Purge the retired module from the OpenViking index (POST-MERGE hygiene — issue #2729).**
   Deleting the module from the repo does NOT remove it from the OV semantic index, so a future
   cycle grounding against OV still gets a high-confidence hit on the retired concept and can
   re-derive the very thing this RETIRE deleted. The OV container is not recreated on
   `deploy.sh`, so the live index survives the merge and MUST be purged explicitly. After the PR
   **merges** (not before — the module must actually be gone from `main`), run the hygiene script
   once, keyed on the same repo-relative module path:
   `bash scripts/ov-retire-hygiene.sh --path web/src/lib/<path>.ts --concept "[one-line concept — e.g. cross-venue arbitrage residual risk]"`.
   The script maps the path to its OV URI (`viking://resources/<path>`, per
   src/knowledge-base/indexer.ts), DELETEs that entry (semantic-queue purge), then re-queries the
   concept to confirm the index no longer surfaces the retired path as live content. It is a
   one-shot post-merge step, NOT a poller — the merge that removed the module is the trigger. Exit
   0 = index clean; exit 2 = an entry survived the purge (a re-index re-added it — investigate the
   OV semantic queue and re-run). This step runs unattended: no interactive prompts, and OV
   unreachable exits 1 without touching the repo.

### Acceptance criteria
- [ ] `[web/src/lib/<path>.ts]` and its test file(s) are deleted — verified by:
      `git diff --name-only origin/main...HEAD` lists them under deletions.
- [ ] No orphaned imports remain — verified by: `rg "<deleted-import-path>" web/src` returns no
      hits, and `npm run typecheck` exits 0.
- [ ] `deadcode-baseline.json` is strictly smaller and the wiring ledger is regenerated —
      verified by: `git diff deadcode-baseline.json` shows a net reduction after
      `npm run deadcode:update-baseline`.
- [ ] `npm run test:raw` and `npm run typecheck` pass — verified by: both commands exit 0.
- [ ] Commit message cites the scan (module path + scan date) per Target `CLAUDE.md` rule 3.
- [ ] OV index purged POST-MERGE — verified by:
      `bash scripts/ov-retire-hygiene.sh --path web/src/lib/<path>.ts --concept "<concept>"` exits 0
      (no live index entry for the retired path remains).
```

**Why this is the only sanctioned deletion path (rule 1 restated).** Protected-provider paths
(and the risk / live-execution / money-movement carve-out of step 2) **NEVER** receive a RETIRE
task — a deletion under `web/src/lib/providers/`, `web/src/lib/risk/`, `web/src/lib/execution/`,
or a `web/src/lib/wagers/` record-* module is an operator-escalation-class decision (ADR-0005),
so those modules route `ready-for-human` at step 2 and this template is never emitted for them.
The template's precondition block re-states that carve-out so the follow-up
`hydra-target-build` dispatch fails closed if a deletion would stray into a protected path.

> **Cross-ref follow-up (out of scope of issue #2723 — different repo).** Target
> `CLAUDE.md` (in `hydra-betting`) should cross-reference this template as the only sanctioned
> deletion path. That edit lives in the `hydra-betting` repo and is intentionally NOT made in
> this orchestrator PR (see the issue's "Related (Target repo)" note). Tracked as a follow-up
> Target-repo change.

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

## Dispatch wiring

Dispatched by the autopilot `wire_or_retire_target` signal class on the
`wire_or_retire_target_available` signal, at a 24h cooldown. Tracked by issue
#2722 under epic #2720. Items are filed into the Target triage lane by
`/hydra-target-cleanup`; this skill resolves at most 2 per run.
