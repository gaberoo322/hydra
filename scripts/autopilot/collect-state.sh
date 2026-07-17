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

# health
hydra health 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print(f'health={d[\"status\"]} redis={d[\"redis\"]}')
except: print('health=FAIL')"

# failed services
echo -n "failed_services="; systemctl --user list-units --type=service --state=failed --no-legend 2>/dev/null | grep -c hydra || echo 0

# direction-doc drift (issue #1791)
#
# The orchestrator's COMMITTED copy of the Target direction docs lives at
# `config/direction/{priorities,roadmap}.md`. These are the runtime source of
# truth for the in-process readers — `readPriorities()` in
# src/api/recommendations.ts and `getCurrentMilestoneProgress()` in
# src/backlog/reads.ts both resolve them via HYDRA_CONFIG_PATH. The LIVE docs
# that `/hydra-target-research` now writes live in the Target repo at
# `$HYDRA_TARGET_REPO/direction/` (default ~/hydra-betting/direction/). Nothing
# syncs the two, so the orch copy silently lags the research cycle (it was 3
# milestones / 2 cycles stale on 2026-06-12 — issue #1791) and autopilot steers
# from a world two research cycles old.
#
# This collector is READ-ONLY (see the header contract — no Redis/GitHub/file
# writes). It does NOT mutate config/direction/ (that would dirty the deploy
# tree, the #1739 hazard). It only DETECTS divergence and emits a boolean
# signal so the autopilot turn can dispatch a refresh (the canonical refresh
# command is documented in docs/operator-playbooks/hydra-target-build.md
# "Direction docs" — copy the Target's direction/{priorities,roadmap}.md into
# config/direction/ on a feature branch and open a PR). `direction_drift=true`
# means the committed orch copy no longer matches the live Target docs;
# `false` means they agree (or the Target docs are unreachable, in which case
# there is nothing to sync against — fail closed to no-drift so a missing
# Target checkout never spuriously triggers a refresh dispatch).
echo -n "direction_drift="
_dd_target_dir="${HYDRA_TARGET_REPO:-$HOME/hydra-betting}/direction"
_dd_orch_dir="${HYDRA_CONFIG_PATH:-$HOME/hydra/config}/direction"
_dd_drift=false
for _dd_f in priorities.md roadmap.md; do
  _dd_live="$_dd_target_dir/$_dd_f"
  _dd_copy="$_dd_orch_dir/$_dd_f"
  # Only a readable live doc + readable orch copy can drift. A missing live
  # doc (Target not checked out) => nothing to sync against => no drift.
  if [ -r "$_dd_live" ] && [ -r "$_dd_copy" ]; then
    if ! cmp -s "$_dd_live" "$_dd_copy"; then
      _dd_drift=true
      break
    fi
  fi
done
echo "$_dd_drift"

# orchestrator-side issue board (counts + stale lists)
#
# The `ready_for_agent` count is the source signal for `dev_orch` dispatch
# (issue #458): when >0, the playbook MUST set
# `state.signals.orch_work_available = true` so decide.py's `dev_orch`
# selector fires. Before #458, `dev_orch` consumed /api/anchor/candidates
# — which in this deployment is structurally a target-product feed —
# causing hydra-dev to receive target-only anchors and escalate.
#
# `needs_qa` counts ISSUES with the `needs-qa` label. The hydra-qa skill
# is responsible for clearing this label from the source issue once it
# files a verdict (PASS / PASS-pending-CI / FAIL) — see issue #638. If
# QA leaves `needs-qa` on an issue while the PR sits waiting on CI or
# operator merge, decide.py will busy-loop re-dispatching hydra-qa every
# turn (each dispatch burns 30-65k tokens). The contract is: needs-qa on
# an issue means "diff has not yet been reviewed"; once reviewed, the PR
# carries the pending-CI state and autopilot polls statusCheckRollup
# directly without re-running QA.
#
# SEAM ROUTING (issue #934): the counts + stale lists below are now served by
# `GET /api/autopilot/board-state` (src/api/autopilot-board.ts), which buckets
# the open board on top of the GitHub-Read seam (src/github/issues.ts). The
# repo handle, the `--json` field set, and the orchestrator label vocabulary
# live in exactly one place (the TS seam) instead of being re-spelled in this
# bash `--jq`. We read that single surface and emit the same JSON shape the
# playbook stitches into state.json. FALLBACK: if the orchestrator is down OR
# returns `degraded:true` (its `gh` read failed), we drop back to the inline
# `gh` call so a transient outage never wedges the autopilot turn.
BOARD_STATE_JSON=$(hydra raw GET /autopilot/board-state 2>/dev/null || true)
BOARD_STATE_DEGRADED=$(printf '%s' "$BOARD_STATE_JSON" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  # degraded, or missing required count fields → treat as unusable.
  ok = isinstance(d,dict) and not d.get('degraded', False) and 'ready_for_agent' in d
  print('0' if ok else '1')
except Exception:
  print('1')" 2>/dev/null || echo 1)
if [ "$BOARD_STATE_DEGRADED" = "0" ]; then
  # Strip the endpoint-only fields (degraded, generatedAt) so the emitted shape
  # matches the historical inline `--jq` output exactly.
  printf '%s' "$BOARD_STATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
keys=['needs_qa','ready_for_agent','needs_triage','needs_research','in_progress','blocked','stale_in_progress','stale_blocked']
print(json.dumps({k:d[k] for k in keys}))"
else
  # Fallback: orchestrator down or its gh read degraded — read directly.
  gh issue list --repo gaberoo322/hydra --state open --json number,labels,updatedAt --jq '{
    needs_qa: [.[] | select(.labels | map(.name) | index("needs-qa"))] | length,
    ready_for_agent: [.[] | select((.labels | map(.name)) as $n | ($n | index("ready-for-agent")) and (($n | index("target-backlog")) | not))] | length,
    needs_triage: [.[] | select(.labels | map(.name) | index("needs-triage"))] | length,
    needs_research: [.[] | select(.labels | map(.name) | index("needs-research"))] | length,
    in_progress: [.[] | select(.labels | map(.name) | index("in-progress"))] | length,
    blocked: [.[] | select(.labels | map(.name) | index("blocked"))] | length,
    stale_in_progress: [.[] | select((.labels | map(.name) | index("in-progress")) and ((now - (.updatedAt | fromdateiso8601)) > 5400))] | map(.number),
    stale_blocked: [.[] | select((.labels | map(.name) | index("blocked")) and ((now - (.updatedAt | fromdateiso8601)) > 43200))] | map(.number)
  }'
