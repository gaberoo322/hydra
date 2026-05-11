---
name: hydra-autopilot
description: Meta-orchestrator that selects and runs the highest-priority Hydra skill based on system state. Designed for /loop overnight operation. Target-project work uses orchestrator API triggers; orchestrator-side work dispatches via background agents.
when_to_use: "When the user wants autonomous overnight operation, says 'autopilot', 'run overnight', 'autonomous mode', or wants a single skill to manage all hydra operations."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
---

# Hydra Autopilot

Meta-orchestrator for overnight autonomous operation. Each iteration is a thin decision loop (~2 min). Target-project work uses the orchestrator's own API (non-blocking, Codex-powered). Orchestrator-side work dispatches via background agents with isolated context.

## Architecture

```
Each iteration (~2 min):
  Phase 0: /compact + heartbeat + iteration budget
  Phase 1: Collect state (parallel, counts only)
  Phase 1.5: Auto-recover stale issues (inline label fixes)
  Phase 2: Dispatch gate (background agent already running?)
  Phase 3: Priority waterfall (first match wins)
  Phase 4: Dispatch
  Phase 5: One-line report

Three dispatch modes:
  1. Inline API — target-project work via orchestrator endpoints (non-blocking)
  2. Background agent — orchestrator-side skills, isolated context
     (Claude: Agent(run_in_background:true); Codex: codex exec & disowned subprocess)
  3. Skip — already in flight
```

## Phase 0: Housekeeping

1. `/compact` (Claude) or fresh context (Codex).
2. Heartbeat:
   ```bash
   echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pid=$$" > /tmp/hydra-autopilot-heartbeat.txt
   ```
3. Iteration budget:
   ```bash
   COUNTER_FILE=/tmp/hydra-autopilot-iteration-count.txt
   if [ -f "$COUNTER_FILE" ]; then
     FILE_AGE=$(( $(date +%s) - $(stat -c %Y "$COUNTER_FILE") ))
     [ "$FILE_AGE" -gt 28800 ] && echo 0 > "$COUNTER_FILE"
   fi
   COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
   echo $((COUNT + 1)) > "$COUNTER_FILE"
   ```
   Count > 50 → STOP gracefully. Print `[autopilot] Session budget exhausted (50 iterations). Restart loop for fresh context.`

## Phase 1: Collect state (parallel, counts only — never dump raw responses)

```bash
# health
hydra health 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print(f'health={d[\"status\"]} redis={d[\"redis\"]}')
except: print('health=FAIL')"

# failed services
echo -n "failed_services="; systemctl --user list-units --type=service --state=failed --no-legend 2>/dev/null | grep -c hydra || echo 0

# issue board + stale
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

# capacity-floor — orchestrator self-improvement share (issue #245)
hydra raw GET /capacity 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin); o=d['orchestrator']
  print(f'capacity_orch_share={o[\"share\"]:.2f} capacity_floor_met={d[\"floorMet\"]} capacity_window={o[\"window\"]}')
except: print('capacity_floor_met=true capacity_window=0')"

# cycle + scheduler
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

# dispatch state
cat /tmp/hydra-autopilot-dispatch.json 2>/dev/null || echo '{"status":"idle"}'

# recommendations
hydra recommendations 2>/dev/null | python3 -c "
import json,sys
try:
  items=json.load(sys.stdin)
  if items: print(f'recommendations={len(items)}: {items[0].get(\"action\",\"?\")[:60]}')
  else: print('recommendations=0')
except: print('recommendations=unavailable')"
```

## Phase 1.5: Auto-recover stale issues

**Stale in-progress (>90 min):**
```bash
for ISSUE in <stale_in_progress>; do
  gh issue edit $ISSUE --repo gaberoo322/hydra --remove-label in-progress --add-label ready-for-agent
  gh issue comment $ISSUE --repo gaberoo322/hydra --body "> *Autopilot:* Re-queued. >90 min idle in in-progress."
done
```

**Stale blocked (>12h, blockers closed):**
```bash
for ISSUE in <stale_blocked>; do
  BLOCKERS=$(gh issue view $ISSUE --repo gaberoo322/hydra --json body --jq '.body' | grep -oP '(?<=#)\d+' | head -20)
  ALL_CLOSED=true
  for b in $BLOCKERS; do
    STATE=$(gh issue view $b --repo gaberoo322/hydra --json state --jq '.state' 2>/dev/null)
    [ "$STATE" != "CLOSED" ] && ALL_CLOSED=false && break
  done
  [ "$ALL_CLOSED" = true ] && gh issue edit $ISSUE --repo gaberoo322/hydra --remove-label blocked --add-label ready-for-agent
done
```

If labels changed, re-read board.

## Phase 2: Dispatch gate

Parse `/tmp/hydra-autopilot-dispatch.json`:

