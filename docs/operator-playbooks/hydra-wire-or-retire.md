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
`needs-triage` Redis backlog items for Target modules that are past the
45-day wiring grace with no runtime importer — modules Hydra built with intent that either
stalled (wire it) or died (retire it). Those items are the **decision queue**; deciding which
requires **recovering the intent**, which a static tool cannot do. This skill makes the call.

The prompt-shaped resolver protocol is drafted inside each item's body. Under ADR-0031 the
Target decision queue is the **GitHub-Issues board on the Target repo** (`$TARGET_GH_REPO`): an
open issue carrying **`wire-or-retire` + `needs-triage`**. The only exits are a WIRE/RETIRE
`ready-for-agent` task (relabel) or a `ready-for-human` operator hand-off (relabel) — there is
no destructive lane. (The retired Redis `moveItemToLane` `triage → backlog` guard of issue
**#2721** is subsumed: on the label board there is no `backlog` lane to launder an item into,
so the label-only exits are the whole state machine.) This skill is issue **#2722**: the class
that *dispatches a resolver* so the queue actually drains.

## Resolve the Target seam (run this first)

@include _fragments/target-seam-preamble.md

## What it is vs. what it is not

| | `/hydra-target-cleanup` (mechanical) | `/hydra-wire-or-retire` (judgment) |
|---|---|---|
| Input | knip report + wiring-status ledger | the open `wire-or-retire` + `needs-triage` issues on `$TARGET_GH_REPO` |
| Decision | deterministic (demote-only, self-checking) | an **opinion** — recover intent, then decide |
| Output | `ready-for-agent` demote issues | per issue: a rewritten WIRE/RETIRE task relabelled `ready-for-agent`, OR relabelled `ready-for-human` |
| Deletes anything? | never | never (it rewrites items into tasks; the *follow-up* task may delete) |
| Cadence | 1h (`target_backfill_idle`) | 24h (`wire_or_retire_target_available`) |

This skill **never edits the Target working tree** and **never deletes a module**. It only
reads (`git log`, `rg`, config/direction, the board) and **rewrites the anchor issue** into the
next actionable task via `gh issue edit` (body + labels) on `$TARGET_GH_REPO` — never
the retired Redis `/backlog` API. The deletion, if any, happens later inside the
`ready-for-agent` retirement task a human/agent picks up.

## Trigger

