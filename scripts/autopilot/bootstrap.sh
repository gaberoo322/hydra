#!/usr/bin/env bash
#
# bootstrap.sh — Phase 0 of /hydra-autopilot.
#
# Heartbeat, run-log rotation, env parsing, and authoritative state.json
# initialization. The budget limits resolved here become first-class
# members of /tmp/hydra-autopilot-state.json so subsequent termination
# checks read from the state file (not from shell env, which doesn't
# persist between Claude turns).
#
# Inputs (env, all optional):
#   HYDRA_AUTOPILOT_TOKEN_BUDGET                (default 2000000)
#   HYDRA_AUTOPILOT_MAX_SEC                     (default 28800  — 8h)
#   HYDRA_AUTOPILOT_IDLE_TURNS                  (default 5)
#   HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS         (default 400000 — soft cap)
#   HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS    (default 800000 — hard cap)
#   HYDRA_AUTOPILOT_SCOPE                       (default all | orch-only | target-only)
#   HYDRA_AUTOPILOT_UNATTENDED                  (default auto — `true` if stdin is
#                                                NOT a TTY, `false` otherwise; an
#                                                explicit value of true|false wins
#                                                over the TTY auto-detect — issue #413)
#
# Inputs (slash args, all optional; processed by args-parse.sh; args > env):
#   --scope=<v>          --tokens=<N>          --token-budget=<N>
#   --max-sec=<N>        --max-seconds=<N>     --idle-turns=<N>
#   --subagent-soft=<N>  --subagent-hard=<N>   --unattended=<true|false>
#
# Unknown args are warned-and-ignored (e.g. trailing `focus=...` tokens).
#
# Side effects:
#   /tmp/hydra-autopilot-heartbeat.txt       (overwritten)
#   /tmp/hydra-autopilot-nightly.log         (truncated; old → .prev)
#   /tmp/hydra-autopilot-state.json          (initialized)
#
# Behavior-preserving extraction of the Phase 0 heredoc (issue #409),
# with slash-arg parsing layered on top (issue #410).

set -euo pipefail

# Slash-arg parsing — must run BEFORE env reads below so explicit args
# override implicit env (issue #410). Sourced (not exec'd) so the
# exports land in this shell.
# shellcheck source=./args-parse.sh
. "$(dirname "$0")/args-parse.sh" "$@"

# Heartbeat — Phase 0 marker.
#
# This is the FIRST write; subsequent decision turns must call
# scripts/autopilot/heartbeat.py to refresh the file (issue #435). The
# pid + run_id stamped here are propagated into state.json below so the
# per-turn updater can re-emit them on every line without re-querying
# the kernel for a pid that may have already exec'd into a child.
RUN_ID="$(uuidgen)"
PID=$$
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) start pid=${PID} run_id=${RUN_ID}" > /tmp/hydra-autopilot-heartbeat.txt

# Concurrent-run guard. If an existing state.json's owner PID is still alive,
# refuse to overwrite — that is a real collision and the second instance
# should bow out. If the owner PID is dead, log the recovery and proceed
# (the chronic case from 2026-05-16: morning run died from a transient API
# 5xx, its state.json was left stamped with the dead PID, and the auto-retry
# misread that as a live duplicate). Best-effort: a missing jq is treated
# as "no prior state" rather than aborting bootstrap.
if [ -f /tmp/hydra-autopilot-state.json ] && command -v jq >/dev/null 2>&1; then
  PRIOR_PID=$(jq -r '.pid // 0' /tmp/hydra-autopilot-state.json 2>/dev/null || echo 0)
  if [ "${PRIOR_PID}" -gt 0 ] && [ "${PRIOR_PID}" != "${PID}" ]; then
    if kill -0 "${PRIOR_PID}" 2>/dev/null; then
      echo "[autopilot] FATAL: prior autopilot pid=${PRIOR_PID} is alive; refusing to overwrite state.json"
      echo "[autopilot]   to force, kill ${PRIOR_PID} or remove /tmp/hydra-autopilot-state.json"
      exit 1
    fi
    echo "[autopilot] recovering from stale state (prior pid=${PRIOR_PID} is dead)"
  fi
fi

# Run log (overwrites previous run; previous-run content rotated to .prev)
[ -f /tmp/hydra-autopilot-nightly.log ] && mv /tmp/hydra-autopilot-nightly.log /tmp/hydra-autopilot-nightly.log.prev
: > /tmp/hydra-autopilot-nightly.log

# Resolve budget knobs from env (per-run override) with hardcoded defaults
TOKEN_BUDGET="${HYDRA_AUTOPILOT_TOKEN_BUDGET:-2000000}"
WALL_CLOCK_MAX_SEC="${HYDRA_AUTOPILOT_MAX_SEC:-28800}"   # 8h
IDLE_DRAIN_TURNS="${HYDRA_AUTOPILOT_IDLE_TURNS:-5}"