| State | Action |
|-------|--------|
| `running` <90min | BG dispatches blocked. Inline API still allowed. |
| `running` >=90min | Timeout — clear. All allowed. |
| `done`/`failed`/missing | All allowed. |

Codex cycle active → `codex_busy=true` (blocks P5 only).

## Phase 3: Priority waterfall (first match wins)

### Phase 3.0: Capacity-floor preference (issue #245, ADR-0003 vision-vector-2)

Before walking the waterfall, check the orchestrator self-improvement share collected in Phase 1 (`capacity_orch_share`, `capacity_floor_met`).

**If `capacity_floor_met == false` AND `capacity_window >= 5`** (enough history to make a call), the autopilot **prefers orchestrator-side skills** in this order:

1. `hydra-discover` — only if orchestrator board has <5 `ready-for-agent` issues
2. `hydra-research` — if cooldown allows
3. `hydra-dev <highest-impact>` — if `ready_for_agent > 0`

Falls back to the normal waterfall only when the orchestrator side has nothing actionable (board empty AND research on cooldown). The floor is a **soft preference**, not a hard block — P0 (health) and P0.5 (pipeline recovery) still pre-empt it. The share recovers naturally on subsequent cycles.

Log line when the preference fires:
```
[autopilot] capacity-floor fired: orchestrator share <X>% < floor 25% (window=N)
```

### Standard waterfall

| Pri | Condition | Action | Type | Cooldown |
|-----|-----------|--------|------|----------|
| **P0** | health=FAIL or redis=false or failed_services>0 | Deep health → doctor if needed | API+BG | -- |
| **P0.5** | stall=hard-stop OR scheduler=stopped OR (alert AND rising) | Pipeline recovery | API+BG | -- |
| **P1** | needs_qa > 0 | `hydra-qa <oldest>` | BG | -- |
| **P2** | ready_for_agent > 0 AND in_progress = 0 | `hydra-dev <highest-impact>` | BG | -- |
| **P3** | work_queue + triage < 15 | Orchestrator research trigger | API | 30 min |
| **P3.5** | ready_for_agent = 0 | `hydra-research` | BG | 60 min |
| **P4** | needs_triage > 0 | `hydra-sweep` | BG | -- |
| **P4.5** | triage>5 OR reframe>2 OR prior_failures>8 | `hydra-target-sweep` | BG | -- |
| **P5** | work_queue>0 AND !codex_busy | Codex cycle trigger | API | -- |
| **P6** | backlog≥30 AND last 10 cycles >50% empty/failed | `hydra-discover` | BG | -- |
| **P7** | needs_research>0 | `hydra-issue-research <oldest>` | BG | -- |
| **P8** | last digest >6h | `hydra-digest` | BG | 6 hr |
| **P9** | true idle | `hydra-target-discover` | BG | -- |

### Inline API actions

**P0 deep:**
```bash
DEEP=$(hydra health deep 2>/dev/null)
echo "$DEEP" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  issues=[k for k,v in d.items() if isinstance(v,dict) and v.get('status') not in ('ok','healthy',True)]
  print(f'HEALTH_ISSUES: {issues}' if issues else 'HEALTH_DEEP: clear')
except: print('HEALTH_DEEP: parse error — dispatch doctor')"
```
Clear → fall through to P1. Real issues / parse error → dispatch `hydra-doctor` BG.

**P0.5 pipeline recovery:**
```bash
# scheduler=stopped or hard-stop:
hydra scheduler start && echo "Restarted scheduler"
hydra research force && echo "Forced research cycle"
# also dispatch hydra-doctor BG to diagnose root cause
```
After P0.5 actions, **don't fall through** — skip to Phase 5.

**P3 research trigger:**
```bash
hydra research start && \
  echo "research-trigger $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/hydra-autopilot-log.txt && \
  date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/hydra-last-research.txt
```

**P5 codex cycle trigger:**
```bash
hydra cycle start && \
  echo "codex-trigger $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/hydra-autopilot-log.txt
```

### Cooldown checks

```bash
[ -f "$FILE" ] && LAST=$(cat "$FILE") && NOW=$(date +%s) && \
  THEN=$(date -d "$LAST" +%s 2>/dev/null || echo 0) && \
  [ $((NOW - THEN)) -lt $COOLDOWN_SECS ] && echo "SKIP: cooldown active"
```

| Action | File | Cooldown |
|--------|------|----------|
| P3 research trigger | `/tmp/hydra-last-research.txt` | 1800s |
| P3.5 hydra-research | `/tmp/hydra-last-orchestrator-research.txt` | 3600s |
| P8 hydra-digest | `/tmp/hydra-last-digest.txt` | 21600s |

### Circuit breaker

If same skill in last 5 log entries 3+ times AND board state hasn't changed (compare to `/tmp/hydra-autopilot-prev-state.txt`), skip and fall through:
```
[autopilot] Circuit break: <skill> dispatched <N>x without board progress.
```

