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
#   The admission POLICY (already-running, pause, session-block, emergency /
#   weekly stops, extra-usage, meter, pace-ahead, five-hour headroom,
#   post-quota cooldown, workless backoff) is owned by src/cost/admission.ts
#   decideAdmission (#5101) and served as the `.admission` object of
#   GET /api/usage/eligibility. This script is TRANSPORT + EXEC only (#5102):
#
#   1. Compute the launcher-host facts: serviceActive (systemd unit active,
#      timer mode only) and pidAlive (state.json owning PID alive), and send
#      them with `mode=timer|exec` as query parameters.
#   2. Read `.admission`: admit=false -> record the typed reason verbatim and
#      exit 0; admit=true -> launch (`systemctl --user start` in timer mode).
#   3. Endpoint unreachable / unparseable / malformed -> FAIL SAFE: do NOT
#      launch. Pacing is the governor; when we're blind to usage we must not
#      burn quota. The only reason literals left in bash are these fail-safes
#      (curl-missing, jq-missing, eligibility-unreachable,
#      eligibility-unparseable, allow-invalid) and token-refresh-nudge (#4843,
#      moves into the verdict in #5103).
#
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
#   - The `systemctl is-active` self-check is skipped (the unit IS active:
#     it's us) and serviceActive=0 is sent. The state.json live-PID fact
#     stays, guarding against stacking a unit run on a hand-launched session.
#   - The eligibility consult runs identically (mode=exec; serviceActive=0). A blocked or fail-safe outcome exits
#     0 — a CLEAN exit, so Restart=on-failure disarms instead of storming,
#     and no start slot is burned. The ~15-min timer resumes admission once
#     the block passes.
#   - Step 4, when eligible, `exec`s the claude CLI (same invocation the
#     unit used to run directly), replacing this shell so systemd keeps
#     tracking the session as the main process.
#
# Model fallback while Fable is out of weekly usage (issue #4585)
# ------------------------------------------------------------------
# Fable is the only model whose weekly allowance runs out BEFORE the
# account-wide limit; the CLI then exits 1 with "You're out of usage
# credits. Switch to another model...". The #4583 reap parses that line and
# POSTs it to /api/usage/session-block, which arms the MODEL-SCOPED
# exhaustion flag — never `.allow`, never `sessionBlockedUntil` (a REDIRECT,
# not a stop) — surfaced as `.reasons.fableExhaustedUntil`. While that
# instant is FUTURE, this gate's exec branch launches the parent session on
# the FALLBACK model (default opus) instead of the PRIMARY (default fable);
# when the flag expires (TTL = min(now+60min, next Weekly Reset Anchor
# boundary)) the next tick launches on the primary again — a post-expiry
# re-probe is ~free (0-token 429 in <0.5s), so under-blocking costs almost
# nothing. INV-1: the out-of-credits 429 is NOT handled by the CLI's own
# `--fallback-model` (empirically falsified on CLI 2.1.280) — the gate
# launches with an explicit `--model`; `--fallback-model` rides along
# belt-and-braces for overload/model-access errors only. Every switch logs a
# `model-fallback:` transition line vs the previous tick's recorded model,
# and `record_tick` stores the model so later readers can join on it.
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
#   HYDRA_PACE_GATE_NUDGE_CMD / HYDRA_PACE_GATE_NUDGE_STAMP (issue #4843)
#       Meter-unavailable arm only: the token-refresh nudge command (default
#       `timeout 60 claude -p --model haiku 'reply ok'`, word-split; bounded
#       to 60s so the synchronous nudge stays well inside a tick) and the
#       rate-limit stamp file (default under the user-owned
#       ${XDG_STATE_HOME:-$HOME/.local/state}/hydra/, never a shared /tmp).
#       The nudge reads only `claudeAiOauth.expiresAt` from
#       ${HYDRA_CLAUDE_CREDENTIALS_PATH:-$HOME/.claude/.credentials.json} and
#       never echoes a token; its stdout/stderr go to /dev/null.
#   HYDRA_PACE_GATE_ELIGIBILITY_URL
#       Override the eligibility endpoint URL (default
#       http://localhost:4000/api/usage/eligibility) so the test can point
#       at a local fixture server.
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT
#       Same contract as scripts/autopilot/hooks/on-subagent-stop.sh:
#       HYDRA_REDIS_HOST defaults to "docker" (shell into hydra-redis-1 via
#       `docker exec`); any other value calls `redis-cli -h $HOST -p $PORT`
#       directly, letting the test inject an unreachable host to verify the
#       best-effort record write never blocks a launch.
#   HYDRA_AUTOPILOT_PRIMARY_MODEL / HYDRA_AUTOPILOT_FALLBACK_MODEL
#       Override the launch-model pair (defaults fable / opus) so tests can
#       pin the exec command line's --model spelling without depending on
#       the real model aliases (#4585).
#   HYDRA_REDIS_DB
#       Selects the logical Redis DB index `record_tick()`'s HSET targets, via
#       `-n <db>` on both the docker-exec and direct redis-cli branches
#       (issue #4210, mirroring #4183's fix for scripts/hydra-watchdog.sh).
#       Defaults to "0" (production) when absent OR non-numeric, so an unset
#       or malformed value is byte-identical to today's hardcoded-db-0
#       behaviour. `scripts/test/redis-db-launch.mjs` is the intended setter
#       for a test run's child env; a bare invocation (a human, a systemd
#       timer) always lands on db 0 exactly as before.
#
# Per-tick durable record (issue #3845, epic #3844)
# --------------------------------------------------
# Every tick — timer or exec mode, launch or skip — writes a best-effort
# snapshot of its own outcome to `hydra:autopilot:pace-gate:last-tick`
# (HSET reason/class/at/latency_ms; owned in TypeScript by
# src/redis/launch-flow.ts, cross-checked against the literal below by
# test/launch-flow-key-contract.test.mts). This is a DURABLE record — no
# TTL, always reflecting the most recent tick — that a later reader
# (a chore, a dashboard) can join against instead of tailing the journal.
# See `record_tick()` below for why this write, uniquely among every other
# dependency in this file, is allowed to fail silently.
#
# Source of truth: this file in the repo at scripts/autopilot/pace-gate.sh.
# Deployed to ~/.local/bin/ by scripts/deploy.sh.

