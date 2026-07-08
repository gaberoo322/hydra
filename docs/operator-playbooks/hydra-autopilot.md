---
name: hydra-autopilot
description: Event-driven autonomous decision loop that orchestrates all Hydra work in one Claude Code session via decide.py, executing typed action plans unattended for hours per run.
when_to_use: "When the operator says 'autopilot' or 'autonomous mode', or a scheduled launch fires."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
claude_only: true
disable-model-invocation: true
---

# Hydra Autopilot

HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: 2

Event-driven autonomous decision loop. The model is a thin Agent-tool-caller;
the policy lives in `scripts/autopilot/decide.py` (the **L2 decision brain**).

> **Schema-version handshake (issue #434).** The grep-able marker above
> (`HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: 2`) must match the
> `limits.schema_version` value written by `bootstrap.sh`. Phase 0 below
> verifies this and aborts on mismatch. Bumping the schema requires
> editing both this marker AND the `SCHEMA_VERSION` constant in
> `scripts/autopilot/bootstrap.sh` in the same commit, then running
> `scripts/sync-skills.sh` so the installed skill mirror is refreshed.

**Authoritative references — read these instead of this playbook when you
need to know what the autopilot will do:**

- Decision logic: `scripts/autopilot/decide.py` (the `decide()` function and
  its docstring own the policy)
- Merge policy: `decide.py:should_auto_merge.__doc__`
- Failure self-heal table: `scripts/autopilot/self_heal.py` docstring
- Runtime invariants: `scripts/autopilot/assert_invariants.py` (INV-001..INV-010; INV-009 is warn-only in Phase B per #466; INV-010 guards the forced-research daily cap per #1666)
- Architecture rationale: [ADR-0007](../adr/0007-decision-brain-orchestration.md)

## Loop

Each tick:

1. **Wake** on TaskNotification, Monitor board-change, or a 15-min heartbeat.
2. **Collect** state + candidates + events into three JSON blobs.
3. **`python3 scripts/autopilot/decide.py decide state.json candidates.json events.json`** — pure function call, returns `{actions, reasons, debug}`. The CLI bumps `state.turn` by one and persists it atomically BEFORE calling `decide()` — the bump is a `main()` side-effect; `decide()` itself stays pure.
4. **`python3 scripts/autopilot/assert_invariants.py plan.json state.json`** — runtime guards.
5. **Execute** each action in the plan via the right tool (table below).
5a. **`python3 scripts/autopilot/heartbeat.py --last-action=<type>`** — write the per-turn heartbeat line. `<type>` is the `type` of the LAST action executed in step 5 (or `wait` / `(none)` if the plan was a no-op). MUST run on every iteration, even when the plan only contained a `wait` — file mtime is the operator's liveness signal (issue #435).
6. **Re-enter step 1.** No inline reasoning between steps.

> **`state.turn` is owned by the decide.py CLI (issue #1769).** One bump per
> `decide` invocation, persisted atomically before `decide()` runs, so the
> plan's `turn` stamp equals the persisted state.json `turn` by construction
> and the heartbeat's strict plan-freshness equality (#1732/#1735) always
> holds. The session MUST NOT write `turn` — neither an explicit increment
> nor a whole-file rewrite of state.json from a stale snapshot (run 69442b4c
> hit a session-improvised increment racing the heartbeat, which zeroed
> turns 2–9's action ledgers run-wide). Session-side state updates (slots,
> dispatches, tokens, signals) are targeted field edits only. A violation
> surfaces loudly as a `plan-stale-skipped: ... exact off-by-one ...` reason
> in the turn record.

## Class taxonomy (7 pipeline slots + 12 signal classes)

| Kind | Class | Skill |
|---|---|---|
| pipeline | `dev_orch` | hydra-dev |
| pipeline | `qa_orch` | hydra-qa |
| pipeline | `research_orch` | hydra-research / hydra-issue-research |
| pipeline | `dev_target` | hydra-target-build |
| pipeline | `qa_target` | hydra-qa (target scope) |
| pipeline | `research_target` | hydra-target-research |
| pipeline | `design_concept_orch` | hydra-grill (Phase B, warn-only) |
| signal | `health` | hydra-doctor (scope-agnostic) |
| signal | `sweep_orch` | hydra-sweep |
| signal | `sweep_target` | hydra-target-sweep |
| signal | `discover_orch` | hydra-discover |
| signal | `discover_target` | hydra-target-discover |
| signal | `scout_orch` | hydra-tool-scout (Phase B, weekly calendar walk) |
| signal | `architecture_orch` | hydra-architecture-scan (#788; idle-time fallback, issue-producing) |
| signal | `retro_orch` | hydra-retro (#919; daily per-run retrospective, issue-producing + ≤1 gated PR) |
| signal | `cleanup_orch` | hydra-cleanup (#960; board-idle deterministic dead-code/simplification scan, issue-producing → `ready-for-agent`) |
| signal | `cleanup_target` | hydra-target-cleanup (Target mirror of cleanup_orch; demote-only dead-export sweep over ~/hydra-betting, backlog-item-producing → `ready-for-agent` + `queued`) |
| signal | `wire_or_retire_target` | hydra-wire-or-retire (#2722, epic #2720; judgment counterpart to cleanup_target — resolves triage `wire-or-retire` items into WIRE/RETIRE/UNCLEAR verdicts; 24h cooldown, ≤2 items/run, model param omitted) |
| signal | `design_qa_target` | hydra-design-qa (#2739, parent #2732; periodic VISUAL QA — screenshots every nav-registry route + judges vs the Target design ADR's [judgment] rules, files ≤3 deduped `needs-triage` design-qa items/run; 7d calendar cooldown, >5-open saturation backstop, model param omitted) |
| signal | `skill_prune` | hydra-skill-prune (#2949, epic #2944; eval-gated PROMPT counterpart to cleanup_orch — prunes ONE playbook-generated skill/run along the Pocock taxonomy [duplication/sediment/no-op], gated on promptfoo golden-task parity, ≤1 T1/T2 PR/run editing only that playbook + its regenerated skill + tightened ratchet baseline, else files a `needs-triage` candidate list; 7d calendar cooldown, saturation backstop, `apply:true`, model param omitted) |

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

## Action-to-tool table

| Action type | Tool the model invokes |
|---|---|
| `dispatch` | `Agent(run_in_background=True, isolation="worktree", model=<resolved>, ...)` — **resolve `<model>` from the action's `slot` (the dispatch class) via the Per-class model routing map below and pass it to the `Agent` call** (issue #1093). A class absent from the map → omit `model`, inheriting the parent session. `decide.py` stays pure: it emits no model field; the model lever lives here in the playbook, keyed off the `slot`/class the action already carries. The action carries `worktreeBranch` (stamped by `decide.py:_synthesize_worktree_branch`; issue #527) so the dashboard's slice-4 "Watch stream" cross-link can scope `/agents/stream?agent=<branch>`. The action ALSO carries `dispatchSentinel` (issue #692) — a hidden HTML comment of the form `<!-- hydra-dispatch v1 skill=… dispatchId=… runId=… -->`. **Prepend `action.dispatchSentinel` verbatim, on its own line, to the FIRST user message of the Agent prompt** (before the worktree-guard preamble). The project-scoped `SessionStart` hook (`scripts/hooks/session-start-capture.sh`, registered in `~/hydra/.claude/settings.json`) scrapes that sentinel from the session transcript and registers the subagent session into `hydra:dispatches:subagent:*` so every live session is recoverable to `(skill, dispatchId, runId, startedAt)`. When `decide.py` does not emit `dispatchSentinel` (legacy plans / a dispatch with no `skill`), skip the prepend — the session simply won't auto-register. |
| `auto-merge` | `Bash` → `gh pr review --approve && gh pr merge --auto --squash`, then a SINGLE `POST /api/holdback/pending {prNumber, tier, cycleId}` register call (see Phase 6). The handler does NOT itself enroll the holdback or write the merged cycle-record — it only ARMS the PR; the in-process merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`, issue #2623) fires both merge-coupled follow-ups once the merge lands. |
| `route-prs-to-review` | `Bash` → emitted only while the operator-only **emergency brake** (issue #744) is engaged, IN PLACE OF every `auto-merge` action. The model routes the current open PRs to the `/hydra-review` pickup set: `gh pr list --repo gaberoo322/hydra --state open --json number` to enumerate them, then for each apply the review label (`gh api .../labels` — `gh pr edit` is broken, per operator memory) so `/hydra-review` surfaces them. The action carries no per-PR list — `decide()` is pure and cannot enumerate PRs. Because the brake suppresses all `auto-merge`, no PR auto-merges this turn; the operator clears the brake via `hydra brake off` once the incident is resolved. The autopilot NEVER engages or disengages the brake — there is no such action type. |
| `apply-operator-approved` | `Bash` → `gh pr edit --add-label operator-approved` |
| `update-branch` | `Bash` → `gh pr update-branch` |
| `queue-decision` | `Bash` → `./scripts/autopilot/queue-decision.sh ...` |
| `reap` | `Bash` → `./scripts/autopilot/reap.py completion ...` (also fires `dispatch.sh cycle-record` for `hydra-dev` / `hydra-target-build`; see Phase 6) |
| `terminate` | `Bash` → `./scripts/autopilot/drain.sh <merged_prs>` → Phase 7. The decide CLI has already POSTed the clean run-end for this cause (issue #1352) — drain + digest are all that remain. |
| `wait` | sleep N; re-enter loop. Only emitted while slots are in flight (busy-wait nap / `wait_or_reap`) or after a non-dispatch housekeeping turn — a wait-only turn with zero occupied slots emits `terminate` (cause `idle`) instead, because a print-mode session exits on its final message and the wait would never be honoured (issue #1352). **Handoff baton-pass (issue #1903):** a `wait` while slots ARE occupied may be the LAST message of this print-mode turn — print mode physically exits when the model goes quiet across the nap, with subagents still mid-flight. When you end such a turn (slots in flight, no further dispatchable work this turn), POST `/api/autopilot/run-end` with `cause=handoff` BEFORE your final message — an honest baton-pass to the successor run, which re-seeds the slots from the surviving dispatch ledger (#1352). This is idempotent on `run_id` (same as the `terminate` path), and the ExecStopPost reap backstop derives `handoff` from `state.json.slots_occupied > 0` even if you miss the POST, so the baton-pass is never mis-stamped `interrupted`. |
| `wait-for-api` | `curl --retry`; re-enter loop |

### Per-class model routing (issue #1093)

Background `Agent`-dispatched subagents inherit the **parent autopilot
session's model** (the operator's saved default — Fable 5 since 2026-06-10)
unless the dispatch passes an explicit `model`.
Skill frontmatter is NOT a sufficient lever — a background dispatch ignores the
skill's declared model and inherits the parent. So the `dispatch` action-to-tool
row resolves `model` from the action's `slot` (the class) via the static map
below and passes it to the `Agent` call. `decide.py` is **pure and emits no
model field** (the README "Subagent Routing" design principle): the map lives in
this playbook, not in `decide()`.

Right-sized by **stakes × frequency** — drop the high-frequency non-authoring
classes off the frontier model; keep authorship and behaviour-reshaping classes
on Fable 5 (the frontier model, replacing Opus as of 2026-06-10).

| Class (`slot`) | Model | Rationale |
|---|---|---|
| `dev_orch` | Fable 5 (keep) | Multi-file, tier-gated self-modification |
| `dev_target` | Fable 5 (keep) | Money-critical betting code |
| `retro_orch` | Fable 5 (keep) | Reshapes future behaviour; per-run low volume |
| `design_concept_orch` | Fable 5 (keep) | A weak design concept wastes a full dev+QA cycle |
| `qa_orch` | Sonnet | Highest ROI; structured review against an artifact, ~every PR |
| `qa_target` | Sonnet | Floor — money-critical review, do NOT drop below Sonnet |
| `sweep_orch` / `sweep_target` | Sonnet | Board-routing decisions, not authorship |
| `health` | Sonnet | Structured diagnosis; rare small fixes |
| `research_orch` | Sonnet | Bounded codebase+web enrichment, not design |
| `research_target` | Sonnet (trial) | Strategic; trial, watch priority quality, revert on drift |
| `architecture_orch` | Sonnet | Non-interactive Explore+emit wrapper |
| `scout_orch` | Sonnet | Search + rubric scoring (low frequency, modest ROI) |
| `cleanup_orch` | Haiku | Deterministic knip output; LLM only formats findings into issues |
| `cleanup_target` | Haiku | Deterministic knip output + tested emit runner; LLM only drives the two commands |
| `wire_or_retire_target` | inherit parent (omit `model`) | Judgment work — recover a module's intent (git archaeology + vision/priorities/backlog cross-ref) and decide WIRE/RETIRE/UNCLEAR. NOT deterministic like `cleanup_target`; a low tier hits the documented Haiku-premature-exit failure mode (narrates "standing by", files nothing). Omit `model` so it inherits the parent (Fable 5), per #1093. |
| `design_qa_target` | inherit parent (omit `model`) | Visual judgment work — grade every route's screenshot against the Target design ADR's [judgment] rules (consistency / density / empty-state honesty). Like `wire_or_retire_target` it is an opinion, not a deterministic check; omit `model` so it inherits the parent (Fable 5), per #1093, to avoid the Haiku-premature-exit failure mode. |
| `discover_orch` / `discover_target` | Haiku | Patrol/diagnostics, designed small/fast/cheap |

Use the harness's model alias (`fable` / `sonnet` / `haiku` / `opus`) for the
`model` kwarg so the operator's plan resolves the concrete version. A class not
in the map (e.g. a legacy/unknown `slot`) → omit `model` and inherit the parent
session, the conservative default.

**Fallback when Fable 5 is unavailable.** The `fable` alias is not entitled in
every environment — a background `Agent(model="fable", …)` dispatch can die in
<1s with *"There's an issue with the selected model (claude-fable-5) … it may
not exist or you may not have access to it"* (0 tokens, 0 tool uses). When a
`fable`-routed dispatch terminates immediately this way (no tool uses + a
model-access error), **re-dispatch the identical action with `model: "opus"`
(Opus 4.8) — do not leave the class unrun.** Opus 4.8 is the frontier-capable
fallback for the authoring/behaviour-reshaping classes (`dev_orch`,
`dev_target`, `retro_orch`, `design_concept_orch`). Fable 5 stays the primary;
the fallback fires only on the model-access failure, so each class
auto-upgrades back to Fable once the alias is entitled again — no manual revert.
The Sonnet/Haiku-routed classes resolve independently and are unaffected.

## Phases (one-line each — full prose lives in code)

- **Phase 0** — `bootstrap.sh "$@"` initialises `/tmp/hydra-autopilot-state.json` (slash args via `args-parse.sh`), then the **schema-version handshake** (see below) runs before any other phase
- **Phase 1** — `collect-state.sh` emits signal counts (~100ms)
- **Phase 1.5** — `recover-stale.sh stale_in_progress <N...> stale_blocked <M...>`
- **Phase 2** — `reap.py` hard-cap sweep (idempotent; #395)
- **Phase 3** — `decide.py decide state.json cands.json events.json` returns the plan
- **Phase 4** — `assert_invariants.py plan.json state.json`
- **Phase 5** — model executes each action via the table above
- **Phase 6** — cycle-record write (#430) + sleep until next event or 15-min heartbeat

### Phase 6 cycle-record contract (issue #430)

After PR-3 (#383) deleted the in-process control loop, `src/cycle.ts`
declared that autopilot subagents would write their own `hydra:cycle:*`
records. That handoff is implemented by `POST /api/autopilot/cycle-record`
(see `src/api/autopilot.ts`), invoked via `dispatch.sh cycle-record`.

The cycle-record write fires at **reap time**:

1. **`reap.py completion`** — when a code-writing class (`hydra-dev` /
   `hydra-target-build`) reaps, it fires cycle-record with `status=completed`
   (or `status=failed` if the soft cap was tripped). The autopilot task_id
   is the `cycleId`, which gives natural dedup across retries. This write has
   no PR number (reap.py runs before the merge lands), so it files the record
   with NO PR/files data.

The **merged-status enrichment** — the follow-up that stamps `filesChanged` +
`prNumber` on the already-recorded metrics hash (issue #2063) — is NO LONGER
posted by the auto-merge handler. It now fires **in-process** from the
merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`, issue
#2623): once a registered PR (see the register handoff below) lands, the watcher
fetches the merged PR's `changedFiles` and calls `recordCycle({cycleId,
prNumber, filesChanged})` itself. Because `recordCycle` is idempotent on
`cycleId`, that duplicate post ENRICHES the existing record WITHOUT re-firing any
lifetime counter — the same enrichment semantics the auto-merge follow-up used
to carry, but coupled to the merge event in-process rather than shelled out from
the playbook.

The reap-time write covers three surfaces atomically server-side:

- `hydra:cycle:<id>` hash + `hydra:cycle:index` ZSET → `/api/cycle/history`
- `hydra:metrics:<id>` via `recordCycleMetrics(source: "claude")` →
  `/api/metrics` and `/api/scheduler/status.mergeRateWindow` (carries the
  enriched `filesChanged` count once the watcher posts the merged enrichment)
- `hydra:scheduler:cycles-{run,merged,failed,unaccounted}` lifetime counters →
  `/api/scheduler/status.mergeRateLifetime`

`dispatch.sh cycle-record` is best-effort: a 5xx or unreachable API is logged
to the nightly run log and the autopilot proceeds.

### Phase 6 register handoff on auto-merge (issues #2055, #2621–#2624)

The auto-merge handler no longer holds the merge — `gh pr merge --auto --squash`
ARMS auto-merge, so the PR may land seconds to minutes later, out-of-band from
this print-mode turn. Rather than block the turn waiting for the squash SHA, the
handler simply **registers** the armed PR and hands both merge-coupled
follow-ups (Outcome-Holdback enroll + the merged cycle-record enrichment) to the
in-process **merge-completion watcher** (`src/scheduler/chores/holdback-merge-watch.ts`,
issue #2623).

After `gh pr review --approve && gh pr merge --auto --squash` succeeds for an
`auto-merge` action, fire ONE register call:

```bash
# The ONLY post-merge follow-up the handler makes. $pr_number is the just-armed
# PR; $pr_tier is the integer tier from the auto-merge action payload
# (state.actions[].tier, 1–4 per ADR-0015, or null); $task_id is the autopilot
# cycleId. Best-effort: a non-2xx or unreachable endpoint is logged and the
# autopilot cycle proceeds — registration NEVER blocks or delays a merge.
#
# Issue #2800: pass an EXPLICIT anchorType so the merge-watch enrichment
# classifies the cycle even when it becomes the FIRST cycle-record write (the
# qa_orch relay case, where reap never wrote a record for this cycleId). Without
# it, the bare-UUID cycleId falls through the slot-suffix inference to the
# `unclassified` sentinel — the 32%-unclassified data-quality gap. Map the
# auto-merge action's dispatch class to its anchorType, mirroring
# `scripts/autopilot/dispatch.sh`: code-writing dispatches (dev_orch/dev_target)
# are `work-queue`; a bare `auto-merge` action with no resolvable class defaults
# to `work-queue` (the dominant armed-PR case). The field is optional — omitting
# it degrades to the prior inference-then-`unclassified` behaviour.
pr_anchor_type="${pr_anchor_type:-work-queue}"
curl -fsS -X POST http://localhost:4000/api/holdback/pending \
  -H 'content-type: application/json' \
  -d "$(jq -n --argjson pr "$pr_number" --argjson tier "${pr_tier:-null}" \
        --arg cycleId "$task_id" --arg anchorType "$pr_anchor_type" \
        '{prNumber:$pr, tier:$tier, cycleId:$cycleId, anchorType:$anchorType}')" \
  || echo "[autopilot] holdback pending register failed for PR #${pr_number} (non-fatal — merge already armed)" >&2
```

`POST /api/holdback/pending` (`src/api/holdback.ts`, issue #2622) records the
armed PR into the durable **pending-enroll registry** (idempotent on `prNumber`;
it records intent only — it never arms, blocks, or performs a merge). The
merge-completion watcher then consumes that registry each housekeeping tick and,
for each entry whose merge has landed, fires BOTH merge-coupled follow-ups
in-process:

1. **Outcome-Holdback enroll** — `enrollHoldback({commitSha, prNumber, tier})`
   against the landed squash SHA (ADR-0004 step 4, #786). Outcome Holdback
   **carries up** the monotonic tier ladder (#741, ADR-0015) — **T2, T3, and T4
   merges all enroll** while **T1 (prompt-shaped) and unknown-tier merges are
   exempt** (`enrollHoldback` enforces the carry-up exemption server-side, so the
   single source of truth for the invariant stays on the server). The watcher
   POSTs the `tier` from the register call verbatim; do NOT add a client-side
   `if tier in {2,3,4}` guard.
2. **Merged cycle-record enrichment** — `recordCycle({cycleId, prNumber,
   filesChanged})` (issue #2063), idempotent-enriching the reap-time record.

The watcher is idempotent (per-PR enrolled marker), leaves a still-open PR in the
registry for a later tick, and never throws (all best-effort). So the auto-merge
handler is reduced to *arm the merge, register the PR* — it holds no merge SHA
and makes no enroll/cycle-record call itself. The **check** mechanism that
watches each enrolled merge lives in the `hydra-qa` Post-merge Regression Check
section B.

### Phase 6 token-surrogate write (issue #394)

After PR-3 (#383) deleted `codex-runner.ts`, the legacy `recordSpend` writer
that fed `hydra:scheduler:daily-spend` for code-writing work was removed.
The autopilot now owns the daily-spend signal via a token surrogate. On
each subagent reap that has authoritative `total_tokens`, the autopilot
SHOULD fire:

```bash
curl -fsS -X POST -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg skill "$cls_skill" \
    --argjson tokens "$total_tokens" \
    --arg cycleId "$task_id" \
    '{skill: $skill, tokens: $tokens, cycleId: $cycleId}')" \
  "${HYDRA_API:-http://localhost:4000/api}/metrics/tokens" >/dev/null 2>&1 || \
  echo "[autopilot] dispatch: tokens write failed for cycle=$task_id (non-fatal)" >&2
```

This is best-effort and idempotent at the autopilot's `reaped_task_ids`
layer (the reaper already dedupes by `task_id` before firing follow-up
writes, so the same `cycleId` never bumps the counter twice). The endpoint
bumps three Redis keys:

- `hydra:metrics:tokens:autopilot:daily:<YYYY-MM-DD>` — INT total
- `hydra:metrics:tokens:by-skill:daily:<YYYY-MM-DD>` — HASH {skill -> tokens}
- `hydra:metrics:tokens:by-cycle:<cycleId>` — HASH {tokens, skill}

The first two have a 30-day TTL; the per-cycle hash has 7 days. The
dashboard `CostWidget` (Metrics page) reads these via `GET /api/metrics/cost`
and surfaces a clearly-labelled `source` so the operator never mistakes
surrogate USD for real billed spend. Dollar conversion uses
`HYDRA_TOKEN_USD_RATE` (USD per million tokens, default 0 — operators must
opt in to a rate they trust).

The per-cycle write keeps the per-cycle cost-cap in `src/cost/cap.ts`
alive: `checkCostCap()` now sums the legacy `costMicrodollars` reader and
the surrogate so a runaway subagent can still trip
`HYDRA_PER_CYCLE_COST_CAP_USD` even though codex is gone.

- **Phase 7** — `drain.sh <merged_prs>` + final `hydra-digest` dispatch (end-of-run summary; the morning timer's digest lands around 19:00, the evening timer's around 05:00)

## Phase 0 schema-version handshake (issue #434)

After `bootstrap.sh` exits successfully, but BEFORE invoking Phase 1
(`collect-state.sh`), the model MUST verify the playbook's expected
schema matches the schema bootstrap wrote:

```bash
PLAYBOOK_SCHEMA=$(grep -oP '^HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA:\s*\K[0-9]+' \
  docs/operator-playbooks/hydra-autopilot.md)
STATE_SCHEMA=$(jq -r '.limits.schema_version // 1' /tmp/hydra-autopilot-state.json)

if [ -z "$PLAYBOOK_SCHEMA" ]; then
  echo "[autopilot] FATAL: playbook missing HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA marker; run scripts/sync-skills.sh"
  exit 1
fi
if [ "$PLAYBOOK_SCHEMA" != "$STATE_SCHEMA" ]; then
  echo "[autopilot] FATAL: schema mismatch (playbook expects v${PLAYBOOK_SCHEMA}, state.json v${STATE_SCHEMA}; run scripts/sync-skills.sh)"
  exit 1
fi
echo "[autopilot] schema handshake OK (v${PLAYBOOK_SCHEMA})"
```

Why: PR #429 changed the state.json shape (10 flat slots → 6 pipeline
slots + 5 signal_last_fired) but the installed `~/.claude/skills/`
mirror of this playbook was stale because `sync-skills.sh` hadn't run.
The model attempted to reconcile and silently wedged for ~20 min
producing no observable output. The handshake makes that wedge a
loud abort at second 0 of the run instead of an invisible stall at
minute 20.

A v1 state.json (legacy, no `schema_version` field) is interpreted as
v1 via the `// 1` jq fallback above — mismatched against any modern
playbook, the handshake aborts and the operator re-runs after
`bootstrap.sh` writes a fresh v2 state on next invocation. There is
no in-place upgrader: bootstrap is the single writer for state.json.

## Cross-run state: Redis mirror survives reboot (issue #2715)

`/tmp/hydra-autopilot-state.json` is the run-local home of all autopilot
state, but `/tmp` is boot-wiped by the host tmpfiles policy (`D /tmp …
30d`). Most of state.json is **run-scoped** and legitimately dies with the
run — `pid`, `turn`, `dispatches`, `slots`, `idle_turns`, `burned_classes`
(the concurrent-run PID guard and the #1352 slot re-seeding DEPEND on those
resetting). Only the **cross-run durable subset** must survive:

- `signal_last_fired` (the per-class cooldown timestamps — the 5 long-cooldown
  classes `retro_orch` / `architecture_orch` / `cleanup_orch` / `scout_orch` /
  `wire_or_retire_target` (the last added by #2722) are the load-bearing ones;
  the 5 always-on classes re-arm to 0 each run by design)
- `research_force_counter` (the 4/day forced-research cap, #1666)

The #2575 prior-file carry-forward reseeds these from the *prior state.json*
on each bootstrap — which survives a pace-gate relaunch (no `/tmp` wipe) but
NOT a host **reboot** (which wipes `/tmp`, so there is no prior file). After a
reboot the long-cooldown classes reset to epoch 0 and all fire in the first
post-boot run — a per-reboot recurrence of the #2575 token churn.

The durable fix mirrors the cross-run subset to **Redis** (which survives
reboot via AOF + the docker volume) and reads it back as a seed tier:

- **Keys** (bare `redis-cli`, matching collect-state.sh's seam):
  `hydra:autopilot:signal-last-fired` — a **Hash** (field = signal class, value
  = last-fired epoch); `hydra:autopilot:research-force-counter` — a **String**
  holding the canonical-JSON date-keyed counter object.
- **Seed order** (bootstrap.sh): prior state file → **Redis** → 0. The prior
  file stays FIRST (fast local path, survives relaunches); Redis is the
  reboot-survival backstop; 0 is the first-install default (no prior file AND
  no Redis key — unchanged behaviour).
- **Write seam**: `reap.py run_completion` mirrors the whole subset on EVERY
  completion (the reliable "a signal class fired" executor seam — reap runs on
  every terminal dispatch, signal classes included). `decide.py` additionally
  mirrors `research_force_counter` on the same turn it stamps it (a force can
  advance without a reap).
- **decide.py's READ path is unchanged**: it reads `signal_last_fired` /
  `research_force_counter` ONLY from the loaded state dict, never from Redis.
  Redis is exclusively a bootstrap SEED source and an executor MIRROR sink.
- **Fail-open everywhere**: every Redis read (seed) and write (mirror) is
  best-effort — a Redis error logs and degrades to the pre-#2715 behaviour
  (seed → 0, write → state.json only) and NEVER aborts bootstrap or a decision
  turn. `HYDRA_AUTOPILOT_REDIS_CLI` overrides the `docker exec hydra-redis-1
  redis-cli` prefix for hermetic tests.

## Termination

`decide.py` emits a single `terminate` action when any of these trip:

1. `cumulative_tokens >= limits.token_budget`
2. `elapsed >= limits.wall_clock_max_sec`
3. `idle_turns >= limits.idle_drain_turns` AND all slots empty
4. 5 consecutive failures of the same pattern (failure backstop; see `self_heal.py`)
5. The turn is wait-only with zero occupied slots (issue #1352): nothing
   dispatched, no other actions, no slots in flight → `terminate` with cause
   `idle`. A `claude -p` print-mode session exits the moment the model emits
   its final message, so an idle-heartbeat `wait` was never honoured — the
   process died and the ExecStopPost reap stamped the run `interrupted`,
   leaving retro with zero drillable dispatches. Per ADR-0021 D5, continuity
   comes from the pace-gate relaunch, so the designed exit is recorded as the
   clean idle drain it is.

When the emitted plan carries a `terminate`, the decide CLI itself POSTs
`/api/autopilot/run-end` with the plan's cause before printing the plan
(issue #1352) — `term-check.py` only covers its own Phase-3 trips, and the
reap backstop would otherwise stamp `interrupted`. The POST is idempotent
(first terminal cause wins) and skipped when state carries no `run_id` or
`HYDRA_AUTOPILOT_RUN_END_POST=off`.

**Handoff baton-pass (issue #1903).** The cases above all leave ZERO slots in
flight at exit. The residual real-world exit is the OPPOSITE: the print-mode
session reaches a natural final message while subagent slots ARE occupied (the
plan was `wait`, but print mode has no event loop that survives the model going
quiet across a multi-minute nap). This is not a truncation — it is an honest
baton-pass: the in-flight subagents live in the durable dispatch ledger
(`hydra:dispatches:subagent:*`) that the next pace-gate-launched run re-seeds
(#1352). It is recorded with the clean `term_reason=handoff` (in
`CLEAN_TERM_REASONS`, `src/autopilot/runs.ts`), via two layers: (1) the model
POSTs `run-end(cause=handoff)` before its final message when it ends a turn with
slots > 0 and no further dispatchable work (the `wait` action row above), and
(2) the ExecStopPost reap backstop (`bootstrap.sh __reap_derive_cause`) derives
`handoff` whenever a CLEAN exit (code 0/143/130) shows `state.json` slots
occupied > 0 — so a missed in-loop POST still classifies the baton-pass
honestly. `interrupted` is now reserved for a clean ZERO-slot exit that bypassed
term-check (a genuine print-mode end with nothing pending).

The clean-termination rate over recent runs is surfaced as
`terminationHealth` (with a pre-derived `starved` alarm boolean) on
`GET /api/autopilot/runs` — `starved: true` means ≥5 ended dispatch-bearing
runs sustain a clean-termination rate below the floor (the #1352/#1847
retro-starvation condition). Reclassifying baton-passes from `interrupted` to
the clean `handoff` (issue #1903) makes this rate measure REAL starvation
(crashes / zero-progress) instead of counting every honest baton-pass as
non-clean.

## Worktree-guard preamble (REQUIRED for code-writing dispatches)

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
```

The preamble catches cwd-confusion. The companion guard is the PreToolUse
**worktree-write-fence** (issue #549), which catches the more insidious
failure: cwd is correct, but an `Edit`/`Write`/`MultiEdit` tool call
passes a `file_path` that resolves outside the worktree (the bug observed
on the PR #548 dispatch). Operators install it once with `bash
scripts/setup-claude-hooks.sh`; the hook source-of-truth lives at
`scripts/claude-hooks/worktree-write-fence.sh`. When active, the hook
denies any out-of-worktree write from a worktree-cwd session and the
agent must self-correct. `scripts/audit-ghost-writes.py` walks the
JSONL transcript history to quantify ghost-write incidents across past
dispatches (useful as a before/after measurement when the hook is rolled
out).

**`dev_target` dispatches need a SECOND check (issue #542).** The harness `isolation: "worktree"` only worktree-isolates the orchestrator repo (`~/hydra`). When `hydra-target-build` then writes to `~/hydra-betting`, those edits land on the main hydra-betting checkout unless the skill explicitly creates a hydra-betting worktree. The `hydra-target-build` playbook now does this in Step 0.6 — every `dev_target` dispatch MUST go through Step 0.6 before any Edit/Write against the target.

```
## TARGET-REPO SAFETY RULE — applies to dev_target only
Before writing to ~/hydra-betting:
- Create a hydra-betting worktree (see hydra-target-build Step 0.6).
- Verify `git -C <worktree> rev-parse --git-common-dir` resolves to ~/hydra-betting/.git
  AND `git -C <worktree> rev-parse --git-dir` contains `.git/worktrees/`.
- Use ONLY worktree-anchored paths for Edit/Write — never raw `/home/gabe/hydra-betting/...`.
- ABORT if any check fails. The two-repo asymmetry was the silent-leak failure mode in #542.
```

## Inspecting a run

- **One-shot status:** `bash scripts/autopilot/status.sh` — pretty-prints the heartbeat (+ wedge verdict), the compact state, and the log tail. Safe to wire to a shell prompt.
- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Liveness probe: `find /tmp/hydra-autopilot-heartbeat.txt -mmin -10` — the model writes the heartbeat every decision turn (Phase 5a). An empty result means no turn completed in the last 10 minutes.
- Live state: `jq '.slots,.signal_last_fired,.burned_classes' /tmp/hydra-autopilot-state.json`
- Run log: `tail -100 /tmp/hydra-autopilot-nightly.log` (filename is historical from when there was only a 22:00 fire; both timers still write here)
- Last decision plan: `jq . /tmp/hydra-autopilot-plan.json`
- Failure ledger: `tail /tmp/hydra-autopilot-failures.jsonl`

### Per-turn heartbeat format (issue #435)

After Phase 0, every decision turn overwrites `/tmp/hydra-autopilot-heartbeat.txt` with one line of the form:

```
<epoch> <pid> <run_id> turn=<N> dispatches=<M> tokens=<K> pipeline_filled=<F>/6 signal_active=<S>/5 last_action=<type>
```

The first turn after bootstrap stamps `last_action=bootstrap`; subsequent turns substitute the type of the most recent executed action (`dispatch`, `auto-merge`, `reap`, `wait`, etc.).

### Wedge detection: stale heartbeat + live process == wedge

`claude -p` buffers stdout, so a running autopilot may produce no observable terminal output for many minutes at a stretch. The heartbeat file is the only liveness signal the operator can trust.

**Decision rule:**

| Heartbeat mtime | Process pid alive? | Verdict |
|---|---|---|
| Within last 10 min | yes | Healthy (model is looping) |
| Within last 10 min | no | Already terminated cleanly — check log tail |
| >10 min old | no | Crashed or killed externally — check `journalctl` or run log |
| **>10 min old** | **yes** | **Wedge.** Model is alive but no longer producing decision turns. |

A wedge is the failure mode the 2026-05-15 incident exposed: a stale schema mirror caused the model to silently reconcile two worldviews and stop looping after Phase 0, while the parent `claude -p` process sat live producing no output for ~20 min. Recover with `kill <pid>` and restart the autopilot. File a `needs-triage` issue with the run-log tail.

```bash
# Quick wedge check:
hb=/tmp/hydra-autopilot-heartbeat.txt
if [ -z "$(find "$hb" -mmin -10 2>/dev/null)" ]; then
  pid=$(awk 'NR==1 { print $2 }' "$hb")  # per-turn format: pid is field 2
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "WEDGE: pid $pid alive, heartbeat stale"
  fi
fi
```

`scripts/autopilot/status.sh` runs the above automatically.

## Invocation

The skill is operator-invocable AND scheduled. Both paths run the same
`/hydra-autopilot` entrypoint and obey the same token / wall-clock budgets.

### Manual

Invoke from an interactive Claude Code session with `/hydra-autopilot`, or
headless from the shell:

```bash
claude --dangerously-skip-permissions -p "/hydra-autopilot"
# Short smoke:
HYDRA_AUTOPILOT_TOKEN_BUDGET=100000 HYDRA_AUTOPILOT_MAX_SEC=600 claude --dangerously-skip-permissions -p "/hydra-autopilot"
# Scope-restricted:
HYDRA_AUTOPILOT_SCOPE=orch-only claude --dangerously-skip-permissions -p "/hydra-autopilot"
```

Slash-args (`--scope=`, `--tokens=`, `--max-sec=`, `--idle-turns=`,
`--subagent-soft=`, `--subagent-hard=`, `--unattended=`) parse via
`args-parse.sh` and override env vars.

### Scheduling — the Pace Gate (ADR-0021)

The autopilot is launched by the **Pace Gate** — a usage-paced admission
controller, NOT a fixed daily schedule. The legacy morning (10:00) and
evening (22:00) timers are **retired** (issue #858); a single frequent
(~15 min) timer now decides whether to launch each Autopilot Run based on
where total weekly burn sits relative to the **Pacing Curve**.

| Unit | Fires | File |
|---|---|---|
| `hydra-pace-gate.timer` | every ~15 min | `scripts/systemd/hydra-pace-gate.timer` |
| `hydra-pace-gate.service` | (oneshot, runs the gate) | `scripts/systemd/hydra-pace-gate.service` |

On each tick `scripts/autopilot/pace-gate.sh`:

1. **Skip if a run is already live** — the service is active OR
   `/tmp/hydra-autopilot-state.json` carries a live owning PID (`kill -0`).
2. **Consult `/api/usage/eligibility`** (the Pacing Curve, #857): skip when
   `.reasons.paused == true` (operator pause, #988), `.reasons.sessionBlockedUntil`
   is a future instant (session-limit hard block, #1089),
   `.reasons.emergencyStop == true` (5h cap ≥ 90%) or `.paceState == "ahead"`
   (above the curve); otherwise (`on`/`behind`, not emergency) launch via
   `systemctl --user start hydra-autopilot.service`.
3. **Fail safe** — if the eligibility endpoint is unreachable, do NOT launch
   (pacing is the governor; don't burn quota while blind to usage).

**Session-limit hard block (#1089).** When the Claude Code rolling *session*
window is exhausted the CLI prints `You've hit your session limit · resets <t>`
and the autopilot exits `code=1`. The reap-on-exit backstop (`bootstrap.sh
--reap`) scans the journal for that line and POSTs it to
`POST /api/usage/session-block`, which parses the reset and records a
self-expiring block (`hydra:autopilot:session-blocked-until`, TTL to the reset
instant). While the block is in the future the eligibility route forces
`allow=false` and surfaces `reasons.sessionBlockedUntil`, so the Gate skips
relaunch into the exhausted quota instead of dying instantly on repeat. The
OAuth 5h `emergencyStop` undershoots the true session limit, so this is the
authoritative "the next run cannot make a single turn" signal. Admission
resumes automatically once the reset passes (TTL expiry + a past-instant read
guard) — no operator action needed.

The Gate governs *admission* only (should a run start now?), never *what work*
to do — that stays with `decide.py` (ADR-0012). It reuses the existing
watchdog, bootstrap concurrent-run guard, and the service's
`Restart=on-failure` untouched; it only ever *starts* the service.

`scripts/deploy.sh` installs `pace-gate.sh` to `~/.local/bin/`, retires the
legacy launch timers, and enables `hydra-pace-gate.timer` on every deploy.
Operator install / migration (one-time, if not relying on deploy):

```bash
# Retire the legacy launch timers (no-op on a fresh host).
systemctl --user disable --now hydra-autopilot-morning.timer hydra-autopilot.timer 2>/dev/null || true
rm -f ~/.config/systemd/user/hydra-autopilot-morning.timer \
      ~/.config/systemd/user/hydra-autopilot.timer

# Install + enable the Pace Gate (hydra-autopilot.service itself is unchanged).
install -D -m 0755 scripts/autopilot/pace-gate.sh ~/.local/bin/hydra-pace-gate.sh
cp scripts/systemd/hydra-pace-gate.service scripts/systemd/hydra-pace-gate.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hydra-pace-gate.timer
```

Inspect: `systemctl --user list-timers | grep pace-gate`,
`journalctl --user -u hydra-pace-gate.service` (admission decisions), and
`journalctl --user -u hydra-autopilot.service` after a launch.

Each launched run is still sized for up to 8h of work (the service's 9h
`RuntimeMaxSec` + 8h internal budget); the "already running" skip in step 1
prevents the ~15-min timer from ever stacking a second run on top of a live
one. The autopilot self-terminates on `idle_drain_turns` when there's nothing
to do. The L2 decision brain in `decide.py` benefits from a stable in-process
view of pipeline state across many turns, so the Gate launches one long run
and lets it run to budget/clock/idle rather than firing many short bursts.

## Slot lifecycle events (issue #509)

Subagent slot accounting is event-driven, not poll-driven. Claude Code's
`SubagentStop` and `Notification` hooks XADD lifecycle events onto a
Redis stream that the autopilot drains every turn:

- **Stream:** `hydra:autopilot:slot-events` (`XADD ... MAXLEN ~ 1000`)
- **Hook scripts:** `scripts/autopilot/hooks/on-subagent-stop.sh`,
  `scripts/autopilot/hooks/on-subagent-permission-wait.sh`
- **Hook registration:** `docs/operator-playbooks/hydra-autopilot.settings.json`
  (propagated by `scripts/sync-skills.sh` to
  `~/.claude/skills/hydra-autopilot/.claude/settings.json`)

### Event schema

```
event=subagent_stop
  slot=<dev_orch|dev_target|qa_orch|qa_target|research_orch|research_target|design_concept_orch|unknown>
  status=<success|failure|no_op|budget_exceeded|unknown>
  task_id=<harness-task-id>
  subagent_type=<hydra-dev|hydra-target-build|...>
  summary=<truncated 200-char text>
  ts_epoch=<unix-epoch>

event=slot_waiting_permission
  slot=<slot-or-unknown>
  prompt=<truncated 200-char text>
  ts_epoch=<unix-epoch>
```

### How the turn consumes them

1. `collect-state.sh` calls `XREAD COUNT 100 STREAMS
   hydra:autopilot:slot-events <last-id>` and emits the parsed events
   as `slot_events_json={events:[...], last_id:"..."}`. The autopilot
   merges this under `state.slot_events` and updates
   `state.slot_events_last_id` to the latest seen id so the next turn
   doesn't re-read.
2. `decide.py` consumes `state.slot_events`:
   - Each `subagent_stop` is translated into a `completion` event (the
     existing reap path) AND appended to `state.slot_history` (capped
     at 50 entries, FIFO).
   - `failure` and `budget_exceeded` statuses also append to
     `state.failure_log` so `self_heal.py` sees them.
   - Each `slot_waiting_permission` appends to `state.failure_log`
     with `pattern=permission_wait` but does NOT free the slot —
     the subagent is paused, not done.

### Silent-wedge fallback

If the hook itself silently fails (e.g. the subagent process crashed
before reaching the harness's `SubagentStop` dispatch), `decide.py`
falls back to a wall-clock timer. When an active slot's `started_epoch`
is older than `subagent_max_wall_seconds` (default `3600`, env override
`HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS`) AND no matching
`subagent_stop` event has been observed for the slot's `task_id`,
`decide.py` emits a `wait_or_reap` action. The harness translates that
into `reap.py completion ...` — the existing fallback CLI.

`reap.py` survives in the tree but is now the **fallback path**, not
the primary; see its module docstring.

### Best-effort guarantees

The hook scripts MUST NEVER propagate an error back to the parent
autopilot session. A Redis outage, a malformed payload, or a missing
`jq` — any of these results in a stderr warning and `exit 0`. The
regression test `test/autopilot-hooks.test.mts` enforces this.

### Environment overrides

| Var | Default | Purpose |
|---|---|---|
| `HYDRA_REDIS_HOST` | `docker` | When `docker`, hooks shell into `hydra-redis-1`. Otherwise `redis-cli -h $HOST -p $PORT` |
| `HYDRA_REDIS_PORT` | `6379` | |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM` | `hydra:autopilot:slot-events` | Used by hooks, `collect-state.sh`, and the regression tests |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID` | `0` | Cursor passed by the autopilot to `XREAD` so each turn only reads new events |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT` | `100` | Max events per `XREAD` batch |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN` | `1000` | `XADD MAXLEN ~` cap |
| `HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS` | `3600` | Silent-wedge fallback cap (`decide.py` only) |
| `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD` | `50.0` | Total daily spend cap (issue #532; bootstrap writes into `state.limits.daily_spend_cap_usd`) |
| `HYDRA_AUTOPILOT_SCOUT_COST_SHARE` | `0.04` | Scout slice of the daily cap (issue #532; `0` = kill-switch). Writes `state.limits.scout_cost_share` |
| `HYDRA_PER_CYCLE_COST_CAP_USD` | `25.0` | Per-cycle `dev_target` cost-cap backstop (issue #1059; HIGH backstop not a throttle; `0` = disabled). Read by `decide.py` from `state.limits.per_cycle_cost_cap_usd` |
| `HYDRA_USAGE_5H_THROTTLE_T1` | `0.60` | Graduated 5h-utilization throttle Tier-1 threshold (issue #1087), a fraction in (0,1). At/above this `percentLast5h` (authoritative OAuth meter only), `projectEligibility` sheds the lowest-value pipeline + backfill classes (`research_orch`/`research_target`/`architecture_orch`/`retro_orch`/`cleanup_orch`/`discover_orch`). Inert on the transcript estimate; set-but-invalid → default (fail-loud). Read by `src/cost/usage-tracker.ts` |
| `HYDRA_USAGE_5H_THROTTLE_T2` | `0.75` | Tier-2 threshold (issue #1087). At/above this `percentLast5h` it ADDITIONALLY sheds `design_concept_orch` + `dev_orch` (the largest 5h consumer); `qa_*` + `dev_target` are never shed. Mis-set below T1 is clamped up so the T2 cut never inverts. Read by `src/cost/usage-tracker.ts` |

## Signal wiring (state.signals)

`collect-state.sh` emits raw counts; the model turns them into the
boolean signals decide.py reads from `state.signals`. The key mappings:

| collect-state output | state.signals key | Drives |
|---|---|---|
| `ready_for_agent > 0` (orch GH board) | `orch_work_available` | `dev_orch` (issue #458) |
| `work_queue > 0` (target Redis queue) | `target_work_available` | `dev_target` |
| `needs_qa > 0` (orch GH board) | `needs_qa_orch` | `qa_orch` |
| `needs_research > 0` (orch GH board) | `needs_research` | `research_orch` |
| `needs_triage > 0` (orch GH board) | `needs_triage_orch` | `sweep_orch` |
| `untriaged_orphans > 0` (orch GH board — open issues carrying NONE of {ready-for-agent, in-progress, blocked, needs-qa, needs-triage, needs-research, target-backlog}) | `untriaged_orphans_orch` | `sweep_orch` (issue #2426) — triage backstop: routes mislabeled/orphaned issues invisible to BOTH the dev_orch and needs_triage_orch paths into an actionable lane |
| `health=FAIL` or `failed_services>0` | `health_fail` | `health` |
| `scout_last_walk_iso` >7d old or empty | `scout_walk_due` | `scout_orch` (issue #485) |
| `scout_board_open_enhancements > 20` | `scout_board_saturated` | suppresses `scout_orch` |
| `scout_spend_usd_today` | (read directly from state) | suppresses `scout_orch` via cost-cap (issue #532) |
| `dev_target_spend_usd_cycle` | (read directly from state) | halts `dev_target` via per-cycle cost-cap backstop (issue #1059) |
| `arch_fallback_due` (`ready_for_agent==0 && needs_research==0 && needs_triage==0 && work_queue==0`) | `arch_fallback_due` | `architecture_orch` (issues #789/#790) |
| `arch_board_open_scan > ARCH_BOARD_SATURATION_CAP (6)` → `arch_board_saturated` | `arch_board_saturated` | suppresses `architecture_orch` (checked FIRST) |
| `orch_backfill_idle` (same signal as above) | `orch_backfill_idle` | also drives `cleanup_orch` (issue #960) — NOT staggered, so it may co-fire with the backfill set |
| `cleanup_board_open_scan > CLEANUP_BOARD_SATURATION_CAP (10)` → `cleanup_board_saturated` | `cleanup_board_saturated` | suppresses `cleanup_orch` (checked FIRST, mirrors `arch_board_saturated`) (issue #960) |
| `target_backfill_idle` (target triage + queued lanes empty AND `work_queue==0`) | `target_backfill_idle` | drives `cleanup_target` (Target mirror of cleanup_orch; API-down degrades to `false`) |
| `target_cleanup_board_open_scan > 10` → `target_cleanup_board_saturated` | `target_cleanup_board_saturated` | suppresses `cleanup_target` (checked FIRST; API-down degrades to `true` — fail closed) |
| `wire_or_retire_target_triage > 0` (≥1 open `wire-or-retire`-labelled item in the Target `triage` lane) → `wire_or_retire_target_available` | `wire_or_retire_target_available` | drives `wire_or_retire_target` (issue #2722, epic #2720) — the judgment resolver; 24h class cooldown, ≤2 items/run; API-down degrades to `false` (fail closed) |
| `/api/autopilot/runs` index has ≥1 non-`running` run | `retro_run_available` | `retro_orch` (issue #920) — daily per-run retrospective; 24h class cooldown enforces the once-per-day cadence |
| `usage_eligibility_json` | `state.usage_eligibility` (object, merged verbatim) | hard-stop all dispatches when `allow=false`; skip listed classes when `shed` non-empty (PR B1). `shed` is the UNION of the weekly-projection pacing shed (`pacingState==="over"`) and the graduated 5h-utilization throttle (issue #1087, keyed off `percentLast5h` against `HYDRA_USAGE_5H_THROTTLE_T1/T2`); `reasons.fiveHourThrottleShed` flags the latter |
| `emergency_brake_json` | `state.emergency_brake` (object, merged verbatim) | operator-only emergency brake (issue #744): when `engaged=true`, `decide()` emits ZERO `auto-merge` actions and a single `route-prs-to-review` action that arms the /hydra-review pickup set. Default `{engaged:false}`. READ-ONLY — the autopilot can never set/clear it (no engage/disengage action type); the sole write path is `hydra brake on\|off`. |
| `orch_pending_grill_anchor=issue-N` (or `none`) | `state.signals.orch_pending_grill_anchor` (string, or omit — verbatim, no rename) | `design_concept_orch` fires hydra-grill on the named anchor; `dev_orch` yields the same turn (issue #628). Key name aligned in #736 so collect-state emits exactly what decide.py reads — no model-mediated rename. |

Pre-#458 `dev_orch` consumed `/api/anchor/candidates` and routinely
received target-product anchors (item-26x). Post-#458, candidates are
treated as target-side work: `dev_target` surfaces the top candidate as
a hint, and a low best-score forces `research_target` (not `research_orch`).

**Discover signals (revived).** `discover_orch` was **revived by issue #959**
(epic #958): it no longer gates on the dead `orch_idle` name — its `decide.py`
selector (`decide.py:2296`) now reads the unified **`orch_backfill_idle`**
board-empty signal, the SAME signal `architecture_orch` reads. Both classes are
members of `BACKFILL_SIGNAL_CLASSES` (`decide.py:329`) and share the 1h backfill
cadence, so `discover_orch` **fires today** on an idle orch board. `collect-state.sh`
emits `orch_backfill_idle` (line ~488); the dead `orch_idle` name it never
produced is gone. `discover_target` still gates on `target_idle` (its own
selector at `decide.py:2307`); whether that signal is produced is a separate
Target-side question.

**Backfill dedup baseline (issue #2554).** Because `discover_orch` and
`architecture_orch` both fire on `orch_backfill_idle`, the **one-per-turn
stagger guard** (it lets only one `BACKFILL_SIGNAL_CLASSES` member dispatch per
turn) prevents them co-firing the same TURN — but their independent per-class 1h
cooldowns plus the `BACKFILL_STARVATION_FLOOR` (`decide.py:331+`, which forces a
starved backfill class through) mean **both can dispatch within the same idle
HOUR**. `cleanup_orch` co-fires on the same signal every idle turn (it is
deliberately NOT in `BACKFILL_SIGNAL_CLASSES`, so exempt from the stagger).
`decide.py` cannot dedup this: it must stay a pure function of `(state, events,
now)` and cannot know what issues a just-dispatched skill WILL file (the filing
happens inside the subagent, after dispatch). The guard therefore lives **at
file-time inside the skill bodies**: `hydra-discover`, `hydra-architecture-scan`
(and `cleanup_orch`/`hydra-research`) each run every candidate through the SAME
deterministic helper `scripts/ci/issue-dedup.ts` (`isDuplicateIssue`,
normalised word-set Jaccard overlap >50%) against the SAME **shared backfill
dedup baseline** — open issues across EVERY backfill label set (`needs-triage` +
`architecture-scan` + `cleanup-scan` + `enhancement`) plus recently-closed — so
whichever class files second sees what the first just filed THIS idle window and
SKIPs the duplicate. The `discover_orch` ↔ `architecture_orch` co-fire is the
primary collision this baseline closes. The helper is a standalone script (NOT
an `@include` fragment), so it is independent of the `_fragments`/#2552 work.

## Where to look when something goes wrong

- Wrong dispatch for a class → `decide.py:_select_for_slot` / `_select_for_signal`
- Tier-0 non-mechanical PR merged anyway → INV-001 violation; run log
- Burned class still got dispatched → INV-003; `burned_classes` in `state.json`
- Failure pattern keeps retrying → `self_heal.py` + `state.failure_log` + Phase 3 backstop
- A subagent in flight wedged → Phase 2 reap or `subagent-hard-max-tokens`

## Merge-rate stabilization history (2026-05 → 2026-06)

### Reading the two merge-rate metrics

`/api/scheduler/status` exposes two distinct figures — keep them separate:

| Field | Formula | What it means |
|---|---|---|
| `mergeRate` | merged / cyclesInWindow (last N=50) | **The health signal.** Current operational health; use this to judge whether the autopilot is working. |
| `mergeRateLifetime` | cyclesMerged / cyclesRun (all time) | **Audit-only accumulator.** Permanently skewed by past failures; introduced by #232 precisely because it cannot reflect current health. Never alert on this metric. |

As of 2026-06-25 the live counters read: `mergeRate=96%` (window 50),
`mergeRateLifetime=17%`. **This is the healthy steady state.** A high rolling
rate alongside a low lifetime rate means the system recovered; it does NOT
signal an ongoing problem.

> **Accounting identity caveat.** `cyclesRun` (7557) exceeds
> `cyclesMerged + cyclesFailed + cyclesUnaccounted` (6957) by ~600. Those
> ~600 cycles predate the `cyclesUnaccounted` counter introduced in #1919 /
> #2150 — they were housekeeping/no-op era cycles that were never bucketed
> and permanently inflate the lifetime denominator. The identity holds only
> for cycles recorded after those PRs merged.

### What broke, how it was fixed

The high historical failure count is the sum of several compounding issues
fixed across spring/summer 2026. The most impactful clusters, in order of
root-cause severity:

**1. Autopilot runs hung and were never reaped (2026-05, #711)**
`claude -p /hydra-autopilot` logged `run complete` but the process was never
reaped — systemd stuck in `activating (start)` blocked every subsequent
pace-gate launch. Fix: `fix(autopilot): reap hung runs (Type=exec) +
force-exit test lesson (#711)`. This was the single largest failure multiplier:
all cycles dispatched after a hung run failed silently.

**2. CI cancelled in-progress master merges (2026-05, #760)**
`cancel-in-progress: true` in `ci.yml`'s `concurrency` block caused back-to-back
pushes to master to cancel each other's deploy. Two rapid merges could leave
prod stale and the second merge's CI red. Fix: `fix(ci): don't cancel
in-progress master CI runs (closes #712) (#760)` — scoped the cancel to
non-master refs only.

**3. QA false-greened on QUEUED status (2026-05, #769)**
`qa-verdict.ts` compared GitHub's UPPERCASE enum strings case-sensitively; a
`QUEUED` check appeared as not-completed, causing the verdict to pass a PR
before CI finished. Fix: `fix(qa): case-insensitive CI status matching (#769)`.

**4. Scope-check blocked valid in-scope files (2026-06, #837 + #1873)**
`scope-check.ts` short-circuited on code-spans before reading bullet-list
paths, and later hard-failed when a code-span in out-of-scope prose matched an
in-scope file. Both caused CI to eject valid PRs. Fixes: `fix(scope-check):
union code-span + bullet Files-in-scope (#837)` and `fix(scope-check): in-scope
wins over incidental out-of-scope code-span (#1873)`.

**5. Stale-claim reaper was mis-routing merged work (2026-06, #1758 + #2085)**
`reapStaleClaims()` had an open-PR guard but no merged-PR guard: when an agent
merged its PR and died before releasing its backlog claim, the reaper re-queued
the work as `queued` instead of `done`, causing duplicate dispatches. A separate
path silently moved reconciled items to `done` when the PR matched only by
fuzzy-token rather than issue-ref. Fixes: `fix(reaper): merged-PR guard (#1758)`
and `fix(backlog): escalate unconfirmable stale claims to blocked (#2085)`.

**6. Worktree write-fence blocked valid in-worktree edits (2026-06, #2371)**
~16 cross-run friction hits: a redundant `EnterWorktree` call desynced the
harness's writable-root anchor from the agent's cwd, causing in-cwd Edits to be
denied. This stalled or aborted dev cycles. Fix: `docs(playbooks): EnterWorktree
anchor contract (#2372)` — preventive playbook rule, no code change needed.

**7. Agent-tool subagents were not registered (2026-06, #2412)**
The `SessionStart` hook that populated `hydra:dispatches:subagent:*` never fires
for `Agent`-tool dispatches; as a result slot accounting was blind to running
subagents, causing double-dispatches and silent capacity waste. Fix:
`fix(autopilot): register Agent-tool subagents via PostToolUse hook (#2412)`.

### Confidence that the recovery is sustained

- `mergeRate=96%` over the last 50 cycles (as of 2026-06-25); no consecutive
  errors; `lastError=null`.
- The seven failure modes above are each closed by a discrete, tested fix — not
  configuration changes that could drift.
- Structural guards added: atomic Lua lane transitions (#2160), merged-PR guard
  in reaper (#1758), scope-check tiebreaker (#1873), and the EnterWorktree
  anchor contract (#2372) close the recurrence vectors.
- Monitoring: `GET /api/scheduler/status` → `mergeRate` (rolling window) is the
  single authoritative health gauge. Any sustained drop below ~80% in the rolling
  window warrants investigation; `mergeRateLifetime` is informational only and
  will trend upward very slowly as the denominator is dominated by historical runs.

## Safety rules

1. NEVER modify `~/hydra` or `~/hydra-betting` working trees directly.
2. Worktree-guard preamble is mandatory for `dev_orch` / `dev_target`.
3. One subagent per pipeline slot.
4. Token budget is a hard cap; subagent caps (#395) bound a single misbehaving subagent.
5. `hydra-architect` is operator-only.
6. Phase 7 is the only path to the end-of-run digest (idempotent shutdown).
