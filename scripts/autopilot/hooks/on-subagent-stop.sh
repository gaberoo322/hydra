#!/usr/bin/env bash
#
# on-subagent-stop.sh — Claude Code `SubagentStop` hook handler (issue #509).
#
# Contract
# --------
# Claude Code fires the `SubagentStop` hook when an `Agent(...)` (a.k.a.
# `Task(...)`) dispatch returns from a background subagent. The harness
# pipes a JSON payload to this script's stdin describing the subagent
# task and its result. We translate that into one event on the Redis
# stream `hydra:autopilot:slot-events` so the next autopilot decision
# turn can free the slot without polling.
#
# Event emitted (XADD with MAXLEN ~ 1000)
# ---------------------------------------
#   event=subagent_stop
#   slot=<dev_orch|dev_target|qa_orch|qa_target|research_orch|research_target|design_concept_orch|unknown>
#   status=<success|failure|no_op|budget_exceeded|unknown>
#   task_id=<harness-task-id-or-empty>
#   subagent_type=<hydra-dev|hydra-target-build|...>
#   summary=<truncated 200-char text>
#   ts_epoch=<unix-epoch-seconds>
#
# Slot parsing
# ------------
# The autopilot dispatches each subagent with a description that STARTS
# with the slot class name (e.g. `dev_orch — hydra-dev`). We extract the
# leading token. If the description doesn't start with a known slot, we
# emit `slot=unknown` and log a stderr warning rather than dropping the
# event.
#
# Status inference
# ----------------
# Heuristics in priority order:
#   1. task.result.error_message non-empty → failure
#   2. response contains "no-op" / "no work to claim" / "nothing to do"
#      → no_op
#   3. response contains a PR URL → success
#   4. response contains "budget" / "token cap" → budget_exceeded
#   5. else → unknown
#
# Best-effort guarantee
# ---------------------
# This hook MUST NOT propagate any error back to the autopilot session.
# A Redis outage, a malformed payload, a missing jq — any of these
# results in a stderr warning + exit 0. The autopilot survives without
# the event; reap.py is the silent-wedge fallback.
#
# Env-var overrides (for tests)
# -----------------------------
#   HYDRA_REDIS_HOST     (default: docker)  — when "docker", we shell into
#                                              hydra-redis-1; otherwise we
#                                              call `redis-cli -h $HOST`.
#   HYDRA_REDIS_PORT     (default: 6379)
#   HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM
#                        (default: hydra:autopilot:slot-events)
#

set -uo pipefail

STREAM_KEY="${HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM:-hydra:autopilot:slot-events}"
REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
MAXLEN_CAP="${HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN:-1000}"

# Known slot names — used for prefix matching on task.description.
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
  printf '[autopilot-hook] on-subagent-stop: %s\n' "$*" >&2
}

truncate_field() {
  # Truncate to 200 chars, strip CR/LF/tab so the stream stays parseable.
  local s="$1"
  s="${s//$'\n'/ }"
  s="${s//$'\r'/ }"
  s="${s//$'\t'/ }"
  if [ "${#s}" -gt 200 ]; then
    s="${s:0:200}"
  fi
  printf '%s' "$s"
}

# Read stdin (the SubagentStop JSON payload). On failure, emit a minimal
# event with status=unknown so we never silently drop a completion.
payload=""
if ! payload="$(cat -)"; then
  warn "stdin read failed"
  payload=""
fi

# Parse with jq if available; fall back to empty values on failure.
# Defensive: the upstream payload schema may evolve. We probe several
# plausible field paths.
slot="unknown"
status="unknown"
task_id=""
subagent_type=""
summary=""
description=""
error_message=""
response_text=""

