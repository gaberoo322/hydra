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
#        - .reasons.paused == true          → operator-only Autopilot pause
#          (#988) is set. Skip launch entirely — no throwaway run spawned.
#          Most authoritative skip; checked first.
#        - .reasons.emergencyStop == true  → the 5-hour cap (>=90%) tripped.
#          Pause fully; skip.
#        - .reasons.weeklyEmergencyStop == true → the 7-day window is
#          exhausted (#1790). Skip until the Weekly Reset Anchor passes —
#          launching would only spawn runs that hard-stop in decide.py.
#        - .allow == false (catch-all, #1790) → the composed verdict from
#          projectEligibility() is negative for a reason none of the arms
#          above named (including reasons added after this script). Skip and
#          log the raw .reasons JSON. The reason-specific arms above exist
#          for log legibility; this arm is the authoritative backstop.
#        - .paceState == "ahead"           → total burn is above the Pacing
#          Curve for this instant in the week. Pause; skip. The sawtooth
#          relaunches the moment burn falls back to/below the curve.
#          (ADDITIVE to .allow — an ahead snapshot still has allow=true, so
#          this arm is a separate check, not subsumed by the catch-all.)
#        - otherwise ("on" / "behind", allow=true, not emergency, not paused)
#          → eligible. Launch: `systemctl --user start hydra-autopilot.service`.
#
#   3. Eligibility endpoint unreachable → FAIL SAFE: do NOT launch. Pacing is
#      the governor; when we're blind to usage we must not burn quota. Log a
#      WARNING and skip (exit 0).
#
# Per ADR-0012 the Gate governs ADMISSION (should a run start now?), never
# WHAT WORK to do — that stays with decide.py. The Gate reuses the existing
# watchdog, bootstrap concurrent-run guard, and the service's
# Restart=on-failure untouched; in timer mode it only ever *starts* the
# service.
#
# Exec mode — `pace-gate.sh --exec-autopilot` (issue #1089 recurrence)
# --------------------------------------------------------------------
# The timer path above is NOT the only way hydra-autopilot.service starts:
# the unit's Restart=on-failure relaunches it 180s after any failed exit,
# and that systemd-internal restart never consults this gate. Observed
# 2026-06-10 (run 342aba81): a session-limit exit (code=1) armed
# Restart=on-failure, and systemd relaunched the unit into the still-
# exhausted quota every 180s for hours (restart counter 53→60) even though
# the session-limit block from #1112 was armed — that block only gated the
# timer path.
#
# Fix: the unit's ExecStart now routes through THIS script in exec mode, so
# every start — timer-initiated `systemctl start` AND systemd-internal
# Restart= — passes the same admission check:
#
#   - Step 1's `systemctl is-active` self-check is skipped (the unit IS
#     active: it's us). The state.json live-PID check stays, guarding
#     against stacking a unit run on a hand-launched session.
#   - Steps 2–3 (eligibility consult + pause/session-block/emergencyStop/
#     pacing checks) run identically. A blocked or fail-safe outcome exits
#     0 — a CLEAN exit, so Restart=on-failure disarms instead of storming,
#     and no start slot is burned. The ~15-min timer resumes admission once
#     the block passes.
#   - Step 4, when eligible, `exec`s the claude CLI (same invocation the
#     unit used to run directly), replacing this shell so systemd keeps
#     tracking the session as the main process.
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
#       In the launch branch, log "would-start" (timer mode) / "would-exec"
#       (exec mode) and exit 0 instead of actually starting/exec'ing
#       anything.
#   HYDRA_PACE_GATE_EXEC_CMD
#       Exec-mode only: override the claude CLI invocation with an
#       arbitrary command line (word-split). Lets the test pin that the
#       eligible branch really execs without spawning a Claude session.
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

# Mode: "timer" (default — the ~15-min admission timer; launches the unit) or
# "exec" (--exec-autopilot — the unit's ExecStart wrapper; execs the CLI).
MODE="timer"
if [[ "${1:-}" == "--exec-autopilot" ]]; then
  MODE="exec"
fi

log() {
  echo "hydra-pace-gate: $*"
}

