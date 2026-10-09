# hydra-autopilot — Operator guide

How a person runs, schedules, stops and inspects the autopilot, and the
reasoning behind three of its rules. The autopilot session does not need
this file to run a turn.

## Inspecting a run

- **One-shot status:** `bash scripts/autopilot/status.sh` — pretty-prints the heartbeat (+ wedge verdict), the compact state, and the log tail. Safe to wire to a shell prompt.
- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Liveness probe: `find /tmp/hydra-autopilot-heartbeat.txt -mmin -10` — the model writes the heartbeat every decision turn (Phase 5a). An empty result means no turn completed in the last 10 minutes.
- Live state: `jq '.slots,.signal_last_fired,.burned_classes' /tmp/hydra-autopilot-state.json`
- Run log: `tail -100 /tmp/hydra-autopilot-nightly.log` (filename is historical)
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
`--subagent-soft=`, `--subagent-hard=`, `--unattended=`, `--quota-5h-max=`,
`--quota-week-max=`) parse via `args-parse.sh` and override env vars. The two
`--quota-*` flags are the opt-in quota-percent budget (issue #3867 — see
**Termination**); unset means disabled.

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

### Stopping the autopilot: the two levers (issue #3868)

Two stop levers exist and they are **not** interchangeable:

| Lever | What stops | What keeps running |
|---|---|---|
| `POST /api/autopilot/paused` (`paused=true`) | **Everything.** The Pace Gate skips Claude AFK launches, AND `scripts/glm/drainer-loop.sh` honours the same durable flag (ADR-0032 Decision 6) — the GLM free lane freezes too. | Nothing. |
| `systemctl --user stop hydra-pace-gate.timer` | Claude AFK relaunches only — no new Autopilot Runs are admitted (a live run finishes its budget). `paused` stays `false`. | The GLM drainer keeps draining `glm-eligible` work on z.ai. |

**`paused=true` is the TOTAL stop; stopping `hydra-pace-gate.timer` is the
Claude-only stop.** Use the timer stop for a cost emergency where Anthropic
quota must stop burning but the free lane should keep shipping: during the
2026-08 cost-emergency shutdown the operator pause froze the drainer for days
while ~30 `glm-eligible` issues queued — the exact outage class this
distinction exists to prevent. Re-arm afterwards with
`systemctl --user start hydra-pace-gate.timer`.