if command -v jq >/dev/null 2>&1 && [ -n "$payload" ]; then
  # We accept either `task.*` (the documented SubagentStop shape from
  # Claude Code docs) or top-level fields (older harnesses).
  description="$(printf '%s' "$payload" | jq -r '
    (.task.description // .description // .subagent.description // "") | tostring
  ' 2>/dev/null || printf '')"
  subagent_type="$(printf '%s' "$payload" | jq -r '
    (.task.subagent_type // .subagent_type // .task.skill // .skill // "") | tostring
  ' 2>/dev/null || printf '')"
  task_id="$(printf '%s' "$payload" | jq -r '
    (.task.id // .task_id // .session_id // .id // "") | tostring
  ' 2>/dev/null || printf '')"
  error_message="$(printf '%s' "$payload" | jq -r '
    (.task.result.error_message // .result.error_message // .error_message // .error // "") | tostring
  ' 2>/dev/null || printf '')"
  response_text="$(printf '%s' "$payload" | jq -r '
    (.task.result.response // .task.result.text // .result.response // .result.text // .response // .text // "") | tostring
  ' 2>/dev/null || printf '')"
fi

# Slot derivation: walk known prefixes.
if [ -n "$description" ]; then
  for s in "${KNOWN_SLOTS[@]}"; do
    case "$description" in
      "$s"|"$s "*|"$s	"*|"$s:"*|"$s-"*|"$s—"*|"$s -"*|"$s --"*)
        slot="$s"
        break
        ;;
    esac
  done
  if [ "$slot" = "unknown" ]; then
    warn "could not derive slot from description=$(truncate_field "$description")"
  fi
fi

# If slot still unknown, fall back to subagent_type → slot mapping.
if [ "$slot" = "unknown" ] && [ -n "$subagent_type" ]; then
  case "$subagent_type" in
    hydra-dev)            slot="dev_orch" ;;
    hydra-target-build)   slot="dev_target" ;;
    hydra-qa)             slot="qa_orch" ;;
    hydra-research|hydra-issue-research) slot="research_orch" ;;
    hydra-target-research) slot="research_target" ;;
    hydra-sweep)          slot="sweep_orch" ;;
    hydra-target-sweep)   slot="sweep_target" ;;
    hydra-discover)       slot="discover_orch" ;;
    hydra-target-discover) slot="discover_target" ;;
    hydra-doctor)         slot="health" ;;
    hydra-grill)          slot="design_concept_orch" ;;
  esac
fi

# Status inference.
if [ -n "$error_message" ]; then
  status="failure"
elif printf '%s' "$response_text" | grep -qiE 'no.?op|no work to claim|nothing to do|nothing to claim'; then
  status="no_op"
elif printf '%s' "$response_text" | grep -qE 'https://github\.com/[^ ]+/pull/[0-9]+'; then
  status="success"
elif printf '%s' "$response_text" | grep -qiE 'budget exceeded|token cap|hard cap|soft cap'; then
  status="budget_exceeded"
fi

# Summary: prefer error_message when failure, otherwise first 200 chars of response.
if [ "$status" = "failure" ] && [ -n "$error_message" ]; then
  summary="$(truncate_field "$error_message")"
else
  summary="$(truncate_field "${response_text:-$description}")"
fi

now_epoch="$(date +%s)"

# Build the redis-cli invocation. Two callsites because the operator
# runtime is `docker exec hydra-redis-1`, but tests inject HYDRA_REDIS_HOST
# pointing at a localhost or an unreachable port to verify graceful failure.
emit() {
  if [ "$REDIS_HOST" = "docker" ]; then
    docker exec hydra-redis-1 redis-cli \
      XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*' \
      event subagent_stop \
      slot "$slot" \
      status "$status" \
      task_id "$task_id" \
      subagent_type "$subagent_type" \
      summary "$summary" \
      ts_epoch "$now_epoch"
  else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
      XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*' \
      event subagent_stop \
      slot "$slot" \
      status "$status" \
      task_id "$task_id" \
      subagent_type "$subagent_type" \
      summary "$summary" \
      ts_epoch "$now_epoch"
  fi
}

if ! emit >/dev/null 2>&1; then
  warn "XADD to ${STREAM_KEY} failed (REDIS_HOST=${REDIS_HOST}, REDIS_PORT=${REDIS_PORT}) — slot=${slot} status=${status} task_id=${task_id}"
  # Best-effort: never propagate Redis failures back to the parent session.
  exit 0
fi

exit 0
