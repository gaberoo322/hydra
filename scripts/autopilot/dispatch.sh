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
    # Usage: dispatch.sh cycle-record <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms] [reflection_sources] [files_changed] [grounding_tests_json]
    #
    # Issue #1136 (Slice 2 of #1119): the optional 8th positional arg
    # `reflection_sources` is the comma-separated reflection bucket tokens
    # (`per-anchor` / `by-file` / ...) the code-writing dispatch was SERVED at
    # planning time. reap.py reads it from a task-scoped deposit file and passes
    # it here so the cycle metric records what was actually injected, instead of
    # `deriveReflectionMatchSource` reading 'none' on every cycle. Empty/absent
    # → the field is omitted from the POST body (truthful 'none').
    #
    # Issue #2063: the optional 9th positional arg `files_changed` is the INTEGER
    # COUNT of files the merged PR changed. It is only knowable on the merged/
    # auto-merge follow-up write (the PR number is unknown at reap time, so the
    # reap-time write omits it). The auto-merge follow-up fetches it with
    # `gh pr view <pr> --json files --jq '.files | length'` and forwards it here;
    # recordCycle ENRICHES the already-recorded cycle's metrics hash with it
    # WITHOUT re-firing any lifetime counter. Empty/absent → omitted from the
    # POST body (truthful "unknown/never-written"); an explicit 0 records a
    # measured zero-file cycle. This is the integer count the metrics trend
    # consumes — NOT the string[] path list capacity-writeback sends.
    # Issue #2754: the optional 10th positional arg `grounding_tests` is a compact
    # JSON object of the code-writing dispatch's grounding test-suite counts
    # ({"testsBefore":N,"testsAfter":N,"testsPassingBefore":N,"testsPassingAfter":N};
    # any subset). reap.py reads it from a task-scoped deposit and passes it here so
    # `testsAfter` stops recording 0 on every cycle. Empty/absent → all four fields
    # omitted from the POST body (truthful "unknown"); an explicit 0 records a
    # measured zero-test cycle. NUMERIC on the read side (aggregate.ts / trend.ts).
    cycle_id="${1:-}"
    status="${2:-}"
    skill="${3:-}"
    pr_number="${4:-}"
    task_title="${5:-}"
    anchor_ref="${6:-}"
    duration_ms="${7:-0}"
    reflection_sources="${8:-}"
    files_changed="${9:-}"
    grounding_tests="${10:-}"
    if [ -z "$cycle_id" ] || [ -z "$status" ] || [ -z "$skill" ]; then
      echo "dispatch.sh: cycle-record requires <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms] [reflection_sources] [files_changed] [grounding_tests_json]" >&2
      exit 2
    fi
    # Anchor type is derived from the skill: dev_orch / dev_target subagents
    # consume work-queue anchors; QA / research / discover have their own
    # anchor vocabulary which the autopilot can fill in if needed.
    #
    # Issue #2689: every cycle-record MUST carry an EXPLICIT, mapped anchorType.
    # `hydra-grill` is the third skill reap.py's CYCLE_RECORD_SKILLS forwards, so
    # it gets a first-class `grill` mapping here rather than falling through. The
    # `*)` fallback no longer emits the bare `$skill` (or, worse, an empty string
    # when $skill is somehow blank) — an empty/whitespace anchorType is what the
    # metrics aggregator (src/metrics/aggregate.ts) buckets as "unknown", the
    # data-quality failure this change exists to eliminate (24% of cycles were
    # invisible to metrics). Instead the fallback emits a diagnostic on stderr AND
    # a self-describing `unmapped:<skill>` sentinel — never empty, always traceable
    # back to the exact skill that needs a first-class mapping added above.
    case "$skill" in
      hydra-dev|hydra-target-build) anchor_type="work-queue" ;;
      hydra-qa) anchor_type="qa-review" ;;
      hydra-grill) anchor_type="grill" ;;
      hydra-research|hydra-issue-research|hydra-target-research) anchor_type="research" ;;
      *)
        # A skill with no first-class mapping. Emit a diagnostic so the gap is
        # visible (and actionable — add a case above), and record a non-empty,
        # self-describing sentinel so the cycle is NEVER bucketed as "unknown".
        # A blank $skill (shouldn't happen — it's validated non-empty above)
        # degrades to a bare "unmapped" rather than an empty string.
        echo "[autopilot] dispatch: cycle-record skill '$skill' has no anchor_type mapping — recording 'unmapped:$skill' (add a case in dispatch.sh)" >&2
        if [ -n "$skill" ]; then
          anchor_type="unmapped:$skill"
        else
          anchor_type="unmapped"
        fi
        ;;
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
cycle_id, status, skill, pr_number, task_title, anchor_ref, duration_ms, anchor_type, tm, tf, ta, reflection_sources, files_changed, grounding_tests = sys.argv[1:15]
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
# Issue #1136: only emit reflectionSources when the dispatch reported a
# non-empty served-bucket string; absent → field omitted → truthful 'none'.
if reflection_sources:
    body['reflectionSources'] = reflection_sources
