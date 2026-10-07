#!/usr/bin/env bash
#
# collect-state.sh — Phase 1 of /hydra-autopilot.
#
# Cheap state collectors (~100ms total). Emits one line per signal to
# stdout; the calling Claude turn reads these as compact decision input.
# Never dumps raw responses — counts and short summaries only.
#
# This script is read-only: no Redis writes, no GitHub edits.
#
# Behavior-preserving extraction of the Phase 1 collectors (issue #409).
#
# Forcing a research cycle (issue #2489): there is no longer an HTTP lever for
# this. The old POST /research/force endpoint wrote a Redis one-shot flag
# (hydra:scheduler:research-force-once) whose consumer was deleted with the
# in-process research loop in #706; the orphaned write end was retired in #2489.
# To force research today, drive it through the autopilot brain: decide.py's
# daily research-force cap (_research_force_allowed / _research_force_stamp)
# governs forced research_target dispatches, or write the work-queue directly
# (POST /api/queue) to push a research anchor to the front of the next turn.
# This collector deliberately does NOT read or surface a force flag — it stays
# read-only and the policy lives in decide.py, not at the HTTP seam.

set -uo pipefail

# Directory of this script — pr-refs.py (the shared reference predicate,
# issue #3852) lives next to it. Resolved to an absolute path so the
# predicate is found regardless of how $0 was passed (relative invocation,
# worktree path), mirroring recover-stale.sh's idiom.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)

# Shared page size for EVERY `gh issue list` in this script (issue #3710).
#
# `gh issue list` defaults to 30 results with no warning, so an unlimited call
# silently truncates once a board exceeds 30 — and because gh sorts
# newest-first it drops the OLDEST issues, which is exactly the cohort the
# age-sensitive consumers (wire-or-retire's 45-day ledger, the backfill-idle
# checks) care about. The Target board was already past 30 when this was
# filed, so five open issues were invisible on every turn.
#
# 100 is the GitHub API's maximum single-page size: the largest value
# obtainable in ONE request on a per-turn hot path, and the same value as
# `DEFAULT_LIMIT` in src/github/issues.ts, so the degraded shell path and the
# healthy API path agree by construction. Deliberately NOT `--paginate` — that
# would trade a silent truncation for unbounded per-turn latency and
# rate-limit cost. Breaching 100 is made observable instead, via
# `target_board_signals_truncated` (see the Target board block below).
#
# One constant, referenced everywhere: nine literals would drift apart.
GH_ISSUE_LIST_LIMIT="${HYDRA_GH_ISSUE_LIST_LIMIT:-100}"

# STRUCTURE (issue #4266): every collector is a named `collect_*` function and
# `main` (at the bottom) calls them in the fixed order that defines the emitted
# key=value stream — that order IS the public interface decide.py and the
# playbook read, so never reorder calls casually. Function bodies are
# deliberately NOT indented: the inline python heredocs need their `PY` body and
# terminator at column 0, and several tests slice this file's text by exact
# markers (see test/collect-state-target-risk-surface-pipefail.test.mts), so the bodies stay
# byte-identical to their pre-decomposition form. Cross-collector values
# (ORCH_*, BOARD_STATE_*, TARGET_*, ARCH_WORK_QUEUE, ...) are globals assigned in
# place; never pre-declare them in a shared init block (it would move the
# first-occurrence markers those tests key on). `main` runs only when the script
# is executed, not when sourced, so a test can source it and call one collector.

# HEALTH + DIRECTION DRIFT — Turn Snapshot collectors (ADR-0043 slice 5,
# issue #4933). collect_health + collect_direction_drift (and their heredoc)
# are now the typed `health` and `direction-drift` collectors in
# src/autopilot/turn-snapshot/passthrough.ts, run by the one-shot CLI and
# rendered byte-identically by render-kv-passthrough.ts (golden files under
# test/fixtures/turn-snapshot/passthrough/). Semantics are unchanged:
#   - health=<status> redis=<redis> from GET /api/health (health=FAIL when
#     unreadable); failed_services=<failed systemd user units matching hydra>
#     (the legacy pipefail quirk — a second `0` line on a zero count — is kept).
#   - direction_drift (#1791): true when a readable live Target direction doc
#     ($HYDRA_TARGET_REPO/direction/{priorities,roadmap}.md, else the Target
#     workspace from src/target-config.ts) differs from its readable committed
#     copy under ${HYDRA_CONFIG_PATH:-$HOME/hydra/config}/direction; a missing
#     side never drifts (fail closed to no-drift). READ-ONLY — the canonical
#     refresh is documented in docs/operator-playbooks/hydra-target-build.md.
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note.
collect_turn_snapshot_health() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors health,direction-drift --format kv) \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "orch turn-snapshot health/direction-drift CLI failed or produced no output — emitting the fail-open fallback (issue #4933)" >&2
  printf '%s\n' $'health=FAIL\nfailed_services=0\n0\ndirection_drift=false'
fi
return 0
}

# Target identity (ADR-0002 / ADR-0013, CSB swap map #4313): the services
# export HYDRA_TARGET_GITHUB_REPO and HYDRA_TARGET_REPO. When a caller's env
# lacks either, resolve through the ONE seam that owns the defaults —
# src/target-config.ts via scripts/target/print-target-facts.ts — never a Target
# literal. JSON mode exits 1 on a manifest failure but still prints identity,
# so its exit code is ignored; an unresolvable seam logs and yields "".
# Resolved lazily, at most once per run, by each collector that needs it — so a
# test that sources this file and calls a single collector still gets it.
_target_facts_json=""
_target_facts_resolved=""
resolve_target_facts() {
[ -z "$_target_facts_resolved" ] || return 0
_target_facts_resolved=1
if [ -z "${HYDRA_TARGET_GITHUB_REPO:-}" ] || [ -z "${HYDRA_TARGET_REPO:-}" ]; then
  _target_facts_json=$(cd "$SCRIPT_DIR/../.." && npx tsx scripts/target/print-target-facts.ts 2>/dev/null) || true
  [ -n "$_target_facts_json" ] || echo "collect-state: target seam unresolved (print-target-facts.ts printed nothing)" >&2
fi
}
_target_fact() { printf '%s' "$_target_facts_json" | jq -r --arg k "$1" '.[$k] // empty' 2>/dev/null; }

# ORCH BOARD — a Turn Snapshot collector (ADR-0043 slice 2, issue #4930). The
# logic that lived here as collect_orch_board (two python heredocs and the
# degraded-path jq re-implementation of deriveBoardState with its own copy of
# the in-progress/blocked stale windows) is now the typed `orch-board` collector in
# src/autopilot/turn-snapshot/orch-board.ts, run by the one-shot CLI
# scripts/autopilot/turn-snapshot.ts and rendered BYTE-IDENTICALLY by its `kv`
# renderer (golden files test/fixtures/turn-snapshot/orch-board-*.json). The
# module docblock carries the rules; in short:
#   - emits the board-state JSON counts line, keys=['needs_qa','ready_for_agent','needs_triage','needs_research','in_progress','blocked','stale_in_progress','stale_blocked']
#     (the NON_KV_PRODUCERS anchor), then orch_needs_triage_items (#3939).
#     `ready_for_agent` > 0 → state.signals.orch_work_available → dev_orch
#     (#458); `needs_qa` counts ISSUES still awaiting review (hydra-qa clears
#     the label once it files a verdict, #638).
#   - PRIMARY read: GET /autopilot/board-state through the hydra HTTP adapter
#     (#934). When the service is down or degraded the CLI imports
#     `deriveBoardState` itself over the gh rows — one predicate, no second
#     language (ADR-0043 Decision 2); glm-eligible stays counted there
#     (fail-open, #3754).
#   - Issue #4130: a FAILED fallback read emits NO counts line and seeds
#     ORCH_BOARD_DEGRADED=1 — the accumulator every later orch-lane board read
#     (grill list, ARCH backfill) adds to; the one
#     `orch_board_signals_degraded=true|false` line after the ARCH block is the
#     per-lane flag decide.py gates on. A failed read never masquerades as an
#     all-zero board.
# ORCH_BOARD_DEGRADED, BOARD_STATE_DEGRADED and BOARD_STATE_JSON (the healthy
# body, the glm_withheld pin guard's source, #4254) come back through
# --exports-file. FAIL-OPEN: if the CLI itself cannot run, this prints the
# all-reads-failed fallback (no counts line, an empty needs-triage set), flags
# the lane degraded and notes why.
collect_turn_snapshot_orch_board() {
ORCH_BOARD_DEGRADED=1
BOARD_STATE_DEGRADED=1
BOARD_STATE_JSON=""
local ts_out="" ts_exports="" ts_key ts_value
ts_exports=$(mktemp) || ts_exports=""
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors orch-board --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --exports-file "$ts_exports") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      ORCH_BOARD_DEGRADED) ORCH_BOARD_DEGRADED=$ts_value ;;
      BOARD_STATE_DEGRADED) BOARD_STATE_DEGRADED=$ts_value ;;
      BOARD_STATE_JSON) BOARD_STATE_JSON=$ts_value ;;
    esac
  done < "$ts_exports"
else
  echo "orch turn-snapshot orch-board CLI failed or produced no output — counts withheld, board flagged degraded (issue #4930)" >&2
  printf '%s\n' $'orch_needs_triage_items='
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
return 0
}