fi

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
# We emit the three counts decide.py's Target branch consumes as its dispatch
# signals, prefixed `target_` so they never collide with the orch board counts
# above:
#   - `target_ready_for_agent` — >0 → the autopilot sets
#     `target_board_work_available`, which decide.py's `dev_target` selector
#     reads (ready-for-agent present → dispatch hydra-target-build).
#   - `target_needs_qa`        — >0 → `needs_qa_target` → `qa_target`.
#   - `target_needs_research`  — surfaced for completeness / symmetry.
# `dev_target` empty (target_ready_for_agent==0) → the autopilot sets
# `target_board_research_due`, which decide.py's `research_target` selector
# reads (board empty → dispatch hydra-target-research).
#
# EXPAND PHASE (ADR-0030 expand-contract, ADR-0031 Decision 6 drain-and-fresh):
# nothing is deleted yet. The Redis Target reads (work_queue / reframe_queue /
# prior_failures / the /api/backlog lane reads below) stay in place in parallel;
# decide.py's Target selectors fire on EITHER the Redis signal OR the new
# GitHub-board signal during the cutover. FALLBACK mirrors the orch block: on a
# degraded/unreachable orchestrator we drop back to a direct REST `gh` read
# against the Target repo (ADR-0031 Decision 6 — REST, never GraphQL, on the
# money-critical Target hot path), so a transient outage never wedges the turn.
TARGET_GH_REPO="${HYDRA_TARGET_GITHUB_REPO:-gaberoo322/hydra-betting}"
TARGET_BOARD_STATE_JSON=$(hydra raw GET "/autopilot/board-state?scope=target" 2>/dev/null || true)
TARGET_BOARD_STATE_DEGRADED=$(printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  ok = isinstance(d,dict) and not d.get('degraded', False) and 'ready_for_agent' in d
  print('0' if ok else '1')
except Exception:
  print('1')" 2>/dev/null || echo 1)
if [ "$TARGET_BOARD_STATE_DEGRADED" = "0" ]; then
  printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
# Emit only the counts decide.py's Target branch consumes, prefixed target_ so
# they never collide with the orch board counts above.
print('target_ready_for_agent=' + str(d.get('ready_for_agent', 0)))
print('target_needs_qa=' + str(d.get('needs_qa', 0)))
print('target_needs_research=' + str(d.get('needs_research', 0)))"
else
  # Fallback: orchestrator down or its gh read degraded — read the Target repo
  # directly over REST (never GraphQL — ADR-0031 Decision 6). Note this fallback
  # does NOT apply the #3059 open-blocker filter (which needs the async blocker
  # resolve the endpoint owns); the healthy endpoint path above is the
  # blocked-excluding source of truth. Best-effort: any failure emits zeros.
  gh issue list --repo "$TARGET_GH_REPO" --state open --json number,labels --jq '{
    target_ready_for_agent: [.[] | select(.labels | map(.name) | index("ready-for-agent"))] | length,
    target_needs_qa: [.[] | select(.labels | map(.name) | index("needs-qa"))] | length,
    target_needs_research: [.[] | select(.labels | map(.name) | index("needs-research"))] | length
  } | to_entries | map("\(.key)=\(.value)") | .[]' 2>/dev/null \
    || { echo "target_ready_for_agent=0"; echo "target_needs_qa=0"; echo "target_needs_research=0"; }
fi

# untriaged-orphans triage backstop (issue #2426).
#
# The dev_orch dispatch path keys ONLY on `ready-for-agent` and the triage
# path keys ONLY on `needs-triage`, so an open issue carrying NONE of the
# actionable/lifecycle labels {ready-for-agent, in-progress, blocked,
# needs-qa, needs-triage, needs-research, target-backlog, ready-for-human,
# needs-info}
# is invisible to BOTH — nothing re-triages an issue that landed with the
# wrong label (e.g. only `enhancement` / `meta-friction` / `backlog`).
# Observed live 2026-06-24: 7 open issues sat in this blind spot with no
# route to either dispatch or triage.
#
# `ready-for-human` (issue #2828) is a TERMINAL operator-queue label — an
# issue carrying it is NOT an orphan, it is parked awaiting a human decision
# (e.g. the daily `Operator decision queue YYYY-MM-DD` issue). Excluding it
# stops `sweep_orch` from re-triaging the operator queue every idle turn.
#
# `needs-info` (issue #2958) is the same shape: the triage bot parks an issue
# `needs-info` when the OPERATOR must supply ACs / a design pick before dev
# can run. Counting it as an orphan made decide.py dispatch `sweep_orch`
# every turn against an issue sweep cannot advance — pure churn (observed
# run 038937ae, 2026-07-06, issue #2956).
#
# This emits `untriaged_orphans` = the count of open issues carrying NONE of
# that label set. The autopilot turn maps `untriaged_orphans > 0` → the
# boolean `untriaged_orphans_orch` signal (mirroring the
# `needs_triage > 0` → `needs_triage_orch` mapping), which decide.py's
# `sweep_orch` selector reads as a SECONDARY trigger to dispatch hydra-sweep
# and route the orphans into an actionable lane. This is a STANDALONE `gh`
# read (not derived from the board-state seam) so the backstop holds whether
# or not `/api/autopilot/board-state` is healthy. Best-effort: any failure
# emits `untriaged_orphans=0` so a transient gh outage never spuriously
# triggers a sweep.
echo -n "untriaged_orphans="
gh issue list --repo gaberoo322/hydra --state open --json number,labels --jq '
  [ .[]
    | select(
        (.labels | map(.name)) as $n
        | ([ "ready-for-agent", "in-progress", "blocked", "needs-qa",
             "needs-triage", "needs-research", "target-backlog",
             "ready-for-human", "needs-info" ]
           | any(. as $lbl | $n | index($lbl))) | not
      )
  ] | length' 2>/dev/null || echo 0

