---
name: hydra-architecture-scan
description: Non-interactive architecture-scan wrapper. Runs the improve-codebase-architecture skill's Explore + Present-candidates phases (steps 1–2 only) against the Orchestrator and emits the surfaced deepening candidates as GitHub issues via hydra-prd / to-issues — never entering the interactive operator grilling loop.
when_to_use: "When the Orchestrator's hydra-autopilot runs out of eligible work and wants to turn idle capacity into self-improvement by surfacing architecture-deepening candidates as tracked issues, or when the operator says 'architecture scan', '/hydra-architecture-scan', or 'find architecture work'. Phase A (issue #788) is the headless wrapper skill; the autopilot `architecture_orch` signal class that dispatches it is wired by #789/#790/#791."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Task(*)
arguments: [apply]
claude_only: true
---

# Hydra Architecture Scan (headless deepening wrapper)

`hydra-architecture-scan` is the **non-interactive** twin of the upstream `improve-codebase-architecture` skill. It runs that skill's first two phases — **Explore** and **Present candidates** — against the **Orchestrator** (`~/hydra`), then emits the surfaced deepening candidates as GitHub issues on `gaberoo322/hydra` instead of dropping into the interactive grilling loop. The interactive skill is left **completely untouched**: it cannot be dispatched unattended (its step 3 grilling loop and its inline `CONTEXT.md`/ADR side-effects both require an operator), so this wrapper exists to give the autopilot a headless entry point that produces tracked work rather than asking questions.

