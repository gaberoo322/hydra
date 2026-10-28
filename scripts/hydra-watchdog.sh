#!/usr/bin/env bash
#
# hydra-watchdog.sh — consolidated Hydra watchdog (issue #705)
#
# This script merges the two previously-separate watchdog scripts into one
# unit that runs at the finer (2-minute) cadence. It is split into two
# clearly-labelled blocks, each with its OWN stale threshold:
#
#   ## SERVICE LIVENESS   — the former hydra-orchestrator-watchdog.sh logic
#                           (HTTP / docker / scheduler-staleness / tunnel,
#                           incl. the deliberate-stop reconciliation), now the
#                           TS CLI `hydra-watchdog.ts liveness` (issue #5096).
#                           Stale threshold: 15 min.
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
# ## SERVICE LIVENESS — ported to TypeScript (issue #5096, epic #5094)
# =============================================================================
#
# The liveness check (Redis ping, boot-window guards, /api/health, scheduler
# status + tick staleness, pending-work scheduler recovery, tunnel) now lives
# in scripts/hydra-watchdog.ts `liveness` over src/watchdog/liveness.ts (four
# pure predicates + a runLiveness over typed ports). See
# docs/operations/watchdog.md. It runs FIRST on every tick (before the wedge
# CLI), through run_watchdog_cli below.

# =============================================================================
# ## AUTOPILOT WEDGE — ported to TypeScript (issue #5095, epic #5094)
# =============================================================================
#
# The wedge check (SIGTERM, grace, SIGKILL of a frozen autopilot PID once its
# OS heartbeat is stale) now lives in scripts/hydra-watchdog.ts over
# src/watchdog/wedge.ts (a pure decideWedge + a runWedge over typed ports), with
# its thresholds in src/autopilot/stale-thresholds.ts. Do NOT shorten the
# SIGKILL threshold. The CLI runs from the deployed checkout ($HYDRA_ROOT), like
# operator-notify.ts; it always exits 0 itself, and this wrapper turns a missing
# node / broken runtime into a WARN line so the other blocks still run.

# Resolve a node binary WITHOUT relying on the caller's PATH: the systemd user
# unit sets no PATH, and Node is nvm-pinned (.nvmrc), so a bare `node` can be
# absent there while the deploy smoke (runner shell) passes — silently
# disarming the SIGKILL gate. Order: HYDRA_WATCHDOG_NODE override, PATH, then
# the newest nvm-installed node under $HOME. Prints the path; rc 1 if none.
resolve_watchdog_node() {
  local cand
  if [ -n "${HYDRA_WATCHDOG_NODE:-}" ] && [ -x "$HYDRA_WATCHDOG_NODE" ]; then
    printf '%s\n' "$HYDRA_WATCHDOG_NODE"; return 0
  fi
  if cand="$(command -v node 2>/dev/null)" && [ -n "$cand" ]; then
    printf '%s\n' "$cand"; return 0
  fi
  cand="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    printf '%s\n' "$cand"; return 0
  fi
  return 1
}

# run_watchdog_cli <subcommand> <log-prefix> <timeout-s>
# Runs one scripts/hydra-watchdog.ts subcommand. The CLI always exits 0 itself;
# a missing node or a non-zero exit (timeout, broken runtime) is ONE WARN line,
# never an aborted tick — every other block still runs.
run_watchdog_cli() {
  local sub="$1" prefix="$2" timeout_s="$3" node_bin rc=0
  if ! node_bin="$(resolve_watchdog_node)"; then
    echo "$prefix WARN node not found (PATH, HYDRA_WATCHDOG_NODE, ~/.nvm) — $sub check skipped this tick"
    return 0
  fi
  timeout "$timeout_s" "$node_bin" --experimental-strip-types "${HYDRA_ROOT:-$HOME/hydra}/scripts/hydra-watchdog.ts" "$sub" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "$prefix WARN $sub CLI FAILED (rc=$rc) — $sub check skipped this tick"
  fi
  return 0
}

run_liveness_cli() { run_watchdog_cli liveness "hydra-orchestrator-watchdog:" 120; }
run_wedge_cli() { run_watchdog_cli wedge "hydra-autopilot-watchdog:" 90; }

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
#                                      The default is pinned to
#                                      DEPLOY_DRIFT_GRACE_SECONDS in
#                                      src/health/deployed-sha.ts (the source
#                                      of truth; test/attention-buckets.test.mts).
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
# ## REDIS BACKUP FRESHNESS
# =============================================================================
#
# Redis-backup freshness backstop (issue #4604).
#
# Why this exists
# ---------------
# The nightly Redis backup (docs/reference.md "## Backups", shipped #2742) is
# the ONLY copy of all orchestrator state (evidence, events, backlog, run
# ledger, attribution) off the hydra_redis-data docker volume — and until
# #4604 its timer was hand-installed host state that was never installed on
# this host, so NO scheduled backup ran and nothing noticed: the doctor's
# Timer Health loop watched only Target timers, the failed-service check
# can't see a never-installed unit, and no watchdog block covered backups.
# deploy.sh now installs+enables the timer; THIS block is the detection half
# — it flags a missing or stale dump so a silently-dead backup schedule
# surfaces within one threshold window instead of at restore time.
#
# What it asserts
# ----------------
#   1. The newest hydra-redis-*.rdb.gz directly under the backup dir is
#      newer than a staleness threshold (default 36h — one daily cadence
#      plus a late-run margin). A missing dir or an empty dir is STALE too.
#   2. Separately (log line only, not part of the staleness signal):
#      hydra-redis-backup.timer reports `enabled` via systemctl — a
#      disabled/not-found timer is the leading indicator of the staleness
#      the file check will eventually catch.
#
# Delivery reuses the #3848 taxonomy run_node_modules_integrity established:
# the SAME streak/dedup design (Redis SET NX since + fired, DEL both on
# recovery) and the SAME in-band delivery surface (an enveloped XADD onto
# hydra:notifications). Threshold is 0ms — the 36h freshness window IS the
# streak, so the fired marker sets (and delivery fires) on the very first
# qualifying tick; dedup suppresses re-alarm for the rest of the episode and
# recovery (DEL) re-arms it. Deliberately NOT registered in
# src/event-bus-vocabulary.ts / alert-grammar / digest: that would drag
# src/ into what is otherwise a scripts-only T3 PR (design concept for
# issue-4604, invariant 11).
#
# Fail-safe (HARD): this block NEVER throws and NEVER returns non-zero. All
# redis-cli / find / systemctl calls are best-effort (`|| true` /
# redirected); Redis being down must not break the block — detection still
# logs, only the dedup/delivery state is unreachable that tick.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-redis-backup-freshness.test.mts):
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT        shared with the other blocks.
#   HYDRA_REDIS_DB                             DB index passed as `-n <db>` to
#                                               every rc_write/rc_read call
#                                               (default 0, the production DB;
#                                               scripts/test/redis-db-launch.mjs
#                                               exports the run's derived DB
#                                               under this name, #4183).
#   HYDRA_WATCHDOG_BACKUP_DIR                  backup dir override (default
#                                               /mnt/hydra-ssd/backups/redis)
#                                               so tests drive a temp dir.
#   HYDRA_WATCHDOG_BACKUP_STALE_HOURS          staleness threshold in hours
#                                               (default 36).
#   HYDRA_WATCHDOG_BACKUP_NOTIFY_STREAM        in-band delivery stream key
#                                               (default hydra:notifications);
#                                               rebound in tests so a case can
#                                               never write a real event onto
#                                               the PRODUCTION stream.
#   HYDRA_WATCHDOG_BACKUP_TIMER_STATE          overrides the timer's
#                                               is-enabled result (skip the
#                                               real systemctl call), e.g.
#                                               "enabled" / "disabled" /
#                                               "not-found".