if [[ "$MODE" == "exec" ]]; then
  log "exec-autopilot mode (unit ExecStart wrapper, issue #1089)"
fi

# --- Step 1: skip if an Autopilot Run is already live ---
#
# Two independent signals; either being true means "already running".
# (a) the systemd unit is active, or (b) state.json carries a live owning
# PID. We check both because an operator can hand-launch /hydra-autopilot
# with the unit stopped, and we must not stack a second run on top.

# In exec mode the unit is BY DEFINITION active — it's us — so the is-active
# self-check is skipped (it would always trip and make every start a no-op).
# systemd itself guarantees single-instance per unit; the state-PID check
# below still guards against stacking onto a hand-launched session.
if [[ "$MODE" != "exec" && "${HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE:-0}" != "1" ]] \
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
# Issue #988: operator-only autopilot pause. The /api/usage/eligibility route
# overlays `.reasons.paused` from the Redis pause flag. When set, skip the
# launch entirely (no throwaway run spawned) — the operator paused autopilot.
PAUSED=$(jq -r '.reasons.paused // false' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "parse-error")
# Issue #1089: session-limit hard block. The route overlays
# `.reasons.sessionBlockedUntil` (ISO-8601) when the autopilot last exited with
# `You've hit your session limit · resets <t>` and that reset is still in the
# future. The OAuth 5h emergencyStop undershoots the true session limit, so
# without this the gate relaunches into an exhausted quota → repeat exit-1
# deaths. `null`/absent => no block.
SESSION_BLOCKED_UNTIL=$(jq -r '.reasons.sessionBlockedUntil // ""' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "parse-error")
# Issue #1790: weekly window exhausted (percentLast7d >= the weekly cap). The
# 7-day rolling window undershoots nothing — when it trips, every launched run
# hard-stops in decide.py within seconds, so launching is pure churn until the
# Weekly Reset Anchor passes.
WEEKLY_EMERGENCY_STOP=$(jq -r '.reasons.weeklyEmergencyStop // false' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "parse-error")
# Issue #1790: the composed verdict. projectEligibility() + the route's
# overlays fold EVERY hard-stop reason (5h emergencyStop, weeklyEmergencyStop,
# paused, future sessionBlockedUntil — and any future reason) into this single
# boolean. The reason-specific arms below stay for operator log legibility;
# the catch-all `.allow == false` arm guarantees the gate can never again
# drift from the route's composition (the bug this issue fixes).
#
# CRITICAL: bare `.allow`, NOT `.allow // true` — jq's `//` operator treats
# `false` itself as falsy, so `.allow // true` returns true when allow is
# false and would silently invert the fix. Strict string matching below:
# only the literal "true" proceeds; "false" skips; anything else (missing
# field => "null", garbage, parse failure) fails safe.
ALLOW=$(jq -r '.allow' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "parse-error")

if [[ "$EMERGENCY_STOP" == "parse-error" || "$PACE_STATE" == "parse-error" || "$PAUSED" == "parse-error" || "$SESSION_BLOCKED_UNTIL" == "parse-error" || "$WEEKLY_EMERGENCY_STOP" == "parse-error" || "$ALLOW" == "parse-error" ]]; then
  log "WARN eligibility response unparseable — failing safe (not launching)"
  exit 0
fi

# A missing or non-boolean .allow is treated as unparseable: the route has
# served a boolean allow since its inception and shares a host with this gate,
# so there is no version-skew window — extend the parse-error stance.
if [[ "$ALLOW" != "true" && "$ALLOW" != "false" ]]; then
  log "WARN eligibility .allow missing or non-boolean (got '$ALLOW') — failing safe (not launching)"
  exit 0
fi

# --- Step 3: pause conditions ---
# Issue #988: operator pause is the most authoritative skip — check it first.
if [[ "$PAUSED" == "true" ]]; then
  log "autopilot paused (operator) — skip"
  exit 0
fi

