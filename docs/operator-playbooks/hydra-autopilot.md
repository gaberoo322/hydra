---
name: hydra-autopilot
description: Event-driven autonomous decision loop. A single Claude Code session orchestrates Hydra work via decide.py — the L2 decision brain — and executes typed action plans. Token-budgeted; each invocation runs unattended for up to ~8 hours. Invoked manually by the operator OR fired on a schedule (multiple times per day — not night-only).
when_to_use: "When the user wants an autonomous decision loop to advance Hydra work, says 'autopilot', 'autonomous mode', or wants a single skill to manage all hydra operations. Also fired by the systemd timers documented in the Scheduling section."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
claude_only: true
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
- Runtime invariants: `scripts/autopilot/assert_invariants.py` (INV-001..INV-009; INV-009 is warn-only in Phase B per #466)
- Architecture rationale: [ADR-0007](../adr/0007-decision-brain-orchestration.md)

## Loop

Each tick:

1. **Wake** on TaskNotification, Monitor board-change, or a 15-min heartbeat.
2. **Collect** state + candidates + events into three JSON blobs.
3. **`python3 scripts/autopilot/decide.py decide state.json candidates.json events.json`** — pure function call, returns `{actions, reasons, debug}`.
4. **`python3 scripts/autopilot/assert_invariants.py plan.json state.json`** — runtime guards.
5. **Execute** each action in the plan via the right tool (table below).
5a. **`python3 scripts/autopilot/heartbeat.py --last-action=<type>`** — write the per-turn heartbeat line. `<type>` is the `type` of the LAST action executed in step 5 (or `wait` / `(none)` if the plan was a no-op). MUST run on every iteration, even when the plan only contained a `wait` — file mtime is the operator's liveness signal (issue #435).
6. **Re-enter step 1.** No inline reasoning between steps.

## Class taxonomy (7 pipeline slots + 6 signal classes)

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
| `dispatch` | `Agent(run_in_background=True, isolation="worktree", ...)` — action carries `worktreeBranch` (stamped by `decide.py:_synthesize_worktree_branch`; issue #527) so the dashboard's slice-4 "Watch stream" cross-link can scope `/agents/stream?agent=<branch>` |
| `auto-merge` | `Bash` → `gh pr review --approve && gh pr merge --auto --squash` |
| `apply-operator-approved` | `Bash` → `gh pr edit --add-label operator-approved` |
| `update-branch` | `Bash` → `gh pr update-branch` |
| `queue-decision` | `Bash` → `./scripts/autopilot/queue-decision.sh ...` |
| `reap` | `Bash` → `./scripts/autopilot/reap.py completion ...` (also fires `dispatch.sh cycle-record` for `hydra-dev` / `hydra-target-build`; see Phase 6) |
| `terminate` | `Bash` → `./scripts/autopilot/drain.sh <merged_prs>` → Phase 7 |
| `wait` | sleep N; re-enter loop |
| `wait-for-api` | `curl --retry`; re-enter loop |

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

Two callers fire the write:

1. **`reap.py completion`** — when a code-writing class (`hydra-dev` /
   `hydra-target-build`) reaps, it fires cycle-record with `status=completed`
   (or `status=failed` if the soft cap was tripped). The autopilot task_id
   is the `cycleId`, which gives natural dedup across retries.
2. **`auto-merge` action** — after `gh pr merge --auto --squash` succeeds,
   the model SHOULD fire a follow-up `dispatch.sh cycle-record <task_id>
   merged <skill> <pr_number> "<title>" "<anchor>" <duration_ms>` so the
   `cycles-merged` lifetime counter and `/api/metrics` reflect the merge.
   Idempotent on cycleId — a duplicate post is a no-op.

`dispatch.sh cycle-record` is best-effort: a 5xx or unreachable API is logged
to the nightly run log and the autopilot proceeds. The write covers three
surfaces atomically server-side:

- `hydra:cycle:<id>` hash + `hydra:cycle:index` ZSET → `/api/cycle/history`
- `hydra:metrics:<id>` via `recordCycleMetrics(source: "claude")` →
  `/api/metrics` and `/api/scheduler/status.mergeRateWindow`
- `hydra:scheduler:cycles-{run,merged,failed}` lifetime counters →
  `/api/scheduler/status.mergeRateLifetime`

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

The per-cycle write keeps the per-cycle cost-cap in `src/cost-cap.ts`
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

## Termination

`decide.py` emits a single `terminate` action when any of these trip:

1. `cumulative_tokens >= limits.token_budget`
2. `elapsed >= limits.wall_clock_max_sec`
3. `idle_turns >= limits.idle_drain_turns` AND all slots empty
4. 5 consecutive failures of the same pattern (failure backstop; see `self_heal.py`)

## Worktree-guard preamble (REQUIRED for code-writing dispatches)

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
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

### Scheduling

Two systemd user timers fire the autopilot on a daily cadence — it is NOT
night-only. Both target the same `hydra-autopilot.service` oneshot (with
its 9h `RuntimeMaxSec` and 8h internal budget), and the morning run
typically finishes by ~19:00 so the two never overlap.

| Unit | Fires | File |
|---|---|---|
| `hydra-autopilot-morning.timer` | 10:00 local | `scripts/systemd/hydra-autopilot-morning.timer` |
| `hydra-autopilot.timer` | 22:00 local | `scripts/systemd/hydra-autopilot.timer` |

Operator install (one-time):

```bash
cp scripts/systemd/hydra-autopilot.service \
   scripts/systemd/hydra-autopilot.timer \
   scripts/systemd/hydra-autopilot-morning.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hydra-autopilot.timer hydra-autopilot-morning.timer
```

Inspect: `systemctl --user list-timers | grep autopilot` and
`journalctl --user -u hydra-autopilot.service` after a fire.

Adding more fires (e.g. a midday run) is a one-line `OnCalendar=` change in
a copy of the morning timer — `Unit=hydra-autopilot.service` ties them all
to the same oneshot. Two cautions:

1. Each fire is sized for up to 8h of work — overlapping fires fight for
   the same `[Service] Type=oneshot` slot. Stagger them by at least 9h or
   use `RandomizedDelaySec=` to avoid stomping.
2. The autopilot self-terminates on `idle_drain_turns` when there's nothing
   to do, so an empty-queue fire is cheap — but every fire still pays the
   bootstrap + Phase 0 schema handshake cost. Don't fire it every 5
   minutes; the heartbeat housekeeping inside `scheduler.ts` covers that
   frequency.

The choice of two daily long runs (rather than many short runs) is
deliberate: the L2 decision brain in `decide.py` benefits from a stable
in-process view of pipeline state across many turns. Short bursts would
re-pay the Phase 0 / Phase 1 collect-state cost without amortising it
across enough decisions to matter. If short-burst mode becomes useful
later, document the tuning in a follow-up section here — don't replace
the long-run schedule.

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
| `health=FAIL` or `failed_services>0` | `health_fail` | `health` |
| `scout_last_walk_iso` >7d old or empty | `scout_walk_due` | `scout_orch` (issue #485) |
| `scout_board_open_enhancements > 20` | `scout_board_saturated` | suppresses `scout_orch` |
| `scout_spend_usd_today` | (read directly from state) | suppresses `scout_orch` via cost-cap (issue #532) |

Pre-#458 `dev_orch` consumed `/api/anchor/candidates` and routinely
received target-product anchors (item-26x). Post-#458, candidates are
treated as target-side work: `dev_target` surfaces the top candidate as
a hint, and a low best-score forces `research_target` (not `research_orch`).

## Where to look when something goes wrong

- Wrong dispatch for a class → `decide.py:_select_for_slot` / `_select_for_signal`
- Tier-0 non-mechanical PR merged anyway → INV-001 violation; run log
- Burned class still got dispatched → INV-003; `burned_classes` in `state.json`
- Failure pattern keeps retrying → `self_heal.py` + `state.failure_log` + Phase 3 backstop
- A subagent in flight wedged → Phase 2 reap or `subagent-hard-max-tokens`

## Safety rules

1. NEVER modify `~/hydra` or `~/hydra-betting` working trees directly.
2. Worktree-guard preamble is mandatory for `dev_orch` / `dev_target`.
3. One subagent per pipeline slot.
4. Token budget is a hard cap; subagent caps (#395) bound a single misbehaving subagent.
5. `hydra-architect` is operator-only.
6. Phase 7 is the only path to the end-of-run digest (idempotent shutdown).
