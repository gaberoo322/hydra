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
#
# Inputs (slash args, all optional; processed by args-parse.sh; args > env):
#   --scope=<v>          --tokens=<N>          --token-budget=<N>
#   --max-sec=<N>        --max-seconds=<N>     --idle-turns=<N>
#   --subagent-soft=<N>  --subagent-hard=<N>
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

# Heartbeat
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) start pid=$$ run_id=$(uuidgen)" > /tmp/hydra-autopilot-heartbeat.txt

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

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date -u +%s)"

# Initialize state file — limits are now first-class members
cat > /tmp/hydra-autopilot-state.json <<EOF
{
  "started": "${STARTED_AT}",
  "started_epoch": ${STARTED_EPOCH},
  "limits": {
    "token_budget": ${TOKEN_BUDGET},
    "wall_clock_max_sec": ${WALL_CLOCK_MAX_SEC},
    "idle_drain_turns": ${IDLE_DRAIN_TURNS},
    "scope": "${SCOPE}",
    "subagent_max_tokens": ${SUBAGENT_MAX_TOKENS},
    "subagent_hard_max_tokens": ${SUBAGENT_HARD_MAX_TOKENS}
  },
  "cumulative_tokens": 0,
  "dispatches": 0,
  "idle_turns": 0,
  "turn": 0,
  "burned_classes": [],
  "slots": {
    "health": null, "qa": null,
    "dev_orch": null, "dev_target": null,
    "research_orch": null, "research_target": null,
    "sweep_orch": null, "sweep_target": null,
    "discover_orch": null, "discover_target": null
  }
}
EOF

# Echo resolved limits so the model captures them in conversation context
echo "[autopilot] limits resolved: token_budget=${TOKEN_BUDGET} wall_clock_max_sec=${WALL_CLOCK_MAX_SEC} idle_drain_turns=${IDLE_DRAIN_TURNS} scope=${SCOPE} subagent_soft=${SUBAGENT_MAX_TOKENS} subagent_hard=${SUBAGENT_HARD_MAX_TOKENS}"