set -euo pipefail

SERVICE="hydra-autopilot.service"
STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
ELIGIBILITY_URL="${HYDRA_PACE_GATE_ELIGIBILITY_URL:-http://localhost:4000/api/usage/eligibility}"
REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
# Non-numeric or absent HYDRA_REDIS_DB falls back to db 0 (production) — same
# validation shape as #4183's watchdog fix. `[[ =~ ]]` against an unset var
# under `set -u` is safe (bash treats the RHS as a pattern, not an expansion).
REDIS_DB="${HYDRA_REDIS_DB:-0}"
[[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
# Single source of truth for this literal is cross-checked against the
# exported PACE_GATE_LAST_TICK_KEY constant in src/redis/launch-flow.ts by
# test/launch-flow-key-contract.test.mts — keep the two in lockstep.
LAST_TICK_KEY="hydra:autopilot:pace-gate:last-tick"
# Issue #4585: the launch-model pair. PRIMARY is what the parent session
# normally runs on; FALLBACK is what the exec branch switches to while the
# model-scoped exhaustion flag (.reasons.fableExhaustedUntil) is future.
# Env-overridable so tests can pin the --model spelling.
PRIMARY_MODEL="${HYDRA_AUTOPILOT_PRIMARY_MODEL:-fable}"
FALLBACK_MODEL="${HYDRA_AUTOPILOT_FALLBACK_MODEL:-opus}"

# Mode: "timer" (default — the ~15-min admission timer; launches the unit) or
# "exec" (--exec-autopilot — the unit's ExecStart wrapper; execs the CLI).
MODE="timer"
if [[ "${1:-}" == "--exec-autopilot" ]]; then
  MODE="exec"
fi

log() {
  echo "hydra-pace-gate: $*"
}

# record_tick REASON CLASS [LATENCY_MS] [MODEL] — best-effort durable per-tick
# record (issue #3845; MODEL field added by #4585). Writes
# hydra:autopilot:pace-gate:last-tick via the SAME docker-exec redis-cli
# pattern scripts/autopilot/hooks/on-subagent-stop.sh uses (HYDRA_REDIS_HOST
# defaulting to "docker"; any other value calls `redis-cli -h $HOST -p $PORT`).
# MODEL (exec-mode launch ticks pass the model the session actually launched
# on) is only written when non-empty, so pre-#4585 readers that HGET the fixed
# field set see an identical shape on skip ticks.
#
# WHY THIS IS THE ONE DEPENDENCY IN THIS FILE ALLOWED TO FAIL SILENTLY:
# every other check above and below (curl, jq, the eligibility HTTP call,
# a parseable response) intentionally fails SAFE by skipping the launch —
# because the launcher is the ONE thing standing between the operator and
# burning quota while blind to usage. This record write is the opposite
# shape of risk: it is pure OBSERVABILITY, downstream of a verdict that has
# ALREADY been decided by the time this function runs. If docker/Redis is
# down, the correct behavior is "launch (or skip) exactly as if this
# function didn't exist" — NOT "fail safe by skipping the launch", which
# would let a Redis hiccup silently stop autopilot dispatch. Hence `|| true`
# on the call site below: a write failure is swallowed (not even logged to
# stdout, to keep the common-path log quiet — mirrors on-subagent-stop.sh's
# own best-effort stance) and the caller's exit code is never touched.
# DO NOT "fix" this by making it fail-safe like its neighbours.
record_tick() {
  local reason="$1" class="$2" latency_ms="${3:-}" model="${4:-}"
  local now_ms
  now_ms="$(date +%s%3N 2>/dev/null || echo "")"
  [[ -n "$now_ms" ]] || return 0
  # `model` joins the HSET only when non-empty (plain `if`, never `&&` —
  # under `set -e` a falsy `&&` chain would read as a failure). See the
  # signature comment above.
  local -a tick_fields=(
    HSET "$LAST_TICK_KEY"
    reason "$reason"
    class "$class"
    at "$now_ms"
    latency_ms "$latency_ms"
  )
  if [[ -n "$model" ]]; then
    tick_fields+=(model "$model")
  fi
  # `|| true` on BOTH branches (belt-and-braces alongside the `|| true` every
  # call site appends): this is the deliberate INVERSE of every other
  # dependency check in this file — see the block comment above. A
  # docker/Redis failure here must NEVER propagate as a non-zero return,
  # which under `set -euo pipefail` would otherwise abort the tick.
  if [[ "$REDIS_HOST" == "docker" ]]; then
    docker exec hydra-redis-1 redis-cli \
      -n "$REDIS_DB" \
      "${tick_fields[@]}" >/dev/null 2>&1 || true
  else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
      -n "$REDIS_DB" \
      "${tick_fields[@]}" >/dev/null 2>&1 || true
  fi
  return 0
}

# read_last_tick_model — best-effort HGET of the previous tick's model field
# (#4585 INV-7). Same docker/direct duality and same best-effort stance as
# record_tick: any failure (Redis down, no model field yet — pre-#4585 ticks
# wrote none) reads as "". Used ONLY to decide whether the transition log
# line below fires; it never gates the launch.
read_last_tick_model() {
  local model=""
  if [[ "$REDIS_HOST" == "docker" ]]; then
    model="$(docker exec hydra-redis-1 redis-cli \
      -n "$REDIS_DB" \
      HGET "$LAST_TICK_KEY" model 2>/dev/null || echo "")"
  else
    model="$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
      -n "$REDIS_DB" \
      HGET "$LAST_TICK_KEY" model 2>/dev/null || echo "")"
  fi
  printf '%s' "$model"
  return 0
}

if [[ "$MODE" == "exec" ]]; then
  log "exec-autopilot mode (unit ExecStart wrapper, issue #1089)"
fi

# --- Step 1: gather the launcher-host FACTS the verdict needs (#5102) ---
#
# Whether an Autopilot Run is already live is an INPUT to the admission verdict
# (src/cost/admission.ts decideAdmission), not an arm decided here. Two
# independent signals: (a) the systemd unit is active, (b) state.json carries a
# live owning PID. In exec mode the unit is BY DEFINITION active — it's us — so
# the is-active self-check is skipped and 0 is sent (systemd guarantees
# single-instance per unit; the PID fact still guards against stacking onto a
# hand-launched session).
SERVICE_ACTIVE=0
if [[ "$MODE" != "exec" && "${HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE:-0}" != "1" ]] \
  && systemctl --user is-active --quiet "$SERVICE"; then
  SERVICE_ACTIVE=1
fi

PID_ALIVE=0
if [[ -f "$STATE_PATH" ]] && command -v python3 >/dev/null 2>&1; then
  # Lenient prior-run read (run_ledger --prior, #5075): a corrupt or older-schema
  # document degrades to pid 0 and can never block the pace gate.
  PID=$(python3 "$(dirname "${BASH_SOURCE[0]}")/run_ledger.py" get "$STATE_PATH" pid --prior --default 0 2>/dev/null || echo "0")
  if [[ -n "$PID" && "$PID" != "0" && "$PID" != "null" ]] && kill -0 "$PID" 2>/dev/null; then
    PID_ALIVE=1
  fi
fi

# --- Step 2: fetch the admission verdict from /api/usage/eligibility ---
#
# Fail safe: if the endpoint is unreachable we must NOT launch — pacing is
# the governor and we will not burn quota while blind to usage.
if ! command -v curl >/dev/null 2>&1; then
  log "WARN curl not found; cannot consult eligibility — failing safe (not launching)"
  record_tick "curl-missing" "fail-safe" || true
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  log "WARN jq not found; cannot parse eligibility — failing safe (not launching)"
  record_tick "jq-missing" "fail-safe" || true
  exit 0
fi

# Issue #3845: capture the probe's round-trip time as latency_ms WITHOUT any
# extra HTTP request. `-w '%{time_total}'` writes ONLY the timing metric to
# stdout (captured below); `-o "$CURL_BODY_FILE"` routes the JSON body to a
# temp file instead of stdout, so the two never collide in one $(...)
# capture. LATENCY_MS stays empty for every exit above this line (the tick
# never reached the probe) and every exit below it if the probe itself
# fails (no completed round-trip to time).
LATENCY_MS=""
CURL_BODY_FILE="$(mktemp)"
ELIGIBILITY_JSON=""
# #5102: the facts ride to the verdict as query parameters (validated by
# EligibilityQuerySchema in src/schemas/usage.ts).
SEP="?"
if [[ "$ELIGIBILITY_URL" == *"?"* ]]; then
  SEP="&"
fi
PROBE_URL="${ELIGIBILITY_URL}${SEP}mode=${MODE}&serviceActive=${SERVICE_ACTIVE}&pidAlive=${PID_ALIVE}"
if ! PROBE_TIME_TOTAL=$(curl -fsS --max-time 10 -w '%{time_total}' -o "$CURL_BODY_FILE" "$PROBE_URL" 2>/dev/null); then
  rm -f "$CURL_BODY_FILE"
  log "WARN eligibility endpoint unreachable ($ELIGIBILITY_URL) — failing safe (not launching)"
  record_tick "eligibility-unreachable" "fail-safe" || true
  exit 0
fi
ELIGIBILITY_JSON="$(cat "$CURL_BODY_FILE" 2>/dev/null || echo "")"
rm -f "$CURL_BODY_FILE"
# %{time_total} is seconds with fractional precision (e.g. "0.045123");
# awk converts to an integer millisecond count. A malformed metric (should
# never happen — curl always emits it on a completed request) leaves
# LATENCY_MS empty rather than recording garbage.
LATENCY_MS="$(awk -v t="$PROBE_TIME_TOTAL" 'BEGIN { printf "%d", (t + 0) * 1000 }' 2>/dev/null || echo "")"

# The route serves ONE admission object (src/cost/admission.ts decideAdmission):
# {admit, reason, class, note?}. This script holds no admission policy — it
# records the verdict's typed reason verbatim and launches or exits 0.
if ! ADMISSION_JSON=$(jq -c '.admission' <<<"$ELIGIBILITY_JSON" 2>/dev/null); then
  log "WARN eligibility response unparseable — failing safe (not launching)"
  record_tick "eligibility-unparseable" "fail-safe" "$LATENCY_MS" || true
  exit 0
fi

# A missing or malformed admission object is treated as invalid: the route
# serves it since #5101 and shares a host with this gate, so there is no
# version-skew window.
if ! jq -e 'type == "object" and (.admit | type == "boolean") and (.reason | type == "string" and length > 0) and (.class | type == "string" and length > 0)' \
  <<<"$ADMISSION_JSON" >/dev/null 2>&1; then
  log "WARN eligibility .admission missing or malformed — failing safe (not launching)"
  record_tick "allow-invalid" "fail-safe" "$LATENCY_MS" || true
  exit 0
fi

ADMISSION_ADMIT=$(jq -r '.admit' <<<"$ADMISSION_JSON")
ADMISSION_REASON=$(jq -r '.reason' <<<"$ADMISSION_JSON")
ADMISSION_CLASS=$(jq -r '.class' <<<"$ADMISSION_JSON")
ADMISSION_NOTE=$(jq -r '.note // ""' <<<"$ADMISSION_JSON")

# --- Step 3: skip on admit=false (pass-through; no policy here) ---
if [[ "$ADMISSION_ADMIT" != "true" ]]; then
  REASONS_JSON=$(jq -c '.reasons // {}' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "{}")
  log "skip reason=$ADMISSION_REASON class=$ADMISSION_CLASS (reasons: $REASONS_JSON)"
  # Issue #3845 (epic #3844): a meter-dark tick records the verdict's own
  # `meter-unavailable` reason. The #4843 nudge below stays in bash until #5103.
  if [[ "$ADMISSION_REASON" == "meter-unavailable" ]]; then
    log "usage meter unavailable (reasons.meterUnavailable) — skip (brake cannot see; #3845)"
  # Issue #4843: an idle stretch longer than the OAuth token lifetime deadlocks
  # here (expired token -> meter blind -> no launch -> nothing rotates the
  # token). When the token has expired / expires within 10 min, run ONE minimal
  # Claude Code call (rate-limited by a stamp file) so the CLI rotates its own
  # token; this tick still skips. Hydra never writes the credentials file or
  # calls the refresh endpoint, and never reads/logs the tokens themselves.
  NUDGE_CREDS="${HYDRA_CLAUDE_CREDENTIALS_PATH:-$HOME/.claude/.credentials.json}"
  NUDGE_STAMP="${HYDRA_PACE_GATE_NUDGE_STAMP:-${XDG_STATE_HOME:-$HOME/.local/state}/hydra/pace-gate-token-nudge.stamp}"
  mkdir -p "$(dirname "$NUDGE_STAMP")" 2>/dev/null || true
  NUDGE_EXPIRES_MS=$(jq -r '.claudeAiOauth.expiresAt // empty' "$NUDGE_CREDS" 2>/dev/null || true)
  if [[ "$NUDGE_EXPIRES_MS" =~ ^[0-9]+$ ]]; then
    NUDGE_NOW_MS=$(( $(date +%s) * 1000 ))
    if (( NUDGE_EXPIRES_MS <= NUDGE_NOW_MS + 600000 )); then
      NUDGE_LAST=$(cat "$NUDGE_STAMP" 2>/dev/null || true)
      NUDGE_AGE=-1
      if [[ "$NUDGE_LAST" =~ ^[0-9]+$ ]]; then
        NUDGE_AGE=$(( $(date +%s) - NUDGE_LAST ))
      fi
      if (( NUDGE_AGE < 0 || NUDGE_AGE >= 1800 )); then
        # Stamp BEFORE the nudge so a hung/failed nudge still counts (no retry storm).
        # If the stamp cannot be written the 30-minute limit is lost — skip the nudge.
        if ! date +%s >"$NUDGE_STAMP" 2>/dev/null; then
          log "WARN: could not write nudge stamp $NUDGE_STAMP — skipping nudge (rate limit unenforceable)"
          record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS" "$LATENCY_MS" || true
          exit 0
        fi
        NUDGE_RC=0
        if [[ -n "${HYDRA_PACE_GATE_NUDGE_CMD:-}" ]]; then
          # shellcheck disable=SC2086
          $HYDRA_PACE_GATE_NUDGE_CMD >/dev/null 2>&1 || NUDGE_RC=$?
        else
          timeout 60 claude -p --model haiku 'reply ok' >/dev/null 2>&1 || NUDGE_RC=$?
        fi
        log "token-refresh nudge ran (expiresAt=${NUDGE_EXPIRES_MS}ms, rc=${NUDGE_RC}, prior stamp age=${NUDGE_AGE}s; #4843) — skip this tick"
        record_tick "token-refresh-nudge" "fail-safe" "$LATENCY_MS" || true
        exit 0
      fi
      log "token expiring (expiresAt=${NUDGE_EXPIRES_MS}ms) but nudge ran ${NUDGE_AGE}s ago (<1800s) — no nudge"
    fi
  else
    log "credentials expiresAt unreadable/non-numeric — no token-refresh nudge"
  fi
  fi
  record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS" "$LATENCY_MS" || true
  exit 0
fi

# Issue #4560: paid overage armed but NOT blocking — the verdict admitted the
# launch and carries the informational note. The hard-stops are the brake.
if [[ "$ADMISSION_NOTE" == "extra-usage-armed-not-blocking" ]]; then
  log "extra usage (paid overage) ARMED on the logged-in account but HYDRA_EXTRA_USAGE_POLICY=allow — proceeding; the 5h/weekly hard-stops are the brake (issue #4560)"
fi

# --- Step 4: admitted — launch/exec ---

if [[ "$MODE" == "exec" ]]; then
  log "eligible (reason=$ADMISSION_REASON) — exec'ing autopilot session"

  # Issue #2955 — stamp the launch mechanism for the run-start trigger field.
  # Every systemd-mediated start (pace-gate timer AND Restart= relaunch) routes
  # through this exec branch (issue #1089), so exporting here makes
  # bootstrap.sh's run-start POST report trigger=pace-gate instead of the
  # retired hour-of-day heuristic values. exec preserves the environment, so
  # the claude CLI (and its Bash-tool children, where bootstrap.sh runs)
  # inherit it. Ineligible exits (Steps 1-3) never reach this export.
  export HYDRA_AUTOPILOT_TRIGGER="pace-gate"

  # Issue #4585: pick the launch model. While the model-scoped exhaustion
  # flag (.reasons.fableExhaustedUntil) is FUTURE, launch on FALLBACK (opus);
  # absent, stale/past, or unparseable launches on PRIMARY (fable) —
  # fail-safe to the primary so a corrupt flag can never wedge the loop on
  # the fallback.
  FABLE_EXHAUSTED_UNTIL=$(jq -r '.reasons.fableExhaustedUntil // ""' <<<"$ELIGIBILITY_JSON" 2>/dev/null || echo "")
  LAUNCH_MODEL="$PRIMARY_MODEL"
  MODEL_FALLBACK_REASON=""
  if [[ -n "$FABLE_EXHAUSTED_UNTIL" ]]; then
    # moves into the verdict in #5103
    FABLE_EPOCH=$(date -d "$FABLE_EXHAUSTED_UNTIL" +%s 2>/dev/null || echo "")
    NOW_EPOCH=$(date -u +%s)
    if [[ -n "$FABLE_EPOCH" && "$FABLE_EPOCH" -gt "$NOW_EPOCH" ]]; then
      LAUNCH_MODEL="$FALLBACK_MODEL"
      MODEL_FALLBACK_REASON="out-of-credits"
    fi
  fi
  # INV-1 (#4585): the out-of-credits 429 is NOT handled by the CLI's own
  # --fallback-model (empirically falsified on CLI 2.1.280) — the gate
  # launches with an explicit --model. --fallback-model rides along
  # belt-and-braces for overload/model-access errors only, and only when it
  # differs from the launch model (identical values have no defined CLI
  # behaviour).
  EXEC_ARGS=(--dangerously-skip-permissions --model "$LAUNCH_MODEL")
  if [[ "$FALLBACK_MODEL" != "$LAUNCH_MODEL" ]]; then
    EXEC_ARGS+=(--fallback-model "$FALLBACK_MODEL")
  fi
  EXEC_ARGS+=(-p "/hydra-autopilot")

  # INV-7 (#4585): every model switch is visible. Compare against the
  # previous tick's recorded model (best-effort read; "" => none recorded —
  # first tick, Redis down, or a pre-#4585 tick) and log the transition so
  # the journal names both directions: fable->opus when the flag is live,
  # opus->fable when it expired. Read BEFORE record_tick below overwrites
  # the field. Never gates the launch.
  PREV_MODEL="$(read_last_tick_model)"
  if [[ "$LAUNCH_MODEL" != "$PRIMARY_MODEL" && "$PREV_MODEL" != "$LAUNCH_MODEL" ]]; then
    log "model-fallback: ${PRIMARY_MODEL}->${LAUNCH_MODEL} reason=${MODEL_FALLBACK_REASON} (#4585)"
  elif [[ "$LAUNCH_MODEL" == "$PRIMARY_MODEL" && -n "$PREV_MODEL" && "$PREV_MODEL" != "$PRIMARY_MODEL" ]]; then
    log "model-fallback: ${PREV_MODEL}->${LAUNCH_MODEL} reason=flag-expired (#4585)"
  fi

  if [[ "${HYDRA_PACE_GATE_DRY_RUN:-0}" == "1" ]]; then
    log "would-exec autopilot session: claude ${EXEC_ARGS[*]} (DRY_RUN=1, test mode)"
    record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS" "$LATENCY_MS" "$LAUNCH_MODEL" || true
    exit 0
  fi

  # Issue #3845: record BEFORE exec — exec replaces this shell's process
  # image, so any statement after either exec call below would never run.
  # The tick carries the launch model (#4585) so the next tick's transition
  # log and any dashboard join can see it.
  record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS" "$LATENCY_MS" "$LAUNCH_MODEL" || true

  if [[ -n "${HYDRA_PACE_GATE_EXEC_CMD:-}" ]]; then
    # Test-only hook: intentional word-split so the test can pass a full
    # command line (e.g. "echo exec-marker"). Deliberately NOT extended with
    # the model flags — its contract (exit codes of an arbitrary command
    # line) predates #4585 and is pinned by tests; the dry-run line above is
    # the model-flag pin (#4585 INV-8).
    # shellcheck disable=SC2086
    exec ${HYDRA_PACE_GATE_EXEC_CMD}
  fi

  # Same invocation hydra-autopilot.service's ExecStart used to run directly
  # (--dangerously-skip-permissions rationale lives in the unit file), plus
  # the #4585 model flags. exec replaces this shell, so systemd tracks the
  # CLI as the main process and RuntimeMaxSec / SIGTERM semantics are
  # unchanged.
  exec claude "${EXEC_ARGS[@]}"
fi

log "eligible (reason=$ADMISSION_REASON) — launching $SERVICE"

if [[ "${HYDRA_PACE_GATE_DRY_RUN:-0}" == "1" ]]; then
  log "would-start $SERVICE (DRY_RUN=1, test mode)"
  record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS" "$LATENCY_MS" || true
  exit 0
fi

systemctl --user start "$SERVICE"
log "launched $SERVICE"
record_tick "$ADMISSION_REASON" "$ADMISSION_CLASS" "$LATENCY_MS" || true

exit 0