# Target-side issue board — GitHub-derived Target dispatch signals (issue #3435,
# spec #3432, ADR-0031).
#
# ADR-0031 migrates Target task tracking from Redis to GitHub Issues on the
# Target repo (gaberoo322/hydra-betting). This block is the exact parity of the
# orch board-state collection above: it reads the SAME scope-parameterized
# reader — `GET /api/autopilot/board-state?scope=target` (issue #3434) — which
# reuses the pure `deriveBoardState` BYTE-FOR-BYTE against the Target repo. The
# `ready_for_agent` count it returns already excludes dependency-blocked
# (open-blocker) issues via the inherited #3059 strict blocked-by/depends-on
# filter (ADR-0031 Decision 5), so a Target issue "blocked by #N" for an OPEN
# #N never inflates the dispatchable count — the blocked-exclusion is free.
#
# We emit the four counts decide.py's Target branch consumes as its dispatch
# signals, prefixed `target_` so they never collide with the orch board counts
# above:
#   - `target_ready_for_agent` — >0 → the autopilot sets
#     `target_board_work_available`, which decide.py's `dev_target` selector
#     reads (ready-for-agent present → dispatch hydra-target-build).
#   - `target_needs_qa`        — >0 → `needs_qa_target` → `qa_target`.
#   - `target_needs_triage`    — >0 → `needs_triage_target` → `sweep_target`
#     (issue #3709). This is the exact Target mirror of the orch
#     `needs_triage` > 0 → `needs_triage_orch` → `sweep_orch` mapping. Until
#     #3709 this count was never emitted, so `needs_triage_target` had ZERO
#     producers and decide.py's `sweep_target` arm (decide.py:~2901) was DEAD
#     — the same defect class as #959's `orch_idle`. UNLIKE
#     `target_ready_for_agent`, this is a RAW label tally with no
#     blocked-exclusion: `deriveBoardState` applies the #3059 open-blocker
#     filter to `ready_for_agent` ONLY, and that is correct on the merits —
#     `ready_for_agent` is a DISPATCHABILITY count (you cannot build atop an
#     open blocker) whereas `needs_triage` is a HYGIENE-BACKLOG count, and
#     triage is precisely the act of re-examining a blocked item's lane.
#     Excluding blocked items would deadlock them out of triage forever.
#   - `target_needs_research`  — surfaced for completeness / symmetry.
# `dev_target` empty (target_ready_for_agent==0) → the autopilot sets
# `target_board_research_due`, which decide.py's `research_target` selector
# reads (board empty → dispatch hydra-target-research).
#
# IN-FLIGHT PR EXCLUSION (issue #4474, CSB swap prep, grilled design concept).
# `target_ready_for_agent` ADDITIONALLY excludes any Target `ready-for-agent`
# issue already referenced by an OPEN Target-repo PR — mirroring the orch
# lane's in-flight exclusion (`collect_turn_snapshot_pr_gate_and_picks`), which the Target lane never
# got (ADR-0031 migrated Target tracking to GitHub Issues without porting it).
# Without this, `decide.py` can dispatch `dev_target` onto an issue that
# already has an open PR carrying `Closes #N` awaiting review.
#
# Reference detection is the SAME shared predicate both lanes use —
# `pr-refs.py` — invoked against an open-PR payload fetched from
# `$TARGET_GH_REPO` rather than a second hand-rolled regex (one definition,
# two repos; pr-refs.py itself stays pure — it gains no repo argument and
# never shells out). The NEW Target reads this needs (the open-PR list, and —
# on the healthy path only — the `ready-for-agent` issue-number set the
# endpoint doesn't expose) are REST `gh api` calls, never `gh --json` /
# GraphQL (ADR-0031 Decision 6, money-critical Target hot path): `gh pr list
# --json` is a GraphQL-backed call in this CLI and is deliberately NOT used
# here. On the degraded/fallback path the ready-for-agent number set is
# instead DERIVED from the fallback's own already-fetched issue-list payload
# — zero extra REST calls.
#
# Math: target_ready_for_agent = max(0, base - |(R ∩ P) - W|), where R is the
# open Target `ready-for-agent` issue numbers, P is the pr-refs.py in-flight
# set, and W is the healthy endpoint's `glm_withheld` set (an issue already
# subtracted from `base` for the GLM-eligible reason must never be subtracted
# twice). `base` is the target_ready_for_agent value either branch above
# already computed. Fails CLOSED on any read failure: an empty/unreadable
# open-PR or ready-for-agent-number payload collapses P or R to empty, which
# makes the exclusion delta zero and leaves `base` UNADJUSTED — never a silent
# re-zero — and a stderr note is logged citing this issue. Never flips
# `TARGET_LANE_DEGRADED` (reserved for a failed COUNTS read, issue #4130) and
# never adds a new emitted key (decide.py's four-key contract is unchanged).
#
# LIVENESS-AWARE WIP SATURATION (issue #4475, CSB swap prep, ex-#4241,
# grilled design concept). `collect_target_board` ALSO emits four WIP keys —
# `target_wip_limit`, `target_in_progress`, `target_wip_live`,
# `target_wip_saturated` — produced by the shared leaf `target-wip.py`, the ONE
# source of truth for both the WIP limit and the liveness predicate
# (hydra-target-build Step 1's pre-flight gate calls the same leaf, so the two
# gates can never disagree). An `in-progress` Target issue counts as live WIP
# only when an OPEN Target PR references it (pr-refs.py's union predicate,
# reusing the single #4474 open-PR REST payload above — no second pulls read);
# an orphaned claim with no PR is discounted, because decide.py only reaches
# the single `dev_target` slot when no dev_target dispatch is live. The
# autopilot promotes `target_wip_saturated` into `state.signals`, and decide.py
# suppresses `dev_target` while it is true. The one NEW read is a REST
# `gh api` in-progress issue list (never GraphQL — ADR-0031 Decision 6). Fails
# OPEN: an unreadable in-progress or open-PR payload emits
# `target_wip_saturated=false` with a stderr note — never flips
# `TARGET_LANE_DEGRADED` and never suppresses dev_target on a read it could not
# make (worst case: today's single pre-flight bounce).
#
# EXPAND PHASE (ADR-0030 expand-contract, ADR-0031 Decision 6 drain-and-fresh):
# nothing is deleted yet. The Redis Target reads (work_queue / reframe_queue /
# prior_failures / the /api/backlog lane reads below) stay in place in parallel;
# decide.py's Target selectors fire on EITHER the Redis signal OR the new
# GitHub-board signal during the cutover. FALLBACK mirrors the orch block: on a
# degraded/unreachable orchestrator we drop back to a direct REST `gh` read
# against the Target repo (ADR-0031 Decision 6 — REST, never GraphQL, on the
# money-critical Target hot path), so a transient outage never wedges the turn.
collect_target_board() {
resolve_target_facts
TARGET_GH_REPO="${HYDRA_TARGET_GITHUB_REPO:-$(_target_fact githubRepo)}"
# Issue #4130 — TARGET_LANE_DEGRADED accumulates across the Target-lane reads
# (the counts fallback below and the TARGET_BOARD_ISSUES_JSON read). A failed
# counts read still emits zeros (decide.py's Target selectors key on the
# presence of these lines) but now ALSO flips the lane's degraded flag, so
# `target_board_signals_degraded` goes true for a GraphQL-only outage even
# when the later per-issue read succeeds — the exact mixed-read scenario the
# 2026-08-17 outage measurement showed (flag read false while counts read
# zero, because the flag keyed on only ONE of the lane's reads).
TARGET_LANE_DEGRADED=0
TARGET_BOARD_STATE_JSON=$(hydra raw GET "/autopilot/board-state?scope=target" 2>/dev/null || true)
TARGET_BOARD_STATE_DEGRADED=$(printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
try:
  d=json.load(sys.stdin)
  ok = isinstance(d,dict) and not d.get('degraded', False) and 'ready_for_agent' in d
  print('0' if ok else '1')
except Exception:
  print('1')
PY
)" 2>/dev/null || echo 1)
TARGET_ISSUES_RAW_JSON=""
TARGET_GLM_WITHHELD=""
TARGET_BLOCKER_EXCLUDED=""
if [ "$TARGET_BOARD_STATE_DEGRADED" = "0" ]; then
  TARGET_RAW_COUNTS=$(printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
d=json.load(sys.stdin)
# Emit only the counts decide.py's Target branch consumes, prefixed target_ so
# they never collide with the orch board counts above.
print('target_ready_for_agent=' + str(d.get('ready_for_agent', 0)))
print('target_needs_qa=' + str(d.get('needs_qa', 0)))
print('target_needs_triage=' + str(d.get('needs_triage', 0)))
print('target_needs_research=' + str(d.get('needs_research', 0)))
# Issue #4823 — observability-only starvation count (NOT a decide.py input, NOT
# promoted into state.signals): the length of the endpoint's blocker_excluded
# list, i.e. ready-for-agent rows it excluded for an open strict blocker.
_be = d.get('blocker_excluded', [])
print('target_ready_blocker_excluded=' + str(len(_be) if isinstance(_be, list) else 0))
PY
)")
  # W (issue #4474) — issue numbers the endpoint ALREADY withheld from
  # ready_for_agent for the GLM-eligible reason (glm_withheld, issue #4254).
  # Resolved here, used only internally by the in-flight exclusion below, and
  # deliberately NEVER echoed into the emitted stream — decide.py's four-key
  # Target contract (INV-8) is unchanged.
  TARGET_GLM_WITHHELD=$(printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
try:
  d = json.load(sys.stdin)
  nums = d.get('glm_withheld', [])
  if not isinstance(nums, list):
    nums = []
  print(' '.join(str(int(n)) for n in nums if isinstance(n, int)))
except Exception as _exc:  # noqa: BLE001 — intentional: fail-open to an empty W (nothing withheld; the base count is unaffected) (issue #4880)
  pass
PY
)" 2>/dev/null || true)
  # B (issue #4823) — issue numbers the endpoint ALREADY excluded from
  # ready_for_agent for an open strict blocker (blocker_excluded). Same
  # internal-only role as W: the in-flight exclusion must not subtract a row
  # the base count already dropped. Empty on the fallback arm (never filtered).
  TARGET_BLOCKER_EXCLUDED=$(printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
try:
  d = json.load(sys.stdin)
  nums = d.get('blocker_excluded', [])
  if not isinstance(nums, list):
    nums = []
  print(' '.join(str(int(n)) for n in nums if isinstance(n, int)))
except Exception as _exc:  # noqa: BLE001 — intentional: fail-open to an empty B (nothing excluded; the base count is unaffected) (issue #4880)
  pass
PY
)" 2>/dev/null || true)
else
  # Fallback: orchestrator down or its gh read degraded — read the Target repo
  # directly over REST (never GraphQL — ADR-0031 Decision 6). Note this fallback
  # does NOT apply the #3059 open-blocker filter (which needs the async blocker
  # resolve the endpoint owns); the healthy endpoint path above is the
  # blocked-excluding source of truth. That caveat scopes to
  # `target_ready_for_agent` ONLY — `deriveBoardState` applies the blocker
  # filter to that one branch and tallies `needs_triage` as a bare label count,
  # so `target_needs_triage` here AGREES WITH THE HEALTHY BRANCH BY
  # CONSTRUCTION. Do not "fix" it by adding a blocked-exclusion (issue #3709):
  # triage is exactly the act of re-examining a blocked item's lane, so
  # filtering would deadlock blocked items out of triage forever.
  # `--limit 100` mirrors the healthy path's `listOpenIssues` DEFAULT_LIMIT
  # (src/github/issues.ts) — without it gh defaults to 30 and silently
  # truncates the Target board (35 open issues at #3709), under-counting every
  # lane. Issue #4130: best-effort zeros stay (empty output means the gh call
  # failed), but a failed read now ALSO flips TARGET_LANE_DEGRADED instead of
  # passing itself off as a genuinely zero-count board.
  #
  # Issue #4474: the RAW `number,labels` payload is captured FIRST (instead of
  # projecting straight through gh's own `--jq`) so the in-flight exclusion
  # below can derive R (the open ready-for-agent issue numbers) from this SAME
  # already-fetched payload with zero extra REST calls. The counts themselves
  # are then computed by piping that raw payload through the IDENTICAL jq
  # filter as before (unchanged object shape/fields), plus the literal
  # `target_ready_blocker_excluded: 0` (issue #4823): this fallback applies no
  # blocker filter, so nothing is excluded — true, not a guess.
  TARGET_ISSUES_RAW_JSON=$(gh issue list --repo "$TARGET_GH_REPO" --state open --limit "$GH_ISSUE_LIST_LIMIT" --json number,labels 2>/dev/null || true)
  if [ -n "$TARGET_ISSUES_RAW_JSON" ]; then
    TARGET_RAW_COUNTS=$(printf '%s' "$TARGET_ISSUES_RAW_JSON" | jq -r '{
    target_ready_for_agent: [.[] | select(.labels | map(.name) | index("ready-for-agent"))] | length,
    target_ready_blocker_excluded: 0,
    target_needs_qa: [.[] | select(.labels | map(.name) | index("needs-qa"))] | length,
    target_needs_triage: [.[] | select(.labels | map(.name) | index("needs-triage"))] | length,
    target_needs_research: [.[] | select(.labels | map(.name) | index("needs-research"))] | length
  } | to_entries | map("\(.key)=\(.value)") | .[]' 2>/dev/null)
  else
    TARGET_LANE_DEGRADED=1
    TARGET_RAW_COUNTS=$'target_ready_for_agent=0\ntarget_ready_blocker_excluded=0\ntarget_needs_qa=0\ntarget_needs_triage=0\ntarget_needs_research=0'
  fi
fi

# Issue #4474 — in-flight PR exclusion (see header doc above).
#
# P — open Target PRs. REST `gh api`, never `gh pr list --json` (GraphQL —
# ADR-0031 Decision 6), projected with jq to pr-refs.py's input shape. A
# failed read (empty payload) degrades TARGET_INFLIGHT_ISSUES to empty via
# pr-refs.py's own fail-open contract (empty stdin -> empty output), which is
# exactly "exclude nothing" — logged here, never silently folded into
# TARGET_LANE_DEGRADED (a missing exclusion is not a missing board read).
TARGET_PRS_RAW_JSON=$(gh api "repos/$TARGET_GH_REPO/pulls?state=open&per_page=$GH_ISSUE_LIST_LIMIT" 2>/dev/null || true)
if [ -z "$TARGET_PRS_RAW_JSON" ]; then
  echo "target open-PR REST read FAILED (empty payload) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' (issue #4474)" >&2
fi
TARGET_PR_REFS_INPUT=$(printf '%s' "$TARGET_PRS_RAW_JSON" | jq -c '[.[] | {headRefName: .head.ref, body: (.body // "")}]' 2>/dev/null || echo '')
TARGET_INFLIGHT_ISSUES=$(printf '%s' "$TARGET_PR_REFS_INPUT" | python3 "$SCRIPT_DIR/pr-refs.py" 2>/dev/null || true)

# R — the open Target `ready-for-agent` issue numbers. Healthy path: a
# dedicated REST issues read (GitHub's issues endpoint also lists PRs, so
# they're filtered out by the absence of `.pull_request`). Degraded path: R is
# instead DERIVED from the fallback's own already-fetched issue-list payload
# above — zero extra REST calls for that branch.
if [ "$TARGET_BOARD_STATE_DEGRADED" = "0" ]; then
  TARGET_RFA_RAW_JSON=$(gh api "repos/$TARGET_GH_REPO/issues?labels=ready-for-agent&state=open&per_page=$GH_ISSUE_LIST_LIMIT" 2>/dev/null || true)
  if [ -z "$TARGET_RFA_RAW_JSON" ]; then
    echo "target ready-for-agent REST read FAILED (empty payload) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' (issue #4474)" >&2
  fi
  TARGET_RFA_NUMBERS_JSON=$(printf '%s' "$TARGET_RFA_RAW_JSON" | jq -c '[.[] | select(.pull_request == null) | .number]' 2>/dev/null || echo '')
else
  TARGET_RFA_NUMBERS_JSON=$(printf '%s' "$TARGET_ISSUES_RAW_JSON" | jq -c '[.[] | select(.labels | map(.name) | index("ready-for-agent")) | .number]' 2>/dev/null || echo '')
fi

# The subtraction: max(0, base - |(R ∩ P) - W - B|) — see header doc for the math.
# ONE named heredoc (LHS=... || true) terminator) so
# test/collect-state-inflight-exclusion.test.mts can extract it directly.
TARGET_BASE_READY_FOR_AGENT=$(printf '%s\n' "$TARGET_RAW_COUNTS" | sed -n 's/^target_ready_for_agent=//p')
TARGET_READY_FOR_AGENT_ADJUSTED=$(printf '%s' "$TARGET_RFA_NUMBERS_JSON" | TARGET_INFLIGHT_ISSUES="$TARGET_INFLIGHT_ISSUES" TARGET_GLM_WITHHELD="$TARGET_GLM_WITHHELD" TARGET_BLOCKER_EXCLUDED="$TARGET_BLOCKER_EXCLUDED" TARGET_BASE_READY_FOR_AGENT="$TARGET_BASE_READY_FOR_AGENT" python3 -c "$(cat <<'PY'
import json, os, sys

try:
  rfa_numbers = json.load(sys.stdin)
  if not isinstance(rfa_numbers, list):
    rfa_numbers = []
except Exception:
  rfa_numbers = []
r = {int(n) for n in rfa_numbers if isinstance(n, int)}

p = {int(x) for x in (os.environ.get('TARGET_INFLIGHT_ISSUES') or '').split() if x.isdigit()}
w = {int(x) for x in (os.environ.get('TARGET_GLM_WITHHELD') or '').split() if x.isdigit()}
b = {int(x) for x in (os.environ.get('TARGET_BLOCKER_EXCLUDED') or '').split() if x.isdigit()}

try:
  base = int(os.environ.get('TARGET_BASE_READY_FOR_AGENT', '0') or 0)
except ValueError:
  base = 0

excluded = len((r & p) - w - b)
print(max(0, base - excluded))
PY
)" 2>/dev/null || true)

if [ -n "$TARGET_READY_FOR_AGENT_ADJUSTED" ]; then
  printf '%s\n' "$TARGET_RAW_COUNTS" | sed "s/^target_ready_for_agent=.*/target_ready_for_agent=${TARGET_READY_FOR_AGENT_ADJUSTED}/"
else
  printf '%s\n' "$TARGET_RAW_COUNTS"
fi

# Issue #4823 — starvation note: a Target lane whose ready-for-agent issues are
# ALL blocker-excluded is starved, not empty. Stderr only (run-log visibility);
# never flips TARGET_LANE_DEGRADED and feeds no decide.py rule.
TARGET_READY_FOR_AGENT_EFFECTIVE=${TARGET_READY_FOR_AGENT_ADJUSTED:-$TARGET_BASE_READY_FOR_AGENT}
if [ "$TARGET_READY_FOR_AGENT_EFFECTIVE" = "0" ] && [ -n "$TARGET_BLOCKER_EXCLUDED" ]; then
  echo "target board STARVED, not empty: ready-for-agent issues held out by an open strict blocker: ${TARGET_BLOCKER_EXCLUDED} (issue #4823)" >&2
fi

# Issue #4475 — liveness-aware WIP saturation (see header doc above).
# InProgress: open `in-progress` Target issue numbers over REST (PRs filtered
# out by `.pull_request`). P reuses #4474's `TARGET_PR_REFS_INPUT` projection
# of the single open-PR REST payload. Both are fed to target-wip.py on STDIN
# (never argv/env — PR bodies can exceed the per-argument exec limit); an empty
# stdin makes target-wip.py fail open by contract.
TARGET_IN_PROGRESS_RAW_JSON=$(gh api "repos/$TARGET_GH_REPO/issues?labels=in-progress&state=open&per_page=$GH_ISSUE_LIST_LIMIT" 2>/dev/null || true)
TARGET_IN_PROGRESS_NUMBERS_JSON=$(printf '%s' "$TARGET_IN_PROGRESS_RAW_JSON" | jq -c '[.[] | select(.pull_request == null) | .number]' 2>/dev/null || echo '')
TARGET_WIP_STDIN=''
if [ -z "$TARGET_IN_PROGRESS_NUMBERS_JSON" ] || [ -z "$TARGET_PR_REFS_INPUT" ]; then
  echo "target WIP read FAILED (in-progress or open-PR payload unreadable) — target_wip_saturated fails OPEN to false (issue #4475)" >&2
else
  TARGET_WIP_STDIN=$({ printf '%s\n' "$TARGET_IN_PROGRESS_NUMBERS_JSON"; printf '%s\n' "$TARGET_PR_REFS_INPUT"; } | jq -cs '{in_progress: .[0], prs: .[1]}' 2>/dev/null || echo '')
fi
TARGET_WIP_LINES=$(printf '%s' "$TARGET_WIP_STDIN" | python3 "$SCRIPT_DIR/target-wip.py" 2>/dev/null || true)
if [ -n "$TARGET_WIP_LINES" ]; then
  printf '%s\n' "$TARGET_WIP_LINES"
else
  echo "target-wip.py produced no output — target_wip_saturated fails OPEN to false (issue #4475)" >&2
  printf '%s\n' "target_wip_limit=unknown" "target_in_progress=0" "target_wip_live=0" "target_wip_saturated=false"
fi

# Issue #4576 — qa_target PR pre-resolution. decide.py's qa_target selector
# dispatches hydra-target-qa, whose first argument is the Target PR to review;
# pre-resolving the PR here (the same verbatim-string seam as needs_qa_numbers,
# #3829) keeps decide.py pure — it names the PR in prompt_args.pr_ref instead
# of the dispatched skill re-deriving it. VALUE: the html_url of the open
# Target PR that CLOSES the first open needs-qa Target issue (REST issue
# order, PR-shaped entries filtered out) that has one; empty string when none
# resolves — the key is ALWAYS emitted (an empty value is decide.py's
# fail-open sentinel: the qa_target dispatch still fires and hydra-target-qa's
# own step 1 resolves the PR when pr_ref is absent, never a dead arm).
#
# Closing detection reuses pr-refs.py's closing_issues() (the ONE predicate,
# #3852/#4045 — no second regex) evaluated PER PR over the ALREADY-fetched
# TARGET_PRS_RAW_JSON payload from the #4474 in-flight exclusion above — no
# new PR read. The ONLY new network call is ONE REST needs-qa issue read
# (never a GraphQL-backed gh --json read — ADR-0031 Decision 6, the
# money-critical Target hot path), and it is SKIPPED entirely when the counts
# above already say target_needs_qa=0 (the overwhelmingly common turn — the
# needs_qa_target signal that arms qa_target is derived from that same count,
# so a zero count means no dispatch and no ref is needed).
#
# Fail-open everywhere: a failed/empty issues read, an empty PR payload, an
# unloadable predicate, or no match each emit an empty value and never abort
# the collector.
#
# Issue #4653 companion fact: `target_needs_qa_pr_head` is the `head.ref` of
# the SAME PR whose html_url resolves as `target_needs_qa_pr_ref`, projected
# from the already-fetched `TARGET_PRS_RAW_JSON` payload inside this exact
# resolver — zero new network calls. decide.py's `_qa_target_builder_hold`
# predicate joins this against the live `dev_target` slot's dispatch token to
# hold `qa_target` while that PR's own builder is still running. The key is
# ALWAYS emitted (empty string on a zero count, a failed issues read, or no
# match), same fail-open contract as `target_needs_qa_pr_ref`.
TARGET_NQA_COUNT=$(printf '%s\n' "$TARGET_RAW_COUNTS" | sed -n 's/^target_needs_qa=//p')
if [ "${TARGET_NQA_COUNT:-0}" = "0" ]; then
  echo "target_needs_qa_pr_ref="
  echo "target_needs_qa_pr_head="
else
  TARGET_NQA_ISSUES_JSON=$(gh api "repos/$TARGET_GH_REPO/issues?labels=needs-qa&state=open&per_page=$GH_ISSUE_LIST_LIMIT" 2>/dev/null || true)
  if [ -z "$TARGET_NQA_ISSUES_JSON" ]; then
    echo "target needs-qa REST read FAILED (empty payload) — target_needs_qa_pr_ref fails OPEN to empty (issue #4576)" >&2
    echo "target_needs_qa_pr_ref="
    echo "target_needs_qa_pr_head="
  else
    # Payloads on STDIN, never argv/env (PR bodies can exceed the exec limit)
    # — the same jq -cs two-document shape as the #4475 WIP read above.
    # The python block below emits url + head.ref on two lines (issue #4653)
    # so both facts come out of the SAME match with no second read.
    TARGET_QA_PR_MATCH=$({ printf '%s\n' "$TARGET_NQA_ISSUES_JSON"; printf '%s\n' "$TARGET_PRS_RAW_JSON"; } | jq -cs '{issues: .[0], prs: .[1]}' 2>/dev/null | TARGET_PR_REFS_PY="$SCRIPT_DIR/pr-refs.py" python3 -c "$(cat <<'PY'
import importlib.util, json, os, sys

# Fail-open predicate loader (the ORCH_PR_REFS_PY shape): a missing or
# unloadable pr-refs.py degrades to no ref, never an abort.
pr_refs = None
_path = os.environ.get("TARGET_PR_REFS_PY") or ""
if _path:
    try:
        _spec = importlib.util.spec_from_file_location("pr_refs", _path)
        if _spec is not None and _spec.loader is not None:
            _mod = importlib.util.module_from_spec(_spec)
            _spec.loader.exec_module(_mod)
            pr_refs = _mod
    except Exception as _exc:  # noqa: BLE001 — best-effort import, fail open (issue #4576)
        print(f"target-qa pr-refs.py import FAILED ({_exc}) — fail open (issue #4576)", file=sys.stderr)
        pr_refs = None

try:
    data = json.load(sys.stdin)
except Exception as _exc:  # noqa: BLE001 — malformed/empty stdin payload, fail open (issue #4576)
    print(f"target-qa stdin JSON parse FAILED ({_exc}) — fail open (issue #4576)", file=sys.stderr)
    data = {}
issues = data.get("issues") if isinstance(data, dict) else None
prs = data.get("prs") if isinstance(data, dict) else None
if not isinstance(issues, list):
    issues = []
if not isinstance(prs, list):
    prs = []

# REST issue order is load-bearing: the FIRST open needs-qa issue (PR-shaped
# entries filtered out by .pull_request) that an open PR actually CLOSES wins;
# among that issue's closing PRs the first in payload order wins. Note the
# GitHub REST issues endpoint defaults to newest-first (created/desc) absent
# an explicit sort param, so "first" here means the NEWEST open needs-qa
# issue, not the oldest — fail-open (INV-5) means the worst case is naming a
# different-than-ideal PR, never suppressing dispatch (issue #4576).
ordered = []
for it in issues:
    if not isinstance(it, dict) or it.get("pull_request") is not None:
        continue
    n = it.get("number")
    if isinstance(n, int):
        ordered.append(n)

if pr_refs is not None:
    for n in ordered:
        for pr in prs:
            if not isinstance(pr, dict):
                continue
            url = pr.get("html_url")
            if not isinstance(url, str) or not url:
                continue
            try:
                closed = pr_refs.closing_issues(json.dumps([pr]))
            except Exception as _exc:  # noqa: BLE001 — a body that breaks the predicate skips this PR, never the turn (issue #4576)
                print(f"target-qa closing_issues() failed for PR {url} ({_exc}) — skipping PR (issue #4576)", file=sys.stderr)
                continue
            if n in closed:
                # Issue #4653: project head.ref from the SAME already-fetched
                # `pr` object — no second read. head may legitimately be
                # missing/malformed on a degraded payload; emit an empty
                # second line rather than aborting the match (fail-open).
                head_obj = pr.get("head")
                head_ref = head_obj.get("ref") if isinstance(head_obj, dict) else None
                sys.stdout.write(url + "\n" + (head_ref if isinstance(head_ref, str) else ""))
                sys.exit(0)
PY
)" || true)
    TARGET_QA_PR_REF=$(printf '%s\n' "$TARGET_QA_PR_MATCH" | sed -n '1p')
    TARGET_QA_PR_HEAD=$(printf '%s\n' "$TARGET_QA_PR_MATCH" | sed -n '2p')
    echo "target_needs_qa_pr_ref=${TARGET_QA_PR_REF}"
    echo "target_needs_qa_pr_head=${TARGET_QA_PR_HEAD}"
  fi
fi

# Issue #4739 — Target dev resume pick: the durable bridge from an operator
# "fix forward on PR #N, push to its existing branch" decision back to
# dev_target. A needs-dev-resume issue is invisible to the board count above
# (the #4474 in-flight exclusion subtracts only ready-for-agent issues, and
# the resume issue deliberately does NOT carry that label), so without this
# pick a held fix-forward PR is stranded forever. Marker writer:
# /hydra-review's per-Target fix-forward resolution (docs/operator-playbooks/
# hydra-review.md) — the ONLY writer of needs-dev-resume on the Target repo.
#
# Wire shape: `target_dev_resume_pick=issue-<N>:<pr>:<head.ref>` or `=none`,
# the SAME shape as orch_dev_resume_pick (#4518), parsed by decide.py's
# existing `_issue_pr_branch_signal` helper. One added REST read (the open
# needs-dev-resume issues, PR-shaped entries filtered by `.pull_request`);
# the PR side REUSES the single #4474 TARGET_PRS_RAW_JSON payload above —
# no second pulls read (ADR-0031 Decision 6: REST, never gh --json/GraphQL).
#
# Fail CLOSED (issue #4739): a false positive spends a paid dev_target
# dispatch on a resume that may not exist; a false negative only waits one
# turn. Any failed read (empty payload on either side) or a jq/pr-refs.py
# failure degrades to `none` + a stderr note naming #4739, and NEVER flips
# TARGET_LANE_DEGRADED — the board reads above own that flag. A healthy
# empty lane (`[]`) stays distinguishable from a failed read (empty string)
# per the #4130 discipline: the tiny TARGET_DEV_RESUME_OK flag below carries
# that distinction into the python block (payloads themselves travel on
# STDIN, never argv/env — PR bodies can exceed the exec limit).
TARGET_NDR_RAW_JSON=$(gh api "repos/$TARGET_GH_REPO/issues?labels=needs-dev-resume&state=open&per_page=$GH_ISSUE_LIST_LIMIT" 2>/dev/null || true)
TARGET_DEV_RESUME_OK=1
if [ -z "$TARGET_NDR_RAW_JSON" ]; then
  echo "target needs-dev-resume REST read FAILED (empty payload) — target_dev_resume_pick fails closed to none (issue #4739)" >&2
  TARGET_DEV_RESUME_OK=0
fi
if [ -z "$TARGET_PRS_RAW_JSON" ]; then
  echo "target open-PR REST payload empty — target_dev_resume_pick fails closed to none (issue #4739)" >&2
  TARGET_DEV_RESUME_OK=0
fi
# One named assignment (TARGET_DEV_RESUME_PICK=$(... || true)) so the
# test/autopilot-decide-dev-target-resume.test.mts can extract it directly —
# same technique as the #4474 subtraction block above.
TARGET_DEV_RESUME_PICK=$({ printf '%s\n' "$TARGET_NDR_RAW_JSON"; printf '%s\n' "$TARGET_PRS_RAW_JSON"; } | jq -cs '{issues: .[0], prs: .[1]}' 2>/dev/null | TARGET_PR_REFS_PY="$SCRIPT_DIR/pr-refs.py" TARGET_DEV_RESUME_OK="$TARGET_DEV_RESUME_OK" python3 -c "$(cat <<'PY'
import importlib.util, json, os, sys

# Fail CLOSED (issue #4739): unlike the #4576 fail-open ref above, a false
# positive here spends a paid dispatch, so every degraded input degrades to
# `none`, never to a guess.
pick = "none"
if os.environ.get("TARGET_DEV_RESUME_OK") != "1":
    print("target-dev-resume read degraded (failed REST read) — fail closed to none (issue #4739)", file=sys.stderr)
else:
    # Fail-closed predicate loader (the ORCH_PR_REFS_PY shape): a missing or
    # unloadable pr-refs.py degrades to no pick, never an abort.
    pr_refs = None
    _path = os.environ.get("TARGET_PR_REFS_PY") or ""
    if _path:
        try:
            _spec = importlib.util.spec_from_file_location("pr_refs", _path)
            if _spec is not None and _spec.loader is not None:
                _mod = importlib.util.module_from_spec(_spec)
                _spec.loader.exec_module(_mod)
                pr_refs = _mod
        except Exception as _exc:  # noqa: BLE001 — best-effort import, fail closed (issue #4739)
            print(f"target-dev-resume pr-refs.py import FAILED ({_exc}) — fail closed to none (issue #4739)", file=sys.stderr)
            pr_refs = None
    if pr_refs is None:
        print("target-dev-resume pr-refs.py unavailable — fail closed to none (issue #4739)", file=sys.stderr)
    else:
        try:
            data = json.load(sys.stdin)
        except Exception as _exc:  # noqa: BLE001 — malformed/empty stdin payload, fail closed (issue #4739)
            print(f"target-dev-resume stdin JSON parse FAILED ({_exc}) — fail closed to none (issue #4739)", file=sys.stderr)
            data = {}
        issues = data.get("issues") if isinstance(data, dict) else None
        prs = data.get("prs") if isinstance(data, dict) else None
        if not isinstance(issues, list):
            print("target-dev-resume issues payload is not a list — treated as empty (issue #4739)", file=sys.stderr)
            issues = []
        if not isinstance(prs, list):
            print("target-dev-resume prs payload is not a list — treated as empty (issue #4739)", file=sys.stderr)
            prs = []

        # Qualifying PRs: open (payload is state=open), non-draft
        # (REST `draft != true`), head.ref a non-empty ':'-free string, and
        # closing_issues() (pr-refs.py, evaluated PER PR — closing, not
        # referenced: Target build branches are feature/<cycle-id>, so the
        # branch half can never match, same rationale as #4195 INV-4)
        # resolves to EXACTLY one issue number.
        per_issue = {}
        for pr in prs:
            if not isinstance(pr, dict) or pr.get("draft") is True:
                continue
            pr_no = pr.get("number")
            if not isinstance(pr_no, int):
                continue
            head_obj = pr.get("head")
            head_ref = head_obj.get("ref") if isinstance(head_obj, dict) else None
            if not isinstance(head_ref, str) or not head_ref or ":" in head_ref:
                continue
            try:
                closed = pr_refs.closing_issues(json.dumps([pr]))
            except Exception as _exc:  # noqa: BLE001 — a body that breaks the predicate skips this PR, never the turn (issue #4739)
                print(f"target-dev-resume closing_issues() failed for PR {pr_no} ({_exc}) — skipping PR (issue #4739)", file=sys.stderr)
                continue
            # closing_issues() returns a SET of ints (pr-refs.py) — accept
            # any container, require EXACTLY one element.
            if isinstance(closed, (list, set, frozenset)) and len(closed) == 1:
                closed_n = next(iter(closed))
                if isinstance(closed_n, int):
                    per_issue.setdefault(closed_n, []).append((pr_no, head_ref))

        # An issue with two or more qualifying PRs is AMBIGUOUS — skip it
        # rather than guess which branch to resume (issue #4739 INV-2).
        # The pick is then the LOWEST-NUMBERED (oldest) open needs-dev-resume
        # issue (PR-shaped entries filtered out by .pull_request) with
        # exactly one qualifying PR. Explicit min() — the REST issues
        # endpoint defaults to newest-first, so payload order must not be
        # trusted (contrast the #4576 newest-first pick above, which is
        # deliberately the other way for QA freshness).
        labelled = []
        for it in issues:
            if not isinstance(it, dict) or it.get("pull_request") is not None:
                continue
            n = it.get("number")
            if isinstance(n, int):
                labelled.append(n)
        candidates = sorted(n for n in labelled if len(per_issue.get(n, [])) == 1)
        if candidates:
            n = candidates[0]
            pr_no, head_ref = per_issue[n][0]
            pick = f"issue-{n}:{pr_no}:{head_ref}"
print(pick)
PY
)" || true)
echo "target_dev_resume_pick=${TARGET_DEV_RESUME_PICK:-none}"
}

