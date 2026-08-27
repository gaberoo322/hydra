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

# health
hydra health 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try: d=json.load(sys.stdin); print(f'health={d["status"]} redis={d["redis"]}')
except: print('health=FAIL')
PY
)"

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
BOARD_STATE_DEGRADED=$(printf '%s' "$BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
try:
  d=json.load(sys.stdin)
  # degraded, or missing required count fields → treat as unusable.
  ok = isinstance(d,dict) and not d.get('degraded', False) and 'ready_for_agent' in d
  print('0' if ok else '1')
except Exception:
  print('1')
PY
)" 2>/dev/null || echo 1)
if [ "$BOARD_STATE_DEGRADED" = "0" ]; then
  # Strip the endpoint-only fields (degraded, generatedAt) so the emitted shape
  # matches the historical inline `--jq` output exactly.
  printf '%s' "$BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
d=json.load(sys.stdin)
keys=['needs_qa','ready_for_agent','needs_triage','needs_research','in_progress','blocked','stale_in_progress','stale_blocked']
print(json.dumps({k:d[k] for k in keys}))
PY
)"
else
  # Fallback: orchestrator down or its gh read degraded — read directly.
  # This jq MUST stay behaviourally identical to `deriveBoardState`
  # (`src/autopilot/board-state.ts`) UNDER THE DEGRADED PATH'S CONDITION.
  # The degraded path is reached when the orchestrator HTTP service (and thus
  # its Redis-backed heartbeat read) is unreachable, so the GLM drainer
  # heartbeat CANNOT be read here — that is exactly the STALE condition, and
  # `deriveBoardState` with a stale / absent heartbeat does NOT subtract
  # `glm-eligible` (issue #3754, ADR-0032 #3753 amendment: fail-open toward
  # work so a down drainer never starves the Opus `dev_orch` lane). This jq
  # therefore deliberately does NOT exclude `glm-eligible` — it matches the
  # stale-heartbeat arm of `deriveBoardState` exactly. The healthy endpoint
  # path above applies the (liveness-conditional) subtraction; this fallback
  # is the always-stale mirror. The `target-backlog` exclusion (issue #2704)
  # stays — it is unconditional on liveness. The strict-blocker exclusion
  # (#3059) is endpoint-only and deliberately absent here, as before.
  gh issue list --repo gaberoo322/hydra --state open --limit "$GH_ISSUE_LIST_LIMIT" --json number,labels,updatedAt --jq '{
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

# Orch needs-triage item-number set (issue #3939 — the orchestrator mirror of
# the Target-side `target_needs_triage_items` seam from #3729).
#
# `needs_triage` above (and the `needs_triage_orch` boolean the playbook derives
# from `needs_triage > 0`) is a COARSE presence gate with no per-item eligibility.
# A needs-triage issue that is a STANDING re-check trigger — one whose own
# acceptance criteria say "re-triage forward when condition X is met" (e.g. #3921,
# "re-run hydra-discover Tier-3 cost characterization") — parks in the lane
# indefinitely: sweep correctly declines to route it, the lane stays non-empty,
# and sweep_orch re-fired every 900s (its class cooldown) to re-make the
# identical no-op decision. Observed in autopilot run 3ce9e61a (2026-08-10):
# sweep_orch fired 4× in ~55 min, ~50-75K tokens per no-op fire = ~200-300K
# tokens/hour of pure churn (16-24% of the default 10M budget over an 8h run).
#
# This emits the CURRENT needs-triage item-number set as a fresh per-turn fact so
# decide.py's per-item verdict-stability guard can stamp each item independently
# and dead-arm only the items sweep just examined — not the whole lane. It is an
# INDEPENDENT, minimal orch-only block, NOT shared with the target_needs_triage_
# items block below (that block bundles unrelated target-only computations —
# cleanup-scan open count, wire-or-retire triage count, design-qa saturation — in
# the same python heredoc; forking a shared shell helper across the two repos
# would tangle them, INV-11).
#
# collect-state.sh stays STATELESS (no state.json read — INV-8): it only
# enumerates the current set, the same role it already plays for the
# `needs_triage` COUNT above. The enumeration is a direct `gh issue list` scoped
# to the needs-triage label — NOT an extension of /api/autopilot/board-state
# (which returns aggregate COUNTS only, no item numbers, on both its healthy and
# degraded orch-board-read paths), so the item set is available regardless of
# which board-state branch above served the count. Numbers are space-separated,
# sorted ascending for a deterministic emit (decide.py parses them into a set, so
# order is not load-bearing). Best-effort: any failure emits an EMPTY value,
# which decide.py treats as absent → fail-open on the coarse count alone (never
# re-dead-arm the sweep — the #3709 defect class, INV-9).
echo -n "orch_needs_triage_items="
gh issue list --repo gaberoo322/hydra --state open --label needs-triage \
  --limit "$GH_ISSUE_LIST_LIMIT" --json number \
  --jq 'map(.number) | sort | map(tostring) | join(" ")' 2>/dev/null || echo ""

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
if [ "$TARGET_BOARD_STATE_DEGRADED" = "0" ]; then
  printf '%s' "$TARGET_BOARD_STATE_JSON" | python3 -c "$(cat <<'PY'
