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

# read_pending_work OUT_COUNT OUT_FAILED
# -----------------------------------------------------------------------------
# Issue #3794: the watchdog's "is there work waiting?" signal for the
# scheduler-recovery decision. Reads REAL sources — the orchestrator GitHub
# board (gaberoo322/hydra) plus the Redis anchor work-queue — replacing the
# retired /api/backlog HTTP surface, which was deleted by #3439 / PR #3455
# (ADR-0031) and now 404s. The previous `curl .../api/backlog || echo "0"`
# guard degraded SILENTLY to 0 on that 404, so the signal was permanently 0
# and the scheduler-recovery path stayed disarmed in exactly the state it
# exists to recover from (a self-stopped scheduler with an empty work-queue).
#
# Board signal: open issues carrying an actionable label — ready-for-agent,
# needs-research, needs-triage — mirroring the orch_backfill_idle signal in
# scripts/autopilot/collect-state.sh (the lanes the scheduler actively drains;
# ready_for_agent is the dev_orch dispatch source signal per its line ~99).
# Read directly via REST `gh issue list` — never GraphQL (ADR-0031 Decision 6,
# and the GraphQL rate-limit hazard, operator memory
# reference_gh_graphql_vs_rest_ratelimit).
#
# HARD RULE (issue #3794 acceptance criterion 2): a monitoring script must
# NEVER treat "I could not read it" as "there is none". On ANY read failure
# (non-zero exit OR non-integer output from gh or redis-cli) this function
# sets OUT_FAILED=1, logs a WARN naming the failed signal, and leaves
# OUT_COUNT=0; the caller then forces the restart branch because "could not
# prove there is no work" must not disarm recovery.
#
# Args (bash namerefs): OUT_COUNT receives the summed pending-work count (0 on
# any failure); OUT_FAILED receives 1 if any signal read failed, else 0.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-pending-work.test.mts), mirroring the HYDRA_*_BIN overrides in
# test/host-probe.test.mts:
#   HYDRA_GH_BIN      Override the `gh` binary used for the board read.
#   HYDRA_DOCKER_BIN  Override the `docker` binary used for the work-queue read.
# -----------------------------------------------------------------------------
read_pending_work() {
  local -n _rpw_count="$1"
  local -n _rpw_failed="$2"
  # All internal locals are _rpw_-prefixed so they can never share a name with
  # a caller's nameref target (bash resolves a nameref to the nearest-scope
  # variable of that name, so an unprefixed `local count` here would shadow the
  # caller's `count` and the final assignment would never reach the caller).
  local _rpw_gh_bin="${HYDRA_GH_BIN:-gh}"
  local _rpw_docker_bin="${HYDRA_DOCKER_BIN:-docker}"
  local _rpw_limit=100  # GitHub API max single page; mirrors collect-state.sh GH_ISSUE_LIST_LIMIT.
  local _rpw_board_total=0 _rpw_work_queue=0
  _rpw_failed=0
  _rpw_count=0

  # --- Board: sum actionable open issues across the three drain lanes. ---
  local _rpw_label _rpw_n
  for _rpw_label in ready-for-agent needs-research needs-triage; do
    _rpw_n=$("$_rpw_gh_bin" issue list --repo gaberoo322/hydra --state open \
      --label "$_rpw_label" --limit "$_rpw_limit" \
      --json number --jq 'length' 2>/dev/null) || {
      echo "hydra-orchestrator-watchdog: WARN board read FAILED for label '$_rpw_label' ($_rpw_gh_bin issue list exited non-zero) — cannot prove no work pending"
      _rpw_failed=1
      return 0
    }
    if ! [[ "$_rpw_n" =~ ^[0-9]+$ ]]; then
      echo "hydra-orchestrator-watchdog: WARN board read for label '$_rpw_label' returned non-integer '$_rpw_n' — cannot prove no work pending"
      _rpw_failed=1
      return 0
    fi
    _rpw_board_total=$((_rpw_board_total + _rpw_n))
  done

  # --- Work-queue: hydra:anchors:work-queue length, via the same Redis
  # container the script pings for the Check 0 liveness probe. ---
  _rpw_work_queue=$("$_rpw_docker_bin" exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null) || {
    echo "hydra-orchestrator-watchdog: WARN work-queue read FAILED ($_rpw_docker_bin exec redis-cli LLEN exited non-zero) — cannot prove no work pending"
    _rpw_failed=1
    return 0
  }
  if ! [[ "$_rpw_work_queue" =~ ^[0-9]+$ ]]; then
    echo "hydra-orchestrator-watchdog: WARN work-queue read returned non-integer '$_rpw_work_queue' — cannot prove no work pending"
    _rpw_failed=1
    return 0
  fi

  _rpw_count=$((_rpw_board_total + _rpw_work_queue))
}

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
      # Check if there's work waiting (issue #3794). Real signals: the
      # orchestrator GitHub board (gaberoo322/hydra) + hydra:anchors:work-queue.
      # The old read hit /api/backlog, which 404s (deleted by #3455 / ADR-0031),
      # and its `|| echo "0"` guard silently zeroed queue_depth — disarming this
      # recovery path in exactly the state it exists to recover from. A read
      # failure now logs loudly and forces a restart: a monitoring script must
      # never treat "I could not read it" as "there is none". See
      # read_pending_work for the per-signal failure handling.
      local total_work work_read_failed
      read_pending_work total_work work_read_failed

      if (( work_read_failed == 0 && total_work == 0 )); then
        echo "hydra-orchestrator-watchdog: scheduler stopped, no work pending (board+queue=0); leaving alone"
      else
        if (( work_read_failed )); then
          echo "hydra-orchestrator-watchdog: scheduler stopped and a work-signal read FAILED — cannot prove no work pending (uptime ${uptime_s}s, stopReason=${stop_reason:-none}); restarting scheduler via API (fail-safe)"
        else
          echo "hydra-orchestrator-watchdog: scheduler stopped but ${total_work} items waiting (uptime ${uptime_s}s, stopReason=${stop_reason:-none}) — restarting scheduler via API"
        fi
        curl -sS --max-time 5 -X POST "http://localhost:4000/api/scheduler/start" \
          -H "content-type: application/json" -d '{}' >/dev/null 2>&1 || true
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
# kill at least clears the wedged process so the next launch by the Pace
# Gate (hydra-pace-gate.timer, ADR-0021) starts cleanly.
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
# ## DEPLOY DRIFT
# =============================================================================
#
# Deploy-drift backstop (issue #734, split from #712 option 2).
#
# Why this exists
# ---------------
# Deploys are driven by a self-hosted GitHub Actions runner on merge to
# master (deploy.sh). When two master merges land back-to-back, the
# deploy workflow's concurrency group cancels the earlier job's deploy —
# so production can silently lag master by one (or more) merge waves
# without any health check noticing (the service stays "ok" the whole
# time; it's just running stale code). See operator memory
# `reference_deploy_concurrency_cancels_master`. This block is the
# backstop: it compares the SHA the orchestrator is *running from*
# against `origin/master` HEAD and surfaces drift.
#
# Read-only on the main tree (HARD invariant)
# -------------------------------------------
# This block NEVER mutates the $HYDRA_ROOT working tree or any local ref.
#   - Deployed SHA: `git rev-parse HEAD` (pure read).
#   - Remote SHA:   `git ls-remote origin master` (network read; touches
#                   no local ref, no FETCH_HEAD, no working tree). We
#                   deliberately do NOT `git fetch` — fetch mutates
#                   remote-tracking refs and, worse, a stray checkout/pull
#                   would clobber operator WIP. grounding.ts is read-only
#                   for the same reason; this block mirrors that rule.
#
# Advisory by default (HARD invariant)
# ------------------------------------
# On drift the default action is a WARNING log line ONLY (visible in
# `journalctl --user -u hydra-watchdog.service`). Auto-running deploy.sh
# is an explicit, separately-gated, grace-windowed opt-in:
#
#   HYDRA_WATCHDOG_AUTODEPLOY=1        Enable auto-deploy on sustained drift.
#                                      OFF by default — drift is advisory.
#   HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS  (default 600 = 10 min)
#                                      Drift must persist at least this long
#                                      before auto-deploy fires. A single
#                                      tick that catches a deploy mid-flight
#                                      must NOT trigger a redundant deploy.
#                                      Tracked via a marker file holding the
#                                      epoch when the drift was first seen.
#
# Even with auto-deploy enabled, this block respects deliberate operator
# stops: if the orchestrator scheduler reports stopReason="deliberate"
# (POST /scheduler/stop, issue #388), the operator has paused the system
# on purpose and we must NOT redeploy underneath them.
#
# Fail-safe (HARD invariant)
# --------------------------
# Any git error, network failure, unparseable SHA, or missing $HYDRA_ROOT
# logs a WARN and returns 0. Drift detection is a backstop; it must never
# be the thing that wedges the watchdog. The whole script ends `exit 0`.
#
# Testability hooks (off-by-default; pinned by test/watchdog-deploy-drift.test.mts)
# --------------------------------------------------------------------------------
#   HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA   Inject the "deployed" SHA, skipping
#                                       the real `git rev-parse HEAD`.
#   HYDRA_WATCHDOG_DRIFT_REMOTE_SHA     Inject the "origin/master" SHA,
#                                       skipping the real `git ls-remote`.
#   HYDRA_WATCHDOG_AUTODEPLOY_DRY_RUN=1 In the auto-deploy branch, log
#                                       "would-deploy" and return 0 instead
#                                       of execing deploy.sh.
#   HYDRA_WATCHDOG_DRIFT_STATE_DIR      Override the marker-file dir (default
#                                       /tmp) so tests don't collide with a
#                                       live watchdog.