# design-concept gate (issue #628): pick the first orch-board
# `ready-for-agent` issue whose design-concept artifact is missing or
# stale. The autopilot promotes this to `state.signals.orch_pending_grill_anchor`
# which decide.py's `design_concept_orch` selector reads as the gate
# trigger. Pre-#628 the selector only consumed `best.designConcept` from
# /api/anchor/candidates — but `best` is structurally a target-scope
# candidate post-#458 (see issue #628 research comment), so the selector
# never fired on orch work even after Phase B shipped. This loop sources
# an orch-scope anchor directly.
#
# Mechanical/non-implementable gate (issue #1230): some ready-for-agent
# issues need NO design concept and grilling them wastes a Fable 5
# design_concept_orch subagent before dev_orch even runs:
#
#   - `cleanup-scan` findings (hydra-cleanup output) are mechanical and
#     self-checking ("remove X AND npm test/tsc pass") — they route straight
#     to dev. Grilling a one-line dead-code deletion is pure waste.
#   - `track:`-prefixed measurement-window trackers are not implementable
#     now (their window is open); a design concept for them is premature.
#
# These are suppressed UNCONDITIONALLY (a positive "skip" signal, unlike the
# trivial gate below which only suppresses on an explicit T1 stamp). The
# `cleanup-scan` exclusion is firm; the `track:` title-prefix exclusion is
# the "consider also skipping calendar-bound issues" half of #1230.
#
# Trivial-anchor gate (issue #1088): grilling EVERY ready-for-agent anchor
# made design_concept_orch the highest-frequency subagent class (~14% of
# burn) — most orch issues (T1 prompt tweaks, doc edits, dead-code removal)
# are fully specified by their body and waste a full grill. We now suppress
# the grill for *provably trivial* anchors. Rule (fail-toward-grill):
#
#   - Per-issue tier CANNOT be derived from /api/tier here — classifyChange()
#     is purely file-PATH based and a ready-for-agent issue has no file list
#     until a PR exists. The only pre-PR signal is the `Expected tier:` body
#     stamp (emitted by hydra-prd / hydra-cleanup).
#   - Suppress the grill ONLY on a POSITIVE trivial signal: an explicit
#     `Expected tier: T1` (or `Expected tier: 1`) stamp in the body AND no
#     `needs-design-concept` label.
#   - ALWAYS grill (do NOT suppress) when: the `needs-design-concept` label
#     is present, OR a T2/T3/T4 stamp is present, OR there is NO stamp at all
#     (unknown complexity). Skip is the unsafe direction — a silently-skipped
#     complex unstamped issue goes straight to dev_orch without a design
#     concept — so absence of a signal NEVER suppresses.
#
# Implementation notes:
#
#   - Top 10 ready-for-agent issue numbers (newest-first by updatedAt).
#     The hot path is "the first one without a fresh artifact"; capping
#     at 10 keeps this loop O(10) regardless of board size.
#   - One `gh issue list` fetches number+updatedAt+body+labels for all 10,
#     so the trivial gate needs no extra per-issue gh round-trip.
#   - For each issue we curl `/api/design-concepts/issue-<N>`. A 200 with
#     `gate.ok` true OR `status=approved` AND fresh means we skip. A 404
#     or stale/draft-without-gate-ok means this is a grill candidate — but
#     a provably-trivial candidate is suppressed (continue) rather than
#     promoted, so the loop falls through to the next non-trivial anchor.
#   - Emit the first matching `issue-<N>` ref, or `none`.
#   - Best-effort: any failure prints `none` so dispatch is never blocked
#     by a transient orchestrator outage.
echo -n "orch_pending_grill_anchor="
# Exclude `target-backlog` issues from the grill candidate set (issue #2704):
# `target-backlog` is the routing label for Target work (code in hydra-betting).
# An issue carrying BOTH `ready-for-agent` and `target-backlog` (e.g. #2701)
# is Target-scope, but grilling it here fires an orchestrator-scope
# `design_concept_orch` grill against target code — a scope mismatch that
# re-fires every idle turn. Drop such issues from the candidate list up front,
# mirroring how the untriaged-orphans jq excludes label sets above.
ORCH_GRILL_LIST_JSON=$(gh issue list --repo gaberoo322/hydra --state open --label ready-for-agent --json number,updatedAt,body,labels,title --jq '
  [ .[] | select((.labels | map(.name) | index("target-backlog")) | not) ]
  | sort_by(.updatedAt) | reverse | .[0:10]
' 2>/dev/null || true)
ORCH_GRILL_CANDIDATES=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | python3 -c "
import json, sys
try:
  for it in json.load(sys.stdin):
    print(it['number'])
except Exception:
  pass
" 2>/dev/null || true)
ORCH_GRILL_PICK="none"
if [ -n "$ORCH_GRILL_CANDIDATES" ]; then
  for n in $ORCH_GRILL_CANDIDATES; do
    DC_JSON=$(curl -sf --max-time 3 "http://localhost:4000/api/design-concepts/issue-${n}" 2>/dev/null || true)
    if [ -n "$DC_JSON" ]; then
      # Artifact exists. Skip ONLY if it's fresh (Phase B warn-only: a
      # draft/!gateOk-but-fresh artifact is still "fresh present" per the
      # selector's contract, so we don't re-grill it here either). A stale
      # or unparseable artifact falls through to the trivial gate below.
      FRESH_OK=$(printf '%s' "$DC_JSON" | python3 -c "
import json, sys, time
try:
  d = json.load(sys.stdin)
  created = int(d.get('createdAt', 0) or 0)
  now_ms = int(time.time() * 1000)
  fresh = (now_ms - created) <= (7 * 24 * 60 * 60 * 1000)
  print('1' if fresh else '0')
except Exception:
  print('0')" 2>/dev/null || echo "0")
      if [ "$FRESH_OK" = "1" ]; then
        # Fresh artifact already present — nothing to grill for this anchor.
        continue
      fi
    fi
    # No fresh artifact for issue-<N>: it would be a grill candidate. First
    # apply the mechanical/non-implementable gate (issue #1230) — suppress
    # UNCONDITIONALLY when the issue carries the `cleanup-scan` label (routes
    # straight to dev, needs no design) OR has a `track:` title prefix
    # (calendar-bound measurement window, not implementable now). MECHANICAL=1
    # means suppress; any parse error prints 0 → fall through to the next gate.
    MECHANICAL=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | python3 -c "
import json, sys
target = int('${n}')
try:
  items = json.load(sys.stdin)
  it = next((x for x in items if int(x.get('number', -1)) == target), None)
  if it is None:
    print('0'); sys.exit(0)
  labels = {l.get('name', '') for l in (it.get('labels') or [])}
  if 'cleanup-scan' in labels:
    # Mechanical, self-checking dead-code removal — routes straight to dev.
    print('1'); sys.exit(0)
  title = (it.get('title') or '').lstrip()
  if title.lower().startswith('track:'):
    # Calendar-bound measurement-window tracker — not implementable now.
    print('1'); sys.exit(0)
  print('0')
except Exception:
  print('0')" 2>/dev/null || echo "0")
    if [ "$MECHANICAL" = "1" ]; then
      # Mechanical (cleanup-scan) or calendar-bound (track:) anchor — needs no
      # design concept. Suppress the grill and let dev_orch dispatch directly.
      continue
    fi
    # Apply the trivial gate (issue #1088) next — suppress ONLY on a positive
    # trivial signal. TRIVIAL=1 means "explicit Expected tier: T1/1 stamp AND
    # no needs-design-concept label". Any ambiguity (parse error, missing
    # field) prints 0 → fail-toward-grill.
    TRIVIAL=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | python3 -c "
import json, re, sys
target = int('${n}')
try:
  items = json.load(sys.stdin)
  it = next((x for x in items if int(x.get('number', -1)) == target), None)
  if it is None:
    print('0'); sys.exit(0)
  labels = {l.get('name', '') for l in (it.get('labels') or [])}
  if 'needs-design-concept' in labels:
    # Explicit opt-in always grills, regardless of any stamp.
    print('0'); sys.exit(0)
  body = it.get('body') or ''
  # Match an explicit T1 stamp: 'Expected tier: T1' or 'Expected tier: 1'.
  # A T2/T3/T4 stamp (or no stamp) is NOT trivial → grill.
  trivial = re.search(r'Expected\s+tier:\s*T?1\b', body, re.IGNORECASE) is not None
  print('1' if trivial else '0')
except Exception:
  print('0')" 2>/dev/null || echo "0")
    if [ "$TRIVIAL" = "1" ]; then
      # Provably trivial (T1-stamped, no opt-in label) — suppress the grill
      # and let this anchor fall straight through to dev_orch.
      continue
    fi
    ORCH_GRILL_PICK="issue-${n}"
    break
  done
fi
echo "$ORCH_GRILL_PICK"

# active dev_orch detector (issue #412): an open PR on a hydra-dev head
# branch updated within the last 90 minutes is the only reliable gate
# signal — the `in-progress` label can go stale when an earlier cycle
# died before producing a PR. We match the three branch-name prefixes
# hydra-dev actually creates: `issue-<N>-<slug>`, `hydra-dev/<...>`,
# and the harness-created `worktree-agent-<hash>` (Claude Agent tool
# isolation=worktree). 5400s = 90 min, matching the Phase 1.5 stale
# threshold so the two signals line up.
echo -n "active_dev_orch="
gh pr list --repo gaberoo322/hydra --state open --json updatedAt,headRefName --jq '[
  .[]
  | select(
      (.headRefName | startswith("issue-"))
      or (.headRefName | startswith("hydra-dev/"))
      or (.headRefName | startswith("worktree-agent-"))
    )
  | select((now - (.updatedAt | fromdateiso8601)) < 5400)
] | length' 2>/dev/null || echo 0

# backlog + queues
hydra raw GET /backlog/counts 2>/dev/null || hydra backlog ls | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(json.dumps({l: len(d.get(l,[])) for l in ['queued','inProgress','blocked','triage']}))"
echo -n "work_queue="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null || echo 0
echo -n "reframe_queue="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:reframe-queue 2>/dev/null || echo 0
echo -n "prior_failures="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:prior-failures 2>/dev/null || echo 0

# Tool Scout — Phase B calendar walk signals (issue #485).
#
# `scout_walk_due` is true when the per-class (`scout_orch`) calendar
# cooldown has elapsed (default 7d). Sourced from
# `hydra:scout:last-calendar-walk` (ISO-8601 UTC). decide.py turns this
# into a dispatch on the `scout_orch` signal class.
#
# `scout_board_saturated` mirrors the playbook's "When NOT to run this"
# clause: skip the calendar walk if the orchestrator board already has
# >20 open `enhancement` issues (the operator should drain before adding
# more proposal-grade work). Threshold lives here so the playbook
# doesn't have to grep state JSON.
echo -n "scout_last_walk_iso="; docker exec hydra-redis-1 redis-cli GET hydra:scout:last-calendar-walk 2>/dev/null | tr -d '"' || echo ""
echo -n "scout_board_open_enhancements="
gh issue list --repo gaberoo322/hydra --state open --label enhancement --json number --jq 'length' 2>/dev/null || echo 0

# Tool Scout — Phase B cost-cap (issue #532).
#
# Mirror today's scout token spend into `hydra:scout:spend:<DATE>` (7d TTL)
# and emit a USD-converted value so decide.py's `scout_orch` selector can
# enforce `scout_cost_share * daily_spend_cap_usd` before dispatch.
#
# Source of truth: `hydra:metrics:tokens:by-skill:daily:<DATE>` HASH, field
# `hydra-tool-scout`, populated by the existing /api/metrics/tokens writer
# (issue #394). We mirror rather than read the surrogate directly because
# the gate documented in the issue body keys off `hydra:scout:spend:<DATE>`
# explicitly, and a tiny derived projection keeps the gate's read path
# free of cross-namespace coupling.
#
# Dollar conversion uses `HYDRA_TOKEN_USD_RATE` (USD per million tokens,
# matching src/cost-surrogate.ts). When the rate is 0 or unset, USD
# evaluates to 0 — decide.py treats that as "rate not configured" and
# skips the cap (the gate is opt-in on the rate, mirroring the dashboard).
SCOUT_TODAY_DATE="$(date -u +%Y-%m-%d)"
SCOUT_TOKENS_TODAY=$(docker exec hydra-redis-1 redis-cli HGET "hydra:metrics:tokens:by-skill:daily:${SCOUT_TODAY_DATE}" hydra-tool-scout 2>/dev/null | tr -d '"' || true)
if [ -z "$SCOUT_TOKENS_TODAY" ] || ! [[ "$SCOUT_TOKENS_TODAY" =~ ^[0-9]+$ ]]; then
  SCOUT_TOKENS_TODAY=0
fi
# Mirror into hydra:scout:spend:<DATE> with 7d TTL. SETEX is atomic; a
# Redis outage here is non-fatal because the next collect tick will retry.
docker exec hydra-redis-1 redis-cli SET "hydra:scout:spend:${SCOUT_TODAY_DATE}" "$SCOUT_TOKENS_TODAY" EX 604800 >/dev/null 2>&1 || true
# Convert to USD via HYDRA_TOKEN_USD_RATE (USD per million tokens; default 0
# = unconfigured). `awk` keeps this hermetic — no python boot just for one
# multiply. When the rate is 0 (or unset/non-numeric), spend evaluates to
# 0.00 and decide.py treats the cap as inactive.
SCOUT_USD_RATE="${HYDRA_TOKEN_USD_RATE:-0}"
SCOUT_SPEND_USD=$(awk -v t="$SCOUT_TOKENS_TODAY" -v r="$SCOUT_USD_RATE" 'BEGIN {
  if (r+0 <= 0 || t+0 <= 0) { printf "0.00"; }
  else { printf "%.6f", (t+0) / 1000000.0 * (r+0); }
}')
echo "scout_tokens_today=${SCOUT_TOKENS_TODAY}"
echo "scout_spend_usd_today=${SCOUT_SPEND_USD}"

# Board-idle backfill + saturation signals (issue #789, epic #787; unified
# under one canonical signal by issue #959, epic #958).
#
# These mirror the scout_board_open_enhancements / scout_board_saturated
# precedent above. The autopilot promotes them into state.signals so the
# backfill-set selectors in decide.py (`architecture_orch` #790, the
# revived `discover_orch` #959, and `cleanup_orch` #960) can fire a deepening /
# discovery / dead-code pass ONLY when the orchestrator board is genuinely idle
# AND the pass hasn't already flooded the board with its own proposals.
# `cleanup_board_saturated` (below) is cleanup_orch's own anti-flood cap,
# mirroring `arch_board_saturated`.
#
# `orch_backfill_idle` — the SINGLE canonical board-empty signal: true when
# the orchestrator board is empty of actionable work, i.e. ready_for_agent
# == 0 AND needs_research == 0 AND needs_triage == 0 AND work_queue == 0.
# This is the "nothing else to do, go backfill" trigger. Issue #959 renamed
# it from `arch_fallback_due` and pointed BOTH backfill-set classes at it,
# so the board-empty predicate is computed in exactly ONE place and emitted
# as ONE line — decide.py never recomputes board-empty or cooldown, it reads
# this precomputed signal only (the signal-seam discipline). The previously
# dead `orch_idle` name that discover_orch keyed off is gone — collect-state
# never emitted it, so discover_orch could never fire before #959. The per-class cooldown is applied
# downstream by decide.py off `arch_last_run_iso` (mirroring how
# `scout_last_walk_iso` gates `scout_walk_due`); the cooldown timestamp is
# stamped by the dispatched architecture skill, not here, so a crash on
# this read can't suppress the next tick's retry.
#
# `arch_board_saturated` — true when the count of OPEN architecture-sourced
# issues exceeds the cap (6). Architecture-sourced issues are countable via
# the STABLE `architecture-scan` label, mirroring how scout tags its
# proposals with `enhancement`. This is the anti-feedback-loop guard: it
# stops the pass from manufacturing low-value work to fill an idle queue.
# The cap lives here (not in the playbook) so the playbook doesn't have to
# grep state JSON, matching the scout saturation precedent. Issues #788/#791
# agree on the `architecture-scan` label as the emit/count seam.
ARCH_SCAN_LABEL="architecture-scan"
ARCH_BOARD_SATURATION_CAP=6
# `cleanup_board_saturated` (issue #960, epic #958) is the anti-flood cap for
# the cleanup_orch backfill class, mirroring arch_board_saturated exactly: true
# when the count of OPEN issues carrying the stable `cleanup-scan` label exceeds
# the cap. The /hydra-cleanup skill stamps every emitted issue with this label
# (the emit/count seam), and decide.py's cleanup_orch selector checks
# `cleanup_board_saturated` FIRST (before the 1h cooldown) so a board already
# full of open cleanup findings suppresses further scans rather than
# manufacturing duplicate deletion tickets. The cap lives here (not in the
# playbook) so the playbook never greps state JSON — the scout/arch precedent.
CLEANUP_SCAN_LABEL="cleanup-scan"
CLEANUP_BOARD_SATURATION_CAP=10
# Single board read: the three actionable-label counts plus the
# architecture-sourced and cleanup-sourced counts, in one gh call to keep this
# collector cheap.
ARCH_BOARD_JSON=$(gh issue list --repo gaberoo322/hydra --state open --json number,labels --jq "{
  ready_for_agent: [.[] | select((.labels | map(.name)) as \$n | (\$n | index(\"ready-for-agent\")) and ((\$n | index(\"target-backlog\")) | not))] | length,
  needs_research: [.[] | select(.labels | map(.name) | index(\"needs-research\"))] | length,
  needs_triage: [.[] | select(.labels | map(.name) | index(\"needs-triage\"))] | length,
  arch_sourced: [.[] | select(.labels | map(.name) | index(\"${ARCH_SCAN_LABEL}\"))] | length,
  cleanup_sourced: [.[] | select(.labels | map(.name) | index(\"${CLEANUP_SCAN_LABEL}\"))] | length
}" 2>/dev/null || echo '{"ready_for_agent":0,"needs_research":0,"needs_triage":0,"arch_sourced":0,"cleanup_sourced":0}')
ARCH_WORK_QUEUE=$(docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null || echo 0)
if ! [[ "$ARCH_WORK_QUEUE" =~ ^[0-9]+$ ]]; then
  ARCH_WORK_QUEUE=0
fi
echo -n "arch_last_run_iso="; docker exec hydra-redis-1 redis-cli GET hydra:architecture:last-run 2>/dev/null | tr -d '"' || echo ""
printf '%s' "$ARCH_BOARD_JSON" | ARCH_WORK_QUEUE="$ARCH_WORK_QUEUE" ARCH_BOARD_SATURATION_CAP="$ARCH_BOARD_SATURATION_CAP" CLEANUP_BOARD_SATURATION_CAP="$CLEANUP_BOARD_SATURATION_CAP" python3 -c "
import json, os, sys
try:
  d = json.load(sys.stdin)
  rfa = int(d.get('ready_for_agent', 0) or 0)
  nr = int(d.get('needs_research', 0) or 0)
  nt = int(d.get('needs_triage', 0) or 0)
  arch = int(d.get('arch_sourced', 0) or 0)
  cleanup = int(d.get('cleanup_sourced', 0) or 0)
except Exception:
  rfa = nr = nt = arch = cleanup = 0
wq = int(os.environ.get('ARCH_WORK_QUEUE', '0') or 0)
cap = int(os.environ.get('ARCH_BOARD_SATURATION_CAP', '6') or 6)
cleanup_cap = int(os.environ.get('CLEANUP_BOARD_SATURATION_CAP', '10') or 10)
fallback_due = (rfa == 0 and nr == 0 and nt == 0 and wq == 0)
saturated = (arch > cap)
cleanup_saturated = (cleanup > cleanup_cap)
print('orch_backfill_idle=' + ('true' if fallback_due else 'false'))
print('arch_board_open_scan=' + str(arch))
print('arch_board_saturated=' + ('true' if saturated else 'false'))
print('cleanup_board_open_scan=' + str(cleanup))
print('cleanup_board_saturated=' + ('true' if cleanup_saturated else 'false'))
" 2>/dev/null || { echo "orch_backfill_idle=false"; echo "arch_board_open_scan=0"; echo "arch_board_saturated=false"; echo "cleanup_board_open_scan=0"; echo "cleanup_board_saturated=false"; }

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
# `design_qa_target_due` / `design_qa_target_saturated` — (issue #2739, parent
# #2732, the Target UI-quality loop) drive the periodic visual-QA pass. This is
# a CALENDAR-cadence class like scout_orch: decide.py's 7d class cooldown owns
# the cadence, so `design_qa_target_due` is simply "board reachable AND not
# saturated" — there is always UI to review. `design_qa_target_saturated` is the
# anti-flood cap: true when more than DESIGN_QA_BOARD_SATURATION_CAP (5) open
# items carrying the stable `design-qa` label sit in any lane except `done`
# (the /hydra-design-qa emit runner stamps every finding with this label).
# Orchestrator-API-down degrades to due=false / saturated=true — BOTH the
# suppressing direction (fail closed: never dispatch a visual pass that cannot
# read its own board to dedup against).
TARGET_CLEANUP_SCAN_LABEL="cleanup-scan"
TARGET_CLEANUP_BOARD_SATURATION_CAP=10
TARGET_WIRE_OR_RETIRE_LABEL="wire-or-retire"
TARGET_DESIGN_QA_LABEL="design-qa"
TARGET_DESIGN_QA_BOARD_SATURATION_CAP=5
TARGET_BACKLOG_JSON=$(curl -sf --max-time 5 "http://localhost:4000/api/backlog" 2>/dev/null || echo '')
if [ -n "$TARGET_BACKLOG_JSON" ]; then
  printf '%s' "$TARGET_BACKLOG_JSON" | TARGET_WORK_QUEUE="$ARCH_WORK_QUEUE" \
    TARGET_CLEANUP_SCAN_LABEL="$TARGET_CLEANUP_SCAN_LABEL" \
    TARGET_WIRE_OR_RETIRE_LABEL="$TARGET_WIRE_OR_RETIRE_LABEL" \
    TARGET_DESIGN_QA_LABEL="$TARGET_DESIGN_QA_LABEL" \
    TARGET_DESIGN_QA_BOARD_SATURATION_CAP="$TARGET_DESIGN_QA_BOARD_SATURATION_CAP" \
    TARGET_CLEANUP_BOARD_SATURATION_CAP="$TARGET_CLEANUP_BOARD_SATURATION_CAP" python3 -c "
import json, os, sys
try:
  lanes = json.load(sys.stdin)
  triage = lanes.get('triage') or []
  queued = lanes.get('queued') or []
  label = os.environ.get('TARGET_CLEANUP_SCAN_LABEL', 'cleanup-scan')
  wor_label = os.environ.get('TARGET_WIRE_OR_RETIRE_LABEL', 'wire-or-retire')
  dqa_label = os.environ.get('TARGET_DESIGN_QA_LABEL', 'design-qa')
  cap = int(os.environ.get('TARGET_CLEANUP_BOARD_SATURATION_CAP', '10') or 10)
  dqa_cap = int(os.environ.get('TARGET_DESIGN_QA_BOARD_SATURATION_CAP', '5') or 5)
  wq = int(os.environ.get('TARGET_WORK_QUEUE', '0') or 0)
  open_scan = 0
  open_design_qa = 0
  for lane, rows in lanes.items():
    if lane in ('done', 'counts') or not isinstance(rows, list):
      continue
    for row in rows:
      labels = row.get('labels') if isinstance(row, dict) else None
      if not isinstance(labels, list):
        continue
      if label in labels:
        open_scan += 1
      if dqa_label in labels:
        open_design_qa += 1
  wor_triage = 0
  for row in triage:
    labels = row.get('labels') if isinstance(row, dict) else None
    if isinstance(labels, list) and wor_label in labels:
      wor_triage += 1
  idle = (len(triage) == 0 and len(queued) == 0 and wq == 0)
  dqa_saturated = (open_design_qa > dqa_cap)
  print('target_backfill_idle=' + ('true' if idle else 'false'))
  print('target_cleanup_board_open_scan=' + str(open_scan))
  print('target_cleanup_board_saturated=' + ('true' if open_scan > cap else 'false'))
  print('wire_or_retire_target_triage=' + str(wor_triage))
  print('wire_or_retire_target_available=' + ('true' if wor_triage > 0 else 'false'))
  print('design_qa_target_open=' + str(open_design_qa))
  print('design_qa_target_saturated=' + ('true' if dqa_saturated else 'false'))
  print('design_qa_target_due=' + ('false' if dqa_saturated else 'true'))
except Exception:
  print('target_backfill_idle=false')
  print('target_cleanup_board_open_scan=0')
  print('target_cleanup_board_saturated=true')
  print('wire_or_retire_target_triage=0')
  print('wire_or_retire_target_available=false')
  print('design_qa_target_open=0')
  print('design_qa_target_saturated=true')
  print('design_qa_target_due=false')
" 2>/dev/null || { echo "target_backfill_idle=false"; echo "target_cleanup_board_open_scan=0"; echo "target_cleanup_board_saturated=true"; echo "wire_or_retire_target_triage=0"; echo "wire_or_retire_target_available=false"; echo "design_qa_target_open=0"; echo "design_qa_target_saturated=true"; echo "design_qa_target_due=false"; }
else
  echo "target_backfill_idle=false"
  echo "target_cleanup_board_open_scan=0"
  echo "target_cleanup_board_saturated=true"
  echo "wire_or_retire_target_triage=0"
  echo "wire_or_retire_target_available=false"
  echo "design_qa_target_open=0"
  echo "design_qa_target_saturated=true"
  echo "design_qa_target_due=false"
fi

# Per-run retrospective — daily trigger (issue #920, epic #917).
#
# `retro_run_available` is true when at least one COMPLETED autopilot run
# exists to analyse. The autopilot promotes it into
# `state.signals.retro_run_available`; decide.py's `retro_orch` signal class
# (issue #920) reads it verbatim and dispatches /hydra-retro on the most-
# recent completed run. The 24h per-class cooldown (SIGNAL_COOLDOWNS in
# decide.py) is what enforces the once-per-day cadence — this signal only
# asserts that there is SOMETHING to retro, mirroring how scout_walk_due /
# orch_backfill_idle are pure board/state reads with the cooldown applied
# downstream.
#
# A "completed" run is any run whose `status` is NOT `running` (the run-tree
# writer flips it to ended/killed/completed on clean exit or read-time
# sweep — see src/autopilot/runs.ts term_reason handling). We read the runs
# index (`/api/autopilot/runs`, the same digest the dashboard consumes) and
# count terminal runs. This is read-only — no Redis writes, no cursor
# advance; the retro skill itself resolves and stamps the run it analyses.
# Orchestrator-down / empty-index degrades to `false` (nothing to retro),
# which suppresses the dispatch — the safe default.
echo -n "retro_run_available="
hydra raw GET /autopilot/runs?limit=14 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  runs=d.get('runs',[]) if isinstance(d,dict) else []
  completed=[r for r in runs if isinstance(r,dict) and str(r.get('status','')).lower() not in ('','running')]
  print('true' if completed else 'false')
except Exception:
  print('false')" || echo "false"

# Wayfinder map frontier — AFK working path (issue #3351, epic #3350, ADR-0029).
#
# The single AFK working class for wayfinder maps (`wayfinder_orch`) needs the
# NEXT unblocked frontier ticket pre-resolved into state, because decide.py stays
# PURE (AC #3: no gh/curl/GraphQL inside decide.py — the enumeration lives ONLY
# here). This block does exactly that pre-resolution and emits two signals:
#
#   - `wayfinder_orch_frontier`     — an `issue-<N>` ref for the first AFK-typed
#     (`wayfinder:research` | `wayfinder:task`), unblocked (all blocked-by
#     closed), unclaimed (open + unassigned) frontier sub-issue across all open
#     APPROVED wayfinder maps — or `none` when there is nothing to work.
#   - `wayfinder_orch_ticket_type`  — `research` | `task` for that ticket, so the
#     playbook can resolve ticket-type -> skill at dispatch time
#     (research -> /hydra-issue-research, task -> /hydra-dev).
#
# A map is APPROVED when it carries `wayfinder:map` but NOT the draft gate label
# `wayfinder:destination-pending` (ADR-0029: a destination-pending map is an
# unapproved draft with no worked tickets yet). The `wayfinder:*` off-radar rule
# is preserved — tickets carry zero standard lifecycle labels, so this dedicated
# frontier signal is their ONLY AFK dispatch path.
#
# Two-step, mirroring the doc's rate-budget guidance (REST list to pick maps,
# GraphQL only for the sub-issue/blocked-by walk):
#   1. REST `gh issue list` for open `wayfinder:map` issues (cheap, no GraphQL).
#   2. Per approved map, the native GraphQL frontier query (subIssues + blockedBy
#      + assignees) — the exact query in docs/agents/issue-tracker.md. We stop at
#      the FIRST eligible ticket (one-per-fire; the 1h cooldown paces the rest).
#
# Best-effort: any failure (gh down, GraphQL error, no maps) degrades to
# `none` — the suppressing direction (never dispatch a worker with no resolved
# target). Maps are walked oldest-first (stable ordering) so the frontier pick
# is deterministic across ticks.
# Saturation guards (issue #3354, epic #3350, ADR-0029 Decision 2): the frontier
# collector emits an in-flight COUNTER and enforces per-map single-flight, so the
# `wayfinder_orch` class can never run more than one worker per map or two workers
# globally. Both bounds hinge on ONE mechanism — a live worker CLAIMS its ticket by
# self-assigning it (`gh issue edit <N> --add-assignee @me`, the first step of the
# dispatch protocol in hydra-autopilot.md). An OPEN AFK-typed sub-issue that IS
# assigned is therefore an in-flight worker; the frontier pick already skips
# assigned tickets (`assignees.totalCount==0`), so a claimed ticket is never
# re-picked. That gives us both:
#   - `wayfinder_orch_inflight_global` — the count of OPEN, assigned, AFK-typed
#     (`wayfinder:research` | `wayfinder:task`) sub-issues across ALL open approved
#     maps = the number of live `wayfinder_orch` workers. decide.py reads it
#     verbatim and suppresses a new dispatch at >= 2 (the global cap; decide.py
#     stays PURE — no gh/GraphQL there).
#   - per-map single-flight — a map with >= 1 in-flight (assigned AFK) ticket
#     yields NO new frontier pick this tick, so at most one worker is ever in
#     flight for a given map even if two of its tickets are simultaneously
#     unblocked+unassigned. (The blocking graph serializes most frontiers already;
#     this guard covers the parallel-eligible case.)
#
# We must count in-flight across EVERY approved map (not stop at the first frontier
# pick), so the loop below always folds the per-map in-flight count into the global
# total before it decides on the frontier. HITL types (grilling/prototype) are
# never counted and never picked — they route to /wayfinder only.
echo -n "wayfinder_orch_frontier="
WF_MAPS_JSON=$(gh issue list --repo gaberoo322/hydra --state open --label 'wayfinder:map' \
  --json number,labels --jq '
    [ .[]
      | select((.labels | map(.name) | index("wayfinder:destination-pending")) | not)
      | .number ]
    | sort' 2>/dev/null || true)
WF_FRONTIER="none"
WF_TICKET_TYPE=""
WF_INFLIGHT_GLOBAL=0
if [ -n "$WF_MAPS_JSON" ]; then
  WF_MAP_NUMS=$(printf '%s' "$WF_MAPS_JSON" | python3 -c "
import json, sys
try:
  for n in json.load(sys.stdin):
    print(int(n))
except Exception:
  pass
" 2>/dev/null || true)
  for map_n in $WF_MAP_NUMS; do
    # ONE native GraphQL query per map (docs/agents/issue-tracker.md) derives BOTH
    # this map's in-flight count and its frontier pick. Emits a single line:
    #   `<inflight> [<pick-number> <pick-type>]`
    # where <inflight> is the count of OPEN, assigned, AFK-typed sub-issues (live
    # workers on this map) and the optional pick is the FIRST OPEN, UNASSIGNED,
    # UNBLOCKED AFK-typed ticket ONLY when this map has zero in-flight (per-map
    # single-flight). grilling/prototype are HITL — never counted, never picked.
    WF_MAP_LINE=$(gh api graphql -F n="$map_n" -f query='query($n:Int!){
      repository(owner:"gaberoo322", name:"hydra"){ issue(number:$n){
        subIssues(first:100){ nodes { number state
          labels(first:20){nodes{ name }}
          assignees(first:1){totalCount}
          blockedBy(first:20){nodes{ number state }} } } } } }' \
      --jq '(.data.repository.issue.subIssues.nodes
              | map(. + {type: ([.labels.nodes[].name
                  | select(. == "wayfinder:research" or . == "wayfinder:task")] | .[0])})
              | map(select(.type != null))) as $afk
            | ($afk | map(select(.state=="OPEN" and .assignees.totalCount>0)) | length) as $inflight
            | ($afk
                | map(select(.state=="OPEN" and .assignees.totalCount==0
                    and ([.blockedBy.nodes[]? | select(.state=="OPEN")] | length)==0))
                | .[0]) as $pick
            | if $inflight > 0 then "\($inflight)"
              elif $pick == null then "\($inflight)"
              else "\($inflight) \($pick.number) \($pick.type | sub("wayfinder:"; ""))" end' \
      2>/dev/null || true)
    # Fold this map's in-flight count into the global total (default 0 on any gap).
    WF_MAP_INFLIGHT=$(printf '%s' "$WF_MAP_LINE" | cut -d' ' -f1)
    case "$WF_MAP_INFLIGHT" in
      ''|*[!0-9]*) WF_MAP_INFLIGHT=0 ;;
    esac
    WF_INFLIGHT_GLOBAL=$((WF_INFLIGHT_GLOBAL + WF_MAP_INFLIGHT))
    # Take the FIRST map that yielded a frontier pick (fields 2 & 3 present).
    # `-s` suppresses no-delimiter lines: the no-pick sentinel `WF_MAP_LINE="0"`
    # (in-flight count only, no space) has no delimiter, so `cut -s` prints
    # nothing and WF_PICK_NUM stays empty — keeping the frontier at `none`.
    # Without `-s`, GNU cut echoes the whole line ("0"), spuriously yielding
    # `wayfinder_orch_frontier=issue-0` (#3400).
    WF_PICK_NUM=$(printf '%s' "$WF_MAP_LINE" | cut -s -d' ' -f2)
    if [ "$WF_FRONTIER" = "none" ] && [ -n "$WF_PICK_NUM" ]; then
      WF_FRONTIER="issue-$WF_PICK_NUM"
      WF_TICKET_TYPE=$(printf '%s' "$WF_MAP_LINE" | cut -s -d' ' -f3)
    fi
  done
fi
echo "$WF_FRONTIER"
echo "wayfinder_orch_ticket_type=${WF_TICKET_TYPE}"
echo "wayfinder_orch_inflight_global=${WF_INFLIGHT_GLOBAL}"

# Stalled-map staleness sweep — housekeeping backstop (issue #3355, epic #3350,
# ADR-0029).
#
# Two stall classes silently strand a wayfinder map on the operator's side, and
# NEITHER has an autopilot working path (both need the human — the machine must
# not synthesize the operator's side of a decision, ADR-0029 Decision 3):
#
#   1. A `wayfinder:destination-pending` map the operator never approves. It sits
#      a draft forever — its whole AFK frontier is un-dispatchable (the #3353
#      approved-map gate excludes it), so the map is dead weight until someone
#      approves or rejects it in /hydra-review §0.5.
#   2. An OPEN, unblocked, unclaimed HITL frontier ticket
#      (`wayfinder:grilling` | `wayfinder:prototype`) on an APPROVED map that the
#      operator never picks up. `wayfinder_orch` NEVER dispatches HITL tickets
#      (ADR-0029 Decision 3), so an un-picked-up one stalls its whole map's AFK
#      frontier — the autopilot cannot advance past a blocking decision — with no
#      autonomous escape.
#
# Both re-surface every day in /hydra-review, but a map/ticket the operator keeps
# deferring never crosses a threshold that says "this has been stuck too long".
# This collector emits that threshold-crossing signal so the review session (and
# the digest) can flag the genuinely STALE ones — the ones aged past
# WAYFINDER_STALENESS_THRESHOLD_SEC — distinctly from the fresh backlog. A map/
# ticket WITHIN the threshold is NOT flagged (it is still in the normal review
# cadence); only past-threshold ones surface here.
#
# Age is measured from `createdAt` (not `updatedAt`): a destination-pending map's
# createdAt is when it was charted, and its whole lifetime IS the un-approved
# window (nothing touches it until the operator acts, so updatedAt would be the
# same). An HITL ticket's createdAt is when the frontier surfaced the decision;
# it stays inert until the operator resolves it via /wayfinder, so createdAt is
# the true "how long stuck" clock. This mirrors the stale_blocked precedent above
# (an age threshold on a timestamp field) but keys on createdAt, not updatedAt.
#
# Threshold: 48h (172800s) — two full daily /hydra-review cadences. A map/ticket
# still stuck after the operator has seen it twice is genuinely stalled, not just
# in-flight. Overridable via HYDRA_WAYFINDER_STALENESS_SEC for tuning without a
# code change (mirrors the env-tunable thresholds elsewhere in this collector).
#
# Read-only + best-effort (the header contract): any failure (gh down, GraphQL
# error, no maps) degrades to `0` on both counts — the suppressing direction, so
# a transient outage never spuriously flags a stall the operator would then chase.
WAYFINDER_STALENESS_THRESHOLD_SEC="${HYDRA_WAYFINDER_STALENESS_SEC:-172800}"
echo "wayfinder_staleness_threshold_sec=${WAYFINDER_STALENESS_THRESHOLD_SEC}"

# 1. Stale destination-pending maps: open wayfinder:map issues carrying the
#    destination-pending gate whose createdAt is older than the threshold. The jq
#    age filter is PURE (no network) so it is golden-fixtured in
#    test/autopilot-decide.test.mts; the gh list feeds it live.
echo -n "wayfinder_stale_maps="
gh issue list --repo gaberoo322/hydra --state open \
  --label 'wayfinder:map' --label 'wayfinder:destination-pending' \
  --json number,createdAt --jq "
    [ .[]
      | select((now - (.createdAt | fromdateiso8601)) > ${WAYFINDER_STALENESS_THRESHOLD_SEC}) ]
    | length" 2>/dev/null || echo 0

# 2. Stale un-picked-up HITL frontier tickets: across every APPROVED map (a
#    wayfinder:map WITHOUT the destination-pending gate — a pending map holds no
#    tickets), count OPEN, unblocked (all blocked-by closed), unclaimed
#    (unassigned), HITL-typed (wayfinder:grilling | wayfinder:prototype) sub-issues
#    whose createdAt is older than the threshold. The eligibility+age jq is PURE
#    and golden-fixtured; the per-map GraphQL walk feeds it live. Maps are the
#    same approved set the frontier collector above walks.
echo -n "wayfinder_stale_hitl="
WF_STALE_HITL=0
if [ -n "${WF_MAPS_JSON:-}" ]; then
  # Reuse the approved-map numbers the frontier collector already resolved
  # ($WF_MAP_NUMS is set inside the frontier block above when maps exist).
  for map_n in ${WF_MAP_NUMS:-}; do
    WF_MAP_STALE=$(gh api graphql -F n="$map_n" -f query='query($n:Int!){
      repository(owner:"gaberoo322", name:"hydra"){ issue(number:$n){
        subIssues(first:100){ nodes { number state createdAt
          labels(first:20){nodes{ name }}
          assignees(first:1){totalCount}
          blockedBy(first:20){nodes{ number state }} } } } } }' \
      --jq "(.data.repository.issue.subIssues.nodes
              | map(. + {hitl: ([.labels.nodes[].name
                  | select(. == \"wayfinder:grilling\" or . == \"wayfinder:prototype\")] | .[0])})
              | map(select(.hitl != null))
              | map(select(.state==\"OPEN\" and .assignees.totalCount==0
                  and ([.blockedBy.nodes[]? | select(.state==\"OPEN\")] | length)==0
                  and ((now - (.createdAt | fromdateiso8601)) > ${WAYFINDER_STALENESS_THRESHOLD_SEC})))
              | length)" \
      2>/dev/null || echo 0)
    case "$WF_MAP_STALE" in
      ''|*[!0-9]*) WF_MAP_STALE=0 ;;
    esac
    WF_STALE_HITL=$((WF_STALE_HITL + WF_MAP_STALE))
  done
fi
echo "$WF_STALE_HITL"

# Tool Scout — Phase C alert-driven trigger (issue #486).
#
# `scout_alert_eligible_count` is the number of recent `hydra:alerts`
# entries whose pattern is in PATTERN_CATEGORY_MAP AND clear the
# 24h per-pattern + per-category dedup gates. When >0, decide.py
# fires a scout_orch dispatch with `trigger: "alert"` so the
# scout investigates the failing category within hours, not days.
#
# Sourced from `/api/scout/alert-plan` (read-only — doesn't advance
# the cursor or stamp any cooldown). The actual stamping happens
# inside the dispatched scout skill after a successful run, so a
# crash here doesn't suppress the next tick's retry.
echo -n "scout_alert_eligible_count="
hydra raw GET /scout/alert-plan 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print(len(d.get('eligible',[])))
except: print(0)" || echo 0

# Subscription Usage Tracker — PR B1 eligibility verdict.
#
# `GET /api/usage/eligibility` (src/api/usage.ts) returns the autopilot-
# facing projection of the Subscription Usage Tracker
# (src/cost/usage-tracker.ts):
#
#   {"allow": bool, "shed": [...], "reasons": {...}, "usage": {...snapshot}}
#
# The playbook merges this into state.json as `state.usage_eligibility`.
# decide.py's normalize pass tolerates a missing field (defaults to
# {"allow": true, "shed": []}), so an orchestrator-down condition here
# is non-fatal — we just dispatch normally.
echo -n "usage_eligibility_json="
hydra raw GET /usage/eligibility 2>/dev/null || echo '{"allow":true,"shed":[],"reasons":{"calibrated":false}}'

# Emergency brake — issue #744 (operator-only).
#
# `GET /api/autopilot/emergency-brake` (src/api/autopilot.ts) returns the
# current brake state: {"engaged":bool,"since"?:ms,"engagedBy"?:str}.
# The playbook merges this into state.json as `state.emergency_brake`.
# decide.py's auto-merge sweep reads `state.emergency_brake.engaged`: when
# true it emits ZERO auto-merge actions and a single `route-prs-to-review`
# action instead. This is a READ-ONLY collector — collect-state.sh (and
# decide.py) can never SET or CLEAR the brake; the sole write path is the
# operator CLI (`hydra brake on|off`) / the API POST route. Orchestrator-down
# defaults to disengaged so a transient outage never wedges auto-merge off.
echo -n "emergency_brake_json="
hydra raw GET /autopilot/emergency-brake 2>/dev/null || echo '{"engaged":false}'

# Per-class yield scoreboard + shadow-mode dampener — issue #2943.
#
# `GET /api/autopilot/class-stats` (src/api/class-stats.ts) returns
# the cross-run per-class yield scoreboard + the SHADOW-MODE cadence multipliers
# decide.py WOULD apply in a future live mode:
#
#   {"scoreboard": {...classes:[{className,role,verdict,mergeRate,beta,...}]},
#    "shadow": {"verdicts":[{className,multiplier,reprobeAt,verdict}], ...},
#    "generatedAt": "..."}
#
# The playbook merges this into state.json as `state.class_stats`. decide.py's
# shadow path reads `state.class_stats.shadow.verdicts` and LOGS the multipliers
# it would apply — it actuates NOTHING (the #2943 byte-identical-dispatch
# invariant): decide.py stays a pure function of state.json and the scoreboard is
# computed orchestrator-side here, never fetched inside decide.py. Read-only
# collector; a snapshot cache write happens server-side, not here. Orchestrator-
# down degrades to an empty scoreboard so a transient outage never wedges the
# turn (decide.py's shadow path no-ops on an empty/absent class_stats).
echo -n "class_stats_json="
hydra raw GET /autopilot/class-stats 2>/dev/null || echo '{"scoreboard":{"classes":[]},"shadow":{"verdicts":[]}}'

# capacity-floor (orchestrator self-improvement share)
hydra raw GET /capacity 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin); o=d['orchestrator']
  print(f'capacity_orch_share={o[\"share\"]:.2f} capacity_floor_met={d[\"floorMet\"]} capacity_window={o[\"window\"]}')
except: print('capacity_floor_met=true capacity_window=0')"

# scheduler / cycle
hydra cycle status 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print('CODEX_ACTIVE' if d.get('running') else 'CODEX_IDLE')
except: print('CODEX_IDLE')"
hydra scheduler status 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  s=d.get('state','?'); nm=d.get('consecutiveNonMerges',0)
  stall='ok' if nm<5 else ('hard-stop' if nm>=8 else 'alert')
  print(f'scheduler={s} nonmerges={nm} stall={stall}')
except: print('scheduler=unknown stall=unknown')"

# recommendations
hydra recommendations 2>/dev/null | python3 -c "
import json,sys
try:
  items=json.load(sys.stdin)
  if items: print(f'recommendations={len(items)}: {items[0].get(\"action\",\"?\")[:60]}')
  else: print('recommendations=0')
except: print('recommendations=unavailable')"

# slot-events stream (issue #509) — drained on every turn.
#
# Claude Code's `SubagentStop` and `Notification` hooks XADD lifecycle
# events into `hydra:autopilot:slot-events`. The autopilot turn reads
# them here (XREAD COUNT N STREAMS ... $LAST_ID), merges them under the
# `slot_events` JSON key, and `decide.py` consumes them to free slots
# without polling. The cursor is `state.slot_events_last_id` — the
# autopilot is expected to update it after each successful read so the
# next turn doesn't re-process the same events.
#
# Best-effort: a Redis outage or empty stream prints an empty JSON
# array under `slot_events_json=`. The collect step never fails.
SLOT_EVENTS_STREAM="${HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM:-hydra:autopilot:slot-events}"
SLOT_EVENTS_LAST_ID="${HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID:-0}"
SLOT_EVENTS_COUNT="${HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT:-100}"
echo -n "slot_events_json="
docker exec hydra-redis-1 redis-cli XREAD COUNT "$SLOT_EVENTS_COUNT" STREAMS "$SLOT_EVENTS_STREAM" "$SLOT_EVENTS_LAST_ID" 2>/dev/null | python3 -c "
# XREAD returns either nothing (empty result) or a list of one stream
# entry: [stream_name, [[id, [k1,v1,k2,v2,...]], ...]]. The redis-cli
# default formatter outputs that as flat indented text. We re-parse it
# into JSON the playbook can stitch into state.slot_events.
import json, sys
lines=[l.rstrip() for l in sys.stdin.readlines() if l.strip()]
if not lines:
  print(json.dumps({'events': [], 'last_id': None}))
  sys.exit(0)
# Heuristic parser for the default redis-cli output. Stream name first,
# then alternating (id, field, value, field, value, ...).
events = []
last_id = None
# Drop the stream name and indent guides; collect only data lines.
toks = [l.lstrip() for l in lines if l.strip()]
# Find pairs: an id line is digits-dash-digits (e.g. 1779143539950-0).
import re
i = 0
while i < len(toks):
  if re.match(r'^\d+-\d+$', toks[i]):
    eid = toks[i]
    i += 1
    fields = {}
    # Consume pairs until next id or end. We expect even count.
    while i < len(toks) and not re.match(r'^\d+-\d+$', toks[i]):
      k = toks[i]; i += 1
      v = toks[i] if i < len(toks) and not re.match(r'^\d+-\d+$', toks[i]) else ''
      if v != '':
        i += 1
      fields[k] = v
    events.append({'id': eid, 'fields': fields})
    last_id = eid
  else:
    i += 1
print(json.dumps({'events': events, 'last_id': last_id}))
" 2>/dev/null || echo '{"events": [], "last_id": null}'
