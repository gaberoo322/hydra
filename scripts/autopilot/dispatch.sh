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
  ""|help|-h|--help)
    cat <<'USAGE'
Usage:
  dispatch.sh log <class> <skill> [ts]
  dispatch.sh capacity-writeback <pr_number> <commit_sha> <skill> <files_json>

Environment:
  HYDRA_AUTOPILOT_LOG   Path to the nightly run log
                        (default /tmp/hydra-autopilot-nightly.log)
USAGE
    ;;
  *)
    echo "dispatch.sh: unknown subcommand '$cmd'" >&2
    exit 2
    ;;
esac
