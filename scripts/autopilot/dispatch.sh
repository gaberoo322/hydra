#!/usr/bin/env bash
#
# dispatch.sh — Phase 5 helpers for /hydra-autopilot.
#
# Two subcommands, both behavior-preserving extractions from the
# playbook prose (issue #409):
#
#   log <class> <skill> <ts>
#       Append a one-line dispatch record to the nightly run log.
#
#   capacity-writeback <pr_number> <commit_sha> <skill> <files_json>
#       POST the post-merge capacity-ledger writeback for a dev_orch /
#       dev_target slot completion that reports a merged PR. Without
#       this, the orchestrator-share reads as 0 % and the capacity-floor
#       preference fires every turn.
#
# The dispatch heavy lifting (slot mutation, Agent() tool call, worktree-
# guard preamble injection) stays in playbook prose because it requires
# the Claude harness — bash can't invoke Agent. This script captures only
# the shell-pure helpers around dispatch.

set -uo pipefail

LOG="${HYDRA_AUTOPILOT_LOG:-/tmp/hydra-autopilot-nightly.log}"

cmd="${1:-}"
shift || true

case "$cmd" in
  log)
    class="${1:-?}"
    skill="${2:-?}"
    ts="${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
    printf 'dispatch %s %s %s\n' "$class" "$skill" "$ts" >> "$LOG"
    ;;
  capacity-writeback)
    pr_number="${1:-}"
    commit_sha="${2:-}"
    skill="${3:-}"
    files_json="${4:-[]}"
    if [ -z "$pr_number" ] || [ -z "$commit_sha" ] || [ -z "$skill" ]; then
      echo "dispatch.sh: capacity-writeback requires <pr> <sha> <skill> [files-json]" >&2
      exit 2
    fi
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'cycleId': 'pr-' + sys.argv[1],
    'commitSha': sys.argv[2],
    'filesChanged': json.loads(sys.argv[4]) if sys.argv[4] else [],
    'source': sys.argv[3],
}))
" "$pr_number" "$commit_sha" "$skill" "$files_json")
    hydra raw POST /capacity/orchestrator-merge --json "$payload" 2>&1 || {
      echo "[autopilot] dispatch: capacity writeback failed for pr=$pr_number (non-fatal)" >&2
    }
    ;;
  cycle-record)
    # Phase 6 helper (issue #430): record an autopilot-turn cycle outcome so
    # /api/cycle/history, /api/metrics, and the lifetime cycles-{run,merged,
    # failed} counters reflect post-PR-3 reality instead of frozen codex-era
    # data. Idempotent on cycleId — re-running with the same cycleId is a
    # no-op on the server, so retries don't double-count.
    #
    # Usage: dispatch.sh cycle-record <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms]
    cycle_id="${1:-}"
    status="${2:-}"
    skill="${3:-}"
    pr_number="${4:-}"
    task_title="${5:-}"
    anchor_ref="${6:-}"
    duration_ms="${7:-0}"
    if [ -z "$cycle_id" ] || [ -z "$status" ] || [ -z "$skill" ]; then
      echo "dispatch.sh: cycle-record requires <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms]" >&2
      exit 2
    fi
    # Anchor type is derived from the skill: dev_orch / dev_target subagents
    # consume work-queue anchors; QA / research / discover have their own
    # anchor vocabulary which the autopilot can fill in if needed.
    case "$skill" in
      hydra-dev|hydra-target-build) anchor_type="work-queue" ;;
      hydra-qa) anchor_type="qa-review" ;;
      hydra-research|hydra-issue-research|hydra-target-research) anchor_type="research" ;;
      *) anchor_type="$skill" ;;
    esac
    # Map status → task-counter buckets so /api/metrics sees the right
    # tasksMerged / tasksFailed / tasksAbandoned numbers without the caller
    # having to think about it.
    case "$status" in
      merged|completed|succeeded) tasks_merged=1; tasks_failed=0; tasks_abandoned=0 ;;
      failed|timeout|timed-out)   tasks_merged=0; tasks_failed=1; tasks_abandoned=0 ;;
      abandoned|aborted)          tasks_merged=0; tasks_failed=0; tasks_abandoned=1 ;;
      *)                          tasks_merged=0; tasks_failed=0; tasks_abandoned=0 ;;
    esac
    payload=$(python3 -c "
import json, sys
cycle_id, status, skill, pr_number, task_title, anchor_ref, duration_ms, anchor_type, tm, tf, ta = sys.argv[1:12]
body = {
    'cycleId': cycle_id,
    'status': status,
    'source': 'claude',
    'anchorType': anchor_type,
    'tasksAttempted': 1,
    'tasksMerged': int(tm),
    'tasksFailed': int(tf),
    'tasksAbandoned': int(ta),
    'totalDurationMs': int(duration_ms) if duration_ms else 0,
}
if pr_number:
    body['prNumber'] = pr_number
if task_title:
    body['taskTitle'] = task_title
if anchor_ref:
    body['anchorReference'] = anchor_ref
print(json.dumps(body))
" "$cycle_id" "$status" "$skill" "$pr_number" "$task_title" "$anchor_ref" "$duration_ms" "$anchor_type" "$tasks_merged" "$tasks_failed" "$tasks_abandoned")
    if command -v hydra >/dev/null 2>&1; then
      hydra raw POST /autopilot/cycle-record --json "$payload" >/dev/null 2>&1 || {
        echo "[autopilot] dispatch: cycle-record post failed for cycle=$cycle_id (non-fatal)" >&2
      }
    else
      # Fallback when `hydra` CLI is unavailable (e.g. CI smoke).
      curl -fsS -X POST -H "Content-Type: application/json" \
        --data "$payload" \
        "${HYDRA_API:-http://localhost:4000/api}/autopilot/cycle-record" >/dev/null 2>&1 || {
        echo "[autopilot] dispatch: cycle-record curl failed for cycle=$cycle_id (non-fatal)" >&2
      }
    fi
    ;;
  ""|help|-h|--help)
    cat <<'USAGE'
Usage:
  dispatch.sh log <class> <skill> [ts]
  dispatch.sh capacity-writeback <pr_number> <commit_sha> <skill> <files_json>
  dispatch.sh cycle-record <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms]

Environment:
  HYDRA_AUTOPILOT_LOG   Path to the nightly run log
                        (default /tmp/hydra-autopilot-nightly.log)
  HYDRA_API             Base URL for the orchestrator API
                        (default http://localhost:4000/api)
USAGE
    ;;
  *)
    echo "dispatch.sh: unknown subcommand '$cmd'" >&2
    exit 2
    ;;
esac