This is the gating build artifact (issue #788) for the `architecture_orch` epic (#787): an issue-producing idle fallback that turns wasted autopilot idle capacity (post-#762, the per-run budget is 10M tokens) into self-improvement, in line with the 25% self-improvement floor (ADR-0003) and the operator's stated preference for maintainability over throughput.

The design deliberately **mirrors `hydra-tool-scout`** (the `scout_orch` precedent this epic copies): a depth-first pass over one surface, a filter to keep the issue count sane, structured GitHub issues labelled `needs-triage`, and **no auto-route to `ready-for-agent`**. The operator (or `/hydra-sweep` triage) is the accept point. Because the fallback only produces issues, no merge happens at fallback time, and the existing tier classifier + Untouchable Core (ADR-0001/0004) apply unchanged when the produced issues are later picked up — no new **Modification Tier** carve-out is required.

## What this skill is NOT

- **NOT a modification of `improve-codebase-architecture`.** That skill stays interactive and operator-facing. This wrapper re-uses its **Explore** and **Present candidates** phases (steps 1–2) by following the same process, then diverts to issue emission instead of running its step-3 grilling loop. Do not edit the upstream skill, its `LANGUAGE.md`, `INTERFACE-DESIGN.md`, or `DEEPENING.md`.
- **NOT a code-writer.** It never opens a PR, never edits `src/`, never runs the deepening refactor. It surfaces candidates and files issues. Implementation is a later `hydra-dev` dispatch against a triaged issue.
- **NOT an interactive skill.** **Zero `AskUserQuestion` calls.** The upstream skill's step 2 ends with *"Which of these would you like to explore?"* and step 3 is a grilling conversation — this wrapper does neither. It presents the candidates into issue bodies and stops.
- **NOT the autopilot wiring.** The `architecture_orch` signal class, the `arch_fallback_due` / `arch_board_saturated` state signals, `decide.py`, and the autopilot taxonomy table are out of scope here — they land in #789 / #790 / #791. This playbook is the wrapper skill only.

## When NOT to run this

- **When the Orchestrator issue board is already saturated** with deepening-grade proposal issues. Mirror the scout's discipline: if there are already > 10 open issues carrying the `architecture-scan` label (or the board has > 20 open `enhancement` issues generally), **emit nothing** and print a board-saturation skip. The downstream `arch_board_saturated` signal (#789) will be the autopilot's hard suppressor; this in-skill check is a belt-and-braces back-stop so a manual run never floods the board.
- **From inside a `dev_orch` / `dev_target` subagent.** Those work a single issue and must not produce sibling work. This wrapper belongs to the autopilot parent context or a manual operator invocation, same as `hydra-prd`.
- **Against the Target (`~/hydra-betting`).** This wrapper is **Orchestrator-scoped** (`~/hydra`) by design — the epic is about the autopilot improving itself. A target-scoped architecture scan would be a separate skill.

## Inputs

| Input | Source | Notes |
|---|---|---|
| `apply` (positional / `--apply`) | Operator or autopilot dispatch | Dry-run by default. `--apply` (or `apply=true`) actually creates issues on `gaberoo322/hydra`. A dry-run is always safe — it prints the candidates and the rendered issue bodies and stops. |
| Scan surface | Implicit | Always the **Orchestrator** repo at `~/hydra`. Not parameterised — see "When NOT to run this". |
| Open-issue board | `gh issue list` | Read before emitting, for the board-saturation back-stop. |

## Process

The first two steps **are** `improve-codebase-architecture` steps 1–2, run verbatim against the Orchestrator. Steps 3–5 are the headless divergence: filter, emit, report — replacing the upstream skill's interactive step 3.

### 1. Explore (= improve-codebase-architecture step 1)

Read the Orchestrator's domain glossary and ADRs first so candidates are named in the project's vocabulary:

- `~/hydra/CONTEXT.md` — the canonical glossary (Target, Orchestrator, Untouchable Core, Pre-merge Gate, Modification Tier, Outcome Holdback, Operator-Required Intervention). Use these terms exactly.
- `~/hydra/docs/adr/` — architectural decision records. **Do not re-litigate a decided ADR.** A candidate may only contradict an ADR when the friction is real enough to warrant reopening it, and then it must say so explicitly (`contradicts ADR-NNNN — but worth reopening because …`).

Then use the **Agent tool with `subagent_type=Explore`** to walk `~/hydra/src/`, `~/hydra/dashboard/src/`, and `~/hydra/scripts/`. Explore organically — note where you experience friction, following the upstream skill's prompts:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting the module concentrate complexity, or just move it? A "yes, concentrates" is the signal worth filing.

> **Quota:** like the scout's 5-candidate discovery quota, aim for **3–6** strong candidates. If the codebase is genuinely clean in the area explored, file fewer (or none) and say so — do not pad with theoretical refactors.

### 2. Present candidates (= improve-codebase-architecture step 2)

Assemble a numbered list of deepening opportunities. For each candidate, capture exactly the upstream fields:

- **Files** — which files/modules are involved (concrete paths under `~/hydra`).
- **Problem** — why the current architecture is causing friction.
- **Solution** — plain-English description of what would change. **Do NOT propose interfaces or write code** — the upstream skill defers interface design to its step 3, and this wrapper never runs step 3.
- **Benefits** — explained in terms of **locality** and **leverage**, and in how tests would improve (the interface is the test surface).

Use **`CONTEXT.md` vocabulary for the domain** and **`improve-codebase-architecture/LANGUAGE.md` vocabulary for the architecture** (Module, Interface, Implementation, Depth, Seam, Adapter, Leverage, Locality). Name the deepened module after a real domain concept, not a coined `FooHandler`.

This is where the upstream skill would ask *"Which of these would you like to explore?"*. **This wrapper does not ask.** Every surviving candidate becomes issue input in step 4.

### 3. Filter (keep the issue count honest)

Drop a candidate before it becomes an issue when ANY of:

- It touches the **Untouchable Core** (`src/untouchable.ts` protected paths: merge gate, rollback, watchdog, cost guardrails) as its *primary* change. Those are operator-only (ADR-0001/0004) and an architecture-scan issue should not steer an agent at them. Note the friction in the report, but do not file it as a deepening issue.
- It duplicates an already-open issue carrying the `architecture-scan` label (read the board in step 0/§"When NOT to run this"). Re-filing the same deepening candidate every idle tick is the exact failure `hydra-tool-scout`'s seen-list guards against; here the lightweight equivalent is a title/scope match against open `architecture-scan` issues.
- It fails the **deletion test** (deleting the module would just move complexity, not concentrate it) — that means it was a genuine pass-through and there is nothing to deepen.

### 4. Emit issues (via hydra-prd or to-issues — labelled `needs-triage`)

Turn the surviving candidates into GitHub issues. Two emission paths, pick by candidate count:

- **≥ 3 related candidates → `hydra-prd`.** Build a `PrdInput` JSON (see `docs/operator-playbooks/hydra-prd.md`) where each candidate is one slice: `whatToBuild` = the **Solution**, `acceptanceCriteria` from the **Benefits** (e.g. "the X module is testable through its interface", "npm test passes"), `filesInScope` = the candidate's **Files**, and `filesOutOfScope` listing the Untouchable Core. Invoke `hydra-prd --apply --input=/tmp/arch-scan-prd.json`. It produces one parent epic + N children, each stamped `Expected tier: N` from `/api/tier`, and parseable by `hydra-epic-close`. **Override the child label**: `hydra-prd` defaults children to `ready-for-agent` — for architecture-scan output the children MUST be `needs-triage` instead (see the labelling rule below). If `hydra-prd` cannot override the child label in your invocation, fall back to the `to-issues` path so nothing is auto-routed to `ready-for-agent`, then re-label any children with `gh issue edit --add-label needs-triage --remove-label ready-for-agent`.
- **1–2 standalone candidates → `to-issues`** (or a direct `gh issue create`). Each candidate becomes one issue using the body schema below.

Issue body schema (one per candidate):

```markdown
# architecture-scan: <deepening candidate title>

> Surfaced by `/hydra-architecture-scan` on <ISO date> against the Orchestrator (~/hydra).
> Explore + Present-candidates phases of `improve-codebase-architecture` (steps 1–2), headless.

## Files

<concrete paths under ~/hydra that this deepening touches>

## Problem

<why the current architecture is causing friction — in CONTEXT.md + LANGUAGE.md vocabulary>

## Solution (plain English — no interface design yet)

<what would change. Deliberately NOT an interface proposal: the upstream skill
defers interface design to its step-3 grilling loop, which a triaged pickup
(operator running /improve-codebase-architecture, or a hydra-grill design-concept)
will run.>

## Benefits (locality + leverage + tests)

- Locality: <change/bugs/knowledge concentrate where?>
- Leverage: <what do callers get from the deepened interface?>
- Tests: <how does the interface-as-test-surface improve?>

## Deletion test

<applied: deleting <module> would concentrate complexity across N callers — so it earns its keep / is worth deepening>

## Files out of scope

<the Untouchable Core (src/untouchable.ts protected paths) + anything this candidate must not touch>

---
*Generated by hydra-architecture-scan (Phase A, issue #788). Needs operator/triage review before pickup.*
```

**Labelling rule (HARD):** every emitted issue carries `enhancement`, `needs-triage`, and `architecture-scan`. **NEVER `ready-for-agent`.** The architecture-scan fallback produces *candidate* work; the operator (or `/hydra-sweep` triage) is the accept point. Auto-routing a self-generated deepening straight to `ready-for-agent` would let the autopilot dispatch a refactor it invented against itself with no human checkpoint — exactly the loop the `needs-triage` gate exists to break.

### 5. Report (deterministic summary)

Print a single-pass summary — this is the operator's accept/reject surface:

```
hydra-architecture-scan — Orchestrator (~/hydra) — 2026-05-31T19:32:00Z — apply

Explored:  src/, dashboard/src/, scripts/
Candidates surfaced:  5
After filter (untouchable/dup/deletion-test):  3
Emitted:  1 epic (#NNN) + 3 children (#NNN, #NNN, #NNN)  [needs-triage]
Dropped:  2  (1 touches Untouchable Core; 1 failed deletion test)
Board saturation:  ok (4 open architecture-scan issues, under the 10 cap)
```

In dry-run mode the header reads `(dry-run; no GitHub issues created)` and the emitted line shows the rendered bodies instead of issue numbers. This is one pass: the skill does not poll, retry, or watch.

## Rules

- **Zero `AskUserQuestion`.** This is the decisive constraint the research (#776) found — the interactive skill cannot run unattended. This wrapper presents candidates into issue bodies and stops; it never asks the operator to pick one.
- **Do NOT modify `improve-codebase-architecture`.** Re-use its Explore + Present-candidates process; never edit the upstream skill or its bundled docs.
- **Issues land in `needs-triage`, never `ready-for-agent`.** The operator/triage is the accept point. No self-dispatch of self-invented refactors.
- **Orchestrator-scoped.** Always `~/hydra`. Not parameterised to the Target.
- **Steps 1–2 only.** Never run the upstream skill's step-3 grilling loop, and never propose concrete interfaces or write code. Solution descriptions stay plain-English.
- **Don't steer at the Untouchable Core.** A candidate whose primary change is a protected path (ADR-0001/0004) is reported as friction but not filed as an actionable issue.
- **Board-saturation back-stop.** Emit nothing when the board is already saturated with `architecture-scan` issues — belt-and-braces ahead of the autopilot's `arch_board_saturated` signal (#789).
- **Dry-run default.** Only `--apply` creates issues. A dry-run on `gaberoo322/hydra` is always safe.
- **One pass.** Explore → present → filter → emit → report, then exit.

## Manual smoke test

Phase A acceptance flow — the operator runs this before #790 wires the autopilot `architecture_orch` dispatch:

```bash
/hydra-architecture-scan            # dry-run: prints candidates + rendered bodies
/hydra-architecture-scan --apply    # files needs-triage issues on gaberoo322/hydra
```

Expected:

- The Explore phase surfaces 3–6 deepening candidates in `CONTEXT.md` + `LANGUAGE.md` vocabulary.
- The filter drops candidates that touch the Untouchable Core, duplicate an open `architecture-scan` issue, or fail the deletion test.
- `--apply` files issues labelled `enhancement`, `needs-triage`, `architecture-scan` — and **never** `ready-for-agent`.
- Re-running `--apply` against an already-saturated board emits nothing and prints the board-saturation skip.
- The interactive `improve-codebase-architecture` skill is unchanged (`git status` shows no edits under `~/.claude/skills/improve-codebase-architecture/`).

## Out of scope (Phase A — issue #788)

| Item | Lands in |
|---|---|
| `arch_fallback_due` + `arch_board_saturated` state signals | **#789** (`scripts/autopilot/collect-state.sh`) |
| `architecture_orch` signal class + selector + cooldown + scope-exclude in `decide.py` | **#790** (`scripts/autopilot/decide.py`) |
| Autopilot class-taxonomy + signal-wiring table | **#791** (`docs/operator-playbooks/hydra-autopilot.md`) |
| Any modification to `improve-codebase-architecture` | Never — it stays interactive and operator-facing. |
| Auto-PRs that perform the deepening refactor | Never — that is a later `hydra-dev` pickup against a triaged issue. |

See parent epic #787 for the full roadmap.

## Files

- `docs/operator-playbooks/hydra-architecture-scan.md` — this playbook (source of truth; the skill is generated by `scripts/sync-skills.sh`).
- `~/.claude/skills/improve-codebase-architecture/` — the upstream interactive skill this wrapper re-uses (Explore + Present-candidates, steps 1–2). **Read-only — never edited by this skill.**
- `docs/operator-playbooks/hydra-prd.md` — the `≥3`-candidate emission path (parent epic + children).
- `~/.claude/skills/to-issues/` (upstream) — the `1–2`-candidate emission path.

## Tier

Tier 3 (ships entirely as a new operator playbook under `docs/operator-playbooks/`; no Untouchable Core, no `src/` change). The PR body carries the live tier classifier's verdict; this footer is informational. The issues this skill later *emits* each carry their own `Expected tier: N` from `/api/tier`, classified at pickup, so the existing gate applies unchanged.