run_deploy_drift() {
  local HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
  local STATE_DIR="${HYDRA_WATCHDOG_DRIFT_STATE_DIR:-/tmp}"
  local DRIFT_MARKER="${STATE_DIR}/hydra-watchdog-drift-since"
  local GRACE_SECONDS="${HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS:-600}"

  log() {
    echo "hydra-deploy-drift-watchdog: $*"
  }

  # --- Resolve deployed SHA (read-only) ---
  local deployed_sha
  if [[ -n "${HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA:-}" ]]; then
    deployed_sha="$HYDRA_WATCHDOG_DRIFT_DEPLOYED_SHA"
  else
    if [[ ! -d "$HYDRA_ROOT/.git" ]]; then
      log "WARN $HYDRA_ROOT is not a git repo (.git missing); skipping drift check"
      return 0
    fi
    deployed_sha=$(git -C "$HYDRA_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  fi
  if [[ -z "$deployed_sha" ]]; then
    log "WARN could not resolve deployed SHA; skipping drift check"
    return 0
  fi

  # --- Resolve origin/master SHA (network read-only, no local ref mutation) ---
  local remote_sha
  if [[ -n "${HYDRA_WATCHDOG_DRIFT_REMOTE_SHA:-}" ]]; then
    remote_sha="$HYDRA_WATCHDOG_DRIFT_REMOTE_SHA"
  else
    # ls-remote touches NO local ref and NO working tree (unlike fetch/pull).
    remote_sha=$(git -C "$HYDRA_ROOT" ls-remote origin master 2>/dev/null | awk '{print $1}' | head -n1 || echo "")
  fi
  if [[ -z "$remote_sha" ]]; then
    log "WARN could not resolve origin/master SHA (network/git error); skipping drift check"
    return 0
  fi

  # --- No drift: clear any stale marker and report healthy ---
  if [[ "$deployed_sha" == "$remote_sha" ]]; then
    rm -f "$DRIFT_MARKER" 2>/dev/null || true
    log "in sync (deployed=${deployed_sha:0:8} == origin/master=${remote_sha:0:8})"
    return 0
  fi

  # --- Drift detected (advisory) ---
  local now first_seen drift_age
  now=$(date +%s)
  if [[ -f "$DRIFT_MARKER" ]]; then
    first_seen=$(cat "$DRIFT_MARKER" 2>/dev/null || echo "$now")
    # Guard against a garbage/non-numeric marker.
    [[ "$first_seen" =~ ^[0-9]+$ ]] || first_seen="$now"
  else
    first_seen="$now"
    echo "$now" > "$DRIFT_MARKER" 2>/dev/null || true
  fi
  drift_age=$((now - first_seen))
  (( drift_age < 0 )) && drift_age=0

  log "WARNING DRIFT — deployed=${deployed_sha:0:8} != origin/master=${remote_sha:0:8} (drift first seen ${drift_age}s ago). Production is running stale code; a deploy was likely cancelled by concurrency (see reference_deploy_concurrency_cancels_master)."

  # --- Auto-deploy is OFF by default: advisory only ---
  if [[ "${HYDRA_WATCHDOG_AUTODEPLOY:-0}" != "1" ]]; then
    log "auto-deploy disabled (HYDRA_WATCHDOG_AUTODEPLOY != 1); advisory only — run scripts/deploy.sh to converge"
    return 0
  fi

  # --- Grace window: drift must persist before auto-deploy fires ---
  if (( drift_age < GRACE_SECONDS )); then
    log "auto-deploy armed but within grace window (drift ${drift_age}s < ${GRACE_SECONDS}s); waiting for next tick"
    return 0
  fi

  # --- Respect deliberate operator stops (issue #388) ---
  local sched stop_reason
  sched=$(curl -sS --max-time 5 "http://localhost:4000/api/scheduler/status" 2>/dev/null || echo "")
  if [[ -n "$sched" ]]; then
    stop_reason=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("stopReason","") or "")' 2>/dev/null || echo "")
    if [[ "$stop_reason" == "deliberate" ]]; then
      log "drift sustained but scheduler stopped deliberately (stopReason=deliberate); NOT auto-deploying — operator paused the system on purpose"
      return 0
    fi
  fi

  # --- Auto-deploy (gated + grace-elapsed + not deliberately stopped) ---
  if [[ "${HYDRA_WATCHDOG_AUTODEPLOY_DRY_RUN:-0}" == "1" ]]; then
    log "would-deploy (DRY_RUN=1): drift sustained ${drift_age}s >= ${GRACE_SECONDS}s — would exec scripts/deploy.sh"
    return 0
  fi

  log "AUTO-DEPLOY — drift sustained ${drift_age}s >= grace ${GRACE_SECONDS}s; running scripts/deploy.sh to converge to origin/master"
  # deploy.sh is self-healing (fails loud on dirty tree); run it best-effort.
  # Clear the marker so the next tick re-arms the grace window from scratch.
  rm -f "$DRIFT_MARKER" 2>/dev/null || true
  if bash "$HYDRA_ROOT/scripts/deploy.sh"; then
    log "auto-deploy completed"
  else
    log "WARN auto-deploy (scripts/deploy.sh) returned non-zero; operator intervention may be needed"
  fi
  return 0
}

# =============================================================================
# ## SKILL MIRROR DRIFT
# =============================================================================
#
# Skill-mirror-drift backstop (issue #3828). The default (unoverridden)
# CLAUDE_SKILLS_DIR mirror at $HOME/.claude/skills is the LIVE, host-shared
# surface every subsequent agent dispatch loads its skill prompts from.
# `scripts/sync-skills.sh` now refuses to WRITE that default path when
# `docs/operator-playbooks/` at $HYDRA_ROOT differs from the local
# `origin/master` ref (its own default-mirror content guard) — but that guard
# only protects sync-skills.sh's OWN invocations. It cannot detect a mirror
# that is ALREADY diverged (a hand-edit, a pre-guard write, an operator
# --force, or simple drift between deploys). This block is that read-only
# detector, mirroring the ## DEPLOY DRIFT block's contract above exactly:
#
#   - Regenerates every hydra-* skill into a SCRATCH CLAUDE_SKILLS_DIR/
#     CODEX_SKILLS_DIR (sync-skills.sh's own override mechanism — a pure,
#     side-effect-free read of $HYDRA_ROOT's checked-out docs/operator-
#     playbooks/) and diffs the result against the live default mirror.
#   - Advisory by default: any diverged skill logs a WARNING only.
#   - Auto-fix is an explicit, separately-gated, grace-windowed opt-in
#     (HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX=1) that re-runs sync-skills.sh
#     against the DEFAULT path to reconcile — which itself passes back through
#     sync-skills.sh's own content guard, so an auto-fix attempt against a
#     dirty $HYDRA_ROOT fails loud rather than propagating dirty content.
#   - Respects a deliberate operator scheduler-stop (issue #388), exactly like
#     ## DEPLOY DRIFT.
#   - Fail-safe: any git/scratch-regen error logs a WARN and returns 0.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-skill-mirror-drift.test.mts):
#   HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR         Override the "live" mirror dir
#                                                 checked against (default
#                                                 CLAUDE_SKILLS_DIR or
#                                                 $HOME/.claude/skills).
#   HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_DRY_RUN=1 In the auto-fix branch, log
#                                                 "would-resync" instead of
#                                                 actually running sync-skills.sh.
#   HYDRA_WATCHDOG_DRIFT_STATE_DIR                Shared with ## DEPLOY DRIFT —
#                                                 same per-test marker dir
#                                                 override.

