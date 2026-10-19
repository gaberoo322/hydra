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
# Subagent-dispatch registration (issue #2406)
# ---------------------------------------------
# This hook is ALSO the only event that fires INSIDE an Agent-tool subagent
# child and carries that child's `session_id` + `transcript_path`. The #692
# `SessionStart` hook is a TOP-LEVEL session event the harness never fires for
# an Agent(...) child, so `hydra:dispatches:subagent:*` stayed empty (0 entries
# ever) and the live in-flight dispatch view (`listActiveSubagentDispatches`,
# consumed by src/autopilot/runs.ts + run-projections.ts) was blind.
#
# So, in ADDITION to the slot-event XADD above, this hook registers the running
# subagent into the dispatch registry on its tool calls: it scrapes the same
# hidden `<!-- hydra-dispatch v1 ... -->` sentinel from the child's own
# transcript (shared grammar — scripts/hooks/extract-dispatch-sentinel.sh) and
# POSTs the UNCHANGED `/api/dispatches/subagent` body. The storage layer + API +
# schema are unchanged. A once-per-session marker keeps the scrape+POST to the
# first observed tool call (the registry write is idempotent, so re-firing would
# only be a harmless no-op anyway). Sessions with no sentinel (interactive
# operator `claude`) never register — the sentinel stays the opt-in marker.
#
# This is DECOUPLED from the offline usage-attribution work (#2401/#2402): the
# two share only the sentinel-parse grammar, never a mechanism, and this hook
# introduces no registry dependency into src/cost/*.
#
# Best-effort guarantee
# ---------------------
# Same as the sibling slot hooks: every failure path is logged to stderr
# and returns exit 0. A Redis outage, a malformed payload, a missing jq, a
# missing transcript, an unreachable API — none of these block the parent
# subagent. We never gate a tool call on this hook succeeding.
#
# Env-var overrides (for tests)
# -----------------------------
#   HYDRA_REDIS_HOST     (default: docker)
#   HYDRA_REDIS_PORT     (default: 6379)
#   HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM
#                        (default: hydra:autopilot:slot-events)
#   HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN
#                        (default: 1000)
#   HYDRA_API_BASE       (default: http://localhost:4000) — dispatch-registry POST target
#   HYDRA_DISPATCH_REGISTER_MARKER_DIR
#                        (default: $TMPDIR or /tmp) — once-per-session guard dir
#

set -uo pipefail

STREAM_KEY="${HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM:-hydra:autopilot:slot-events}"
REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
MAXLEN_CAP="${HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN:-1000}"
API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"
DISPATCH_REGISTER_MARKER_DIR="${HYDRA_DISPATCH_REGISTER_MARKER_DIR:-${TMPDIR:-/tmp}}"

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

# ---------------------------------------------------------------------------
# Child identity (issue #4965). Inside an Agent-tool child the payload's
# `session_id` / `transcript_path` belong to the PARENT; only `agent_id` is
# per-child (present ONLY inside a subagent). So:
#   - No agent_id (operator session, autopilot parent main thread) -> exit 0
#     here, before any XADD / docker exec / curl / transcript read. Registering
#     this hook project-wide therefore costs main-thread sessions nothing.
#   - The child transcript is `agent_transcript_path` when the harness supplies
#     it, else `${transcript_path%.jsonl}/subagents/agent-${agent_id}.jsonl`.
#   - The registry key + once-per-dispatch marker are keyed on agent_id (never
#     session_id, which every sibling child shares).
# ---------------------------------------------------------------------------
agent_id=""
parent_session_id=""
child_transcript=""
project_dir=""
if command -v jq >/dev/null 2>&1 && [ -n "$payload" ]; then
  agent_id="$(printf '%s' "$payload" | jq -r '(.agent_id // "") | tostring' 2>/dev/null || printf '')"
  parent_session_id="$(printf '%s' "$payload" | jq -r '(.session_id // .sessionId // "") | tostring' 2>/dev/null || printf '')"
  project_dir="$(printf '%s' "$payload" | jq -r '(.cwd // .project_dir // "") | tostring' 2>/dev/null || printf '')"
  child_transcript="$(printf '%s' "$payload" | jq -r '(.agent_transcript_path // "") | tostring' 2>/dev/null || printf '')"
  if [ -z "$child_transcript" ]; then
    parent_transcript="$(printf '%s' "$payload" | jq -r '(.transcript_path // .transcriptPath // "") | tostring' 2>/dev/null || printf '')"
    if [ -n "$parent_transcript" ] && [ -n "$agent_id" ]; then
      child_transcript="${parent_transcript%.jsonl}/subagents/agent-${agent_id}.jsonl"
    fi
  fi
fi

[ -n "$agent_id" ] || exit 0
if ! [[ "$agent_id" =~ ^[0-9a-f]{8,40}$ ]]; then
  warn "agent_id not hex-shaped; skipping"
  exit 0
fi
task_id="$agent_id"