# Issue #1089: session-limit hard block. The route only surfaces a FUTURE
# instant (the overlay drops past ones), but we re-check against now defensively
# so a clock-skewed/stale value can never wedge the gate off. A non-future or
# unparseable value falls through to normal admission.
if [[ -n "$SESSION_BLOCKED_UNTIL" ]]; then
  BLOCK_EPOCH=$(date -d "$SESSION_BLOCKED_UNTIL" +%s 2>/dev/null || echo "")
  NOW_EPOCH=$(date -u +%s)
  if [[ -n "$BLOCK_EPOCH" && "$BLOCK_EPOCH" -gt "$NOW_EPOCH" ]]; then
    log "session-limit block until $SESSION_BLOCKED_UNTIL — skip (exhausted session quota)"
    exit 0
  fi
fi

if [[ "$EMERGENCY_STOP" == "true" ]]; then
  log "5h emergencyStop — pausing (skip)"
  exit 0
fi

# Issue #1790: weekly window exhausted. Reason-specific arm (log legibility)
# in front of the authoritative catch-all below.
if [[ "$WEEKLY_EMERGENCY_STOP" == "true" ]]; then
  log "weekly emergencyStop (7-day window exhausted) — skip until weekly reset"
  exit 0
fi

# Issue #1790 catch-all: the composed verdict is authoritative. Any reason —
# including ones added to projectEligibility() after this script was written —
# that folds allow=false blocks admission here, so the gate can never drift
# from the route's composition again. Log the raw reasons so the operator can
# see which (possibly future) reason produced the verdict.
if [[ "$ALLOW" == "false" ]]; then
  REASONS_JSON=$(jq -c '.reasons // {}' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "{}")
  log "eligibility allow=false — skip (reasons: $REASONS_JSON)"
  exit 0
fi

# Pacing Curve verdict is ADDITIVE to .allow (src/cost/eligibility.ts): a
# burn-ahead snapshot returns allow=true with paceState=ahead, so this arm
# CANNOT be folded into the .allow check above.
if [[ "$PACE_STATE" == "ahead" ]]; then
  log "ahead of pacing curve — pausing (skip)"
  exit 0
fi

# --- Step 4: eligible (paceState on/behind, not emergency) — launch/exec ---

if [[ "$MODE" == "exec" ]]; then
  log "eligible (paceState=$PACE_STATE, emergencyStop=$EMERGENCY_STOP) — exec'ing autopilot session"

  # Issue #2955 — stamp the launch mechanism for the run-start trigger field.
  # Every systemd-mediated start (pace-gate timer AND Restart= relaunch) routes
  # through this exec branch (issue #1089), so exporting here makes
  # bootstrap.sh's run-start POST report trigger=pace-gate instead of the
  # retired hour-of-day heuristic values. exec preserves the environment, so
  # the claude CLI (and its Bash-tool children, where bootstrap.sh runs)
  # inherit it. Ineligible exits (Steps 1-3) never reach this export.
  export HYDRA_AUTOPILOT_TRIGGER="pace-gate"

  if [[ "${HYDRA_PACE_GATE_DRY_RUN:-0}" == "1" ]]; then
    log "would-exec autopilot session (DRY_RUN=1, test mode)"
    exit 0
  fi

  if [[ -n "${HYDRA_PACE_GATE_EXEC_CMD:-}" ]]; then
    # Test-only hook: intentional word-split so the test can pass a full
    # command line (e.g. "echo exec-marker").
    # shellcheck disable=SC2086
    exec ${HYDRA_PACE_GATE_EXEC_CMD}
  fi

  # Same invocation hydra-autopilot.service's ExecStart used to run directly
  # (--dangerously-skip-permissions rationale lives in the unit file). exec
  # replaces this shell, so systemd tracks the CLI as the main process and
  # RuntimeMaxSec / SIGTERM semantics are unchanged.
  exec claude --dangerously-skip-permissions -p "/hydra-autopilot"
fi

log "eligible (paceState=$PACE_STATE, emergencyStop=$EMERGENCY_STOP) — launching $SERVICE"

if [[ "${HYDRA_PACE_GATE_DRY_RUN:-0}" == "1" ]]; then
  log "would-start $SERVICE (DRY_RUN=1, test mode)"
  exit 0
fi

systemctl --user start "$SERVICE"
log "launched $SERVICE"

exit 0