# Per-subagent token caps (issue #395). Soft cap = stop re-dispatching that
# class; hard cap = abandon the in-flight slot and open a runaway issue.
# Soft must be <= hard. Defaults bound a single misbehaving subagent to
# ~20% of the 2M total budget at the hard cap; well-behaved subagents
# (~30-150k tokens for a normal hydra-dev run) are unaffected.
SUBAGENT_MAX_TOKENS="${HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS:-400000}"
SUBAGENT_HARD_MAX_TOKENS="${HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS:-800000}"
if [ "$SUBAGENT_MAX_TOKENS" -gt "$SUBAGENT_HARD_MAX_TOKENS" ]; then
  echo "[autopilot] FATAL: HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS=$SUBAGENT_MAX_TOKENS exceeds HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS=$SUBAGENT_HARD_MAX_TOKENS"
  exit 1
fi

# Resolve scope from env. Allowed: all | orch-only | target-only. Default: all.
SCOPE="${HYDRA_AUTOPILOT_SCOPE:-all}"
case "$SCOPE" in
  all|orch-only|target-only) ;;
  *) echo "[autopilot] FATAL: HYDRA_AUTOPILOT_SCOPE=$SCOPE invalid (expected all|orch-only|target-only)"; exit 1 ;;
esac

# Resolve unattended mode (issue #413). Detection precedence chain:
#   1. Explicit HYDRA_AUTOPILOT_UNATTENDED=true|false  (always wins)
#   2. TTY auto-detect — `[ -t 0 ]` (interactive stdin) → false; non-TTY → true
# In unattended mode, the playbook must NOT invoke `AskUserQuestion`; it
# uses `scripts/autopilot/queue-decision.sh` to append a row to today's
# rolling `Operator decision queue YYYY-MM-DD` issue instead. The morning
# `/hydra-review` skill drains the queue.
if [ -n "${HYDRA_AUTOPILOT_UNATTENDED:-}" ]; then
  case "$HYDRA_AUTOPILOT_UNATTENDED" in
    true|TRUE|True|1|yes)   UNATTENDED="true" ;;
    false|FALSE|False|0|no) UNATTENDED="false" ;;
    *) echo "[autopilot] FATAL: HYDRA_AUTOPILOT_UNATTENDED=$HYDRA_AUTOPILOT_UNATTENDED invalid (expected true|false)"; exit 1 ;;
  esac
else
  if [ -t 0 ]; then
    UNATTENDED="false"
  else
    UNATTENDED="true"
  fi
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date -u +%s)"

# Schema version handshake (issue #434).
#
# Bumped every time the on-disk shape of state.json or the playbook's
# expectations of it change in an incompatible way. The playbook's
# `HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: <N>` marker MUST match the value
# written here; Phase 0 of the playbook fails loud on mismatch and
# instructs the operator to run `scripts/sync-skills.sh`.
#
# Bump procedure (operator-only):
#   1. Bump this constant in bootstrap.sh.
#   2. Bump the `HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA:` marker in
#      docs/operator-playbooks/hydra-autopilot.md.
#   3. Update test/autopilot-schema-version.test.mts to reflect the
#      new current version.
#   4. Run `./scripts/sync-skills.sh` so ~/.claude/skills/hydra-autopilot/
#      mirrors the new playbook.
#
# Why v2 today: the post-#426 schema collapsed the legacy 10 flat slots
# into 6 pipeline slots + 5 signal_last_fired. A v1 state.json (no
# schema_version field, ten-slot shape) is detected at Phase 0 as a
# legacy run; bootstrap re-runs and writes v2 on the next tick.
SCHEMA_VERSION=2

