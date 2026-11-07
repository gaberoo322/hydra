#!/usr/bin/env bash
#
# hydra-watchdog.sh — the watchdog TIMER ENTRY (issue #705; collapsed by #5099, epic #5094)
#
# Modification Tier T3 (demoted infra, ADR-0015); not Verifier Core (src/untouchable.ts).
# Source of truth: this file in the repo. Deployed by scripts/deploy.sh to
# ~/.local/bin/hydra-watchdog.sh and run every 2 minutes by hydra-watchdog.timer.
#
# Every decision block lives in TypeScript (scripts/hydra-watchdog.ts over
# src/watchdog/); this file only (1) asks the CLI for its check table (`plan`)
# and runs each check as its own timeout-bounded process, (2) raises the
# "CLI failed to start" alarm when it cannot, and (3) keeps the one check that
# must NOT depend on the CLI: the node_modules-integrity block. What each check
# asserts, its thresholds, delivery, dedup state and env hooks:
# docs/operations/watchdog.md. The script always exits 0.

set -euo pipefail

NM_LOG="hydra-node-modules-integrity-watchdog:"
CLI_LOG="hydra-watchdog-cli:"

log() { local prefix="$1"; shift; echo "$prefix $*"; }

# Resolve a node binary WITHOUT relying on the caller's PATH (the systemd user
# unit sets none, and Node is nvm-pinned): HYDRA_WATCHDOG_NODE, PATH, then the
# newest nvm-installed node under $HOME. Prints the path; rc 1 if none.
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
# One CLI subcommand as its own process. The CLI exits 0 itself; a missing node
# or a non-zero exit (timeout) is ONE WARN line, never an aborted tick, and does
# NOT raise the CLI-start alarm (a single check timing out is routine).
run_watchdog_cli() {
  local sub="$1" prefix="$2" timeout_s="$3" node_bin rc=0
  if ! node_bin="$(resolve_watchdog_node)"; then
    echo "$prefix WARN node not found (PATH, HYDRA_WATCHDOG_NODE, ~/.nvm) — $sub check skipped this tick"
    return 0
  fi
  timeout "$timeout_s" "$node_bin" --experimental-strip-types "${HYDRA_ROOT:-$HOME/hydra}/scripts/hydra-watchdog.ts" "$sub" </dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "$prefix WARN $sub CLI FAILED (rc=$rc) — $sub check skipped this tick"
  fi
  return 0
}

# redis-cli helpers (the ONLY copy). rc_read prints the reply ("" on any
# failure); rc_write is fire-and-forget. HYDRA_REDIS_DB is numeric or 0.
rc_read() {
  local host="${HYDRA_REDIS_HOST:-docker}" db="${HYDRA_REDIS_DB:-0}"
  [[ "$db" =~ ^[0-9]+$ ]] || db=0
  if [[ "$host" == "docker" ]]; then
    timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$db" "$@" 2>/dev/null || true
  else
    timeout 5 redis-cli --raw -h "$host" -p "${HYDRA_REDIS_PORT:-6379}" -n "$db" "$@" 2>/dev/null || true
  fi
}
rc_write() { rc_read "$@" >/dev/null; }

# deliver_page LOG-PREFIX SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045
# D2), the ONLY Telegram sender; it imports src/operator-channel/ directly so it
# works with the orchestrator down. HYDRA_WATCHDOG_OPERATOR_NOTIFY overrides the
# binary (tests: an argv-recording stub). Returns 0 only when the CLI exited 0;
# callers treat failure as best-effort (`|| true`) unless they gate state on it.
deliver_page() {
  local prefix="$1"; shift
  local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-}" node_bin
  if [ -z "$notify_bin" ]; then
    # The unit PATH carries no nvm node: use the SAME resolved binary as the
    # checks (bare `node` only if nothing resolves), else the page rc=127s.
    node_bin="$(resolve_watchdog_node)" || node_bin=node
    notify_bin="$node_bin --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts"
  fi
  local out err_file rc=0
  err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
  # shellcheck disable=SC2086  # word-splitting binary+flags is intended
  out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    log "$prefix" "operator-notify $1 ok for '${3:-}' (${out:-no output})"
  else
    log "$prefix" "WARN operator-notify $1 FAILED (rc=$rc) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
  fi
  rm -f "$err_file" 2>/dev/null || true
  return "$rc"
}

