#!/usr/bin/env bash
#
# hydra-watchdog.sh — consolidated Hydra watchdog (issue #705)
#
# This script merges the two previously-separate watchdog scripts into one
# unit that runs at the finer (2-minute) cadence. It is split into two
# clearly-labelled blocks, each with its OWN stale threshold:
#
#   ## SERVICE LIVENESS   — the former hydra-orchestrator-watchdog.sh logic
#                           (HTTP / docker / scheduler-staleness / tunnel /
#                           credential checks, incl. the deliberate-stop
#                           reconciliation). Stale threshold: 15 min.
#   ## AUTOPILOT WEDGE     — the former hydra-autopilot-watchdog.sh PID-kill
#                           logic (incl. the HYDRA_AUTOPILOT_WATCHDOG_* test
#                           hooks). Stale threshold: 25 min. Do NOT shorten
#                           the SIGKILL threshold.
#
# The two blocks are INDEPENDENT: each is implemented as a function whose
# early returns short-circuit only that block. The original scripts used
# `exit 0` for those short-circuits; here those become `return 0` so a
# service-liveness short-circuit does NOT prevent the autopilot-wedge block
# from running on the same tick. The internal logic of each block is
# otherwise preserved verbatim from the source scripts.
#
# ⚠️ Tier-0 / Untouchable Core (ADR-0001). This is a live recovery mechanism.
# Source of truth: this file in the repo at scripts/hydra-watchdog.sh.
# Deployed by scripts/deploy.sh to ~/.local/bin/hydra-watchdog.sh.

set -euo pipefail

# =============================================================================
# ## SERVICE LIVENESS
# =============================================================================
#
# Detects when `hydra-orchestrator.service` is reporting "active (running)"
# but has silently stopped making progress. Three failure modes handled:
#
#   1. HTTP endpoint unresponsive — /health doesn't return 200
#   2. Scheduler stuck — running=true but lastTickAt is stale (>15 min old)
#      AND no cycle is currently in progress
#   3. Redis disconnected — /health returns redis:false
#
# Issue #397: liveness keys off `lastTickAt` (heartbeat of the scheduler's
# housekeeping loop). The in-process control loop's `lastCycleAt` field was
# removed in the scheduler-junk-drawer retirement (follow-up to ADR-0010);
# `lastTickAt` advances on every housekeeping pass, which is what we
# actually want for "is the scheduler still breathing".
#
# Ticks run every 5 minutes, so 15 minutes = ~3x safety margin. A
# legitimate long-running operation that pauses the tick (e.g. a research
# cycle holding the loop for 10+ minutes) is NOT restarted, because we
# check /cycle/status and skip if status=running.
#
# Only restarts when the service is meant to be active (respects a deliberate
# `systemctl --user stop`).

