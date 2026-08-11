#!/usr/bin/env bash
#
# recover-stale.sh — Phase 1.5 of /hydra-autopilot.
#
# Auto-recover stale issues on the orchestrator board:
#   * stale in-progress (>90 min)   → re-queue as ready-for-agent
#   * stale blocked    (>12h, all blockers closed) → re-queue
#
# The caller passes the lists Phase 1 produced as positional args:
#
#   recover-stale.sh stale_in_progress <ISSUE...> -- stale_blocked <ISSUE...>
#
# Either list may be empty. The script never aborts on a single failed
# `gh` call — it logs and continues so one bad issue doesn't strand the
# whole turn.
#
# Behavior-preserving extraction of the Phase 1.5 heredocs (issue #409).

set -uo pipefail

REPO="${HYDRA_AUTOPILOT_REPO:-gaberoo322/hydra}"

# Directory of this script — pr-refs.py (the shared reference predicate) lives
# next to it (issue #3852). Resolved to an absolute path so the predicate is
# found regardless of how $0 was passed (relative invocation, worktree path).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# Calendar guard (issue #838).
#
# Some stale `blocked` issues are calendar-blocked, not blocker-reference
# blocked — e.g. #664 ("Do not start before 2026-06-10"). All of its `#N`
# references are CLOSED, so the all-blockers-closed heuristic below would
# wrongly re-queue it before its promised start date.
#
# `calendar_block_future` scans the WHOLE issue body (case-insensitive) for a
# YYYY-MM-DD date adjacent to a calendar cue token, and echoes the LATEST date
# that is still in the FUTURE (UTC). Empty output ⇒ no future calendar block ⇒
# the issue stays eligible for normal blocker-reference recovery.
#
# Cue tokens (case-insensitive):
#   * "do not start before"   (inline body marker; #664 uses it bolded)
#   * "calendar:"             (a `## Blocked by` → `Calendar:` line)
#   * "blocked-until:"        (explicit machine marker)
#
# A date counts as "adjacent" to a cue if it appears anywhere from the cue
# token to the end of that same line. Markdown emphasis (`**`) and trailing
# punctuation around the date are tolerated because we extract the bare
# YYYY-MM-DD with a regex rather than word-splitting.
calendar_block_future() {
  local body="$1"
  local now_epoch latest_epoch="" latest_date="" line date_epoch d
  now_epoch=$(date -u +%s)

  # Iterate line-by-line so a cue and its date must share a line.
  while IFS= read -r line; do
    # Lowercase copy for cue detection only (dates have no letters).
    local lc="${line,,}"
    case "$lc" in
      *"do not start before"*|*"calendar:"*|*"blocked-until:"*) ;;
      *) continue ;;
    esac
    # Extract every YYYY-MM-DD on the cue line (grep -o; one per output line).
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      # date -u rejects malformed dates (e.g. 2026-13-40) → skip them.
      if date_epoch=$(date -u -d "$d" +%s 2>/dev/null); then
        if [ "$date_epoch" -gt "$now_epoch" ]; then
          # Keep the latest future date (most conservative).
          if [ -z "$latest_epoch" ] || [ "$date_epoch" -gt "$latest_epoch" ]; then
            latest_epoch="$date_epoch"
            latest_date="$d"
          fi
        fi
      fi
    done < <(printf '%s\n' "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
  done < <(printf '%s\n' "$body")

  [ -n "$latest_date" ] && printf '%s\n' "$latest_date"
}

# Split args on the literal `--` separator. Defensive: missing separator
# means "all in-progress, no blocked".
STALE_IN_PROGRESS=()
STALE_BLOCKED=()
mode="in_progress"
saw_in_progress_header=0
saw_blocked_header=0
for arg in "$@"; do
  case "$arg" in
    stale_in_progress) mode="in_progress"; saw_in_progress_header=1 ;;
    stale_blocked)     mode="blocked";     saw_blocked_header=1 ;;
    --)                mode="blocked" ;;  # legacy separator
    *)
      if [ "$mode" = "in_progress" ]; then
        STALE_IN_PROGRESS+=("$arg")
      else
        STALE_BLOCKED+=("$arg")
      fi
      ;;
  esac
done