Related watchdog coverage: the launch-flow block's `glm-sterile` signal
(`scripts/hydra-watchdog.sh`) alarms in-band when the drainer heartbeat is
fresh, `glm-eligible` + `ready-for-agent` work is queued, and zero drainer PRs
(the shared #4048 OR-predicate) were created in the trailing window (default
6h, `HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS`) — the live-but-sterile
failure (#3863) that liveness checks alone cannot see.

## Termination limits

The termination causes themselves are summarised in SKILL.md § Termination
and detailed in `hydra-autopilot-ops-reference.md`.

### Quota-percent budget (issue #3867)

`token_budget` is denominated in the **wrong currency**. It counts cumulative subagent-reported input/output tokens; what the operator pays is cache-weighted **account utilization**. Measured on run 2bcba309 (2026-08-05): the run "spent" 801k of a 4,000,000 token budget and would have kept dispatching, while the OAuth meter moved the 5h utilization window 2% → 30% over the same period (~150M raw tokens — one QA dispatch's 4-subagent fan-out moved ~15M, one dev dispatch ~40M). So a "conservative" token budget does not bound real spend.

The quota-percent budget is a second per-run cap denominated in **utilization points accrued over this run's own run-start baseline**:

| Knob | Env var | Meaning |
|---|---|---|
| `--quota-5h-max=<pts>` | `HYDRA_AUTOPILOT_QUOTA_5H_MAX` | terminate once `usage.percentLast5h` has risen this many points over the run-start baseline |
| `--quota-week-max=<pts>` | `HYDRA_AUTOPILOT_QUOTA_WEEK_MAX` | same, against `usage.percentSinceReset` |

- **Opt-in, default disabled.** Both stamp `state.limits.quota_5h_max_pts` / `quota_week_max_pts`, defaulting to `0` = the cap never fires. An unset flag leaves every existing termination path byte-identical, so the standing systemd invocation is unchanged by this feature. The token budget stays as a **secondary** bound.
- **Zero new I/O.** The Turn Snapshot already fetches `/usage/eligibility` every turn; the cap reads the nested `usage` object out of `state.usage_eligibility`.
- **Baseline capture.** `decide.py` writes `state.quota_baseline` **once**, lazily, on the first turn that sees a *calibrated* payload (persisted through the same tmp-file + `os.replace` write-back as the force-research and turn counters). `term-check.py` only *reads* that baseline — it stays side-effect-free, so Phase 3 simply prints `OK` on the very first turn and the authoritative check lands moments later in Phase 4.
- **Window resets are not spend.** If a current percentage drops below the baseline the 5h window (or the weekly reset anchor) rolled over: the delta clamps to zero **and** the baseline rebases down, so post-reset spend is measured fresh. A reset never reads as negative spend and never itself terminates.
- **Subordinate to the Pace Gate.** Per ADR-0021 D5 this is a per-run *hygiene* cap, not a second governor: it reads raw `percentLast5h` / `percentSinceReset` only, never `paceState` / `targetPercent`, and touches no Pace Gate admission logic.

### Workless-board backoff on a productive idle exit (issue #3867 slice 2)

`endRun` stamps the #2956 workless-board hint on **every** `cause=idle` termination, so the Pace Gate's next tick never launches a fresh session into a just-drained board:

| Idle exit | Window |
|---|---|
| dispatched nothing | full `HYDRA_WORKLESS_BACKOFF_SEC` (default 45 min) — unchanged |
| dispatched work (`dispatches > 0`) | shorter `HYDRA_WORKLESS_BACKOFF_POSTWORK_SEC` (default 20 min) — new QA-able output can arrive sooner after a drain |

Non-idle causes still stamp nothing. Pace Gate semantics are unchanged: it already honours whatever instant `reasons.worklessUntil` carries, and the hint remains **launcher-only** — never `allow=false`, never draining an in-flight or operator-launched session (the #2956 / ADR-0021 boundary).

## Phase 0 schema-version handshake — rationale

The handshake itself (the marker and the check) is in SKILL.md § Phase 0
schema-version handshake.

Why: a stale `~/.claude/skills/` mirror of this playbook against a newer
state.json shape makes the model silently wedge mid-reconcile. The handshake
converts that into a loud abort at second 0.

A v1 state.json (legacy, no `schema_version` field) is interpreted as
v1 via the `// 1` jq fallback above — mismatched against any modern
playbook, the handshake aborts and the operator re-runs after
`bootstrap.sh` writes a fresh v2 state on next invocation. There is
no in-place upgrader: bootstrap is the single writer for state.json.

## The admission rule

The rule itself — self-filed orchestrator defects are filed `hitl-grill`,
never `ready-for-agent` — is in SKILL.md § Self-filed work.

### Why (do not undo this without reading it)

Measured over the 14 days to 2026-08-19, orchestrator-side: **137 issues created,
159 closed, 0.9-day median lifetime, 78% closed inside 2 days, 100% inside 7.**
That board was not a backlog — it was a churn buffer the loop refilled as fast as
it drained, and `hydra-dev` implementing it consumed **49.8%** of all tokens while
the Target merged 1 commit in 7 days.

The specimen that made it legible: #4141 filed a suite-count gate, #4152 merged it,
it false-positived and reddened master, #4154 was filed CRITICAL, and #4157 reverted
it — filed, built, broke production, withdrawn, in roughly 36 hours, net change zero.

None of that came from a producer class. `discover_orch` / `research_orch` /
`architecture_orch` / `cleanup_orch` had all been dark since 2026-07-26, gated off a
`orch_backfill_idle` signal that cannot be true while the board is non-empty. The
supply was self-filed. This rule cuts the edge from "the loop noticed a defect" to
"the loop funds fixing it", which is the only edge that was ever load-bearing.