# UNTRIAGED ORPHANS + NEEDS-QA NUMBERS — Turn Snapshot collectors (ADR-0043
# slice 2, issue #4930). The jq filters that lived here as
# collect_untriaged_orphans + collect_needs_qa_numbers are now the typed
# `untriaged-orphans` and `needs-qa` collectors in
# src/autopilot/turn-snapshot/orch-board.ts (the exclusion-label rationale —
# #2426, #2828, #2958, #3728, #3817, #4025, #4096, #4220 — lives on
# UNTRIAGED_ORPHAN_EXCLUDED_LABELS there), rendered byte-identically:
#   - untriaged_orphans = open issues carrying no lifecycle/parking label and no
#     `wayfinder:` label; `> 0` → untriaged_orphans_orch → sweep_orch's
#     secondary trigger. A failed read emits 0 (never a spurious sweep).
#   - needs_qa_numbers = the open needs-qa issues in gh's DEFAULT order — the
#     order hydra-qa self-selects in, so `[0]` is the issue QA reviews next
#     (#3829 INV-4). A failed read emits empty (decide.py fails open).
# Both are standalone gh reads, independent of the board-state seam. FAIL-OPEN:
# if the CLI itself cannot run, this prints the failed-read fallback lines.
collect_turn_snapshot_orphans_needs_qa() {
# The `.` sentinel keeps the CLI's trailing blank line (the historical
# needs_qa_numbers shape) that `$(...)` would otherwise strip.
local ts_out=""
ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors untriaged-orphans,needs-qa --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" && printf '.')
if [ "${ts_out%.}" != "$ts_out" ] && [ -n "${ts_out%.}" ]; then
  printf '%s' "${ts_out%.}"
else
  echo "orch turn-snapshot untriaged-orphans/needs-qa CLI failed or produced no output — emitting the failed-read fallback (issue #4930)" >&2
  printf '%s\n' $'untriaged_orphans=0\nneeds_qa_numbers='
fi
return 0
}

