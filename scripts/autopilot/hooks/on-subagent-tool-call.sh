#!/usr/bin/env bash
#
# on-subagent-tool-call.sh — Claude Code `PostToolUse` hook handler (issue #671).
#
# Purpose
# -------
# Fires after every tool call inside a subagent session (hydra-dev,
# hydra-target-build, hydra-qa, hydra-research, hydra-target-research,
# hydra-sweep, hydra-target-sweep, hydra-discover, hydra-target-discover,
# hydra-doctor). Classifies the call into one of three categories at
# emit-time and XADDs a `subagent_tool_call` event onto
# `hydra:autopilot:slot-events` so the /now-pixel dashboard and the
# autopilot's slot-events bridge can render per-tool-call activity
# without polling.
#
# Categories
# ----------
#   milestone   — code/state-changing writes
#                 (Write, Edit, MultiEdit, NotebookEdit, MCP write tools,
#                  Bash matching ^(git commit|gh pr|npm test|npm run build|
#                  npm run typecheck))
#   io          — non-milestone external work
#                 (Bash not in the milestone list, WebFetch)
#   background  — read-only context gathering
#                 (Read, Grep, Glob)
#
# Event emitted (XADD with MAXLEN ~ 1000)
# ---------------------------------------
#   event=subagent_tool_call
#   slot=<dev_orch|dev_target|qa_orch|...|unknown>
#   task_id=<harness-task-id-or-empty>
#   tool=<tool-name>
#   category=<milestone|io|background>
#   target=<short identifier — file path / cmd head / url-or-empty>
#   duration_ms=<int-or-empty>
#   success=<true|false|unknown>
#   ts_epoch=<unix-epoch-seconds>
#
# Best-effort guarantee
# ---------------------
# Same as the sibling slot hooks: every failure path is logged to stderr
# and returns exit 0. A Redis outage, a malformed payload, a missing jq —
# none of these block the parent subagent. We never gate a tool call on
# this hook succeeding.
#
# Env-var overrides (for tests)
# -----------------------------
#   HYDRA_REDIS_HOST     (default: docker)
#   HYDRA_REDIS_PORT     (default: 6379)
#   HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM
#                        (default: hydra:autopilot:slot-events)
#   HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN
#                        (default: 1000)
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
  printf '[autopilot-hook] on-subagent-tool-call: %s\n' "$*" >&2
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

tool=""
description=""
task_id=""
subagent_type=""
file_path=""
command_str=""
url=""
notebook_path=""
duration_ms=""
success=""

