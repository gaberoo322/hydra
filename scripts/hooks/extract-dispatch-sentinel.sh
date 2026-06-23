#!/usr/bin/env bash
#
# extract-dispatch-sentinel.sh — shared sentinel-parse grammar (issue #2406).
#
# Single source of truth for the `<!-- hydra-dispatch v1 ... -->` sentinel
# grammar that the autopilot injects into the FIRST user message of every
# Agent-tool dispatch (issue #692). Two hooks parse it:
#
#   - scripts/hooks/session-start-capture.sh        (SessionStart — top-level
#                                                     operator/parent sessions)
#   - scripts/autopilot/hooks/on-subagent-tool-call.sh (PostToolUse — the only
#                                                     event that fires INSIDE an
#                                                     Agent-tool subagent child;
#                                                     SessionStart never does)
#
# Both register the SAME `/api/dispatches/subagent` body shape into the
# subagent-dispatch registry. Keeping the grammar in one sourced helper means a
# future change to the sentinel form (or the first-user-message extraction)
# happens in exactly one place and both writers stay in lock-step (qaTrace
# recommendation on #2406: "factor the sentinel-extraction into a single shared
# parser source-of-truth").
#
# This file is SOURCED, not executed — it defines functions only and has no
# top-level side effects. The sourcing script owns its own `set` flags, stdin
# handling, and exit discipline; nothing here ever `exit`s.
#
# Functions
# ---------
#   extract_first_user_text <transcript_path>
#       Echo the textual content of the first user message in a session JSONL,
#       or empty on any failure. Handles both plain-string and content-block
#       array shapes.
#
#   extract_sentinel_line <text>
#       Echo the first `<!-- hydra-dispatch v1 ... -->` line found in <text>,
#       or empty if none. (No sentinel == not a dispatched session.)
#
#   extract_sentinel_field <sentinel_line> <field-name>
#       Echo the value of `name=VALUE` from a sentinel line (VALUE runs to the
#       next whitespace or the closing `-->`), or empty if absent. Field order
#       and the presence/absence of optional fields (e.g. runId) don't matter.
#
# All three require `jq`/`grep`/`sed` on PATH; the caller is responsible for the
# `command -v jq` guard (both callers already do it before sourcing-time use).

# Echo the first user message's text from a session JSONL transcript.
extract_first_user_text() {
  local transcript_path="$1"
  [ -n "$transcript_path" ] && [ -f "$transcript_path" ] || return 0
  jq -rs '
    [ .[]
      | select((.type? == "user") or (.role? == "user") or (.message?.role? == "user"))
    ] as $users
    | ($users[0] // {}) as $u
    | ( $u.message?.content // $u.content // $u.text // "" ) as $c
    | if ($c | type) == "array"
      then ( [ $c[] | (.text // .content // "") ] | join("\n") )
      else ($c | tostring)
      end
  ' "$transcript_path" 2>/dev/null || printf ''
}

# Echo the first hydra-dispatch v1 sentinel line found in the given text.
extract_sentinel_line() {
  local text="$1"
  [ -n "$text" ] || return 0
  printf '%s\n' "$text" \
    | grep -m1 -E '<!--[[:space:]]*hydra-dispatch[[:space:]]+v1[[:space:]]' || true
}

# Echo the value of `name=VALUE` from a sentinel line.
extract_sentinel_field() {
  local sentinel_line="$1" field="$2"
  [ -n "$sentinel_line" ] && [ -n "$field" ] || return 0
  printf '%s' "$sentinel_line" \
    | grep -oE "$field=[^[:space:]>]+" \
    | head -n1 \
    | sed -E "s/^$field=//"
}
