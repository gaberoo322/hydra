# hydra-autopilot — Operator guide

How a person runs, schedules, stops and inspects the autopilot, and the
reasoning behind three of its rules. The autopilot session does not need this
file to run a turn.

## Inspecting a run

- **One-shot status:** `bash scripts/autopilot/status.sh` pretty-prints the heartbeat with its wedge verdict, the compact state and the log tail. It is safe to wire to a shell prompt.
- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Liveness probe: `find /tmp/hydra-autopilot-heartbeat.txt -mmin -10`. The model writes the heartbeat every decision turn (Phase 5a), so an empty result means no turn completed in the last 10 minutes.
- Live state: `jq '.slots,.signal_last_fired,.burned_classes' /tmp/hydra-autopilot-state.json`
- Run log: `tail -100 /tmp/hydra-autopilot-nightly.log` (the filename is historical)
- Last decision plan: `jq . /tmp/hydra-autopilot-plan.json`
- Failure ledger: `tail /tmp/hydra-autopilot-failures.jsonl`

### Per-turn heartbeat format

After Phase 0, every decision turn overwrites `/tmp/hydra-autopilot-heartbeat.txt` with one line:

```
<epoch> <pid> <run_id> turn=<N> dispatches=<M> tokens=<K> pipeline_filled=<F>/<P> signal_active=<S>/<Q> last_action=<type>
```

The first turn after bootstrap stamps `last_action=bootstrap`; later turns carry the type of the most recent executed action (`dispatch`, `auto-merge`, `reap`, `wait`, and so on).

### Wedge detection: stale heartbeat plus live process

`claude -p` buffers stdout, so a running autopilot can produce no terminal output for many minutes. The heartbeat file is the only liveness signal to trust.

| Heartbeat mtime | Process pid alive? | Verdict |
|---|---|---|
| Within last 10 min | yes | Healthy (the model is looping) |
| Within last 10 min | no | Terminated cleanly; check the log tail |
| >10 min old | no | Crashed or killed externally; check `journalctl` or the run log |
| **>10 min old** | **yes** | **Wedge.** The model is alive but has stopped producing decision turns. |

A wedge is typically a stale schema mirror (see Phase 0 schema-version handshake) leaving the model reconciling two worldviews after Phase 0. Recover with `kill <pid>` and restart the autopilot, then file a `needs-triage` issue with the run-log tail.

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

`scripts/autopilot/status.sh` runs this check automatically.

## Invocation

The skill is operator-invocable and scheduled. Both paths run the same
`/hydra-autopilot` entrypoint and obey the same token and wall-clock budgets.

### Manual

Invoke `/hydra-autopilot` from an interactive Claude Code session, or headless from the shell:

```bash
claude --dangerously-skip-permissions -p "/hydra-autopilot"
# Short smoke:
HYDRA_AUTOPILOT_TOKEN_BUDGET=100000 HYDRA_AUTOPILOT_MAX_SEC=600 claude --dangerously-skip-permissions -p "/hydra-autopilot"
# Scope-restricted:
HYDRA_AUTOPILOT_SCOPE=orch-only claude --dangerously-skip-permissions -p "/hydra-autopilot"
```

Slash-args (`--scope=`, `--tokens=`, `--max-sec=`, `--subagent-soft=`,
`--subagent-hard=`, `--unattended=`, `--quota-week-max=`) parse via
`args-parse.sh` and override env vars. `--quota-week-max` is the opt-in
quota-percent budget (see Quota-percent budget); unset means disabled.

### Scheduling — the Pace Gate (ADR-0021)

The **Pace Gate** is a usage-paced admission controller: a single frequent timer
decides whether to launch each Autopilot Run from where total weekly burn sits
against the **Pacing Curve**. It is not a fixed daily schedule.

| Unit | Fires | File |
|---|---|---|
| `hydra-pace-gate.timer` | on a short interval | `scripts/systemd/hydra-pace-gate.timer` |
| `hydra-pace-gate.service` | oneshot; runs the gate | `scripts/systemd/hydra-pace-gate.service` |

On each tick `scripts/autopilot/pace-gate.sh` runs as transport only. The
admission rules live in `decideAdmission` (`src/cost/admission.ts`) and arrive as
the eligibility route's `.admission` object; the gate records `.admission.reason`
verbatim and performs the effects it names. The verdict's ladder:

