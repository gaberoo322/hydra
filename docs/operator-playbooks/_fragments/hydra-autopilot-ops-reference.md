# hydra-autopilot — Operations reference

Troubleshooting and operational internals for the autopilot. Read when
diagnosing a wedge, a slot accounting failure, Redis state loss or a merge-rate
anomaly.

## Where to look when something goes wrong

- Wrong dispatch for a class → `decide.py:_select_for_slot` / `_select_for_signal`
- PR merged without a PASS verdict → the merge-verdict invariant in the `assert_invariants.py` docstring; the run log
- Burned class still got dispatched → INV-003; `burned_classes` in `state.json`
- Failure pattern keeps retrying → `self_heal.py`, `state.failure_log` and the Phase 3 backstop
- A subagent in flight wedged → Phase 2 reap or `subagent-hard-max-tokens`
- Back-to-back master merges left prod stale → `bash scripts/deploy.sh` (CLAUDE.md "CI/CD & Deployment")

Historical: `ci.yml` scopes `cancel-in-progress` to non-master refs (closes #712).

## Cross-run state: the Redis mirror

`/tmp/hydra-autopilot-state.json` is the run-local home of autopilot state, and
`/tmp` is wiped on boot. Most of it is **run-scoped** and dies with the run:
`pid`, `turn`, `dispatches`, `slots`, `burned_classes` (the concurrent-run PID
guard and slot re-seeding depend on those resetting). Only the **cross-run
durable subset** survives a reboot:

- `signal_last_fired`, the per-class cooldown timestamps. The classes whose
  `classes.json` row carries a large `cooldownSeconds` are the load-bearing ones;
  short-cooldown classes re-arm to 0 each run by design. It also carries the
  `research_target` pipeline re-fire stamp, which decide.py writes at plan time
  to enforce that slot's minimum re-fire interval
  (`HYDRA_RESEARCH_TARGET_REFIRE_SEC`); bootstrap carries it forward so a
  relaunch cannot reset the interval.
- `research_force_counter`, the date-keyed forced-research counter.

Bootstrap seeds these from the prior `state.json` first, which survives a
pace-gate relaunch but not a host reboot. The Redis mirror is the reboot-survival
backstop (AOF plus the docker volume):

- **Keys** (bare `redis-cli`, the docker-exec seam the autopilot scripts use):
  `hydra:autopilot:signal-last-fired` is a Hash (field = signal class, value =
  last-fired epoch); `REDIS_RESEARCH_FORCE_KEY` (`scripts/autopilot/run_ledger.py`) is a String
  holding the canonical-JSON counter object.
- **Seed order** (`bootstrap.sh`): prior state file, then Redis, then 0. The
  prior file stays first (fast local path); 0 is the first-install default.
- **Write seam**: `reap.py run_completion` mirrors the whole subset on every
  completion, signal classes included. `decide.py` also mirrors
  `research_force_counter` on the turn it stamps it, because a force can advance
  without a reap.
- **Read path**: `decide.py` reads `signal_last_fired` and `research_force_counter`
  only from the loaded state dict, never from Redis. Redis is a bootstrap seed
  source and an executor mirror sink.
- **Fail-open**: every Redis read and write is best-effort. An error logs and
  degrades to state.json-only behaviour, and never aborts bootstrap or a decision
  turn. `HYDRA_AUTOPILOT_REDIS_CLI` overrides the `docker exec hydra-redis-1
  redis-cli` prefix for hermetic tests.

## Termination

`decide.py` emits a single `terminate` action, always the plan's LAST action,
preceded only by the `auto-merge` actions the sweep produces from that turn's QA
PASS verdicts (session `qa-verdict` events and recheck entries, all holds
unchanged). It fires when any of these trip:

1. `cumulative_tokens >= limits.token_budget`
2. `elapsed >= limits.wall_clock_max_sec`
3. Five consecutive failures of the same pattern (the failure backstop; see
   `self_heal.py`)
4. The turn is wait-only with zero occupied slots: nothing dispatched, no other
   actions, nothing in flight. The cause is `idle`. A `claude -p` print-mode
   session exits the moment the model emits its final message, so an idle
   heartbeat `wait` is never honoured; per ADR-0021 D5 continuity comes from the
   pace-gate relaunch, and the designed exit is recorded as a clean idle drain.
5. `turn > 0` AND `turn % limits.context_compaction_turns == 0` gives cause
   `context_compaction`. The limit is `state.limits.context_compaction_turns`
   (`HYDRA_AUTOPILOT_CONTEXT_COMPACTION_TURNS`; 0 disables it). It is checked
   LAST, so a budget, wall-clock, idle or failure-backstop trip on the same turn
   wins, and it is NOT gated on `slots_occupied == 0`, because a busy run
   accumulates the most cache-read growth. The unit is Autopilot Turns (one
   `decide.py decide` invocation), not raw API calls. It reuses the same
   terminate and pace-gate relaunch path as the other causes: clean `exit 0`,
   next launch at the next `hydra-pace-gate.timer` tick, slot re-seeding via
   `/api/autopilot/inflight-slots`. Phase 7's `hydra-digest` dispatch is skipped
   for this cause; `drain.sh` still runs.

   **The session must actually end.** `bootstrap.sh` refuses a second run from
   the process that already ran one when `HYDRA_AUTOPILOT_TRIGGER` is set, so the
   context, the per-run quota caps and the pace gate reset on every relaunch.
   Children still running at the terminate are reaped as they complete, as on a
   `quota` terminate, and nothing new is dispatched. Interactive sessions
   (trigger unset) may re-bootstrap in place.

When the plan carries a `terminate`, the decide CLI itself POSTs
`/api/autopilot/run-end` with the plan's cause before printing the plan; the reap
backstop would otherwise stamp `interrupted`. The POST is idempotent (the first
terminal cause wins) and is skipped when state carries no `run_id` or
`HYDRA_AUTOPILOT_RUN_END_POST=off`.

**Handoff baton-pass.** A print-mode session can reach a natural final message
while subagent slots are occupied, because print mode has no event loop that
survives the model going quiet across a long nap. That is a baton-pass, not a
truncation: the in-flight subagents live in the durable dispatch ledger
(`hydra:dispatches:subagent:*`) that the next pace-gate-launched run re-seeds. It
is recorded as the clean `term_reason=handoff` (in `CLEAN_TERM_REASONS`,
`src/autopilot/runs.ts`) by ONE scripted writer: the ExecStopPost reap backstop
(`bootstrap.sh __reap_derive_cause`, wired in `hydra-autopilot.service`) derives
`handoff` whenever a clean exit (code 0, 143 or 130) shows occupied slots in
`state.json`. The parent session posts nothing for a baton-pass. `interrupted` is
reserved for a clean zero-slot exit that bypassed decide.py's terminate.

`GET /api/autopilot/runs` surfaces the clean-termination rate as
`terminationHealth`, with a pre-derived `starved` alarm boolean. `starved: true`
means at least five ended dispatch-bearing runs sustain a clean-termination rate
under the floor, which is the retro-starvation condition (crashes or zero
progress).

## Slot lifecycle events

Subagent slot accounting is event-driven. Claude Code's `SubagentStop` and
`Notification` hooks XADD lifecycle events onto a Redis stream that the autopilot
drains every turn:

- **Stream:** `hydra:autopilot:slot-events` (`XADD ... MAXLEN ~`)
- **Hook scripts:** `scripts/autopilot/hooks/on-subagent-stop.sh`,
  `scripts/autopilot/hooks/on-subagent-permission-wait.sh`
- **Hook registration:** `docs/operator-playbooks/hydra-autopilot.settings.json`
  (propagated by `scripts/sync-skills.sh` to
  `~/.claude/skills/hydra-autopilot/.claude/settings.json`)

### Event schema

```
event=subagent_stop
  slot=<a pipeline slot name, or unknown>
  status=<success|failure|no_op|budget_exceeded|unknown>
  task_id=<harness-task-id>
  subagent_type=<hydra-dev|hydra-target-build|...>
  summary=<truncated text>
  ts_epoch=<unix-epoch>

event=slot_waiting_permission
  slot=<slot-or-unknown>
  prompt=<truncated text>
  ts_epoch=<unix-epoch>
```

### How the turn consumes them

1. The Turn Snapshot's `slot-events` collector calls `hydra raw GET
   /autopilot/slot-events?last_id=<last-id>&count=<n>`, a thin HTTP adapter over
   a plain, non-consumer-group `XREAD` that the orchestrator performs server-side
   through `EventBus.readRaw()` (`src/event-bus.ts`). It carries the response as
   its `slot_events` blob (`{events:[...], last_id:"..."}`).
   `turn_snapshot.py apply` stores it on `state.slot_events` and advances
   `state.slot_events_last_id` so the next turn does not re-read. `bootstrap.sh`
   seeds `state.slot_events_last_id` at run start (`<STARTED_EPOCH>000-0`) so a
   fresh run's first collect reads only entries after the run began, and `turn.sh`
   passes the advancing cursor on every later collect via
   `HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID`.
2. `decide.py` consumes `state.slot_events`, first dropping any entry whose event
   time is provably earlier than `state.started_epoch`. The seed is an efficiency
   layer, not the correctness guarantee: a forgotten cursor export or a
   context-compaction re-bootstrap falls back toward `0`, and this filter makes
   that replay inert. An entry with no resolvable time is kept (fail-open).
   - Each surviving `subagent_stop` becomes a `completion` event (the reap path)
     and is appended to `state.slot_history` (a capped FIFO).
   - `failure` and `budget_exceeded` statuses also append to `state.failure_log`,
     where `self_heal.py` reads them.
   - Each surviving `slot_waiting_permission` appends to `state.failure_log` with
     `pattern=permission_wait` and does NOT free the slot: the subagent is
     paused, not done.
   - The cascade-routing escalation re-dispatch rule reads the same pre-filtered
     `state.slot_events`, so a stale `subagent_stop` cannot trigger a stale
     escalation.

### Silent-wedge fallback

If the hook itself fails silently (for example the subagent process crashed
before the harness's `SubagentStop` dispatch), `decide.py` falls back to a
wall-clock timer. When an active slot's `started_epoch` is older than
`subagent_max_wall_seconds` (env `HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS`) and
no `subagent_stop` event has been observed for the slot's `task_id`, `decide.py`
emits a `wait_or_reap` action. The brain runs
`reap.py wait-or-reap <slot> <task_id>` from the playbook's `wait_or_reap`
action-table row: liveness by transcript mtime, then the forced reap. A
transcript `stat()` failure stays `verdict=unknown` (no reap) only until the slot
has been occupied past `subagent_max_wall_seconds`; after that it is treated as
dead and reaped. `reap.py` is the executor for both the `reap` and `wait_or_reap`
rows.

### Best-effort guarantees

The hook scripts never propagate an error back to the parent autopilot session. A
Redis outage, a malformed payload or a missing `jq` results in a stderr warning
and `exit 0`. `test/autopilot-hooks.test.mts` enforces this.

### Environment overrides

Defaults live in the file named in each row; read them there.

| Var | Owner | Purpose |
|---|---|---|
| `HYDRA_REDIS_HOST` | the hooks | `docker` makes the hooks shell into `hydra-redis-1`; any other value uses `redis-cli -h $HOST -p $PORT` |
| `HYDRA_REDIS_PORT` | the hooks | Port for the non-docker form |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM` | hooks and tests | Stream name. The Turn Snapshot does not read it: `GET /autopilot/slot-events` hard-codes the production stream name server-side so a narrow autopilot read never becomes a general Redis-stream proxy |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID` | `turn.sh` | Cursor for each turn's read. `turn.sh` exports it from `state.slot_events_last_id` so the first turn cannot replay a prior run's stream tail; `turn-snapshot.ts` stays stateless |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT` | the collector | Max events per read batch |
| `HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN` | the hooks | `XADD MAXLEN ~` cap |
| `HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS` | `decide.py` | Silent-wedge fallback cap |
| `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD` | bootstrap | Written to `state.limits.daily_spend_cap_usd`; nothing reads it (the spend gate was removed) |
| `HYDRA_USAGE_5H_THROTTLE_T1` | `src/cost/usage-tracker.ts` | Tier-1 fraction of the 5h window. Once reached on the authoritative OAuth meter (never the transcript estimate), `projectEligibility` sheds the lowest-value pipeline and backfill classes. Inert when the meter reports no 5h window. Set-but-invalid falls back to the default and logs |
| `HYDRA_USAGE_5H_THROTTLE_T2` | `src/cost/usage-tracker.ts` | Tier-2 fraction. Additionally sheds `design_concept_orch` and `dev_orch`; `qa_*` and `dev_target` are never shed. A value under T1 is clamped up |
| `HYDRA_EXTRA_USAGE_POLICY` | `src/cost/config.ts` | `block` forces `allow=false` while paid overage is armed (`reasons.extraUsageArmed`); `allow` reports it without folding it into `allow`, for an account whose overage is plan-level and capped. `pace-gate.sh` keys its skip arm off `extraUsageBlocking`. Set-but-invalid falls back to the default and logs |
| `HYDRA_USAGE_EMERGENCY_STOP_PERCENT` | `src/cost/config.ts` | The 5h and weekly hard-stop threshold, percent of a window's quota in (0, 100], that `deriveHardStop` compares the OAuth meter against. The check runs between dispatches while in-flight subagents keep burning, so keep a margin under 100. Set-but-invalid falls back to the default and logs |

## Reading the two merge-rate metrics

`GET /api/scheduler/status` exposes two figures. Keep them separate:

| Field | Formula | Use |
|---|---|---|
| `mergeRate` | merged / cyclesInWindow (rolling window) | The health signal. Alert on this one, and treat a sustained drop as a reason to investigate. |
| `mergeRateLifetime` | cyclesMerged / cyclesRun (all time) | Audit-only accumulator. Early failures skew it permanently, so it cannot reflect current health. Never alert on it. |

A high rolling rate beside a low lifetime rate is the healthy steady state: the
system recovered, and the lifetime denominator is dominated by history.
`cyclesRun` exceeds `cyclesMerged + cyclesFailed + cyclesUnaccounted` by the
cycles that predate the `cyclesUnaccounted` counter, so that identity holds only
for cycles recorded after it landed.
