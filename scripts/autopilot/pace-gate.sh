#!/usr/bin/env bash
#
# pace-gate.sh — the Pace Gate admission-control supervisor (ADR-0021, #858).
#
# Why this exists
# ---------------
# ADR-0021 turns hydra-autopilot from "scheduled batches" into a continuous,
# usage-paced background fill that yields to the operator. The legacy
# morning/evening timers (hydra-autopilot-morning.timer @ 10:00,
# hydra-autopilot.timer @ 22:00) are retired; this Gate is now the SOLE
# launcher of hydra-autopilot.service.
#
# The Gate is a frequent (~15 min) timer that runs a small admission check
# and decides whether to launch an Autopilot Run RIGHT NOW:
#
#   1. Already running?  An Autopilot Run is live if the service is active OR
#      /tmp/hydra-autopilot-state.json carries a live owning PID (kill -0).
#      → log "already running" and skip (exit 0). The Gate never stacks runs;
#      bootstrap.sh's concurrent-run guard is the second layer of protection.
#
#   2. Consult the Pacing Curve via GET /api/usage/eligibility (#857):
#        - .reasons.emergencyStop == true  → the 5-hour cap (>=90%) tripped.
#          Pause fully; skip.
#        - .paceState == "ahead"           → total burn is above the Pacing
#          Curve for this instant in the week. Pause; skip. The sawtooth
#          relaunches the moment burn falls back to/below the curve.
#        - otherwise ("on" / "behind", not emergency) → eligible. Launch:
#          `systemctl --user start hydra-autopilot.service`.
#
#   3. Eligibility endpoint unreachable → FAIL SAFE: do NOT launch. Pacing is
#      the governor; when we're blind to usage we must not burn quota. Log a
#      WARNING and skip (exit 0).
#
# Per ADR-0012 the Gate governs ADMISSION (should a run start now?), never
# WHAT WORK to do — that stays with decide.py. The Gate reuses the existing
# watchdog, bootstrap concurrent-run guard, and the service's
# Restart=on-failure untouched; it only ever *starts* the service.
#
# Style + idempotency
# -------------------
# Mirrors scripts/hydra-autopilot-watchdog.sh: reads the same state.json,
# extracts the owning PID, checks `kill -0`, checks `systemctl --user
# is-active`. Quiet on the common skip paths (one log line). set -euo
# pipefail, every failure path logged.
#
# Testability hooks (off-by-default; for the regression test only)
# ----------------------------------------------------------------
#   HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE=1
#       Skip the real `systemctl is-active` call and treat the service as
#       inactive. Lets the test exercise the launch-decision path without
#       poking systemd.
#   HYDRA_PACE_GATE_DRY_RUN=1
#       In the launch branch, log "would-start" and exit 0 instead of
#       actually `systemctl --user start`-ing the service.
#   HYDRA_PACE_GATE_ELIGIBILITY_URL
#       Override the eligibility endpoint URL (default
#       http://localhost:4000/api/usage/eligibility) so the test can point
#       at a local fixture server.
#
# Source of truth: this file in the repo at scripts/autopilot/pace-gate.sh.
# Deployed to ~/.local/bin/ by scripts/deploy.sh.

set -euo pipefail

SERVICE="hydra-autopilot.service"
STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
ELIGIBILITY_URL="${HYDRA_PACE_GATE_ELIGIBILITY_URL:-http://localhost:4000/api/usage/eligibility}"

log() {
  echo "hydra-pace-gate: $*"
}

# --- Step 1: skip if an Autopilot Run is already live ---
#
# Two independent signals; either being true means "already running".
# (a) the systemd unit is active, or (b) state.json carries a live owning
# PID. We check both because an operator can hand-launch /hydra-autopilot
# with the unit stopped, and we must not stack a second run on top.

if [[ "${HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE:-0}" != "1" ]] \
  && systemctl --user is-active --quiet "$SERVICE"; then
  log "already running ($SERVICE active); skipping"
  exit 0
fi

if [[ -f "$STATE_PATH" ]] && command -v jq >/dev/null 2>&1; then
  PID=$(jq -r '.pid // 0' "$STATE_PATH" 2>/dev/null || echo "0")
  if [[ -n "$PID" && "$PID" != "0" && "$PID" != "null" ]] && kill -0 "$PID" 2>/dev/null; then
    log "already running (state PID $PID alive); skipping"
    exit 0
  fi
fi

# --- Step 2: consult the Pacing Curve via /api/usage/eligibility ---
#
# Fail safe: if the endpoint is unreachable we must NOT launch — pacing is
# the governor and we will not burn quota while blind to usage.
if ! command -v curl >/dev/null 2>&1; then
  log "WARN curl not found; cannot consult eligibility — failing safe (not launching)"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  log "WARN jq not found; cannot parse eligibility — failing safe (not launching)"
  exit 0
fi

ELIGIBILITY_JSON=""
if ! ELIGIBILITY_JSON=$(curl -fsS --max-time 10 "$ELIGIBILITY_URL" 2>/dev/null); then
  log "WARN eligibility endpoint unreachable ($ELIGIBILITY_URL) — failing safe (not launching)"
  exit 0
fi

EMERGENCY_STOP=$(jq -r '.reasons.emergencyStop // false' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "parse-error")
PACE_STATE=$(jq -r '.paceState // "unknown"' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "parse-error")

if [[ "$EMERGENCY_STOP" == "parse-error" || "$PACE_STATE" == "parse-error" ]]; then
  log "WARN eligibility response unparseable — failing safe (not launching)"
  exit 0
fi

# --- Step 3: pause conditions ---
if [[ "$EMERGENCY_STOP" == "true" ]]; then
  log "5h emergencyStop — pausing (skip)"
  exit 0
fi

if [[ "$PACE_STATE" == "ahead" ]]; then
  log "ahead of pacing curve — pausing (skip)"
  exit 0
fi

# --- Step 4: eligible (paceState on/behind, not emergency) — launch ---
log "eligible (paceState=$PACE_STATE, emergencyStop=$EMERGENCY_STOP) — launching $SERVICE"

if [[ "${HYDRA_PACE_GATE_DRY_RUN:-0}" == "1" ]]; then
  log "would-start $SERVICE (DRY_RUN=1, test mode)"
  exit 0
fi

systemctl --user start "$SERVICE"
log "launched $SERVICE"

exit 0