## Phase 4: Dispatch

### Inline API (P0-api, P3, P5)
Already executed in Phase 3. Log + report.

### Background agent (P0-doctor, P1, P2, P3.5, P4, P4.5, P6-P9)

1. Marker: `echo '{"status":"running","skill":"<S>","started":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > /tmp/hydra-autopilot-dispatch.json`
2. Log: `echo "<S> $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/hydra-autopilot-log.txt`
3. **Do NOT write the skill's own cooldown file here.** Skills with internal rate-limiting (`hydra-research`, `hydra-discover`, `hydra-target-research`) own their own cooldown timestamp and check it on entry. If autopilot writes the cooldown pre-dispatch, the skill reads it and rate-limits itself into a no-op (observed 2026-05-09: research dispatched, skipped 16s later because autopilot pre-stamped the file). The autopilot's circuit breaker (Phase 3, 3-same-skill-in-a-row check) is the dispatch-rate guard. The cooldown table (P3, P5, P8) applies only to **inline API actions** that have no skill of their own to enforce it.
4. Save board state for circuit breaker.
5. **Worktree-guard preamble (required for code-writing skills: `hydra-dev`, `hydra-qa`).** Every dispatched prompt MUST begin with the block below. The dispatched agent uses it to verify isolation and ABORT on mismatch — never fall back to `~/hydra`. See `docs/operator-playbooks/hydra-dev.md` for the canonical text and rationale.

   ```
   ## CRITICAL SAFETY RULE — READ FIRST
   Run `pwd` and `git rev-parse --git-dir` first.
   - Worktree path AND `.git/worktrees/...` gitdir → proceed.
   - cwd == `/home/gabe/hydra` → ABORT with status:failed. Do not run any git commands.
   No fallback to `~/hydra`. No `git checkout` in the main tree.
   ```
6. Dispatch:
   - **Claude:** `Agent(description:"<S>", run_in_background:true, isolation:"worktree", prompt:"<WORKTREE-GUARD PREAMBLE>\n\n... call Skill(skill:'<S>',args:'<ARGS>') and write completion marker on done/failed.")`
     Pass `isolation:"worktree"` for any skill that writes code. The harness should spin a fresh worktree under `.claude/worktrees/agent-<id>`.
   - **Codex:** `nohup codex exec --skill <S> --args '<ARGS>' >> /tmp/hydra-autopilot-bg.log 2>&1 & disown`
     Then write `done`/`failed` to `/tmp/hydra-autopilot-dispatch.json` from a wrapper.
7. **Post-dispatch sanity check.** After the BG agent terminates, verify `git -C ~/hydra rev-parse --abbrev-ref HEAD == master`. If not, surface a warning in the Phase 5 report (`isolation_breach=<branch>`) and do NOT auto-`checkout master` — let the operator decide whether the feature branch has unpushed work. This catches the 2026-05-11 #245 failure mode where isolation silently broke and the BG agent committed in `~/hydra`.

### Recording orchestrator-side merges (capacity-floor data source)

`hydra-dev` lands orchestrator-side PRs but does not run through the Codex control loop, so post-merge does not stamp those entries. After a successful merge to `master` of `gaberoo322/hydra`, the dispatching skill (or a webhook) should POST the merge to the capacity ledger so the floor sees it:

```bash
hydra raw POST /capacity/orchestrator-merge --json '{
  "cycleId": "pr-<PR_NUMBER>",
  "commitSha": "<sha>",
  "filesChanged": ["src/foo.ts", "..."],
  "source": "hydra-dev"
}'
```

Without this signal the share will read as 0% and the preference will fire every cycle until merged orchestrator work appears in the window.

## Phase 5: Report (one line)

```
[autopilot] <ts> | <action> | Reason: <condition> | Board: qa=N agent=N triage=N wq=N | Capacity: orch=X%/25% (W cycles)
```

Or:
```
[autopilot] <ts> | WAITING for <skill> (<N>m) | Board: qa=N agent=N triage=N wq=N
[autopilot] <ts> | STOPPED | Session budget exhausted | Board: qa=N agent=N triage=N wq=N
```

## Safety rules

1. NEVER modify `~/hydra` working tree directly.
2. NEVER call skills inline from autopilot. BG dispatch only (Claude: `Agent(run_in_background:true)`; Codex: disowned `codex exec`). Inline API for non-blocking ops only.
3. One BG agent at a time. Inline API always allowed.
4. Rate-limit research (30/60 min); rate-limit codex triggers; circuit-break repeated dispatches without progress.
5. Iteration cap = 50.
6. Dispatch timeout = 90 min.
7. NEVER auto-run `/hydra-architect` — operator-only.
8. Capacity-floor preference is **soft** — P0/P0.5 always pre-empt it. Never refuse target work indefinitely; the share recovers naturally.
