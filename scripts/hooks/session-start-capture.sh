#!/usr/bin/env bash
#
# session-start-capture.sh — Claude Code `SessionStart` hook (issue #692).
#
# Purpose
# -------
# Captures every autopilot- (or operator-) dispatched subagent session into
# the subagent-dispatch registry so a live `(skill, dispatchId, runId,
# startedAt)` tuple is recoverable from Redis within ~5s of a dispatch. This
# is the read-side counterpart to the hidden sentinel the autopilot injects
# into each Agent-tool dispatch prompt.
#
# How it works
# ------------
# 1. Claude Code fires SessionStart with a JSON payload on stdin carrying
#    `session_id`, `transcript_path`, `cwd`, and `source`.
# 2. We read the transcript JSONL and find the FIRST user message.
# 3. We regex-extract the hidden sentinel from that message:
#
#        <!-- hydra-dispatch v1 skill={skill} dispatchId={id} runId={runId} -->
#
#    (`runId` is optional — omitted for operator-launched dispatches.)
# 4. We POST the parsed fields to `POST /api/dispatches/subagent`.
#
# Sessions WITHOUT a sentinel (a human running `claude` directly) silently
# exit 0 — they never register. That is the whole point of the sentinel: it
# is the opt-in marker that distinguishes a dispatched subagent from an
# interactive operator session.
#
# Idempotent
# ----------
# Re-running for the same session is a no-op write: the endpoint keys on
# sessionId and ZADD keeps the index score in place, so a SessionStart that
# fires again on resume re-registers the identical row.
#
# Best-effort guarantee
# ---------------------
# Every failure path (no sentinel, no transcript, Redis/HTTP down, missing
# jq) logs to stderr and returns exit 0. A SessionStart hook MUST NOT block
# or fail the session it is announcing.
#
# Env-var overrides (for tests)
# -----------------------------
#   HYDRA_API_BASE   (default: http://localhost:4000)
#
set -uo pipefail

API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"

warn() {
  printf '[hook] session-start-capture: %s\n' "$*" >&2
}

# --- read stdin payload ----------------------------------------------------
payload=""
if ! payload="$(cat -)"; then
  warn "stdin read failed"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  warn "jq not found — skipping"
  exit 0
fi

# Shared sentinel-parse grammar (issue #2406) — same source of truth the
# subagent-scoped PostToolUse hook uses, so the two registration writers stay
# in lock-step. Sourced from this script's own directory so a worktree / synced
# copy resolves it relative to itself.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/hooks/extract-dispatch-sentinel.sh
if ! . "$HOOK_DIR/extract-dispatch-sentinel.sh" 2>/dev/null; then
  warn "could not source extract-dispatch-sentinel.sh from $HOOK_DIR — skipping"
  exit 0
fi

session_id="$(printf '%s' "$payload" | jq -r '(.session_id // .sessionId // "") | tostring' 2>/dev/null || printf '')"
transcript_path="$(printf '%s' "$payload" | jq -r '(.transcript_path // .transcriptPath // "") | tostring' 2>/dev/null || printf '')"
project_dir="$(printf '%s' "$payload" | jq -r '(.cwd // .project_dir // "") | tostring' 2>/dev/null || printf '')"

if [ -z "$session_id" ]; then
  warn "no session_id in payload — skipping"
  exit 0
fi
if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  warn "transcript not found ($transcript_path) — skipping"
  exit 0
fi

# --- find the first user message text --------------------------------------
# The transcript is JSONL, one record per line. We want the textual content
# of the first record whose role/type is "user" (shared grammar — see
# extract-dispatch-sentinel.sh).
first_user_text="$(extract_first_user_text "$transcript_path")"

if [ -z "$first_user_text" ]; then
  warn "no first user message — skipping"
  exit 0
fi

# --- extract the sentinel --------------------------------------------------
# Sentinel form (single line):
#   <!-- hydra-dispatch v1 skill={skill} dispatchId={id} runId={runId} -->
# runId is optional. We extract each field independently so field order and
# the presence/absence of runId don't matter.
sentinel_line="$(extract_sentinel_line "$first_user_text")"
if [ -z "$sentinel_line" ]; then
  # No sentinel — interactive operator session. Silent no-op.
  exit 0
fi

skill="$(extract_sentinel_field "$sentinel_line" skill)"
dispatch_id="$(extract_sentinel_field "$sentinel_line" dispatchId)"
run_id="$(extract_sentinel_field "$sentinel_line" runId)"

if [ -z "$skill" ] || [ -z "$dispatch_id" ]; then
  warn "malformed sentinel (skill='$skill' dispatchId='$dispatch_id') — skipping"
  exit 0
fi

# --- POST to the registry --------------------------------------------------
started_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

body="$(jq -nc \
  --arg sessionId "$session_id" \
  --arg skill "$skill" \
  --arg dispatchId "$dispatch_id" \
  --arg startedAt "$started_at" \
  --arg runId "$run_id" \
  --arg projectDir "$project_dir" \
  '{sessionId: $sessionId, skill: $skill, dispatchId: $dispatchId, startedAt: $startedAt}
   + (if ($runId | length) > 0 then {runId: $runId} else {} end)
   + (if ($projectDir | length) > 0 then {projectDir: $projectDir} else {} end)' \
  2>/dev/null || printf '')"

if [ -z "$body" ]; then
  warn "failed to build request body — skipping"
  exit 0
fi

if ! curl -fsS --max-time 5 \
  -X POST "$API_BASE/api/dispatches/subagent" \
  -H 'content-type: application/json' \
  -d "$body" >/dev/null 2>&1; then
  warn "POST to $API_BASE/api/dispatches/subagent failed — skipping"
  exit 0
fi

exit 0