# IN-FLIGHT PRs + PR-GATE REACHABILITY + GRILL/DEV-READY PICKS — Turn Snapshot
# collectors (ADR-0043 slices 1 and 3, issues #4929 and #4931). The logic that
# lived here as collect_orch_inflight_prs + collect_pr_gate_reachability
# (slice 1) and collect_orch_grill_candidates + collect_orch_merged_prs +
# collect_orch_grill_and_dev_ready_picks + collect_candidate_exclusions +
# collect_active_dev_orch (slice 3) is now the typed `pr-gate` and `picks`
# collectors in src/autopilot/turn-snapshot/{pr-gate,picks}.ts, run in ONE
# invocation of the one-shot CLI scripts/autopilot/turn-snapshot.ts (picks takes
# pr-gate's in-flight sets in-process) and rendered by its `kv` renderer
# BYTE-IDENTICALLY to the bash it replaced (golden files under
# test/fixtures/turn-snapshot/). Semantics are unchanged; the module docblocks
# carry the rules and the issues behind them:
#   - ONE `gh pr list` payload feeds the in-flight exclusion sets (#3711,
#     #3851, #3964, #4334) AND the PR-gate buckets (#4240); the #4812 UNKNOWN
#     mergeStateStatus re-poll is the single sanctioned second PR read
#     (HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS, default 5).
#   - emits orch_prs_dirty / orch_prs_unchecked / orch_prs_behind /
#     orch_ci_trigger_stale / orch_prs_glm_red / orch_glm_red_forward_fix /
#     orch_dev_resume_pick / orch_dirty_forward_fix / orch_prs_dirty_surface,
#     in that order (#4240, #4460, #4518, #4807). Windows:
#     HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS (600), HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS (1800).
#   - then orch_pending_grill_anchor / orch_dev_ready_anchor (#628, #1088,
#     #1230, #3711, #3965, #4254, #4690), candidate_exclusions_json (#3964) and
#     active_dev_orch (#412, #3687, #4048). The strict-blocker, merged-PR and
#     grill-exemption predicates are the canonical TS ones
#     (src/github/blockers.ts, src/github/pr-refs.ts, src/glm/eligibility.ts) —
#     no python twin remains in this script.
#   - the stale flag fails OPEN (INV-E); the glm-red / dev-resume / dirty-fix
#     picks fail CLOSED (INV-5, #4807 INV-4). A FAILED grill-list read flips the
#     ORCH_BOARD_DEGRADED accumulator (#4130), which comes back through
#     --exports-file for the still-bash arch block below.
#   - the GLM-withheld pin refusal (#4254) reads glm_withheld off the SAME
#     healthy board-state body the counts line used (handed over through
#     --board-state-file); a degraded board-state read passes no file, so no pin
#     is refused (fail-open, #3754).
# FAIL-OPEN: if the CLI itself cannot run (no node, a crash before output) this
# prints the same all-reads-failed fallback lines the bash printed, plus a note,
# and flags the orch lane degraded (the grill list was never read).
collect_turn_snapshot_pr_gate_and_picks() {
local ts_out="" ts_exports="" ts_board="" ts_key ts_value ts_degraded_seen=0
local -a ts_board_args=()
ts_exports=$(mktemp) || ts_exports=""
if [ "${BOARD_STATE_DEGRADED:-1}" = "0" ]; then
  if ts_board=$(mktemp); then
    printf '%s' "${BOARD_STATE_JSON:-}" > "$ts_board"
    ts_board_args=(--board-state-file "$ts_board")
  else
    ts_board=""
    echo "orch turn-snapshot: mktemp for --board-state-file failed — no glm_withheld pin refusal this turn (fail-open, #3754) (issue #4931)" >&2
  fi
fi
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors pr-gate,picks --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --exports-file "$ts_exports" \
       ${ts_board_args[@]+"${ts_board_args[@]}"}) \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      ORCH_BOARD_DEGRADED) ts_degraded_seen=1; [ "$ts_value" = "1" ] && ORCH_BOARD_DEGRADED=1 ;;
    esac
  done < "$ts_exports"
  # The CLI always writes ORCH_BOARD_DEGRADED=0|1; a missing key means the
  # exports write failed, so the grill-list read is unconfirmed — fail CLOSED.
  if [ "$ts_degraded_seen" != "1" ]; then
    echo "orch turn-snapshot exports file carried no ORCH_BOARD_DEGRADED — treating the orch lane as degraded (issue #4931)" >&2
    ORCH_BOARD_DEGRADED=1
  fi
