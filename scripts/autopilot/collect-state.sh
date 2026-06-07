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

set -uo pipefail

# health
hydra health 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print(f'health={d[\"status\"]} redis={d[\"redis\"]}')
except: print('health=FAIL')"

# failed services
echo -n "failed_services="; systemctl --user list-units --type=service --state=failed --no-legend 2>/dev/null | grep -c hydra || echo 0

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
    ready_for_agent: [.[] | select(.labels | map(.name) | index("ready-for-agent"))] | length,
    needs_triage: [.[] | select(.labels | map(.name) | index("needs-triage"))] | length,
    needs_research: [.[] | select(.labels | map(.name) | index("needs-research"))] | length,
    in_progress: [.[] | select(.labels | map(.name) | index("in-progress"))] | length,
    blocked: [.[] | select(.labels | map(.name) | index("blocked"))] | length,
    stale_in_progress: [.[] | select((.labels | map(.name) | index("in-progress")) and ((now - (.updatedAt | fromdateiso8601)) > 5400))] | map(.number),
    stale_blocked: [.[] | select((.labels | map(.name) | index("blocked")) and ((now - (.updatedAt | fromdateiso8601)) > 43200))] | map(.number)
  }'
fi

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
ORCH_GRILL_LIST_JSON=$(gh issue list --repo gaberoo322/hydra --state open --label ready-for-agent --json number,updatedAt,body,labels --jq '
  sort_by(.updatedAt) | reverse | .[0:10]
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
    # No fresh artifact for issue-<N>: it would be a grill candidate. Apply
    # the trivial gate (issue #1088) — suppress ONLY on a positive trivial
    # signal. TRIVIAL=1 means "explicit Expected tier: T1/1 stamp AND no
    # needs-design-concept label". Any ambiguity (parse error, missing
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
  ready_for_agent: [.[] | select(.labels | map(.name) | index(\"ready-for-agent\"))] | length,
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