import json,sys
d=json.load(sys.stdin)
# Emit only the counts decide.py's Target branch consumes, prefixed target_ so
# they never collide with the orch board counts above.
print('target_ready_for_agent=' + str(d.get('ready_for_agent', 0)))
print('target_needs_qa=' + str(d.get('needs_qa', 0)))
print('target_needs_triage=' + str(d.get('needs_triage', 0)))
print('target_needs_research=' + str(d.get('needs_research', 0)))
PY
)"
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
  # lane. Best-effort: any failure emits zeros.
  gh issue list --repo "$TARGET_GH_REPO" --state open --limit "$GH_ISSUE_LIST_LIMIT" --json number,labels --jq '{
    target_ready_for_agent: [.[] | select(.labels | map(.name) | index("ready-for-agent"))] | length,
    target_needs_qa: [.[] | select(.labels | map(.name) | index("needs-qa"))] | length,
    target_needs_triage: [.[] | select(.labels | map(.name) | index("needs-triage"))] | length,
    target_needs_research: [.[] | select(.labels | map(.name) | index("needs-research"))] | length
  } | to_entries | map("\(.key)=\(.value)") | .[]' 2>/dev/null \
    || { echo "target_ready_for_agent=0"; echo "target_needs_qa=0"; echo "target_needs_triage=0"; echo "target_needs_research=0"; }
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
# `wayfinder:*` tickets (issue #3728) carry NO standard lifecycle label BY
# DESIGN — the off-radar rule (wayfinder maps dispatch via
# `wayfinder_orch_frontier`, never through `dev_orch` / `needs_triage_orch`)
# means a `wayfinder:*` label is the ONLY marker that distinguishes them on
# this board read. Without an exclusion they are permanently counted as
# orphans, so `untriaged_orphans > 0` is true for as long as any wayfinder
# map is open, re-firing `sweep_orch` on its 900s cooldown forever to
# re-confirm there is nothing to route. They are dropped by a PREFIX test
# (`startswith("wayfinder:")`), NOT by enumerating the known wayfinder label
# names (wayfinder:map / :grilling / :research / :task / :prototype /
# :destination-pending), so a future wayfinder ticket type cannot silently
# reintroduce the churn. This MUST NOT weaken the backstop: an issue with
# genuinely NO labels matches neither the exclusion set NOR the prefix, so it
# is still counted — the orphan detector's actual target stays intact.
#
# `needs-design-concept` (issues #3817 -> #4096): #3817 added it to this
# exclusion array as a deliberate HITL parking lane. #4096 REMOVED it — that
# framing held only for the parked-AND-routed state. The label is an override
# INSIDE the grill selector's walk, not an entry point INTO it: the
# design-concept gate below resolves `orch_pending_grill_anchor` by iterating
# the `ready-for-agent` candidate list (`--label ready-for-agent`), and within
# that walk `needs-design-concept` only forces TRIVIAL=0 (never suppress the
# grill). An issue carrying the label WITHOUT `ready-for-agent` is therefore
# unreachable by EVERY consumer: never in the grill walk (design_concept_orch
# cannot fire on it), listed by no HITL surface, and — pre-#4096 — exempt from
# this backstop by its own name. Observed live on #4093 (run bdbf82c8):
# sweep_orch triaged it needs-triage -> needs-design-concept, a reasonable
# verdict that wrote the issue into a silent sink. With the label gone from
# this array such an issue COUNTS as an orphan, sweep_orch recovers it by
# ADDING `ready-for-agent` (through the #772 Open-PR pre-promotion gate, never
# stripping the label — docs/operator-playbooks/hydra-sweep.md), the issue
# enters the grill walk, and the count drops to zero — one fire, one fix, no
# churn. When `ready-for-agent` (or any other lifecycle label) IS present the
# issue stays excluded via that label's own entry, preserving #3817's
# no-churn property for the parked-and-routed state.
#
# `needs-tickets` (issue #3817) stays excluded — it is a genuine standalone
# parking lane with a consumer of its own:
#   - it parks a published spec awaiting `/to-tickets` decomposition, and it
#     is the board condition for the `tickets_orch` producer (issue #4014,
#     ADR-0030's one-lineage AFK spine — collect-state.sh emits
#     `tickets_available` from it just below the wayfinder block), so it is
#     autopilot-VISIBLE. It stays in this orphan-exclusion array regardless:
#     `sweep_orch` has no rule to act on it (the tickets_orch producer owns
#     it), and counting it as an orphan would re-fire `sweep_orch` every
#     cooldown to re-confirm a no-op. (Pre-#4014 this lane was
#     autopilot-invisible by design — the spine made it visible; the
#     orphan-exclusion rationale is unchanged.)
#
# `hitl-grill` (issue #4025) is a TERMINAL park state, not a "wrong label"
# blind spot either: it marks an agent-proposed idea the operator must
# grill-or-dismiss, and no agent may ever action it. Without this exclusion
# an issue carrying only `hitl-grill` pins `untriaged_orphans` above zero
# permanently, so `sweep_orch` re-triages the parked idea into an actionable
# lane on every cooldown — draining the very inbox this label exists to
# hold. Same shape as `needs-design-concept` / `needs-tickets` above: ADDED
# as a single fixed label, not a prefix family. Do not conflate this with
# `ready-for-human` (an `INTERVENTION_LABEL` in
# `src/aggregators/autonomy-classifier.ts` — an escalation) or with the
# attention feed (#4007, ADR-0034-scoped to threshold crossings): parking an
# idea in `hitl-grill` is neither.
#
# Audited against the full repo label list and NOT added, with reasons:
#   - `meta-friction`: explicitly the MOTIVATING example above ("an issue
#     landed with the wrong label") — `src/pattern-memory/escalation.ts`
#     creates these issues with ONLY this label and no lifecycle label, so
#     this backstop counting it as an orphan is exactly the intended catch,
#     not a gap to suppress.
#   - `design-qa`, `cleanup-scan`, `architecture-scan`, `tool-scout`: producer
#     category labels always applied alongside `needs-triage` or
#     `ready-for-agent` at creation time (see `hydra-design-qa.md`,
#     `hydra-cleanup.md`, `hydra-architecture-scan.md`,
#     `hydra-tool-scout.md`) — never the sole label on an open issue.
#   - `operator-approved`, `glm-authored`, `merge-ready`, `ready-for-merge`,
#     `no-rebase`: applied via `gh pr edit`, not `gh issue edit` — PR labels,
#     invisible to this issue-scoped `gh issue list` read regardless.
#   - `keep-open`, `design-concept-exempt`, `glm-eligible`, `glm-withhold`,
#     `ubiquitous-language`, `refactor-batch-2026-05`, `backlog`, `sentry`:
#     modifier/category tags always applied alongside an existing lifecycle
#     label (e.g. `keep-open` rides on `wayfinder:map`, already prefix-
#     excluded), never a standalone parking state.
#
# This emits `untriaged_orphans` = the count of open issues carrying NONE of
# that label set AND no `wayfinder:`-prefixed label. The autopilot turn maps
# `untriaged_orphans > 0` → the boolean `untriaged_orphans_orch` signal
# (mirroring the `needs_triage > 0` → `needs_triage_orch` mapping), which
# decide.py's `sweep_orch` selector reads as a SECONDARY trigger to dispatch
# hydra-sweep and route the orphans into an actionable lane. This is a
# STANDALONE `gh` read (not derived from the board-state seam) so the
# backstop holds whether or not `/api/autopilot/board-state` is healthy.
# Best-effort: any failure emits `untriaged_orphans=0` so a transient gh
# outage never spuriously triggers a sweep.
echo -n "untriaged_orphans="
gh issue list --repo gaberoo322/hydra --state open --limit "$GH_ISSUE_LIST_LIMIT" --json number,labels --jq '
  [ .[]
    | select(
        (.labels | map(.name)) as $n
        | ([ "ready-for-agent", "in-progress", "blocked", "needs-qa",
             "needs-triage", "needs-research", "target-backlog",
             "ready-for-human", "needs-info", "needs-tickets",
             "hitl-grill" ]
           | any(. as $lbl | $n | index($lbl))) | not
      )
    | select((.labels | map(.name) | any(.[]; startswith("wayfinder:"))) | not)
  ] | length' 2>/dev/null || echo 0