else
  echo "orch turn-snapshot pr-gate/picks CLI failed or produced no output — emitting the fail-open PR-gate + picks fallback; orch lane flagged degraded (issues #4929, #4931)" >&2
  printf '%s\n' $'orch_prs_dirty=\norch_prs_unchecked=\norch_prs_behind=\norch_ci_trigger_stale=false\norch_prs_glm_red=\norch_glm_red_forward_fix=none\norch_dev_resume_pick=none\norch_dirty_forward_fix=none\norch_prs_dirty_surface=\norch_pending_grill_anchor=none\norch_dev_ready_anchor=none\ncandidate_exclusions_json=[]\nactive_dev_orch=0'
  ORCH_BOARD_DEGRADED=1
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
[ -n "$ts_board" ] && rm -f "$ts_board"
return 0
}

# REDIS QUEUES + SCOUT + ARCH/CLEANUP/SKILL-PRUNE BOARDS + HITL-GRILL INBOX —
# Turn Snapshot collectors (ADR-0043 slice 5B, issue #4933). collect_redis_queues,
# collect_scout, collect_arch_cleanup_boards and collect_hitl_grill (and their
# heredocs) are now the typed `redis-queues`, `scout`, `arch-cleanup-boards` and
# `hitl-grill` collectors in src/autopilot/turn-snapshot/board-saturation.ts,
# reading Redis through the typed src/redis accessors (redis-port.ts) and gh
# through the TurnSnapshotGithub port, rendered byte-identically by
# render-kv-remaining.ts (golden files under test/fixtures/turn-snapshot/remaining/).
# The module docblock carries each signal's rules and the issues behind them
# (#3478, #485, #532, #789, #959, #960, #4130, #4391, #4607, #4657). Semantics
# are unchanged — including the scout spend mirror WRITE into
# hydra:scout:spend:<DATE> (7d TTL) and the #4130 rule that a failed board read
# never computes orch_backfill_idle from fake zeros. ORCH_BOARD_DEGRADED goes in
# (earlier orch reads may have flipped it) and comes back with ARCH_WORK_QUEUE
# (read by collect_target_scan_boards) through --exports-file.
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note and
# flag the orch lane degraded (the board read did not happen). The exported
# globals fail CLOSED: an unconfirmed work-queue depth reads as 1 (so
# target_backfill_idle cannot fire) and ORCH_BOARD_DEGRADED as 1.
collect_turn_snapshot_boards() {
ARCH_WORK_QUEUE=0
local ts_out="" ts_exports="" ts_key ts_value ts_wq_seen=0 ts_degraded_seen=0
ts_exports=$(mktemp) || ts_exports=""
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors redis-queues,scout,arch-cleanup-boards,hitl-grill --format kv \
       --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --orch-board-degraded "${ORCH_BOARD_DEGRADED:-0}" \
       --exports-file "$ts_exports") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      ARCH_WORK_QUEUE) ts_wq_seen=1; ARCH_WORK_QUEUE=$ts_value ;;
      ORCH_BOARD_DEGRADED) ts_degraded_seen=1; ORCH_BOARD_DEGRADED=$ts_value ;;
    esac
  done < "$ts_exports"
  # The CLI always writes both keys; a missing key means the exports write
  # failed, so the work-queue depth / board read is unconfirmed — fail CLOSED:
  # a non-zero work queue keeps target_backfill_idle false, and the orch lane
  # reads degraded (the slice-3 ts_degraded_seen pattern).
  if [ "$ts_wq_seen" != "1" ]; then
    echo "orch turn-snapshot boards exports file carried no ARCH_WORK_QUEUE — treating the work queue as non-empty so target backfill cannot fire (issue #4933)" >&2
    ARCH_WORK_QUEUE=1
  fi
  if [ "$ts_degraded_seen" != "1" ]; then
    echo "orch turn-snapshot boards exports file carried no ORCH_BOARD_DEGRADED — treating the orch lane as degraded (issue #4933)" >&2
    ORCH_BOARD_DEGRADED=1
  fi
