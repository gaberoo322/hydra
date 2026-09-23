# Operator-facing functionality beyond HTTP routes — inventory

**Wayfinder ticket:** [Inventory the orchestrator's operator-facing functionality beyond HTTP routes (#4418)](https://github.com/gaberoo322/hydra/issues/4418) ·
**Map:** [Operator guidance layer (#4416)](https://github.com/gaberoo322/hydra/issues/4416) ·
**Date:** 2026-09-22 · **Audited commit:** `5fded9547` (`origin/master`)

This is the **denominator** for the parity contract's "every class/skill visible" and
"every procedure reachable as instruction" rungs (map #4416 Destination (3)). HTTP routes
are covered by the sibling audit (#4417) and its dispositions (#4424 writes, #4425 GETs);
this document covers everything else. **Facts only — no UI is proposed.** Every row cites
its primary source as `path:line` in the audited tree (host-local files are marked).
Prior art cited rather than redone:
[`2026-09-17-inventory-sources-of-truth-and-drift-tests.md`](./2026-09-17-inventory-sources-of-truth-and-drift-tests.md)
(§2.3 classes, §2.4 playbooks, §2.5 config, §2.9 units/scripts, §2.11 env, §2.13 chores) —
that doc named #4418 as still-open and stood in as primary for the non-HTTP surface; this
document now supersedes it for these families.

**Visibility vocabulary** (all four sections): *named* = the thing's name/command appears
literally in user-visible dashboard UI; *generic* = it is rendered from data only once it has
run (e.g. a slot card on `/runs/:runId`); *indirect* = only its effect or output is shown;
*absent*. **Due-signal** = anything that tells the *operator* (not the autopilot) that it is
due, overdue, starved or misconfigured — feed item, Telegram, doctor finding, watchdog alert.

## 0. Headline findings

1. **Classes (22: 7 pipeline, 15 signal).** None is *named* in UI (only in the
   `useTaxonomy.js` fallback list); all 22 render *generically* on `/runs/:runId` from
   `GET /api/taxonomy/classes` + the run's turn snapshots — per-run, non-polling. **No
   operator-facing due/overdue/starved signal exists for any class**; per-turn skip reasons
   are not persisted. **No API computes cooldown remaining**; last-fired lives in
   `state.json` / `hydra:autopilot:signal-last-fired`, read by no `src/` code.
2. **Playbooks (38) + hand-run procedures (24).** 1 skill named in UI (`hydra-autopilot`,
   an empty-state label); **0 slash commands or invocations appear anywhere in the
   dashboard**; the Today feed never recommends a procedure. Operator-facing due-signals
   exist for only **4 playbooks** (review, hitl-grill, wayfinder, wire-or-retire) and **3
   procedures** (deploy drift chip, sync-skills journal line, StopBanner). 26 playbooks are
   both operator- and autopilot-run, 12 operator-only, 0 autopilot-only.
3. **Scripts & units.** 21 operator-relevant scripts. Housekeeping, the test-proc reaper,
   branch-prune, the GLM drainer unit, redis-backup and notify-failure have **no dashboard
   presence and no due-signal**. `/api/v2/now/service-strip` covers only orchestrator +
   redis and has no dashboard consumer; the Health "systemd" light is the only unit state
   shown. Watchdog alerts reach the operator via the Telegram digest only.
4. **Config & env.** The dashboard never calls `/api/config` or `/api/env` (the latter
   401s on every call — `CRON_SECRET` unset); nine operator-owned systemd drop-ins and three
   EnvironmentFiles are validated by nothing. Scope, extra-usage policy, holdback settings,
   trace URL and OTel config are shown nowhere.

### Premise corrections surfaced (for sibling tickets and fog)

- **Autopilot scope is `all`**, not orch-only — re-flipped 2026-09-16 with the CSB swap (§4.0).
- **Watchdog SHA drift:** it *does* compare deployed SHA to `origin/master` every 2 min, but
  is **log-only** (`HYDRA_WATCHDOG_AUTODEPLOY` set nowhere, no alert) — CLAUDE.md's "checks
  health, not SHA drift" is wrong, its "no alarm" is right (§3.4).
- **classes.json `skill` column is wrong for two classes** — `research_orch` says
  `hydra-research` but `decide.py` dispatches `hydra-issue-research`; `qa_target` says
  `hydra-target-qa` but dispatches `hydra-qa` (scope=target, #4576) — so "the skill a class
  dispatches" must be read from `decide.py`, not classes.json (§1). (`wayfinder_orch` →
  `hydra-issue-research` is by design: it works the map's AFK research tickets; task tickets
  go to `hydra-dev` — `decide.py:5878-5940`.)
- **Three selector inputs have no producer** (`target_idle`, `skill_prune_board_saturated`,
  `target_research_due`) — `discover_target` can never fire (§1).
- **`cleanup_orch` / `architecture_orch` dispatch as dry-runs** (no `apply`) (§1).
- **`hydra-skill-prune` carries `disable-model-invocation`** yet is autopilot-dispatched (§2).
- **Redis backups are not scheduled on this host** (timer never installed) despite
  `docs/reference.md` describing a daily run; the doctor's Timer Health loop checks three
  Target timers and none of the 7 in-repo ones (§3.2).
- Stale Target pointers: `docs/reference.md` defaults, `branch-prune.sh:610`, doctor
  probes and watchdog checks still name `~/hydra-betting` (§3, §4).

## 1. Autopilot dispatch classes

Commit `5fded9547` (= origin/master). All citations are `path:line` in that tree unless marked host-local.

**Source of the alphabet.** `scripts/autopilot/classes.json` has **22 rows** (7 `pipeline`, 15 `signal`). `decide.py` builds `PIPELINE_SLOTS` / `SIGNAL_CLASSES` / `SIGNAL_COOLDOWNS` from it when it is imported (`scripts/autopilot/decide.py:391-393`, `:489-491`). Dispatch **order** is separate policy, hardcoded in decide.py: the pipeline order is `pipeline_priority` (`decide.py:3264-3278`) and the signal order is the iteration tuple in `_rule_signal_classes` (`decide.py:3490-3579`). Prior art: `docs/research/2026-09-17-inventory-sources-of-truth-and-drift-tests.md:122-138` (§2.3).

**Gates that apply to every class** (listed once here, not repeated per row):
- Usage-tracker gate: `allow=false` blocks every class; `shed` skips the listed classes (`decide.py:3221-3238`, consumed at `:3281-3298` and `:3580-3597`).
- Per-run soft cap: `burned_classes`. A class whose subagent's tokens reached `limits.subagent_max_tokens` is suppressed for the rest of the run (`scripts/autopilot/reap.py:1550-1556`; checked at `decide.py:3309`, `:3640`).
- Scope mask:
  - `orch-only` excludes the 8 target classes (`decide.py:1080-1097`).
  - `target-only` excludes the 13 orch classes (`decide.py:1098-1152`).
  - `health` is never excluded (`decide.py:1936-1937`).
  - The live host is `scope=all` (host-local drop-in `~/.config/systemd/user/hydra-autopilot.service.d/scope.conf`: `HYDRA_AUTOPILOT_SCOPE=all`, `QUOTA_5H_MAX=15`, `QUOTA_WEEK_MAX=5`).
- Orch-realm weekly-share guard: applies to orch-scope classes only, and is off by default (`orch_realm_weekly_share_cap` default 0, `decide.py:6337`, `:6354`; checked at `:3334`, `:3626`).
- Run-level quota-delta cap: this ends the run rather than skipping a class (`decide.py:1003-1045`).
- **Pipeline concurrency:** 1 in flight per slot (`slots.get(cls) is not None` → "slot busy", `decide.py:3300-3308`).
- **Signal concurrency:** signal classes have no slot. They record only `signal_last_fired` (`reap.py:1539-1542`), and `_rule_signal_classes` has no slot-busy check (`decide.py:3447-3761`). The cooldown is their only throttle.

**Where a signal comes from.** "cs" in the table means `scripts/autopilot/collect-state.sh`. Some signals are counts that the harness model turns into booleans; the playbook's Signal-wiring table documents that step (`docs/operator-playbooks/hydra-autopilot.md:986-1047`).

### Class table

| name | kind | scope | skill dispatched | cooldown (s) | cap / concurrency limit | trigger signal (selector) | how to run by hand | dashboard presence | due-signal |
|---|---|---|---|---|---|---|---|---|---|
| `dev_orch` | pipeline (`classes.json:5-6`) | orch | `hydra-dev` (`decide.py:4700`; also the resume and GLM-fix pins at `:4469`, `:4512`, `:4574`, `:4690`) | null (`classes.json:10`) | 1 slot; `GLM_RED_FORWARD_FIX_CAP=2` pinned forward-fixes per GLM PR (`decide.py:3032`, `:4562`) | Order of checks: `dev_resume_pending` → `orch_dev_resume_pick` → `orch_glm_red_forward_fix` → **`orch_work_available`** (`decide.py:4443-4607`). `orch_work_available` comes from `ready_for_agent>0` (cs:203, playbook:993). It yields to a grill when `orch_pending_grill_anchor` is set (`decide.py:4658`) | `/hydra-dev <issue_number>` (`docs/operator-playbooks/hydra-dev.md:6`) | **Generic.** Slot card on `/runs/:runId` (`dashboard/src/components/PipelineSnapshot.jsx:81-83`). Dispatch rows in the turn timeline (`components/RunView.jsx:31`, `TurnTimeline.jsx:13`) and the `/now` Turn journal (`pages/now-console/NowConsole.jsx:76`). Named literally only in the fallback list (`hooks/useTaxonomy.js:13`) | none |
| `qa_orch` | pipeline (`classes.json:16-17`) | orch | `hydra-qa`, scope orch (`decide.py:4408`) | null | 1 slot; `QA_STALL_MAX_ATTEMPTS=3` per head needs-qa issue (`decide.py:1193`, `:4361-4406`) | `needs_qa_orch` (`decide.py:4358`), from the `needs_qa` count (cs:203, :230; playbook:999). Head issue from `needs_qa_numbers` (cs:748) | `/hydra-qa <issue_number>` (`hydra-qa.md:6`) | Generic (same as `dev_orch`) | The stall cap is only a plan-level `dispatch_decision` reason plus `debug.qa_orch_stalled_issue` (`decide.py:3395-3421`). It is not persisted anywhere an operator sees (see (b)) |
| `research_orch` | pipeline (`classes.json:27-28`) | orch | **`hydra-issue-research`** (`decide.py:4772`). classes.json says `hydra-research` (`:29`) | null | 1 slot. `RESEARCH_FORCE_DAILY_CAP=4` (`decide.py:754`) is defined, but `_research_force_allowed` (`:6079`) has no caller; only a comment references it (`:4801`) | `needs_research` (`decide.py:4771`), from the `needs_research` count (cs:233; playbook:1001) | `/hydra-issue-research <issue_number>` (`hydra-issue-research.md:6`). The taxonomy's `/hydra-research` is board-level and not what decide dispatches | Generic | none |
| `dev_target` | pipeline (`classes.json:38-39`) | target | `hydra-target-build` (`decide.py:4746`) | null | 1 slot; `target_wip_saturated` guard (`decide.py:3380`, from cs:561 / `target-wip.py`); per-cycle cost cap $25 (`decide.py:797`, `:3354`), marked INERT because USD spend is structurally $0 (`decide.py:791-796`) | `target_work_available` OR `target_board_work_available` (`decide.py:4730-4731`), from `work_queue>0` (cs:2026) or `target_ready_for_agent>0` (cs:416) (playbook:994-995) | `/hydra-target-build` | Generic | none |
| `qa_target` | pipeline (`classes.json:49-50`) | target | **`hydra-qa`, scope target** (`decide.py:4429`). classes.json says `hydra-target-qa` (`:51`); the playbook says "hydra-qa (target scope)" (`hydra-autopilot.md:68`) | null | 1 slot | `needs_qa_target` (`decide.py:4428`), from `target_needs_qa` (cs:417; playbook:998) | `/hydra-target-qa <pr_ref>` (`hydra-target-qa.md:6`). Operator memory (#4576): the target path exists only in hydra-target-qa | Generic | none |
| `research_target` | pipeline (`classes.json:60-61`) | target | `hydra-target-research` (`decide.py:4806`, `:4817`) | null | 1 slot | `target_research_due` (`decide.py:4805`) has **no producer**, per the PRODUCERLESS list in `scripts/ci/signal-parity-check.ts:84-86`. The live trigger is `target_board_research_due` (`decide.py:4816`), set when `target_ready_for_agent==0` (playbook:997) | `/hydra-target-research` | Generic | none |
| `design_concept_orch` | pipeline (`classes.json:71-72`) | orch | `hydra-grill` (`decide.py:4908`) | null | 1 slot | `orch_pending_grill_anchor` (`decide.py:4906`; cs:1837) | `/hydra-grill <N> orch` (`hydra-grill.md:479`) | Generic from the live API. **Missing from the fallback slot list** (`useTaxonomy.js:13` has 6 of the 7 slots) | none |
| `health` | signal (`classes.json:82-83`) | both | `hydra-doctor` (`decide.py:5167`) | 0 (`classes.json:87`) | none: cooldown 0 (`decide.py:1953-1954`) and no slot, so it can re-dispatch every turn while `health_fail` holds | `health_fail` (`decide.py:5166`), derived by the model from `health=FAIL` / `failed_services>0` (cs:70-71, :76; playbook:1008) | `/hydra-doctor` | **Generic.** Signal chip on `/runs/:runId` showing last-fired age and a cooldown badge (`PipelineSnapshot.jsx:42-62`, `:88-90`). Named literally only in the fallback (`useTaxonomy.js:14`). Its cycleId has no `_orch/_target` suffix, so `/runs` attribution maps it to `unknown` (`src/taxonomy/classes.ts:345`, `:358-362`) | none |
| `sweep_orch` | signal (`classes.json:93-94`) | orch | `hydra-sweep` (`decide.py:5206`, `:5221`, `:5248`) | 900 (`classes.json:98`) | Per-item 6h verdict backoff, `ORCH_TRIAGE_BACKOFF_SEC` (`decide.py:604-606`, `:5179-5207`) | `needs_triage_orch` (`decide.py:5178`), from the `needs_triage` count (playbook:1002) plus `orch_needs_triage_items` (cs:281); OR `untriaged_orphans_orch` (`decide.py:5247`; cs:706) | `/hydra-sweep` | Generic chip. Literal only in the fallback (`useTaxonomy.js:14`, `:17`) | none |
| `sweep_target` | signal (`classes.json:104-105`) | target | `hydra-target-sweep` (`decide.py:5292`) | 900 (`classes.json:109`) | Per-item 6h backoff, `TARGET_TRIAGE_BACKOFF_SEC` (`decide.py:589-591`, `:5263-5291`) | `needs_triage_target` (`decide.py:5263`), from `target_needs_triage` (cs:418; playbook:1004) | `/hydra-target-sweep` | Generic chip. Literal in the fallback (`useTaxonomy.js:14`, `:18`) | none |
| `discover_orch` | signal (`classes.json:115-116`) | orch | `hydra-discover` (`decide.py:5336`, `:5338`) | 3600 (`classes.json:120`) | Member of `BACKFILL_SIGNAL_CLASSES`, so at most one backfill class per turn (`decide.py:504`, `:3731-3760`). The idle path is suppressed by `hitl_grill_saturated` (inbox ≥10, cs:2256, :2274; `decide.py:5333-5335`) | `orch_backfill_idle` (cs:2180; `decide.py:5333`), OR the 7d staleness floor (`DISCOVER_STALENESS_FLOOR_SEC`, `decide.py:551`, `:5337`) | `/hydra-discover` | Generic chip. The fallback cooldown is **1800**, which disagrees with 3600 (`useTaxonomy.js:19`) | Self-heal only: the 7d floor and the 24h starvation floor that bypasses the stagger (`decide.py:523`, `:1966-1997`, `:3732`) force a dispatch. Neither raises an operator alert |
| `discover_target` | signal (`classes.json:126-127`) | target | `hydra-target-discover` (`decide.py:5357`) | 1800 (`classes.json:131`) | none beyond cooldown | `target_idle` (`decide.py:5356`) has **no producer** (`signal-parity-check.ts:88-90`; playbook:1085-1087), so **this class can never fire** | `/hydra-target-discover`. Its route-crawl step files only with `--apply` (`hydra-target-discover.md:35`, `:100`) | Generic chip (always "never" in practice). Literal in the fallback (`useTaxonomy.js:14`, `:20`) | none |
| `scout_orch` | signal (`classes.json:137-138`) | orch | `hydra-tool-scout`, trigger alert or calendar (`decide.py:5403`, `:5410`) | 604800 (`classes.json:142`) | `scout_board_saturated` (>20 open `enhancement`, playbook:1010; `decide.py:5392`). Scout cost-cap gate (`decide.py:3653-3667`) is INERT (`decide.py:765-772`) | `scout_alert_eligible_count>0` (cs:2961; `decide.py:5394-5408`) OR `scout_walk_due` (from `scout_last_walk_iso` >7d, cs:2044; playbook:1009; `decide.py:5409`) | `/hydra-tool-scout <category>` (`hydra-tool-scout.md:6`) | Generic chip. Merged PRs carrying provenance label `tool-scout` show on `/` Recent merges (`src/aggregators/recent-merges.ts:103-108`) | none |
| `architecture_orch` | signal (`classes.json:148-149`) | orch | `hydra-architecture-scan` (`decide.py:5460-5464`). **No `apply` arg is passed** | 3600 (`classes.json:153`). The fragment says **24h** (`docs/operator-playbooks/_fragments/hydra-autopilot-class-wiring.md:84`, `:105`) | `arch_board_saturated` (>6, cs:2128, :2182; `decide.py:5444`); `hitl_grill_saturated` (`decide.py:5457`); backfill stagger (`decide.py:504`) | `orch_backfill_idle` (`decide.py:5459`; cs:2180) | `/hydra-architecture-scan --apply`. It is a dry run without `--apply` (`hydra-architecture-scan.md:6`, `:64`, `:373`), so **autopilot dispatches are dry runs** | Generic chip. Provenance `architecture-scan` on `/` Recent merges | Self-heal only: 24h starvation floor (`decide.py:523`, `:3732`). No 7d floor; deferred by #4114 (playbook:1066-1070) |
| `retro_orch` | signal (`classes.json:159-160`) | orch | `hydra-retro`, `apply:true` (`decide.py:5520-5525`, `:5546-5550`) | 86400 (`classes.json:164`) | Not staggered | `retro_run_available` (cs:2650; `decide.py:5517`) AND `retro_run_drillable` (cs:2702; `decide.py:5519`); OR the weekly override (`RETRO_ORCH_WEEKLY_OVERRIDE_SEC`, `decide.py:566`, `:5546`) | `/hydra-retro [run_id]`, with `--apply` to emit (`hydra-retro.md:21`, `:73`) | Generic chip. `/now` RetroPanel from `/autopilot/retros` (`pages/now-console/RetroPanel.jsx:107`) shows retro output, not class state | Self-heal only (the weekly override) |
| `cleanup_orch` | signal (`classes.json:170-171`) | orch | `hydra-cleanup` (`decide.py:5596-5600`). **No `apply` arg is passed** | 3600 (`classes.json:175`) | `cleanup_board_saturated` (>10, cs:2139, :2184; `decide.py:5593`). Not staggered | `orch_backfill_idle` (`decide.py:5595`) | `/hydra-cleanup --apply`. It is a dry run without `--apply` (`hydra-cleanup.md:6`, `:61`), so **autopilot dispatches are dry runs** (matches operator memory "cleanup_orch is a no-op") | Generic chip. Provenance `cleanup-scan` on `/` Recent merges | none |
| `cleanup_target` | signal (`classes.json:181-182`) | target | `hydra-target-cleanup`, `apply:true` (`decide.py:5634-5639`) | 3600 (`classes.json:186`) | `target_cleanup_board_saturated` (>10, cs:2363, :2519; `decide.py:5631`) | `target_backfill_idle` (cs:2517; `decide.py:5633`) | `/hydra-target-cleanup apply` (`hydra-target-cleanup.md:6`) | Generic chip | none |
| `wire_or_retire_target` | signal (`classes.json:192-193`) | target | `hydra-wire-or-retire`, `apply:true, max_items:2, risk_carveout` (`decide.py:5709-5718`) | 86400 (`classes.json:197`) | `WIRE_OR_RETIRE_MAX_ITEMS=2` (`decide.py:1052`). Withheld when `target_risk_surface` is unresolved (`decide.py:3680-3696`) | `wire_or_retire_target_available` (cs:2521; `decide.py:5689`) | `/hydra-wire-or-retire` (no `arguments` frontmatter). Without `risk_carveout` every module is carve-out, i.e. routed to a human (`hydra-wire-or-retire.md:85-95`) | Generic chip | Withholding shows only in `plan.debug.wire_or_retire_withheld` (`decide.py:3685-3688`) |
| `design_qa_target` | signal (`classes.json:203-204`) | target | `hydra-design-qa`, `apply:true, max_items:3` (`decide.py:5785-5793`) | 604800 (`classes.json:208`) | `DESIGN_QA_TARGET_MAX_ITEMS=3` (`decide.py:1075`); `design_qa_target_saturated` (>5, cs:2366, :2525; `decide.py:5782`) | `design_qa_target_due` (cs:2531; `decide.py:5784`) | `/hydra-design-qa` with apply and max_items 3 (`hydra-design-qa.md:71-72`) | Generic chip | none |
| `skill_prune` | signal (`classes.json:214-215`) | orch | `hydra-skill-prune`, `apply:true` (`decide.py:5845-5850`) | 604800 (`classes.json:219`) | `skill_prune_board_saturated` (`decide.py:5842`) has **no producer** (`signal-parity-check.ts:80-83`), so the cap never engages | `orch_backfill_idle` (`decide.py:5844`) | `/hydra-skill-prune apply` (`hydra-skill-prune.md:6`, `:34`, `:40`) | Generic chip. No `_orch/_target` suffix, so `/runs` attribution maps it to `unknown` (`src/taxonomy/classes.ts:345`) | none |
| `wayfinder_orch` | signal (`classes.json:225-226`) | orch | `hydra-issue-research` in the action (`decide.py:5938-5941`). The playbook reroutes `task` tickets to `hydra-dev` at dispatch time (`hydra-autopilot.md:391`) | 3600 (`classes.json:230`) | Global cap of ≤2 in flight via `wayfinder_orch_inflight_global` (cs:2871; `decide.py:5903-5928`). Per-map single-flight is enforced structurally in cs (`decide.py:5913-5915`) | `wayfinder_orch_frontier` ≠ `none` (cs:2802; `decide.py:5897-5902`) plus `wayfinder_orch_ticket_type` | `/hydra-issue-research <ticket>` (research) or `/hydra-dev <ticket>` (task). `/hydra-wayfinder [map, ticket]` is the interactive planner (`hydra-wayfinder.md:7`) | Generic chip | none |
| `tickets_orch` | signal (`classes.json:236-237`) | orch | `hydra-tickets`, `spec_issue` (`decide.py:6002-6012`) | 3600 (`classes.json:241`) | none beyond cooldown | `tickets_available` (cs:2922; `decide.py:5991`) plus `tickets_orch_pending_spec` (cs:2941) | `/hydra-tickets` with the spec issue | Generic chip | none |

**Due-signal summary.** Nothing tells the operator that a class is due, overdue, or starved:
- The watchdog checks whole-autopilot wedge and liveness only (`scripts/hydra-watchdog.sh:13`, `:412-438`).
- The `/now` stuck-signal heuristics are idle-streak, issue-PR churn, stalled dispatch, and unproductive loop (`src/autopilot/health-signals/{idle-streak,issue-pr-churn,stalled-dispatch,unproductive-loop}.ts`). All of these detect over-dispatch, not under-dispatch.
- The hydra-doctor playbook has no per-class cadence check (grep of `docs/operator-playbooks/hydra-doctor.md` for autopilot or class: only `:151`, `:410`, `:419`, none of which are cadence checks).
- The only per-class "dark" handling is self-healing floors inside decide.py (discover 7d, retro weekly, backfill 24h), which force a dispatch without alerting anyone.
- The `/runs/:runId` signal chip shows age and a `cooldown` badge but has no due or overdue state (`PipelineSnapshot.jsx:45-59`).

### Dashboard presence: how generic rendering works

- **`/runs/:runId`** (`Autopilot.jsx` → `components/RunView.jsx:228` → `PipelineSnapshot`):
  - Slot cards come from `pipelineSlots`, one card per class, rendered even when the slot is empty.
  - Signal chips come from `signalClasses`, one chip per class, showing last-fired age plus a cooldown badge.
  - The alphabet comes from **`GET /api/taxonomy/classes`** (`hooks/useTaxonomy.js:40`; handler `src/api/taxonomy.ts:154`). Slot occupants and last-fired epochs come from the latest turn row of **`GET /api/autopilot/runs/:runId`** (`pages/Autopilot.jsx:178`; handler `src/api/autopilot-runs.ts:165`): `latestTurn.slots_snapshot` and `latestTurn.signals_snapshot` (`PipelineSnapshot.jsx:66-67`).
  - So **all 22 classes are rendered from data**. The only literal class names in `dashboard/src` are the fallback arrays in `useTaxonomy.js:13-21`. That fallback has 6 slots and 5 signals, omits `design_concept_orch` and the 10 newer signal classes, and has `discover_orch: 1800`.
  - This view does one fetch with no polling, and exists only per run.
- **`/now`**:
  - The Turn journal lists dispatched `slot` names and skills from `GET /api/autopilot/runs/current` (`NowConsole.jsx:40`, `:76-80`). A class appears here only when it was dispatched this run.
  - The "In flight" widget shows `slot.skill`, not class, from `GET /api/autopilot/inflight-slots` (`StatusStrip.jsx:77`, `:116`; handler `src/api/autopilot-runs.ts:101`).
- **`/runs`**:
  - "Dispatch events" shows `classLabel` (a skill-style label such as "hydra-grill", per `src/redis/dispatches.ts:30`) from `/now/active-dispatches` (`pages/Runs.jsx:100`; `src/api/now-page.ts:214-224`).
  - "Outcome attribution" renders `producerClass`, i.e. dispatch-class names parsed from the cycleId suffix, from `/attribution` (`Runs.jsx:54`, `:82-83`; `src/taxonomy/classes.ts:358`).
- **`/health`**: CostPanel `BurnTile` shows only the top **CostClass bucket** (dev-orch, qa, research, …; `src/cost/cost-by-class.ts:68-88`), not dispatch classes, from `/metrics/cost-by-class` (`components/pages/health/CostPanel.jsx:68-80`).
- **`/` (Today)**: Recent merges show the provenance label only (`tool-scout` / `architecture-scan` / `cleanup-scan`; `src/aggregators/recent-merges.ts:103-108`).
- **`/builder`, `/work`**: no class rendering found. Imports: `pages/Builder.jsx:1-6`, `pages/Work.jsx:1-3`.
- `GET /api/autopilot/class-stats` (`src/api/class-stats.ts:73`) has per-class dispatch counts and yield but **no dashboard consumer** (grep of `dashboard/src` for `class-stats` returns nothing).

### (a) Live in decide.py vs classes.json

- **No class is missing either way.**
  - All 7 pipeline rows are in `pipeline_priority` (`decide.py:3264-3278`) and `_SLOT_SELECTORS` (`:4929`).
  - All 15 signal rows are in the signal tuple (`:3490-3579`) and `_SIGNAL_SELECTORS` (`:6020-6036`).
  - `TARGET_ISOLATION` covers exactly the target and both-scope rows, checked at import (`:432-480`).
- **Divergences found:**
  - **Skill column vs what decide dispatches:**
    - `research_orch`: classes.json has `hydra-research` (`classes.json:29`); decide dispatches `hydra-issue-research` (`decide.py:4772`).
    - `qa_target`: classes.json has `hydra-target-qa` (`classes.json:51`); decide dispatches `hydra-qa` with scope=target (`decide.py:4429`).
    - `wayfinder_orch`: the skill is routed at dispatch time; classes.json's value is a default (`classes.json:233`).
  - **Stale classes.json notes:**
    - `tickets_orch` notes say "EXPAND STEP ONLY … decide.py's … tuples do NOT dispatch this class yet" (`classes.json:244`). It *is* dispatched (`decide.py:3578`, `:5949-6012`).
    - `wayfinder_orch` notes say the global ≤2 cap "land[s] in follow-on slices" (`classes.json:233`). It is implemented (`decide.py:5903-5928`).
  - **Playbook and fragment drift** (classes.json is authoritative):
    - The playbook heading says "7 pipeline slots + **14** signal classes" (`hydra-autopilot.md:60`); the file has 15.
    - The class-wiring fragment says `SIGNAL_COOLDOWNS["architecture_orch"] = 24h` (`_fragments/hydra-autopilot-class-wiring.md:84`, `:105`) versus 3600 (`classes.json:153`).
    - The ops-reference fragment says "the 5 long-cooldown classes" (`_fragments/hydra-autopilot-ops-reference.md:27-30`) versus 8 seeded (`bootstrap.sh:1047`).
    - `reap_state.py:134` says "the 10 signal classes".
  - **Stale hardcoded mirrors:**
    - `heartbeat.py` fallback cooldowns have `discover_orch: 1800` (`scripts/autopilot/heartbeat.py:103-110`), and its heartbeat line hardcodes the denominators `pipeline_filled=<F>/6 signal_active=<S>/5` (`heartbeat.py:27`, `:170`). The real counts are 7 and 15.
    - The dashboard fallback in `useTaxonomy.js:13-21` has the same problem (see above).
  - **Bootstrap seed:**
    - `signal_last_fired` is seeded with 12 keys (`bootstrap.sh:1118`).
    - `wayfinder_orch` and `tickets_orch` are not seeded, so they are treated as never fired and immediately eligible. The classes.json notes call this a benign 1h case (`classes.json:233`).
  - **Producerless selector inputs** (`scripts/ci/signal-parity-check.ts:79-91`):
    - `target_idle`: `discover_target` is dead.
    - `skill_prune_board_saturated`: the `skill_prune` cap never engages.
    - `target_research_due`: legacy input; the other `research_target` trigger still works.
  - **Apply flag:** `cleanup_orch` and `architecture_orch` dispatches carry no `apply` (`decide.py:5460-5464`, `:5596-5600`). Both skills are dry runs by default. Four other dry-run-default classes do get `apply:true`: retro, cleanup_target, skill_prune, design_qa (`decide.py:5523`, `:5637`, `:5848`, `:5789`).

### (b) "Last run" / "cooldown remaining" sources

- **Run-local state:** `/tmp/hydra-autopilot-state.json` holds `signal_last_fired`. It is seeded at bootstrap from the prior file → Redis → 0 (`bootstrap.sh:1047-1127`, written at `:1266`). decide.py reads it in `signal_is_cooled` (`decide.py:1950-1957`).
  - No script on the live path writes it per dispatch. `stamp_signal` exists (`decide.py:1960-1963`), but decide.py says it "is not on the live stamp path" (`decide.py:6673`). `reap.py:1563` says the timestamp is "stamped by the dispatcher", i.e. the harness model. Operator memory `reference_autopilot_harness_state_json_pitfalls` says "stamp signal_last_fired yourself".
  - Pipeline occupancy is `state.slots`.
- **Redis:** the hash `hydra:autopilot:signal-last-fired` is written by reap (`scripts/autopilot/reap_state.py:55`, `:133-160`) and read **only** by `bootstrap.sh` (`:647`, `:1080-1105`). No `src/` accessor or route reads it (grep of `src` and `dashboard/src` for `signal-last-fired` returns nothing).
- **Turn rows:** `heartbeat.py` POSTs `signals_snapshot = state.signal_last_fired` and `slots_snapshot` each turn (`heartbeat.py:286-296`). They are stored in `hydra:autopilot:run:{runId}:turns` with a 7d TTL (`src/autopilot/runs.ts:566-584`; `src/redis/autopilot-runs.ts:11-13`).
  - They are exposed via `GET /api/autopilot/runs/:runId` (`src/api/autopilot-runs.ts:165`) and `/runs/current` (`:109`).
  - **This is the only API that exposes per-class last-fired today, and only inside a run's turn array.** Raw epochs, per run.
- **No API computes "cooldown remaining".** `GET /api/taxonomy/classes` returns `signalCooldowns` (`src/api/taxonomy.ts:154-186`). The dashboard derives an `onCooldown` boolean client-side, not a remaining duration (`PipelineSnapshot.jsx:45`). `GET /api/autopilot/class-stats` has no last-run field (`src/autopilot/class-stats-math.ts:217-291`).
- **Terminal only:** `scripts/autopilot/status.sh:66` prints `signal_last_fired` / `slots` / `burned_classes`. The heartbeat file line has the stale `signal_active=<S>/5` count (`heartbeat.py:170`).
- **Skip reasons are not persisted.** The per-turn `dispatch_decision` events (cooldown / idle / budget / stagger reasons; `decide.py:1559-1584`) exist only in the plan's `events` (`decide.py:1837`). The turn POST carries actions, reasons, and snapshots only (`heartbeat.py:286-296`), and no `src/` consumer of `dispatch_decision` was found (grep).

### (c) Autopilot chores / housekeeping that are not classes

**In-loop rules and phases inside the autopilot session:**
- Phase 1.5 `recover-stale.sh` (`hydra-autopilot.md:485`; `scripts/autopilot/recover-stale.sh:3`).
- Phase 2 reap hard-cap sweep (`hydra-autopilot.md:486`).
- decide.py rules:
  - termination (`decide.py:2161`)
  - candidate-exclusion events (`:2190`)
  - slot-event and completion reaps (`:2512`, `:2653`)
  - cascade escalation re-dispatch (`:2686`)
  - **auto-merge sweep** (`:2958`)
  - **PR gate:** `update-branch` capped at 2 per turn, `surface-pr`, GLM red forward-fix (`:3025`, `:3132-3219`)
  - silent-wedge `wait_or_reap` (`:3763`)
  - idle fallback (`:3823`)
- Phase 6 cycle-record, plus the holdback register `POST /api/holdback/pending` after each `auto-merge` (`hydra-autopilot.md:103`, `:491`). Per playbook:103 the handler only arms the PR; enrolment and the merged cycle-record are done by the `holdback-merge-watch` housekeeping chore.
- Phase 7 `drain.sh` and the **`hydra-digest`** dispatch at run end (`hydra-autopilot.md:494`; `scripts/autopilot/drain.sh:7`).
- Failure self-heal table (`scripts/autopilot/self_heal.py:1-15`).

**Server-side housekeeping.** These are not run by the autopilot. They run under `hydra-housekeeping.timer`, `OnCalendar=hourly` (`scripts/systemd/hydra-housekeeping.timer:6`), from the `runHousekeeping()` chore list (`src/scheduler/housekeeping.ts:304-510`). The 14 chores:
- review-pickup-notify (`:306`)
- weekly-summary (`:313`)
- usage-weekly-snapshot (`:327`)
- memory-consolidation (`:334`)
- design-concept-snapshot (`:341`)
- stale-key-prune (`:349`)
- worktree-orphan-prune (`:366`)
- glm-eligibility-sweep (`:388`)
- target-outcomes-publish (`:403`)
- wiring-liveness (`:415`)
- attribution-record (`:443`)
- **holdback-merge-watch** (`:460`)
- cycle-merge-reconcile (`:481`)
- pattern-cue-demotion (`:498`)

Prior art: research doc §2.13, `docs/research/2026-09-17-inventory-sources-of-truth-and-drift-tests.md:263-269`.

**Skills with no class row that the autopilot never dispatches:** `hydra-epic-close`, `hydra-branch-prune`, `hydra-pr-rebase`, `hydra-target-retro`, `hydra-target-incident`, `hydra-incident`. None appears in any `make_dispatch` call in decide.py (grep). `hydra-prd` is deliberately not a class (`classes.json:244`).

---

## 2. Operator playbook procedures

Research for wayfinder ticket #4418 (map #4416). Read-only snapshot of worktree `wayfinder-4418` @ `5fded9547` (= origin/master), 2026-09-22. Facts only; each claim carries a `path:line` citation.

### Scope and method

- **Population.** `docs/operator-playbooks/` has **38 top-level `.md` playbooks**: 36 `hydra-*.md`, plus `thermo-nuclear-code-quality-review.md` and `zoom-out.md`. The "~51" figure in the brief counts these 38 plus 11 sibling `*.settings.json` hook files and the `_fragments/` and `_vendor/` directories, which are not playbooks. There is **no `README.md`** in the directory today, so the prior-art count "36 `hydra-*.md`, plus `README.md` and `thermo-nuclear…`" (`docs/research/2026-09-17-inventory-sources-of-truth-and-drift-tests.md:142`) is stale: the 38th file is `zoom-out.md`. The rest of prior-art §2.4 still holds (`…inventory…md:140-150`): the generator is `scripts/sync-skills.sh`, the skill id is the frontmatter `name:`, there are no ownership deep-links, and `/health/skills` was removed.
- **Skill name.** `scripts/sync-skills.sh` reads `docs/operator-playbooks/*.md` without recursing and writes `~/.claude/skills/<frontmatter name>/SKILL.md`. Every playbook's `name:` equals its filename stem. `claude_only: true` suppresses the Codex copy (`scripts/sync-skills.sh:8`).
- **Who runs it.**
  - *autopilot-dispatched* means the skill is the `skill` of a row in `scripts/autopilot/classes.json`, or another automated caller spawns it.
  - *operator-interactive* means the playbook's `when_to_use` / "Who runs this" names the operator or user.
  - *both* means both of the above apply.
  - All 22 class skills also carry an operator trigger phrase in `when_to_use`, so every class skill is "both".
- **Dashboard presence.** I grepped `dashboard/src` (excluding `*.test.*`) for every skill name, `/hydra-*` string and procedure keyword. **Named** means the name is visible to the user. **Functional** means an unnamed panel that shows the procedure's output or inputs, or lets the operator perform it.
  - Skill-name matches: only three exist. The one user-visible match is `pages/Autopilot.jsx:64`. The other two, `App.jsx:19` and `components/pages/today/NewTargetFindings.jsx:7`, are source comments.
  - Class skills appear only as **data-driven row labels**: the per-skill token cross-tab (`components/pages/today/SkillModelCrossTab.jsx:20`) and the taxonomy-driven pipeline (`hooks/useTaxonomy.js:13-14`, consumed by `components/PipelineSnapshot.jsx` and `pages/Autopilot.jsx`). They are never shown with an invocation.
- **Today feed.** The feed is `src/attention.ts`, served by `src/api/attention.ts`. It has three signals: `blocked-on-human`, `breakage` (failed-CI PRs) and `repetition` (friction cues) (`src/attention.ts:10-19`, `:162-195`).
  - Items link to a GitHub issue or PR, or to `/explore/friction` (`src/attention.ts:292-300`).
  - **The feed never recommends a procedure or slash command.** A `repetition` item's title embeds the friction group's *skill name* as data (`src/attention.ts:282`). That is a label, not a recommendation.
  - The other Today panels (`OperatorDecisionQueue`, `StuckItems`, `NewTargetFindings`) are item lists with GitHub links and no commands (`components/pages/today/OperatorDecisionQueue.jsx:36-52`, `StuckItems.jsx:56-67`, `NewTargetFindings.jsx:20-32`).
- **Due-signal.** Anything that tells the operator a procedure is due. Autopilot `collect-state` → `decide.py` signals are cited too, but they are **machine-facing**: they trigger an AFK dispatch and never reach the operator.

### A. Playbooks (38 rows)

Abbreviations:
- **OI** = operator-interactive; **AD** = autopilot-dispatched; **B** = both.
- **cls** = `scripts/autopilot/classes.json` skill line.
- **DD-label** = the skill appears only as a data-driven row label (SkillModelCrossTab / pipeline); no static name, no invocation.
- Every `when_to_use` is at line 4 of its playbook unless another line is given.

| # | Playbook | Skill (SKILL.md) | Who runs it | Trigger condition | Exact invocation | Dashboard presence | Due-signal |
|---|---|---|---|---|---|---|---|
| 1 | hydra-architect.md | hydra-architect | **OI only.** "`hydra-architect` is operator-only" (`hydra-autopilot.md:1163`). "operator-invoked and off the autopilot path" (`hydra-architect.md:220`). `dispatch.sh:59` maps it to cost bucket `architecture`, but no class row names it. | Operator wants to assess Hydra's architecture, or asks "how can we improve Hydra" (`hydra-architect.md:4`). | `/hydra-architect [focus]` (`hydra-architect.md:6`) | absent | none |
| 2 | hydra-architecture-scan.md | hydra-architecture-scan | **B.** AD via `architecture_orch` (cls:150; `decide.py:5419-5462`, dispatched on `orch_backfill_idle` unless `arch_board_saturated` / `hitl_grill_saturated`). OI via "operator says 'architecture scan'". | The Orchestrator runs out of eligible work, or the operator asks (`hydra-architecture-scan.md:4`). | `/hydra-architecture-scan` (dry-run) · `/hydra-architecture-scan --apply` (`hydra-architecture-scan.md:381-382`) | DD-label only | AD: `orch_backfill_idle` (`decide.py:5460`, `collect-state.sh:2103`). Operator: none. |
| 3 | hydra-auto-merge-window.md | hydra-auto-merge-window | **OI only.** "Operator-controlled batch auto-merger". No class row. **DORMANT**: "campaign template, not a standing skill" (`hydra-auto-merge-window.md:10-19`). | The operator is running a labelled bulk-PR campaign (`hydra-auto-merge-window.md:4`). Needs `HYDRA_BATCH_LABEL` set (`:16-19`). | `/hydra-auto-merge-window open 6` · `/hydra-auto-merge-window close` (`hydra-auto-merge-window.md:331,338`) | absent | none (dormant by design) |
| 4 | hydra-autopilot.md | hydra-autopilot | **B.** Launched by Pace Gate → `systemctl --user start hydra-autopilot.service` (`hydra-autopilot.md:896-905`; `scripts/systemd/hydra-pace-gate.timer:14`, every 15 min). Also operator `/hydra-autopilot` (`:861-866`). Carries `disable-model-invocation` (`hydra-autopilot.md:7`; rule at `scripts/sync-skills.sh:25-33`). | "operator says 'autopilot' … or a scheduled launch fires" (`hydra-autopilot.md:4`). | `/hydra-autopilot` or `claude --dangerously-skip-permissions -p "/hydra-autopilot"`. Slash-args `--scope= --tokens= --max-sec= --idle-turns= --subagent-soft= --subagent-hard= --unattended= --quota-5h-max= --quota-week-max=` (`hydra-autopilot.md:866-880`). | **Named**: `pages/Autopilot.jsx:64` renders `hydra-autopilot` in a `<code>` label in the "No autopilot run recorded yet" empty state. **Functional**: Runs list, NowConsole status verdict, Health autopilot chip. | Machine-facing: the Pace Gate timer decides admission (`hydra-autopilot.md:896-910`). Operator-facing: NowConsole `StopBanner` shows a hard stop (`pages/now-console/StopBanner.jsx:36-45`). Unit `OnFailure=hydra-notify-failure@%n.service` (`scripts/systemd/hydra-autopilot.service:8`). |
| 5 | hydra-branch-prune.md | hydra-branch-prune | **OI** for the skill. The underlying script is **timer-run**: `hydra-branch-prune.timer` `OnCalendar=*-*-* 04:00:00` → `branch-prune.sh --apply` (`scripts/systemd/hydra-branch-prune.timer:9`, `.service:12`). No class row. | Operator says "prune branches", or after the daily merge wave (`hydra-branch-prune.md:4`). | `/hydra-branch-prune`. The script itself: `scripts/branch-prune.sh [--audit\|--apply]` (`hydra-branch-prune.md:262-264`). | absent | Daily systemd timer (automatic). No operator-facing signal. |
| 6 | hydra-cleanup.md | hydra-cleanup | **B.** AD via `cleanup_orch` (cls:172; `decide.py:5561-5596`). OI via "operator says 'cleanup scan'". | Orchestrator board idle, or operator request (`hydra-cleanup.md:4`). | `/hydra-cleanup` (dry-run) · `/hydra-cleanup --apply` (`hydra-cleanup.md:314-315`) | DD-label only | AD: `orch_backfill_idle` unless `cleanup_board_saturated` (`decide.py:5593-5596`). Operator: none. |
| 7 | hydra-design-qa.md | hydra-design-qa | **B.** AD via `design_qa_target` (cls:205; `hydra-design-qa.md:53-60`). OI trigger phrase. | "periodic design-QA cadence is due", or operator request (`hydra-design-qa.md:4`). | `/hydra-design-qa` (no `arguments:` key) | DD-label only | AD: `design_qa_target_due`, 7-day cooldown (`hydra-design-qa.md:55-60`; `decide.py:5784`). Operator: none. |
| 8 | hydra-dev.md | hydra-dev | **B.** AD via `dev_orch` (cls:7). OI via "work on issue #N". | User wants to work on an orchestrator issue (`hydra-dev.md:4`). | `/hydra-dev <issue_number>` (`hydra-dev.md:6`) | DD-label only | AD: `orch_work_available` (`decide.py:4607`; `collect-state.sh:149`). Operator: none. |
| 9 | hydra-digest.md | hydra-digest | **B.** AD by autopilot **Phase 7**: `hydra-digest` is dispatched at run end for causes `{budget, quota, wall_clock, idle, failure_backstop}` and skipped on `context_compaction` (`hydra-autopilot.md:494`; `scripts/autopilot/drain.sh:7`). Not a class row. OI trigger phrases. **Partly stale**: cycle-era aggregates plus a "Codex" row (`hydra-digest.md:201,244`) and `hydra metrics` (`:24`). | User says "digest / summary / what happened" (`hydra-digest.md:4`). | `/hydra-digest` · `/hydra-digest 12h` · `/hydra-digest 7d` (`hydra-digest.md:298-300`) | absent. Today's `OvernightBanner` / `RecentMerges` are a separate `/today/summary` read (`pages/Today.jsx:38,68`), not this skill. | AD: run termination. The separate weekly Telegram digest *chore* (`src/scheduler/chores/weekly-digest.ts:1-10`) is not this skill. Operator: none. |
| 10 | hydra-discover.md | hydra-discover | **B.** AD via `discover_orch` (cls:117; `decide.py:5295-5342`). OI trigger phrases. **Partly stale**: Codex paths (`hydra-discover.md:217`) and `src/codex-runner.ts` (`:225`, file absent). | User says "discover / find improvements / patrol" (`hydra-discover.md:4`). | `/hydra-discover` (no `arguments:`) | DD-label only | AD: `orch_backfill_idle` (`decide.py:5333-5336`). Operator: none. |
| 11 | hydra-doctor.md | hydra-doctor | **B.** AD via `health` class (cls:84, cooldown 0; `decide.py:5159-5168`). OI trigger phrases. | User wants a health check / "fix hydra" (`hydra-doctor.md:4`). | `/hydra-doctor [focus]` (`hydra-doctor.md:6`) | absent. Health page lights come from `/health` and `/health/deep` (`pages/Health.jsx:89-90`), not from this skill. | AD: `health_fail`, derived from `health=FAIL` (`collect-state.sh:71`; `hydra-autopilot.md:1008`; `decide.py:5166`). Operator: none. |
| 12 | hydra-epic-close.md | hydra-epic-close | **OI** in practice. The playbook says it "belongs to the autopilot parent context or a manual operator invocation" (`hydra-epic-close.md:21`), but no class row, `decide.py` action or workflow invokes it (only `scripts/ci/epic-close.ts`, the classifier). | Operator says "close completed epics", or after a merge wave closes an epic's last sub-issue (`hydra-epic-close.md:4`). | `/hydra-epic-close [apply]` (`hydra-epic-close.md:7`) | absent | none |
| 13 | hydra-grill.md | hydra-grill | **B.** AD via `design_concept_orch` (cls:73; first in `pipeline_priority`, `decide.py:3264-3273`). OI ("Operator-interactive runs", `hydra-grill.md:310`). | Design concept needed before implementation, operator says "grill issue #N", or `needs-design-concept` label (`hydra-grill.md:4`). | `/hydra-grill <anchor> [scope]` (`hydra-grill.md:6`). Operator approval step: `bash scripts/autopilot/grill-artifact.sh approve <N> "operator:gabe"` (`hydra-grill.md:488`). | DD-label only | AD: `needs-design-concept` pipeline selection. Operator: none. |
| 14 | hydra-hitl-grill.md | hydra-hitl-grill | **OI only.** "never named in `scripts/autopilot/classes.json` and never dispatched by `/hydra-autopilot`" (`hydra-hitl-grill.md:30-31`). | Operator has time to drain parked ideas, or `/hydra-review` points here (`hydra-hitl-grill.md:4`). | `/hydra-hitl-grill [cluster]` (`hydra-hitl-grill.md:7`) | **Functional (unnamed)**: Work page "HITL grill inbox" lane is the lane's other write path (`components/pages/work/HitlGrillLane.jsx:81-90`; `hydra-review.md:403`). The skill name is never shown. | **Yes**: the lane shows a cap banner, "Cap reached — N ideas parked … Grill or dismiss to drain the lane." (`HitlGrillLane.jsx:92-99`). Machine-facing: `hitl_grill_open` / `hitl_grill_saturated` (`collect-state.sh:2228-2231`; `hydra-autopilot.md:1016-1017`). |
| 15 | hydra-incident.md | hydra-incident | **OI** in practice. It lists triggers "From `/hydra-doctor`" and "From `/hydra-autopilot` when P0 health fails" (`hydra-incident.md:16-17`), but neither is wired: no class row, no `decide.py` reference, and `hydra-doctor.md` never names it. **Stale trigger claims.** | Doctor finds a regression, a service crashes, or the user says "incident / what broke" (`hydra-incident.md:4`). | `/hydra-incident [context]` (`hydra-incident.md:6`) | absent | none (claimed doctor/autopilot hand-offs are not wired) |
| 16 | hydra-issue-research.md | hydra-issue-research | **B.** AD via `wayfinder_orch` (cls:227; note the class/skill name mismatch) and via hydra-sweep (`hydra-sweep.md:165`). OI "research issue #N". | User asks, issue has `needs-research`, or more context is needed (`hydra-issue-research.md:4`). | `/hydra-issue-research <issue_number>` (`hydra-issue-research.md:6`) | DD-label only | AD: `wayfinder_orch_frontier` (`collect-state.sh:590`; `decide.py:5854-5870`) and `needs_research` (`decide.py:4771`). Operator: none. |
| 17 | hydra-prd.md | hydra-prd | **B (as library).** Demoted to "a called renderer library, not a dispatch identity" (`CLAUDE.md:100`; `decide.py:5961-5967`). Called by hydra-research (`hydra-research.md:279-282`) and the hydra-tickets overlay. No class row. | A multi-issue finding needs to become tracked work; input is JSON (`hydra-prd.md:4`). | `/hydra-prd --input=<json>` · `/hydra-prd --apply --input=<json>` (`hydra-research.md:279,282`; `hydra-prd.md:7`) | absent | none |
| 18 | hydra-pr-rebase.md | hydra-pr-rebase | **OI** in practice. The playbook says it is safe to run from "cron, autopilot Phase 4, or manually" (`hydra-pr-rebase.md:13`), but the autopilot now does `update-branch` / `surface-pr` inline in `decide.py` (`decide.py:3138-3192`; `hydra-autopilot.md:106-107`) and never dispatches this skill. No cron exists. | Operator says "rebase PRs / unblock the merge queue", or after master leaves PRs behind (`hydra-pr-rebase.md:4`). | `/hydra-pr-rebase` (no `arguments:`) | absent | none for the skill. Machine-facing equivalent: `orch_prs_behind` / `orch_prs_dirty` (`hydra-autopilot.md:1030-1032`). |
| 19 | hydra-qa.md | hydra-qa | **B.** AD via `qa_orch` (cls:18). OI "QA issue #N". | User says "QA / verify", or `needs-qa` label (`hydra-qa.md:4`). | `/hydra-qa <issue_number>` (`hydra-qa.md:6`) | DD-label only | AD: `needs_qa_orch` (`decide.py:4358`). Operator: none. |
| 20 | hydra-research.md | hydra-research | **B.** AD via `research_orch` (cls:29). OI "research hydra". | User asks, or autopilot finds the orch board empty with capacity (`hydra-research.md:4`). | `/hydra-research [focus]` (`hydra-research.md:6`) | DD-label only | AD: pipeline selection. Operator: none. |
| 21 | hydra-retro.md | hydra-retro | **B.** AD via `retro_orch` (cls:161, 24h cooldown; `decide.py:5468-5520`). OI "retro". | User asks, or autopilot has a completed run (`hydra-retro.md:4`). | `/hydra-retro [run_id]` (`hydra-retro.md:73`) | **Functional (unnamed)**: NowConsole "Retrospectives" panel lists persisted retro artifacts from `/api/autopilot/retros` (`pages/now-console/RetroPanel.jsx:107-116`). | AD: `retro_run_available` / `retro_run_drillable` (`decide.py:5517-5519`). Operator: none. |
| 22 | hydra-review.md | hydra-review | **OI only.** "The operator's HITL cockpit". `claude_only`, no class row. The autopilot only *routes* PRs to its pickup set (`decide.py:2982`). It retires `/hydra-target-review` (`hydra-review.md:22`). | "what needs my attention", and the morning hand-off after `/hydra-autopilot --unattended=true` (`hydra-review.md:4`). | `/hydra-review` (no `arguments:`) | **Functional (unnamed)**: Today "Operator decision queue" unifies its inputs (`components/pages/today/OperatorDecisionQueue.jsx:6-10,36`), plus StuckItems / AttentionFeed. The command is never shown. | **Yes**: Telegram edge-triggered notify, "📥 Review queue — N items need attention / Run `/hydra-review` to triage." (`src/notify-format.ts:255-260`; chore `src/scheduler/chores/review-pickup-notify.ts:1-12`). Health rule text "open PRs are routed to /hydra-review" (`src/health/rules.ts:52`) is API-only, not rendered. |
| 23 | hydra-skill-prune.md | hydra-skill-prune | **B.** AD via `skill_prune` (cls:216, 7-day cooldown; `hydra-skill-prune.md:31-34`). "Runnable by hand". **Drift**: the playbook carries `disable-model-invocation: true` (`hydra-skill-prune.md:8`), but `sync-skills.sh:25-33` says only hydra-autopilot may carry it because a Skill-tool dispatch of a flagged skill hard-errors. | Orchestrator board idle, or operator says "skill prune" (`hydra-skill-prune.md:4`). | `/hydra-skill-prune [apply]` (`hydra-skill-prune.md:34`) | DD-label only | AD: `orch_backfill_idle` unless `skill_prune_board_saturated` (`decide.py:5842-5846`). Operator: none. |
| 24 | hydra-sweep.md | hydra-sweep | **B.** AD via `sweep_orch` (cls:95, 900 s). OI "sweep the board". **Partly stale**: `codex exec --skill …` alternatives (`hydra-sweep.md:134,160,165`; Codex retired per ADR-0006). | User says "sweep the board / process issues" (`hydra-sweep.md:4`). | `/hydra-sweep`, optionally under `/loop` (`hydra-sweep.md:3`) | DD-label only | AD: `needs_triage_orch` / `untriaged_orphans_orch` (`decide.py:5178,5247`). Operator: none. |
| 25 | hydra-target-build.md | hydra-target-build | **B.** AD via `dev_target` (cls:40). OI "build / ship". | User wants to build, fix or run a dev cycle (`hydra-target-build.md:4`). | `/hydra-target-build [task]` (`hydra-target-build.md:6`) | DD-label only | AD: `target_work_available` / `target_board_work_available` (`decide.py:4730-4731`). Operator: none. |
| 26 | hydra-target-cleanup.md | hydra-target-cleanup | **B.** AD via `cleanup_target` (cls:183; `hydra-target-cleanup.md:175`). OI phrase. | Target backlog idle, or operator request (`hydra-target-cleanup.md:4`). | `/hydra-target-cleanup` · `/hydra-target-cleanup --apply` (`hydra-target-cleanup.md:150-151`) | DD-label only | AD: `target_backfill_idle` (`decide.py:5633`). Operator: none. |
| 27 | hydra-target-discover.md | hydra-target-discover | **B.** AD via `discover_target` (cls:128). "Also dispatched by hydra-autopilot". | User says "target discover / production health" (`hydra-target-discover.md:4`). | `/hydra-target-discover` (no `arguments:`) | **Functional (unnamed)**: Today "New target findings" lists its output (`components/pages/today/NewTargetFindings.jsx:7` comment, `:20-26`). | AD: `target_idle` (`decide.py:5356`). Operator: none. |
| 28 | hydra-target-incident.md | hydra-target-incident | **B.** AD by the post-merge health watcher: `claude -p "/hydra-target-incident <context>"`, only when `HYDRA_PMH_DISPATCH=1` / `--dispatch` (`scripts/target/post-merge-health.ts:852-870,157`). Called from hydra-target-build Step 8.6 (`hydra-target-incident.md:41-49`). Not a class row. OI manual. | A Target regression, web-service crash or deploy failure (`hydra-target-incident.md:4`). | `/hydra-target-incident [context]` (`hydra-target-incident.md:6`) | absent | Automated alarm → dispatch (`post-merge-health.ts:1029`). Operator: none. |
| 29 | hydra-target-qa.md | hydra-target-qa | **B.** AD via `qa_target` (cls:51). OI "QA the target PR". | A Target build opens a PR (`hydra-target-qa.md:4`). | `/hydra-target-qa <pr_ref>` (`hydra-target-qa.md:6`) | DD-label only | AD: `needs_qa_target` (`decide.py:4428`). Hard findings route to `/hydra-review` via `reframe` + `ready-for-human` (`hydra-target-qa.md:210`). |
| 30 | hydra-target-research.md | hydra-target-research | **B.** AD via `research_target` (cls:62). OI. **Partly stale**: the description frames it as "instead of Codex agents" (`hydra-target-research.md:3,71`). | User wants a research cycle or reprioritisation (`hydra-target-research.md:4`). | `/hydra-target-research [focus]` (`hydra-target-research.md:6`) | DD-label only | AD: `target_research_due` / `target_board_research_due` (`decide.py:4805,4816`). Operator: none. |
| 31 | hydra-target-retro.md | hydra-target-retro | **OI** in practice. `when_to_use` claims "or hydra-autopilot wants to…" (`hydra-target-retro.md:4`), but no class row or `decide.py` selector dispatches it. Only a cost-bucket mapping exists (`scripts/autopilot/dispatch.sh:60`). | User says "target retro" (`hydra-target-retro.md:4`). | `/hydra-target-retro [run_id]` (`hydra-target-retro.md:44`) | absent | none |
| 32 | hydra-target-sweep.md | hydra-target-sweep | **B.** AD via `sweep_target` (cls:106, 900 s). OI. | User says "sweep target / process backlog" (`hydra-target-sweep.md:4`). | `/hydra-target-sweep` (no `arguments:`) | DD-label only | AD: `needs_triage_target` (`decide.py:5263`). Operator: none. |
| 33 | hydra-tickets.md | hydra-tickets | **B.** AD via `tickets_orch` (cls:238). OI "ticket this". | A resolved plan or finding needs tickets (`hydra-tickets.md:4`). | `/hydra-tickets` (no `arguments:`) | DD-label only | AD: `tickets_available` / `orch_backfill_idle` (`decide.py:5991,6074`). Operator: none. |
| 34 | hydra-tool-scout.md | hydra-tool-scout | **B.** AD via `scout_orch` (cls:139, 7-day cooldown; `trigger: calendar\|alert`). Manual invocations use `trigger: "manual"` (`hydra-tool-scout.md:28,44-46`). | Operator says "scout tools" (`hydra-tool-scout.md:4`). | `/hydra-tool-scout <category>` (`hydra-tool-scout.md:233`) | DD-label only | AD: `scout_walk_due` unless `scout_board_saturated` (`decide.py:5392,5409`). Operator: none. |
| 35 | hydra-wayfinder.md | hydra-wayfinder | **OI.** "Who runs this: the operator, interactively" (`hydra-wayfinder.md:27`). The AFK share is worked by the `wayfinder_orch` class, which dispatches **hydra-issue-research**, not this skill (cls:227; `hydra-wayfinder.md:28-30`). | A large, foggy initiative: "wayfind / chart a map" (`hydra-wayfinder.md:4`). | `/hydra-wayfinder [map] [ticket]` (`hydra-wayfinder.md:7`; Invocation §`:256`) | absent. Dashboard grep finds `wayfinder` only in source comments (`components/Versions.jsx:20`, `components/VersionBadge.jsx:11`, `lib/versions-format.ts:3`). | **Yes, indirect**: `/hydra-review` §0.5 prints "OPEN WAYFINDER MAPS (N) — run /hydra-wayfinder to work them" (`hydra-review.md:93,104-107`). |
| 36 | hydra-wire-or-retire.md | hydra-wire-or-retire | **B.** AD via `wire_or_retire_target` (cls:194, 24h; `hydra-wire-or-retire.md:47-53`). OI phrase. | The Target triage lane holds `wire-or-retire` + `needs-triage` items (`hydra-wire-or-retire.md:4,49-51`). | `/hydra-wire-or-retire` (`hydra-wire-or-retire.md:284`) | DD-label only | AD: `wire_or_retire_target_available` (`decide.py:5689`). **Operator (inside doctor report)**: the doctor kill-chain soft SLO emits `FLAG` when modules sit >30 days past grace, and the report "steer[s] `/hydra-wire-or-retire`" (`hydra-doctor.md:228,334`). |
| 37 | thermo-nuclear-code-quality-review.md | thermo-nuclear-code-quality-review | **OI only.** "Operator-invoked, full-repo architectural review" (`thermo-nuclear-code-quality-review.md:3`). Carries `disable-model-invocation: true` (`:5`) and has no class row. **Drift**: it is not `hydra-`-prefixed, and prior art does not list it as a mirror entry. | "Find the biggest reshapes this whole system needs" (`thermo-nuclear-code-quality-review.md:32-42`). | `/thermo-nuclear-code-quality-review [--pressure-points=N]` (`:69`) | absent | none |
| 38 | zoom-out.md | zoom-out | **OI only.** Carries `disable-model-invocation: true` (`zoom-out.md:5`). No class row. A generic 1-paragraph prompt, not Hydra-specific. | "unfamiliar with a section of code" (`zoom-out.md:3`). | `/zoom-out` | absent | none |

**Stale or retired markers in the population:**
- **Dormant:** #3 auto-merge-window (explicitly).
- **Stale trigger claims:** #15 hydra-incident (doctor/autopilot triggers not wired), #31 hydra-target-retro (autopilot trigger not wired), #12 hydra-epic-close and #18 hydra-pr-rebase ("autopilot parent context / Phase 4 / cron" not wired).
- **Retired-subsystem (Codex) residue:** #9 digest, #10 discover, #24 sweep, #30 target-research.
- **Frontmatter drift:** #23 skill-prune (`disable-model-invocation` on a dispatched skill).
- **Retired skill:** `/hydra-target-review` was retired into hydra-review (`hydra-review.md:22`) and has no playbook file.

### B. Non-skill operator procedures (hand-run commands in docs)

| # | Procedure | Source (docs tell operator) | Who runs it | Trigger condition | Exact invocation | Dashboard presence | Due-signal |
|---|---|---|---|---|---|---|---|
| B1 | **Deploy after a merge batch** | `CLAUDE.md:62` ("after the LAST merge of a batch settles … run `bash scripts/deploy.sh` once"). | Operator. Normally the CI `deploy` job on merge (`docs/reference.md:625`; `scripts/deploy.sh:4-6`). | Back-to-back merges cancelled the older deploy, so master is ahead of prod (`CLAUDE.md:62`). | `bash scripts/deploy.sh` | **Named/functional**: Health page "Deploy" block, "Drift — deployed vs origin/master" chip `IN SYNC`/`DRIFTED` with both SHAs (`components/pages/health/DeployAxes.jsx:58-63,80-110`). No command shown. | **Yes**: the DRIFTED chip. The watchdog logs `WARNING DRIFT … advisory only — run scripts/deploy.sh to converge` to the journal only (`scripts/hydra-watchdog.sh:693,697`); auto-deploy is opt-in via `HYDRA_WATCHDOG_AUTODEPLOY=1` (`:599-600`). The doctor renders the same drift as a finding with "Fix: run scripts/deploy.sh" (`hydra-doctor.md:55-66`). |
| B2 | **Deploy recipe (6 steps)** | `docs/reference.md:623-632` | CI deploy job (auto) | Every merge to master | pull → `npm ci` → `bash scripts/sync-skills.sh` → `cd dashboard && npm ci && npm run build` → `systemctl --user restart hydra-orchestrator.service` → `curl …/api/health` (`docs/reference.md:627-632`). Prior art notes the recipe omits flock / daemon-reload / health-poll (REF-25, `…inventory…md:225`). | DeployAxes (as B1) | as B1 |
| B3 | **Emergency manual deploy** | `docs/reference.md:643`; `CLAUDE.md` CI/CD "Never deploy by restarting the service without building the dashboard first". | Operator | Deploy failed or was cancelled | `./scripts/deploy.sh` (`docs/reference.md:643`; `scripts/deploy.sh:6`) | as B1 | as B1. `DEPLOY_FAILED` Telegram format exists (`src/notify-format.ts:245-246`). |
| B4 | **Service restart** | `CLAUDE.md:27`; Port-4000 pitfall `CLAUDE.md:79` | Operator. The watchdog also auto-restarts (`scripts/hydra-watchdog.sh:249-275`). | After a crash, or when the port is held (`CLAUDE.md:79`) | `systemctl --user restart hydra-orchestrator.service`; check `lsof -ti:4000` first | Functional: Health "Service" lights (api/redis/scheduler/systemd) (`pages/Health.jsx:150-180`). No restart control. | Watchdog restarts automatically (journal only). Health rule "Watchdog inactive → `systemctl --user start hydra-watchdog.timer`" (`src/health/rules.ts:199-202`) is in `/api/health/deep` diagnostics, which the dashboard does not render. |
| B5 | **Health checks** | `CLAUDE.md:35-36` | Operator | Ad hoc | `curl http://localhost:4000/api/health` · `curl http://localhost:4000/api/scheduler/status` | Health page reads the same `/health` (`pages/Health.jsx:89`) | n/a |
| B6 | **Autopilot pause / resume (total stop)** | `hydra-autopilot.md:964-967`; `docs/target-swap-runbook.md:41-43` | Operator | Stop *everything*: Claude AFK launches plus the GLM drainer (`hydra-autopilot.md:964`) | `curl -sf -X POST http://localhost:4000/api/autopilot/paused -H 'content-type: application/json' -d '{"paused":true}'` (`docs/target-swap-runbook.md:42-43`); `{"paused":false}` to resume | **Named control**: Health page Autopilot RUNNING/PAUSED chip plus a Pause/Resume button (`pages/Health.jsx:109-116,194-217`). NowConsole toggle (`pages/now-console/NowConsole.jsx:103-115`) and a PAUSED verdict (`status-verdict-state.ts:139-145`). | none (operator intent). |
| B7 | **Claude-only stop (pace-gate timer)** | `hydra-autopilot.md:965-973` | Operator | Cost emergency where the GLM free lane should keep shipping (`hydra-autopilot.md:967-972`) | `systemctl --user stop hydra-pace-gate.timer`; re-arm with `systemctl --user start hydra-pace-gate.timer` (`:965,973`) | absent (the Pause toggle is B6, a different lever) | StopBanner shows automatic 5h/weekly emergency stops (`StopBanner.jsx:36-45`), but not this lever. |
| B8 | **Manual autopilot launch / smoke** | `hydra-autopilot.md:866-876` | Operator | Ad hoc / smoke test | `claude --dangerously-skip-permissions -p "/hydra-autopilot"` (plus the `HYDRA_AUTOPILOT_TOKEN_BUDGET=… MAX_SEC=…` and `HYDRA_AUTOPILOT_SCOPE=orch-only` forms) | as row A4 | none |
| B9 | **Pace Gate install / migration** | `hydra-autopilot.md:928-945` | Operator (one-time); `deploy.sh` also does it each deploy (`:928-929`) | Fresh host or not relying on deploy | `install -D -m 0755 scripts/autopilot/pace-gate.sh ~/.local/bin/hydra-pace-gate.sh; cp scripts/systemd/hydra-pace-gate.{service,timer} ~/.config/systemd/user/; systemctl --user daemon-reload; systemctl --user enable --now hydra-pace-gate.timer` (`:939-943`) | absent | none |
| B10 | **Autopilot status inspection** | `hydra-autopilot.md:813-815,946-948` | Operator | Liveness doubts (`claude -p` buffers stdout, `:833`) | `bash scripts/autopilot/status.sh`; `cat /tmp/hydra-autopilot-heartbeat.txt`; `journalctl --user -u hydra-pace-gate.service` | Functional: NowConsole status verdict and run history | Watchdog AUTOPILOT WEDGE block (`scripts/hydra-watchdog.sh:409,474`); `OnFailure` notify (`hydra-autopilot.service:8`) |
| B11 | **Emergency brake on/off** | `bin/hydra:22,122-124`; rule `src/health/rules.ts:46-56` | Operator only | Incident: stop all auto-merge and route PRs to `/hydra-review` (`src/health/rules.ts:52`) | `hydra brake on\|off\|status` (`bin/hydra:22`) → `POST /api/autopilot/emergency-brake` | **Named control**: Health "Emergency brake" section with two-step confirm (`pages/Health.jsx:227-292`) | Health rule "When the incident is resolved: hydra brake off" (`src/health/rules.ts:54`), API diagnostics only |
| B12 | **Kill switch** | `src/health/rules.ts:36-39` | Operator | Kill switch file present | `rm ~/hydra/.kill` (after investigating) | absent | Health rule in `/api/health/deep` diagnostics (not rendered) |
| B13 | **Scheduler start/stop** | `docs/operations/watchdog.md:23-25`; `src/health/rules.ts:78-81` | Operator | Auto-stopped after errors, or a deliberate stop | `POST /api/scheduler/stop` (sets deliberate flag) · `POST /api/scheduler/start` | Health "scheduler" light (`pages/Health.jsx:168`) | Health rule "Check logs, then POST /api/scheduler/start" (`src/health/rules.ts:81`), API only. The watchdog restarts it when work is pending (`scripts/hydra-watchdog.sh:317-319`). |
| B14 | **sync-skills (skill-mirror regen)** | `docs/reference.md:629`; `scripts/sync-skills.sh:2-4,55-112`; sync-skills guard message "Regenerate from a throwaway origin/master worktree" (`scripts/sync-skills.sh:109`) | Deploy step (auto); operator for skill-only changes | Live `~/.claude/skills` diverges from the playbooks | `bash scripts/sync-skills.sh [--dry-run\|--force]` (`scripts/sync-skills.sh:47-49`), from an origin/master checkout | absent | **Yes (journal only)**: watchdog SKILL MIRROR DRIFT, `WARNING DRIFT — N skill(s) diverge … advisory only — run scripts/sync-skills.sh to converge` (`scripts/hydra-watchdog.sh:847,850`); auto-fix is opt-in (`HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX=1`, `:849`) |
| B15 | **Opt-in git post-merge hook** | `docs/reference.md:634` | Operator (one-time) | Setup | `bash scripts/setup-git-hooks.sh` (remove: `--remove`) | absent | none |
| B16 | **Claude worktree-write-fence hook install** | `hydra-autopilot.md:596-601` | Operator (one-time) | Setup | `bash scripts/setup-claude-hooks.sh` | absent | none |
| B17 | **Branch / worktree prune (script)** | `hydra-branch-prune.md:262-271` | Daily timer (auto); operator ad hoc | Stale `[gone]` branches / worktrees | `scripts/branch-prune.sh [--audit\|--apply]` | absent | Daily timer 04:00 (`scripts/systemd/hydra-branch-prune.timer:9`); no operator signal |
| B18 | **Stale test-process reaper** | `docs/operations/process-cleanup.md:50-90` | Hourly timer (auto); operator ad hoc | Leaked tsx/esbuild processes | `~/hydra/scripts/reap-stale-test-procs.sh --dry-run\|--apply [--max-age 60]` (`process-cleanup.md:70-76`) | absent | Hourly timer (`scripts/systemd/hydra-test-proc-reaper.timer:9`); none for the operator |
| B19 | **Redis backup install (host state)** | `docs/reference.md:558-586` | Operator (one-time) | Units are not committed (`:556`) | `install -m 0755 scripts/redis-backup.sh ~/.local/bin/hydra-redis-backup.sh` + unit files + `systemctl --user enable --now hydra-redis-backup.timer` (`:562-585`) | absent | `OnFailure=hydra-notify-failure@…` → Telegram (`docs/reference.md:552`). Prior art: redis-backup is not installed and the pg timer is disabled (REF-24, `…inventory…md:225`). |
| B20 | **Redis restore** | `docs/reference.md:588-620` | Operator | Data loss / volume corruption | 5-step stop → gunzip → `docker cp` → remove `appendonlydir` → start + `BGREWRITEAOF` → verify (`:591-620`) | absent | none |
| B21 | **Target swap** | `docs/target-swap-runbook.md:36-110` | Operator | Swapping the Target project | Step 0 pause autopilot (`:41-43`), Step 1 snapshot Redis, Step 2 env repoint, Step 3 reset Target-scoped keys (`:85-108`), … | absent | none |
| B22 | **Grill-artifact operator approval** | `hydra-grill.md:483-488` | Operator | Design concept failed the auto content-gate | `bash scripts/autopilot/grill-artifact.sh approve <N> "operator:gabe"` | absent | none |
| B23 | **Dependency / CVE scans** | `CLAUDE.md:53-54` | Operator ad hoc; advisory weekly CI | Audit | `npm run deps:check[:all]`; `bash scripts/osv-scan.sh` | absent | Weekly advisory workflows `deps-check.yml` cron `0 8 * * 1` (`.github/workflows/deps-check.yml:23`) and `osv-scan.yml` cron `15 8 * * 1` (`.github/workflows/osv-scan.yml:41`); artifacts only |
| B24 | **Account switch (`/login`)** | **Not documented as an operator procedure** in `docs/`, `CLAUDE.md` or `README.md`. Only code comments say the usage meter / eligibility gate "follows a `/login` to a different account automatically" (`src/cost/eligibility.ts:299`; `src/cost/eligibility-usage.ts:313,355`; `src/cost/oauth-usage.ts:73`). | Operator (undocumented) | Weekly or 5h quota stop | `/login` in a Claude Code session (no doc) | absent. StopBanner says "WEEKLY EMERGENCY STOP engaged … will not dispatch new work until the 7-day window resets" (`StopBanner.jsx:39-40`) and does not mention switching. | StopBanner (indirect) |

### C. Tallies

- **Who runs it (38 playbooks):**
  - **26 both**: the 22 class skills, plus hydra-autopilot (Pace Gate), hydra-digest (Phase 7), hydra-target-incident (post-merge-health watcher) and hydra-prd (called renderer).
  - **12 operator-interactive only**: architect, auto-merge-window, branch-prune (skill), epic-close, hitl-grill, incident, pr-rebase, review, target-retro, wayfinder, thermo-nuclear, zoom-out.
  - **0 autopilot-only.**
  - Four playbooks claim autopilot or doctor triggers that no code wires: incident, target-retro, epic-close, pr-rebase.
- **Dashboard presence (38 playbooks):**
  - **1 named** in user-visible UI: `hydra-autopilot`, in an empty-state `<code>` label (`pages/Autopilot.jsx:64`).
  - **4 more have an unnamed functional surface**: hitl-grill (Work lane), review (Today decision queue), retro (NowConsole RetroPanel), target-discover (Today NewTargetFindings).
  - 20 other class skills appear only as data-driven row labels.
  - **13 have nothing at all.**
  - **0 show an invocation or slash command anywhere in the dashboard.** The Today attention feed never recommends a procedure.
- **Operator-facing due-signal (38 playbooks):** **4**.
  - hydra-review: Telegram "Run `/hydra-review`".
  - hydra-hitl-grill: Work-lane cap banner.
  - hydra-wayfinder: `/hydra-review` §0.5 line.
  - hydra-wire-or-retire: doctor SLO FLAG.
  - The 22 class skills have **machine-facing** `collect-state` / `decide.py` triggers only. Branch-prune has a timer.
- **Non-skill procedures (24 rows):**
  - Dashboard control or indicator for **5**: deploy drift (B1–B3 share it), pause/resume (B6), emergency brake (B11), and service / scheduler lights (B4, B13).
  - Operator-facing due-signal for **3**: deploy (DRIFTED chip, plus watchdog journal and doctor), sync-skills (watchdog journal only), and the account-switch-adjacent StopBanner (indirect).

---

## 3. Operator-run scripts, CLIs, systemd units and timers

Researched against `5fded9547` (= origin/master), worktree `/home/gabe/hydra/.claude/worktrees/wayfinder-4418`. Read-only. Host facts (`systemctl --user …` read-only queries, 2026-09-22 ~10:56 PDT) are marked **[host]**; everything else is `path:line`.

Prior art, cited and not redone: `docs/research/2026-09-17-inventory-sources-of-truth-and-drift-tests.md` §2.9 (lines 215-227: the 14 tracked units, the 25 orchestrator/shared host units, 6 of them untracked, `bin/hydra`'s 11 subcommands, divergences REF-24/REF-25/REF-08) and §2.13 (lines 263-269: 14 housekeeping chores registered at `src/scheduler/housekeeping.ts:304`, with no dashboard reference).

### How the survey was done

- **Callers:** for each file under `scripts/` and `bin/`, I ran `git grep -l -F <basename>` across the repo, excluding `docs/research`, `docs/historical` and `CHANGELOG.md`. Hits were split by where they came from: `test/`, `package.json`, `.github/`, playbooks, and `src`/`scripts`.
- **Dashboard presence:** I grepped `dashboard/src/**` for each script and unit name, then traced the API routes that v3 pages poll with `useApi(`.
- **File counts:** `scripts/` has 22 top-level files and 13 subdirectories. `scripts/ci/` holds 64 files: 52 scripts plus 12 `*.json` baselines. `scripts/autopilot/` holds 24 entries: 23 files plus a `hooks/` directory with 3 scripts. `bin/` holds 2 files (`hydra`, `start.sh`).

---

### 3.1 Scripts

#### 3.1a Operator-relevant scripts (full rows)

"Dashboard" means v3 pages (`dashboard/src/pages/*`, `now-console/*`, `components/**`).

| script | what it does | who runs it (cite) | how to run by hand | dashboard presence | due-signal |
|---|---|---|---|---|---|
| `bin/hydra` | Thin CLI over the :4000 HTTP API with 11 subcommands. Includes `brake on/off/status`, the emergency brake at `bin/hydra:22-24,116-124`. | Operator shell. On PATH through the symlink `~/.local/bin/hydra -> ~/hydra/bin/hydra` **[host]**. Skills also call it (`bin/hydra:5-7`). | `hydra health`, `hydra brake status`, `hydra raw GET /api/...` | The brake is duplicated on the dashboard: Health.jsx POSTs the same `/autopilot/emergency-brake` route (`dashboard/src/pages/Health.jsx:118-127,227-229`). This contradicts the CLI comment "This CLI is the ONLY write path" (`bin/hydra:24`, repeated at `:119`). | none |
| `scripts/deploy.sh` | Deploys under an flock (`:19-21`). Steps: `npm ci` (`:45`), `sync-skills.sh` (`:60`), dashboard build (`:62-63`), install every host unit and script copy (`:73-175`), restart the orchestrator (`:178`), health-wait (`:200`), version tag via `scripts/ci/stamp-version.sh` (`:214`). | CI `deploy` job: `.github/workflows/ci.yml:403`. Also run manually (`scripts/deploy.sh:4-5`, `CLAUDE.md` CI/CD section). | `bash scripts/deploy.sh` from the `~/hydra` master checkout | Indirect. Health.jsx `DeployAxes` shows DRIFT and HEALTH axes computed from `/api/health` `deployedSha` and `originMasterSha` (`dashboard/src/components/pages/health/DeployAxes.jsx:58-63,91-106`; server side at `src/api/health.ts:115-123`). `/api/versions` deploy tags render in `Versions.jsx:231` (mounted on Today at `pages/Today.jsx:77`) and `VersionBadge.jsx:42`. | Watchdog DEPLOY DRIFT block, which only writes a log line (see §4). Doctor `deploy-drift-check.ts --text --alert` (`docs/operator-playbooks/hydra-doctor.md:55`). |
| `scripts/hydra-watchdog.sh` | Consolidated 2-minute watchdog. Six blocks: SERVICE LIVENESS `:32`, AUTOPILOT WEDGE `:409`, DEPLOY DRIFT `:565`, SKILL MIRROR DRIFT `:737`, NODE MODULES INTEGRITY `:890`, LAUNCH FLOW `:1132`. All are invoked from main at `:1676-1681`. | `hydra-watchdog.service` runs the installed copy `~/.local/bin/hydra-watchdog.sh` (`scripts/systemd/hydra-watchdog.service:8`), installed by `scripts/deploy.sh:84`. | `bash scripts/hydra-watchdog.sh`, or `journalctl --user -u hydra-watchdog.service` | Indirect only. The Health "systemd" light includes `watchdog` (the *timer* state) (`pages/Health.jsx:170-176` ← `src/health/fan-out.ts:302`). Signals the watchdog XADDs into `ALERT_TYPES` (`INFRA_NODE_MODULES_WIPED`, `LAUNCH_*`, `GLM_DRAINER_STERILE`; `src/notification/alert-grammar.ts:35-61`) have no v3 reader: no dashboard file fetches `/alerts` or `/v2/now/alerts` (grep returns 0). They reach the operator through the Telegram digest instead (`scripts/hydra-watchdog.sh:940-942,1403-1404`). | It is the due-signal for other things. For itself: the `/health/deep` rule "Watchdog inactive" (`src/health/rules.ts:194-205`). |
| `scripts/housekeeping.sh` | Pings `POST /api/maintenance/housekeeping` (`:20`), which runs the 14 chores. It is best-effort and never fails hard (`:14-17`). The header's "five time-boxed chores" (`:5-7`) is stale; the registry now has 14 (prior art §2.13). | `hydra-housekeeping.service` → `~/.local/bin/hydra-housekeeping.sh` (`scripts/systemd/hydra-housekeeping.service:8`), installed by `scripts/deploy.sh:109`. | `bash scripts/housekeeping.sh`, or `curl -X POST localhost:4000/api/maintenance/housekeeping` | absent. Prior art §2.13 found no `housekeeping` or `chores` hit in `dashboard/src`; my grep confirms 0 hits. | none. No watchdog block covers it, and the doctor Timer Health loop does not list it (§2). |
| `scripts/branch-prune.sh` | Janitor for `[gone]` branches and leaked worktrees (`:2-18`). Classification is delegated to `scripts/ci/branch-prune.ts` (`:20`). | `hydra-branch-prune.service` runs `--apply --log /tmp/hydra-branch-prune.log` (`scripts/systemd/hydra-branch-prune.service:12`). Also run by the `hydra-branch-prune` skill and `reap.py`. | `scripts/branch-prune.sh` (audit only, the default) / `--apply` (`:29-33`) | absent (0 dashboard hits) | none |
| `scripts/reap-stale-test-procs.sh` | SIGKILLs orphaned tsx/esbuild/`node --test` process groups older than N minutes that have no live parent (`:17-21`). | `hydra-test-proc-reaper.service` runs `--apply --max-age 30` (`scripts/systemd/hydra-test-proc-reaper.service:10`). | `scripts/reap-stale-test-procs.sh` (dry run, the default) / `--apply --max-age 60` (`:76-82`) | absent | none |
| `scripts/autopilot/pace-gate.sh` | Pace Gate admission check. It is the only launcher of `hydra-autopilot.service` (`:6-10,48`). `--exec-autopilot` is the service's ExecStart wrapper (`:161-163`). Each tick writes the Redis hash `hydra:autopilot:pace-gate:last-tick` (`src/redis/launch-flow.ts:74`). | `hydra-pace-gate.service` → `~/.local/bin/hydra-pace-gate.sh` (`scripts/systemd/hydra-pace-gate.service:9`). Also `hydra-autopilot.service:121`. Installed by `scripts/deploy.sh:151`. | `bash scripts/autopilot/pace-gate.sh` (one admission check) | Named. The `/now` StatusStrip shows a "next pace-gate check" countdown (`pages/now-console/StatusStrip.jsx:34-54`) from `/autopilot/idle-diagnostics`. That timestamp is an *estimate*, `now + interval`, not the timer's real next elapse (`src/aggregators/autopilot-idle.ts:107-121`). StopBanner shows the session-block window (`StopBanner.jsx:9,23`). | Watchdog LAUNCH FLOW reads the last-tick hash every 2 minutes (`scripts/hydra-watchdog.sh:1143-1160`). |
| `scripts/glm/drainer-loop.sh` (+ `drainer-driver.ts`) | GLM dev-drainer tick: flock → kill-switch → daily cap → authoring (`:2-11`). | `hydra-glm-drainer.service:9` | `bash scripts/glm/drainer-loop.sh` (needs `~/.config/hydra-glm/env`; see `hydra-glm-drainer.service:18`) | Indirect. A `glm-eligible` badge appears on Work BoardState (`components/pages/work/BoardState.jsx:228-230`). There is no drainer-status view. | Watchdog LAUNCH FLOW `glm-sterile` streak → `glm:drainer_sterile` alert (`scripts/hydra-watchdog.sh:1282-1286,1427-1431,1554`) |
| `scripts/redis-backup.sh` | Daily Redis BGSAVE, copied out to `/mnt/hydra-ssd/backups/redis/`, 7-day retention (`:1-19`). | Documented to run under host-only `hydra-redis-backup.{service,timer}` (`docs/reference.md:551,555,562-585`). **[host]** `hydra-redis-backup.timer` is `not-found` (never installed). The sibling `hydra-pg-backup.timer` is `disabled`. This matches prior art REF-24. | `bash scripts/redis-backup.sh`. Install recipe at `docs/reference.md:562-585`. | absent | none. So no Redis backup currently runs on a schedule **[host]**. |
| `scripts/sync-skills.sh` | Regenerates `~/.claude/skills/` from `docs/operator-playbooks/*.md` (`:2-7`). | `scripts/deploy.sh:60`. Also referenced by `.github/workflows/ci.yml` and `vendor-drift.yml`. The optional post-merge git hook from `setup-git-hooks.sh` also runs it (`scripts/setup-git-hooks.sh:4-8`). | `bash scripts/sync-skills.sh` (memory: run it from a throwaway origin/master worktree) | absent | Watchdog SKILL MIRROR DRIFT, which logs by default (`scripts/hydra-watchdog.sh:737-875`) |
| `scripts/deploy-drift-check.ts` | Compares deployed SHA with `origin/master`, reporting `--json`, `--text` or `--alert` (`:2-21`). `--alert` pushes a critical `hydra:alerts` entry (`:23,229`). | hydra-doctor Phase 1 (`docs/operator-playbooks/hydra-doctor.md:55`) | `npx tsx scripts/deploy-drift-check.ts --text` | Same data as Health DeployAxes, but that page does not run this script. The `hydra:alerts` it writes has no v3 reader. | It *is* a due-signal for the doctor. |
| `scripts/tool-currency-check.ts` | Checks whether installed tool versions are current against upstream (`--json`, `--table`, `--alert`) (`:2-20`). | hydra-doctor (`docs/operator-playbooks/hydra-doctor.md:153`) | `npx tsx scripts/tool-currency-check.ts --table` | absent | doctor only |
| `scripts/autopilot/status.sh` | Read-only snapshot: heartbeat plus wedge verdict, compact `state.json`, run-log tail (`:2-15`). | Operator. It is documented in `docs/operator-playbooks/hydra-autopilot.md:813,857`. No automated caller: its only non-test referrer is that playbook. | `bash scripts/autopilot/status.sh` | Indirect. The `/now` console polls `/autopilot/runs/current`, `/now/autopilot-health` and `/autopilot/inflight-slots` (`now-console/NowConsole.jsx:40,100-103`; `StatusStrip.jsx:77`). | none (it is itself the check) |
| `scripts/glm-beachhead-report.sh` | One-line keep/kill/expand readout for the GLM lane; `--ab-report` gives per-arm output (`:2-17`). | `hydra-review` runs it and surfaces the line (`:12-13`). Also referenced from `collect-state.sh`, `drainer-loop.sh` and `hydra-watchdog.sh`. | `scripts/glm-beachhead-report.sh [--ab-report]` | absent | none |
| `scripts/cost/weighted-quota-report.ts` | Ranks weekly-quota burn by weighted cost per dispatch kind and skill (`:2-15`). | Operator only. The only non-test referrers are `src/cost/*` comments (`src/cost/index.ts:101,119`). | `npx tsx scripts/cost/weighted-quota-report.ts [--json]` (`:54-58`) | Indirect: the Health CostPanel reads `/outcomes/quota` and `/metrics/cost-by-class` (`components/pages/health/CostPanel.jsx:68,117`), not this report. | none |
| `scripts/osv-scan.sh` | Advisory OSV CVE scan using a SHA-pinned binary (`:3-15`). | CI `osv-scan.yml:63`, on PR and weekly cron `15 8 * * 1` (`:41`) | `bash scripts/osv-scan.sh .` | absent | none. The result is only a CI artifact. |
| `scripts/audit-ghost-writes.py` | Scans subagent transcripts for Edit/Write calls outside the worktree (`:1-6`). | Operator forensic tool. Referenced in `docs/operator-playbooks/hydra-autopilot.md:603` and suggested by the `hydra-dev-parent-flow.md:380` WARN. | `python3 scripts/audit-ghost-writes.py` | absent | none |
| `scripts/setup-git-hooks.sh` / `scripts/setup-claude-hooks.sh` | One-time opt-in installers. The first installs git post-merge (sync-skills) and pre-commit (secret-scan) hooks (`setup-git-hooks.sh:2-17`). The second installs the Claude PreToolUse write fence (`setup-claude-hooks.sh:2-14`). | Operator, opt-in (`setup-git-hooks.sh:13-14`). Referenced in `docs/operator-playbooks/hydra-autopilot.md:600`. | `bash scripts/setup-{git,claude}-hooks.sh [--remove]` | absent | none |
| `scripts/cleanup/{reclassify-deferred-acs,retire-reflection-buffer,retire-specs}.sh` | One-shot Redis migrations and retirements (`reclassify-deferred-acs.sh:3-6`, `retire-reflection-buffer.sh:3-10`, `retire-specs.sh:3-7`). | Operator, one-shot. Referrers: `reclassify` → `docs/reference.md` only. `retire-specs` → ADR-0016 plus a comment in `src/redis/keys.ts`. `retire-reflection-buffer` has **no** referrer. | `bash scripts/cleanup/<x>.sh --dry-run` (e.g. `retire-reflection-buffer.sh:26-30`) | absent | none. These are likely candidates for "dead after run". |
| `scripts/otel/*.example*` + `README.md` | Host-side examples for Tempo, the OTel collector and a systemd drop-in. "Nothing here is auto-installed" (`scripts/otel/README.md:3`). | Operator copies them by hand. **[host]** `hydra-orchestrator.service.d/otel.conf` exists. | see README table (`:9-15`) | absent | none |
| `bin/start.sh` | **Dead.** It launches `node src/openai-proxy.mjs` (`bin/start.sh:30-32`), but that file does not exist. The live unit runs `node … dist/index.js` directly **[host]** (`hydra-orchestrator.service` ExecStart). Its only referrer is prose in `docs/target-swap-runbook.md:63`. | nobody | — | absent | — |

#### 3.1b Grouped: autopilot, skill, hook, CI and dev tooling (not operator-run)

- **Autopilot internals (`scripts/autopilot/`, 20 files plus 3 hooks):** `bootstrap.sh`, `collect-state.sh`, `decide.py`, `dispatch.sh`, `drain.sh`, `heartbeat.py`, `reap.py`, `reap_{ghrefs,stall,state}.py`, `recover-stale.sh`, `run_termination.py`, `self_heal.py`, `target-wip.py`, `term-check.py`, `assert_invariants.py`, `args-parse.sh`, `pr-refs.py`, `queue-decision.sh`, `grill-artifact.sh`, and `hooks/on-subagent-{stop,tool-call,permission-wait}.sh`.
  - Each is driven by the hydra-autopilot session per the phase table at `docs/operator-playbooks/hydra-autopilot.md:108-110,485-494`, or by a skill (`grill-artifact.sh` ← `hydra-grill`).
  - `classes.json` is data. `queue-decision.sh` writes the operator's daily decision-queue issue (`queue-decision.sh:2-5`).
  - Dashboard mentions exist only in comments: `pages/Autopilot.jsx:63` (`bootstrap.sh`) and `components/PipelineSnapshot.jsx:20` (`decide.py`).
- **Session hooks:**
  - `scripts/hooks/{session-start-capture,extract-dispatch-sentinel}.sh`, registered in `.claude/settings.json`.
  - `scripts/claude-hooks/worktree-write-fence.sh`, installed by `setup-claude-hooks.sh`.
- **Skill libraries:**
  - `scripts/hydra/footer.sh`, sourced by the discover, incident and research playbooks.
  - `scripts/reflection-deposit.sh`, run by hydra-dev fragments and `on-subagent-stop.sh`.
  - `scripts/sync-target-gate.sh` plus 8 `scripts/target/*.ts`, used in the hydra-target-build, -qa and -retro playbooks.
- **`scripts/ci/` (52 scripts):**
  - 29 are referenced from `.github/workflows/*`.
  - 15 are referenced only from playbooks (skill-run renderers and emitters: `hydra-*-emit/render`, `epic-close`, `pr-rebase`, `issue-dedup`, `branch-prune{,-runner}`, `target-route-crawl`, …).
  - 8 have neither kind of referrer. Five of those are helpers called by other scripts: `derive-version-bump.ts` and `stamp-version.sh` ← `deploy.sh:214`; `wait-for-health.sh` ← `deploy.sh:200`; `hydra-emit-shell.ts` ← `hydra-cleanup-emit.ts:57`; `design-concept-reconcile-check.ts` ← `design-concept-reconcile-run.ts:50`.
  - Two are test-only guards: `signal-parity-check.ts` ← `test/decide-signal-classes.test.mts:41`, and `test-subject-map.ts` ← `test/test-file-sprawl-guard.test.mts:52`.
  - One has no runtime caller: `mechanical-check.ts`. It is referenced only by its own test and a comment in `design-concept-reconcile-check.ts:36`.
- **Dev tooling:** `scripts/{ast-search,probe-search}.ts` (npm scripts), `scripts/tier-classify.ts` (ci.yml / deep-qa-gate.yml), `scripts/test/{redis-db-launch,suite-count-check}.mjs` (npm `test*`), `scripts/comby-rules/*.toml` (`advisory-checks.yml:126-131`), and `scripts/deploy-drift-logic.ts` / `tool-currency-logic.ts` (pure halves of the drivers above).

---

### 3.2 Systemd units in `scripts/systemd/` (plus host-only units named in `docs/reference.md`)

| unit | what it runs | schedule | installed by | dashboard presence | due / failure signal |
|---|---|---|---|---|---|
| `hydra-watchdog.{service,timer}` | `~/.local/bin/hydra-watchdog.sh` (`.service:8`) | `OnBootSec=2min`, `OnUnitActiveSec=2min` (`.timer:6-7`) | `deploy.sh:84,95-98` | **Named.** It is one of the three keys behind the Health "systemd" light (`pages/Health.jsx:170-176`; probe `src/health/fan-out.ts:302`, `serviceStatus("hydra-watchdog.timer")`). | `/health/deep` rule "Watchdog inactive" → `systemctl --user start hydra-watchdog.timer` (`src/health/rules.ts:194-205`) |
| `hydra-pace-gate.{service,timer}` | `~/.local/bin/hydra-pace-gate.sh` (`.service:9`) | `OnBootSec=5min`, `OnUnitActiveSec=15min` (`.timer:13-14`) | `deploy.sh:151,160-161,175` | Indirect. The `/now` StatusStrip countdown is estimated from the interval (`src/aggregators/autopilot-idle.ts:107-121`). The unit's state is not probed. | Watchdog LAUNCH FLOW (last-tick hash; `scripts/hydra-watchdog.sh:1143-1160`) |
| `hydra-autopilot.service` | `hydra-pace-gate.sh --exec-autopilot` (`:121`), with `RuntimeMaxSec=32400` (`:46`) and `Restart=on-failure` (`:157`) | none. It is launched only by the pace gate (`pace-gate.sh:6-10`). **[host]** `is-enabled=disabled`, `active`. | `deploy.sh:172` | Indirect. `/now` console run state; Health autopilot RUNNING/PAUSED chip and pause/resume (`pages/Health.jsx:15,105`); per-run journal slice via `/api/autopilot/runs/:id/journal` (`components/LogsSection.jsx:12,114`; unit name `src/journal/exec.ts:107`). | `OnFailure=hydra-notify-failure@%n.service` → Telegram (`hydra-autopilot.service:8`). Watchdog AUTOPILOT WEDGE kills a stale-heartbeat process (`scripts/hydra-watchdog.sh:425-434,550`). |
| `hydra-notify-failure@.service` | A bash `curl` to the Telegram sendMessage API (`:22-27`) | on demand (OnFailure template) | `deploy.sh:73` | absent | This is the failure signal itself. In the repo, only `hydra-autopilot.service:8` wires `OnFailure=` to it. The host-only redis-backup recipe also references it (`docs/reference.md:568`). |
| `hydra-housekeeping.{service,timer}` | `~/.local/bin/hydra-housekeeping.sh` (`.service:8`) | `OnCalendar=hourly`, `Persistent=true` (`.timer:6-7`) | `deploy.sh:109-111` | absent | none |
| `hydra-test-proc-reaper.{service,timer}` | repo `scripts/reap-stale-test-procs.sh --apply --max-age 30` (`.service:10`) | `OnCalendar=hourly` (`.timer:9`) | `deploy.sh:122-125` | absent | none |
| `hydra-glm-drainer.{service,timer}` | repo `scripts/glm/drainer-loop.sh` (`.service:9`); `EnvironmentFile=-~/.config/hydra-glm/env` (`:18`) | `OnBootSec=5min`, `OnUnitActiveSec=15min` (`.timer:11-12`) | `deploy.sh:140-143` | Indirect: `glm-eligible` badge only (`BoardState.jsx:228-230`) | Watchdog `glm-sterile` → `glm:drainer_sterile` (`scripts/hydra-watchdog.sh:1431`) |
| `hydra-branch-prune.{service,timer}` | repo `scripts/branch-prune.sh --apply` (`.service:12`) | `OnCalendar=*-*-* 04:00:00`, `Persistent=true` (`.timer:9-10`) | **not** by `deploy.sh` (no match). Installed by hand per `docs/operator-playbooks/hydra-branch-prune.md:274-280`. **[host]** `enabled`/`active`. | absent | none |
| `hydra-orchestrator.service` (host-only, untracked; prior art §2.9) | `node --max-old-space-size=4096 --import ./dist/instrument.js dist/index.js` **[host]** | long-running | not tracked. `deploy.sh:178` restarts it. | **Named.** It is a key of the Health "systemd" light (`fan-out.ts:301`) and the `orchestrator` row of the service strip (`src/health/strip-probes.ts:103-108`). The Health "api" light is fed from `/health/deep` (`pages/Health.jsx:166`). | Watchdog SERVICE LIVENESS restarts it (`scripts/hydra-watchdog.sh:169,250-275,368`) |
| `hydra-redis-backup.{service,timer}` (host-only, per docs) | `~/.local/bin/hydra-redis-backup.sh` (`docs/reference.md:563,571`) | daily 03:15 (`docs/reference.md:551`) | manual recipe (`docs/reference.md:562-585`). **[host]** timer `not-found`. | absent | none |
| `hydra-pg-backup.{service,timer}` (host-only, Target) | host script (`docs/reference.md:550`) | daily 03:00 | host. **[host]** timer `disabled`. | absent | none |

#### Service strip versus the Health "systemd" light

These are two separate surfaces.

- **Service strip:** `GET /api/v2/now/service-strip` (`src/api/now-page.ts:157-167`) enumerates only `orchestrator` and `redis` (`src/health/strip-probes.ts:103-114`). The vikingdb, openviking and embed-backend rows were removed (`:115-116`). The strip lists **no systemd units**, and **no `dashboard/src` file consumes the route** (0 grep hits).
- **Health "systemd" light:** this is the only v3 surface that reads unit state. It is one boolean over `orchestrator`, `watchdog` and `targetWeb` from `/health/deep` `infrastructure.systemd` (`pages/Health.jsx:170-178`; `src/health/fan-out.ts:301-303`). None of `pace-gate`, `housekeeping`, `test-proc-reaper`, `glm-drainer`, `branch-prune` or `autopilot` is probed.

#### Timer freshness

The code path exists: the `wiring-liveness` chore checks `type: timer` entries, flagging STALE when a timer is older than `maxStaleMinutes` (`src/scheduler/chores/wiring-liveness-timer.ts:192,226`). It covers nothing today, because the manifest `config/direction/liveness.yaml` is empty by design after the Target mothball (`:40-46,52`). No orchestrator timer is declared there.

#### The doctor's Timer Health loop checks the wrong timers

The loop `for timer in hydra-betting-ingest hydra-betting-scan hydra-checkpoint-refresh` (`docs/operator-playbooks/hydra-doctor.md:288-295`) checks **none** of the 7 in-repo timers.

The doctor catches only *failed* hydra services, through a generic list (`:159-160,299`). A timer that is disabled or has never fired, like the redis-backup timer, is invisible to it.

---

### 3.3 npm scripts intended for operators (`package.json`)

| script | line | what it does | also run by |
|---|---|---|---|
| `test` | `:14` | full suite, `HYDRA_FULL_SUITE=1`, with the suite-count FILE-SET gate | CI `ci.yml` |
| `test:debug` | `:15` | spec reporter plus a `test-debug.tap` sink, concurrency 1 | — |
| `test:file` | `:16` | single-file or multi-file run with per-run Redis DB isolation | GLM drainer allow-list (CLAUDE.md) |
| `typecheck` / `typecheck:test` | `:17` / `:18` | `tsc --noEmit` / test-file typecheck ratchet | `test-typecheck.yml:45` |
| `ast-search` | `:33` | exact AST search (`scripts/ast-search.ts`) | advisory-checks.yml |
| `probe-search` | `:34` | fuzzy BM25 block search | — |
| `ast-grep-scan` | `:35` | runs the `src/ast-grep-rules/` lint rules | advisory-checks.yml |
| `eval` / `eval:ts` | `:36` / `:37` | promptfoo evals (`evals/golden.yaml` / `evals/hydra-dev.yaml`) | advisory-checks.yml eval-gate step (`:184-185`) |
| `deps:check` / `deps:check:all` | `:40` / `:41` | taze@19 staleness JSON (scan only) | `deps-check.yml:44`, weekly cron `0 8 * * 1` (`:23`) |
| `vendor:drift` | `:42` | vendored Pocock-base drift check | vendor-drift.yml |
| `qa:catch-rate` | `:32` | QA catch-rate report (`scripts/ci/qa-catch-rate.ts`) | a playbook reference |
| `stryker:scan` | `:30` | comparison-only mutation scan | `stryker-check.yml:95` |
| `dev` / `start` / `build` | `:13` / `:12` / `:11` | watch-mode dev server / `tsc && node dist` / `tsc` | — |

The `*-seam-check`, `coupling-check`, `dep-boundary-check`, `biome-check`, `lockfile-lint` and `allow-scripts` scripts are CI and dev gates, not operator tools.

The `bash scripts/osv-scan.sh` entry point has no npm alias.

Doc drift: `CLAUDE.md` names standalone `eval-gate`, `ast-grep-lint` and `comby-check` workflows. At this commit they are steps inside `.github/workflows/advisory-checks.yml` (`:6-7,30,126,184`), and no such workflow files exist (`ls .github/workflows`).

---

### 3.4 Does the watchdog alarm on deployed-SHA drift? Both claims are partly true

- **The watchdog does check SHA drift.** `run_deploy_drift()` (`scripts/hydra-watchdog.sh:633`) runs every 2 minutes (`:1678`). It compares `git rev-parse HEAD` with `git ls-remote origin master` (`:565-580,645-668`) and on drift logs `WARNING DRIFT — deployed=… != origin/master=…` (`:693`). That falsifies the CLAUDE.md premise "the watchdog checks health, not SHA drift".
- **It raises no alarm.** The block is "Advisory by default … a WARNING log line ONLY (visible in journalctl)" (`:595-600`). It returns right after logging unless `HYDRA_WATCHDOG_AUTODEPLOY=1` (`:695-698`), and that variable is set nowhere in `scripts/systemd/`, `docs/reference.md` or `docs/operations/` (grep returns 0). There is no XADD, Telegram message or `hydra:alerts` write inside `run_deploy_drift` (`:633-735`); only the LAUNCH FLOW and NODE MODULES blocks emit those. So CLAUDE.md's "with **no alarm**" wording holds.
- **Operator memory ("#734 exists, log-only") is accurate.** The doctor playbook itself says the watchdog's "journald WARN is invisible to a `hydra doctor` reader" (`docs/operator-playbooks/hydra-doctor.md:58-62`).
- **Where drift is visible:**
  - doctor `deploy-drift-check.ts --alert`, which pushes a critical `hydra:alerts` entry (`scripts/deploy-drift-check.ts:23`) that no v3 page reads;
  - the Health page DRIFT axis (`DeployAxes.jsx:58-63`), shown only when someone is looking at it.

#### Watchdog checks left over from the mothballed Target

- SERVICE LIVENESS Check 5 still warns on `hydra-betting-{ingest,scan,alerts}` failures (`scripts/hydra-watchdog.sh:382-388`).
- Check 6 probes Kalshi credentials at `:3333` every hour (`:390-401`).

The Target was mothballed per the memory note `reference_autopilot_scope_orch_only_dropin`, and the doctor loop above has the same staleness.

---

## 4. Operator-set env vars and config files, both projects

Worktree `5fded9547` (= origin/master). Host files read-only on 2026-09-22. Secret **values** are omitted throughout; only names are listed. Prior art is cited, not repeated: `docs/research/2026-09-17-inventory-sources-of-truth-and-drift-tests.md` §2.5 (config tree, `CONFIG_SECTIONS`) and §2.11 (env var sprawl, 10 dead `.env.example` names).

**Scope rule applied.** A row is included when an operator playbook (`docs/operator-playbooks/*.md` incl. `_fragments/`), `docs/reference.md`, `CLAUDE.md`, or the hydra-doctor playbook says the operator sets or changes it. Operator-owned systemd drop-ins and EnvironmentFiles on this host are also included. §4.6 lists the candidates that were excluded.

### 4.0 Premise corrections

- **Autopilot scope is `all`, not orch-only.** `~/.config/systemd/user/hydra-autopilot.service.d/scope.conf:61` sets `HYDRA_AUTOPILOT_SCOPE=all`. Its comment at `:60` reads "2026-09-16: CSB swap landed (hydra#4313 checklist C8 …). Scope back to both lanes." The 2026-09-01 orch-only pin (`:50-57`) was superseded.
- **The Target is claw-street-bets.** `~/.config/hydra/target.env` sets `HYDRA_TARGET_NAME=claw-street-bets`, `HYDRA_PROJECT_WORKSPACE=/home/gabe/claw-street-bets`, `HYDRA_TARGET_GITHUB_REPO=gaberoo322/claw-street-bets` and `HYDRA_TARGET_REPO=/home/gabe/claw-street-bets`. The code defaults agree: `src/target-config.ts:28-29`.
- **`docs/reference.md` Target defaults are stale.** `:150` documents the `HYDRA_TARGET_NAME` default as `hydra-betting`, and `:151` documents `gaberoo322/hydra-betting`. Code is `claw-street-bets` (`src/target-config.ts:28-29`).
- **#4424 resolution on `/api/config` and `/api/env`** (issue comment, `gh api repos/gaberoo322/hydra/issues/4424/comments`):
  - `PUT /config/:section/:name` moves to the **machine exclusion list**. Reason: it writes tracked files in the prod checkout and trips the deploy dirty-tree guard, and its only callers are skills.
  - `PUT /env/:project` and `DELETE /env/:project/:key` are marked **Retire**: zero callers, Bearer-gated, ADR-0005 credential class.
  - Consequence: #4420 `config-env` entries **stay hand-off** (file link plus a copyable line).
  - As of `5fded9547`, all three routes are still mounted: `src/api/config.ts:76`, `:119`, `:140`. They are also still listed `stable` in `src/api/ENDPOINT-REGISTRY.md:199-204`.

### 4.1 `/api/config` and `/api/env` — what they expose

| Route | Cite | Exposes / edits | Auth | Dashboard |
|---|---|---|---|---|
| `GET /api/config/:section` | `src/api/config.ts:47` | lists `*.md` in `config/{agents,feedback,direction,research}` (`src/api/config-io.ts:111-116`). `agents/` and `feedback/` do not exist on disk, so the call returns `[]` (§2.5). `.yaml`, `orchestrator/` and `glm/` are unreachable | none | absent (no `useApi("/config…")` in `dashboard/src`) |
| `GET /api/config/:section/:name` | `src/api/config.ts:59` | raw text of one `.md` | none | absent |
| `PUT /api/config/:section/:name` | `src/api/config.ts:76` | overwrites one tracked `.md` in the prod checkout | none | absent. #4424 lists it as machine-excluded |
| `GET /api/env/:project` | `src/api/config.ts:103` | `hydra` → `~/hydra/.env`, `<targetName>` → `<workspace>/.env.local` (`:91-94`). Values are masked unless `?reveal=1` (`:110-114`) | Bearer `CRON_SECRET` (`:96-100`) | absent |
| `PUT /api/env/:project` | `src/api/config.ts:119` | upserts a key | Bearer | absent. #4424: retire |
| `DELETE /api/env/:project/:key` | `src/api/config.ts:140` | removes a key | Bearer | absent. #4424: retire |

**Observed on this host: all `/api/env/*` routes return 401 unconditionally.** The guard rejects whenever the secret is empty (`src/api/config-io.ts:83`: `if (!secret || token !== secret)`). `CRON_SECRET` is not set in any source:
- not in `~/hydra/.env`
- not in the unit or its drop-ins
- not in the running orchestrator's `/proc/<pid>/environ`

### 4.2 Orchestrator (`~/hydra`) — files the operator edits

| name | project | where set (cite) | read by (cite) | referenced by (cite) | dashboard | due-signal |
|---|---|---|---|---|---|---|
| `config/direction/vision.md` | orch (Target vision) | tracked file | `src/project-goals.ts:241` (North-Star prompt section); `config/direction/vision.md` is byte-identical to `~/claw-street-bets/direction/vision.md` (`cmp`) | `docs/reference.md:535` ("Operator edits these"); `hydra-target-research.md:24`; `hydra-architect.md:131` | absent | none |
| `config/direction/outcomes.yaml` | orch | tracked file | `src/outcomes.ts:47` (`DEFAULT_OUTCOMES_FILE`); holdback `src/holdback.ts:93,190` | `docs/reference.md:88,370,398,536`; `hydra-qa.md:1268` | shown: `/builder` OutcomeCards (`dashboard/src/components/pages/outcomes/OutcomeCards.jsx:18,38`), empty-state text names the file | none (the empty-state text on the card is the only cue) |
| `config/direction/priorities.md` | orch (mirror of Target doc) | tracked file; refreshed by PR copy from `$HYDRA_TARGET_REPO/direction/` | `src/api/recommendations.ts:46`; `collect-state.sh:130` (`direction_drift`) | `docs/reference.md:537`; `hydra-target-build.md:207-225` (refresh recipe); `hydra-architect.md:133` | indirect: `/work` AnchorRationale label "Priorities doc" (`dashboard/src/components/pages/work/AnchorRationale.jsx:31`) | `direction_drift` collector (`scripts/autopilot/collect-state.sh:122-143`); no `decide.py` consumer (grep 0). Today the orch copy and `~/claw-street-bets/direction/priorities.md` **differ** (`cmp`). `roadmap.md` is absent from `config/direction/`, so its half of the check can never fire (`:135` requires both files readable). `cycle:stale_priorities` (`src/event-bus-vocabulary.ts:51`) is rendered by the digest (`src/digest-format.ts:187-189`) but has no emitter in `src/` |
| `config/orchestrator/vision.md` | orch (self vision) | tracked file | none in loop code, as the playbook itself states (`hydra-autopilot.md:370-371`); the prompt applies its § Trade-offs (`:377`) | `docs/reference.md:537`; `CLAUDE.md` Documentation Map | absent | none |
| `config/research/*.md` (6) | orch | tracked files | `GET /api/config/research` only (`config-io.ts:111-116`); no `src/` reader (grep 0) | `docs/reference.md:539` | absent | none |
| `config/direction/goals.md` | orch | **deleted** | — | `docs/reference.md:538` still lists it (REF-23) | absent | none |
| `~/hydra/.env` | orch | orchestrator unit `EnvironmentFile=/home/gabe/hydra/.env` (`~/.config/systemd/user/hydra-orchestrator.service:15`) | see §3 | `README.md:101` (edit `.env`); `GET /api/env/hydra` (401 today, §1) | absent | none |

### 4.3 Orchestrator env vars (operator-set)

Names only. "Set in" is the live host location.

| name | project | where set (cite) | read by (cite) | referenced by (cite) | dashboard | due-signal |
|---|---|---|---|---|---|---|
| `HYDRA_AUTOPILOT_SCOPE` | orch | `hydra-autopilot.service.d/scope.conf:61`; per-run `--scope=` | `scripts/autopilot/bootstrap.sh:808` (default `all`) | `hydra-autopilot.md:874` | absent (no scope read in `dashboard/src`) | none |
| `HYDRA_AUTOPILOT_QUOTA_5H_MAX` | orch | `scope.conf:64` | `bootstrap.sh:759` (default 0 = off) | `hydra-autopilot.md:540` | indirect: the 5h burn it caps shows in `/now` UsagePanel (`dashboard/src/pages/now-console/UsagePanel.jsx:78`); the cap itself is absent | none (termination is logged by `decide.py`) |
| `HYDRA_AUTOPILOT_QUOTA_WEEK_MAX` | orch | `scope.conf:63` | `bootstrap.sh:760` | `hydra-autopilot.md:541` | indirect, as above | none |
| `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD` | orch | `scope.conf:62` (kept deliberately at 0, `:40-43`) | `bootstrap.sh:804` (default 50.0) | `_fragments/hydra-autopilot-ops-reference.md:237` | absent | none. USD gates are "structurally $0" (`scope.conf:40-43`) |
| `HYDRA_AUTOPILOT_TOKEN_BUDGET`, `HYDRA_AUTOPILOT_MAX_SEC` | orch | per-run env / slash-args | `bootstrap.sh:732-733` | `hydra-autopilot.md:872` | absent | none |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | host (claude CLI) | tracked unit `scripts/systemd/hydra-autopilot.service:89` (installed copy identical) | the Claude Code CLI; coupled to the `decide.py` wedge cap | `hydra-autopilot.md:294-300` | absent | none |
| `HYDRA_USAGE_WEEKLY_QUOTA_TOKENS`, `HYDRA_USAGE_5H_QUOTA_TOKENS` | orch | `hydra-orchestrator.service.d/usage-quota.conf:56-57` | `src/cost/config.ts:159-165` | `CONTEXT.md:206` (outside the scope-rule doc set); `src/cost/eligibility-usage.ts:31` | indirect: `/health` CostPanel "meter uncalibrated" (`dashboard/src/components/pages/health/CostPanel.jsx:122,149`) | `logger.error` on a set-but-bad value (contract `src/cost/config.ts:18`); log only |
| `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` | orch | `usage-quota.conf:83` | `src/cost/config.ts:316-317` → `eligibility-usage.ts:193` | none in the scope-rule docs (ADR-0021) | indirect: `/now` UsagePanel pace curve (`UsagePanel.jsx:19`) | log on an unparseable value (`src/cost/config.ts:308-314`) |
| `HYDRA_USAGE_WEEKLY_PACE_CEILING` | orch | `usage-quota.conf:84` | `src/cost/config.ts:442-443` | `CONTEXT.md:226` | indirect: `/now` UsagePanel | log on a bad value (`src/cost/config.ts:431-434`) |
| `HYDRA_EXTRA_USAGE_POLICY` | orch | `hydra-orchestrator.service.d/extra-usage-policy.conf:16` (live `allow`) | `src/cost/config.ts:576-577` → `src/cost/eligibility-usage.ts:365` | `_fragments/hydra-autopilot-ops-reference.md:242` | absent. StopBanner reads only `sessionBlockedUntil` / `emergencyStop` / `weeklyEmergencyStop` (`dashboard/src/pages/now-console/StopBanner.jsx:27-31`) | none |
| `HYDRA_USAGE_5H_THROTTLE_T1`, `_T2`, `HYDRA_USAGE_EMERGENCY_STOP_PERCENT` | orch | unset (defaults) | `src/cost/config.ts:530,542,603` | `_fragments/hydra-autopilot-ops-reference.md:240-243` | emergency stop shown via StopBanner (`StopBanner.jsx:28-43`); thresholds absent | log on a bad value |
| `HYDRA_TARGET_NAME` | orch→target | `~/.config/hydra/target.env` via `EnvironmentFile=%h/.config/hydra/target.env` in `hydra-orchestrator.service.d/target.conf:3`, `hydra-autopilot.service.d/target.conf:3`, `hydra-pace-gate.service.d/target.conf:3` | `src/target-config.ts:51` | `docs/reference.md:145,150` (stale default) | shown: sidebar VersionBadge project name (`dashboard/src/components/VersionBadge.jsx:42,66` ← `src/versions/project-list.ts:71`); target unit probe in `/health` (`dashboard/src/pages/Health.jsx:90` ← `src/health/fan-out.ts:259`) | one-time `console.warn` on fallback (`src/target-config.ts:53-56`) |
| `HYDRA_PROJECT_WORKSPACE` (legacy `HYDRA_WORKSPACE`) | orch→target | `target.env` | `src/target-config.ts:73,76` | `docs/reference.md:149,152`; `README.md:101` | indirect: VersionBadge reads that root (`project-list.ts:71`) | one-time warn (`src/target-config.ts:78-90`) |
| `HYDRA_TARGET_GITHUB_REPO` | orch→target | `target.env` | `src/target-config.ts:123`; `scripts/autopilot/collect-state.sh:116,387`; `scripts/autopilot/reap_ghrefs.py:60` | `docs/reference.md:151`; `hydra-review.md:152,205,211` | absent | stderr "target seam unresolved" (`collect-state.sh:117-118`) |
| `HYDRA_TARGET_REPO` | orch→target | `target.env` | `collect-state.sh:127`; `scripts/branch-prune.sh:610` (default **`$HOME/hydra-betting`**) | `hydra-target-build.md:212-213,224` | absent | none. The `hydra-branch-prune.service` unit has no target drop-in and sets only `HYDRA_ROOT` (unit `:10`), so branch-prune's target pass defaults to the mothballed repo (`branch-prune.sh:610`) |
| `HYDRA_TARGET_WEB_URL` | orch→target | `target.env` | `src/target-config.ts:163` (legacy `HYDRA_BETTING_URL` `:166`) | none in the scope-rule docs (REF-18 in §2.11) | absent | none |
| `HYDRA_OTEL_ENABLED`, `OTEL_INGEST_KEY` | orch | `/etc/hydra/otel.env` via `hydra-orchestrator.service.d/otel.conf:5` (`EnvironmentFile=-…`) | `src/api/observability.ts:40` | `docs/reference.md:200,226-231,277-300` (section marked "historical", `:173`) | absent | none |
| `HYDRA_TRACE_UI_URL` | orch | unset | `src/api/observability.ts:44,60` | `docs/reference.md:251,258` | absent | none |
| `HYDRA_WORKLESS_BACKOFF_SEC`, `_POSTWORK_SEC` | orch | unset | `src/redis/workless-hint.ts:94,115` | `hydra-autopilot.md:555-556` | absent | none |
| `HYDRA_HOLDBACK_WINDOW_CYCLES` (+`_T3`/`_T4`), `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY`, `_BASELINE_TTL_SECONDS`, `_CYCLE_MS` | orch | unset | `src/holdback-policy.ts:39,52`; `src/redis/holdback.ts:50` | `docs/reference.md:396-403`; `hydra-qa.md:1262` | absent | none |
| `HYDRA_WORKTREE_MIN_AGE_SECONDS` | orch | unset | `scripts/branch-prune.sh:426` | `hydra-branch-prune.md:86` | absent | none |
| `HYDRA_REAP_WORKTREE_GC` | orch | unset | `scripts/autopilot/reap.py:790` | `hydra-branch-prune.md:300` ("Operator opt-out") | absent | none |
| `HYDRA_BRANCH_PRUNE_LOG` | orch | unset | `branch-prune.sh` `--log` | `hydra-branch-prune.md:249,373` | absent | none |
| `HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS` | orch | unset | `collect-state.sh:933` (default 600) | `hydra-autopilot.md:1031` | absent | none |
| `HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS` | orch | unset | `scripts/hydra-watchdog.sh:1335` | `hydra-autopilot.md:979` | absent | none |
| `HITL_GRILL_INBOX_CAP` | orch | **not env-settable**: shell literal `HITL_GRILL_INBOX_CAP=10` (`collect-state.sh:2256`) that overrides any env before `:2271` reads it | `collect-state.sh:2258-2271` | `hydra-autopilot.md:1017` | indirect: `/work` HitlGrillLane (`dashboard/src/components/pages/work/HitlGrillLane.jsx`); the cap itself absent | `hitl_grill_saturated` signal (`hydra-autopilot.md:1017`) |
| `GLM_RED_FORWARD_FIX_CAP` | orch | **not env-settable**: Python constant `scripts/autopilot/decide.py:3032` | `decide.py:3195` | `hydra-autopilot.md:362` | absent | none |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | orch | `~/hydra/.env` | `src/notify.ts:17-18`; `scripts/hydra-watchdog.sh:1390-1393` | none in the scope-rule docs | absent | watchdog `WARN … SKIPPED — missing Telegram config` (`hydra-watchdog.sh:1394`). This fires on every out-of-band alert: `hydra-watchdog.service` sets only `HOME` (unit `:9`) and loads no `.env` |
| `CRON_SECRET` | orch | **unset everywhere** (§1) | `src/api/config.ts:96` | none | absent | none (routes silently 401) |
| `SENTRY_DSN`, `REDIS_URL`, `HYDRA_PORT`, `HYDRA_AUTO_CYCLE_INTERVAL_MS` | orch | `~/hydra/.env` (`HYDRA_AUTO_CYCLE_INTERVAL_MS` is also in `hydra-orchestrator.service:22` and appears twice in `.env`) | `src/instrument.ts:16`; `src/redis/connection.ts:158`; `src/index.ts:26`; `src/scheduler/heartbeat.ts:202` | `README.md:101` family; `CLAUDE.md` Running (port 4000) | absent | none |
| **Dead names in live env sources** | orch | `~/hydra/.env`: `HYDRA_ORCHESTRATOR_PATH`, `HYDRA_VAULT_PATH`, `OPENVIKING_URL`, `OPENVIKING_API_KEY`, `OLLAMA_DISABLED`, `SENTRY_AUTH_TOKEN`, `SENTRY_GITHUB_REPO`, `SENTRY_RATE_LIMIT`. Unit `hydra-orchestrator.service:21,23`: `HYDRA_DAILY_COST_CAP_USD`, `HYDRA_WORKTREE_DIR` | 0 readers in `src/`/`scripts/` (grep). `HYDRA_DAILY_COST_CAP_USD` survives only in comments (`src/scheduler/heartbeat.ts:136,645`) | — | absent | none |

### 4.4 Target (`~/claw-street-bets`, repo `gaberoo322/claw-street-bets`, HEAD `0b96f8e`)

| name | project | where set (cite) | read by (cite) | referenced by (cite) | dashboard | due-signal |
|---|---|---|---|---|---|---|
| `.hydra/manifest.json` (`verify.*`, `riskCritical.surface`, `mutationKillFloor`) | target | `~/claw-street-bets/.hydra/manifest.json` | `src/target/manifest.ts:65-66` (`loadManifest`), `src/grounding/index.ts:61`, `scripts/sync-target-gate.sh`, `scripts/target/mutation-check.ts` | `hydra-target-build.md:141,179-185,349,443,607`; `hydra-target-qa.md:37`; `hydra-target-incident.md:59-60,111`; `hydra-target-research.md:33,130`; `hydra-wire-or-retire.md:131,193` | absent | none (the loader returns a result object; no doctor or watchdog check) |
| `.env.local` (`DATABASE_URL`, `PORT`) | target | `~/claw-street-bets/.env.local` (mode 600) via `EnvironmentFile=%h/claw-street-bets/.env.local` in `~/.config/systemd/user/claw-street-bets-web.service:21` (and `ops/systemd/claw-street-bets-{backfill,recorder}.service`) | CSB `src/db/client.ts`, `drizzle.config.ts:10`, `scripts/database-migration-drift-check.ts:100` | Hydra `GET /api/env/claw-street-bets` resolves here (`src/api/config.ts:93`, 401 today) | absent | none |
| `direction/{vision,priorities,roadmap,outcomes.yaml}` | target | `~/claw-street-bets/direction/` | Hydra `collect-state.sh:127-143` (`direction_drift`); `$HYDRA_TARGET_REPO/direction/` | `hydra-target-build.md:207-225` (live docs written by `/hydra-target-research`) | absent | `direction_drift` (§2 row) |
| `direction/outcomes.yaml`, `config/graduation-gate.yaml`, `config/risk-template.json` | target | files marked "OPERATOR-ONLY-EDITABLE" (`direction/outcomes.yaml:20`, `config/graduation-gate.yaml:3`, `config/risk-template.json:3`) | CSB stage evaluator; listed in `riskCritical.surface` (`.hydra/manifest.json`) | no Hydra playbook names them; reached only through the manifest's `riskCritical.surface` | absent | none on the Hydra side |
| `scripts/sync-target-gate.sh` | orch→target | — | mirrors orchestrator gate **scripts** plus the `src/` closure into `<wt>.hydra-gate` (`scripts/sync-target-gate.sh:23-40`) | `hydra-target-build.md` (`$HYDRA_GATE_DIR`) | — | — (copies code; carries no operator config) |
| Mothballed `~/hydra-betting/.env.local` (`ODDS_API_KEY`) | target (old) | file exists | — | `hydra-doctor.md:310` (Odds API probe, hardcoded path). Doctor also hardcodes `~/hydra-betting` (`:165-166`) and `hydra-betting-*` timers (`:289`) | absent | doctor probe still targets the old Target |

### 4.5 Host systemd drop-ins and EnvironmentFiles (names only)

| drop-in / file | var NAMES |
|---|---|
| `~/.config/systemd/user/hydra-autopilot.service.d/scope.conf` | `HYDRA_AUTOPILOT_SCOPE`, `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD`, `HYDRA_AUTOPILOT_QUOTA_WEEK_MAX`, `HYDRA_AUTOPILOT_QUOTA_5H_MAX` |
| `…/hydra-autopilot.service.d/scope.conf.bak-20260819` | `HYDRA_AUTOPILOT_SCOPE`, `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD` (inert backup; systemd loads `*.conf` only) |
| `…/hydra-autopilot.service.d/target.conf` | `EnvironmentFile=%h/.config/hydra/target.env` |
| `…/hydra-orchestrator.service.d/extra-usage-policy.conf` | `HYDRA_EXTRA_USAGE_POLICY` |
| `…/hydra-orchestrator.service.d/otel.conf` | `EnvironmentFile=-/etc/hydra/otel.env` |
| `…/hydra-orchestrator.service.d/target.conf` | `EnvironmentFile=%h/.config/hydra/target.env` |
| `…/hydra-orchestrator.service.d/usage-quota.conf` | `HYDRA_USAGE_WEEKLY_QUOTA_TOKENS`, `HYDRA_USAGE_5H_QUOTA_TOKENS`, `HYDRA_USAGE_WEEKLY_RESET_ANCHOR`, `HYDRA_USAGE_WEEKLY_PACE_CEILING` |
| `…/hydra-pace-gate.service.d/target.conf` | `EnvironmentFile=%h/.config/hydra/target.env` |
| `…/hydra-betting-paper-edge-feed.service.d/override.conf` | `HYDRA_PAPER_LLM_WARMUP` (+ `ExecStart` override; mothballed Target) |
| `…/hydra-betting-web.service.d/10-start-timeout.conf` | `TimeoutStartSec` only |
| `~/.config/hydra/target.env` | `HYDRA_TARGET_NAME`, `HYDRA_PROJECT_WORKSPACE`, `HYDRA_TARGET_GITHUB_REPO`, `HYDRA_TARGET_WEB_URL`, `HYDRA_TARGET_REPO` |
| `/etc/hydra/otel.env` (root:gabe 640) | `HYDRA_OTEL_ENABLED`, `OTEL_INGEST_KEY` |
| `~/.config/hydra-glm/env` (tracked unit `scripts/systemd/hydra-glm-drainer.service:18`, `EnvironmentFile=-`) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `API_TIMEOUT_MS`. Read by `src/glm/drainer-runner.ts:171-189`, which fails closed on an unset token (`:178`) |
| `~/hydra/.env` | see §3 (14 distinct names) |
| `~/claw-street-bets/.env.local` | `DATABASE_URL`, `PORT` |

**Doc coverage of the drop-ins.**
- Only `otel.conf` / `otel.env` are documented in-repo (`docs/reference.md:226-231`, `scripts/otel/README.md:15-16`).
- `scope.conf`, `usage-quota.conf`, `extra-usage-policy.conf`, the three `target.conf` files and `target.env` have **no in-repo doc** (grep of `docs/`, `CLAUDE.md`, `README.md`, `scripts/`, `src/` → 0 hits outside `docs/research`).
- The only in-repo mention is `scripts/deploy.sh:171`: "Host-local drop-ins (hydra-autopilot.service.d/) are preserved by design."

**Due-signal for drop-ins: none.** No doctor, watchdog or housekeeping check reads or validates any drop-in:
- `docs/operator-playbooks/hydra-doctor.md`: no env or drop-in check.
- `scripts/hydra-watchdog.sh`: grep for `scope.conf`, `target.env` and `drop-in` returns 0.

### 4.6 Excluded (checked, not operator-set per the scope-rule docs)

- `config/direction/{proposal-policy,tech-preferences}.md`: no playbook reference, no `src/` reader.
- `config/direction/architecture-review.md`: written by the `hydra-architect` skill (`hydra-architect.md:171`), not by the operator.
- `config/direction/liveness.yaml`: machine manifest (`src/scheduler/chores/wiring-liveness-timer.ts:47`, `scripts/ci/wiring-caller-check.ts:55`).
- `config/glm/drainer-settings.json`: fenced allow-list (`src/glm/drainer-runner.ts:128`; CLAUDE.md pitfall mentions it as a fence, not an operator dial).
- The 13 root personality `.md` files (§2.5: no reader).
- `scripts/autopilot/classes.json`: cooldown taxonomy changed by PR (`hydra-autopilot.md:369`), not framed as an operator setting.
- The `.env.example` dead names (§2.11).
- Autopilot internal env such as `HYDRA_AUTOPILOT_SLOT_EVENTS_*` and `HYDRA_REDIS_*` (`_fragments/hydra-autopilot-ops-reference.md:230-236`): harness plumbing, not operator dials.

---

## 5. Method & limits

- Four read-only survey passes (one per family) against `5fded9547`, each citing `path:line`; host-local files (systemd drop-ins, `state.json`, `.env` **names only**, the CSB checkout at `0b96f8e`) were read, never written. No secret values are recorded.
- Dashboard presence = `grep` of `dashboard/src/**` for literal names plus tracing the fetch calls behind generic renderers; a surface reachable only through a data-driven label is recorded as *generic*, not *named*.
- Out of scope: HTTP routes (#4417/#4424/#4425), UI proposals (#4423 and the epic), and fixing any stale item found — the premise corrections above are recorded for follow-up, not acted on.