# needs-qa issue enumeration for the qa_orch per-issue STALL CAP guard
# (issue #3829, design-concept issue-3829). `needs_qa` above is a bare COUNT;
# decide.py's stall-cap guard needs the actual issue NUMBERS, in the SAME
# order hydra-qa's own self-selection query returns them, so it can track an
# attempt counter for the HEAD issue only (the one hydra-qa will actually
# review next) and stop re-dispatching qa_orch once that head has exhausted
# its cap — an issue that structurally cannot reach a QA verdict (the
# motivating case: the hourly worktree-orphan-prune reaping the parent QA
# agent's worktree AND every reviewer worktree mid-review, which reproduces
# identically on every retry) otherwise keeps `needs_qa` > 0 forever and
# busy-loops qa_orch at 30-65k tokens/turn with no bound.
#
# ORDER IS LOAD-BEARING (design-concept invariant 4): this is deliberately
# the SAME unsorted-default query hydra-qa's own step 1 self-selection uses
# (docs/operator-playbooks/hydra-qa.md: `gh issue list --repo gaberoo322/hydra
# --label "needs-qa" --state open --json number,title --jq '.[0]'`) — no
# `sort`, so `needs_qa_numbers[0]` here is defined to match the issue hydra-qa
# will actually pick. A numeric sort would silently break that parity and let
# the guard track a different issue than the one being reviewed. Mirrors the
# #3729 sweep_target per-item verdict-stability guard's
# `target_needs_triage_items` signal shape — same verbatim-string seam,
# decide.py parses it into an ordered list of ints. STANDALONE `gh` read (not
# derived from the board-state seam), same shape as the untriaged_orphans
# backstop above. Best-effort: any failure emits an empty list, which
# decide.py treats as ABSENT (no head known this turn) -> fails open on the
# coarse `needs_qa_orch` boolean alone, preserving pre-#3829 behaviour.
echo -n "needs_qa_numbers="
# NOTE: the jq flag's argument deliberately opens on its OWN line, one line
# below the flag itself, rather than the opening bracket sitting on the same
# line as the flag. Reason: test/autopilot-dev-orch-gate.test.mts extracts the
# UNRELATED active_dev_orch collector's filter via a regex keyed on that
# flag immediately followed by an opening bracket (no line break between
# them) being the FIRST such occurrence anywhere in this script. Keeping the
# bracket on the flag's own line here — same shape as the untriaged_orphans
# call above and the wayfinder calls below — avoids shadowing that match.
gh issue list --repo gaberoo322/hydra --state open --label needs-qa \
  --limit "$GH_ISSUE_LIST_LIMIT" --json number --jq '
    [.[] | .number] | join(" ")
  ' 2>/dev/null || true