else
  echo "orch turn-snapshot boards CLI failed or produced no output — emitting the fail-open fallback; orch board flagged degraded, work queue treated as non-empty (issue #4933)" >&2
  ORCH_BOARD_DEGRADED=1
  ARCH_WORK_QUEUE=1
  printf '%s\n' $'backlog_subsystem=retired-adr0031\nwork_queue=0\nreframe_queue=0\nprior_failures=0\nscout_last_walk_iso=\nscout_board_open_enhancements=0\nscout_tokens_today=0\nscout_spend_usd_today=0.00\narch_last_run_iso=\norch_backfill_idle=false\narch_board_open_scan=0\narch_board_open_enhancements=0\narch_board_saturated=false\ncleanup_board_open_scan=0\ncleanup_board_saturated=false\nskill_prune_board_open=0\nskill_prune_board_saturated=false\norch_board_signals_degraded=true\nhitl_grill_open=0\nhitl_grill_saturated=true'
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
return 0
}

# Target cleanup backfill — cleanup_target signal class (the Target mirror of
# cleanup_orch; operator-approved 2026-06-10).
#
# `target_backfill_idle` — true when the Target backlog has NO actionable
# work: the `triage` and `queued` lanes are empty AND the Redis work-queue is
# empty (the same `hydra:anchors:work-queue` read that feeds
# orch_backfill_idle above, reused via $ARCH_WORK_QUEUE). The Target's
# `backlog` lane (ready-for-human / unapproved items) deliberately does NOT
# block the backfill — those items are parked for the operator, not agent
# work. Mirrors how orch_backfill_idle reads only the actionable label
# counts.
#
# `target_cleanup_board_saturated` — true when more than the cap (10,
# mirroring CLEANUP_BOARD_SATURATION_CAP) backlog items carrying the stable
# `cleanup-scan` label sit in any lane except `done`. The
# /hydra-target-cleanup emit runner stamps every item with this label (the
# emit/count seam) and re-checks the cap itself as a belt-and-braces
# back-stop. Orchestrator-API-down degrades to idle=false / saturated=true —
# BOTH in the suppressing direction (fail closed: never dispatch a scan that
# cannot read its own board).
#
# `wire_or_retire_target_available` — (issue #2722, epic #2720) true when >=1
# open item carrying the stable `wire-or-retire` label sits in the Target
# `triage` lane. These are the JUDGMENT items /hydra-target-cleanup files for
# modules past the 45-day wiring grace (the decision queue). decide.py's
# `wire_or_retire_target` signal class reads this and dispatches the headless
# /hydra-wire-or-retire resolver (24h class cooldown, at most 2 items/run) to
# turn each into a WIRE / RETIRE / UNCLEAR verdict. Only the `triage` lane is
# read (the #2721 lane guard keeps unresolved wire-or-retire items IN triage;
# a resolved item leaves as a queued WIRE/RETIRE task or a ready-for-human
# backlog item). Orchestrator-API-down degrades to false — the suppressing
# direction (never dispatch a resolver that cannot read its own queue).
#
# `design_qa_target_due` / `design_qa_target_saturated` /
# `design_qa_target_adr_present` — (issue #2739, parent #2732, the Target
# UI-quality loop; ADR-presence gate added by #4528) drive the periodic
# visual-QA pass. This is a CALENDAR-cadence class like scout_orch: decide.py's
# 7d class cooldown owns the cadence. `design_qa_target_due` is true only when
# ALL THREE hold: the Target board read succeeded, the board is not saturated,
# AND at least one file matches the design-language ADR convention glob
# (docs/adr/*design-language*.md) under the seam-resolved Target workspace —
# #4528: the post-swap Target (no design ADR, no nav registry) otherwise pays
# a ~50k-token no-op dispatch every 7d with nothing to grade. An unresolved
# workspace or zero glob matches yields due=false (fail closed: the class
# stays dormant, never dispatches on a guessed Target). `design_qa_target_
# saturated` is the anti-flood cap: true when more than
# DESIGN_QA_BOARD_SATURATION_CAP (5) open items carrying the stable `design-qa`
# label sit in any lane except `done` (the /hydra-design-qa emit runner stamps
# every finding with this label) — unchanged by #4528: it depends only on that
# label count vs the cap, never on ADR presence. `design_qa_target_adr_present`
# is the ADVISORY observability key for the dormancy (the same convention as
# target_board_signals_degraded): emitted in every branch, read by NOBODY in
# decide.py — a permanently-false due signal must be visible, not silent.
# Orchestrator-API-down degrades to due=false / saturated=true — BOTH the
# suppressing direction (fail closed: never dispatch a visual pass that cannot
# read its own board to dedup against).
#
# Design-language ADR presence (issue #4528) — the pure glob half of the
# `design_qa_target_due` predicate. Echoes true when at least one file matches
# docs/adr/*design-language*.md under $1 (the Target workspace), else false.
# PURE on purpose: no seam resolution inside (the caller resolves the
# workspace exactly like the direction-drift Turn Snapshot collector — HYDRA_TARGET_REPO, else the
# seam's workspace fact) so this helper is unit-testable against a tmpdir
# fixture. The SAME glob literal is re-checked by the hydra-design-qa playbook
# right after its seam preamble; test/autopilot-target-board-signals.test.mts
# pins the two against drift. Unresolved workspace / zero matches -> false
# (fail closed).
_design_qa_adr_glob_matches() {
local _dqa_ws _dqa_f
_dqa_ws="${1:-}"
if [ -z "$_dqa_ws" ] || [ ! -d "$_dqa_ws" ]; then
  echo false
  return 0
fi
for _dqa_f in "$_dqa_ws"/docs/adr/*design-language*.md; do
  if [ -f "$_dqa_f" ]; then
    echo true
    return 0
  fi
done
echo false
}
collect_target_scan_boards() {
TARGET_CLEANUP_SCAN_LABEL="cleanup-scan"
TARGET_CLEANUP_BOARD_SATURATION_CAP=10
TARGET_WIRE_OR_RETIRE_LABEL="wire-or-retire"
TARGET_DESIGN_QA_LABEL="design-qa"
TARGET_DESIGN_QA_BOARD_SATURATION_CAP=5
# Issue #4528: ADR presence is resolved ONCE here, BEFORE the board read, so
# every emission branch below (healthy, python-except, invocation-failure,
# degraded) can publish the advisory design_qa_target_adr_present key and the
# due predicate can AND on it. The workspace resolution mirrors
# the direction-drift Turn Snapshot collector: HYDRA_TARGET_REPO overrides, else the seam's
# workspace fact (memoized by resolve_target_facts). Seam down / workspace
# unresolvable -> helper echoes false -> due=false (fail closed).
resolve_target_facts
TARGET_DESIGN_QA_ADR_PRESENT="$(_design_qa_adr_glob_matches "${HYDRA_TARGET_REPO:-$(_target_fact workspace)}")"
# ADR-0031 lane: read these Target board-derivation signals directly from the
# GitHub board (gaberoo322/hydra-betting), NOT the retired `/api/backlog` HTTP
# surface (deleted by #3439 / PR #3455 — it now returns 404). The old
# `curl -sf .../api/backlog || echo ''` guard degraded SILENTLY to empty on the
# 404, so the `[ -n ... ]` gate fell to the all-suppressing `else` defaults
# below with no visible signal — flipping wire_or_retire/design_qa off and
# leaving `target_backfill_idle=false`, i.e. exactly the degraded-signal set
# that mis-drove the run (b07ad8e4, 2026-07-18, issue #3478).
#
# The lane->label mapping mirrors the direct-`gh` Target reads already above
# (lines ~195, ~546): the retired Redis backlog's `triage` lane == the
# `needs-triage` label, its `queued` lane == the `ready-for-agent` label. REST
# `gh issue list` (never GraphQL — ADR-0031 Decision 6, money-critical Target
# hot path). On an UNREACHABLE read we still fall to the suppressing defaults
# (fail closed) BUT now emit an OBSERVABLE `target_board_signals_degraded=true`
# line so a degraded read is a visible signal rather than an invisible zero-set.
#
# TRUNCATION (issue #3710) is a SEPARATE, ORTHOGONAL signal from degradation,
# and the two must never be folded together — they have opposite semantics:
#   degraded  = the read FAILED       -> suppress dispatch (fail closed)
#   truncated = the read SUCCEEDED but is INCOMPLETE -> keep dispatching
# Overloading `degraded` would stall the whole Target lane on a merely-large
# board. `target_board_signals_truncated` is therefore ADVISORY ONLY: nothing
# in decide.py gates on it, exactly like `target_board_signals_degraded`.
#
# Detection is `len(rows) >= limit` on the array already materialised above —
# ZERO extra API calls, and the only in-band evidence available without a
# second request. It is emitted in BOTH branches so decide.py never sees a
# missing key. This is what keeps `--limit 100` from re-arming the identical
# silent failure at 100 instead of 30: breaching the page size becomes loud.
TARGET_BOARD_ISSUES_JSON=$(gh issue list --repo "$TARGET_GH_REPO" --state open \
  --limit "$GH_ISSUE_LIST_LIMIT" \
  --json number,labels --jq '[ .[] | { number: .number, labels: (.labels | map(.name)) } ]' 2>/dev/null || echo '')
if [ -n "$TARGET_BOARD_ISSUES_JSON" ]; then
  # Issue #4130: the healthy per-item read emits the ACCUMULATED lane verdict,
  # not a hard false — a failed COUNTS read earlier in the pass (which still
  # emitted its fail-open zeros) must flip this flag true even when THIS read
  # succeeded. That mixed-read shape is what the 2026-08-17 GraphQL-only
  # outage measurement caught: the flag keyed on one call while a sibling call
  # silently degraded. Emitted via command substitution so the first literal
  # degraded-true echo in this file stays the fail-closed branch below (tests
  # anchor their slices on it).
  echo "target_board_signals_degraded=$( [ "$TARGET_LANE_DEGRADED" = "1" ] && echo true || echo false )"
  printf '%s' "$TARGET_BOARD_ISSUES_JSON" | TARGET_WORK_QUEUE="$ARCH_WORK_QUEUE" \
    GH_ISSUE_LIST_LIMIT="$GH_ISSUE_LIST_LIMIT" \
    TARGET_CLEANUP_SCAN_LABEL="$TARGET_CLEANUP_SCAN_LABEL" \
    TARGET_WIRE_OR_RETIRE_LABEL="$TARGET_WIRE_OR_RETIRE_LABEL" \
    TARGET_DESIGN_QA_LABEL="$TARGET_DESIGN_QA_LABEL" \
    TARGET_DESIGN_QA_BOARD_SATURATION_CAP="$TARGET_DESIGN_QA_BOARD_SATURATION_CAP" \
    TARGET_DESIGN_QA_ADR_PRESENT="$TARGET_DESIGN_QA_ADR_PRESENT" \
    TARGET_CLEANUP_BOARD_SATURATION_CAP="$TARGET_CLEANUP_BOARD_SATURATION_CAP" python3 -c "$(cat <<'PY'
import json, os, sys
try:
  rows = json.load(sys.stdin)
  if not isinstance(rows, list):
    rows = []
  scan_label = os.environ.get('TARGET_CLEANUP_SCAN_LABEL', 'cleanup-scan')
  wor_label = os.environ.get('TARGET_WIRE_OR_RETIRE_LABEL', 'wire-or-retire')
  dqa_label = os.environ.get('TARGET_DESIGN_QA_LABEL', 'design-qa')
  cap = int(os.environ.get('TARGET_CLEANUP_BOARD_SATURATION_CAP', '10') or 10)
  dqa_cap = int(os.environ.get('TARGET_DESIGN_QA_BOARD_SATURATION_CAP', '5') or 5)
  wq = int(os.environ.get('TARGET_WORK_QUEUE', '0') or 0)
  # Lane->label mapping (ADR-0031): triage lane == needs-triage,
  # queued lane == ready-for-agent (all rows here are already open == not-done).
  triage_count = 0
  triage_item_numbers = []
  queued_count = 0
  open_scan = 0
  open_design_qa = 0
  wor_triage = 0
  # wire_or_retire_target_unlabelled (issue #3973) — ADVISORY count of open
  # `wire-or-retire` Target issues carrying NONE of the lifecycle labels
  # (needs-triage / ready-for-agent / ready-for-human / blocked). Such an item
  # is invisible to the resolver, which gates on `wire-or-retire` AND
  # needs-triage (#3726): `wire-or-retire` + a non-lifecycle label like `bug`
  # reads wire_or_retire_target_available=false while sitting in plain sight
  # (the live gaberoo322/hydra-betting#760 case). Advisory only — mirrors
  # target_board_signals_truncated: never gates dispatch and never relaxes the
  # AND (would regress #3726, the reason #3747 was closed). ready-for-human and
  # ready-for-agent are the resolver's own verdict outputs and are correctly
  # excluded — counting either would re-arm the resolver forever, the exact
  # hazard the AND predicate exists to prevent.
  wor_unlabelled = 0
  for row in rows:
    labels = row.get('labels') if isinstance(row, dict) else None
    if not isinstance(labels, list):
      continue
    in_triage = 'needs-triage' in labels
    if in_triage:
      triage_count += 1
      # Issue #3729 — emit the needs-triage item NUMBER set as a fresh per-turn
      # fact so decide.py's per-item verdict-stability guard can stamp each item
      # independently. collect-state.sh stays stateless (no state.json read); it
      # only enumerates the current set, mirroring its existing role for the
      # target_needs_triage COUNT. Numbers are sorted ascending for a deterministic
      # emit (decide.py parses them into a set, so order is not load-bearing).
      num = row.get('number')
      if isinstance(num, int):
        triage_item_numbers.append(num)
    if 'ready-for-agent' in labels:
      queued_count += 1
    if scan_label in labels:
      open_scan += 1
    if dqa_label in labels:
      open_design_qa += 1
    # Co-presence is intentional and load-bearing (issue #3726): needs-triage
    # is what keeps a wire-or-retire item in an operator-visible lane, and
    # hydra-target-sweep's triage step now exempts any wire-or-retire-carrying
    # item from its auto-promote path instead of stripping needs-triage off
    # it (docs/operator-playbooks/hydra-target-sweep.md Step 2), so this
    # predicate is safe to rely on as an AND, not a footgun to relax to an OR.
    if wor_label in labels and in_triage:
      wor_triage += 1
    # Independent accumulator (issue #3973): the same wire-or-retire item, but
    # counted toward the advisory unlabelled total only when it carries NONE of
    # the lifecycle labels. in_triage is needs-triage. Never relaxes the AND
    # predicate above — this is a separate count, computed in the same loop.
    if wor_label in labels and not (
      in_triage
      or 'ready-for-agent' in labels
      or 'ready-for-human' in labels
      or 'blocked' in labels
    ):
      wor_unlabelled += 1
  idle = (triage_count == 0 and queued_count == 0 and wq == 0)
  dqa_saturated = (open_design_qa > dqa_cap)
  # Issue #4528: the shell-side glob verdict, env-threaded like the label/cap
  # inputs. Defaults FALSE when absent (fail closed) — an unset input must
  # never arm the class.
  adr_present = (os.environ.get('TARGET_DESIGN_QA_ADR_PRESENT', 'false').strip().lower() == 'true')
  # Advisory truncation flag (issue #3710): the read succeeded, but a row count
  # at the page size means gh almost certainly dropped the OLDEST issues, so
  # every count below is a floor, not a total. Never gates dispatch.
  limit = int(os.environ.get('GH_ISSUE_LIST_LIMIT', '100') or 100)
  print('target_board_signals_truncated=' + ('true' if len(rows) >= limit else 'false'))
  # Issue #3729 — the per-item needs-triage set. Empty when the lane is empty.
  # The playbook merges this verbatim into state.signals.target_needs_triage_items
  # (the same verbatim-string seam as wayfinder_orch_frontier); decide.py parses
  # it into a set of ints. A degraded read (the else branch below) emits an empty
  # value, which decide.py treats as absent → fail-open on the coarse count.
  print('target_needs_triage_items=' + ' '.join(str(n) for n in sorted(set(triage_item_numbers))))
  print('target_backfill_idle=' + ('true' if idle else 'false'))
  print('target_cleanup_board_open_scan=' + str(open_scan))
  print('target_cleanup_board_saturated=' + ('true' if open_scan > cap else 'false'))
  print('wire_or_retire_target_triage=' + str(wor_triage))
  print('wire_or_retire_target_available=' + ('true' if wor_triage > 0 else 'false'))
  # Advisory only — nothing in decide.py gates on it (issue #3973).
  print('wire_or_retire_target_unlabelled=' + str(wor_unlabelled))
  print('design_qa_target_open=' + str(open_design_qa))
  print('design_qa_target_saturated=' + ('true' if dqa_saturated else 'false'))
  # Issue #4528: due ANDs on ADR presence — the advisory key publishes the
  # shell-side glob verdict so a dormant (permanently-false due) class is
  # observable, mirroring target_board_signals_degraded. decide.py reads ONLY
  # the due/saturated pair.
  print('design_qa_target_adr_present=' + ('true' if adr_present else 'false'))
  print('design_qa_target_due=' + ('true' if (not dqa_saturated and adr_present) else 'false'))
except Exception:
  print('target_board_signals_truncated=false')
  print('target_needs_triage_items=')
  print('target_backfill_idle=false')
  print('target_cleanup_board_open_scan=0')
  print('target_cleanup_board_saturated=true')
  print('wire_or_retire_target_triage=0')
  print('wire_or_retire_target_available=false')
  print('wire_or_retire_target_unlabelled=0')
  print('design_qa_target_open=0')
  print('design_qa_target_saturated=true')
  print('design_qa_target_adr_present=' + ('true' if os.environ.get('TARGET_DESIGN_QA_ADR_PRESENT', 'false').strip().lower() == 'true' else 'false'))
  print('design_qa_target_due=false')
PY
)" 2>/dev/null || { echo "target_board_signals_truncated=false"; echo "target_needs_triage_items="; echo "target_backfill_idle=false"; echo "target_cleanup_board_open_scan=0"; echo "target_cleanup_board_saturated=true"; echo "wire_or_retire_target_triage=0"; echo "wire_or_retire_target_available=false"; echo "wire_or_retire_target_unlabelled=0"; echo "design_qa_target_open=0"; echo "design_qa_target_saturated=true"; echo "design_qa_target_adr_present=$TARGET_DESIGN_QA_ADR_PRESENT"; echo "design_qa_target_due=false"; }
else
  # Fail closed AND observable: the board read was unreachable/empty, so emit
  # the suppressing defaults (never dispatch a scan/resolver that cannot read
  # its own board) but flag the degradation so it is not an invisible zero-set.
  # Issue #4130: the per-item read failing also sets the lane accumulator, so
  # the flag stays latched for the whole pass.
  TARGET_LANE_DEGRADED=1
  echo "target_board_signals_degraded=true"
  # Emitted in BOTH branches so decide.py never sees a missing key. A read that
  # never happened is not a truncated read — it is a degraded one.
  echo "target_board_signals_truncated=false"
  echo "target_needs_triage_items="
  echo "target_backfill_idle=false"
  echo "target_cleanup_board_open_scan=0"
  echo "target_cleanup_board_saturated=true"
  echo "wire_or_retire_target_triage=0"
  echo "wire_or_retire_target_available=false"
  echo "wire_or_retire_target_unlabelled=0"
  echo "design_qa_target_open=0"
  echo "design_qa_target_saturated=true"
  echo "design_qa_target_adr_present=$TARGET_DESIGN_QA_ADR_PRESENT"
  echo "design_qa_target_due=false"
fi
}

# Target risk-surface resolver (issue #4411, item (2) of wayfinder ticket
# #4324 on map #4313) — replaces decide.py's deleted
# `WIRE_OR_RETIRE_RISK_CARVEOUT` hardcoded constant. Runs
# `scripts/target/print-target-facts.ts` once per turn (the same seam every
# `hydra-target-*` playbook resolves through — see
# `_fragments/target-seam-preamble.md`) and emits its `manifest` sub-object
# verbatim as `target_risk_surface_json=`. The playbook merges this into
# state.json as `state.target_risk_surface`; decide.py's
# `_normalize_target_risk_surface` reads `.ok` / `.surfaceRepoRelative` and,
# per Invariant 1, performs NO manifest file read and NO subprocess of its
# own — collect-state.sh owns the resolution, decide.py stays a pure
# function of state.json (the same division of labour as
# `usage_eligibility_json` → `state.usage_eligibility`).
#
# Fail closed on any resolution failure (ADR-0026 decision 7): an
# unreachable `npx tsx`, a missing/malformed Target Manifest, or unparseable
# output all degrade to `{"ok":false,"errors":[...]}` — decide.py's
# `wire_or_retire_target` signal class WITHHOLDS its dispatch entirely on
# `ok:false` (never a hardcoded or empty fallback carve-out).
collect_target_risk_surface() {
local _target_risk_py_status
echo -n "target_risk_surface_json="
# NOTE (#4411 QA remediation): print-target-facts.ts deliberately exits 1
# whenever the manifest resolves to ok:false (an expected, non-crash
# outcome, e.g. no resolvable Target Manifest today) — that is a normal
# INPUT to the python3 extractor below, not a failure of this pipeline.
# Under `set -o pipefail` (line 24), gating the fallback on the pipeline's
# own combined exit status (a trailing `||` on it) misattributes that
# expected upstream exit code to the extractor and double-emits a line: the
# extractor's real `{"ok":false,...}` output followed by the generic
# fallback message. So the fallback below is gated ONLY on
# `PIPESTATUS[1]` — the python3 extractor's own exit status — never on
# tsx's (`PIPESTATUS[0]`). The extractor's except-branch already guarantees
# valid `{"ok":false,...}` JSON on any malformed/absent/erroring input, so
# it only exits nonzero if python3 itself failed to run at all (e.g.
# missing binary).
(cd "$SCRIPT_DIR/../.." && npx tsx scripts/target/print-target-facts.ts 2>/dev/null) \
  | python3 -c "$(cat <<'PY'
import json, sys
try:
  d = json.load(sys.stdin)
  manifest = d.get("manifest") if isinstance(d, dict) else None
  if not isinstance(manifest, dict):
    raise ValueError("no manifest field")
  print(json.dumps(manifest))
except Exception as e:
  print(json.dumps({"ok": False, "errors": ["target_risk_surface_json: " + str(e)]}))
PY
)"
_target_risk_py_status="${PIPESTATUS[1]}"
if [ "$_target_risk_py_status" -ne 0 ]; then
  echo '{"ok":false,"errors":["target_risk_surface_json: print-target-facts.ts unreachable"]}'
fi
unset _target_risk_py_status
}

# RETRO + WAYFINDER FRONTIER + TICKETS — Turn Snapshot collectors (ADR-0043
# slice 5B, issue #4933). collect_retro, collect_wayfinder_frontier and
# collect_tickets (and their heredocs) are now the typed `retro`,
# `wayfinder-frontier` and `tickets` collectors in
# src/autopilot/turn-snapshot/afk-frontier.ts, rendered byte-identically by
# render-kv-remaining.ts (golden files under test/fixtures/turn-snapshot/remaining/).
# The pre-resolution decide.py stays too pure to do (#920, #3871, #4244, #4584;
# #3351, #3354, #3400, ADR-0029; #4014) is unchanged; the module docblock
# carries the rules. Every failure still degrades in each signal's documented
# direction (retro_run_available=false, retro_run_drillable=true on a failed
# bundle read, wayfinder/tickets suppressed).
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note.
collect_turn_snapshot_afk_frontier() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors retro,wayfinder-frontier,tickets --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "orch turn-snapshot retro/wayfinder/tickets CLI failed or produced no output — emitting the fail-open fallback (issue #4933)" >&2
  printf '%s\n' $'retro_run_available=false\nretro_run_drillable=false\nwayfinder_orch_frontier=none\nwayfinder_orch_ticket_type=\nwayfinder_orch_inflight_global=0\ntickets_available=false\ntickets_orch_pending_spec=none'
fi
return 0
}

# DATA-PLANE PASSTHROUGHS — Turn Snapshot collectors (ADR-0043 slice 5,
# issue #4933). collect_scout_alerts, collect_realm_share,
# collect_usage_eligibility, collect_emergency_brake, collect_class_stats,
# collect_capacity, collect_scheduler, collect_recommendations and
# collect_slot_events (and their heredocs) are now typed collectors in
# src/autopilot/turn-snapshot/passthrough.ts, read through the injected hydra
# HTTP client (`hydra raw GET` semantics) and rendered byte-identically by
# render-kv-passthrough.ts (golden files under
# test/fixtures/turn-snapshot/passthrough/). The module docblock carries each
# signal's rules and the issues behind them (#486, #4161, #744, #2943, #4298,
# #509, #4510). The slot-events cursor still comes from
# HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID / HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT
# (turn.sh), which the CLI reads from its environment.
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note.
collect_turn_snapshot_passthrough() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors scout-alerts,realm-share,usage-eligibility,emergency-brake,class-stats,capacity,scheduler,recommendations,slot-events \
     --format kv) \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "orch turn-snapshot passthrough CLI failed or produced no output — emitting the fail-open fallback (issue #4933)" >&2
  printf '%s\n' $'scout_alert_eligible_count=0\n0\norch_realm_weekly_share=unavailable\nusage_eligibility_json={"allow":true,"shed":[],"reasons":{"calibrated":false}}\nemergency_brake_json={"engaged":false}\nclass_stats_json={"scoreboard":{"classes":[]},"shadow":{"verdicts":[]}}\ncapacity_floor_met=None capacity_floor_status=unmeasured capacity_window=0\nCODEX_IDLE\nscheduler=unknown stall=unknown\nrecommendations=unavailable\nslot_events_json={"events": [], "last_id": null}'
fi
return 0
}

# Run every collector in the order that defines the emitted key=value stream.
main() {
  collect_turn_snapshot_health
  collect_turn_snapshot_orch_board
  collect_target_board
  collect_turn_snapshot_orphans_needs_qa
  collect_turn_snapshot_pr_gate_and_picks
  collect_turn_snapshot_boards
  collect_target_scan_boards
  collect_target_risk_surface
  collect_turn_snapshot_afk_frontier
  collect_turn_snapshot_passthrough
}

# Execute main only when run (bash collect-state.sh), never when sourced.
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
