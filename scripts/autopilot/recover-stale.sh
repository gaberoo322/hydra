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

# Stale in-progress: re-queue.
for ISSUE in "${STALE_IN_PROGRESS[@]:-}"; do
  [ -z "$ISSUE" ] && continue
  if gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null; then
    gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Re-queued. >90 min idle in in-progress." 2>/dev/null || true
    echo "[autopilot] recover-stale: re-queued in-progress issue=$ISSUE"
  else
    echo "[autopilot] recover-stale: skip issue=$ISSUE (gh edit failed)"
  fi
done

# Stale blocked: check that ALL blockers are closed before re-queueing.
for ISSUE in "${STALE_BLOCKED[@]:-}"; do
  [ -z "$ISSUE" ] && continue
  BLOCKERS=$(gh issue view "$ISSUE" --repo "$REPO" --json body --jq '.body' 2>/dev/null | grep -oP '(?<=#)\d+' | head -20)
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