run_redis_backup_freshness() {
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  # DB index for the bash-side redis-cli calls in rc_write/rc_read below
  # (issue #4183, mirroring run_node_modules_integrity's identical
  # treatment): unset/non-numeric falls back to db 0 so production behaviour
  # is byte-identical; scripts/test/redis-db-launch.mjs exports the run's
  # derived DB under this same name so a test inherits isolation for free.
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  local RB_KEY_PREFIX="hydra:autopilot:redis-backup-freshness"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_BACKUP_NOTIFY_STREAM:-hydra:notifications}"
  local BACKUP_DIR="${HYDRA_WATCHDOG_BACKUP_DIR:-/mnt/hydra-ssd/backups/redis}"
  local STALE_HOURS="${HYDRA_WATCHDOG_BACKUP_STALE_HOURS:-36}"
  [[ "$STALE_HOURS" =~ ^[0-9]+$ ]] || STALE_HOURS=36
  local TIMER_STATE="${HYDRA_WATCHDOG_BACKUP_TIMER_STATE:-}"

  log() {
    echo "hydra-redis-backup-freshness-watchdog: $*"
  }

  # rc_write/rc_read — same best-effort contract as run_launch_flow's and
  # run_node_modules_integrity's helpers (fire-and-forget mutation; "" on any
  # read failure). Deliberately another copy rather than a shared top-level
  # helper: hoisting would change those blocks' tested extraction boundaries.
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # stderr is kept so the WARN names WHY (a strip-types boot error, a
    # transport error) instead of a bare rc; the first Error line wins, else
    # the last line.
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  # deliver_signal REASON AGE_MS THR_MS — enveloped XADD onto the
  # notifications stream, the exact on-wire shape src/event-bus.ts's publish()
  # constructs (ADR-0017 Category A), mirroring run_node_modules_integrity's
  # deliver_signal, PLUS one Operator Channel CLI page (#5046). Always
  # returns 0 (best-effort).
  deliver_signal() {
    local reason="$1" age_ms="$2" thr_ms="$3"
    local reason_clean
    reason_clean="$(printf '%s' "$reason" | tr -dc 'a-zA-Z0-9_.:-')"
    local iso payload
    iso="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    payload="$(printf '{"signal":"%s","reason":"%s","durationMs":%s,"thresholdMs":%s}' \
      "redis-backup" "$reason_clean" "$age_ms" "$thr_ms")"
    rc_write XADD "$NOTIFY_STREAM" '*' \
      id "redis-backup-freshness-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "infra:redis_backup_stale" \
      source "watchdog-redis-backup-freshness" \
      timestamp "$iso" \
      correlationId "redis-backup-freshness" \
      payload "$payload"
    log "in-band delivery published (best-effort) for stale redis backup (type=infra:redis_backup_stale -> ${NOTIFY_STREAM})"
    deliver_page page --kind "infra:redis_backup_stale" --dedup-key "infra:redis_backup_stale" \
      --title "Redis backup $reason_clean (threshold ${STALE_HOURS}h)" \
      --fact "reason=$reason_clean" --fact "age_ms=$age_ms" --fact "threshold_ms=$thr_ms" --fact "backup_dir=$BACKUP_DIR"
    return 0
  }

  # Freshness threshold, expressed in ms for the delivery envelope and in
  # seconds for the age comparison below.
  local thr_ms=$(( STALE_HOURS * 3600 * 1000 ))

  # --- Timer-enabled visibility (advisory log only; deliberately NOT part
  # of the staleness signal — a disabled timer surfaces here first, then as
  # staleness once the newest dump ages out) ---
  if [[ -z "$TIMER_STATE" ]]; then
    TIMER_STATE="$(systemctl --user is-enabled hydra-redis-backup.timer 2>/dev/null || true)"
    [[ -n "$TIMER_STATE" ]] || TIMER_STATE="unknown"
  fi
  if [[ "$TIMER_STATE" != "enabled" ]]; then
    log "WARN hydra-redis-backup.timer is not enabled (state=${TIMER_STATE}) — no scheduled Redis backup is running; scripts/deploy.sh installs+enables it (issue #4604)"
  fi

  # --- Freshness detection: newest hydra-redis-*.rdb.gz directly under the
  # backup dir. find errors (missing dir, unreadable) degrade to empty →
  # STALE, never to a wedged block. ---
  local now_ms
  now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0
  local now_s=$(( now_ms / 1000 ))

  local newest_line
  newest_line="$(find "$BACKUP_DIR" -maxdepth 1 -name 'hydra-redis-*.rdb.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 || true)"
  local newest_file="" newest_mtime=0
  if [[ -n "$newest_line" ]]; then
    newest_file="${newest_line#* }"
    newest_mtime="$(printf '%s' "$newest_line" | cut -d' ' -f1 | cut -d'.' -f1 | tr -dc '0-9')"
    [[ "$newest_mtime" =~ ^[0-9]+$ ]] || newest_mtime=0
  fi

  local since_key="${RB_KEY_PREFIX}:since"
  local fired_key="${RB_KEY_PREFIX}:fired"
  local stale reason age_s age_ms
  if [[ -z "$newest_file" ]]; then
    stale=1
    reason="missing"
    age_s=0
  else
    age_s=$(( now_s - newest_mtime ))
    if (( age_s < 0 )); then age_s=0; fi
    if (( age_s >= STALE_HOURS * 3600 )); then
      stale=1
      reason="stale"
    else
      stale=0
    fi
    log "newest backup: ${newest_file##*/} (age ${age_s}s ≈ $(( age_s / 3600 ))h; stale threshold ${STALE_HOURS}h)"
  fi
  age_ms=$(( age_s * 1000 ))

  # --- Uniform streak rule (threshold 0 — the 36h window IS the streak):
  # SET NX the since anchor, fire the enveloped delivery ONCE per episode,
  # DEL both keys on recovery so a recurrence re-arms. ---
  if [[ "$stale" == "1" ]]; then
    log "WARNING REDIS BACKUP STALE — ${reason} in ${BACKUP_DIR} (threshold ${STALE_HOURS}h); orchestrator state is not being backed up off-volume (issue #4604)"
    rc_write SET "$since_key" "$now_ms" NX
    local since
    since="$(rc_read GET "$since_key" | tr -dc '0-9')"
    [[ "$since" =~ ^[0-9]+$ ]] || since="$now_ms"
    local dur_ms=$(( now_ms - since ))
    if (( dur_ms < 0 )); then dur_ms=0; fi
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
      rc_write SET "$fired_key" 1
      deliver_signal "$reason" "$age_ms" "$thr_ms"
    fi
  else
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
      log "redis backup fresh again — clearing the staleness episode (dedup re-armed)"
      deliver_page resolve --dedup-key "infra:redis_backup_stale" --title "Redis backup fresh again"
    fi
    rc_write DEL "$since_key" "$fired_key"
  fi

  log "redis-backup-freshness tick processed (backup_dir=${BACKUP_DIR}, timer=${TIMER_STATE}, now_ms=${now_ms})"
  return 0
}