# =============================================================================
# ## CLI-START ALARM (issue #5099)
# =============================================================================
# Fires when node is unresolvable or `plan` fails: `plan` loads the same module
# graph as every check, so a failure means ALL of them are disarmed. One
# `infra:watchdog_cli_failed` page, deduped by a FILE marker written only when
# the CLI exited 0 (HYDRA_WATCHDOG_CLI_ALARM_STATE_DIR, default /tmp); cleared
# (with a resolve) on the next tick whose plan succeeds. Redis-free on purpose.
# Limit (docs/operations/watchdog.md): with node or node_modules broken,
# operator-notify cannot boot either, so this degrades to the journal WARN.
cli_alarm_raise() {
  local reason="$1" rc="$2"
  local marker="${HYDRA_WATCHDOG_CLI_ALARM_STATE_DIR:-/tmp}/hydra-watchdog-cli-failed.since"
  log "$CLI_LOG" "WARN watchdog CLI failed to start (reason=$reason, rc=$rc) — every ported check is skipped this tick"
  [ -f "$marker" ] && return 0
  if deliver_page "$CLI_LOG" report --kind "infra:watchdog_cli_failed" \
      --fact "reason=$reason" --fact "rc=$rc"; then
    date +%s > "$marker" 2>/dev/null || true
  fi
  return 0
}
cli_alarm_clear() {
  local marker="${HYDRA_WATCHDOG_CLI_ALARM_STATE_DIR:-/tmp}/hydra-watchdog-cli-failed.since"
  [ -f "$marker" ] || return 0
  if deliver_page "$CLI_LOG" resolve --dedup-key "infra:watchdog_cli_failed" --title "Watchdog CLI starts again"; then
    rm -f "$marker" 2>/dev/null || true
  fi
  return 0
}

# =============================================================================
# ## NODE MODULES INTEGRITY (issue #4175; kept in bash by decision, #5099)
# =============================================================================
# Watches the runtime the CLI needs, so it runs on EVERY tick, CLI-start alarm
# or not. Per watched root it asserts: the dir exists, has `.bin/`, holds >=
# ENTRY_FLOOR top-level entries, and `.bin/<REQUIRED_BIN>` is executable. Reasons:
# root-absent, no-bin-dir, below-entry-floor:N<F, missing-binary:tsx. Threshold 0
# (fires on the first bad tick; Redis since/fired keys under
# hydra:autopilot:node-modules-integrity:{since,fired}:<sig>), in-band XADD
# (infra:node_modules_wiped) + page/resolve via operator-notify. Never fails.
# Env: HYDRA_REDIS_HOST/PORT/DB, HYDRA_WATCHDOG_NM_{NOW_MS,ROOTS,ENTRY_FLOOR,
# REQUIRED_BIN,NOTIFY_STREAM}, HYDRA_WATCHDOG_OPERATOR_NOTIFY. See watchdog.md.
NM_KEY_PREFIX="hydra:autopilot:node-modules-integrity"

# sig_for_root ROOT — a Redis-key-safe signal name (non-alnum runs -> one underscore).
sig_for_root() { printf '%s' "$1" | tr -c 'a-zA-Z0-9' '_' | tr -s '_'; }

# nm_deliver SIG ROOT REASON DUR_MS THR_MS — the enveloped XADD (the on-wire
# shape src/event-bus.ts publish() builds, ADR-0017 Category A) plus one page.
nm_deliver() {
  local sig="$1" root="$2" reason_clean root_clean iso payload
  reason_clean="$(printf '%s' "$3" | tr -dc 'a-zA-Z0-9_.:-')"
  root_clean="$(printf '%s' "$root" | tr -dc 'a-zA-Z0-9_./-')"
  iso="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
  payload="$(printf '{"signal":"%s","reason":"%s","durationMs":%s,"thresholdMs":%s}' "$root_clean" "$reason_clean" "$4" "$5")"
  rc_write XADD "${HYDRA_WATCHDOG_NM_NOTIFY_STREAM:-hydra:notifications}" '*' \
    id "node-modules-integrity-$(date +%s 2>/dev/null || echo 0)-$$" \
    type "infra:node_modules_wiped" \
    source "watchdog-node-modules-integrity" \
    timestamp "$iso" \
    correlationId "node-modules-integrity-${sig}" \
    payload "$payload"
  log "$NM_LOG" "in-band delivery published (best-effort) for '$root' (type=infra:node_modules_wiped)"
  # --alert false: the XADD above already reaches the bus consumer, which writes the dashboard alert.
  deliver_page "$NM_LOG" report --kind "infra:node_modules_wiped" --alert false \
    --fact "signal=$root_clean" --fact "reason=$reason_clean" --fact "sustained_ms=$4" --fact "threshold_ms=$5" || true
  return 0
}