run_skill_mirror_drift() {
  local HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
  local LIVE_DIR="${HYDRA_WATCHDOG_SKILL_MIRROR_LIVE_DIR:-${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}}"
  local STATE_DIR="${HYDRA_WATCHDOG_DRIFT_STATE_DIR:-/tmp}"
  local DRIFT_MARKER="${STATE_DIR}/hydra-watchdog-skill-mirror-drift-since"
  local GRACE_SECONDS="${HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_GRACE_SECONDS:-600}"

  log() {
    echo "hydra-skill-mirror-drift-watchdog: $*"
  }

  if [[ ! -f "$HYDRA_ROOT/scripts/sync-skills.sh" ]]; then
    log "WARN sync-skills.sh not found at $HYDRA_ROOT; skipping skill-mirror drift check"
    return 0
  fi

  local scratch=""
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/hydra-skill-mirror-drift.XXXXXX" 2>/dev/null || echo "")
  if [[ -z "$scratch" ]]; then
    log "WARN could not create a scratch dir; skipping skill-mirror drift check"
    return 0
  fi

  local scratch_claude="$scratch/claude"
  local regen_rc=0
  CLAUDE_SKILLS_DIR="$scratch_claude" CODEX_SKILLS_DIR="$scratch/codex" \
    bash "$HYDRA_ROOT/scripts/sync-skills.sh" >/dev/null 2>"$scratch/stderr" || regen_rc=$?
  if [[ "$regen_rc" -ne 0 ]]; then
    log "WARN scratch regeneration of $HYDRA_ROOT's skills failed (exit $regen_rc): $(tail -n1 "$scratch/stderr" 2>/dev/null); skipping skill-mirror drift check"
    rm -rf "$scratch"
    return 0
  fi

  local diverged=()
  local d name scratch_file live_file
  if [[ -d "$scratch_claude" ]]; then
    for d in "$scratch_claude"/*/; do
      [[ -d "$d" ]] || continue
      name=$(basename "$d")
      scratch_file="$d/SKILL.md"
      live_file="$LIVE_DIR/$name/SKILL.md"
      [[ -f "$scratch_file" ]] || continue
      if [[ ! -f "$live_file" ]]; then
        diverged+=("$name(missing-live)")
      elif ! diff -q "$scratch_file" "$live_file" >/dev/null 2>&1; then
        diverged+=("$name")
      fi
    done
  fi
  rm -rf "$scratch"

  if [[ ${#diverged[@]} -eq 0 ]]; then
    rm -f "$DRIFT_MARKER" 2>/dev/null || true
    log "in sync (live mirror matches $HYDRA_ROOT's checked-out docs/operator-playbooks/)"
    return 0
  fi

  local now first_seen drift_age
  now=$(date +%s)
  if [[ -f "$DRIFT_MARKER" ]]; then
    first_seen=$(cat "$DRIFT_MARKER" 2>/dev/null || echo "$now")
    [[ "$first_seen" =~ ^[0-9]+$ ]] || first_seen="$now"
  else
    first_seen="$now"
    echo "$now" > "$DRIFT_MARKER" 2>/dev/null || true
  fi
  drift_age=$((now - first_seen))
  (( drift_age < 0 )) && drift_age=0

  log "WARNING DRIFT — ${#diverged[@]} skill(s) diverge from $HYDRA_ROOT: ${diverged[*]} (drift first seen ${drift_age}s ago). The live mirror may carry unmerged/uncommitted playbook content — regenerate from a throwaway origin/master worktree to converge."

  if [[ "${HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX:-0}" != "1" ]]; then
    log "auto-fix disabled (HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX != 1); advisory only — run scripts/sync-skills.sh to converge"
    return 0
  fi

  if (( drift_age < GRACE_SECONDS )); then
    log "auto-fix armed but within grace window (drift ${drift_age}s < ${GRACE_SECONDS}s); waiting for next tick"
    return 0
  fi

  local sched stop_reason
  sched=$(curl -sS --max-time 5 "http://localhost:4000/api/scheduler/status" 2>/dev/null || echo "")
  if [[ -n "$sched" ]]; then
    stop_reason=$(echo "$sched" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("stopReason","") or "")' 2>/dev/null || echo "")
    if [[ "$stop_reason" == "deliberate" ]]; then
      log "drift sustained but scheduler stopped deliberately (stopReason=deliberate); NOT auto-fixing — operator paused the system on purpose"
      return 0
    fi
  fi

  if [[ "${HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX_DRY_RUN:-0}" == "1" ]]; then
    log "would-resync (DRY_RUN=1): drift sustained ${drift_age}s >= ${GRACE_SECONDS}s — would run scripts/sync-skills.sh against the default path"
    return 0
  fi

  log "AUTO-FIX — drift sustained ${drift_age}s >= grace ${GRACE_SECONDS}s; running scripts/sync-skills.sh to converge the live mirror to $HYDRA_ROOT"
  rm -f "$DRIFT_MARKER" 2>/dev/null || true
  # Deliberately the DEFAULT path (no CLAUDE_SKILLS_DIR/CODEX_SKILLS_DIR
  # override) — this is the one caller allowed to reconcile the live mirror.
  # sync-skills.sh's own default-mirror content guard still applies: if
  # $HYDRA_ROOT itself carries unmerged/uncommitted playbook content, this
  # fails loud instead of propagating it.
  if (cd "$HYDRA_ROOT" && bash scripts/sync-skills.sh); then
    log "auto-fix completed"
  else
    log "WARN auto-fix (scripts/sync-skills.sh) returned non-zero; operator intervention may be needed"
  fi
  return 0
}

# =============================================================================
# ## NODE MODULES INTEGRITY
# =============================================================================
#
# Detection + delivery for the 2026-08-19 incident (issue #4175): a `/dev/shm`
# hydra-betting worktree's `web/node_modules` symlink reached back through the
# main checkout, and a destructive install step inside the worktree wiped
# `/home/gabe/hydra-betting/web/node_modules` — taking down six money-critical
# Target services for ~70 minutes with NO signal to anything watching the main
# checkout. The structural prevention (eliminating the reach-back symlink) is
# tracked separately in #4177; this block is the detection backstop, valuable
# regardless of which prevention lands because it is the only mitigation that
# covers causes nobody has anticipated.
#
# What it asserts
# ----------------
# Not "the directory shrank" (needs stored history + an uncalibratable
# threshold) but the structural invariant the incident actually violated —
# the binaries the live services execute exist:
#   1. the watched root exists, contains `.bin/`, and holds at least
#      ENTRY_FLOOR top-level entries (observed wiped: 24K / no `.bin/`;
#      observed healthy: ~995M / ~450 entries — the gap needs no tuning).
#   2. the specific `.bin/` entry the live systemd units reference (the five
#      `ExecStart=.../web/node_modules/.bin/tsx …` units that died
#      `203/EXEC`) exists and is executable. Hardcoded to `tsx` — the one the
#      watched services use — rather than derived from the unit files, per
#      the issue's explicit fallback.
# A resolvable-import probe (the checkpoint-refresh `ERR_MODULE_NOT_FOUND`
# symptom) is intentionally NOT implemented — checks 1+2 already cover both
# observed failure symptoms from the incident.
#
# Watched roots (a list, never a literal buried in a condition; override via
# HYDRA_WATCHDOG_NM_ROOTS for tests, colon-separated):
#   /home/gabe/hydra-betting/web/node_modules   (the incident)
#   /home/gabe/hydra/node_modules
#
# Delivery reuses the #3848 taxonomy this file already established for
# run_launch_flow: the SAME uniform streak-rule / dedup design (Redis SET
# NX since + fired, DEL on recovery) and the SAME in-band delivery surface
# (an enveloped XADD onto hydra:notifications — the Orchestrator is
# demonstrably up when this check runs, since it is the thing running the
# check, so out-of-band is not warranted here the way it is for
# fail-safe/meter-dark). It is a SEPARATE block (a filesystem invariant is
# not a pace-gate reason and cannot share run_launch_flow's `now_ms`/`reason`
# derivation) but must never diverge from that design — if you change the
# streak/dedup shape here, check whether run_launch_flow needs the same
# change. Threshold is 0ms: a wiped node_modules under a live service is not
# something to wait out a streak on, so the fired marker sets (and delivery
# fires) on the very first qualifying tick — dedup then suppresses re-alarm
# for the duration of the outage, and recovery (DEL) re-arms a fresh streak.
#
# Surface: IN-BAND, in BOTH ALERT_TYPES (src/notification/alert-grammar.ts)
# and CRITICAL_EVENT_TYPES (src/digest.ts) — six money-critical services down
# warrants both the dashboard alert and the immediate Telegram digest line.
# Event type pinned in test/event-bus-vocabulary.test.mts's EXPECTED_MEMBERS
# (that enum-completeness arm fails by design until a new member is
# deliberately pinned).
#
# Fail-safe (HARD): mirrors run_launch_flow's contract — this block NEVER
# throws and NEVER returns non-zero. All redis-cli / stat calls are
# best-effort (`|| true` / redirected), and a read failure never mutates a
# since/fired marker (never falsely clears an in-progress streak).
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-node-modules-integrity.test.mts):
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT        shared with the other blocks.
#   HYDRA_WATCHDOG_NM_NOW_MS                   inject `now` (epoch-ms).
#   HYDRA_WATCHDOG_NM_ROOTS                    colon-separated root override.
#   HYDRA_WATCHDOG_NM_ENTRY_FLOOR              default 20.
#   HYDRA_WATCHDOG_NM_REQUIRED_BIN             default "tsx".
#   HYDRA_WATCHDOG_NM_NOTIFY_STREAM            in-band delivery stream key
#                                               (default hydra:notifications);
#                                               rebound in tests so a case can
#                                               never write a real event onto
#                                               the PRODUCTION stream.

run_node_modules_integrity() {
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  local NM_KEY_PREFIX="hydra:autopilot:node-modules-integrity"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_NM_NOTIFY_STREAM:-hydra:notifications}"
  local ENTRY_FLOOR="${HYDRA_WATCHDOG_NM_ENTRY_FLOOR:-20}"
  local REQUIRED_BIN="${HYDRA_WATCHDOG_NM_REQUIRED_BIN:-tsx}"
  [[ "$ENTRY_FLOOR" =~ ^[0-9]+$ ]] || ENTRY_FLOOR=20

  local -a WATCHED_ROOTS
  if [[ -n "${HYDRA_WATCHDOG_NM_ROOTS:-}" ]]; then
    IFS=':' read -r -a WATCHED_ROOTS <<< "$HYDRA_WATCHDOG_NM_ROOTS"
  else
    WATCHED_ROOTS=(
      "/home/gabe/hydra-betting/web/node_modules"
      "/home/gabe/hydra/node_modules"
    )
  fi

  log() {
    echo "hydra-node-modules-integrity-watchdog: $*"
  }

  # rc_write/rc_read — same best-effort contract as run_launch_flow's helpers
  # (fire-and-forget mutation; "" on any read failure). Deliberately a second
  # copy rather than a shared top-level helper: hoisting would change
  # run_launch_flow's tested extraction boundary (test/watchdog-launch-flow
  # .test.mts and test/launch-flow-delivery.test.mts both extract that
  # function verbatim by name).
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      docker exec hydra-redis-1 redis-cli --raw "$@" >/dev/null 2>&1 || true
    else
      redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" "$@" >/dev/null 2>&1 || true
    fi
  }
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      docker exec hydra-redis-1 redis-cli --raw "$@" 2>/dev/null || true
    else
      redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" "$@" 2>/dev/null || true
    fi
  }

  nm_since_key() { printf '%s:since:%s\n' "$NM_KEY_PREFIX" "$1"; }
  nm_fired_key() { printf '%s:fired:%s\n' "$NM_KEY_PREFIX" "$1"; }

  # sig_for_root ROOT — a stable, Redis-key-safe signal name derived from the
  # watched path (non-alnum runs collapsed to single underscores).
  sig_for_root() {
    printf '%s' "$1" | tr -c 'a-zA-Z0-9' '_' | tr -s '_'
  }

  # deliver_signal SIG ROOT REASON DUR_MS THR_MS — enveloped XADD onto the
  # notifications stream, the exact on-wire shape src/event-bus.ts's publish()
  # constructs (ADR-0017 Category A), mirroring run_launch_flow's
  # deliver_in_band. Always returns 0 (best-effort).
  deliver_signal() {
    local sig="$1" root="$2" reason="$3" dur_ms="$4" thr_ms="$5"
    local reason_clean
    reason_clean="$(printf '%s' "$reason" | tr -dc 'a-zA-Z0-9_.:-')"
    local root_clean
    root_clean="$(printf '%s' "$root" | tr -dc 'a-zA-Z0-9_./-')"
    local iso payload
    iso="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    payload="$(printf '{"signal":"%s","reason":"%s","durationMs":%s,"thresholdMs":%s}' \
      "$root_clean" "$reason_clean" "$dur_ms" "$thr_ms")"
    rc_write XADD "$NOTIFY_STREAM" '*' \
      id "node-modules-integrity-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "infra:node_modules_wiped" \
      source "watchdog-node-modules-integrity" \
      timestamp "$iso" \
      correlationId "node-modules-integrity-${sig}" \
      payload "$payload"
    log "in-band delivery published (best-effort) for '$root' (type=infra:node_modules_wiped -> ${NOTIFY_STREAM})"
    return 0
  }

  # track_signal SIG ROOT REASON THR_MS IS_MEMBER — the SAME uniform streak
  # rule as run_launch_flow's track_signal (SET NX since / fire once at
  # now-since >= threshold / DEL both on recovery), scoped to this block's own
  # key prefix. Always returns 0.
  track_signal() {
    local sig="$1" root="$2" reason="$3" thr_ms="$4" is_member="$5"
    local since_key fired_key
    since_key="$(nm_since_key "$sig")"
    fired_key="$(nm_fired_key "$sig")"
    if [[ "$is_member" == "1" ]]; then
      rc_write SET "$since_key" "$now_ms" NX
      local since dur
      since="$(rc_read GET "$since_key" | tr -dc '0-9')"
      [[ "$since" =~ ^[0-9]+$ ]] || since="$now_ms"
      dur=$((now_ms - since))
      if (( dur < 0 )); then dur=0; fi
      if (( dur >= thr_ms )); then
        if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
          log "WARNING NODE_MODULES INTEGRITY — '$root' ${reason} (sustained ${dur}ms >= ${thr_ms}ms threshold); see issue #4175"
          rc_write SET "$fired_key" 1
          deliver_signal "$sig" "$root" "$reason" "$dur" "$thr_ms"
        fi
      fi
    else
      rc_write DEL "$since_key" "$fired_key"
    fi
    return 0
  }

  local now_ms
  if [[ -n "${HYDRA_WATCHDOG_NM_NOW_MS+x}" ]]; then
    now_ms="$HYDRA_WATCHDOG_NM_NOW_MS"
  else
    now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  fi
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0

  local root sig broken reason count
  for root in "${WATCHED_ROOTS[@]}"; do
    sig="$(sig_for_root "$root")"
    broken=0
    reason=""
    if [[ ! -d "$root" ]]; then
      broken=1
      reason="root-absent"
    elif [[ ! -d "$root/.bin" ]]; then
      broken=1
      reason="no-bin-dir"
    else
      count="$(find "$root" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -dc '0-9')"
      [[ "$count" =~ ^[0-9]+$ ]] || count=0
      if (( count < ENTRY_FLOOR )); then
        broken=1
        reason="below-entry-floor:${count}<${ENTRY_FLOOR}"
      elif [[ ! -x "$root/.bin/$REQUIRED_BIN" ]]; then
        broken=1
        reason="missing-binary:${REQUIRED_BIN}"
      fi
    fi
    # Threshold is always 0 — see header: no streak to wait out on a wiped
    # tree under a live service.
    track_signal "$sig" "$root" "$reason" 0 "$broken"
  done

  log "node-modules-integrity tick processed (${#WATCHED_ROOTS[@]} root(s) watched, now_ms=$now_ms)"
  return 0
}

# =============================================================================
# ## LAUNCH FLOW
# =============================================================================
#
# Launch-flow DETECTION block (issue #3847, epic #3844; decided on maps
# #3807/#3809/#3812/#3813/#3814). The watchdog owns this — NOT an in-
# orchestrator chore — for two reasons established on map #3807: a chore
# structurally CANNOT observe "the launcher is unreachable or hanging"
# (housekeeping.sh exits 0 by design with no OnFailure=, so a 30s curl
# timeout produced a green systemd unit and a skipped pass), and the hourly
# chore reads once per four 15-minute launcher ticks so it cannot implement
# the reset semantics at all. The watchdog's 2-minute tick reads ~7x per
# pace-gate write.
#
# What it watches
# ---------------
# scripts/autopilot/pace-gate.sh writes ONE Redis hash per ~15-min tick —
# hydra:autopilot:pace-gate:last-tick (owned in TypeScript by src/redis/
# launch-flow.ts's PACE_GATE_LAST_TICK_KEY, written by pace-gate.sh's
# record_tick(), landed in #3845) — carrying the tick's reason, coarse class,
# at (epoch-ms), and latency_ms. This block reads EXACTLY that one hash per
# tick (no new HTTP probe, no second /api/usage/eligibility consumer — #3813
# Decision 3) and asks: has a defective / quota / pause signal, or a slow
# probe, been SUSTAINED past its threshold?
#
# Signals (reason → signal membership; canonical taxonomy owned in TS by
# classifyLaunchSignal / LAUNCH_FLOW_REASON_SIGNAL, drift-guarded by
# test/watchdog-launch-flow.test.mts):
#   fail-safe   — curl-missing, jq-missing, eligibility-unreachable,
#                 eligibility-unparseable, allow-invalid (5 exits). 2h.
#   meter-dark  — meter-unavailable. 2h (defective character like fail-safe,
#                 but a DISTINCT signal — #3814 split it out of generic
#                 fail-safe — so a flip between meter-dark and a fail-safe
#                 exit resets, different root cause).
#   quota       — session-blocked, emergency-stop, weekly-emergency-stop
#                 (unified into ONE class so a stretch flipping between them
#                 does not spuriously reset). 4h.
#   pause       — paused (forgotten operator pause). 24h.
#   latency     — the eligibility probe's latency_ms > 1s budget, INDEPENDENT
#                 of reason (a slow-but-successful eligible-launch tick still
#                 has a latency worth checking). Breach 1h, STRICTLY before
#                 the 2h fail-safe streak so it stays the LEADING indicator
#                 (#3813: if either number ever changes, re-check this
#                 ordering — latency leads, fail-safe lags).
#   (healthy)   — every other reason (launch, already-running, deliberate
#                 skips other than quota/pause) = endpoint readable, not
#                 defective. Clears every reason-keyed streak (recovery).
#
# Thresholds are fitted to a measured bimodal gap over 764 ticks (fail-safe
# noise tops out at 1.5h, real outage 6.5–9.75h; routine quota cycling tops
# out at 3.5h, real blocks start at 8.25h) and are DURATION-based (epoch-ms
# delta, NOT tick-count) so a timer-cadence change cannot silently re-time
# them (#3809 Decision 4).
#
# State — ten Redis keys (5 signals × {since, fired}; key templates owned in
# TS by launchFlowSinceKey / launchFlowFiredKey, drift-guarded by the test):
#   hydra:autopilot:launch-flow:since:<signal>  epoch-ms the streak began
#       (SET NX: locked on the first qualifying tick, a no-op after).
#   hydra:autopilot:launch-flow:fired:<signal>  set ONCE per streak, the
#       instant now-since >= threshold; cleared on recovery so a later streak
#       fires fresh. Idempotent (mirrors wiring-liveness-dark-outcomes.ts).
#
# Reset rule is UNIFORM across all five signals: for signal S, membership true
# → extend (SET NX since; fire the WARNING exactly once when now-since >=
# threshold AND no fired marker yet); membership false → DEL both since+fired
# (stateless recovery). This block is the SOLE writer (SET NX / DEL via
# redis-cli); TypeScript owns only the key NAMES.
#
# DELIVERY (issue #3848, gamma — the half every previous attempt missed).
# Detection without a delivery surface is indistinguishable from no detection.
# At the EXACT tick a fired marker transitions absent→present (the same
# instant the WARNING log fires, inside track_signal), the block delivers on a
# surface derived per signal from whether the Orchestrator is provably up in
# that signal's failure mode:
#
#   fail-safe, meter-dark → OUT-OF-BAND: a direct bash curl POST to the
#       Telegram Bot API. Both mean "DEFECTIVE AND FULLY BLOCKING" — the
#       Orchestrator process that would consume an in-band event may itself be
#       unreachable, and a bash LPUSH an operator can only read through
#       GET /api/alerts on port 4000 is the "written and unreadable" trap.
#       This makes the watchdog the third Telegram consumer alongside
#       DLQ_ALERT and CONSUMER_DEAD (same infrastructure-is-broken character).
#
#   quota, latency → IN-BAND: an enveloped event XADD'd directly onto the
#       hydra:notifications stream (id/type/source/timestamp/correlationId/
#       payload — the on-wire shape src/event-bus.ts's publish() constructs,
#       ADR-0017 Category A). Both fire only when pace-gate's last-tick hash
#       was successfully READ, which proves the Orchestrator was up at
#       detection time. The in-process notification-consumer (unmodified)
#       picks the event up: it lands in ALERT_TYPES (dashboard alert via the
#       compile-checked formatAlertMessage grammar) AND in CRITICAL_EVENT_TYPES
#       (immediate digest-surfaced Telegram line via formatCriticalAlert's
#       generic default arm) — no new digest-format.ts batched section.
#
#   pause → IN-BAND, DIGEST LINE ONLY: the same enveloped XADD, but
#       launch:pause_forgotten is deliberately NOT in ALERT_TYPES — a
#       deliberate overnight operator pause must never leave a lingering
#       unread dashboard alert (the alarm-fatigue failure the taxonomy exists
#       to prevent). It reaches the operator via CRITICAL_EVENT_TYPES' immediate
#       digest bypass only.
#
# Credential placement: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are read from
# the watchdog's process env (the same vars src/notify.ts reads). Wiring them
# into hydra-watchdog.service is an explicit OPERATOR action out of scope here
# (issue #3848) — so when either is absent the out-of-band block logs a
# distinguishable WARN naming the missing var and continues: an unconfigured
# signal must be visible as unconfigured, never silent and never fatal.
#
# Dedup/un-suppression need NO new machinery: delivery fires at the same
# absent→present fired-marker transition the WARNING already detects (the
# #3847 fired/since keys are the sole dedup state, zero new Redis keys), the
# fired marker suppresses re-alarm for a streak's duration, and recovery DELs
# it — so a fresh streak re-crossing the threshold delivers again (recurrence,
# never acknowledgement).
#
# Fail-safe (HARD): this block NEVER throws and NEVER returns non-zero (matches
# the watchdog's per-block contract, set -euo pipefail notwithstanding). The
# delivery calls follow the same best-effort discipline as rc_write/rc_read
# (redirected output, || true, bounded --max-time) — a curl or XADD failure
# degrades to a logged WARN and never propagates out of run_launch_flow. Any
# redis-cli/docker failure or an empty/absent last-tick hash logs a
# distinguishable WARN and returns WITHOUT mutating any anchor or fired marker
# — it must NEVER clear on a read failure (clearing on failure would falsely
# erase an in-progress streak, a worse outcome than leaving stale state one
# extra tick).
#
# Testability hooks (off-by-default; pinned by test/watchdog-launch-flow.test.mts
# and test/launch-flow-delivery.test.mts):
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT  redis-cli target (default: docker exec
#                                        hydra-redis-1). Any non-"docker" host
#                                        calls redis-cli -h/-p directly, so the
#                                        test points at a known-clean DB.
#   HYDRA_REDIS_DB                       redis-cli `-n <db>` selector on BOTH
#                                        the docker-exec and host rc_write/
#                                        rc_read branches (issue #4183).
#                                        Absent or non-numeric falls back to db
#                                        0 so production behaviour is
#                                        byte-identical. scripts/test/
#                                        redis-db-launch.mjs exports this into
#                                        every test run's child env, so a bash
#                                        block a test shells into inherits the
#                                        run's Redis DB isolation automatically
#                                        instead of writing straight past it to
#                                        production db 0.
#   HYDRA_WATCHDOG_LAUNCH_NOW_MS         Inject `now` (epoch-ms) so threshold
#                                        crossings are deterministic with zero
#                                        real-time waits.
#   HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS       (default 7200  = 2h)
#   HYDRA_WATCHDOG_LAUNCH_METER_DARK_SECONDS     (default 7200  = 2h)
#   HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS          (default 14400 = 4h)
#   HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS          (default 86400 = 24h)
#   HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS      (default 1000  = 1s)
#   HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS (default 3600  = 1h)
#   HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_SECONDS    (default 3600  = 1h sustain
#                                        before the glm-sterile streak fires —
#                                        absorbs a just-restarted drainer that
#                                        inherits an empty PR window, issue #3868)
#   HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS (default 6 — the zero-drainer-PR
#                                        lookback window; far above the observed
#                                        ~40-min per-issue author time so a single
#                                        slow issue never trips it)
#   HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM  In-band delivery stream key (default
#                                        hydra:notifications — the literal owned
#                                        by src/event-bus-stream-keys.ts's
#                                        STREAMS.NOTIFICATIONS, drift-guarded by
#                                        the test). The delivery test rebinds it
#                                        to a private namespace so behavioural
#                                        cases never write a real event onto the
#                                        PRODUCTION notifications stream (the
#                                        live consumer would push a real
#                                        dashboard alert + Telegram line).

run_launch_flow() {
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  # DB index for both rc_write/rc_read branches (issue #4183). Absent or
  # non-numeric falls back to db 0 so production behaviour (no env override)
  # is byte-identical to before this variable existed.
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  # Single source of truth for this literal is src/redis/launch-flow.ts's
  # PACE_GATE_LAST_TICK_KEY, cross-checked by test/watchdog-launch-flow.test.mts
  # (the watchdog is the SECOND bash reader of this key after pace-gate.sh).
  local LAST_TICK_KEY="hydra:autopilot:pace-gate:last-tick"
  # Key-template prefix — owned by src/redis/launch-flow.ts's
  # LAUNCH_FLOW_KEY_PREFIX / launchFlowSinceKey / launchFlowFiredKey; the test
  # asserts the bash template and the TS builder emit identical strings.
  local LF_KEY_PREFIX="hydra:autopilot:launch-flow"
  # In-band delivery stream — the literal owned by src/event-bus-stream-keys.ts's
  # STREAMS.NOTIFICATIONS, drift-guarded by test/launch-flow-delivery.test.mts.
  # HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM is a test-only override (see header).
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM:-hydra:notifications}"

  # Thresholds (env in SECONDS, the AUTODEPLOY_GRACE_SECONDS precedent; the
  # delta math is epoch-MS, so multiply by 1000). Sanitize each to its
  # documented default on a non-numeric injection.
  local FAILSAFE_S="${HYDRA_WATCHDOG_LAUNCH_FAILSAFE_SECONDS:-7200}"
  local METER_DARK_S="${HYDRA_WATCHDOG_LAUNCH_METER_DARK_SECONDS:-7200}"
  local QUOTA_S="${HYDRA_WATCHDOG_LAUNCH_QUOTA_SECONDS:-14400}"
  local PAUSE_S="${HYDRA_WATCHDOG_LAUNCH_PAUSE_SECONDS:-86400}"
  local LATENCY_BUDGET_MS="${HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS:-1000}"
  local LATENCY_BREACH_S="${HYDRA_WATCHDOG_LAUNCH_LATENCY_BREACH_SECONDS:-3600}"
  local GLM_STERILE_S="${HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_SECONDS:-3600}"
  local GLM_STERILE_WINDOW_H="${HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS:-6}"
  [[ "$FAILSAFE_S" =~ ^[0-9]+$ ]] || FAILSAFE_S=7200
  [[ "$METER_DARK_S" =~ ^[0-9]+$ ]] || METER_DARK_S=7200
  [[ "$QUOTA_S" =~ ^[0-9]+$ ]] || QUOTA_S=14400
  [[ "$PAUSE_S" =~ ^[0-9]+$ ]] || PAUSE_S=86400
  [[ "$LATENCY_BUDGET_MS" =~ ^[0-9]+$ ]] || LATENCY_BUDGET_MS=1000
  [[ "$LATENCY_BREACH_S" =~ ^[0-9]+$ ]] || LATENCY_BREACH_S=3600
  [[ "$GLM_STERILE_S" =~ ^[0-9]+$ ]] || GLM_STERILE_S=3600
  [[ "$GLM_STERILE_WINDOW_H" =~ ^[0-9]+$ ]] || GLM_STERILE_WINDOW_H=6
  local FAILSAFE_MS=$((FAILSAFE_S * 1000))
  local METER_DARK_MS=$((METER_DARK_S * 1000))
  local QUOTA_MS=$((QUOTA_S * 1000))
  local PAUSE_MS=$((PAUSE_S * 1000))
  local LATENCY_BREACH_MS=$((LATENCY_BREACH_S * 1000))
  local GLM_STERILE_MS=$((GLM_STERILE_S * 1000))

  log() {
    echo "hydra-launch-flow-watchdog: $*"
  }

  # rc_write — fire-and-forget redis mutation; never fails the block.
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  # rc_read — capture redis output ("" on any failure).
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  lf_since_key() { printf '%s:since:%s\n' "$LF_KEY_PREFIX" "$1"; }
  lf_fired_key() { printf '%s:fired:%s\n' "$LF_KEY_PREFIX" "$1"; }

  # --- Delivery helpers (issue #3848, gamma) — every one best-effort ---
  #
  # Both helpers are called ONLY from track_signal's fired absent→present
  # transition (the same instant the WARNING fires) and MUST return 0 on every
  # path — a delivery failure degrades to a logged WARN, never a non-zero out
  # of run_launch_flow. The caller's locals `reason` and `REDIS_*` are visible
  # via bash dynamic scoping.

  # deliver_out_of_band SIGNAL DUR_MS THR_MS — direct bash curl to the Telegram
  # Bot API (fail-safe / meter-dark; mirrors src/notify.ts's endpoint shape).
  # Zero dependency on any Orchestrator HTTP endpoint or in-process module:
  # both signals mean the Orchestrator may itself be unreachable, so an
  # in-band event would be written and unreadable.
  deliver_out_of_band() {
    local sig="$1" dur_ms="$2" thr_ms="$3"
    if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
      local missing=""
      [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] && missing="TELEGRAM_BOT_TOKEN"
      [[ -z "${TELEGRAM_CHAT_ID:-}" ]] && missing="${missing:+$missing }TELEGRAM_CHAT_ID"
      log "WARN launch-flow out-of-band delivery for '$sig' SKIPPED — missing Telegram config: ${missing} (credential placement into the watchdog service env is an operator action, see #3848); the streak is still detected and logged"
      return 0
    fi
    local text
    text="$(printf 'HYDRA LAUNCH FLOW ALERT (out-of-band — Orchestrator may be down)\nsignal: %s\nsustained: %sms >= %sms threshold\nreason: %s\nhost: %s' \
      "$sig" "$dur_ms" "$thr_ms" "${reason:-n/a}" "$(hostname 2>/dev/null || echo unknown)")"
    # Best-effort by contract: bounded --max-time, output redirected, `|| log`
    # (not `|| true`) so a failed Telegram send is distinguishable in the
    # journal from a skipped one — but still never fails the block.
    if curl -sS --max-time 10 -X POST \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${text}" >/dev/null 2>&1; then
      log "out-of-band Telegram delivery sent for '$sig'"
    else
      log "WARN launch-flow out-of-band Telegram send FAILED for '$sig' (curl non-zero, best-effort — will not retry this streak; recovery + a fresh streak re-alarm)"
    fi
    return 0
  }

  # deliver_in_band SIGNAL DUR_MS THR_MS — enveloped XADD directly onto the
  # notifications stream (quota / latency / pause). The on-wire field set is
  # exactly what src/event-bus.ts's publish() constructs (ADR-0017 Category
  # A), so the unmodified in-process notification-consumer folds it through
  # the compile-checked grammar: ALERT_TYPES members become dashboard alerts;
  # CRITICAL_EVENT_TYPES members bypass the digest and send immediately.
  # pause's type is deliberately absent from ALERT_TYPES (digest line only).
  deliver_in_band() {
    local sig="$1" dur_ms="$2" thr_ms="$3" etype
    case "$sig" in
      quota)   etype="launch:quota_stretch" ;;
      latency) etype="launch:latency_breach" ;;
      pause)   etype="launch:pause_forgotten" ;;
      # Issue #3868: live-but-sterile GLM drainer — the literal is owned by
      # src/event-bus-vocabulary.ts's GLM_DRAINER_STERILE (in ALERT_TYPES and
      # CRITICAL_EVENT_TYPES: dashboard alert + immediate digest line), drift-
      # guarded by test/launch-flow-delivery.test.mts.
      glm-sterile) etype="glm:drainer_sterile" ;;
      *) return 0 ;;
    esac
    # reason is a fixed pace-gate exit literal, but sanitize anyway so a future
    # reason containing a quote/backslash can never break the payload JSON.
    local reason_clean
    reason_clean="$(printf '%s' "${reason:-}" | tr -dc 'a-zA-Z0-9_.:-')"
    local iso payload
    iso="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    payload="$(printf '{"signal":"%s","reason":"%s","durationMs":%s,"thresholdMs":%s}' \
      "$sig" "$reason_clean" "$dur_ms" "$thr_ms")"
    # rc_write is fire-and-forget by contract (|| true): a redis failure costs
    # this one delivery, never the block's exit code — matching the read-path
    # discipline the rest of the block already relies on.
    rc_write XADD "$NOTIFY_STREAM" '*' \
      id "launch-flow-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "$etype" \
      source "watchdog-launch-flow" \
      timestamp "$iso" \
      correlationId "launch-flow-${sig}" \
      payload "$payload"
    log "in-band delivery published (best-effort) for '$sig' (type=${etype} -> ${NOTIFY_STREAM})"
    return 0
  }

  # deliver_signal SIGNAL DUR_MS THR_MS — surface routing per the #3848
  # taxonomy: fail-safe/meter-dark go OUT-OF-BAND (Orchestrator unproven);
  # everything else goes IN-BAND (a successfully-read verdict proves the
  # Orchestrator was up at detection time). Always returns 0.
  deliver_signal() {
    local sig="$1" dur_ms="$2" thr_ms="$3"
    case "$sig" in
      fail-safe|meter-dark)
        deliver_out_of_band "$sig" "$dur_ms" "$thr_ms" ;;
      *)
        deliver_in_band "$sig" "$dur_ms" "$thr_ms" ;;
    esac
    return 0
  }

  # track_signal SIGNAL THRESHOLD_MS IS_MEMBER — the UNIFORM streak rule. The
  # caller's locals `now_ms` and `reason` are visible via bash dynamic scoping.
  # IS_MEMBER=1 extends: SET NX since (locked on the first qualifying tick,
  # no-op after), then fire the WARNING exactly once when now-since >=
  # threshold AND no fired marker yet. IS_MEMBER=0 clears: DEL both since+fired
  # (stateless recovery, idempotent). Always returns 0.
  track_signal() {
    local sig="$1" thr_ms="$2" is_member="$3"
    local since_key fired_key
    since_key="$(lf_since_key "$sig")"
    fired_key="$(lf_fired_key "$sig")"
    if [[ "$is_member" == "1" ]]; then
      rc_write SET "$since_key" "$now_ms" NX
      local since dur
      since="$(rc_read GET "$since_key" | tr -dc '0-9')"
      [[ "$since" =~ ^[0-9]+$ ]] || since="$now_ms"
      dur=$((now_ms - since))
      if (( dur < 0 )); then dur=0; fi
      if (( dur >= thr_ms )); then
        if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
          log "WARNING LAUNCH FLOW — signal '$sig' sustained ${dur}ms >= ${thr_ms}ms threshold (reason=${reason:-n/a}); see epic #3844"
          # The fired marker is set BEFORE delivering: dedup holds even if the
          # delivery call itself fails (delivery is best-effort per streak).
          rc_write SET "$fired_key" 1
          # #3848 delivery — at the exact absent→present transition, the same
          # instant as the WARNING. The fired/since keys remain the ONLY dedup
          # state; un-suppression is recurrence after recovery (DEL on
          # membership flip), never acknowledgement.
          deliver_signal "$sig" "$dur" "$thr_ms"
        fi
      else
        log "launch-flow signal '$sig' streak ${dur}ms (< ${thr_ms}ms threshold); not firing"
      fi
    else
      # Membership false — stateless recovery: DEL both (idempotent).
      rc_write DEL "$since_key" "$fired_key"
    fi
    return 0
  }

  # --- Read the ONE upstream fact: the last-tick hash (INV-1) ---
  local tick_raw reason latency_ms
  tick_raw="$(rc_read HGETALL "$LAST_TICK_KEY")"
  reason="$(printf '%s\n' "$tick_raw" | awk 'prev=="reason"{print; exit} {prev=$0}')"
  latency_ms="$(printf '%s\n' "$tick_raw" | awk 'prev=="latency_ms"{print; exit} {prev=$0}')"

  if [[ -z "$reason" ]]; then
    # Empty/absent last-tick OR redis unreadable. Distinguishable WARN, and
    # MUST NOT mutate any anchor/fired — clearing on a read failure would
    # falsely erase an in-progress streak.
    log "WARN no pace-gate last-tick record (redis unreadable or key absent) — leaving all launch-flow anchors untouched, no alarm"
    return 0
  fi

  # --- Resolve `now` (epoch-ms; injectable for deterministic tests) ---
  local now_ms
  if [[ -n "${HYDRA_WATCHDOG_LAUNCH_NOW_MS+x}" ]]; then
    now_ms="$HYDRA_WATCHDOG_LAUNCH_NOW_MS"
  else
    now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  fi
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0

  # --- Reason → signal membership (INV-3; mirrors TS classifyLaunchSignal) ---
  local is_failsafe=0 is_meterdark=0 is_quota=0 is_pause=0
  case "$reason" in
    curl-missing|jq-missing|eligibility-unreachable|eligibility-unparseable|allow-invalid)
      is_failsafe=1 ;;
    meter-unavailable)
      is_meterdark=1 ;;
    session-blocked|emergency-stop|weekly-emergency-stop)
      is_quota=1 ;;
    paused)
      is_pause=1 ;;
  esac

  # --- Latency membership (INDEPENDENT of reason; INV-5) ---
  # Over-budget (present AND > budget) extends; absent OR <= budget clears.
  local is_lat_over=0
  if [[ "$latency_ms" =~ ^[0-9]+$ ]] && (( latency_ms > LATENCY_BUDGET_MS )); then
    is_lat_over=1
  fi

  # --- GLM drainer zero-throughput membership (issue #3868) ---
  #
  # "Live but sterile": while the drainer heartbeat is FRESH, the #3754
  # partition hides every glm-eligible ready-for-agent issue from the Opus
  # dev lane — so a drainer that is alive but shipping nothing starves the
  # whole board invisibly. Observed 2026-08-05 (#3863): fresh heartbeat,
  # claims proceeding, `gh pr create` failing on every attempt, ~40 min of
  # z.ai authoring per issue, zero PRs, no alarm — liveness checks cannot see
  # throughput. Membership here is the AND of three facts, evaluated cheap →
  # expensive, and every upstream read failure fails QUIET in the no-alarm
  # direction:
  #
  #   1. heartbeat fresh (one Redis GET) — stale/absent is the already-handled
  #      "down" case (board-state.ts un-gates the Opus lane after 45 min,
  #      ADR-0032 #3753 delta 2); alarming on it here would double-alarm, so
  #      a non-fresh heartbeat clears membership and NO gh call is made.
  #   2. work queued (one gh REST call) — at least one open glm-eligible +
  #      ready-for-agent issue, excluding glm-withhold client-side exactly as
  #      drainer-loop.sh's own defense-in-depth does: a withheld issue is
  #      definitionally not work the drainer will touch. This clause is what
  #      distinguishes STERILE (work waiting, nothing shipped) from IDLE
  #      (nothing to do — never an alarm).
  #   3. zero drainer PRs created in the trailing window (one gh REST call) —
  #      "a drainer PR" is the SHARED issue-#4048 OR-predicate (glm-authored
  #      label OR worktree-agent-glm-* head branch), reused LITERALLY below:
  #      GLM_PR_MATCH_JQ is byte-identical to scripts/glm-beachhead-report.sh's
  #      and MUST stay so (drift-guarded by test/launch-flow-delivery.test.mts,
  #      mirroring the existing collect-state ↔ beachhead pairing). REST rows
  #      are normalized to the {labels, headRefName} field names the shared
  #      predicate reads, so the predicate text itself never forks.
  #
  # A FAILED gh query (non-zero exit, empty stdout, unparseable output) is not
  # evidence of anything: it leaves the glm-sterile streak state UNTOUCHED this
  # tick (glm_sterile_known=0 skips the track_signal call entirely — the same
  # never-extend-AND-never-clear-on-a-read-failure discipline as the last-tick
  # read above).
  #
  # The sustain threshold (default 1h) exists because the three-way AND can be
  # INSTANTLY true the moment a drainer restarts in front of a queued board
  # (fresh heartbeat + eligible work + an inherited empty PR window): a healthy
  # drainer authors its first PR in ~40 min, flipping membership off well
  # before the streak fires; a sterile one sustains it. gh api (REST) rather
  # than gh's --json (GraphQL) because a live autopilot can exhaust the GraphQL
  # budget and this runs on every 2-min watchdog tick.
  local GLM_HEARTBEAT_KEY="hydra:glm:drainer:active"
  # 45 min in ms — MUST mirror src/redis/autopilot.ts's
  # GLM_DRAINER_HEARTBEAT_STALE_MS (drift-guarded by the delivery test).
  local GLM_HEARTBEAT_STALE_MS=2700000
  local GLM_REPO="gaberoo322/hydra"
  # BYTE-IDENTICAL to scripts/glm-beachhead-report.sh's GLM_PR_MATCH_JQ — the
  # shared "is this PR drainer output?" predicate (issue #4048). Never edit one
  # without the other; the drift-guard test compares the two literals.
  local GLM_PR_MATCH_JQ='((.labels // []) | map(.name) | index($label)) or ((.headRefName // "") | startswith($prefix))'
  local is_glm_sterile=0 glm_sterile_known=1
  local glm_hb_raw glm_hb_age=-1
  glm_hb_raw="$(rc_read GET "$GLM_HEARTBEAT_KEY" | tr -dc '0-9')"
  if [[ "$glm_hb_raw" =~ ^[0-9]+$ ]]; then
    glm_hb_age=$((now_ms - glm_hb_raw))
  fi
  if (( glm_hb_age >= 0 && glm_hb_age <= GLM_HEARTBEAT_STALE_MS )); then
    if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
      glm_sterile_known=0
      log "WARN glm-sterile check needs gh+jq and one is missing — leaving the glm-sterile streak untouched this tick (#3868)"
    else
      local glm_queue_len
      glm_queue_len="$(gh api "repos/${GLM_REPO}/issues?labels=glm-eligible,ready-for-agent&state=open&per_page=100" \
        --jq '[.[] | select(has("pull_request") | not) | select(((.labels // []) | map(.name) | index("glm-withhold")) | not)] | length' 2>/dev/null)" || glm_queue_len=""
      if ! [[ "$glm_queue_len" =~ ^[0-9]+$ ]]; then
        glm_sterile_known=0
        log "WARN glm-sterile queue query failed/unparseable — a failed query is not an empty queue; leaving the glm-sterile streak untouched this tick (#3868)"
      elif (( glm_queue_len > 0 )); then
        local glm_window_start_ms glm_recent_prs glm_jq_prog
        glm_window_start_ms=$((now_ms - GLM_STERILE_WINDOW_H * 3600000))
        # Normalize REST rows to the shared predicate's field names, then apply
        # the predicate + the created-in-window filter. 100 newest-first rows
        # comfortably cover any 6h window at this repo's PR rate.
        glm_jq_prog='[.[] | {labels, headRefName: (.head.ref // ""), createdAt: (.created_at // "")} | select('"${GLM_PR_MATCH_JQ}"') | select((.createdAt != "") and ((.createdAt | fromdateiso8601) * 1000 >= $since_ms))] | length'
        glm_recent_prs="$(gh api "repos/${GLM_REPO}/pulls?state=all&sort=created&direction=desc&per_page=100" 2>/dev/null \
          | jq --arg label "glm-authored" --arg prefix "worktree-agent-glm-" \
               --argjson since_ms "$glm_window_start_ms" "$glm_jq_prog" 2>/dev/null)" || glm_recent_prs=""
        if ! [[ "$glm_recent_prs" =~ ^[0-9]+$ ]]; then
          glm_sterile_known=0
          log "WARN glm-sterile PR-window query failed/unparseable — a failed query is not zero throughput; leaving the glm-sterile streak untouched this tick (#3868)"
        elif (( glm_recent_prs == 0 )); then
          is_glm_sterile=1
        fi
      fi
      # glm_queue_len == 0 → idle, not sterile: membership stays 0 (clears).
    fi
  fi
  # Non-fresh heartbeat → membership stays 0 (the "down" case; no double alarm).

  # --- Apply the uniform streak rule to all signals ---
  track_signal fail-safe  "$FAILSAFE_MS"       "$is_failsafe"
  track_signal meter-dark "$METER_DARK_MS"     "$is_meterdark"
  track_signal quota      "$QUOTA_MS"          "$is_quota"
  track_signal pause      "$PAUSE_MS"          "$is_pause"
  track_signal latency    "$LATENCY_BREACH_MS" "$is_lat_over"
  if [[ "$glm_sterile_known" == "1" ]]; then
    # Sixth signal, same uniform rule + fired/since dedup keys (issue #3868).
    # Skipped ENTIRELY (state untouched) when an upstream gh query failed —
    # never extend and never clear a streak on unknown inputs. Deliberately
    # NOT a member of src/redis/launch-flow.ts's WATCHDOG_LAUNCH_SIGNALS:
    # that constant enumerates the pace-gate REASON-derived signals; this one
    # is derived from the drainer heartbeat + the GitHub board instead.
    track_signal glm-sterile "$GLM_STERILE_MS" "$is_glm_sterile"
  fi

  log "launch-flow tick processed (reason=$reason, latency_ms=${latency_ms:-none}, now_ms=$now_ms)"
  return 0
}


# =============================================================================
# Entry point — run all blocks on every tick ONLY when the script is executed
# directly, not when it is sourced. test/watchdog-pending-work.test.mts sources
# this file to exercise read_pending_work in isolation (without faking the
# service-liveness block's docker/HTTP/systemd upstream checks); the guard keeps
# that sourcing side-effect-free. Each block is independent and self-contained;
# a short-circuit in one MUST NOT skip the others.
# =============================================================================
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_service_liveness
  run_autopilot_wedge
  run_deploy_drift
  run_skill_mirror_drift
  run_launch_flow
  run_node_modules_integrity
  exit 0
fi