1. **Skip if a run is already live:** the service is active, or
   `/tmp/hydra-autopilot-state.json` carries a live owning PID (`kill -0`).
2. **Consult `/api/usage/eligibility`:** skip when `.reasons.paused == true`
   (operator pause), when `.reasons.sessionBlockedUntil` is a future instant
   (session-limit hard block), when `.reasons.emergencyStop == true`
   (`HYDRA_USAGE_EMERGENCY_STOP_PERCENT` over whichever windows the meter
   reports), or when `.paceState == "ahead"` (ahead of the Pacing Curve). Otherwise
   (`on` or `behind`, no emergency) launch via
   `systemctl --user start hydra-autopilot.service`.
3. **Fail safe:** if the eligibility endpoint is unreachable, do NOT launch.
   Pacing is the governor, and the gate does not burn quota while blind to usage.

**Session-limit hard block.** When the Claude Code rolling session window is
exhausted, the CLI prints `You've hit your session limit · resets <t>` and the
autopilot exits `code=1`. The reap-on-exit backstop (`bootstrap.sh --reap`) scans
the journal for that line and POSTs it to `POST /api/usage/session-block`, which
parses the reset and records a self-expiring block
(`hydra:autopilot:session-blocked-until`, TTL to the reset instant). While the
block is in the future, the eligibility route forces `allow=false` and surfaces
`reasons.sessionBlockedUntil`, so the gate skips relaunch into the exhausted
quota. The OAuth `emergencyStop` undershoots the true session limit, which makes
this the authoritative "the next run cannot make a single turn" signal.
Admission resumes on its own once the reset passes.

The gate governs *admission* only (should a run start now?), never *what work* to
do; that stays with `decide.py` (ADR-0012). It leaves the watchdog, the bootstrap
concurrent-run guard and the service's `Restart=on-failure` untouched, and only
ever *starts* the service.

`scripts/deploy.sh` installs `pace-gate.sh` to `~/.local/bin/` and enables
`hydra-pace-gate.timer` on every deploy. Manual install, when not relying on
deploy:

```bash
install -D -m 0755 scripts/autopilot/pace-gate.sh ~/.local/bin/hydra-pace-gate.sh
cp scripts/systemd/hydra-pace-gate.service scripts/systemd/hydra-pace-gate.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hydra-pace-gate.timer
```

Inspect: `systemctl --user list-timers | grep pace-gate`,
`journalctl --user -u hydra-pace-gate.service` (admission decisions), and
`journalctl --user -u hydra-autopilot.service` after a launch.

Each launched run is sized for a long session (the service's `RuntimeMaxSec`
plus the internal budget). The already-running skip in step 1 keeps the timer
from stacking a second run on a live one. A run with nothing to do ends on the
budget, clock, quota or wait-only-idle causes in `decide.py`'s
`_check_termination`. The decision brain benefits from a stable in-process view
of pipeline state across many turns, so the gate launches one long run and lets
it run to budget, clock or idle rather than firing many short bursts.

### Stopping the autopilot: the two levers

The two stop levers are not interchangeable:

| Lever | What stops | What keeps running |
|---|---|---|
| `POST /api/autopilot/paused` (`paused=true`) | **Everything.** The Pace Gate skips Claude AFK launches, and `scripts/glm/drainer-loop.sh` honours the same durable flag (ADR-0032 Decision 6), so the GLM free lane freezes too. | Nothing. |
| `systemctl --user stop hydra-pace-gate.timer` | Claude AFK relaunches only: no new Autopilot Runs are admitted, and a live run finishes its budget. `paused` stays `false`. | The GLM drainer keeps draining `glm-eligible` work on z.ai. |

**`paused=true` is the TOTAL stop; stopping `hydra-pace-gate.timer` is the
Claude-only stop.** Use the timer stop for a cost emergency where Anthropic quota
must stop burning but the free lane should keep shipping: an operator pause
freezes the drainer while `glm-eligible` issues queue. Re-arm afterwards with
`systemctl --user start hydra-pace-gate.timer`.

Related watchdog coverage: the launch-flow block's `glm-sterile` signal
(`scripts/hydra-watchdog.sh`) alarms in-band when the drainer heartbeat is
fresh, `glm-eligible` plus `ready-for-agent` work is queued, and zero drainer PRs
were created in the trailing window
(`HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS`). It catches the live-but-sterile
failure that liveness checks cannot see.

