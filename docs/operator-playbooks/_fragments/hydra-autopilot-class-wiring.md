# hydra-autopilot — Class wiring reference

Per-class wiring details for signal classes. Read when investigating a specific
class's dispatch logic, cooldown configuration, scope, or saturation guards.
The authoritative source for dispatch policy is `scripts/autopilot/decide.py`.

> **Phase B wiring (issue #485, sub of #483):** `scout_orch` is a
> calendar-driven signal class — `SIGNAL_COOLDOWNS["scout_orch"] = 7d`.
> The walk surface (categories from `docs/ai-leverage-categories.md` +
> runtime deps from `package.json` + `dashboard/package.json`) is built
> by `src/scout/calendar-walk.ts:planWalk()`. Per-category cooldown
> (30d default) and per-tool cooldown (90d, via the Phase A seen-list)
> stack on top of the per-class 7d cooldown — all three must clear
> before a category is dispatched. When the per-category cooldown says
> "skip" but per-tool says "ready", the category-level skip wins
> (operator preference: fewer issues). Steady-state cost slice: ~4% of
> the \$50/day cap (`SCOUT_DAILY_COST_SHARE` in `calendar-walk.ts`);
> operators override via `state.limits.scout_cost_share`.
>
> **Cost-cap gate (issue #532).** The 4% share is now enforced at
> dispatch time, NOT just documented. `decide.py:_select_for_signal`
> for `scout_orch` reads `state.limits.scout_cost_share` (default
> `SCOUT_DAILY_COST_SHARE = 0.04`) and `state.limits.daily_spend_cap_usd`
> (default `$50.0`) — computes `cap_usd = share * daily_cap` — reads
> `state.scout_spend_usd_today` (emitted by `collect-state.sh` from the
> `hydra:metrics:tokens:by-skill:daily:<DATE>[hydra-tool-scout]`
> surrogate, USD via `HYDRA_TOKEN_USD_RATE`) — and suppresses dispatch
> when `spend_usd >= cap_usd`. The check fires BEFORE the 7d class
> cooldown (cap is the harder limit): if the cap is exceeded the
> dispatch is suppressed even when the cooldown has elapsed.
>
> Two operator escape hatches:
> - **Tightening:** `state.limits.scout_cost_share = 0.0` is the
>   intentional kill-switch — `cap_usd` resolves to `0.0` and the
>   `>=` check suppresses every dispatch. Set this if a runaway scout
>   needs to be muted while keeping the walk infrastructure intact.
> - **Loosening:** `state.limits.daily_spend_cap_usd = 0.0` (or an
>   unset `HYDRA_TOKEN_USD_RATE`, which produces \$0 surrogate spend) is
>   treated as "rate not configured" and the gate becomes a no-op.
>   This preserves Phase B's pre-#532 behaviour for operators who
>   haven't opted in to a per-token USD rate yet.
>
> The daily mirror at `hydra:scout:spend:<YYYY-MM-DD>` (7d TTL) is
> populated by `collect-state.sh` each turn from the existing
> `/api/metrics/tokens` accumulator (`hydra-tool-scout` skill) — no
> separate writer is needed and the gate sees real usage.

> **Per-cycle dev_target cost-cap backstop (issue #1059, leaf of epic
> #1052).** `dev_target` dispatches respect a per-cycle USD backstop that
> mirrors the Orchestrator's per-cycle cost-cap pattern (the
> `HYDRA_PER_CYCLE_COST_CAP_USD` knob) and the scout cost-share gate above.
> It is a HIGH backstop, NOT a throttle: it only fires on a runaway cycle
> that has already burned a large dollar budget on Target builds. Slices
> 3/5/6 of epic #1052 (Target QA, mutation, retro) raise per-cycle Target
> spend on the single self-hosted runner, so the backstop guards against an
> unbounded sub-dispatch loop.
>
> `decide.py:_rule_pipeline_classes` reads
> `state.limits.per_cycle_cost_cap_usd` (default
> `PER_CYCLE_COST_CAP_USD_DEFAULT = $25.0`) and
> `state.dev_target_spend_usd_cycle` (default `0.0`), then halts further
> `dev_target` sub-dispatch this cycle when `spend_usd >= cap_usd`. The
> check fires BEFORE the selector (cap is the harder limit), mirroring the
> scout gate, and records a `dispatch_decision` `budget` skip plus a
> `plan.debug.dev_target_cost_cap_skipped` breakdown for operator audit.
>
> Two operator knobs:
> - **Tune:** raise/lower `state.limits.per_cycle_cost_cap_usd` (or the
>   `HYDRA_PER_CYCLE_COST_CAP_USD` bootstrap env var) to move the backstop.
> - **Disable:** a cap of `0` turns the backstop off entirely (no-op) —
>   this is NOT a kill-switch (the cap is a backstop, never a throttle), so
>   `0` means "no backstop", never "suppress everything". An absent
>   `dev_target_spend_usd_cycle` key likewise degrades to a clean no-op, so
>   legacy state shapes keep today's behaviour.

> **Architecture-scan wiring (issues #789/#790, parent #787):**
> `architecture_orch` is the idle-time fallback signal class. When the
> orchestrator board has gone fully idle, it reclaims spare capacity by
> dispatching the headless `/hydra-architecture-scan` wrapper (#788),
> which runs explore + emit-issues and **files orch-scope GitHub issues**
> via `hydra-prd` / `to-issues`. It is **issue-producing, not
> direct-dispatch** — it never dispatches `dev_orch` itself; the issues it
> files re-enter the board as ordinary `ready-for-agent` work on a later
> turn. `SIGNAL_COOLDOWNS["architecture_orch"] = 24h`
> (`decide.py`) — a daily idle-reclamation cadence, in contrast to
> `scout_orch`'s weekly 7d walk.
>
> Two precomputed signals from `collect-state.sh` gate it (decide.py reads
> them verbatim, never recomputing board-empty or cooldown here — the
> signal seam exists precisely to prevent that gate-re-parsing round-trip):
>
> - **`arch_board_saturated`** is the PRIMARY suppressor and is checked
>   FIRST in `decide.py:_select_for_signal` (mirroring scout's
>   `scout_board_saturated` early-return). It is true when the count of
>   OPEN issues carrying the stable `architecture-scan` label exceeds
>   `ARCH_BOARD_SATURATION_CAP = 6` (the cap lives in `collect-state.sh`,
>   not this playbook, so the playbook never greps state JSON — the scout
>   saturation precedent). This is the anti-feedback-loop guard: once the
>   board already holds enough proposal-grade architecture work, the scan
>   suppresses itself rather than manufacturing low-value work.
> - **`arch_fallback_due`** is the "nothing else to do, go deepen" trigger:
>   true when `ready_for_agent == 0 AND needs_research == 0 AND
>   needs_triage == 0 AND work_queue (hydra:anchors:work-queue) == 0`.
>
> The 24h per-class cooldown is the BACK-STOP (honored by the shared
> `signal_is_cooled` guard); `arch_board_saturated` is the primary
> suppressor. `architecture_orch` is registered in `decide.py`'s
> `SIGNAL_CLASSES` dispatch tuple and excluded under `target-only` runs
> via `SCOPE_TARGET_ONLY_EXCLUDE` (it scans the orchestrator's own
> codebase and emits orch-scope issues — orch-scope by definition).
>
> **`architecture_target` soft-dependency:** there is deliberately NO
> `architecture_target` mirror today. It stays OUT until the Target PR
> merge backlog (#718) drains — wiring it prematurely would manufacture
> target work that cannot merge. When #718 clears, the mirror is added the
> same way (`SCOPE_TARGET_ONLY_EXCLUDE` gains no target entry; a
> target-scope saturation count + fallback predicate land in
> `collect-state.sh`).

> **Retrospective wiring (issue #920, parent #917):** `retro_orch` is the
> daily per-run retrospective signal class. It dispatches the `/hydra-retro`
> skill (#919), which consumes the run-tree **retro bundle** (#918),
> deep-reads only the flagged transcripts, and emits a **conservative,
> recurrence-gated** set of improvement proposals (≤2 GitHub issues + ≤1
> gated PR + artifact-only notes per run). Like `architecture_orch` it is
> **issue-producing, not direct-dispatch** — the issues/PR it files re-enter
> the board as ordinary work on a later turn.
>
> - **Cadence / cooldown:** `SIGNAL_COOLDOWNS["retro_orch"] = 24h`
>   (`decide.py`) — a once-per-day cadence, the same daily back-stop as
>   `architecture_orch` (in contrast to `scout_orch`'s weekly 7d walk). The
>   24h cooldown is what enforces "at most once per day": the gating signal
>   only asserts a completed run *exists*, so without the cooldown the same
>   run would re-fire on every idle turn.
> - **Spare-capacity / no-preemption:** `retro_orch` is a signal class, so it
>   has no slot semantics and `decide.py` dispatches every pipeline slot
>   (dev/QA/research/design-concept) BEFORE the signal loop. It is registered
>   LAST in the `decide.py` signal iteration tuple, making it the
>   lowest-priority signal class — a retro therefore never preempts an active
>   or pending dev/QA/research dispatch. That ordering, not a separate
>   capacity gate, is how the issue's "does not preempt pipeline classes"
>   requirement is met.
> - **Scope / target:** `retro_orch` analyses the orchestrator's OWN autopilot
>   runs and files orch-scope improvements — orch-scope by definition. It is
>   excluded under `target-only` runs via `SCOPE_TARGET_ONLY_EXCLUDE`,
>   mirroring `scout_orch` / `architecture_orch`. There is no
>   `retro_target` mirror (the Target produces no autopilot runs to retro).
> - **Signal seam:** the single gate is **`retro_run_available`** — true when
>   a COMPLETED run exists to analyse (`collect-state.sh` reads the
>   `/api/autopilot/runs` index and counts non-`running` runs). `decide.py`
>   reads it verbatim and never recomputes run state. No `run_id` is threaded
>   through `prompt_args`: the `hydra-retro` skill defaults to the latest
>   completed run when invoked with no argument (see
>   `docs/operator-playbooks/hydra-retro.md` — "Resolve the run id"), so the
>   run-id resolution stays inside the skill exactly like `architecture_orch`.
> - **Emit, don't audit (issue #1078):** `decide.py` DOES stamp
>   `prompt_args:{apply:true}` on the dispatch. `hydra-retro` defaults to
>   `--audit`/dry-run, so an argument-free headless dispatch would file ZERO
>   issues and open ZERO PRs — a silent no-op that defeats the class's entire
>   purpose (≤2 issues + ≤1 gated PR/run). With `apply:true` the autopilot
>   forwards `--apply` (the action-to-tool table maps `apply=true` →
>   `--apply`), so the scheduled retro emits. `--audit` remains the explicit
>   opt-in for a manual operator inspection run.

> **Cleanup wiring (issue #960, parent #958):** `cleanup_orch` is the
> high-confidence mechanical backfill class. It dispatches the headless
> `/hydra-cleanup` skill — a **deterministic** dead-code + simplification
> detector (a `knip`/`ts-prune` **devDependency**, NOT a runtime dep — ADR-0005
> only constrains runtime deps) that finds provably-unused exports/files and
> files them as GitHub issues. Like `architecture_orch` / `retro_orch` it is
> **issue-producing, not direct-dispatch** — the issues it files re-enter the
> board as ordinary work on a later turn.
>
> - **Cadence / cooldown:** `SIGNAL_COOLDOWNS["cleanup_orch"] = 3600` (1h) —
>   the same hourly backfill cadence as `discover_orch` / `architecture_orch`
>   (#959), so the workhorse runs hot on an idle board.
> - **Trigger / gate:** keyed off the **same** unified `orch_backfill_idle`
>   signal as the backfill set. `cleanup_board_saturated` is the PRIMARY
>   suppressor (checked FIRST in `decide.py:_select_for_signal`, before the 1h
>   cooldown) — true when the count of OPEN issues carrying the stable
>   `cleanup-scan` label exceeds `CLEANUP_BOARD_SATURATION_CAP = 10` (the cap
>   lives in `collect-state.sh`, not this playbook, mirroring
>   `arch_board_saturated`). This is the anti-feedback-loop guard.
> - **NOT staggered:** unlike `discover_orch` / `architecture_orch`,
>   `cleanup_orch` is deliberately **NOT** in `decide.py`'s
>   `BACKFILL_SIGNAL_CLASSES`, so it is exempt from the one-per-turn stagger and
>   MAY dispatch on the same idle turn as a staggered backfill class. Dead-code
>   removal is the highest-confidence (mechanically-verifiable) continuous-
>   backfill work (epic #958), so it is meant to run every cooled idle turn.
> - **Findings are `ready-for-agent`, NOT `needs-triage`:** in contrast to
>   `architecture_orch` (whose softer deepening candidates land at
>   `needs-triage`), `cleanup_orch`'s findings are mechanically verifiable —
>   each emitted issue's acceptance criterion is "remove X **AND** `npm test` /
>   `tsc` still pass", so the deletion is self-checking and routes straight to
>   `ready-for-agent`.
> - **Scope / target:** orch-scope by definition (it scans the orchestrator's
>   own `src/`), excluded under `target-only` via `SCOPE_TARGET_ONLY_EXCLUDE`,
>   mirroring `scout_orch` / `architecture_orch` / `retro_orch`. There is no
>   `cleanup_target` mirror (the Target PR merge backlog, #718, must drain first).

> **Phase B wiring (issue #466, sub of #437):** `design_concept_orch`
> fires before `dev_orch` for an orch anchor when the artifact is
> missing or stale. Phase B is **warn-only** — a draft artifact whose
> `gateCheck()` returns `ok:false` is still treated as "fresh present"
> and `dev_orch` proceeds. Phase C (separate issue) will flip warn-only
> to a hard block. The `design_concept_target` mirror lands in Phase D.
>
> Sequencing rule: when the best candidate carries a `designConcept`
> block with `present:true` and `isFresh:true`, the
> `design_concept_orch` selector returns None (no re-grill within 7
> days) and `dev_orch` proceeds. When the block is absent (legacy
> candidates API), Phase B is a no-op and `dev_orch` proceeds as
> before — that lets B-1 (this PR) land before the candidates API is
> extended to surface artifact metadata.
>
> Retry policy (per #466): grill timeout (case 1) and grill crash (case
> 3) each retry up to `MAX_FAILURE_RETRIES=5` via `self_heal.py`. A
> warn-only artifact (case 2) does NOT retry — the operator handoff is
> filed and `dev_orch` proceeds.

Pipeline slots: at most one subagent per slot in flight. Signal classes
track only their last-fired timestamp under `signal_last_fired` — no
slot semantics, just cooldowns. The scope filter (`limits.scope`) is an
**exclusion mask** (`orch-only` / `target-only` / `all`); `health` is
the only scope-agnostic class. See `decide.py:scope_excluded()` and
INV-008.
