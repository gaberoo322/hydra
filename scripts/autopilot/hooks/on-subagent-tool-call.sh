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
  # jq is required to read the payload + build the body; without it, no-op.
  command -v jq >/dev/null 2>&1 || { warn "jq not found — skipping dispatch registration"; return 0; }
  [ -n "$payload" ] || return 0

  # PostToolUse carries the child's own session_id, transcript_path, and cwd at
  # the top level (same shape SessionStart uses). These are DISTINCT from the
  # `task_id` derived above (which the slot-event uses): the registry is keyed
  # on the harness session_id, the JSONL filename stem.
  local session_id transcript_path project_dir
  session_id="$(printf '%s' "$payload" | jq -r '(.session_id // .sessionId // "") | tostring' 2>/dev/null || printf '')"
  transcript_path="$(printf '%s' "$payload" | jq -r '(.transcript_path // .transcriptPath // "") | tostring' 2>/dev/null || printf '')"
  project_dir="$(printf '%s' "$payload" | jq -r '(.cwd // .project_dir // "") | tostring' 2>/dev/null || printf '')"

  [ -n "$session_id" ] || { warn "no session_id in payload — skipping dispatch registration"; return 0; }
  if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
    warn "transcript not found ($transcript_path) — skipping dispatch registration"
    return 0
  fi

  # Once-per-session guard. The registry write is idempotent (ZADD without
  # XX/NX, keyed on sessionId), so re-registering on every tool call is a
  # harmless no-op — this marker is purely an optimisation to avoid re-scraping
  # the transcript and re-POSTing on every subsequent tool call. Best-effort:
  # if we can't create the marker (read-only TMPDIR), we just register again,
  # which is safe.
  local marker
  marker="${DISPATCH_REGISTER_MARKER_DIR%/}/hydra-dispatch-registered-${session_id}"
  if [ -e "$marker" ]; then
    return 0
  fi

  # Source the shared sentinel grammar relative to THIS hook's location. The
  # helper lives under scripts/hooks/, this hook under scripts/autopilot/hooks/.
  local hook_dir helper
  hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  helper="$hook_dir/../../hooks/extract-dispatch-sentinel.sh"
  if [ ! -f "$helper" ]; then
    warn "sentinel helper not found at $helper — skipping dispatch registration"
    return 0
  fi
  # shellcheck source=scripts/hooks/extract-dispatch-sentinel.sh
  . "$helper" 2>/dev/null || { warn "could not source $helper — skipping dispatch registration"; return 0; }

  local first_user_text sentinel_line d_skill d_dispatch_id d_run_id
  first_user_text="$(extract_first_user_text "$transcript_path")"
  [ -n "$first_user_text" ] || { warn "no first user message — skipping dispatch registration"; return 0; }

  sentinel_line="$(extract_sentinel_line "$first_user_text")"
  # No sentinel — interactive operator subagent / non-dispatch session. Silent
  # no-op (don't even write the marker; a later resume might carry one).
  [ -n "$sentinel_line" ] || return 0

  d_skill="$(extract_sentinel_field "$sentinel_line" skill)"
  d_dispatch_id="$(extract_sentinel_field "$sentinel_line" dispatchId)"
  d_run_id="$(extract_sentinel_field "$sentinel_line" runId)"

  if [ -z "$d_skill" ] || [ -z "$d_dispatch_id" ]; then
    warn "malformed sentinel (skill='$d_skill' dispatchId='$d_dispatch_id') — skipping dispatch registration"
    return 0
  fi

  local started_at body
  started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  body="$(jq -nc \
    --arg sessionId "$session_id" \
    --arg skill "$d_skill" \
    --arg dispatchId "$d_dispatch_id" \
    --arg startedAt "$started_at" \
    --arg runId "$d_run_id" \
    --arg projectDir "$project_dir" \
    '{sessionId: $sessionId, skill: $skill, dispatchId: $dispatchId, startedAt: $startedAt}
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
  : > "$marker" 2>/dev/null || true
  return 0
}

register_subagent_dispatch

exit 0
