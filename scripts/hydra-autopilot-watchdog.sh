#!/usr/bin/env bash
#
# hydra-autopilot-watchdog.sh
#
# External liveness watchdog for the hydra-autopilot Claude Code session.
#
# Why this exists
# ---------------
# When the autopilot `claude -p` parent process freezes mid-run — the
# process is still "active" by systemd's reckoning but the decision loop
# has stopped advancing — neither the systemd unit nor the unit's
# Restart=on-failure policy will recover it. The 2026-05-16 morning run
# went silent after a transient Anthropic 5xx and the 2026-05-17
# overnight run wedged at 06:44Z with `last_action=bootstrap` and ~22%
# of an 8h budget consumed. Both lost hours of autonomous work.
#
# This script closes that gap by observing the autopilot from outside:
# it reads the heartbeat file maintained by scripts/autopilot/heartbeat.py
# (refreshed on every decision turn), and if the heartbeat is stale
# beyond the threshold AND the recorded PID is still alive AND the
# systemd unit is meant to be active, it SIGTERMs (with grace, then
# SIGKILLs) the wedged process. The unit's Restart=on-failure policy
# (added on PR #488, parallel branch fix/autopilot-transient-recovery)
# then brings the autopilot back clean. This watchdog complements that
# PR but does not depend on it — even without Restart=on-failure the
# kill at least clears the wedged process so the next timer fire of
# hydra-autopilot.timer starts cleanly.
#
# Why 25-minute staleness threshold
# ---------------------------------
# scripts/autopilot/decide.py sets WALL_CLOCK_HEARTBEAT_SEC = 900 (15
# min idle wakeups). The threshold must absorb at least one dropped
# tick without false-positives, so >15 min is mandatory. 25 min gives
# ~1.6x margin while still bounding lost work below the typical
# operator notice window.
#
# Why `systemctl --user is-active` first
# --------------------------------------
# An operator can hand-launch /hydra-autopilot in a terminal session
# while the systemd unit is stopped. The systemd unit being inactive
# is the canonical signal "this autopilot is owned by a human, leave
# it alone." We exit 0 in that case — we MUST NOT kill an interactive
# session.
#
# Why SIGTERM + grace + SIGKILL
# -----------------------------
# SIGTERM gives the Claude Code harness a chance to flush logs,
# checkpoint state, and exit cleanly. Default 30s grace, then SIGKILL
# if the process is still alive. The systemd Restart=on-failure
# (where present) treats either exit signal as a failure and restarts.
#
# Testability hooks
# -----------------
# Two env vars exist solely for the regression test in
# test/autopilot-watchdog.test.mts; both are off-by-default in
# production:
#   HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE=1
#       Skip the real `systemctl is-active` call and treat the service
#       as inactive. Lets the test exercise the hand-launched path
#       without poking systemd.
#   HYDRA_AUTOPILOT_WATCHDOG_DRY_RUN=1
#       In the stale + alive-PID branch, log "would-SIGTERM ${PID}"
#       and exit 0 instead of actually issuing kill -TERM/-KILL. Lets
#       the test verify the decision path without killing the test
#       process itself.
#
# Source of truth: this file in the repo at
# scripts/hydra-autopilot-watchdog.sh. Deploy with:
#     cp scripts/hydra-autopilot-watchdog.sh ~/.local/bin/
# (scripts/deploy.sh now installs it automatically.)

set -euo pipefail

SERVICE="hydra-autopilot.service"
STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
HEARTBEAT_PATH="${HYDRA_AUTOPILOT_HEARTBEAT:-/tmp/hydra-autopilot-heartbeat.txt}"
STALE_THRESHOLD_SECONDS="${STALE_THRESHOLD_SECONDS:-1500}"  # 25 minutes
KILL_GRACE_SECONDS="${KILL_GRACE_SECONDS:-30}"

log() {
  echo "hydra-autopilot-watchdog: $*"
}

# --- Step 1: respect deliberate stops + hand-launched sessions ---
if [[ "${HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE:-0}" == "1" ]]; then
  log "service not active (FORCE_SERVICE_INACTIVE=1, test mode); nothing to do"
  exit 0
fi

if ! systemctl --user is-active --quiet "$SERVICE"; then
  log "service not active ($SERVICE); nothing to do (hand-launched or deliberately stopped)"
  exit 0
fi

# --- Step 2: read state.json to get PID + run_id ---
if [[ ! -f "$STATE_PATH" ]]; then
  log "no state file at $STATE_PATH (fresh boot or pre-bootstrap); leaving alone"
  exit 0
fi

PID=$(jq -r '.pid // 0' "$STATE_PATH" 2>/dev/null || echo "0")
RUN_ID=$(jq -r '.run_id // "unknown"' "$STATE_PATH" 2>/dev/null || echo "unknown")

if [[ -z "$PID" || "$PID" == "0" || "$PID" == "null" ]]; then
  log "state file has no pid (fresh bootstrap in flight); leaving alone"
  exit 0
fi

# --- Step 3: check PID is alive ---
if ! kill -0 "$PID" 2>/dev/null; then
  log "state PID $PID is dead (run_id=$RUN_ID); bootstrap will recover on next launch — leaving alone"
  exit 0
fi

# --- Step 4: check heartbeat file exists and read mtime ---
if [[ ! -f "$HEARTBEAT_PATH" ]]; then
  # Missing heartbeat alone is not a kill trigger — bootstrap might be
  # mid-write or heartbeat.py might be transiently failing. Log a warn
  # so operators can spot the case from journalctl, then exit clean.
  log "WARN heartbeat file missing at $HEARTBEAT_PATH (PID $PID alive); not escalating to kill"
  exit 0
fi

HEARTBEAT_MTIME=$(stat -c %Y "$HEARTBEAT_PATH" 2>/dev/null || echo "0")
NOW=$(date +%s)
AGE=$((NOW - HEARTBEAT_MTIME))

if (( AGE < 0 )); then
  log "negative heartbeat age (${AGE}s); clock skew — leaving alone"
  exit 0
fi

# --- Step 5: healthy path ---
if (( AGE < STALE_THRESHOLD_SECONDS )); then
  log "healthy (heartbeat ${AGE}s ago, PID $PID, run_id=$RUN_ID, threshold=${STALE_THRESHOLD_SECONDS}s)"
  exit 0
fi

# --- Step 6: wedged — kill the process ---
log "STALE — heartbeat ${AGE}s ago (> ${STALE_THRESHOLD_SECONDS}s), PID $PID alive (run_id=$RUN_ID) — sending SIGTERM"

if [[ "${HYDRA_AUTOPILOT_WATCHDOG_DRY_RUN:-0}" == "1" ]]; then
  log "would-SIGTERM $PID (DRY_RUN=1, test mode); would wait ${KILL_GRACE_SECONDS}s then would-SIGKILL"
  exit 0
fi

kill -TERM "$PID" 2>/dev/null || log "kill -TERM $PID failed (process may have already exited)"

sleep "$KILL_GRACE_SECONDS"

if kill -0 "$PID" 2>/dev/null; then
  log "grace expired (${KILL_GRACE_SECONDS}s) — PID $PID still alive — sending SIGKILL"
  kill -KILL "$PID" 2>/dev/null || log "kill -KILL $PID failed (process exited during grace)"
else
  log "PID $PID exited cleanly after SIGTERM"
fi

exit 0