if command -v jq >/dev/null 2>&1 && [ -n "$payload" ]; then
  tool="$(printf '%s' "$payload" | jq -r '
    (.tool_name // .tool // "") | tostring
  ' 2>/dev/null || printf '')"
  description="$(printf '%s' "$payload" | jq -r '
    (.task.description // .description // .subagent.description // "") | tostring
  ' 2>/dev/null || printf '')"
  subagent_type="$(printf '%s' "$payload" | jq -r '
    (.task.subagent_type // .subagent_type // .task.skill // .skill // "") | tostring
  ' 2>/dev/null || printf '')"
  task_id="$(printf '%s' "$payload" | jq -r '
    (.task.id // .task_id // .session_id // .id // "") | tostring
  ' 2>/dev/null || printf '')"
  file_path="$(printf '%s' "$payload" | jq -r '
    (.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // "") | tostring
  ' 2>/dev/null || printf '')"
  command_str="$(printf '%s' "$payload" | jq -r '
    (.tool_input.command // "") | tostring
  ' 2>/dev/null || printf '')"
  url="$(printf '%s' "$payload" | jq -r '
    (.tool_input.url // "") | tostring
  ' 2>/dev/null || printf '')"
  notebook_path="$(printf '%s' "$payload" | jq -r '
    (.tool_input.notebook_path // "") | tostring
  ' 2>/dev/null || printf '')"
  duration_ms="$(printf '%s' "$payload" | jq -r '
    (.duration_ms // .tool_response.duration_ms // .result.duration_ms // "") | tostring
  ' 2>/dev/null || printf '')"
  # Heuristic: explicit success flag, else infer from error fields.
  success="$(printf '%s' "$payload" | jq -r '
    if (.tool_response.success // .result.success // null) != null then
      (.tool_response.success // .result.success | tostring)
    elif (.tool_response.error // .result.error // .error // "") != "" then
      "false"
    else
      "unknown"
    end
  ' 2>/dev/null || printf 'unknown')"
fi

# Skip emit when tool is unknown — without a tool name, the event is
# unparseable and pollutes the stream. The hook still exits 0.
if [ -z "$tool" ]; then
  warn "missing tool_name in payload; skipping emit"
  exit 0
fi

# Slot derivation: walk known prefixes on description.
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

# Fall back to subagent_type → slot mapping when description didn't match.
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

# Category classification.
#
# Bash is special: by default it's `io`, but a few specific milestone
# prefixes (commit/PR open/test/build/typecheck) are promoted to
# `milestone` so the dashboard can light up on the verification heartbeat.
classify_bash() {
  local cmd="$1"
  # Strip leading whitespace.
  cmd="${cmd#"${cmd%%[![:space:]]*}"}"
  case "$cmd" in
    "git commit"*|"git commit -"*|\
    "gh pr"*|"gh pr "*|\
    "npm test"|"npm test "*|\
    "npm run build"|"npm run build "*|\
    "npm run typecheck"|"npm run typecheck "*)
      printf 'milestone'
      ;;
    *)
      printf 'io'
      ;;
  esac
}

# Anything matching an MCP write surface (heuristic: name contains `__create`,
# `__update`, `__edit`, `__send`, `__post`, `__write`, `__delete`, or starts
# with `mcp__` and the trailing verb suggests mutation) is a milestone.
classify_mcp_write() {
  local t="$1"
  case "$t" in
    mcp__*__create*|mcp__*__update*|mcp__*__edit*|mcp__*__send*|\
    mcp__*__post*|mcp__*__write*|mcp__*__delete*|mcp__*__add*|\
    mcp__*__transition*|mcp__*__authenticate*|mcp__*__upload*)
      return 0
      ;;
  esac
  return 1
}

category="background"
case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit)
    category="milestone"
    ;;
  Read|Grep|Glob)
    category="background"
    ;;
  Bash)
    category="$(classify_bash "$command_str")"
    ;;
  WebFetch|WebSearch)
    category="io"
    ;;
  mcp__*)
    if classify_mcp_write "$tool"; then
      category="milestone"
    else
      category="io"
    fi
    ;;
  *)
    # Unknown / future tools default to io — visible on the dashboard,
    # but doesn't trigger the high-impact milestone animation.
    category="io"
    ;;
esac

# Target derivation — a short identifier for the dashboard to show.
target=""
case "$tool" in
  Write|Edit|MultiEdit|Read)
    target="$file_path"
    ;;
  NotebookEdit)
    target="${notebook_path:-$file_path}"
    ;;
  Bash)
    # First word of the command, capped.
    target="${command_str%% *}"
    ;;
  WebFetch|WebSearch)
    target="$url"
    ;;
  Grep|Glob)
    # Pattern / glob isn't on a stable field name across versions;
    # leave empty rather than guess. The dashboard can show "Grep" alone.
    target=""
    ;;
  *)
    target=""
    ;;
esac

target="$(truncate_field "$target")"

now_epoch="$(date +%s)"

# Build the XADD field list dynamically. Redis tolerates empty string
# values, but `redis-cli XRANGE` formats them as blank lines that some
# parsers (notably the regression-test parser in test/) lose during
# whitespace-stripping. Emit `n/a` as a sentinel for fields the harness
# didn't supply, so every event has a stable shape and downstream
# consumers don't have to guess whether a missing field is "no value"
# or "field was elided".
SENTINEL="n/a"
field_pairs=(
  event subagent_tool_call
  slot "$slot"
  task_id "${task_id:-$SENTINEL}"
  tool "$tool"
  category "$category"
  target "${target:-$SENTINEL}"
  duration_ms "${duration_ms:-$SENTINEL}"
  success "${success:-unknown}"
  ts_epoch "$now_epoch"
)

emit() {
  if [ "$REDIS_HOST" = "docker" ]; then
    docker exec hydra-redis-1 redis-cli \
      XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*' \
      "${field_pairs[@]}"
  else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
      XADD "$STREAM_KEY" MAXLEN '~' "$MAXLEN_CAP" '*' \
      "${field_pairs[@]}"
  fi
}

if ! emit >/dev/null 2>&1; then
  warn "XADD to ${STREAM_KEY} failed (REDIS_HOST=${REDIS_HOST}, REDIS_PORT=${REDIS_PORT}) — slot=${slot} tool=${tool} category=${category}"
  exit 0
fi

exit 0