# nm_track SIG ROOT REASON IS_BROKEN NOW_MS — SET NX since / fire once / DEL both
# on recovery (resolve only when the fired marker existed). A failed read never
# mutates a marker. Always returns 0.
nm_track() {
  local sig="$1" root="$2" reason="$3" broken="$4" now_ms="$5"
  local since_key="$NM_KEY_PREFIX:since:$sig" fired_key="$NM_KEY_PREFIX:fired:$sig" since dur
  if [[ "$broken" == "1" ]]; then
    rc_write SET "$since_key" "$now_ms" NX
    since="$(rc_read GET "$since_key" | tr -dc '0-9')"
    [[ "$since" =~ ^[0-9]+$ ]] || since="$now_ms"
    dur=$((now_ms - since))
    if (( dur < 0 )); then dur=0; fi
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
      log "$NM_LOG" "WARNING NODE_MODULES INTEGRITY — '$root' ${reason} (sustained ${dur}ms >= 0ms threshold); see issue #4175"
      rc_write SET "$fired_key" 1
      nm_deliver "$sig" "$root" "$reason" "$dur" 0
    fi
  else
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
      deliver_page "$NM_LOG" resolve --dedup-key "infra:node_modules_wiped" --title "node_modules integrity recovered: '$root'" || true
    fi
    rc_write DEL "$since_key" "$fired_key"
  fi
  return 0
}

run_node_modules_integrity() {
  local entry_floor="${HYDRA_WATCHDOG_NM_ENTRY_FLOOR:-20}" required_bin="${HYDRA_WATCHDOG_NM_REQUIRED_BIN:-tsx}"
  [[ "$entry_floor" =~ ^[0-9]+$ ]] || entry_floor=20
  local -a roots
  if [[ -n "${HYDRA_WATCHDOG_NM_ROOTS:-}" ]]; then
    IFS=':' read -r -a roots <<< "$HYDRA_WATCHDOG_NM_ROOTS"
  else
    # The orchestrator root always; the LIVE Target's best-effort through the
    # target-config seam (#4608) — fail OPEN on Target coverage only.
    roots=("$HOME/hydra/node_modules")
    local facts target_root
    facts="$(cd "$HOME/hydra" 2>/dev/null && npx tsx scripts/target/print-target-facts.ts 2>/dev/null || true)"
    target_root="$(printf '%s' "$facts" | jq -r '
      if (.workspace // "") == "" then empty
      elif (.manifest.appSubdir // "") == "" then .workspace + "/node_modules"
      else .workspace + "/" + (.manifest.appSubdir | sub("/+$"; "")) + "/node_modules"
      end' 2>/dev/null || true)"
    if [[ -n "$target_root" ]]; then
      roots+=("$target_root")
    else
      log "$NM_LOG" "WARN — Target node_modules root unresolved via scripts/target/print-target-facts.ts; watching only the orchestrator root this tick"
    fi
  fi

  local now_ms
  if [[ -n "${HYDRA_WATCHDOG_NM_NOW_MS+x}" ]]; then now_ms="$HYDRA_WATCHDOG_NM_NOW_MS"; else now_ms="$(date +%s%3N 2>/dev/null || echo 0)"; fi
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0

  local root broken reason count
  for root in "${roots[@]}"; do
    broken=0; reason=""
    if [[ ! -d "$root" ]]; then
      broken=1; reason="root-absent"
    elif [[ ! -d "$root/.bin" ]]; then
      broken=1; reason="no-bin-dir"
    else
      count="$(find "$root" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -dc '0-9')"
      [[ "$count" =~ ^[0-9]+$ ]] || count=0
      if (( count < entry_floor )); then
        broken=1; reason="below-entry-floor:${count}<${entry_floor}"
      elif [[ ! -x "$root/.bin/$required_bin" ]]; then
        broken=1; reason="missing-binary:${required_bin}"
      fi
    fi
    nm_track "$(sig_for_root "$root")" "$root" "$reason" "$broken" "$now_ms"
  done
  log "$NM_LOG" "node-modules-integrity tick processed (${#roots[@]} root(s) watched, now_ms=$now_ms)"
  return 0
}

# =============================================================================
# Entry point — only when executed directly (deploy.sh's smoke SOURCES this file
# to call resolve_watchdog_node; the guard keeps sourcing side-effect-free).
# =============================================================================
run_watchdog_tick() {
  local node_bin plan="" rc=0 sub prefix timeout_s
  if ! node_bin="$(resolve_watchdog_node)"; then
    cli_alarm_raise node-missing 127
  else
    plan="$(timeout 60 "$node_bin" --experimental-strip-types "${HYDRA_ROOT:-$HOME/hydra}/scripts/hydra-watchdog.ts" plan 2>/dev/null </dev/null)" || rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$plan" ]; then
      plan=""
      cli_alarm_raise plan-failed "$rc"
    else
      cli_alarm_clear
    fi
  fi
  while IFS=$'\t' read -r sub prefix timeout_s; do
    [ -n "$sub" ] && [ -n "$prefix" ] && [[ "$timeout_s" =~ ^[0-9]+$ ]] || continue
    run_watchdog_cli "$sub" "$prefix" "$timeout_s"
  done <<< "$plan"
  # The one check that must not depend on the CLI: always runs.
  run_node_modules_integrity
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_watchdog_tick
  exit 0
fi