run_service_liveness() {
  local STALE_THRESHOLD_SECONDS=900  # 15 minutes
  local SERVICE="hydra-orchestrator.service"
  local HEALTH_URL="http://localhost:4000/api/health"
  local SCHEDULER_STATUS_URL="http://localhost:4000/api/scheduler/status"
  local CYCLE_STATUS_URL="http://localhost:4000/api/cycle/status"

  # Respect deliberate stops
  if ! systemctl --user is-active --quiet "$SERVICE"; then
    echo "hydra-orchestrator-watchdog: $SERVICE is not active; nothing to do"
    return 0
  fi

  # --- Check 0: Docker container liveness (MUST run first) ---
  # Without Redis, the orchestrator crash-loops and all other checks are meaningless.
  local redis_ping
  redis_ping=$(docker exec hydra-redis-1 redis-cli ping 2>/dev/null || echo "FAILED")
  if [[ "$redis_ping" != "PONG" ]]; then
    echo "hydra-orchestrator-watchdog: Redis container not responding (got: $redis_ping) — restarting hydra-docker.service"
    systemctl --user restart hydra-docker.service
    sleep 5
    local redis_retry
    redis_retry=$(docker exec hydra-redis-1 redis-cli ping 2>/dev/null || echo "FAILED")
    if [[ "$redis_retry" == "PONG" ]]; then
      echo "hydra-orchestrator-watchdog: Docker containers recovered — restarting orchestrator"
      systemctl --user restart "$SERVICE"
    else
      echo "hydra-orchestrator-watchdog: Docker recovery FAILED — manual intervention needed"
    fi
    return 0
  fi

  # --- Check 1: /health responds and reports ok + redis connected ---
  local health
  health=$(curl -sS --max-time 5 "$HEALTH_URL" 2>&1 || echo "CURL_FAILED")
  if [[ "$health" == "CURL_FAILED" || -z "$health" ]]; then
    echo "hydra-orchestrator-watchdog: $HEALTH_URL unreachable — restarting $SERVICE"
    systemctl --user restart "$SERVICE"
    return 0
  fi

  local status redis_ok
  status=$(echo "$health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status",""))' 2>/dev/null || echo "")
  redis_ok=$(echo "$health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("redis",False))' 2>/dev/null || echo "False")

  if [[ "$status" != "ok" ]]; then
    echo "hydra-orchestrator-watchdog: /health returned status='$status' (not 'ok') — restarting $SERVICE"
    systemctl --user restart "$SERVICE"
    return 0
  fi

  if [[ "$redis_ok" != "True" ]]; then
    echo "hydra-orchestrator-watchdog: /health reports redis=$redis_ok — restarting $SERVICE"
    systemctl --user restart "$SERVICE"
    return 0
  fi

  # --- Check 2: scheduler lastCycleAt is not stale (if running) ---
  local sched
  sched=$(curl -sS --max-time 5 "$SCHEDULER_STATUS_URL" 2>&1 || echo "CURL_FAILED")
  if [[ "$sched" == "CURL_FAILED" ]]; then
    echo "hydra-orchestrator-watchdog: $SCHEDULER_STATUS_URL unreachable — restarting $SERVICE"
    systemctl --user restart "$SERVICE"
    return 0
  fi

  local running
  running=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("running",False))' 2>/dev/null || echo "False")
  if [[ "$running" != "True" ]]; then
    # Issue #388: respect deliberate stops. If the operator called
    # POST /scheduler/stop, /api/scheduler/status reports stopReason="deliberate"
    # and the scheduler writes a 24h Redis marker (hydra:scheduler:deliberate-stop)
    # that survives a service bounce. We must NOT auto-restart in that case —
    # the historical failure mode was the watchdog ticking the scheduler back on
    # within ~2 minutes of every operator stop. Auto-pause reasons
    # (circuit-breaker / error-cap) still warrant a restart attempt.
    local stop_reason
    stop_reason=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("stopReason","") or "")' 2>/dev/null || echo "")
    if [[ "$stop_reason" == "deliberate" ]]; then
      echo "hydra-orchestrator-watchdog: scheduler stopped deliberately (stopReason=deliberate); leaving alone"
      return 0
    fi

    # Scheduler stopped — check if it's a fresh startup or a circuit breaker.
    # If uptime > 5 min and work exists, the scheduler self-stopped (zero-output
    # breaker or error cap). Restart it via API instead of restarting the service.
    local uptime_s
    uptime_s=$(echo "$health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(int(d.get("uptime",0)))' 2>/dev/null || echo "0")
    if (( uptime_s > 300 )); then
      # Check if there's work waiting
      local queue_depth work_queue total_work
      queue_depth=$(curl -sS --max-time 5 "http://localhost:4000/api/backlog" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
total=sum(len(d.get(l,[])) for l in ['queued','inProgress','triage','backlog'])
print(total)
" 2>/dev/null || echo "0")
      work_queue=$(docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null || echo "0")
      total_work=$((queue_depth + work_queue))

      if (( total_work > 0 )); then
        echo "hydra-orchestrator-watchdog: scheduler stopped but ${total_work} items waiting (uptime ${uptime_s}s, stopReason=${stop_reason:-none}) — restarting scheduler via API"
        curl -sS --max-time 5 -X POST "http://localhost:4000/api/scheduler/start" \
          -H "content-type: application/json" -d '{}' >/dev/null 2>&1 || true
      else
        echo "hydra-orchestrator-watchdog: scheduler stopped, no work pending; leaving alone"
      fi
    else
      echo "hydra-orchestrator-watchdog: scheduler not yet running (startup window, uptime ${uptime_s}s); leaving alone"
    fi
    return 0
  fi

  local last_tick_at
  last_tick_at=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("lastTickAt","") or "")' 2>/dev/null || echo "")
  if [[ -z "$last_tick_at" ]]; then
    echo "hydra-orchestrator-watchdog: scheduler running but lastTickAt is null (fresh restart); leaving alone"
    return 0
  fi

  # Before we judge staleness, check if a cycle is currently in progress.
  # A legitimate research cycle can take 10+ minutes.
  local cycle cycle_status
  cycle=$(curl -sS --max-time 5 "$CYCLE_STATUS_URL" 2>&1 || echo "CURL_FAILED")
  if [[ "$cycle" != "CURL_FAILED" ]]; then
    cycle_status=$(echo "$cycle" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status",""))' 2>/dev/null || echo "")
    if [[ "$cycle_status" == "running" ]]; then
      echo "hydra-orchestrator-watchdog: cycle in progress (status=$cycle_status); leaving alone"
      return 0
    fi
  fi

  # Parse lastTickAt and compute age
  local last_tick_epoch
  last_tick_epoch=$(date -d "$last_tick_at" +%s 2>/dev/null || echo "")
  if [[ -z "$last_tick_epoch" ]]; then
    echo "hydra-orchestrator-watchdog: could not parse lastTickAt='$last_tick_at'"
    return 0
  fi

  local now_epoch age
  now_epoch=$(date +%s)
  age=$((now_epoch - last_tick_epoch))

  if (( age < 0 )); then
    echo "hydra-orchestrator-watchdog: negative age (${age}s); clock skew — ignoring"
    return 0
  fi

  if (( age > STALE_THRESHOLD_SECONDS )); then
    echo "hydra-orchestrator-watchdog: STALE — lastTickAt was ${age}s ago (> ${STALE_THRESHOLD_SECONDS}s) and no cycle in progress. Restarting $SERVICE"
    systemctl --user restart "$SERVICE"
    return 0
  fi

  # --- Check 3: Cloudflare tunnel reachability ---
  if systemctl --user is-active --quiet hydra-tunnel.service; then
    local tunnel_health
    tunnel_health=$(curl -sS --max-time 5 "https://admin.clawstreetbets.xyz/api/health" 2>&1 || echo "TUNNEL_FAILED")
    if [[ "$tunnel_health" == "TUNNEL_FAILED" || -z "$tunnel_health" ]]; then
      echo "hydra-orchestrator-watchdog: tunnel unreachable externally but orchestrator healthy — restarting hydra-tunnel.service"
      systemctl --user restart hydra-tunnel.service
    fi
  fi

  # --- Check 5: Betting runner services — alert on repeated failures ---
  local svc
  for svc in hydra-betting-ingest hydra-betting-scan hydra-betting-alerts; do
    if systemctl --user is-failed --quiet "${svc}.service" 2>/dev/null; then
      echo "hydra-orchestrator-watchdog: WARNING — ${svc}.service is in failed state"
    fi
  done

  # --- Check 6: Venue credential health (run once per hour, not every 2 min) ---
  local CRED_CHECK_FLAG kalshi_check
  CRED_CHECK_FLAG="/tmp/hydra-cred-check-$(date +%Y%m%d%H)"
  if [[ ! -f "$CRED_CHECK_FLAG" ]]; then
    touch "$CRED_CHECK_FLAG"
    # Kalshi balance check (uses auth)
    kalshi_check=$(curl -sS --max-time 10 "http://localhost:3333/api/kalshi/balance" 2>&1 || echo "FAILED")
    if echo "$kalshi_check" | grep -q "balanceDollars"; then
      : # Kalshi credentials OK
    elif echo "$kalshi_check" | grep -qi "auth\|credential\|unauthorized\|FAILED"; then
      echo "hydra-orchestrator-watchdog: WARNING — Kalshi credential check failed: $(echo "$kalshi_check" | head -c 200)"
    fi
  fi

  echo "hydra-orchestrator-watchdog: healthy (lastCycleAt ${age}s ago, cycle=idle, redis=ok)"
  return 0
}

# =============================================================================
# ## AUTOPILOT WEDGE
# =============================================================================
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

run_autopilot_wedge() {
  local SERVICE="hydra-autopilot.service"
  local STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
  local HEARTBEAT_PATH="${HYDRA_AUTOPILOT_HEARTBEAT:-/tmp/hydra-autopilot-heartbeat.txt}"
  local STALE_THRESHOLD_SECONDS="${STALE_THRESHOLD_SECONDS:-1500}"  # 25 minutes
  local KILL_GRACE_SECONDS="${KILL_GRACE_SECONDS:-30}"

  log() {
    echo "hydra-autopilot-watchdog: $*"
  }

  # --- Step 1: respect deliberate stops + hand-launched sessions ---
  if [[ "${HYDRA_AUTOPILOT_WATCHDOG_FORCE_SERVICE_INACTIVE:-0}" == "1" ]]; then
    log "service not active (FORCE_SERVICE_INACTIVE=1, test mode); nothing to do"
    return 0
  fi

  if ! systemctl --user is-active --quiet "$SERVICE"; then
    log "service not active ($SERVICE); nothing to do (hand-launched or deliberately stopped)"
    return 0
  fi

  # --- Step 2: read state.json to get PID + run_id ---
  if [[ ! -f "$STATE_PATH" ]]; then
    log "no state file at $STATE_PATH (fresh boot or pre-bootstrap); leaving alone"
    return 0
  fi

  local PID RUN_ID
  PID=$(jq -r '.pid // 0' "$STATE_PATH" 2>/dev/null || echo "0")
  RUN_ID=$(jq -r '.run_id // "unknown"' "$STATE_PATH" 2>/dev/null || echo "unknown")

  if [[ -z "$PID" || "$PID" == "0" || "$PID" == "null" ]]; then
    log "state file has no pid (fresh bootstrap in flight); leaving alone"
    return 0
  fi

  # --- Step 3: check PID is alive ---
  if ! kill -0 "$PID" 2>/dev/null; then
    log "state PID $PID is dead (run_id=$RUN_ID); bootstrap will recover on next launch — leaving alone"
    return 0
  fi

  # --- Step 4: check heartbeat file exists and read mtime ---
  if [[ ! -f "$HEARTBEAT_PATH" ]]; then
    # Missing heartbeat alone is not a kill trigger — bootstrap might be
    # mid-write or heartbeat.py might be transiently failing. Log a warn
    # so operators can spot the case from journalctl, then exit clean.
    log "WARN heartbeat file missing at $HEARTBEAT_PATH (PID $PID alive); not escalating to kill"
    return 0
  fi

  local HEARTBEAT_MTIME NOW AGE
  HEARTBEAT_MTIME=$(stat -c %Y "$HEARTBEAT_PATH" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  AGE=$((NOW - HEARTBEAT_MTIME))

  if (( AGE < 0 )); then
    log "negative heartbeat age (${AGE}s); clock skew — leaving alone"
    return 0
  fi

  # --- Step 5: healthy path ---
  if (( AGE < STALE_THRESHOLD_SECONDS )); then
    log "healthy (heartbeat ${AGE}s ago, PID $PID, run_id=$RUN_ID, threshold=${STALE_THRESHOLD_SECONDS}s)"
    return 0
  fi

  # --- Step 6: wedged — kill the process ---
  log "STALE — heartbeat ${AGE}s ago (> ${STALE_THRESHOLD_SECONDS}s), PID $PID alive (run_id=$RUN_ID) — sending SIGTERM"

  if [[ "${HYDRA_AUTOPILOT_WATCHDOG_DRY_RUN:-0}" == "1" ]]; then
    log "would-SIGTERM $PID (DRY_RUN=1, test mode); would wait ${KILL_GRACE_SECONDS}s then would-SIGKILL"
    return 0
  fi

  kill -TERM "$PID" 2>/dev/null || log "kill -TERM $PID failed (process may have already exited)"

  sleep "$KILL_GRACE_SECONDS"

  if kill -0 "$PID" 2>/dev/null; then
    log "grace expired (${KILL_GRACE_SECONDS}s) — PID $PID still alive — sending SIGKILL"
    kill -KILL "$PID" 2>/dev/null || log "kill -KILL $PID failed (process exited during grace)"
  else
    log "PID $PID exited cleanly after SIGTERM"
  fi

  return 0
}

# =============================================================================
# Entry point — run both blocks on every tick. Each block is independent and
# self-contained; a short-circuit in one MUST NOT skip the other.
# =============================================================================

run_service_liveness
run_autopilot_wedge

exit 0