# Space-separated membership over the pr-refs.py output (e.g. "123 456 789").
# Empty haystack ⇒ no open PR references the issue ⇒ keep today's behaviour.
inflight_contains() {
  local haystack="$1" needle="$2" x
  [ -z "$haystack" ] && return 1
  [ -z "$needle" ] && return 1
  for x in $haystack; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

# Stale in-progress: re-queue — guarded by an open-PR check (issue #3852).
#
# A stale `in-progress` issue may be idle because it is FINISHED and waiting on
# review, not because dev stalled — an open PR already implements it. Demoting
# such an issue straight to `ready-for-agent` hands it back to dev_orch as fresh
# work and manufactures a DUPLICATE implementation of an already-open PR
# (observed: #3689 was demoted while its PR #3836 sat open and clean). So before
# demoting, check for an open PR that references the issue; on a hit, route to
# `needs-qa` (it is awaiting review, not stalled in dev) and comment.
#
# The reference predicate lives in ONE place — scripts/autopilot/pr-refs.py
# (branch-prefix + keyword-in-body regex, INCLUDING the non-closing `Refs #N`
# form). collect-state.sh's in-flight exclusion has the same shape but misses
# `Refs #N`; this script is the broader of the two until collect-state.sh adopts
# the shared file (separately-filed gap).
#
# Never-abort contract (mirrors the rest of this script): a failed `gh pr list`
# or a pr-refs.py parse error yields an EMPTY referenced-issue set, so every
# issue falls through to today's ready-for-agent relabel. A transient gh outage
# never strands the turn.
INFLIGHT_PR_ISSUES=""
if [ "${#STALE_IN_PROGRESS[@]}" -gt 0 ]; then
  PR_JSON=$(gh pr list --repo "$REPO" --state open --limit "${GH_ISSUE_LIST_LIMIT:-100}" \
    --json headRefName,body 2>/dev/null || true)
  if [ -n "$PR_JSON" ]; then
    INFLIGHT_PR_ISSUES=$(printf '%s' "$PR_JSON" \
      | python3 "$SCRIPT_DIR/pr-refs.py" 2>/dev/null || true)
  fi
fi

for ISSUE in "${STALE_IN_PROGRESS[@]:-}"; do
  [ -z "$ISSUE" ] && continue
  if inflight_contains "$INFLIGHT_PR_ISSUES" "$ISSUE"; then
    # An open PR already references this issue → awaiting review, not stalled.
    if gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label needs-qa 2>/dev/null; then
      gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Routed to needs-qa — an open PR already references this issue (recover-stale open-PR guard, #3852)." 2>/dev/null || true
      echo "[autopilot] recover-stale: routed in-progress→needs-qa issue=$ISSUE (open PR references it)"
    else
      echo "[autopilot] recover-stale: skip issue=$ISSUE (gh edit failed)"
    fi
  else
    if gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null; then
      gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Re-queued. >90 min idle in in-progress." 2>/dev/null || true
      echo "[autopilot] recover-stale: re-queued in-progress issue=$ISSUE"
    else
      echo "[autopilot] recover-stale: skip issue=$ISSUE (gh edit failed)"
    fi
  fi
done

# Stale blocked: check that ALL blockers are closed before re-queueing.
for ISSUE in "${STALE_BLOCKED[@]:-}"; do
  [ -z "$ISSUE" ] && continue
  BODY=$(gh issue view "$ISSUE" --repo "$REPO" --json body --jq '.body' 2>/dev/null)

  # Calendar guard (issue #838): never unblock while a future calendar date
  # is present in the body. Past/today dates don't gate; absence doesn't gate.
  FUTURE_DATE=$(calendar_block_future "$BODY")
  if [ -n "$FUTURE_DATE" ]; then
    echo "[autopilot] recover-stale: skip issue=$ISSUE (calendar-blocked until $FUTURE_DATE)"
    continue
  fi

  BLOCKERS=$(printf '%s\n' "$BODY" | grep -oP '(?<=#)\d+' | head -20)
  ALL_CLOSED=true
  for b in $BLOCKERS; do
    STATE=$(gh issue view "$b" --repo "$REPO" --json state --jq '.state' 2>/dev/null)
    [ "$STATE" != "CLOSED" ] && ALL_CLOSED=false && break
  done
  if [ "$ALL_CLOSED" = true ]; then
    if gh issue edit "$ISSUE" --repo "$REPO" --remove-label blocked --add-label ready-for-agent 2>/dev/null; then
      echo "[autopilot] recover-stale: unblocked issue=$ISSUE (all blockers closed)"
    else
      echo "[autopilot] recover-stale: skip issue=$ISSUE (gh edit failed)"
    fi
  fi
done