# =============================================================================
# ## CLAUDE HOOKS
# =============================================================================
#
# Issue #5064. scripts/setup-claude-hooks.sh owns the HOOKS array of Claude
# Code PreToolUse hooks (worktree-write-fence.sh, git-remote-fence.sh, …). For
# months nothing in the deploy path ran it, so git-remote-fence.sh (#4939,
# merged in #4980) was never installed and never protected a session — and
# nothing noticed. scripts/deploy.sh now runs the installer on every deploy;
# this block is the backstop alarm for when the live install still lacks a
# hook (a failed deploy step, a hand-edited settings.json, a wiped hooks dir).
#
# Fails (alarms) when ANY hook listed by `setup-claude-hooks.sh --list` (the
# single source of truth — never a second copy of the list here) is
#   (a) missing as a file under the installed hooks dir, OR
#   (b) not registered in settings.json's hooks.PreToolUse — registered means
#       a block whose `matcher` EQUALS the --list entry's matcher and which
#       holds a `{"type":"command","command":"bash <hooks dir>/<name>"}` hook
#       (exactly what the installer writes; a substring match would accept a
#       wrong matcher or a decorated command) — OR the settings file is
#       absent/unparseable (Claude Code would load no hooks from it either).
#
# STRICTLY READ-ONLY: never installs or repairs — `bash scripts/deploy.sh` (or
# `bash scripts/setup-claude-hooks.sh`) is the fix, run from an operator shell.
# One enveloped XADD onto hydra:notifications per episode (type
# infra:claude_hooks_missing), dedup'd by a since marker that is created only
# after the XADD succeeds and cleared (re-armed) once everything is present.
# "Succeeds" means the reply is a stream id (^[0-9]+-[0-9]+$): `redis-cli
# --raw` prints an error reply (ERR …, WRONGTYPE …) on stdout and still exits
# 0, so a merely non-empty reply must NOT write the marker — that would
# silence the alarm for the whole episode with nothing delivered.
#
# Fail-safe: any tooling failure (installer script missing, --list failing,
# python3 missing) logs WARN and returns 0.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-claude-hooks.test.mts):
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_SETUP         Installer script read for the
#                                             expected list (default
#                                             $HYDRA_ROOT/scripts/setup-claude-hooks.sh).
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_DIR           Installed hooks dir (default
#                                             $HOME/.claude/hooks/hydra).
#   HYDRA_WATCHDOG_CLAUDE_SETTINGS            Settings file (default
#                                             $HOME/.claude/settings.json).
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_STATE_DIR     Marker dir (default /tmp).
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_NOTIFY_STREAM Notification stream (default
#                                             hydra:notifications).

run_claude_hooks() {
  local HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
  local SETUP="${HYDRA_WATCHDOG_CLAUDE_HOOKS_SETUP:-${HYDRA_ROOT}/scripts/setup-claude-hooks.sh}"
  local HOOKS_DIR="${HYDRA_WATCHDOG_CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/hydra}"
  local SETTINGS="${HYDRA_WATCHDOG_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
  local STATE_DIR="${HYDRA_WATCHDOG_CLAUDE_HOOKS_STATE_DIR:-/tmp}"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_CLAUDE_HOOKS_NOTIFY_STREAM:-hydra:notifications}"
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  local SINCE_MARKER="${STATE_DIR}/hydra-claude-hooks-missing.since"

  ch_log() {
    echo "hydra-claude-hooks-watchdog: $*"
  }

  # Output-returning call ("" on any failure) so the XADD result can gate the
  # dedup marker.
  ch_rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  if [[ ! -f "$SETUP" ]]; then
    ch_log "WARN installer ${SETUP} not found — skipping claude hooks check"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    ch_log "WARN python3 not found — skipping claude hooks check"
    return 0
  fi

  # --- Expected hooks: the installer's own HOOKS array (single source) ---
  local listing="" list_rc=0
  listing="$(bash "$SETUP" --list 2>/dev/null)" || list_rc=$?
  if (( list_rc != 0 )); then
    ch_log "WARN ${SETUP} --list failed (rc=${list_rc}) — skipping claude hooks check"
    return 0
  fi
  # entries keep the full "name|matcher" line for the registration check;
  # names is just the hook filename for the installed-file check.
  local entries=() names=() entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    entries+=("$entry")
    names+=("${entry%%|*}")
  done <<< "$listing"
  if (( ${#names[@]} == 0 )); then
    ch_log "WARN ${SETUP} --list returned no hooks — skipping claude hooks check"
    return 0
  fi

  mkdir -p "$STATE_DIR" 2>/dev/null || {
    ch_log "WARN cannot create state dir ${STATE_DIR} — skipping claude hooks check"
    return 0
  }

  local reasons=() name
  # (a) installed hook files
  for name in "${names[@]}"; do
    [[ -f "${HOOKS_DIR}/${name}" ]] || reasons+=("file-missing:${name}")
  done

  # (b) settings.json PreToolUse registrations. Prints one line per hook that
  # is NOT registered, or the single token SETTINGS_UNREADABLE.
  local unregistered="" py_rc=0
  unregistered="$(python3 - "$SETTINGS" "$HOOKS_DIR" "${entries[@]}" <<'PY' 2>/dev/null
import json, sys
settings_path, hooks_dir, *entries = sys.argv[1:]
try:
    with open(settings_path, encoding="utf-8") as f:
        data = json.load(f)
    pre = data.get("hooks", {}).get("PreToolUse", [])
    if not isinstance(pre, list):
        pre = []
except Exception:
    print("SETTINGS_UNREADABLE")
    sys.exit(0)
# Exact (matcher, command) pairs of every command hook, mirroring the shape
# setup-claude-hooks.sh writes: {"matcher": M, "hooks": [{"type": "command",
# "command": "bash <dir>/<name>"}]}.
registered = set()
for block in pre:
    if not isinstance(block, dict):
        continue
    matcher = block.get("matcher")
    for h in block.get("hooks", []) or []:
        if isinstance(h, dict) and h.get("type") == "command":
            registered.add((matcher, h.get("command")))
for entry in entries:
    name, _, matcher = entry.partition("|")
    if (matcher, f"bash {hooks_dir.rstrip('/')}/{name}") not in registered:
        print(name)
PY
)" || py_rc=$?
  if (( py_rc != 0 )); then
    ch_log "WARN settings parser failed (rc=${py_rc}) — skipping claude hooks check"
    return 0
  fi
  local u
  while IFS= read -r u; do
    [[ -n "$u" ]] || continue
    if [[ "$u" == "SETTINGS_UNREADABLE" ]]; then
      reasons+=("settings-unreadable")
    else
      reasons+=("unregistered:${u}")
    fi
  done <<< "$unregistered"

  if (( ${#reasons[@]} == 0 )); then
    if [[ -f "$SINCE_MARKER" ]]; then
      ch_log "claude hooks healthy again — dedup re-armed"
    fi
    rm -f "$SINCE_MARKER" 2>/dev/null || true
    ch_log "claude-hooks tick processed (${#names[@]} hook(s) installed and registered: ${names[*]})"
    return 0
  fi

  local reason_str
  reason_str="$(IFS=,; echo "${reasons[*]}")"
  ch_log "ALARM Claude Code PreToolUse hooks not fully installed: ${reason_str} (hooks dir ${HOOKS_DIR}, settings ${SETTINGS}; issue #5064 — run 'bash scripts/setup-claude-hooks.sh' or 'bash scripts/deploy.sh' from an operator shell)"

  if [[ ! -f "$SINCE_MARKER" ]]; then
    local iso_now payload reason_clean xadd_out
    iso_now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    reason_clean="$(printf '%s' "$reason_str" | tr -dc 'a-zA-Z0-9_.:,-')"
    payload="$(printf '{"signal":"claude-hooks","reason":"%s"}' "$reason_clean")"
    xadd_out="$(ch_rc_read XADD "$NOTIFY_STREAM" '*' \
      id "claude-hooks-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "infra:claude_hooks_missing" \
      source "watchdog-claude-hooks" \
      timestamp "$iso_now" \
      correlationId "claude-hooks" \
      payload "$payload")"
    # Only a stream id proves the entry landed. An error reply (ERR …,
    # WRONGTYPE …, NOAUTH …) is printed on stdout with exit 0 by `redis-cli
    # --raw`; treating it as success would write the marker and silence the
    # whole episode.
    if [[ "$xadd_out" =~ ^[0-9]+-[0-9]+$ ]]; then
      date +%s > "$SINCE_MARKER" 2>/dev/null || true
      ch_log "in-band delivery published type=infra:claude_hooks_missing -> ${NOTIFY_STREAM} (id ${xadd_out})"
    else
      local reply_snip
      reply_snip="$(printf '%s' "$xadd_out" | tr '\n' ' ' | cut -c1-160)"
      ch_log "WARN in-band delivery FAILED (XADD reply '${reply_snip}' is not a stream id) — will retry next tick"
    fi
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
#   - Regenerates every hydra-* skill into a SCRATCH CLAUDE_SKILLS_DIR
#     (sync-skills.sh's own override mechanism — a pure,
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
  CLAUDE_SKILLS_DIR="$scratch_claude" \
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
  # Deliberately the DEFAULT path (no CLAUDE_SKILLS_DIR
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
#   $HOME/hydra/node_modules                    (the orchestrator — always)
#   <target workspace>/<appSubdir>/node_modules (the LIVE Target, resolved
#                                                through the target-config
#                                                seam scripts/target/
#                                                print-target-facts.ts, #4608;
#                                                the incident root was the
#                                                mothballed Target's
#                                                web/node_modules, which is
#                                                no longer watched)
# The Target resolve is best-effort: on any seam failure the block logs a
# WARN and watches only the orchestrator root — fail OPEN on Target
# coverage, never on orchestrator coverage.
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
# and PAGE_KINDS (src/operator-channel/page-list.ts) — six money-critical
# services down warrants both the dashboard alert and an Operator Channel page.
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
#   HYDRA_REDIS_DB                             DB index passed as `-n <db>` to
#                                               every rc_write/rc_read call
#                                               (default 0, the production DB).
#                                               Non-numeric input falls back to
#                                               0. scripts/test/redis-db-launch
#                                               .mjs exports the run's derived
#                                               per-run DB under this name, so
#                                               a test that shells into this
#                                               block writes into the run's
#                                               isolated DB instead of past it
#                                               onto production db 0 (#4183).
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
  # DB index for the bash-side redis-cli calls in rc_write/rc_read below
  # (issue #4183, mirroring run_launch_flow's identical treatment). Unset or
  # non-numeric input falls back to db 0 so production behaviour is
  # byte-identical to before this variable existed. scripts/test/
  # redis-db-launch.mjs exports the run's derived DB under this same name, so
  # any bash block a test shells into inherits the run's isolation
  # automatically rather than opting in per call site.
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  local NM_KEY_PREFIX="hydra:autopilot:node-modules-integrity"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_NM_NOTIFY_STREAM:-hydra:notifications}"
  local ENTRY_FLOOR="${HYDRA_WATCHDOG_NM_ENTRY_FLOOR:-20}"
  local REQUIRED_BIN="${HYDRA_WATCHDOG_NM_REQUIRED_BIN:-tsx}"
  [[ "$ENTRY_FLOOR" =~ ^[0-9]+$ ]] || ENTRY_FLOOR=20

  log() {
    echo "hydra-node-modules-integrity-watchdog: $*"
  }

  local -a WATCHED_ROOTS
  if [[ -n "${HYDRA_WATCHDOG_NM_ROOTS:-}" ]]; then
    IFS=':' read -r -a WATCHED_ROOTS <<< "$HYDRA_WATCHDOG_NM_ROOTS"
  else
    # Default roots (issue #4608): the orchestrator's own node_modules plus
    # the LIVE Target's app-dir node_modules — `<workspace>/<appSubdir>/
    # node_modules`, empty appSubdir = identity — resolved through the
    # target-config seam, never a hardcoded Target path (ADR-0002, ADR-0013
    # Decision 4). Every step is best-effort under `set -e`: a missing
    # seam / npx / jq degrades to "orchestrator root only" plus a WARN.
    WATCHED_ROOTS=(
      "$HOME/hydra/node_modules"
    )
    local target_facts target_nm_root
    target_facts="$(cd "$HOME/hydra" 2>/dev/null && npx tsx scripts/target/print-target-facts.ts 2>/dev/null || true)"
    target_nm_root="$(printf '%s' "$target_facts" | jq -r '
      if (.workspace // "") == "" then empty
      elif (.manifest.appSubdir // "") == "" then .workspace + "/node_modules"
      else .workspace + "/" + (.manifest.appSubdir | sub("/+$"; "")) + "/node_modules"
      end' 2>/dev/null || true)"
    if [[ -n "$target_nm_root" ]]; then
      WATCHED_ROOTS+=("$target_nm_root")
    else
      log "WARN — Target node_modules root unresolved via scripts/target/print-target-facts.ts; watching only the orchestrator root this tick"
    fi
  fi

  # rc_write/rc_read — same best-effort contract as run_launch_flow's helpers
  # (fire-and-forget mutation; "" on any read failure). Deliberately a second
  # copy rather than a shared top-level helper: hoisting would change
  # run_launch_flow's tested extraction boundary (test/watchdog-launch-flow
  # .test.mts and test/launch-flow-delivery.test.mts both extract that
  # function verbatim by name).
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  nm_since_key() { printf '%s:since:%s\n' "$NM_KEY_PREFIX" "$1"; }
  nm_fired_key() { printf '%s:fired:%s\n' "$NM_KEY_PREFIX" "$1"; }

  # sig_for_root ROOT — a stable, Redis-key-safe signal name derived from the
  # watched path (non-alnum runs collapsed to single underscores).
  sig_for_root() {
    printf '%s' "$1" | tr -c 'a-zA-Z0-9' '_' | tr -s '_'
  }

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # stderr is kept so the WARN names WHY (a strip-types boot error, a
    # transport error) instead of a bare rc; the first Error line wins, else
    # the last line.
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  # deliver_signal SIG ROOT REASON DUR_MS THR_MS — enveloped XADD onto the
  # notifications stream, the exact on-wire shape src/event-bus.ts's publish()
  # constructs (ADR-0017 Category A), mirroring run_launch_flow's
  # deliver_in_band, PLUS one Operator Channel CLI page (#5046). Always
  # returns 0 (best-effort).
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
    deliver_page page --kind "infra:node_modules_wiped" --dedup-key "infra:node_modules_wiped" \
      --title "node_modules integrity: '$root_clean' $reason_clean" \
      --fact "root=$root_clean" --fact "reason=$reason_clean" --fact "sustained_ms=$dur_ms" --fact "threshold_ms=$thr_ms"
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
      # Recovery edge (#5046): CLI resolve only when the fired marker existed.
      if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
        deliver_page resolve --dedup-key "infra:node_modules_wiped" --title "node_modules integrity recovered: '$root'"
      fi
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
#   fail-safe, meter-dark → OUT-OF-BAND: one Operator Channel CLI `page`
#       (scripts/operator-notify.ts, ADR-0045 D2 — it imports the channel
#       module directly, so it works with the Orchestrator down; #5046
#       replaced the former bash curl). Both mean "DEFECTIVE AND FULLY
#       BLOCKING" — the Orchestrator process that would consume an in-band
#       event may itself be unreachable, and a bash LPUSH an operator can
#       only read through GET /api/alerts on port 4000 is the "written and
#       unreadable" trap. Page kinds launch:fail_safe / launch:meter_dark.
#
#   quota, latency → IN-BAND: an enveloped event XADD'd directly onto the
#       hydra:notifications stream (id/type/source/timestamp/correlationId/
#       payload — the on-wire shape src/event-bus.ts's publish() constructs,
#       ADR-0017 Category A). Both fire only when pace-gate's last-tick hash
#       was successfully READ, which proves the Orchestrator was up at
#       detection time. The in-process notification-consumer (unmodified)
#       picks the event up: it lands in ALERT_TYPES (dashboard alert via the
#       compile-checked formatAlertMessage grammar) AND in the Operator
#       Channel's PAGE_KINDS (src/operator-channel/page-list.ts — an immediate
#       page, ADR-0045).
#
#   pause → IN-BAND, PAGE ONLY: the same enveloped XADD, but
#       launch:pause_forgotten is deliberately NOT in ALERT_TYPES — a
#       deliberate overnight operator pause must never leave a lingering
#       unread dashboard alert (the alarm-fatigue failure the taxonomy exists
#       to prevent). It reaches the operator as an Operator Channel page only
#       (launch:pause_forgotten is in PAGE_KINDS).
#
# Credential placement: the CLI's single loader reads TELEGRAM_BOT_TOKEN /
# TELEGRAM_CHAT_ID from the process env — hydra-watchdog.service loads
# %h/hydra/.env dash-prefixed (#5046) so the vars are present without making
# any other block depend on the file. The watchdog itself never reads them;
# an unconfigured credential is the CLI's `skipped-no-credentials` outcome in
# its JSON line, the journal and the channel's delivery log — visible as
# unconfigured, never silent and never fatal.
#
# Every page-list alarm (quota / latency / pause / glm-sterile too) ALSO calls
# the CLI `page` at the fired absent→present transition, with dedupKey ==
# kind, while the in-band XADD stays byte-for-byte (the dashboard-alert path).
# At the fired→absent recovery edge the block calls CLI `resolve` once.
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
# (redirected output, || log, bounded `timeout`) — a CLI or XADD failure
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
#   HYDRA_REDIS_DB                      DB index passed as `-n <db>` to every
#                                        rc_write/rc_read call (default 0, the
#                                        production DB). Non-numeric input
#                                        falls back to 0. scripts/test/
#                                        redis-db-launch.mjs exports the run's
#                                        derived per-run DB under this name, so
#                                        a test that shells into this block
#                                        writes into the run's isolated DB
#                                        instead of past it onto production
#                                        db 0 (issue #4183).
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
  # DB index for the bash-side redis-cli calls in rc_write/rc_read below
  # (issue #4183). Unset or non-numeric input falls back to db 0 so
  # production behaviour is byte-identical to before this variable existed.
  # scripts/test/redis-db-launch.mjs exports the run's derived DB under this
  # same name, so any bash block a test shells into inherits the run's
  # isolation automatically rather than opting in per call site.
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
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  # rc_read — capture redis output ("" on any failure).
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
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

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # stderr is kept so the WARN names WHY (a strip-types boot error, a
    # transport error) instead of a bare rc; the first Error line wins, else
    # the last line.
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  # lf_kind_for_sig SIGNAL — the Operator Channel page kind for a signal (the
  # same literals the in-band envelopes carry; fail-safe / meter-dark are the
  # #5046 page-list literals that never ride the bus). dedupKey == kind, so an
  # in-process page for the same event is suppressed by the shared Redis
  # dedup state rather than delivered twice.
  lf_kind_for_sig() {
    case "$1" in
      fail-safe)   printf 'launch:fail_safe' ;;
      meter-dark)  printf 'launch:meter_dark' ;;
      quota)       printf 'launch:quota_stretch' ;;
      latency)     printf 'launch:latency_breach' ;;
      pause)       printf 'launch:pause_forgotten' ;;
      glm-sterile) printf 'glm:drainer_sterile' ;;
      *)           printf '%s' "$1" ;;
    esac
  }

  # deliver_out_of_band SIGNAL DUR_MS THR_MS — fail-safe / meter-dark: one
  # Operator Channel CLI `page` (ADR-0045 D2). Zero dependency on any
  # Orchestrator HTTP endpoint and no XADD: both signals mean the Orchestrator
  # may itself be unreachable, so an in-band event would be written and
  # unreadable. Credentials and dedup are the CLI's.
  deliver_out_of_band() {
    local sig="$1" dur_ms="$2" thr_ms="$3" etype
    case "$sig" in
      fail-safe)  etype="launch:fail_safe" ;;
      meter-dark) etype="launch:meter_dark" ;;
      *) return 0 ;;
    esac
    deliver_page page --kind "$etype" --dedup-key "$etype" \
      --title "Launch flow '$sig' sustained ${dur_ms}ms (>= ${thr_ms}ms) — Orchestrator may be down" \
      --fact "signal=$sig" --fact "reason=${reason:-n/a}" --fact "sustained_ms=$dur_ms" --fact "threshold_ms=$thr_ms"
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
    # ADR-0045 D2 (#5046): the page itself goes through the Operator Channel
    # CLI with dedupKey == kind, so the consumer's own page for the XADD above
    # (messageFromEvent keys on the event type) dedups against it.
    deliver_page page --kind "$etype" --dedup-key "$etype" \
      --title "Launch flow '$sig' sustained ${dur_ms}ms (>= ${thr_ms}ms)" \
      --fact "signal=$sig" --fact "reason=${reason_clean:-n/a}" --fact "sustained_ms=$dur_ms" --fact "threshold_ms=$thr_ms"
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
      # Membership false — stateless recovery: DEL both (idempotent). The
      # "recovered" message is ONE edge (#5046): CLI resolve only when the
      # fired marker existed before the DEL, never once per healthy tick.
      if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
        deliver_page resolve --dedup-key "$(lf_kind_for_sig "$sig")" --title "Launch flow '$sig' recovered"
      fi
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
    meter-unavailable|token-refresh-nudge)
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

  # --- GLM drainer zero-throughput membership (issues #3868 + #4691) ---
  #
  # "Live but sterile": while the drainer heartbeat is FRESH, the #3754
  # partition keeps the drained work off the Opus dev lane — so a drainer
  # that is alive but shipping nothing starves its lane invisibly. Observed
  # 2026-08-05 (#3863): fresh heartbeat, picks proceeding, `gh pr create`
  # failing on every attempt, ~40 min of z.ai authoring per issue, zero PRs,
  # no alarm — liveness checks cannot see throughput. Membership here is the
  # AND of exactly four facts, evaluated cheap → expensive, and a
  # missing/stale/unparseable verdict read fails QUIET in the no-alarm
  # direction:
  #
  #   1. heartbeat fresh (one Redis GET) — stale/absent is the already-handled
  #      "down" case (board-state.ts un-gates the Opus lane after 45 min,
  #      ADR-0032 #3753 delta 2); alarming on it here would double-alarm, so
  #      a non-fresh heartbeat clears membership and NO further read is made.
  #   2. the drainer's own published pick verdict is present and fresh (one
  #      Redis GET of hydra:glm:drainer:last-pick, written every non-dry-run
  #      tick by the epsilon pick phase, #4686 / ADR-0040 row 10). #4691
  #      replaced the watchdog's own board re-derivation — a gh issue-queue
  #      count that forked the drainer's eligibility rules and false-alarmed
  #      on correctly-skipped candidates (the #4286 class) — with this
  #      record: the drainer is the single authority on what is pickable. A
  #      missing, unparseable, or stale (age > GLM_LAST_PICK_STALE_MS)
  #      verdict is not sterile — fail-quiet, the heartbeat's own direction.
  #   3. that verdict's `picked` is a positive integer — the last pick tick
  #      ADMITTED an issue (ADR-0040 row 10's `pickable > 0`). `candidates`
  #      and `skipped` are never consulted by the membership decision: the
  #      pick phase returns on the first admitted candidate, so candidates>0
  #      with picked=null means every candidate was legitimately skipped —
  #      the correctly-IDLE shape, never sterile, and zero gh calls.
  #   4. zero drainer PRs created in the trailing window (one gh REST call) —
  #      "a drainer PR" is the SHARED issue-#4048 OR-predicate (glm-authored
  #      label OR worktree-agent-glm-* head branch), reused LITERALLY below:
  #      GLM_PR_MATCH_JQ is byte-identical to scripts/glm-beachhead-report.sh's
  #      and MUST stay so (drift-guarded by test/launch-flow-delivery.test.mts,
  #      mirroring the existing Turn Snapshot ↔ beachhead pairing). REST rows
  #      are normalized to the {labels, headRefName} field names the shared
  #      predicate reads, so the predicate text itself never forks.
  #
  # A FAILED pulls query (non-zero exit, unparseable output) or a missing
  # gh/jq binary is not evidence of anything: it leaves the glm-sterile
  # streak state UNTOUCHED this tick (glm_sterile_known=0 skips the
  # track_signal call entirely — the same never-extend-AND-never-clear-on-a-
  # read-failure discipline as the last-tick read above). A missing/stale/
  # unparseable VERDICT, by contrast, is a measured fact, not a failed
  # measurement: it CLEARS (the heartbeat's own direction), so an old anchor
  # cannot survive a verdict outage and fire instantly on the next pick.
  #
  # The sustain threshold (default 1h) exists because the four-way AND can be
  # INSTANTLY true the moment a drainer picks an issue in front of an empty
  # PR window (fresh heartbeat + pickable verdict + no PR yet): a healthy
  # drainer lands its first PR in ~40 min, flipping membership off well
  # before the streak fires; a sterile one sustains it. gh api (REST) rather
  # than gh's --json (GraphQL) because a live autopilot can exhaust the
  # GraphQL budget and this runs on every 2-min watchdog tick — and since
  # #4691 the pulls query is the ONLY gh call in this block (idle ticks make
  # zero gh calls at all).
  local GLM_HEARTBEAT_KEY="hydra:glm:drainer:active"
  # 45 min in ms — MUST mirror src/redis/autopilot.ts's
  # GLM_DRAINER_HEARTBEAT_STALE_MS (drift-guarded by the delivery test).
  local GLM_HEARTBEAT_STALE_MS=2700000
  # The pick verdict key — owned by src/redis/autopilot.ts's
  # GLM_DRAINER_LAST_PICK_KEY (drift-guarded by the delivery test's rebind).
  # READ-ONLY here: the watchdog never writes or deletes this key.
  local GLM_LAST_PICK_KEY="hydra:glm:drainer:last-pick"
  # Verdict staleness window — the WRITER's own key TTL
  # (GLM_DRAINER_HEARTBEAT_TTL_SECONDS * 1000 from src/redis/autopilot.ts),
  # deliberately NOT the 45-min heartbeat window: the pick runs once per
  # drainer tick BEFORE a session of up to ~50 min, and flock-blocked ticks
  # refresh the heartbeat without re-picking, so a legitimate verdict is up
  # to ~65 min old (#4691).
  local GLM_LAST_PICK_STALE_MS=5400000
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
    # Fresh heartbeat — only now may clauses 2-4 read anything (read order,
    # cheap → expensive; a stale/absent heartbeat short-circuits first).
    if ! command -v jq >/dev/null 2>&1; then
      glm_sterile_known=0
      log "WARN glm-sterile check needs jq and it is missing — leaving the glm-sterile streak untouched this tick (#3868/#4691)"
    else
      local glm_pick_raw glm_pick_at="" glm_pick_picked="" glm_pick_age=-1
      glm_pick_raw="$(rc_read GET "$GLM_LAST_PICK_KEY")"
      if [[ -n "$glm_pick_raw" ]]; then
        # Type-strict jq extracts (a non-object value, a non-numeric `at`, a
        # non-numeric/non-positive `picked`, or an unparseable value all
        # degrade to ""). Every jq parse is `||`-guarded so a parse error can
        # never return non-zero out of the block under `set -euo pipefail`.
        glm_pick_at="$(printf '%s' "$glm_pick_raw" | jq -r 'if (.at | type) == "number" then .at else empty end' 2>/dev/null)" || glm_pick_at=""
        glm_pick_picked="$(printf '%s' "$glm_pick_raw" | jq -r 'if ((.picked | type) == "number") and (.picked > 0) then .picked else empty end' 2>/dev/null)" || glm_pick_picked=""
      fi
      if [[ "$glm_pick_at" =~ ^[0-9]+$ ]]; then
        glm_pick_age=$((now_ms - glm_pick_at))
      fi
      if (( glm_pick_age >= 0 && glm_pick_age <= GLM_LAST_PICK_STALE_MS )); then
        # Fresh verdict (clause 2). Clause 3: only a POSITIVE-integer `picked`
        # (the pick phase admitted an issue) may proceed to the PR window —
        # picked null/absent/non-positive is the correctly-idle shape (every
        # candidate legitimately skipped, e.g. artifact-missing) and clears
        # with ZERO gh calls.
        if [[ "$glm_pick_picked" =~ ^[1-9][0-9]*$ ]]; then
          local glm_window_start_ms glm_recent_prs glm_jq_prog
          glm_window_start_ms=$((now_ms - GLM_STERILE_WINDOW_H * 3600000))
          # gh is needed ONLY here: a bad/idle/stale verdict above clears with
          # zero gh calls even on a host without gh (ADR-0040 row 10 / #4691).
          if ! command -v gh >/dev/null 2>&1; then
            glm_sterile_known=0
            log "WARN glm-sterile PR-window query needs gh and it is missing — leaving the glm-sterile streak untouched this tick (#3868/#4691)"
          else
            # Normalize REST rows to the shared predicate's field names, then apply
            # the predicate + the created-in-window filter. 100 newest-first rows
            # comfortably cover any 6h window at this repo's PR rate.
            glm_jq_prog='[.[] | {labels, headRefName: (.head.ref // ""), createdAt: (.created_at // "")} | select('"${GLM_PR_MATCH_JQ}"') | select((.createdAt != "") and ((.createdAt | fromdateiso8601) * 1000 >= $since_ms))] | length'
            glm_recent_prs="$(gh api "repos/${GLM_REPO}/pulls?state=all&sort=created&direction=desc&per_page=100" 2>/dev/null \
              | jq --arg label "glm-authored" --arg prefix "worktree-agent-glm-" \
                   --argjson since_ms "$glm_window_start_ms" "$glm_jq_prog" 2>/dev/null)" || glm_recent_prs=""
            if ! [[ "$glm_recent_prs" =~ ^[0-9]+$ ]]; then
              glm_sterile_known=0
              log "WARN glm-sterile PR-window query failed/unparseable — a failed query is not zero throughput; leaving the glm-sterile streak untouched this tick (#3868/#4691)"
            elif (( glm_recent_prs == 0 )); then
              is_glm_sterile=1
            fi
          fi
        fi
      fi
      # Verdict missing/stale/unparseable (age <0 or > TTL) or idle (picked
      # null) → membership stays 0 and the streak CLEARS via the uniform rule
      # below — the heartbeat's own fail-quiet direction (#4691).
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
    # Skipped ENTIRELY (state untouched) when the pulls query failed or gh/jq is missing —
    # never extend and never clear a streak on unknown inputs. Deliberately
    # NOT a member of src/redis/launch-flow.ts's WATCHDOG_LAUNCH_SIGNALS:
    # that constant enumerates the pace-gate REASON-derived signals; this one
    # is derived from the drainer heartbeat + the published pick verdict +
    # the PR window instead.
    track_signal glm-sterile "$GLM_STERILE_MS" "$is_glm_sterile"
  fi

  log "launch-flow tick processed (reason=$reason, latency_ms=${latency_ms:-none}, now_ms=$now_ms)"
  return 0
}