echo

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
# PER-ANCHOR GATE (issue #3711) — this ONE loop pass now emits THREE signals:
#
#   - `orch_pending_grill_anchor` — the first candidate that still needs a
#     grill (unchanged semantics).
#   - `orch_dev_ready_anchor` — the first candidate that is already
#     GRILL-CLEAR, i.e. it has a fresh artifact, or it qualifies for the
#     mechanical (#1230) / trivial (#1088) exemption.
#   - `orch_dev_ready_anchor_design_concept_status` — NEW (issue #3798): the
#     design-concept `status` ("approved"/"draft") of `orch_dev_ready_anchor`
#     when — and ONLY when — that pick was earned via a genuine fresh
#     artifact. It stays "none" when the pick came from the mechanical or
#     trivial exemption instead, so decide.py can tell "architecturally
#     consequential, worth a frontier-tier dev_orch dispatch" apart from
#     "grill-clear by construction, needs no design at all" without decide.py
#     itself doing any I/O (see the `design_concept_permits_frontier`
#     discriminator in decide.py).
#
# WHY: decide.py's `dev_orch` selector used to yield whenever
# `orch_pending_grill_anchor` was set to anything — a GLOBAL stop, not a
# per-anchor one. One un-grilled issue anywhere on the board blocked dev_orch
# from building EVERY issue, including ones whose artifacts were already
# approved (autopilot run a1c24124 ended with 15 `ready-for-agent` issues all
# gated behind one un-grilled anchor, zero dev PRs). The gate's intent — never
# build an un-grilled anchor — is per-anchor, so the signal has to be too.
#
# `decide.py` MUST stay a pure function of `(state, events, now)`, so it cannot
# ask "does the anchor dev_orch would pick have an artifact?" — it has no
# network/FS/Redis. The pre-resolution therefore belongs HERE, exactly like
# `wayfinder_orch_frontier` and `wire_or_retire_target_available`: this script
# owns the enumeration, decide.py reads one pre-qualified string verbatim.
# decide.py then pins dev_orch to `orch_dev_ready_anchor` via `prompt_args`
# instead of yielding — which ALSO closes the self-selection gap, because a
# pinned dispatch can no longer land on the un-grilled anchor via hydra-dev's
# own unguarded `gh issue list ... | .[0]` pick.
#
# THE GATE IS NOT WEAKENED: `orch_dev_ready_anchor` is only ever set to an
# anchor that is *already* grill-clear, and dev_orch still yields when the only
# grill-clear anchor IS the pending-grill one (or when there is none). An
# un-grilled anchor still gets grilled; it just no longer blocks unrelated work.
#
# Implementation notes:
#
#   - Candidate ORDER IS STABLE (issue #3711, sub-defect (a)): issues are
#     walked by issue NUMBER ASCENDING (oldest first), then capped at 10.
#     It used to be `sort_by(.updatedAt) | reverse` (newest-first), which meant
#     every newly-filed issue displaced the head of the queue and RE-EXTENDED
#     the block — filing a bug mid-run rotated the anchor to the new issue and
#     restarted the gate from scratch (observed 3x in run a1c24124). Ascending
#     issue number is monotonic in creation order, so the head only changes when
#     the head itself drains: a newly-filed issue sorts to the BACK. The cap
#     moved out of the jq and into the python3 extractor for the same reason —
#     capping a newest-first list rotates the candidate POOL, not just its order.
#   - One `gh issue list` fetches number+updatedAt+body+labels+title for the
#     whole board, so the trivial gate needs no extra per-issue gh round-trip.
#   - For each issue we curl `/api/design-concepts/issue-<N>`. A 200 that is
#     fresh means the anchor is grill-clear. A 404 or a stale artifact means it
#     is a grill candidate — unless the mechanical/trivial gates suppress it, in
#     which case it is ALSO grill-clear (it needs no concept by construction).
#   - The loop breaks as soon as BOTH picks are resolved, so the common case
#     still costs one or two curls; the worst case stays the documented O(10).
#   - Emit `issue-<N>` or `none` for each pick.
#   - Best-effort: any failure prints `none` so dispatch is never blocked
#     by a transient orchestrator outage.
# Exclude `target-backlog` issues from the grill candidate set (issue #2704):
# `target-backlog` is the routing label for Target work (code in hydra-betting).
# An issue carrying BOTH `ready-for-agent` and `target-backlog` (e.g. #2701)
# is Target-scope, but grilling it here fires an orchestrator-scope
# `design_concept_orch` grill against target code — a scope mismatch that
# re-fires every idle turn. Drop such issues from the candidate list up front,
# mirroring how the untriaged-orphans jq excludes label sets above.
#
# IN-FLIGHT DEV-WORK EXCLUSION (issue #3711, sub-defect (b)). An anchor that
# dev_orch has already built, or is building, must not be selected as a grill
# anchor at all: a design concept produced *after* the PR exists is retro-active
# waste, and it was one of the three ways a single anchor held this gate for a
# whole run (run a1c24124 — the gate demanded a concept for the very anchor
# dev_orch was mid-implementation on). Such an anchor is excluded from BOTH
# picks, because dev must not re-pick it either.
#
# WHY THIS CANNOT WEAKEN THE GATE: the predicate requires POSITIVE evidence that
# dev work already happened or is in flight — an open PR referencing the issue,
# or the `in-progress` label. A never-built un-grilled anchor matches neither, so
# it is still promoted and still gets grilled. (Contrast the mechanical/trivial
# gates, which suppress on properties of the issue itself.)
#
# Two sources, both cheap:
#   - open-PR refs: the head branch `issue-<N>-<slug>` (hydra-dev's branch
#     convention) PLUS an issue reference in the PR body. The body matcher
#     recognises GitHub CLOSING keywords (`Closes`/`Fixes`/`Resolves #<N>`)
#     AND the non-closing reference keyword `Refs #<N>` (issue #3851): a PR
#     that must NOT auto-close its anchor (e.g. a draft "[BLOCKED on #N]"
#     awaiting a sibling) correctly uses `Refs` instead of `Closes`, so the
#     exclusion has to honour it — otherwise a harness-created
#     `worktree-agent-<hash>` branch (whose name carries no issue number) is
#     invisible to BOTH sources and dev_orch re-builds work already awaiting
#     review. Bare `#N` is deliberately NOT matched: a passing mention (e.g.
#     "blocked on #3749") would false-exclude and starve dev_orch.
#   - the `in-progress` label, for any path that applied it (the AFK inline
#     dispatch does not relabel, so this is belt-and-braces, not the primary).
#
# Costs ONE `gh pr list`. Deliberate trade: it buys the signal that unblocks
# dev_orch dispatch for a whole run. Best-effort — a gh failure yields an empty
# set, which is exactly today's (no-exclusion) behaviour.
ORCH_INFLIGHT_PR_JSON=$(gh pr list --repo gaberoo322/hydra --state open --limit "$GH_ISSUE_LIST_LIMIT" --json headRefName,body 2>/dev/null || true)
ORCH_INFLIGHT_ISSUES=$(printf '%s' "$ORCH_INFLIGHT_PR_JSON" | python3 -c "$(cat <<'PY'
import json, re, sys
try:
  out = set()
  for pr in json.load(sys.stdin):
    m = re.match(r'issue-(\d+)\b', pr.get('headRefName') or '')
    if m:
      out.add(int(m.group(1)))
    for m in re.finditer(
        r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s*:?\s+#(\d+)\b',
        pr.get('body') or '', re.IGNORECASE):
      out.add(int(m.group(1)))
  print(' '.join(str(x) for x in sorted(out)))
except Exception:
  pass
PY
)" 2>/dev/null || true)
ORCH_GRILL_LIST_JSON=$(gh issue list --repo gaberoo322/hydra --state open --label ready-for-agent --limit "$GH_ISSUE_LIST_LIMIT" --json number,updatedAt,body,labels,title --jq '
  [ .[] | select((.labels | map(.name) | index("target-backlog")) | not) ]
' 2>/dev/null || true)
# ---------------------------------------------------------------------------
# BLOCKED-DEPENDENCY CANDIDATE EXCLUSION (issue #3965). The count path
# (`src/autopilot/board-state.ts::hasOpenStrictBlocker` →
# `extractStrictBlockerRefs`) already excludes a ready-for-agent issue citing
# an OPEN strict blocker from the dispatchable `ready_for_agent` COUNT. This
# candidate loop — which chooses WHICH anchor to actually dispatch — applied no
# such check, so a dependency-blocked issue could be picked as the grill or
# dev-ready anchor even though decide.py's `ready_for_agent > 0` gate had
# already counted it as zero. This is the FIFTH candidate exclusion
# (`blocked-dependency-exclusion`), applying the SAME predicate the count path
# uses (issue #3965).
#
# It is a HARD skip applied HERE at candidate construction (alongside
# in-flight-dev and target-backlog), NOT a soft `continue` inside the
# per-candidate loop: a dependency-blocked issue is never safe to hand to
# dev_orch either (its blocker has not merged), so it must not be able to
# become the sole ORCH_DEV_READY_PICK the way the mechanical/trivial gates can.
#
# collect-state.sh is bash/python (no TS bridge), so the strict-blocker parse is
# mirrored in python and pinned to the TS predicate by
# `test/board-state.test.mts`: a byte-identical drift guard over the pattern
# sources exported as `STRICT_BLOCKER_PATTERN_SOURCES` in
# `src/github/blockers.ts`, plus a behavioural-parity check on a golden
# fixture. One predicate, two call sites. Anchored keyword-only
# (`blocked by #N` / `depends on #N`), code-span-safe, self-ref-safe — a bare
# `#N` "see also" never matches (it would starve real work).
#
# Openness is resolved with ONE batched `gh issue list --state open --search`
# over the union of refs (mirrors `fetchOpenBlockerNumbers`), and its FAIL-SAFE
# default is load-bearing: on a gh lookup FAILURE every referenced blocker is
# treated as still-OPEN, so the loop WAITS a tick rather than dispatching onto
# an unmerged blocker. Best-effort — a failure never aborts the collect step
# (same `2>/dev/null || true` degrade as every sibling collector).
#
# Additive to the manual `blocked` label — this NEVER toggles that label (an
# operator escape hatch; writing it would collide with the orphan-backstop
# tracking loop). Body-text ONLY — no native `blockedBy` query here: ADR-0029
# Decision 5 keeps the two blocking conventions unbridged (native is for
# wayfinder-map internals; body-text is for hydra-prd handoff epics, which is
# what lands on this board), and this script already runs a native query for
# `wayfinder_orch_frontier` that must stay map-scoped.
#
# Step 1 — the union of strict-blocker refs declared across the candidate pool
# (self-refs excluded), mirroring `resolveOpenBlockers`' ref collection. The
# two PATTERNS are byte-identical to STRICT_BLOCKER_PATTERN_SOURCES.
ORCH_BLOCKER_REFS=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | python3 -c "$(cat <<'PY'
import json, re, sys
PATTERNS = [
  r'\bblock(?:ed|s)?(?:[\s-]+by)?\s*:?\s*#(\d+)',
  r'\bdepend(?:s|ent)?(?:[\s-]+on)?\s*:?\s*#(\d+)',
]
try:
  refs = set()
  for it in json.load(sys.stdin):
    n = it.get('number')
    if not isinstance(n, int):
      continue
    # Strip backtick code spans first -- a #N inside code is not a ref.
    stripped = re.sub(r'\x60[^\x60]*\x60', '', it.get('body') or '')
    for pat in PATTERNS:
      for m in re.finditer(pat, stripped, re.IGNORECASE):
        x = int(m.group(1))
        if x > 0 and x != n:
          refs.add(x)
  print(' '.join(str(x) for x in sorted(refs)))
except Exception:
  pass
PY
)" 2>/dev/null || true)
# Step 2 — ONE batched open-state lookup over that union (mirrors
# fetchOpenBlockerNumbers: a single `gh issue list --state open --search`).
# FAIL-SAFE: a gh failure treats EVERY referenced blocker as still-OPEN.
ORCH_OPEN_BLOCKERS=""
if [ -n "$ORCH_BLOCKER_REFS" ]; then
  if ORCH_OPEN_BLOCKERS_JSON=$(gh issue list --repo gaberoo322/hydra --state open --search "$ORCH_BLOCKER_REFS" --limit "$GH_ISSUE_LIST_LIMIT" --json number 2>/dev/null); then
    # gh succeeded -- intersect the open rows with the requested refs (guards
    # against unrelated matches that merely mention a number). An empty result
    # is CORRECT here (no referenced blocker is open) and is NOT a fail-safe
    # trigger. A parse error despite gh success still fails toward exclusion.
    ORCH_OPEN_BLOCKERS=$(printf '%s' "$ORCH_OPEN_BLOCKERS_JSON" | ORCH_BLOCKER_REFS="$ORCH_BLOCKER_REFS" python3 -c "$(cat <<'PY'
import json, os, sys
try:
  req = {int(x) for x in (os.environ.get('ORCH_BLOCKER_REFS') or '').split() if x.isdigit()}
  data = json.load(sys.stdin)
  rows = data if isinstance(data, list) else []
  open_nums = {int(r.get('number')) for r in rows if isinstance(r.get('number'), int)}
  print(' '.join(str(x) for x in sorted(req & open_nums)))
except Exception:
  print(os.environ.get('ORCH_BLOCKER_REFS') or '')
PY
)" 2>/dev/null || true)
  else
    # gh failure -> treat every referenced blocker as still open (wait a tick).
    ORCH_OPEN_BLOCKERS="$ORCH_BLOCKER_REFS"
  fi
