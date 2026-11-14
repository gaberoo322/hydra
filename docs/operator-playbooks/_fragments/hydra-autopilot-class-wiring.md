# hydra-autopilot — Class wiring reference

Per-class wiring for signal classes. Read when investigating one class's
dispatch logic, scope or saturation guard. Policy values are owned elsewhere and
read from there:

- cooldown, scope and model per class: the `cooldownSeconds`, `scope` and `model`
  columns of `scripts/autopilot/classes.json` (`jq` over the row)
- signal-loop order: `SIGNAL_LOOP_ORDER` in `scripts/autopilot/decide.py`
- board-saturation constants: `src/autopilot/turn-snapshot/board-saturation.ts`
- the slot, signal-class and action-type lists: `python3 scripts/autopilot/decide.py smoke`

## Scout

`scout_orch` is a calendar-driven signal class. Its walk surface is the category
list in `docs/ai-leverage-categories.md`, built by
`src/scout/calendar-walk.ts:planWalk()`. Dependency freshness and CVEs belong to
`npm run deps:check` and the OSV scan, not to the walk. Three cooldowns stack:
the per-class cooldown, a per-category cooldown and a per-tool cooldown through
the seen-list (the last two live in `src/scout/calendar-walk.ts`), and all three
must clear before a category dispatches. When the category cooldown says skip and
the tool cooldown says ready, the category skip wins (fewer issues). Each
dispatched outcome goes through `recordCalendarDispatch`
(`src/scout/dispatch-audit.ts`), whose one call lands the `hydra:scout:dispatches`
audit entry, the per-category cooldown stamp and the per-day counter that
`/api/scout/stats` rolls up.

The live budget split is the orch-realm weekly-share guard
(`orch_realm_share_state`). The Turn Snapshot's `scout` collector writes the daily
token mirror at `hydra:scout:spend:<YYYY-MM-DD>`.

## Architecture scan

`architecture_orch` is the idle-time fallback signal class. When the
orchestrator board is idle, it dispatches the headless `/hydra-architecture-scan`
wrapper, which runs explore plus emit-issues and **files orch-scope GitHub
issues** through `hydra-prd` / `to-tickets`. It is **issue-producing, not
direct-dispatch**: it never dispatches `dev_orch` itself, and the issues it files
re-enter the board as ordinary `ready-for-agent` work on a later turn.

Two precomputed Turn Snapshot signals gate it. `decide.py` reads them verbatim and
never recomputes board-empty or cooldown, because the signal seam exists to
prevent that gate-re-parsing round-trip:

- **`arch_board_saturated`** is the primary suppressor, checked FIRST in
  `decide.py:_select_for_signal`. It is true when the count of OPEN issues
  carrying the `architecture-scan` label exceeds the architecture saturation
  constant in `board-saturation.ts`. It is the anti-feedback-loop guard: a board
  that already holds enough proposal-grade architecture work suppresses the scan.
- **`arch_fallback_due`** is the "nothing else to do, go deepen" trigger. It is
  true when `ready_for_agent`, `needs_research`, `needs_triage` and the
  `hydra:anchors:work-queue` count are all 0.

The per-class cooldown is the back-stop, honoured by the shared
`signal_is_cooled` guard. The class's `scope` column is `orch` (it scans the
orchestrator's own codebase), so a `target-only` run excludes it.

## Retrospective