# =============================================================================
# ## MORNING BRIEF MISSING
# =============================================================================
#
# Operator Channel delivery-health alarm (ADR-0045 Decision 8, issue #5048):
# page the operator ONCE when no Morning Brief has been delivered for 26h, and
# send the recovered message when one lands again.
#
# Why it lives here and not in the orchestrator
# ---------------------------------------------
# The brief (Decision 7) rides the scheduler heartbeat tick, so every way the
# brief can go silent — the orchestrator down, the scheduler deliberately
# stopped (`POST /scheduler/stop`), the transport failing for a day, the
# credentials unset — is a way the orchestrator could never report it. This
# block therefore reads the brief's ONLY timing state, the Redis key
# `hydra:operator-channel:brief:last-sent` (epoch ms, stamped by
# src/redis/operator-channel.ts ONLY after the transport reported a delivered
# send), directly with redis-cli — never through the orchestrator's HTTP API
# — and pages through the Operator Channel CLI, which imports the channel
# directly (Decision 6). The alarm is deliberately INDEPENDENT of the
# scheduler's running state: a stopped scheduler still earns a page after 26h,
# because the operator asked for a brief every day, not for one whenever the
# scheduler happens to run.
#
# Cold-start rule
# ---------------
# When the key has never been written (a fresh deploy, a restored Redis, or
# the key deleted) the block anchors `hydra:autopilot:brief-missing:absent-
# since` with SET NX at the FIRST tick that observes the absence and measures
# the 26h from that anchor — so a brand-new install gets a full 26h grace and
# then pages with reason `never-delivered`, instead of either paging on the
# first tick or staying silent forever. The anchor is DELeted the moment the
# key appears. (Rejected: anchoring on the orchestrator's first-start time,
# which would need the orchestrator API — the dependency this block exists to
# avoid.) A key holding an unparseable value is treated as absent.
#
# Reachability: an EXISTS that answers neither 0 nor 1 means Redis itself is
# unreachable — the block logs a WARN and leaves every state untouched (no
# page, no resolve, no anchor): the ## SERVICE LIVENESS block owns Redis-down,
# and an unreachable store must never masquerade as a missing brief.
#
# Delivery is the same edge-triggered shape the other blocks use: a fired
# marker SET on the first stale tick gates ONE `page` call per episode (the
# channel's own dedup would suppress a 2-minute repeat anyway, but every such
# call would inflate the suppressed counter the /health card shows), and the
# recovery tick calls `resolve` only when that marker existed, then DELs it.
#
# Fail-safe (HARD): never throws, never returns non-zero; every redis-cli /
# CLI call is best-effort.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-operator-channel.test.mts):
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT / HYDRA_REDIS_DB  shared with the other
#                                               blocks (see run_launch_flow).
#   HYDRA_WATCHDOG_BRIEF_STALE_HOURS            threshold in hours (default 26).
#   HYDRA_WATCHDOG_BRIEF_NOW_MS                 deterministic clock (epoch ms)
#                                               so a test can age the key
#                                               without sleeping.
#   HYDRA_WATCHDOG_OPERATOR_NOTIFY              the CLI binary (tests: an
#                                               argv-recording stub).