fi
# Step 3 — the candidate numbers blocked by an OPEN strict blocker, given the
# resolved open set. Re-parses bodies with the same byte-identical patterns.
ORCH_BLOCKED_DEPENDENCY_ISSUES=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | ORCH_OPEN_BLOCKERS="$ORCH_OPEN_BLOCKERS" python3 -c "$(cat <<'PY'
import json, os, re, sys
PATTERNS = [
  r'\bblock(?:ed|s)?(?:[\s-]+by)?\s*:?\s*#(\d+)',
  r'\bdepend(?:s|ent)?(?:[\s-]+on)?\s*:?\s*#(\d+)',
]
try:
  open_blockers = {int(x) for x in (os.environ.get('ORCH_OPEN_BLOCKERS') or '').split() if x.isdigit()}
  blocked = []
  for it in json.load(sys.stdin):
    n = it.get('number')
    if not isinstance(n, int):
      continue
    stripped = re.sub(r'\x60[^\x60]*\x60', '', it.get('body') or '')
    refs = set()
    for pat in PATTERNS:
      for m in re.finditer(pat, stripped, re.IGNORECASE):
        x = int(m.group(1))
        if x > 0 and x != n:
          refs.add(x)
    if any(x in open_blockers for x in refs):
      blocked.append(n)
  print(' '.join(str(x) for x in sorted(blocked)))
except Exception:
  pass
PY
)" 2>/dev/null || true)
# Stable candidate order: issue number ASCENDING (oldest first), capped at 10,
# minus every anchor with dev work already in flight OR an open strict blocker
# (issue #3965). Both the ordering and the cap live here rather than in the jq
# so a newly-filed issue can neither reorder nor displace the pool (issue
# #3711, sub-defect (a)).
ORCH_GRILL_CANDIDATES=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | ORCH_INFLIGHT_ISSUES="$ORCH_INFLIGHT_ISSUES" ORCH_BLOCKED_DEPENDENCY_ISSUES="$ORCH_BLOCKED_DEPENDENCY_ISSUES" python3 -c "$(cat <<'PY'
import json, os, sys
try:
  inflight = {int(x) for x in (os.environ.get('ORCH_INFLIGHT_ISSUES') or '').split() if x.isdigit()}
  blocked_dep = {int(x) for x in (os.environ.get('ORCH_BLOCKED_DEPENDENCY_ISSUES') or '').split() if x.isdigit()}
  nums = set()
  for it in json.load(sys.stdin):
    n = it.get('number')
    if not isinstance(n, int):
      continue
    labels = {l.get('name', '') for l in (it.get('labels') or [])}
    if n in inflight or 'in-progress' in labels or n in blocked_dep:
      continue
    nums.add(n)
  for n in sorted(nums)[:10]:
    print(n)
except Exception:
  pass
PY
)" 2>/dev/null || true)
ORCH_GRILL_PICK="none"
ORCH_DEV_READY_PICK="none"
# ISSUE #3798: a THIRD signal, tied to ORCH_DEV_READY_PICK, so decide.py can
# tell a genuine fresh design-concept artifact apart from the mechanical
# (#1230) / trivial (#1088) exemption branches below — both of which set
# ORCH_DEV_READY_PICK but must NEVER be mistaken for "architecturally
# consequential enough to route dev_orch to the frontier tier". Only the
# fresh-artifact branch (below) sets this away from "none"; both exemption
# branches deliberately leave it untouched.
ORCH_DEV_READY_DESIGN_CONCEPT_STATUS="none"
if [ -n "$ORCH_GRILL_CANDIDATES" ]; then
  for n in $ORCH_GRILL_CANDIDATES; do
    # Both picks resolved — stop paying for design-concept round-trips.
    if [ "$ORCH_GRILL_PICK" != "none" ] && [ "$ORCH_DEV_READY_PICK" != "none" ]; then
      break
    fi
    DC_JSON=$(curl -sf --max-time 3 "http://localhost:4000/api/design-concepts/issue-${n}" 2>/dev/null || true)
    if [ -n "$DC_JSON" ]; then
      # Artifact exists. Skip ONLY if it's fresh (Phase B warn-only: a
      # draft/!gateOk-but-fresh artifact is still "fresh present" per the
      # selector's contract, so we don't re-grill it here either). A stale
      # or unparseable artifact falls through to the trivial gate below.
      FRESH_OK=$(printf '%s' "$DC_JSON" | python3 -c "$(cat <<'PY'
import json, sys, time
try:
  d = json.load(sys.stdin)
  created = int(d.get('createdAt', 0) or 0)
  now_ms = int(time.time() * 1000)
  fresh = (now_ms - created) <= (7 * 24 * 60 * 60 * 1000)
  print('1' if fresh else '0')
except Exception:
  print('0')
PY
)" 2>/dev/null || echo "0")
      if [ "$FRESH_OK" = "1" ]; then
        # Fresh artifact already present — nothing to grill for this anchor,
        # and it is GRILL-CLEAR: dev_orch may be pinned to it (issue #3711).
        if [ "$ORCH_DEV_READY_PICK" = "none" ]; then
          ORCH_DEV_READY_PICK="issue-${n}"
          # ISSUE #3798: capture the artifact's approval status alongside the
          # pin, sourced from the SAME DC_JSON already fetched above (no extra
          # round-trip). A parse failure or missing field conservatively
          # defaults to "none" — same fail-toward-Sonnet direction as every
          # other best-effort read in this loop.
          ORCH_DEV_READY_DESIGN_CONCEPT_STATUS=$(printf '%s' "$DC_JSON" | python3 -c "$(cat <<'PY'
import json, sys
try:
  d = json.load(sys.stdin)
  s = d.get('status')
  print(s if isinstance(s, str) and s else 'none')
except Exception:
  print('none')
PY
)" 2>/dev/null || echo "none")
        fi
        continue
      fi
    fi
    # No fresh artifact for issue-<N>: it would be a grill candidate. First
    # apply the mechanical/non-implementable gate (issue #1230) — suppress
    # UNCONDITIONALLY when the issue carries the `cleanup-scan` label (routes
    # straight to dev, needs no design) OR has a `track:` title prefix
    # (calendar-bound measurement window, not implementable now). MECHANICAL=1
    # means suppress; any parse error prints 0 → fall through to the next gate.
    MECHANICAL=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | ORCH_GRILL_N="$n" python3 -c "$(cat <<'PY'