# Initialize state file — limits are now first-class members.
#
# Schema migration (issue #426 decision brain rewrite + issue #466 Phase B):
#   - `slots` now contains the 7 fixed pipeline slots:
#     dev_orch / qa_orch / research_orch + their _target peers + the
#     design_concept_orch slot added in #466. ALL SEVEN KEYS MUST BE
#     PRESENT (as `null`) — issue #431. The first successful γ run
#     (2026-05-15) observed `slots: {}` because an earlier bootstrap
#     variant emitted an empty dict; downstream defensive
#     `slots.get(cls)` reads in decide.py and assert_invariants.py
#     masked the bug, but INV-002's `slots.items()` iteration over an
#     empty dict silently allowed any dispatch. Pin the 7-key schema
#     here; tests in test/autopilot-scripts.test.mts and
#     test/autopilot-invariants.test.mts enforce both shapes.
#   - The previous signal-driven classes (health / sweep_* / discover_*)
#     no longer occupy slots; they track only their last-fired timestamp
#     under `signal_last_fired`, replacing the legacy
#     `/tmp/hydra-last-*.txt` files. ALL FIVE KEYS MUST BE PRESENT
#     (as `0`) for the same reason.
#   - `failure_log` is a new ring buffer of structured failure records
#     consumed by `self_heal.py` (issue #426 self-heal table).
#   - `reaped_task_ids` (issue #411) and `burned_classes` (issue #395)
#     are preserved unchanged.
#   - `schema_version` (issue #434) participates in the Phase 0 handshake.
#
# Backward compat: this heredoc OVERWRITES the existing file. A v1
# legacy state.json (or a v2 state.json with `slots: {}` empty) is
# clobbered on each bootstrap, so no migration path is needed —
# bootstrap is always run before the brain reads state.
cat > /tmp/hydra-autopilot-state.json <<EOF
{
  "started": "${STARTED_AT}",
  "started_epoch": ${STARTED_EPOCH},
  "pid": ${PID},
  "run_id": "${RUN_ID}",
  "limits": {
    "token_budget": ${TOKEN_BUDGET},
    "wall_clock_max_sec": ${WALL_CLOCK_MAX_SEC},
    "idle_drain_turns": ${IDLE_DRAIN_TURNS},
    "scope": "${SCOPE}",
    "subagent_max_tokens": ${SUBAGENT_MAX_TOKENS},
    "subagent_hard_max_tokens": ${SUBAGENT_HARD_MAX_TOKENS},
    "unattended": ${UNATTENDED},
    "schema_version": ${SCHEMA_VERSION}
  },
  "cumulative_tokens": 0,
  "dispatches": 0,
  "idle_turns": 0,
  "turn": 0,
  "burned_classes": [],
  "reaped_task_ids": [],
  "failure_log": [],
  "slots": {
    "dev_orch": null,
    "qa_orch": null,
    "research_orch": null,
    "dev_target": null,
    "qa_target": null,
    "research_target": null,
    "design_concept_orch": null
  },
  "signal_last_fired": {
    "health": 0,
    "sweep_orch": 0,
    "sweep_target": 0,
    "discover_orch": 0,
    "discover_target": 0
  }
}
EOF

# Echo resolved limits so the model captures them in conversation context
echo "[autopilot] limits resolved: token_budget=${TOKEN_BUDGET} wall_clock_max_sec=${WALL_CLOCK_MAX_SEC} idle_drain_turns=${IDLE_DRAIN_TURNS} scope=${SCOPE} subagent_soft=${SUBAGENT_MAX_TOKENS} subagent_hard=${SUBAGENT_HARD_MAX_TOKENS} unattended=${UNATTENDED} schema_version=${SCHEMA_VERSION}"
echo "[autopilot] state schema_version=${SCHEMA_VERSION} (playbook must match HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA marker; see Phase 0 handshake)"

# Issue #435 — overwrite the Phase 0 heartbeat with the structured
# per-turn format immediately so the file format is consistent from turn
# 0 onwards. Best-effort: a heartbeat-write failure must NOT abort
# bootstrap (we already wrote the legacy `start ...` line above which is
# enough for operators to see something).
python3 "$(dirname "$0")/heartbeat.py" --last-action=bootstrap || \
  echo "[autopilot] heartbeat.py initial write failed; continuing"

# Issue #497 — register this run with the orchestrator's autopilot-runs
# dashboard surface. Posts run-start with the limits payload + trigger from
# hour-of-day heuristic (UTC). Best-effort: orchestrator-down must not block
# bootstrap, so a curl failure is logged but ignored. The endpoint is
# idempotent on run_id, so a transient failure followed by a manual retry is
# safe.
#
# Trigger heuristic (UTC):
#   09:00–11:59 → morning-timer
#   21:00–23:59 → overnight-timer
#   else         → manual
HOUR_UTC=$(date -u +%H)
HOUR_NUM=$((10#${HOUR_UTC}))
if [ "${HOUR_NUM}" -ge 9 ] && [ "${HOUR_NUM}" -lt 12 ]; then
  TRIGGER="morning-timer"
elif [ "${HOUR_NUM}" -ge 21 ] && [ "${HOUR_NUM}" -le 23 ]; then
  TRIGGER="overnight-timer"
else
  TRIGGER="manual"
fi

HYDRA_API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"
RUN_START_PAYLOAD=$(cat <<JSON
{
  "run_id": "${RUN_ID}",
  "started": "${STARTED_AT}",
  "started_epoch": ${STARTED_EPOCH},
  "pid": ${PID},
  "trigger": "${TRIGGER}",
  "limits": {
    "token_budget": ${TOKEN_BUDGET},
    "wall_clock_max_sec": ${WALL_CLOCK_MAX_SEC},
    "idle_drain_turns": ${IDLE_DRAIN_TURNS},
    "scope": "${SCOPE}",
    "subagent_max_tokens": ${SUBAGENT_MAX_TOKENS},
    "subagent_hard_max_tokens": ${SUBAGENT_HARD_MAX_TOKENS},
    "unattended": ${UNATTENDED},
    "schema_version": ${SCHEMA_VERSION}
  }
}
JSON
)
curl -sf --max-time 5 -X POST \
  -H "content-type: application/json" \
  -d "${RUN_START_PAYLOAD}" \
  "${HYDRA_API_BASE}/api/autopilot/run-start" >/dev/null 2>&1 || \
  echo "[autopilot] run-start POST failed (orchestrator down?); continuing run_id=${RUN_ID} trigger=${TRIGGER}"