## Termination limits

The termination causes are summarised in SKILL.md § Termination and detailed in
`hydra-autopilot-ops-reference.md`.

### Quota-percent budget

`token_budget` counts cumulative subagent-reported input and output tokens, but
the operator pays for cache-weighted **account utilization**, and the two diverge
by orders of magnitude: a single QA fan-out moves far more utilization than its
reported tokens suggest. A token budget therefore does not bound real spend.

The quota-percent budget is a second per-run cap, denominated in **utilization
points accrued over this run's own run-start baseline**:

| Knob | Env var | Meaning |
|---|---|---|
| `--quota-week-max=<pts>` | `HYDRA_AUTOPILOT_QUOTA_WEEK_MAX` | terminate once `usage.percentSinceReset` has risen this many points over the run-start baseline |

- **Opt-in.** It stamps `state.limits.quota_week_max_pts`, where `0` means the cap never fires, so an unset flag leaves every other termination path unchanged. The token budget stays as a secondary bound.
- **Zero new I/O.** The Turn Snapshot already fetches `/usage/eligibility` every turn; the cap reads the nested `usage` object out of `state.usage_eligibility`.
- **Baseline capture.** `decide.py` writes `state.quota_baseline` once, lazily, on the first turn that sees a calibrated payload, through the same tmp-file and `os.replace` write-back as the other counters. `decide.py` is the only termination predicate, so it both captures and evaluates the baseline; the cap can first fire on the turn after capture.
- **Window resets are not spend.** If a current percentage falls under the baseline, the weekly reset anchor rolled over: the delta clamps to zero and the baseline rebases down. A reset never reads as negative spend and never itself terminates.
- **Subordinate to the Pace Gate.** Per ADR-0021 D5 this is a per-run hygiene cap, not a second governor. It reads raw `percentSinceReset` only, never `paceState` or `targetPercent`, and touches no admission logic.

### Workless-board backoff on an idle exit

`endRun` stamps the workless-board hint on every `cause=idle` termination, so the
Pace Gate's next tick does not launch a fresh session into a just-drained board:

| Idle exit | Window |
|---|---|
| dispatched nothing | `HYDRA_WORKLESS_BACKOFF_SEC` |
| dispatched work (`dispatches > 0`) | the shorter `HYDRA_WORKLESS_BACKOFF_POSTWORK_SEC`, because new QA-able output can arrive sooner after a drain |

Non-idle causes stamp nothing. The gate honours whatever instant
`reasons.worklessUntil` carries, and the hint is launcher-only: it never sets
`allow=false` and never drains an in-flight or operator-launched session
(ADR-0021 boundary).

## Phase 0 schema-version handshake — rationale

The marker and the check are in SKILL.md § Phase 0 schema-version handshake.

A stale `~/.claude/skills/` mirror of this playbook against a newer `state.json`
shape makes the model wedge silently mid-reconcile. The handshake turns that into
a loud abort at second 0. A `state.json` with no `schema_version` field
mismatches every current playbook, so the handshake aborts and the operator
re-runs after `bootstrap.sh` writes a fresh state. `bootstrap.sh` is the single
writer for `state.json`; there is no in-place upgrader.

## The admission rule

The rule itself, that self-filed orchestrator defects are filed `hitl-grill` and
never `ready-for-agent`, is in SKILL.md § Self-filed work.

### Why (do not undo this without reading it)

Measured over the 14 days to 2026-08-19, orchestrator-side: 137 issues created,
159 closed, 0.9-day median lifetime, 78% closed inside 2 days, 100% inside 7. That
board was a churn buffer the loop refilled as fast as it drained, and `hydra-dev`
implementing it consumed 49.8% of all tokens while the Target merged one commit
in seven days.

The specimen: a suite-count gate was filed, merged, false-positived and reddened
master, was filed critical, and was reverted, all in roughly 36 hours with net
change zero.

None of that supply came from a producer class. `discover_orch`, `research_orch`,
`architecture_orch` and `cleanup_orch` were all idle, gated off an
`orch_backfill_idle` signal that cannot be true while the board is non-empty.
The supply was self-filed. The rule cuts the edge from "the loop noticed a
defect" to "the loop funds fixing it", which is the only edge that was ever
load-bearing.
