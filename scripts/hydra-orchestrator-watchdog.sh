#!/usr/bin/env bash
#
# hydra-orchestrator-watchdog.sh
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
# Source of truth: this file in the repo at scripts/hydra-orchestrator-watchdog.sh.
# Deploy with: cp scripts/hydra-orchestrator-watchdog.sh ~/.local/bin/
#
# Only restarts when the service is meant to be active (respects a deliberate
# `systemctl --user stop`).

set -euo pipefail

STALE_THRESHOLD_SECONDS=900  # 15 minutes
SERVICE="hydra-orchestrator.service"
HEALTH_URL="http://localhost:4000/api/health"
SCHEDULER_STATUS_URL="http://localhost:4000/api/scheduler/status"
CYCLE_STATUS_URL="http://localhost:4000/api/cycle/status"

# Respect deliberate stops
if ! systemctl --user is-active --quiet "$SERVICE"; then
  echo "hydra-orchestrator-watchdog: $SERVICE is not active; nothing to do"
  exit 0
fi

# --- Check 0: Docker container liveness (MUST run first) ---
# Without Redis, the orchestrator crash-loops and all other checks are meaningless.
redis_ping=$(docker exec hydra-redis-1 redis-cli ping 2>/dev/null || echo "FAILED")
if [[ "$redis_ping" != "PONG" ]]; then
  echo "hydra-orchestrator-watchdog: Redis container not responding (got: $redis_ping) — restarting hydra-docker.service"
  systemctl --user restart hydra-docker.service
  sleep 5
  redis_retry=$(docker exec hydra-redis-1 redis-cli ping 2>/dev/null || echo "FAILED")
  if [[ "$redis_retry" == "PONG" ]]; then
    echo "hydra-orchestrator-watchdog: Docker containers recovered — restarting orchestrator"
    systemctl --user restart "$SERVICE"
  else
    echo "hydra-orchestrator-watchdog: Docker recovery FAILED — manual intervention needed"
  fi
  exit 0
fi

# --- Check 1: /health responds and reports ok + redis connected ---
health=$(curl -sS --max-time 5 "$HEALTH_URL" 2>&1 || echo "CURL_FAILED")
if [[ "$health" == "CURL_FAILED" || -z "$health" ]]; then
  echo "hydra-orchestrator-watchdog: $HEALTH_URL unreachable — restarting $SERVICE"
  systemctl --user restart "$SERVICE"
  exit 0
fi

status=$(echo "$health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status",""))' 2>/dev/null || echo "")
redis_ok=$(echo "$health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("redis",False))' 2>/dev/null || echo "False")

if [[ "$status" != "ok" ]]; then
  echo "hydra-orchestrator-watchdog: /health returned status='$status' (not 'ok') — restarting $SERVICE"
  systemctl --user restart "$SERVICE"
  exit 0
fi

if [[ "$redis_ok" != "True" ]]; then
  echo "hydra-orchestrator-watchdog: /health reports redis=$redis_ok — restarting $SERVICE"
  systemctl --user restart "$SERVICE"
  exit 0
fi

# --- Check 2: scheduler lastCycleAt is not stale (if running) ---
sched=$(curl -sS --max-time 5 "$SCHEDULER_STATUS_URL" 2>&1 || echo "CURL_FAILED")
if [[ "$sched" == "CURL_FAILED" ]]; then
  echo "hydra-orchestrator-watchdog: $SCHEDULER_STATUS_URL unreachable — restarting $SERVICE"
  systemctl --user restart "$SERVICE"
  exit 0
fi

running=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("running",False))' 2>/dev/null || echo "False")
if [[ "$running" != "True" ]]; then
  # Issue #388: respect deliberate stops. If the operator called
  # POST /scheduler/stop, /api/scheduler/status reports stopReason="deliberate"
  # and the scheduler writes a 24h Redis marker (hydra:scheduler:deliberate-stop)
  # that survives a service bounce. We must NOT auto-restart in that case —
  # the historical failure mode was the watchdog ticking the scheduler back on
  # within ~2 minutes of every operator stop. Auto-pause reasons
  # (circuit-breaker / error-cap) still warrant a restart attempt.
  stop_reason=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("stopReason","") or "")' 2>/dev/null || echo "")
  if [[ "$stop_reason" == "deliberate" ]]; then
    echo "hydra-orchestrator-watchdog: scheduler stopped deliberately (stopReason=deliberate); leaving alone"
    exit 0
  fi

  # Scheduler stopped — check if it's a fresh startup or a circuit breaker.
  # If uptime > 5 min and work exists, the scheduler self-stopped (zero-output
  # breaker or error cap). Restart it via API instead of restarting the service.
  uptime_s=$(echo "$health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(int(d.get("uptime",0)))' 2>/dev/null || echo "0")
  if (( uptime_s > 300 )); then
    # Check if there's work waiting
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
  exit 0
fi

last_tick_at=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("lastTickAt","") or "")' 2>/dev/null || echo "")
if [[ -z "$last_tick_at" ]]; then
  echo "hydra-orchestrator-watchdog: scheduler running but lastTickAt is null (fresh restart); leaving alone"
  exit 0
fi

# Before we judge staleness, check if a cycle is currently in progress.
# A legitimate research cycle can take 10+ minutes.
cycle=$(curl -sS --max-time 5 "$CYCLE_STATUS_URL" 2>&1 || echo "CURL_FAILED")
if [[ "$cycle" != "CURL_FAILED" ]]; then
  cycle_status=$(echo "$cycle" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status",""))' 2>/dev/null || echo "")
  if [[ "$cycle_status" == "running" ]]; then
    echo "hydra-orchestrator-watchdog: cycle in progress (status=$cycle_status); leaving alone"
    exit 0
  fi
fi

# Parse lastTickAt and compute age
last_tick_epoch=$(date -d "$last_tick_at" +%s 2>/dev/null || echo "")
if [[ -z "$last_tick_epoch" ]]; then
  echo "hydra-orchestrator-watchdog: could not parse lastTickAt='$last_tick_at'"
  exit 0
fi

now_epoch=$(date +%s)
age=$((now_epoch - last_tick_epoch))

if (( age < 0 )); then
  echo "hydra-orchestrator-watchdog: negative age (${age}s); clock skew — ignoring"
  exit 0
fi

if (( age > STALE_THRESHOLD_SECONDS )); then
  echo "hydra-orchestrator-watchdog: STALE — lastTickAt was ${age}s ago (> ${STALE_THRESHOLD_SECONDS}s) and no cycle in progress. Restarting $SERVICE"
  systemctl --user restart "$SERVICE"
  exit 0
fi

# --- Check 3: Cloudflare tunnel reachability ---
if systemctl --user is-active --quiet hydra-tunnel.service; then
  tunnel_health=$(curl -sS --max-time 5 "https://admin.clawstreetbets.xyz/api/health" 2>&1 || echo "TUNNEL_FAILED")
  if [[ "$tunnel_health" == "TUNNEL_FAILED" || -z "$tunnel_health" ]]; then
    echo "hydra-orchestrator-watchdog: tunnel unreachable externally but orchestrator healthy — restarting hydra-tunnel.service"
    systemctl --user restart hydra-tunnel.service
  fi
fi

# --- Check 5: Betting runner services — alert on repeated failures ---
for svc in hydra-betting-ingest hydra-betting-scan hydra-betting-alerts; do
  if systemctl --user is-failed --quiet "${svc}.service" 2>/dev/null; then
    echo "hydra-orchestrator-watchdog: WARNING — ${svc}.service is in failed state"
  fi
done

# --- Check 6: Venue credential health (run once per hour, not every 2 min) ---
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
