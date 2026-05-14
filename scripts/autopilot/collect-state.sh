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

# backlog + queues
hydra raw GET /backlog/counts 2>/dev/null || hydra backlog ls | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(json.dumps({l: len(d.get(l,[])) for l in ['queued','inProgress','blocked','triage']}))"
echo -n "work_queue="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null || echo 0
echo -n "reframe_queue="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:reframe-queue 2>/dev/null || echo 0
echo -n "prior_failures="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:prior-failures 2>/dev/null || echo 0

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