# Resolve the child's dispatch sentinel (cached per agent_id). Sets d_skill,
# d_dispatch_id, d_run_id and returns 0 when the child is sentinel-bearing;
# returns 1 otherwise (sentinel-less children write a negative marker so their
# later tool calls skip the transcript scrape).
d_skill=""; d_dispatch_id=""; d_run_id=""
child_marker="${DISPATCH_REGISTER_MARKER_DIR%/}/hydra-dispatch-registered-${agent_id}"
child_registered=0
resolve_child_dispatch() {
  if [ -e "$child_marker" ]; then
    local first
    first="$(head -n 1 "$child_marker" 2>/dev/null || printf '')"
    [ "$first" = "none" ] && return 1
    IFS=$'\t' read -r d_skill d_dispatch_id d_run_id <<<"$first"
    if [ -n "$d_skill" ] && [ -n "$d_dispatch_id" ]; then
      child_registered=1
      return 0
    fi
  fi
  [ -n "$child_transcript" ] && [ -f "$child_transcript" ] || return 1
  local hook_dir helper first_user_text sentinel_line
  hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  helper="$hook_dir/../../hooks/extract-dispatch-sentinel.sh"
  [ -f "$helper" ] || { warn "sentinel helper not found at $helper"; return 1; }
  # shellcheck source=scripts/hooks/extract-dispatch-sentinel.sh
  . "$helper" 2>/dev/null || { warn "could not source $helper"; return 1; }
  first_user_text="$(extract_first_user_text "$child_transcript")"
  [ -n "$first_user_text" ] || return 1
  sentinel_line="$(extract_sentinel_line "$first_user_text")"
  if [ -z "$sentinel_line" ]; then
    printf 'none\n' > "$child_marker" 2>/dev/null || true
    return 1
  fi
  d_skill="$(extract_sentinel_field "$sentinel_line" skill)"
  d_dispatch_id="$(extract_sentinel_field "$sentinel_line" dispatchId)"
  d_run_id="$(extract_sentinel_field "$sentinel_line" runId)"
  if [ -z "$d_skill" ] || [ -z "$d_dispatch_id" ]; then
    warn "malformed sentinel (skill='$d_skill' dispatchId='$d_dispatch_id')"
    return 1
  fi
  return 0
}

resolve_child_dispatch || exit 0

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

# Sentinel-derived slot: the dispatchId `-t<N>-<class>` suffix.
if [ "$slot" = "unknown" ]; then
  case "$d_dispatch_id" in
    *-t[0-9]*-*)
      suffix_class="${d_dispatch_id#*-t[0-9]*-}"
      for s in "${KNOWN_SLOTS[@]}"; do
        if [ "$suffix_class" = "$s" ]; then slot="$s"; break; fi
      done
      ;;
  esac
fi

# Fall back to subagent_type (else the sentinel's skill) → slot mapping.
if [ "$slot" = "unknown" ] && [ -z "$subagent_type" ]; then
  subagent_type="$d_skill"
fi
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
  # NOT a return — fall through to the dispatch-registration attempt below.
  # The two are independent best-effort writes; a slot-event XADD failure
  # (e.g. Redis down) must not suppress the registry POST (which targets the
  # HTTP API, a different surface).
fi

# ===========================================================================
# Subagent-dispatch registration (issue #2406) — additive, best-effort.
#
# Register THIS subagent session into hydra:dispatches:subagent:* so the live
# in-flight view is populated for Agent-tool dispatches (which SessionStart can
# never see). Scrape the sentinel from the child's own transcript and POST the
# existing /api/dispatches/subagent body. Every failure path exits 0.
# ===========================================================================
register_subagent_dispatch() {
  # jq is required to build the body; without it, no-op.
  command -v jq >/dev/null 2>&1 || { warn "jq not found — skipping dispatch registration"; return 0; }
  # The sentinel was resolved (and the once-per-agent marker consulted) up top
  # by resolve_child_dispatch. Already registered -> nothing to do.
  [ "$child_registered" = "1" ] && return 0

  local started_at body
  started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  # Registry key = the bare agent_id hash (matches reap's slot.task_id
  # convention); the parent's session_id rides along as parentSessionId so the
  # transcript route can find <parent>/subagents/agent-<id>.jsonl.
  body="$(jq -nc \
    --arg sessionId "$agent_id" \
    --arg parentSessionId "$parent_session_id" \
    --arg skill "$d_skill" \
    --arg dispatchId "$d_dispatch_id" \
    --arg startedAt "$started_at" \
    --arg runId "$d_run_id" \
    --arg projectDir "$project_dir" \
    '{sessionId: $sessionId, skill: $skill, dispatchId: $dispatchId, startedAt: $startedAt}
     + (if ($parentSessionId | length) > 0 then {parentSessionId: $parentSessionId} else {} end)
     + (if ($runId | length) > 0 then {runId: $runId} else {} end)
     + (if ($projectDir | length) > 0 then {projectDir: $projectDir} else {} end)' \
    2>/dev/null || printf '')"

  [ -n "$body" ] || { warn "failed to build dispatch-registration body — skipping"; return 0; }

  if ! curl -fsS --max-time 5 \
    -X POST "$API_BASE/api/dispatches/subagent" \
    -H 'content-type: application/json' \
    -d "$body" >/dev/null 2>&1; then
    warn "POST to $API_BASE/api/dispatches/subagent failed — skipping"
    return 0
  fi

  # Registered. Drop the once-per-session marker so subsequent tool calls in
  # this session skip the scrape+POST. Best-effort: a failure here just means
  # we re-register (idempotent) on the next tool call.
  printf '%s\t%s\t%s\n' "$d_skill" "$d_dispatch_id" "$d_run_id" > "$child_marker" 2>/dev/null || true
  return 0
}

register_subagent_dispatch

exit 0
