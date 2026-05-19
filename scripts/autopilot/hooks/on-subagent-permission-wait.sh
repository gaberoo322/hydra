#!/usr/bin/env bash
#
# on-subagent-permission-wait.sh — Claude Code `Notification` hook handler
# (issue #509).
#
# Contract
# --------
# Claude Code fires the `Notification` hook for various lifecycle events,
# including when a subagent has prompted the operator for permission to
# use a restricted tool. We FILTER for permission-prompt notifications
# only (the rest — idle warnings, status pings — would be noise on the
# slot-events stream).
#
# Event emitted (XADD with MAXLEN ~ 1000)
# ---------------------------------------
#   event=slot_waiting_permission
#   slot=<slot-or-unknown>
#   prompt=<truncated 200-char text>
#   ts_epoch=<unix-epoch-seconds>
#
# Why this is distinct from `subagent_stop`
# -----------------------------------------
# A permission-wait is NOT a completion — the slot is still in flight,
# the subagent is paused. decide.py logs it into state.failure_log so
# the operator can spot wedged-on-permission subagents on the next
# review, but does NOT free the slot.
#
# Best-effort guarantee
# ---------------------
# Same as on-subagent-stop.sh: every failure path is logged to stderr
# and returns exit 0. The autopilot session must NEVER receive a
# non-zero exit code from a hook.
#

set -uo pipefail

STREAM_KEY="${HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM:-hydra:autopilot:slot-events}"
REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
MAXLEN_CAP="${HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN:-1000}"

KNOWN_SLOTS=(
  dev_orch
  dev_target
  qa_orch
  qa_target
  research_orch
  research_target
  research
  sweep_orch
  sweep_target
  discover_orch
  discover_target
  design_concept_orch
  health
)

warn() {
  printf '[autopilot-hook] on-subagent-permission-wait: %s\n' "$*" >&2
}

truncate_field() {
  local s="$1"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  if [ "${#s}" -gt 200 ]; then
    s="${s:0:200}"
  fi
  printf '%s' "$s"
}

payload=""
if ! payload="$(cat -)"; then
  warn "stdin read failed"
  payload=""
fi

prompt_text=""
description=""
notification_type=""

if command -v jq >/dev/null 2>&1 && [ -n "$payload" ]; then
  prompt_text="$(printf '%s' "$payload" | jq -r '
    (.message // .prompt // .notification.message // .notification.prompt // .text // "") | tostring
  ' 2>/dev/null || printf '')"
  description="$(printf '%s' "$payload" | jq -r '
    (.task.description // .description // .subagent.description // "") | tostring
  ' 2>/dev/null || printf '')"
  notification_type="$(printf '%s' "$payload" | jq -r '
    (.type // .notification.type // "") | tostring
  ' 2>/dev/null || printf '')"
fi

# Filter: only emit for permission-prompt notifications.
combined="$(printf '%s\n%s' "$prompt_text" "$notification_type")"
if ! printf '%s' "$combined" | grep -qiE 'permission|approve|approval|denied|allow.*tool|tool.*permission'; then
  # Not a permission-wait — drop silently. Other Notification events
  # MUST NOT pollute the slot-events stream.
  exit 0
fi

slot="unknown"
if [ -n "$description" ]; then
  for s in "${KNOWN_SLOTS[@]}"; do
    case "$description" in
      "$s"|"$s "*|"$s	"*|"$s:"*|"$s-"*|"$s—"*|"$s -"*|"$s --"*)
        slot="$s"
        break
        ;;
    esac
  done
fi

prompt="$(truncate_field "$prompt_text")"
now_epoch="$(date +%s)"

emit() {
  if [ "$REDIS_HOST" = "docker" ]; then
    docker exec hydra-redis-1 redis-cli \
      XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*' \
      event slot_waiting_permission \
      slot "$slot" \
      prompt "$prompt" \
      ts_epoch "$now_epoch"
  else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
      XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*' \
      event slot_waiting_permission \
      slot "$slot" \
      prompt "$prompt" \
      ts_epoch "$now_epoch"
  fi
}

if ! emit >/dev/null 2>&1; then
  warn "XADD to ${STREAM_KEY} failed (REDIS_HOST=${REDIS_HOST}, REDIS_PORT=${REDIS_PORT}) — slot=${slot}"
  exit 0
fi

exit 0
