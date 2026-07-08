# hydra-autopilot — Operations reference

Troubleshooting, historical context, and operational internals for the
autopilot. Read when diagnosing a wedge, slot accounting failure, Redis
state loss, or merge-rate anomaly.

## Where to look when something goes wrong


- Wrong dispatch for a class → `decide.py:_select_for_slot` / `_select_for_signal`
- Tier-0 non-mechanical PR merged anyway → INV-001 violation; run log
- Burned class still got dispatched → INV-003; `burned_classes` in `state.json`
- Failure pattern keeps retrying → `self_heal.py` + `state.failure_log` + Phase 3 backstop
- A subagent in flight wedged → Phase 2 reap or `subagent-hard-max-tokens`


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

## Termination detail

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