run_brief_missing() {
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  # The TS-owned key name (BRIEF_LAST_SENT_KEY in src/redis/operator-channel.ts;
  # drift-guarded by the test). READ ONLY here — only the scheduler stamps it.
  local LAST_SENT_KEY="hydra:operator-channel:brief:last-sent"
  local BM_KEY_PREFIX="hydra:autopilot:brief-missing"
  local STALE_HOURS="${HYDRA_WATCHDOG_BRIEF_STALE_HOURS:-26}"
  [[ "$STALE_HOURS" =~ ^[0-9]+$ ]] || STALE_HOURS=26
  # Force base 10: a zero-padded value (e.g. "08") must not parse as octal under set -e.
  STALE_HOURS=$((10#$STALE_HOURS))
  local KIND="brief:missing"

  log() {
    echo "hydra-brief-missing-watchdog: $*"
  }

  # rc_write/rc_read — same best-effort contract as the sibling blocks
  # (fire-and-forget mutation; "" on any read failure). A per-block copy, like
  # theirs: the test harnesses extract each block by slicing.
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  local now_ms="${HYDRA_WATCHDOG_BRIEF_NOW_MS:-}"
  if [[ ! "$now_ms" =~ ^[0-9]+$ ]]; then
    now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  fi
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0
  local thr_ms=$(( STALE_HOURS * 3600 * 1000 ))
  local absent_key="${BM_KEY_PREFIX}:absent-since"
  local fired_key="${BM_KEY_PREFIX}:fired"

  # --- Reachability first: neither 0 nor 1 means Redis is unreachable, not
  # that the brief is missing. Leave every state untouched. ---
  local exists
  exists="$(rc_read EXISTS "$LAST_SENT_KEY" | tr -dc '0-9')"
  if [[ "$exists" != "0" && "$exists" != "1" ]]; then
    log "WARN Redis unreachable (EXISTS ${LAST_SENT_KEY} answered '${exists:-nothing}') — cannot evaluate brief freshness this tick; alarm state unchanged (## SERVICE LIVENESS owns Redis-down)"
    return 0
  fi

  # --- Reference instant: the delivered stamp, or the cold-start anchor. ---
  local last_ms="" reference_ms reason
  if [[ "$exists" == "1" ]]; then
    last_ms="$(rc_read GET "$LAST_SENT_KEY" | tr -dc '0-9')"
  fi
  if [[ "$last_ms" =~ ^[0-9]+$ ]] && (( last_ms > 0 )); then
    reference_ms="$last_ms"
    reason="stale"
    # Gate the DEL on EXISTS: a healthy tick must not write when nothing is there.
    if [[ "$(rc_read EXISTS "$absent_key" | tr -dc '0-9')" == "1" ]]; then
      rc_write DEL "$absent_key"
    fi
  else
    rc_write SET "$absent_key" "$now_ms" NX
    local absent_since
    absent_since="$(rc_read GET "$absent_key" | tr -dc '0-9')"
    [[ "$absent_since" =~ ^[0-9]+$ ]] || absent_since="$now_ms"
    reference_ms="$absent_since"
    reason="never-delivered"
  fi
  local age_ms=$(( now_ms - reference_ms ))
  if (( age_ms < 0 )); then age_ms=0; fi
  local age_h=$(( age_ms / 3600000 ))

  # --- Edge-triggered delivery: ONE page per episode, one resolve on recovery. ---
  if (( age_ms >= thr_ms )); then
    log "WARNING MORNING BRIEF MISSING — ${reason}: no brief delivered for ${age_h}h (threshold ${STALE_HOURS}h; reference_ms=${reference_ms}, now_ms=${now_ms}) — issue #5048"
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
      rc_write SET "$fired_key" "$now_ms"
      deliver_page page --kind "$KIND" --dedup-key "$KIND" \
        --title "No Morning Brief delivered for ${age_h}h" \
        --fact "reason=${reason}" --fact "age_h=${age_h}" --fact "threshold_h=${STALE_HOURS}" --fact "last_sent_key=${LAST_SENT_KEY}"
    else
      log "still missing — already paged this episode (the fired marker holds the dedup)"
    fi
  else
    if [[ "$reason" == "stale" ]]; then
      log "morning brief fresh: last delivered ${age_h}h ago (threshold ${STALE_HOURS}h)"
    else
      log "morning brief never delivered yet: cold-start grace ${age_h}h of ${STALE_HOURS}h used (absent-since anchor ${reference_ms})"
    fi
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
      log "morning brief delivered again — clearing the episode (dedup re-armed)"
      deliver_page resolve --dedup-key "$KIND" --title "Morning Brief delivered again"
    fi
    rc_write DEL "$fired_key"
  fi

  log "brief-missing tick processed (threshold=${STALE_HOURS}h, reason=${reason}, now_ms=${now_ms})"
  return 0
}


# =============================================================================
# ## ORIGIN IDENTITY
# =============================================================================
#
# Issue #4939. Every ~/hydra worktree shares /home/gabe/hydra/.git/config. On
# 2026-10-07 a Target dispatch rewrote remote.origin.url to the Target repo
# (claw-street-bets) and a pruning fetch then deleted refs/remotes/origin/master;
# recent-merges failed open for ~80 minutes with nothing alarming. This block is
# the single alarm owner for that failure class. Fails (alarms) when
#   (a) the normalised remote.origin.url is not
#       ${HYDRA_WATCHDOG_EXPECTED_ORIGIN_REPO:-gaberoo322/hydra}, OR
#   (a') the origin host is not ${HYDRA_WATCHDOG_EXPECTED_ORIGIN_HOST:-github.com}
#       (reason wrong-origin-host, issue #5026), OR
#   (b) refs/remotes/origin/master does not resolve.
#
# AUTO-REPAIR (issue #5065). Detection is read-only (`git config --get`,
# `git rev-parse --verify`, `stat`). When it fails, the block self-heals from the
# watchdog's OWN shell (the git-remote-fence hook governs only Claude Code Bash
# tool calls, so this path is deliberately outside it):
#   (a) wrong URL  -> `git -C $HYDRA_ROOT config remote.origin.url <canonical>`
#                     (+ the default fetch refspec if absent), then fetch;
#   (b) origin/master missing with a correct URL -> fetch only.
# `git -C "$HYDRA_ROOT" fetch --quiet origin` runs under a timeout, then both
# checks are re-run against real git. The notification still fires (now saying
# "repaired", with old/new URL and the fetch result), and the .git/config mtime
# breadcrumb still logs, so the writer stays attributable. A failed repair or
# fetch alarms exactly as before, saying the repair failed. Every mutation is
# `git -C "$HYDRA_ROOT"` — no other repo is ever touched; no `git remote`, push,
# pull or prune. Never acts when EXPECTED or the canonical URL is empty.
#
# Each tick also records the .git/config mtime and logs one INFO line when it
# moved, so the next rewrite is attributable from the journal. One enveloped
# XADD onto hydra:notifications per episode-outcome (alarm / repaired /
# repair-failed), dedup'd by a since marker under the state dir that records
# the outcome; cleared (re-armed) when both checks pass on a later tick.
#
# Fail-safe (like ## DEPLOY DRIFT): any tooling failure logs WARN and returns 0.
#
# Knobs:
#   HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR      0 = kill switch (alarm only). Default 1.
#   HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL   URL written on repair. Default
#                                         https://github.com/${EXPECTED}.git;
#                                         set-but-empty disables the repair.
#   HYDRA_WATCHDOG_ORIGIN_FETCH_TIMEOUT_S Fetch timeout in seconds (default 60).
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-origin-identity.test.mts):
#   HYDRA_WATCHDOG_ORIGIN_URL             Inject the observed origin URL.
#   HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT  Inject 1/0 for origin/master resolving.
#   HYDRA_WATCHDOG_ORIGIN_STATE_DIR       Marker dir (default /tmp).
#   HYDRA_WATCHDOG_ORIGIN_NOTIFY_STREAM   Notification stream (default
#                                         hydra:notifications).

run_origin_identity() {
  local HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
  local EXPECTED="${HYDRA_WATCHDOG_EXPECTED_ORIGIN_REPO-gaberoo322/hydra}"  # unset-only default: an explicit empty value is honoured (repair then refuses to act)
  local STATE_DIR="${HYDRA_WATCHDOG_ORIGIN_STATE_DIR:-/tmp}"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_ORIGIN_NOTIFY_STREAM:-hydra:notifications}"
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  local SINCE_MARKER="${STATE_DIR}/hydra-origin-identity.since"
  local MTIME_MARKER="${STATE_DIR}/hydra-origin-identity.config-mtime"

  log() {
    echo "hydra-origin-identity-watchdog: $*"
  }

  # Output-returning call ("" on any failure) so the XADD result can gate the
  # dedup marker.
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # stderr is kept so the WARN names WHY (a strip-types boot error, a
    # transport error) instead of a bare rc; the first Error line wins, else
    # the last line.
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  mkdir -p "$STATE_DIR" 2>/dev/null || {
    log "WARN cannot create state dir ${STATE_DIR} — skipping origin identity check"
    return 0
  }

  # --- Forensic breadcrumb (read-only stat) ---
  local cfg="${HYDRA_ROOT}/.git/config"
  if [[ -f "$cfg" ]]; then
    local mt prev_mt iso
    mt="$(stat -c %Y "$cfg" 2>/dev/null || true)"
    if [[ "$mt" =~ ^[0-9]+$ ]]; then
      prev_mt="$(cat "$MTIME_MARKER" 2>/dev/null || true)"
      if [[ -n "$prev_mt" && "$prev_mt" != "$mt" ]]; then
        iso="$(date -u -d "@${mt}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$mt")"
        log "INFO .git/config changed at ${iso}"
      fi
      printf '%s' "$mt" > "$MTIME_MARKER" 2>/dev/null || true
    fi
  fi

  # --- Observed origin URL ---
  local url="" url_ok=1
  if [[ -n "${HYDRA_WATCHDOG_ORIGIN_URL+x}" ]]; then
    url="$HYDRA_WATCHDOG_ORIGIN_URL"
  elif [[ -e "${HYDRA_ROOT}/.git" ]]; then
    # `git config --get` exits 1 when the key is absent (a finding: no origin);
    # >1 is a tooling failure.
    local rc=0
    url="$(git -C "$HYDRA_ROOT" config --get remote.origin.url 2>/dev/null)" || rc=$?
    if (( rc > 1 )); then
      log "WARN git config read failed (rc=${rc}) — skipping origin identity check"
      return 0
    fi
  else
    log "WARN ${HYDRA_ROOT}/.git not found — skipping origin identity check"
    url_ok=0
  fi
  (( url_ok == 1 )) || return 0

  # --- origin/master resolves? (read-only rev-parse) ---
  local master_present
  if [[ -n "${HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT+x}" ]]; then
    master_present="$HYDRA_WATCHDOG_ORIGIN_MASTER_PRESENT"
  elif git -C "$HYDRA_ROOT" rev-parse --verify -q refs/remotes/origin/master >/dev/null 2>&1; then
    master_present=1
  else
    master_present=0
  fi

  # --- Normalise: strip scheme, user@, host, trailing .git and slashes ---
  # Userinfo (INV-8, QA round 4): for a scheme URL strip through the LAST `@`
  # of the whole remainder (greedy `.*@`), so a token containing `/` or `@`
  # never survives; an `@` in the path is over-stripped, which is fail-safe.
  # scp-style `user@host:path` has no scheme and keeps `^[^/]*@`.
  local strip_ui='s#^[A-Za-z][A-Za-z0-9+.-]*://.*@##; s#^[A-Za-z][A-Za-z0-9+.-]*://##; s#^[^/]*@##'
  origin_identity_norm() {
    printf '%s' "$1" | sed -E "${strip_ui}"'; s#^[^/:]+[:/]##; s#/+$##; s#\.git$##' | tr 'A-Z' 'a-z'
  }
  # Strip any userinfo (https://user:TOKEN@host/...) BEFORE a URL reaches a
  # log line, the notifications payload or the dashboard alert (#4939 QA).
  origin_identity_redact() {
    printf '%s' "${1:-<unset>}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://).*@#\1#'
  }

  # Free-text variant for multi-line git stderr: strips userinfo anywhere in
  # the line, greedy up to the last `@` of the whitespace/quote-free run (so a
  # token containing `/` never survives), same rule as the greedy URL redact.
  origin_identity_redact_text() {
    sed -E "s#([A-Za-z][A-Za-z0-9+.-]*://)[^[:space:]'\"]*@#\\1#g"
  }

  # --- Auto-repair configuration (#5065) ---
  local AUTOREPAIR="${HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR:-1}"
  local CANONICAL
  if [[ -n "${HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL+x}" ]]; then
    CANONICAL="$HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL"
  elif [[ -n "$EXPECTED" ]]; then
    CANONICAL="https://github.com/${EXPECTED}.git"
  else
    CANONICAL=""
  fi
  local FETCH_TIMEOUT="${HYDRA_WATCHDOG_ORIGIN_FETCH_TIMEOUT_S:-60}"
  [[ "$FETCH_TIMEOUT" =~ ^[0-9]+$ ]] || FETCH_TIMEOUT=60

  local norm want canon_norm=""
  norm="$(origin_identity_norm "$url")"
  want="$(printf '%s' "$EXPECTED" | tr 'A-Z' 'a-z')"
  # An operator-overridden canonical URL (e.g. a mirror) is by definition an
  # acceptable origin, so a repaired tree does not re-alarm on the next tick.
  if [[ -n "$CANONICAL" ]]; then
    canon_norm="$(origin_identity_norm "$CANONICAL")"
  fi
  # Host (issue #5026, INV-9): scheme + userinfo stripped, then `^[^/:]+` (so
  # an optional `:port` is dropped). An ssh Host alias from ~/.ssh/config (e.g.
  # `git@gh-alias:o/r`) reads as that alias and alarms wrong-origin-host —
  # set HYDRA_WATCHDOG_EXPECTED_ORIGIN_HOST to the alias if one is used.
  local host want_host
  host="$(printf '%s' "$url" | sed -E "${strip_ui}"'; s#^([^/:]+).*#\1#' | tr 'A-Z' 'a-z')"
  want_host="$(printf '%s' "${HYDRA_WATCHDOG_EXPECTED_ORIGIN_HOST:-github.com}" | tr 'A-Z' 'a-z')"

  local reasons=()
  # canon_norm must be non-empty to count as an acceptable identity: a
  # set-but-empty canonical URL with an unset origin URL would otherwise match
  # (both normalise to "") and mask wrong-origin-url (QA round 2).
  if [[ -z "$want" || ( "$norm" != "$want" && ( -z "$canon_norm" || "$norm" != "$canon_norm" ) ) ]]; then
    reasons+=("wrong-origin-url")
  fi
  # An operator-overridden canonical URL is by definition
  # acceptable, so an auto-repaired tree does not re-alarm on its host (#5065).
  if [[ "$host" != "$want_host" && ( -z "${HYDRA_WATCHDOG_CANONICAL_ORIGIN_URL:-}" || -z "$canon_norm" || "$norm" != "$canon_norm" ) ]]; then
    reasons+=("wrong-origin-host")
  fi
  if [[ "$master_present" != "1" ]]; then
    reasons+=("origin-master-missing")
  fi

  if (( ${#reasons[@]} == 0 )); then
    if [[ -f "$SINCE_MARKER" ]]; then
      log "origin identity healthy again (origin=${norm}, origin/master resolves) — dedup re-armed"
      deliver_page resolve --dedup-key "infra:origin_identity_wrong" --title "~/hydra origin identity healthy again"
    fi
    rm -f "$SINCE_MARKER" 2>/dev/null || true
    log "origin-identity tick processed (origin=${norm}, origin_master=present)"
    return 0
  fi

  local reason_str
  reason_str="$(IFS=+; echo "${reasons[*]}")"
  local shown_url
  shown_url="$(origin_identity_redact "$url")"

  # --- Auto-repair (#5065): only $HYDRA_ROOT, only remote.origin.*, only fetch ---
  # outcome: alarm (repair not attempted) | repaired | failed
  local outcome="alarm" repair_note="" fetch_result="skipped" new_url="$url"
  # Marker format: "<epoch-first-published> <outcome> <epoch-last-repair-attempt>".
  # After a failed repair, skip re-attempting (config rewrite + a <=60s fetch)
  # for a backoff window so a persistent failure does not refetch every tick.
  local BACKOFF="${HYDRA_WATCHDOG_ORIGIN_REPAIR_BACKOFF_S:-600}"
  [[ "$BACKOFF" =~ ^[0-9]+$ ]] || BACKOFF=600
  local prev_outcome="" prev_first="" prev_attempt="" now_epoch attempted=0
  now_epoch="$(date +%s 2>/dev/null || echo 0)"
  if [[ -f "$SINCE_MARKER" ]]; then
    read -r prev_first prev_outcome prev_attempt < "$SINCE_MARKER" || true
    [[ -n "$prev_outcome" ]] || prev_outcome="alarm"
  fi
  if [[ "$AUTOREPAIR" == "0" ]]; then
    repair_note="auto-repair disabled (HYDRA_WATCHDOG_ORIGIN_AUTOREPAIR=0)"
  elif [[ -z "$want" || -z "$CANONICAL" ]]; then
    repair_note="auto-repair skipped (expected repo or canonical URL is empty)"
  elif [[ ! -e "${HYDRA_ROOT}/.git" ]]; then
    repair_note="auto-repair skipped (no gitdir under ${HYDRA_ROOT})"
  elif [[ "$prev_outcome" == "failed" && "$prev_attempt" =~ ^[0-9]+$ ]] && (( now_epoch - prev_attempt < BACKOFF )); then
    outcome="failed"
    repair_note="auto-repair FAILED: backing off ${BACKOFF}s after a failed attempt"
  else
    attempted=1
    outcome="repaired"
    if [[ " ${reasons[*]} " == *" wrong-origin-url "* || " ${reasons[*]} " == *" wrong-origin-host "* ]]; then
      if git -C "$HYDRA_ROOT" config remote.origin.url "$CANONICAL" >/dev/null 2>&1; then
        new_url="$CANONICAL"
        # A remote that was removed outright has no fetch refspec, and a bare
        # `git fetch origin` would then never recreate refs/remotes/origin/*.
        if ! git -C "$HYDRA_ROOT" config --get-all remote.origin.fetch >/dev/null 2>&1; then
          git -C "$HYDRA_ROOT" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1 || {
            outcome="failed"; repair_note="could not set remote.origin.fetch"
          }
        fi
      else
        outcome="failed"; repair_note="could not rewrite remote.origin.url"
      fi
    fi
    if [[ "$outcome" == "repaired" ]]; then
      local frc=0 fetch_err=""
      if command -v timeout >/dev/null 2>&1; then
        fetch_err="$(GIT_TERMINAL_PROMPT=0 timeout -k 5 "$FETCH_TIMEOUT" git -C "$HYDRA_ROOT" fetch --quiet origin 2>&1)" || frc=$?
      else
        fetch_err="$(GIT_TERMINAL_PROMPT=0 git -C "$HYDRA_ROOT" fetch --quiet origin 2>&1)" || frc=$?
      fi
      if (( frc == 0 )); then
        fetch_result="ok"
      else
        fetch_result="failed-rc-${frc}"
        outcome="failed"
        repair_note="origin fetch failed (rc=${frc})"
        if (( frc == 124 )); then
          repair_note="origin fetch timed out after ${FETCH_TIMEOUT}s"
        fi
        if [[ -n "$fetch_err" ]]; then
          log "WARN fetch stderr: $(printf '%s\n' "$fetch_err" | head -n 3 | origin_identity_redact_text | tr '\n' ' ')"
        fi
      fi
    fi
    if [[ "$outcome" == "repaired" ]]; then
      # Re-verify against real git, never against the injected test hooks.
      local post_url post_norm
      post_url="$(git -C "$HYDRA_ROOT" config --get remote.origin.url 2>/dev/null || true)"
      post_norm="$(origin_identity_norm "$post_url")"
      if [[ "$post_norm" != "$want" && ( -z "$canon_norm" || "$post_norm" != "$canon_norm" ) ]]; then
        outcome="failed"; repair_note="origin URL still wrong after repair"
      elif ! git -C "$HYDRA_ROOT" rev-parse --verify -q refs/remotes/origin/master >/dev/null 2>&1; then
        outcome="failed"; repair_note="refs/remotes/origin/master still missing after fetch"
      else
        new_url="$post_url"
      fi
    fi
    if [[ "$outcome" == "failed" ]]; then
      repair_note="auto-repair FAILED: ${repair_note}"
    fi
  fi
  local shown_new
  shown_new="$(origin_identity_redact "$new_url")"

  if [[ "$outcome" == "repaired" ]]; then
    log "REPAIRED ~/hydra origin identity: ${reason_str} — remote.origin.url ${shown_url} -> ${shown_new}; fetch ${fetch_result}; refs/remotes/origin/master present (issue #5065 auto-repair; check the .git/config INFO breadcrumb for the writer)"
  else
    log "ALARM ~/hydra origin identity broken: ${reason_str} — remote.origin.url=${shown_url} (expected ${EXPECTED}); refs/remotes/origin/master $([[ "$master_present" == "1" ]] && echo present || echo MISSING); ${repair_note} (issues #4939/#5065; restore from an operator shell)"
  fi

  # Dedup: the since marker records the published outcome, so a persistent
  # failure publishes once, but an outcome change (alarm -> repaired, or a
  # repair that later fails) is a new event. Legacy markers (bare epoch) read
  # as outcome "alarm".
  if [[ "$prev_outcome" == "$outcome" && "$attempted" == "1" && "$outcome" == "failed" ]]; then
    # Same outcome, but a fresh repair attempt ran: stamp it for the backoff.
    printf '%s %s %s\n' "${prev_first:-$now_epoch}" "$outcome" "$now_epoch" > "$SINCE_MARKER" 2>/dev/null || true
  fi
  if [[ "$prev_outcome" != "$outcome" ]]; then
    local iso_now payload url_clean new_clean note_clean xadd_out repair_field
    iso_now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    url_clean="$(printf '%s' "$shown_url" | tr -dc 'a-zA-Z0-9_.:/@<>-')"
    new_clean="$(printf '%s' "$shown_new" | tr -dc 'a-zA-Z0-9_.:/@<>-')"
    note_clean="$(printf '%s' "$repair_note" | tr -dc 'a-zA-Z0-9_.:/@<>()=, -')"
    case "$outcome" in
      repaired) repair_field="repaired" ;;
      failed) repair_field="failed" ;;
      *) repair_field="not-attempted" ;;
    esac
    payload="$(printf '{"signal":"origin-identity","reason":"%s","url":"%s","repair":"%s","newUrl":"%s","fetch":"%s","note":"%s"}' \
      "$reason_str" "$url_clean" "$repair_field" "$new_clean" "$fetch_result" "$note_clean")"
    # The since-marker is written ONLY after the XADD succeeds (a stream id
    # comes back), so a Redis blip on the first tick retries next tick instead
    # of suppressing the alert for the whole episode.
    xadd_out="$(rc_read XADD "$NOTIFY_STREAM" '*' \
      id "origin-identity-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "infra:origin_identity_wrong" \
      source "watchdog-origin-identity" \
      timestamp "$iso_now" \
      correlationId "origin-identity" \
      payload "$payload")"
    # Only a stream id proves the entry landed: `redis-cli --raw` prints an
    # error reply (ERR …, WRONGTYPE …, NOAUTH …) on stdout with exit 0, so a
    # bare non-empty test would write the marker and silence the episode (#5140).
    if [[ "$xadd_out" =~ ^[0-9]+-[0-9]+$ ]]; then
      printf '%s %s %s\n' "$now_epoch" "$outcome" "$now_epoch" > "$SINCE_MARKER" 2>/dev/null || true
      log "in-band delivery published type=infra:origin_identity_wrong repair=${repair_field} -> ${NOTIFY_STREAM}"
    else
      local reply_snip
      reply_snip="$(printf '%s' "$xadd_out" | tr '\n' ' ' | cut -c1-160)"
      log "WARN in-band delivery FAILED (XADD reply '${reply_snip}' is not a stream id) — will retry next tick"
    fi
    # Operator Channel (#5046): a self-healed identity needs no operator
    # action (#5065 QA round 2 — the consumer briefs it), so `repaired` is
    # this block's recovery edge; alarm / failed page with dedupKey == kind.
    if [[ "$outcome" == "repaired" ]]; then
      deliver_page resolve --dedup-key "infra:origin_identity_wrong" --title "~/hydra origin identity repaired: ${reason_str}"
    else
      deliver_page page --kind "infra:origin_identity_wrong" --dedup-key "infra:origin_identity_wrong" \
        --title "~/hydra origin identity broken: ${reason_str}" \
        --fact "reason=${reason_str}" --fact "url=${url_clean}" --fact "repair=${repair_field}" --fact "note=${note_clean}"
    fi
  fi
  return 0
}


# =============================================================================
# Entry point — run all blocks on every tick ONLY when the script is executed
# directly, not when it is sourced. test/autopilot-watchdog.test.mts sources
# this file to exercise run_watchdog_cli in isolation; the guard keeps that
# sourcing side-effect-free. Each block is independent and self-contained;
# a short-circuit in one MUST NOT skip the others.
# =============================================================================
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_liveness_cli
  run_wedge_cli
  run_deploy_drift
  run_redis_backup_freshness
  run_skill_mirror_drift
  run_claude_hooks
  run_launch_flow
  run_node_modules_integrity
  run_brief_missing
  run_origin_identity
  exit 0
fi