import json, os, sys
target = int(os.environ['ORCH_GRILL_N'])
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
  print('0')
PY
)" 2>/dev/null || echo "0")
    if [ "$MECHANICAL" = "1" ]; then
      # Mechanical (cleanup-scan) or calendar-bound (track:) anchor — needs no
      # design concept. Suppress the grill and let dev_orch dispatch directly.
      # `cleanup-scan` is grill-clear by construction (self-checking, routes
      # straight to dev) so it is a valid dev pin. A `track:` tracker is NOT
      # implementable now, so it must NOT be pinned — only the cleanup-scan arm
      # records a dev-ready pick (issue #3711).
      if [ "$ORCH_DEV_READY_PICK" = "none" ] \
        && printf '%s' "$ORCH_GRILL_LIST_JSON" | ORCH_GRILL_N="$n" python3 -c "$(cat <<'PY'
import json, os, sys
target = int(os.environ['ORCH_GRILL_N'])
try:
  items = json.load(sys.stdin)
  it = next((x for x in items if int(x.get('number', -1)) == target), None)
  labels = {l.get('name', '') for l in ((it or {}).get('labels') or [])}
  sys.exit(0 if 'cleanup-scan' in labels else 1)
except Exception:
  sys.exit(1)
PY
)" 2>/dev/null; then
        ORCH_DEV_READY_PICK="issue-${n}"
      fi
      continue
    fi
    # Apply the trivial gate (issue #1088) next — suppress ONLY on a positive
    # trivial signal. TRIVIAL=1 means "explicit Expected tier: T1/1 stamp AND
    # no needs-design-concept label". Any ambiguity (parse error, missing
    # field) prints 0 → fail-toward-grill.
    TRIVIAL=$(printf '%s' "$ORCH_GRILL_LIST_JSON" | ORCH_GRILL_N="$n" python3 -c "$(cat <<'PY'
import json, os, re, sys
target = int(os.environ['ORCH_GRILL_N'])
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
  print('0')
PY
)" 2>/dev/null || echo "0")
    if [ "$TRIVIAL" = "1" ]; then
      # Provably trivial (T1-stamped, no opt-in label) — suppress the grill
      # and let this anchor fall straight through to dev_orch. Grill-clear by
      # construction, so it is a valid dev pin (issue #3711).
      if [ "$ORCH_DEV_READY_PICK" = "none" ]; then
        ORCH_DEV_READY_PICK="issue-${n}"
      fi
      continue
    fi
    # Needs a grill. Record the FIRST such anchor and keep walking — the loop
    # must still find a grill-clear anchor for dev_orch to build this turn
    # (issue #3711); pre-#3711 it `break`ed here, which is why decide.py only
    # ever saw "some anchor somewhere is un-grilled".
    if [ "$ORCH_GRILL_PICK" = "none" ]; then
      ORCH_GRILL_PICK="issue-${n}"
    fi
  done
fi
echo "orch_pending_grill_anchor=$ORCH_GRILL_PICK"
echo "orch_dev_ready_anchor=$ORCH_DEV_READY_PICK"
echo "orch_dev_ready_anchor_design_concept_status=$ORCH_DEV_READY_DESIGN_CONCEPT_STATUS"

# active dev_orch detector (issue #412): an open PR on a hydra-dev head
# branch updated within the last 90 minutes is the only reliable gate
# signal — the `in-progress` label can go stale when an earlier cycle
# died before producing a PR. We match the three branch-name prefixes
# hydra-dev actually creates: `issue-<N>-<slug>`, `hydra-dev/<...>`,
# and the harness-created `worktree-agent-<hash>` (Claude Agent tool
# isolation=worktree). 5400s = 90 min, matching the Phase 1.5 stale
# threshold so the two signals line up.
#
# GLM PARTITION (ADR-0032 / issue #3687, widened by #4048): a drainer PR is
# EXCLUDED. Provenance is the `glm-authored` label FIRST (ADR-0032 Decision 5)
# with the drainer's exact literal `worktree-agent-glm-` head-branch prefix as
# an OR-fallback: the drainer builds `worktree-agent-glm-${issue}-${ts}`
# (drainer-loop.sh create_worktree) while Opus dev_orch harness branches are
# `worktree-agent-<hex-hash>-...`, and a hex hash cannot contain g or l — so
# the prefix discriminates perfectly where the bare shared `worktree-agent-`
# prefix could not (#4048: the label's non-atomic `--label` mutation was
# silently missing on 29 of 62 drainer PRs, mis-partitioning this count too).
# This must stay the IDENTICAL OR-predicate glm-beachhead-report.sh applies,
# so the two consumers never disagree on what "a GLM PR" is. Without this
# filter every open drainer PR would inflate `active_dev_orch`, and decide.py's
# busy-slot guard would idle the Opus dev_orch slot on quota the drainer isn't
# even spending — inverting the whole point of the lane. `.labels // []` keeps
# the filter total: a PR row with no labels field is simply not glm-authored.
echo -n "active_dev_orch="
gh pr list --repo gaberoo322/hydra --state open --json updatedAt,headRefName,labels --jq '[
  .[]
  | select(
      (.headRefName | startswith("issue-"))
      or (.headRefName | startswith("hydra-dev/"))
      or (.headRefName | startswith("worktree-agent-"))
    )
  | select(
      (((.labels // []) | map(.name) | index("glm-authored"))
        or (.headRefName | startswith("worktree-agent-glm-")))
      | not
    )
  | select((now - (.updatedAt | fromdateiso8601)) < 5400)
] | length' 2>/dev/null || echo 0

# backlog + queues
#
# The Redis backlog subsystem (lanes: queued/inProgress/blocked/triage) was
# retired by the ADR-0031 Target-tracking migration (#3439, PR #3455): the
# Target now tracks work as GitHub Issues on gaberoo322/hydra-betting, so the
# `/api/backlog` + `/api/backlog/counts` HTTP surface is gone (returns 404).
# The old call (`hydra raw GET /backlog/counts || hydra backlog ls | json.load`)
# lacked a fail-closed guard: on a 404 the `hydra` CLI prints the HTML error
# BODY to stdout (not stderr, so `2>/dev/null` never suppressed it) and exits
# nonzero, so the `||` fallback piped that HTML into `json.load`, which erupted
# with a JSONDecodeError traceback at the top of the state emit and corrupted
# the whole board-signal collection (run b07ad8e4, 2026-07-18, issue #3478).
# The queued/inProgress/blocked/triage counts it emitted are consumed by NO
# decide.py / assert_invariants.py signal, so we drop them and instead emit a
# single OBSERVABLE marker: a degraded/retired read is now a visible signal line
# rather than a silent traceback. Fail closed — no CLI call that can 404 onto
# stdout.
echo "backlog_subsystem=retired-adr0031"
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
gh issue list --repo gaberoo322/hydra --state open --label enhancement --limit "$GH_ISSUE_LIST_LIMIT" --json number --jq 'length' 2>/dev/null || echo 0

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
#
# INERT ON THIS DEPLOYMENT (issue #4161): the rate is not merely defaulted —
# it was never set post-ADR-0006 and #704 removed the conversion machinery
# outright, so this always evaluates to 0.00 here. The live budget split is
# the orch_realm_weekly_share collector below (issue #4161).
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
ARCH_BOARD_JSON=$(gh issue list --repo gaberoo322/hydra --state open --limit "$GH_ISSUE_LIST_LIMIT" --json number,labels --jq "{
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
printf '%s' "$ARCH_BOARD_JSON" | ARCH_WORK_QUEUE="$ARCH_WORK_QUEUE" ARCH_BOARD_SATURATION_CAP="$ARCH_BOARD_SATURATION_CAP" CLEANUP_BOARD_SATURATION_CAP="$CLEANUP_BOARD_SATURATION_CAP" python3 -c "$(cat <<'PY'
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
PY
)" 2>/dev/null || { echo "orch_backfill_idle=false"; echo "arch_board_open_scan=0"; echo "arch_board_saturated=false"; echo "cleanup_board_open_scan=0"; echo "cleanup_board_saturated=false"; }

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
  echo "target_board_signals_degraded=false"
  printf '%s' "$TARGET_BOARD_ISSUES_JSON" | TARGET_WORK_QUEUE="$ARCH_WORK_QUEUE" \
    GH_ISSUE_LIST_LIMIT="$GH_ISSUE_LIST_LIMIT" \
    TARGET_CLEANUP_SCAN_LABEL="$TARGET_CLEANUP_SCAN_LABEL" \
    TARGET_WIRE_OR_RETIRE_LABEL="$TARGET_WIRE_OR_RETIRE_LABEL" \
    TARGET_DESIGN_QA_LABEL="$TARGET_DESIGN_QA_LABEL" \
    TARGET_DESIGN_QA_BOARD_SATURATION_CAP="$TARGET_DESIGN_QA_BOARD_SATURATION_CAP" \
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
  print('design_qa_target_due=' + ('false' if dqa_saturated else 'true'))
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
  print('design_qa_target_due=false')
PY
)" 2>/dev/null || { echo "target_board_signals_truncated=false"; echo "target_needs_triage_items="; echo "target_backfill_idle=false"; echo "target_cleanup_board_open_scan=0"; echo "target_cleanup_board_saturated=true"; echo "wire_or_retire_target_triage=0"; echo "wire_or_retire_target_available=false"; echo "wire_or_retire_target_unlabelled=0"; echo "design_qa_target_open=0"; echo "design_qa_target_saturated=true"; echo "design_qa_target_due=false"; }
else
  # Fail closed AND observable: the board read was unreachable/empty, so emit
  # the suppressing defaults (never dispatch a scan/resolver that cannot read
  # its own board) but flag the degradation so it is not an invisible zero-set.
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
hydra raw GET /autopilot/runs?limit=14 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try:
  d=json.load(sys.stdin)
  runs=d.get('runs',[]) if isinstance(d,dict) else []
  completed=[r for r in runs if isinstance(r,dict) and str(r.get('status','')).lower() not in ('','running')]
  print('true' if completed else 'false')
