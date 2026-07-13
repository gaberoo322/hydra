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
    # Usage: dispatch.sh cycle-record <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms] [reflection_sources] [files_changed] [grounding_tests_json] [tokens] [worktree_branch] [escalation_json]
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
    # Issue #2942: the optional 11th positional arg `tokens` is the dispatch's
    # total token spend — reap.py's run_completion already holds the
    # authoritative total_tokens and forwards it here so the durable
    # per-dispatch outcome record (recordCycle → src/redis/dispatch-outcomes.ts)
    # carries a cost figure. Only a POSITIVE integer is emitted: reap reports 0
    # when no usage was parsed, which is "unknown" not "measured zero", so 0/
    # empty/absent are all omitted and recordCycle falls back to the per-cycle
    # token hash before recording a truthful null.
    # Issue #3252: the optional 12th positional arg `worktree_branch` is the
    # dispatch's synthesised worktree branch (`worktree-agent-<runToken>-t<N>-<slot>`).
    # reap.py forwards it so recordCycleMetrics can mirror the grounding test
    # counts onto the SEPARATE branch-keyed metrics record the merge-watch
    # enrichment + dashboards read (reap's cycle-record is keyed on the bare
    # worktree-hash task_id — an un-joinable id — so `testsAfter` recorded 0 on
    # the sampled record every cycle). Empty/absent → the field is omitted from
    # the POST body → recordCycleMetrics does no mirror (prior behaviour).
    # Issue #3284: the optional 13th positional arg `escalation` is a compact JSON
    # object of the dispatch's cascade-routing escalation provenance
    # ({"escalationAttempt":N,"escalatedModel":"sonnet"}), present ONLY when
    # decide.py's `_rule_escalation` re-dispatched this cheap-tier class at a
    # stronger model. reap.py reads it from a task-scoped deposit and forwards it
    # here so the durable per-dispatch outcome record (#2942) tags the escalated
    # attempt — letting /metrics/cascade-routing derive cost-delta from this
    # dispatch's ACTUAL recorded tokens (design-concept invariant 7) and report
    # postEscalationMergeRate (invariant 8). Empty/absent → both fields omitted
    # from the POST body (truthful "not an escalation").
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
    tokens="${11:-}"
    worktree_branch="${12:-}"
    escalation="${13:-}"
    if [ -z "$cycle_id" ] || [ -z "$status" ] || [ -z "$skill" ]; then
      echo "dispatch.sh: cycle-record requires <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms] [reflection_sources] [files_changed] [grounding_tests_json] [tokens] [worktree_branch] [escalation_json]" >&2
      exit 2
    fi
    # Issue #2852: defence-in-depth — fail loud at the shell BEFORE building the
    # POST body if any of the three REQUIRED positional args resolved to a
    # `--`-prefixed CLI-flag token. This is the argument-parsing-failure class
    # the issue observed: a dropped/empty interpolation shifts flag names left so
    # `--cycle-id` / `--status` / `--skill` land in the value slots. The durable
    # fix is the CycleRecordBodySchema `.superRefine()` (every HTTP caller funnels
    # through it); this guard mirrors the empty-arg check above so a malformed
    # LOCAL invocation fails non-zero here instead of silently POSTing garbage
    # (friction cue: metrics-record-cli-arg-leak).
    for _arg_name in cycle_id status skill; do
      eval "_arg_val=\${$_arg_name}"
      case "$_arg_val" in
        --*)
          echo "dispatch.sh: cycle-record $_arg_name value '$_arg_val' looks like a CLI flag (starts with '--') — refusing to record a malformed cycle (issue #2852)" >&2
          exit 2
          ;;
      esac
    done
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
cycle_id, status, skill, pr_number, task_title, anchor_ref, duration_ms, anchor_type, tm, tf, ta, reflection_sources, files_changed, grounding_tests, tokens, worktree_branch, escalation = sys.argv[1:18]
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
# Issue #2942: only emit tokens when the caller passed a parseable POSITIVE
# integer. reap reports 0 when no usage was parsed — that is 'unknown', not a
# measured zero, so 0/empty/absent are all omitted and recordCycle's write-time
# fallback (the per-cycle token hash) gets its chance before a truthful null.
if tokens != '':
    try:
        tk = int(tokens)
        if tk > 0:
            body['tokens'] = tk
    except (TypeError, ValueError):
        pass
# Issue #3252: emit worktreeBranch when reap forwarded a non-empty one so
# recordCycleMetrics can mirror the grounding test counts onto the branch-keyed
# record dashboards read. Empty/absent → omitted → no mirror (prior behaviour).
if worktree_branch:
    body['worktreeBranch'] = worktree_branch
# Issue #3284: merge the cascade-routing escalation provenance. Present ONLY on
# an escalated re-dispatch. escalationAttempt must be a POSITIVE integer (>= 2 in
# practice — the cheap tier ran attempt 1); escalatedModel a non-empty string.
# Empty/absent/malformed → both fields omitted (truthful 'not an escalation'),
# so recordCycle records null provenance for the overwhelming non-escalation
# majority and never fabricates a marker.
if escalation != '':
    try:
        esc = json.loads(escalation)
        if isinstance(esc, dict):
            attempt = esc.get('escalationAttempt')
            if not isinstance(attempt, bool):
                try:
                    n = int(attempt)
                    if n > 0:
                        body['escalationAttempt'] = n
                except (TypeError, ValueError):
                    pass
            model = esc.get('escalatedModel')
            if isinstance(model, str) and model:
                body['escalatedModel'] = model
    except (TypeError, ValueError):
        pass