# Issue #2063: only emit filesChanged when the caller passed a non-empty,
# parseable non-negative integer count (the merged-path follow-up write that
# knows the PR). Empty/absent → omitted (truthful 'unknown'); an explicit '0'
# DOES emit (a measured zero-file cycle, distinct from never-written).
if files_changed != '':
    try:
        fc = int(files_changed)
        if fc >= 0:
            body['filesChanged'] = fc
    except (TypeError, ValueError):
        pass
# Issue #2754: merge the grounding test-suite counts. Empty/absent → all four
# fields omitted (truthful 'unknown'); an explicit non-negative integer (incl. 0)
# for any subset is recorded. A malformed JSON blob or a non-integer / negative
# value for a key is silently dropped for that key — never blocks the write.
if grounding_tests != '':
    try:
        gt = json.loads(grounding_tests)
        if isinstance(gt, dict):
            for key in ('testsBefore', 'testsAfter', 'testsPassingBefore', 'testsPassingAfter'):
                val = gt.get(key)
                if isinstance(val, bool):
                    continue  # bool is an int subclass — reject it explicitly
                try:
                    n = int(val)
                    if n >= 0:
                        body[key] = n
                except (TypeError, ValueError):
                    pass
    except (TypeError, ValueError):
        pass
print(json.dumps(body))
" "$cycle_id" "$status" "$skill" "$pr_number" "$task_title" "$anchor_ref" "$duration_ms" "$anchor_type" "$tasks_merged" "$tasks_failed" "$tasks_abandoned" "$reflection_sources" "$files_changed" "$grounding_tests")
    # Issue #2635: the rest of the autopilot ecosystem (reap.py, heartbeat.py,
    # term-check.py, decide.py, bootstrap.sh, the hooks) resolves the API origin
    # from HYDRA_API_BASE, but the `hydra` CLI reads HYDRA_BASE_URL and the curl
    # fallback reads HYDRA_API — neither honours HYDRA_API_BASE. Tests (and any
    # isolated harness) set HYDRA_API_BASE=http://127.0.0.1:1 to sink writes into
    # a dead socket; without this propagation the cycle-record POST leaked to the
    # live orchestrator on :4000, injecting test-fixture cycle IDs into the
    # production metrics window. Bridge HYDRA_API_BASE onto both call paths so a
    # single env var isolates every cycle-record write. HYDRA_API_BASE is the
    # bare origin (no /api); the curl fallback appends its own /api path segment,
    # so we suffix it here to keep the existing endpoint shape.
    if command -v hydra >/dev/null 2>&1; then
      HYDRA_BASE_URL="${HYDRA_API_BASE:-${HYDRA_BASE_URL:-http://localhost:4000}}" \
        hydra raw POST /autopilot/cycle-record --json "$payload" >/dev/null 2>&1 || {
        echo "[autopilot] dispatch: cycle-record post failed for cycle=$cycle_id (non-fatal)" >&2
      }
    else
      # Fallback when `hydra` CLI is unavailable (e.g. CI smoke). HYDRA_API_BASE
      # is a bare origin, so append /api to match the endpoint prefix; otherwise
      # keep honouring the legacy HYDRA_API (which already includes /api).
      if [ -n "${HYDRA_API_BASE:-}" ]; then
        cycle_record_url="${HYDRA_API_BASE}/api/autopilot/cycle-record"
      else
        cycle_record_url="${HYDRA_API:-http://localhost:4000/api}/autopilot/cycle-record"
      fi
      curl -fsS -X POST -H "Content-Type: application/json" \
        --data "$payload" \
        "$cycle_record_url" >/dev/null 2>&1 || {
        echo "[autopilot] dispatch: cycle-record curl failed for cycle=$cycle_id (non-fatal)" >&2
      }
    fi
    ;;
  ""|help|-h|--help)
    cat <<'USAGE'
Usage:
  dispatch.sh log <class> <skill> [ts]
  dispatch.sh capacity-writeback <pr_number> <commit_sha> <skill> <files_json>
  dispatch.sh cycle-record <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms] [reflection_sources] [files_changed]

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