except Exception:
  print('false')
PY
)" || echo "false"

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
  --limit "$GH_ISSUE_LIST_LIMIT" \
  --json number,labels --jq '
    [ .[]
      | select((.labels | map(.name) | index("wayfinder:destination-pending")) | not)
      | .number ]
    | sort' 2>/dev/null || true)
WF_FRONTIER="none"
WF_TICKET_TYPE=""
WF_INFLIGHT_GLOBAL=0
if [ -n "$WF_MAPS_JSON" ]; then
  WF_MAP_NUMS=$(printf '%s' "$WF_MAPS_JSON" | python3 -c "$(cat <<'PY'
import json, sys
try:
  for n in json.load(sys.stdin):
    print(int(n))
except Exception:
  pass
PY
)" 2>/dev/null || true)
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

# tickets_orch board condition — resolved plan awaiting ticketing (issue #4014,
# design-concept issue-4014). Wakes the dormant tickets-STAGE producer wired in
# #3423 (ADR-0030 Decision 2/5 — the §0.8 needs-tickets -> children slicing
# step the class was built for; until this block landed, `tickets_available` had
# zero producers repo-wide and the selector was a documented, tested no-op).
#
# Structural sibling of the wayfinder_orch_frontier collector above: the
# tickets-STAGE producer needs the SAME pre-resolution decide.py cannot do
# itself (it stays PURE — AC: no gh/curl/GraphQL inside decide.py; the board
# enumeration lives ONLY here). This block answers "does a resolved plan await
# ticketing?" and emits two signals the model stitches into state.signals:
#
#   - `tickets_available`          — `true` when >=1 eligible spec exists, else
#     `false` (a direct boolean emit, same shape as `orch_backfill_idle`).
#   - `tickets_orch_pending_spec`  — an `issue-<N>` ref for the OLDEST eligible
#     spec, or `none` when nothing awaits (verbatim string, the SAME seam as
#     `wayfinder_orch_frontier` / `orch_pending_grill_anchor`).
#
# Board condition (design-concept INV-3): an OPEN issue carrying the EXISTING
# `needs-tickets` label (#3817's parking lane — a published spec/plan awaiting
# /to-tickets decomposition). No new label is introduced: `needs-tickets`
# already encodes exactly this semantic, so a second parallel parking lane
# would fragment it (the label-drift bug class this repo's operator memory
# documents). Making needs-tickets autopilot-visible is the intended
# consequence of ADR-0030's one-lineage AFK spine, not a contradiction of its
# prior 'operator-driven' framing — that framing predates the spine.
#
# In-flight dedup (design-concept INV-4): a spec currently being decomposed is
# excluded by ASSIGNMENT, mirroring wayfinder_orch's assignee-based
# single-flight. A live hydra-tickets worker self-assigns the spec as its first
# step (the same `--add-assignee @me` claim every AFK working class uses), so
# an OPEN ASSIGNED needs-tickets issue is mid-decomposition and never re-picked
# within the window. This bounds duplicate-epic risk BEYOND the existing 1h
# SIGNAL_COOLDOWNS["tickets_orch"] backstop decide.py honors. (Long-term
# re-fire prevention is the composed hydra-tickets skill dropping needs-tickets
# on successful decomposition — design-concept INV-6, the skill's
# responsibility — so the NEXT enumeration does not re-surface the same spec.)
#
# One-per-fire: we take the OLDEST eligible spec (number ascending, stable
# across ticks) — the 1h class cooldown paces the rest, exactly as wayfinder
# takes the first frontier ticket per fire. A single cheap REST `gh issue list`
# suffices (no sub-issue / blocked-by walk is needed, unlike wayfinder maps).
#
# Best-effort: any failure (gh down, malformed output, empty lane) degrades to
# `tickets_available=false` + `tickets_orch_pending_spec=none` — the
# SUPPRESSING direction (never dispatch a decomposition with no resolved
# target), mirroring wayfinder's `none` fail-closed.
echo -n "tickets_available="
TICKETS_PICK_NUM=""
TICKETS_JSON=$(gh issue list --repo gaberoo322/hydra --state open --label needs-tickets \
  --limit "$GH_ISSUE_LIST_LIMIT" \
  --json number,assignees --jq '
    [ .[]
      | select((.assignees | length) == 0)
      | .number ]
    | sort
    | .[0]' 2>/dev/null || true)
# Accept only a bare positive integer: `gh --jq` prints `null` for an empty
# list's .[0], and a transient gh failure yields empty output (the `|| true`
# above). Any non-numeric / null result keeps both signals suppressed.
case "$TICKETS_JSON" in
  ''|*[!0-9]*) ;;
  *) TICKETS_PICK_NUM="$TICKETS_JSON" ;;