`retro_orch` is the per-run retrospective signal class. It dispatches
`/hydra-retro`, which consumes the run-tree **retro bundle**, deep-reads only the
flagged transcripts, and emits a conservative, recurrence-gated set of
improvement proposals (the skill's caps are in `hydra-retro.md`). Like
`architecture_orch` it is **issue-producing, not direct-dispatch**.

- **Cadence:** the cooldown rate-limits the class. The gating signal only asserts
  that a completed run exists, so without the cooldown the same run would
  re-fire on every idle turn.
- **No preemption:** a signal class has no slot semantics, and `decide.py`
  dispatches every pipeline slot (dev, QA, research, design-concept) BEFORE the
  signal loop, so a retro never preempts an active or pending pipeline dispatch.
  That ordering is the preemption guard, not a separate capacity gate.
- **Scope:** `retro_orch` analyses the orchestrator's OWN autopilot runs, so its
  `scope` is `orch` and a `target-only` run excludes it.
- **Signal seam:** the single gate is **`retro_run_available`**, true when a
  COMPLETED run exists to analyse (the Turn Snapshot `retro` collector counts
  non-`running` runs in the `/api/autopilot/runs` index). No `run_id` rides
  `prompt_args`: `hydra-retro` defaults to the latest completed run (see
  `docs/operator-playbooks/hydra-retro.md`, "Resolve the run id").
- **Emit, don't audit:** `decide.py` stamps `prompt_args:{apply:true}` on the
  dispatch, and the action-to-tool table maps `apply=true` to `--apply`.
  `hydra-retro` defaults to `--audit` (a dry run), so an argument-free headless
  dispatch would file nothing. `--audit` is the explicit opt-in for a manual
  inspection run.

## Cleanup

`cleanup_orch` is the high-confidence mechanical backfill class. It dispatches the
headless `/hydra-cleanup` skill, a **deterministic** dead-code and simplification
detector built on `knip` (a **devDependency**; ADR-0005 constrains runtime
dependencies only) that finds provably-unused exports and files and files them as
GitHub issues. Like `architecture_orch` and `retro_orch` it is
**issue-producing, not direct-dispatch**.

- **Trigger and gate:** it keys off the same unified `orch_backfill_idle` signal as
  the backfill set. `cleanup_board_saturated` is the primary suppressor, checked
  FIRST in `decide.py:_select_for_signal`, before the cooldown. It is true when
  the count of OPEN issues carrying the `cleanup-scan` label exceeds the cleanup
  saturation constant in `board-saturation.ts`, mirroring `arch_board_saturated`.
- **Not staggered:** `cleanup_orch` is deliberately outside `decide.py`'s
  `BACKFILL_SIGNAL_CLASSES`, so the one-per-turn stagger does not apply and it may
  dispatch on the same idle turn as a staggered backfill class. Dead-code removal
  is the most mechanically verifiable continuous-backfill work, so it runs every
  cooled idle turn.
- **Findings are `ready-for-agent`, not `needs-triage`:** each emitted issue's
  acceptance criterion is "remove X **AND** `npm test` / `tsc` still pass", so the
  deletion is self-checking and routes straight to `ready-for-agent`.
  `architecture_orch`'s softer deepening candidates land at `needs-triage`.
- **Scope:** `scope` is `orch` (it scans the orchestrator's own `src/`), so a
  `target-only` run excludes it. Its Target mirror is `cleanup_target`, with its
  own `classes.json` row and `SIGNAL_LOOP_ORDER` entry.

## Design concept

`design_concept_orch` fires before `dev_orch` for an orch anchor whose design
concept artifact is missing or stale. The plan-level selector is **warn-only**: a
draft artifact whose `gateCheck()` returns `ok:false` counts as freshly present
and `dev_orch` proceeds (INV-009 is a stderr warning). The hard gate is
per-anchor at PR time, in the `design-concept-reconcile` required check and the
`hydra-qa` preflight (see `hydra-qa-reference.md`).

- When the best candidate carries a `designConcept` block with `present:true` and
  `isFresh:true`, the selector returns None (no re-grill inside the freshness
  window) and `dev_orch` proceeds.
- When the block is absent (a candidates API without it), the selector is a no-op
  and `dev_orch` proceeds.
- A grill timeout and a grill crash each retry up to `MAX_FAILURE_RETRIES` through
  `self_heal.py`. A warn-only artifact does NOT retry: the operator handoff is
  filed and `dev_orch` proceeds.

## Slots and scope

At most one subagent per pipeline slot is in flight. Signal classes track only
their last-fired timestamp under `signal_last_fired`, with cooldowns and no slot
semantics. The scope filter (`limits.scope`) is an **exclusion mask**
(`orch-only`, `target-only` or `all`), and `health` is the only scope-agnostic
class. See `decide.py:scope_excluded()` and INV-008.