print(json.dumps(body))
" "$cycle_id" "$status" "$skill" "$pr_number" "$task_title" "$anchor_ref" "$duration_ms" "$anchor_type" "$tasks_merged" "$tasks_failed" "$tasks_abandoned" "$reflection_sources" "$files_changed" "$grounding_tests" "$tokens" "$worktree_branch" "$escalation")
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
  holdback-pending)
    # Phase 6 helper (issue #3078): register a PR the autopilot has ARMED for
    # auto-merge but that has not yet landed into the pending-enroll registry
    # (hydra:holdback:pending-enroll), via POST /api/holdback/pending. This is
    # the deterministic replacement for the drop-prone inlined `curl … | jq …`
    # arming step the phase6-ops fragment previously specified: the Outcome
    # Attribution Spine ledger went 7+ days dark because that best-effort LLM-
    # remembered POST was silently dropped with no backstop (#3078). Moving it
    # behind a single audited subcommand (mirroring `cycle-record` /
    # `capacity-writeback`) makes the common-path arming reliable; the
    # cycle-merge-reconcile chore is the eventual-consistency backstop for any
    # arm that is still dropped.
    #
    # Records intent ONLY — it never arms, blocks, delays, or performs a merge.
    # Idempotent on prNumber server-side (HSET-in-place). Best-effort: a non-2xx
    # or unreachable endpoint is logged non-fatally and the autopilot proceeds —
    # arming NEVER blocks a merge (the merge is already armed by `gh pr merge`).
    #
    # Usage: dispatch.sh holdback-pending <pr_number> <tier> <cycle_id> [anchor_type]
    #   <tier>       integer 1–4, or the literal `null` / empty for unknown-tier.
    #                enrollHoldback enforces the T1/unknown-tier carry-up exemption
    #                SERVER-SIDE — do NOT filter tiers here (invariant: no client-
    #                side `if tier in {2,3,4}` guard, #3078).
    #   [anchor_type] optional explicit dispatch-class anchorType (#2800); omitted
    #                → the merge-watch enrichment infers, then `unclassified`.
    pr_number="${1:-}"
    tier="${2:-}"
    cycle_id="${3:-}"
    anchor_type="${4:-}"
    if [ -z "$pr_number" ] || [ -z "$cycle_id" ]; then
      echo "dispatch.sh: holdback-pending requires <pr_number> <tier> <cycle_id> [anchor_type]" >&2
      exit 2
    fi
    payload=$(python3 -c "
import json, sys
pr_number, tier, cycle_id, anchor_type = sys.argv[1:5]
try:
    pr = int(pr_number)
except (TypeError, ValueError):
    sys.stderr.write('dispatch.sh: holdback-pending pr_number must be an integer\n')
    sys.exit(2)
# tier: the literal 'null' / '' → JSON null (unknown-tier, exempt server-side);
# otherwise an integer that the schema (z.number().int().min(1).max(4).nullable())
# validates — a bad value is surfaced as a 400, never silently coerced.
if tier in ('', 'null', 'None'):
    tier_val = None
else:
    try:
        tier_val = int(tier)
    except (TypeError, ValueError):
        sys.stderr.write('dispatch.sh: holdback-pending tier must be an integer 1-4 or null\n')
        sys.exit(2)
body = {'prNumber': pr, 'tier': tier_val, 'cycleId': cycle_id}
# Only emit anchorType when the caller supplied one — omitting the field lets a
# legacy/omitting caller degrade to the prior inference-then-'unclassified' path.
if anchor_type:
    body['anchorType'] = anchor_type
print(json.dumps(body))
" "$pr_number" "$tier" "$cycle_id" "$anchor_type") || exit 2
    # Same HYDRA_API_BASE / HYDRA_BASE_URL / HYDRA_API resolution as cycle-record
    # (#2635): a single env var isolates every arming write in tests, and the
    # bare-origin base needs the /api segment appended on the curl fallback.
    if command -v hydra >/dev/null 2>&1; then
      HYDRA_BASE_URL="${HYDRA_API_BASE:-${HYDRA_BASE_URL:-http://localhost:4000}}" \
        hydra raw POST /holdback/pending --json "$payload" >/dev/null 2>&1 || {
        echo "[autopilot] dispatch: holdback-pending post failed for pr=$pr_number (non-fatal — merge already armed)" >&2
      }
    else
      if [ -n "${HYDRA_API_BASE:-}" ]; then
        holdback_pending_url="${HYDRA_API_BASE}/api/holdback/pending"
      else
        holdback_pending_url="${HYDRA_API:-http://localhost:4000/api}/holdback/pending"
      fi
      curl -fsS -X POST -H "Content-Type: application/json" \
        --data "$payload" \
        "$holdback_pending_url" >/dev/null 2>&1 || {
        echo "[autopilot] dispatch: holdback-pending curl failed for pr=$pr_number (non-fatal — merge already armed)" >&2
      }
    fi
    ;;
  ""|help|-h|--help)
    cat <<'USAGE'
Usage:
  dispatch.sh log <class> <skill> [ts]
  dispatch.sh capacity-writeback <pr_number> <commit_sha> <skill> <files_json>
  dispatch.sh cycle-record <cycle_id> <status> <skill> [pr_number] [task_title] [anchor_ref] [duration_ms] [reflection_sources] [files_changed] [grounding_tests_json] [tokens]
  dispatch.sh holdback-pending <pr_number> <tier> <cycle_id> [anchor_type]

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
