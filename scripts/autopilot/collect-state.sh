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