Dispatched by the autopilot `wire_or_retire_target` signal class (issue #2722) when
`collect-state.sh` emits **`wire_or_retire_target_available`** — true when ≥1 open issue
carrying **`wire-or-retire` + `needs-triage`** sits on the Target board
(`$TARGET_GH_REPO`). The class carries a
**24h cooldown** (`SIGNAL_COOLDOWNS["wire_or_retire_target"]`, seeded in `bootstrap.sh`'s
`signal_last_fired` so it survives the pace-gate relaunch — the #2575 cooldown-bootstrap bug
class), and this skill **resolves at most 2 items per run**. The dispatch **omits the model
param** so the resolver inherits the parent session's model (the #1093 fallback): this is
judgment work, and the documented Haiku-premature-exit failure mode (a low-tier model narrates
"standing by" and exits in seconds, files nothing) makes a low tier unsafe here.

## The resolution loop

Read the board (`gh api repos/$TARGET_GH_REPO/issues?state=open&labels=wire-or-retire,needs-triage`
— REST comma is AND, so this requires **co-presence** of both labels, never `gh --json`/GraphQL,
ADR-0031 Decision 6), pick the up-to-2 oldest open matching issues, and for **each**
(`$ANCHOR_NUM` = its issue number):

Co-presence is required, not optional: the resolver's own UNCLEAR verdict (step 4c below) and
risk carve-out (step 2 below) both *remove* `needs-triage` while *deliberately keeping*
`wire-or-retire` so the operator can see the decision class. Filtering on the `wire-or-retire`
label in isolation would re-match that already-adjudicated output forever, re-picking items this
skill has already resolved. Requiring `needs-triage` too makes this skill the sole legitimate
retirer of the pairing and stops it from re-selecting its own prior output.

### 1. Verify first (the ledger / triage snapshot may be a regeneration behind)

- The module path is in the item title (`cleanup(target): wire-or-retire <path under $TARGET_APP_DIR>`).
- Confirm the module still exists on current `main` in `$TARGET_WS` AND still has **no
  runtime importer** — `rg` its import path under `$TARGET_APP_DIR`, excluding test files.
- If the module was wired or removed since the scan, **close this issue as stale**
  (`gh issue close $ANCHOR_NUM --repo $TARGET_GH_REPO --reason completed --comment "Stale — module wired/removed since scan."`)
  and go to the next item. Do **not** regenerate the ledger.

### 2. Hard carve-out — risk / live-execution modules ALWAYS route ready-for-human

Before recovering intent, check the module path against **`prompt_args.risk_carveout`** — the
list the autopilot dispatch stamped from `$TARGET_RISK_SURFACE_JSON` (the Target Manifest's
`riskCritical.surface`, ADR-0026, resolved fresh every turn by
`scripts/target/print-target-facts.ts`; issue #4411). A module path matches the carve-out when
it is prefixed by (or equals) any entry in the list. If it matches — or if `risk_carveout` is
**missing or empty** (the dispatch's fail-closed default when the Target Manifest could not be
resolved, issue #4411 Invariant 4) — relabel **`ready-for-human`** immediately
(`gh issue edit $ANCHOR_NUM --repo $TARGET_GH_REPO --remove-label needs-triage --add-label ready-for-human`)
and STOP for this item — do not attempt a wire-vs-retire verdict, do not queue a retirement.

There is no hardcoded fallback list: an absent/empty `risk_carveout` is itself carve-out
evidence (over-routing to a human is safe, under-routing is not), never a signal to fall through
to intent-recovery. `classifyTargetRisk` (issue #2701) is exactly `riskCritical.surface`
declared by the target's own manifest — the carve-out this skill matches against IS that surface,
not a copy of it.

Rationale: retiring or rewiring a money-critical module is an operator-escalation-class
decision (ADR-0005). Ambiguity here is not a judgment call — it is a fail-closed route to a
human. (Target `CLAUDE.md` rule 6: ambiguity never resolves to deletion.)

### 3. Recover the intent

- **`git log --follow`** the module in `$TARGET_WS`: who created it, in which cycle,
  alongside what feature. Read the commit messages of the introducing PR.
- Cross-reference **`~/hydra/config/direction/`** (vision, priorities, roadmap, outcomes) AND
  the target's own **`$TARGET_WS/CONTEXT.md`** / **`$TARGET_WS/direction/vision.md`** (the
  domain angles and feature history live there, not in this playbook): is
  the feature this module belongs to a **current** priority, a **superseded** one, or absent?
- Search the **Target board** (`gh issue list --repo $TARGET_GH_REPO --search "<feature>" --state all`)
  across **open AND closed** issues for the feature: a **closed** issue that superseded / retired
  the feature is decisive evidence for RETIRE; an open `ready-for-agent` issue that needs this
  module is decisive evidence for WIRE. (Lexical search — REST-first, never `gh --json`/GraphQL.)
- Read the target's own ADR history (`$TARGET_WS/docs/adr/`) for a supersession decision that
  bears on this module — a feature area the target's own ADRs record as retired is strong
  RETIRE evidence.

### 4. Decide — exactly one of

All three exits are `gh issue edit` label + body edits on `$TARGET_GH_REPO` — never a
Redis lane move. Drop **both** `needs-triage` and `wire-or-retire` on a WIRE/RETIRE resolution
(the decision is made — the issue is now an actionable task, not a pending decision).

- **(a) WIRE** — the intent is live (matches a current `config/direction` priority, or an
  obvious runtime seam exists to wire it into). **Rewrite the issue body** into a concrete wiring
  task: name the entry point / route / runner to wire the module into, state the acceptance
  criteria ("module is imported from a runtime entry point; the target's test + typecheck
  commands (`$TARGET_WS/.hydra/manifest.json`'s `verify.test` / `verify.typecheck`) pass; the
  wiring-status ledger no longer lists it"). Then:
  `gh issue edit $ANCHOR_NUM --repo $TARGET_GH_REPO --body-file <task> --remove-label needs-triage --remove-label wire-or-retire --add-label ready-for-agent`.
- **(b) RETIRE** — the intent is gone (superseded, dropped, experiment concluded).
  **Rewrite the issue body** into a retirement task using the **standard RETIRE-task body template**
  below (delete the module AND its test files, sweep orphaned imports, run
  the target's deadcode-baseline update, verify with the target's real test suite + typecheck,
  commit citing the scan per Target `CLAUDE.md` rule 3). Then:
  `gh issue edit $ANCHOR_NUM --repo $TARGET_GH_REPO --body-file <task> --remove-label needs-triage --remove-label wire-or-retire --add-label ready-for-agent`.
- **(c) UNCLEAR** — the intent cannot be established either way. Relabel to **`ready-for-human`**
  (drop `needs-triage`; keep `wire-or-retire` so the operator sees the decision class):
  `gh issue edit $ANCHOR_NUM --repo $TARGET_GH_REPO --remove-label needs-triage --add-label ready-for-human`,
  and STOP for this item. **Ambiguity never resolves to deletion** (Target `CLAUDE.md` rule 6, fail closed).

## Standard RETIRE-task body template (issue #2723)

When step 4(b) rewrites an item into a RETIRE task, use the template below verbatim as the
item's description (substituting the bracketed values). It is the **only sanctioned deletion
path** in the Target — it exists so `hydra-target-build` executes the deletion *safely*:
deleting a module without sweeping its now-orphaned imports leaves the build red, and verifying
against the wrong test script gives a false green. Both are documented Target failure modes the
template forecloses.

The template also encodes the two hard preconditions from this playbook: a RETIRE task is only
ever written for a module that **passed the carve-out** (step 2 — nothing matching
`prompt_args.risk_carveout` ever receives a RETIRE task; those route
`ready-for-human`), and only after the module was
**verified still dead** (step 1 — exists on `main`, no runtime importer). Do not emit this
template for a module that failed either check.

```markdown
## RETIRE: delete `[<path under $TARGET_APP_DIR>]`

Verdict from `/hydra-wire-or-retire` ([ISO date]): the intent behind this module is gone
([one-line reason — cite the target's own ADR/vision history that superseded it]). Retire it.

### Preconditions (already checked by the resolver — do NOT re-decide)
- NOT a risk-carve-out path (rule 1 carve-out passed): the module does not match any entry in
  `prompt_args.risk_carveout` (the Target Manifest's `riskCritical.surface`).
  If your deletion would touch such a path, STOP and route ready-for-human — carve-out paths
  NEVER receive a RETIRE task.
- Verified still dead on current `main`: the module exists and has no runtime importer
  (test-only importers do not count).

### Steps
1. **Delete the module AND its test file(s).** Remove `[<path>]` and every
   co-located test that exercises only it (e.g. `[<path>.test.ts]`,
   `[<path>.spec.ts]`). A test that also exercises surviving code stays — excise only the
   deleted module's cases from it.
2. **Sweep orphaned imports.** Deleting the module orphans every `import` of it. **Both `knip`
   and `tsc` miss these** — `knip` reports unused *exports/files*, not the dangling *import
   statements* left behind, and `tsc` with `noUnusedLocals` off does not flag a now-unused
   import (documented lesson: cleanup-leaves-orphaned-imports / "Cleanup leaves orphaned
   imports"). So sweep them by hand: `rg` the deleted module's import path across
   `$TARGET_APP_DIR`, remove each dead `import` line, and remove any symbol that was only used
   to call into the deleted module.
3. **Tighten the ratchet + regenerate the ledger.** Run the target's deadcode-baseline update
   command (per its own `docs/agents/domain.md` or `package.json` scripts). This tightens the
   baseline (it must end up strictly smaller — a retirement that does not shrink it did not
   actually remove dead code) AND regenerates the wiring-status ledger so this module no longer
   appears in the wire-or-retire queue.
4. **Verify with the REAL suite + typecheck.** Run the target's manifest-declared `verify.test`
   and `verify.typecheck` commands (`$TARGET_WS/.hydra/manifest.json`) — read the manifest
   rather than assuming a specific script name; some targets alias a `test` script to a count-gate
   plus a handful of sentinels rather than the real suite (a documented failure mode on the prior
   Target), so the manifest's declared command is the one that is actually the merge gate.
5. **Commit citing the scan (Target `CLAUDE.md` rule 3).** The commit message MUST cite the
   deadcode scan that justified the deletion: the module path, the original scan date from this
   item's body ([ISO date]), and this RETIRE verdict. Example:
   `chore(deadcode): retire <path> — dead since <scan-date> scan, wire-or-retire RETIRE (item-<N>)`.

### Acceptance criteria
- [ ] `[<path>]` and its test file(s) are deleted — verified by:
      `git diff --name-only origin/main...HEAD` lists them under deletions.
- [ ] No orphaned imports remain — verified by: `rg "<deleted-import-path>" "$TARGET_APP_DIR"` returns no
      hits, and the manifest's `verify.typecheck` command exits 0.
- [ ] The deadcode baseline is strictly smaller and the wiring ledger is regenerated —
      verified by: the baseline diff shows a net reduction.
- [ ] The manifest's `verify.test` and `verify.typecheck` commands pass — verified by: both exit 0.
- [ ] Commit message cites the scan (module path + scan date) per Target `CLAUDE.md` rule 3.
```

**Why this is the only sanctioned deletion path (rule 1 restated).** Any path matching
`prompt_args.risk_carveout` **NEVER** receives a RETIRE
task — a deletion touching such a path is an operator-escalation-class decision (ADR-0005),
so those modules route `ready-for-human` at step 2 and this template is never emitted for them.
The template's precondition block re-states that carve-out so the follow-up
`hydra-target-build` dispatch fails closed if a deletion would stray into a carve-out path.

> **Cross-ref follow-up (out of scope of issue #2723 — different repo).** The Target's own
> `CLAUDE.md` should cross-reference this template as the only sanctioned
> deletion path. That edit lives in the target repo and is intentionally NOT made in
> this orchestrator PR. Tracked as a follow-up Target-repo change.

## The `gh`-write seam (ADR-0031)

The Target's tracker is the **GitHub-Issues board on `$TARGET_GH_REPO`**; all reads
and writes go through `gh` (REST-first, never `gh --json`/GraphQL on the hot path).

```bash
REPO="$TARGET_GH_REPO"

# Read the decision queue (open wire-or-retire + needs-triage issues) — REST:
gh api "repos/$REPO/issues?state=open&labels=wire-or-retire,needs-triage&per_page=100" \
  --jq '.[] | select(has("pull_request")|not) | "#\(.number)\t\(.title)"'

# Rewrite an issue's body + labels (WIRE or RETIRE task):
gh issue edit "$ANCHOR_NUM" --repo "$REPO" --body-file <task> \
  --remove-label needs-triage --remove-label wire-or-retire --add-label ready-for-agent

# UNCLEAR → operator hand-off (keep wire-or-retire so the class is visible):
gh issue edit "$ANCHOR_NUM" --repo "$REPO" \
  --remove-label needs-triage --add-label ready-for-human

# Stale (module wired/removed since the scan) → close as completed:
gh issue close "$ANCHOR_NUM" --repo "$REPO" --reason completed \
  --comment "Stale — module wired/removed since scan."
```

The only exits are a WIRE/RETIRE `ready-for-agent` task, a `ready-for-human` operator hand-off,
or a stale close — enforced by the label vocabulary itself (there is no `backlog` lane to
launder an item into, which is what the retired Redis lane guard #2721 protected against).

## Report

```
hydra-wire-or-retire — Target ($TARGET_WS) — <ISO>
triage wire-or-retire items open: <N>
resolved this run (cap 2):
• #<N> <path-a> → RETIRE (<one-line reason>) → ready-for-agent
• #<N> <path-b> → WIRE (<one-line reason>) → ready-for-agent
skipped: #<N> <carve-out path>  → CARVE-OUT → ready-for-human
```

## Rules

- **Zero `AskUserQuestion`.** Non-interactive; decide from the evidence or route to a human.
- **At most 2 items per run.** The 24h cooldown + this cap keep the queue draining steadily
  rather than resolving a large batch in one under-examined pass.
- **Verify first.** A stale item (module already wired/removed) is closed as stale, not decided.
- **Risk / live-execution → ready-for-human, always.** The carve-out (`prompt_args.risk_carveout`,
  sourced from the Target Manifest's `riskCritical.surface`) is checked BEFORE intent
  recovery; missing/empty is itself carve-out evidence (fail closed).
- **Ambiguity never resolves to deletion** (Target `CLAUDE.md` rule 6). UNCLEAR is
  `ready-for-human`, never a RETIRE task.
- **Never touch the Target working tree.** This skill reads and relabels/rewrites board issues
  via `gh`; the module change happens in the follow-up `ready-for-agent` task.
- **REST-first reads (ADR-0031 Decision 6).** Board reads use `gh api repos/...` / `gh issue list --search`, never `gh --json`/GraphQL.
- **One pass, then exit.**

## Manual smoke test

```bash
/hydra-wire-or-retire
```

Expected: reads the Target board (open `wire-or-retire` + `needs-triage` issues), resolves ≤2
into `ready-for-agent` WIRE/RETIRE tasks (or `ready-for-human` on UNCLEAR / carve-out), leaves
the rest for the next 24h tick, and reports the verdicts. A board with no open `wire-or-retire`
issues is a no-op (the `wire_or_retire_target_available` signal is false, so the autopilot never
dispatches this in the first place).

## Dispatch wiring

Dispatched by the autopilot `wire_or_retire_target` signal class on the
`wire_or_retire_target_available` signal, at a 24h cooldown. Tracked by issue
#2722 under epic #2720. Issues are filed with `wire-or-retire` + `needs-triage` on the Target
board by `/hydra-target-cleanup`; this skill resolves at most 2 per run.