esac
if [ -n "$TICKETS_PICK_NUM" ]; then
  echo "true"
  echo "tickets_orch_pending_spec=issue-${TICKETS_PICK_NUM}"
else
  echo "false"
  echo "tickets_orch_pending_spec=none"
fi

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
hydra raw GET /scout/alert-plan 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try: d=json.load(sys.stdin); print(len(d.get('eligible',[])))
except: print(0)
PY
)" || echo 0

# Orch-realm weekly share — the one LIVE budget split (issue #4161).
#
# Every USD-denominated cost gate in decide.py is structurally inert on this
# deployment (HYDRA_TOKEN_USD_RATE never set post-ADR-0006; #704 stripped the
# dollar-conversion machinery — the spend counters are permanently $0), so
# none of them can back an orch-vs-target budget split. This collector
# enumerates the real one: it fetches `/api/usage` `bySkillByModel` — the
# 7-day rolling weekly cross-tab, and the only trustworthy per-skill surface
# (NOT `costByClass`, which covers only ~13% of measured spend) — folds each
# skill's token total into per-realm buckets via the taxonomy `scope` column
# in the sibling classes.json, and emits ONE pre-qualified line the playbook
# merges as `state.signals.orch_realm_weekly_share`:
#
#   orch_realm_weekly_share=<fraction 0..1>  orch dispatch spend over
#                                            (orch + target) dispatch spend
#   orch_realm_weekly_share=unavailable      no usable reading this turn
#
# decide.py reads that value verbatim and suppresses ORCH-scope dispatch when
# it exceeds `state.limits.orch_realm_max_share` (default 0 = guard
# disabled — ADR-0021 D5: never a second governor behind the operator's
# back). Fold rules:
#   - taxonomy scope "orch"   -> orch numerator
#   - taxonomy scope "target" -> target side of the denominator
#   - taxonomy scope "both" (health) -> NEITHER side: realm-agnostic shared
#     spend must not tilt either realm's share
#   - skills absent from the taxonomy (operator `interactive` sessions, the
#     `hydra-autopilot` brain loop itself, ...) -> NEITHER side: the split
#     measures DISPATCH-class spend only, so shared/unattributed spend
#     changes neither realm's share
#
# Best-effort on the sibling contract: the collect step NEVER fails — an
# orchestrator-down fetch, an unparseable payload, an unreadable taxonomy,
# or a zero denominator (no dispatch spend in the window at all) all degrade
# to `orch_realm_weekly_share=unavailable`, which decide.py treats as "no
# usable reading" and leaves the guard DISABLED. An unreadable meter must
# never suppress dispatch (issue #4161 AC1 — the same fail-open direction
# ADR-0032 chose for the drainer heartbeat, and the opposite of the
# fabricated-certainty failure #4128 documents). The python below prints
# exactly one line on EVERY path, so no `||` fallback echo is needed (and
# none is safe: under `set -o pipefail` a failed `hydra` fetch would fire a
# fallback echo AFTER python's own line, corrupting the output with a
# duplicate).
echo -n "orch_realm_weekly_share="
ORCH_REALM_TAXONOMY="${0%/*}/classes.json"
hydra raw GET /usage 2>/dev/null | python3 -c "$(cat <<'PY'
import json, math, sys

def unavailable():
    print("unavailable")
    sys.exit(0)

try:
    payload = json.load(sys.stdin)
except Exception:
    unavailable()
bsm = payload.get("bySkillByModel") if isinstance(payload, dict) else None
if not isinstance(bsm, dict):
    unavailable()

# skill -> taxonomy scope ("orch" | "target" | "both"). An unreadable
# taxonomy degrades the WHOLE fold — never a guessed split.
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        rows = (json.load(fh) or {}).get("classes") or []
except Exception:
    unavailable()
skill_scope = {}
for row in rows:
    if not isinstance(row, dict):
        continue
    skill, realm = row.get("skill"), row.get("scope")
    if isinstance(skill, str) and realm in ("orch", "target", "both"):
        skill_scope[skill] = realm

orch = 0.0
target = 0.0
for skill, entry in bsm.items():
    realm = skill_scope.get(skill)
    if realm not in ("orch", "target"):
        continue  # unknown skill or realm-agnostic "both" — neither side
    if not isinstance(entry, dict):
        continue
    for fam in entry.values():
        if not isinstance(fam, dict):
            continue
        raw = fam.get("total")
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            continue
        if realm == "orch":
            orch += float(raw)
        else:
            target += float(raw)

denom = orch + target
if not math.isfinite(denom) or denom <= 0:
    unavailable()
share = orch / denom
if not math.isfinite(share) or share < 0 or share > 1:
    unavailable()
print(f"{share:.4f}")
PY
)" "$ORCH_REALM_TAXONOMY"

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
hydra raw GET /capacity 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try:
  d=json.load(sys.stdin); o=d['orchestrator']
  print(f'capacity_orch_share={o["share"]:.2f} capacity_floor_met={d["floorMet"]} capacity_window={o["window"]}')
except: print('capacity_floor_met=true capacity_window=0')
PY
)"

# scheduler / cycle
hydra cycle status 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try: d=json.load(sys.stdin); print('CODEX_ACTIVE' if d.get('running') else 'CODEX_IDLE')
except: print('CODEX_IDLE')
PY
)"
hydra scheduler status 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try:
  d=json.load(sys.stdin)
  s=d.get('state','?'); nm=d.get('consecutiveNonMerges',0)
  stall='ok' if nm<5 else ('hard-stop' if nm>=8 else 'alert')
  print(f'scheduler={s} nonmerges={nm} stall={stall}')
except: print('scheduler=unknown stall=unknown')
PY
)"

# recommendations
hydra recommendations 2>/dev/null | python3 -c "$(cat <<'PY'
import json,sys
try:
  items=json.load(sys.stdin)
  if items: print(f'recommendations={len(items)}: {items[0].get("action","?")[:60]}')
  else: print('recommendations=0')
except: print('recommendations=unavailable')
PY
)"

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
docker exec hydra-redis-1 redis-cli XREAD COUNT "$SLOT_EVENTS_COUNT" STREAMS "$SLOT_EVENTS_STREAM" "$SLOT_EVENTS_LAST_ID" 2>/dev/null | python3 -c "$(cat <<'PY'
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
PY
)" 2>/dev/null || echo '{"events": [], "last_id": null}'
