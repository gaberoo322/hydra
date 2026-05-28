---
name: hydra-target-sweep
description: Autonomous target project board processor. Scans Redis backlog triage/blocked/reframe lanes and advances items that can be progressed without operator input.
when_to_use: "When the user says 'sweep target', 'process backlog', 'advance target items', or wants to clean up the target project work queue. Also dispatched by hydra-autopilot."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
---

# Hydra Target Sweep

Autonomous board processor for `~/hydra-betting` work tracked in Redis via the Hydra API. Advances items without operator judgment, escalates the rest.

## Context management

On `/loop`, run `/compact` (Claude) / restart context (Codex) at the START of each iteration.

## Process

### 1. Collect state

```bash
hydra backlog ls | python3 -c "
import json,sys
d=json.load(sys.stdin)
for lane in ['triage','queued','inProgress','blocked']:
    items=d.get(lane,[])
    if items:
        print(f'{lane}: {len(items)}')
        for i in items[:5]: print(f'  [{i.get(\"id\")}] {i[\"title\"][:70]}')
"

docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:reframe-queue 0 -1
docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:prior-failures 0 -1
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue

hydra metrics --count 20 | python3 -c "
import json,sys
d=json.load(sys.stdin)
for t in [m.get('taskTitle','').lower() for m in d.get('trend',[]) if int(m.get('tasksMerged',0))>0][:10]: print(t)
"
```

### 2. Process triage lane

For each:
1. **Already completed?** → compare title to recent merged titles. If done: `hydra backlog move $ITEM_ID done`
2. **Well-described?** = specific title (names file/function/behavior) + description with context.
3. **Auto-promote** well-described → `hydra backlog move $ITEM_ID queued`
4. **Flag vague** items — log for operator, don't block sweep.

### 3. Process blocked lane

For each:
1. Read blocked reason from metadata
2. Blocker is a specific backlog item now done → unblock to queued
3. External dependency (vendor / operator) → leave, log
4. Stale reason (>7 days no update) → log for operator review
5. Work was done by a different item / cycle → move to done

### 4. Process reframe queue

Each entry is JSON with `taskId`, `reason`, `retryCount`:
1. Underlying issue fixed by recent merge (title overlap) → remove:
   ```bash
   docker exec hydra-redis-1 redis-cli LREM hydra:anchors:reframe-queue 1 '<json>'
   ```
2. Still failing — is the failure reason actionable without operator input?
   - "No code changes produced" → too vague. Leave for operator.
   - "Verification failed" → narrow scope, re-queue:
     ```bash
     hydra queue add "<narrowed title>" -d "Reframed after <N> failures: <specific narrowing>"
     ```
   - "Scope gate blocked" → too broad. Leave for operator.
   - "Regression" → fragile area. Leave for operator.

### 5. Stall-detection (in-progress >90 min)

Detect items that claimed an `inProgress` slot but stopped making progress. Backlog items expose `movedAt` (ISO timestamp of the most recent lane transition) and, for `inProgress`, `claimedAt` + `claimedBy`. Items that landed in `inProgress` before these timestamps shipped (PR #201) will have `movedAt: null` — skip those, the longer-cutoff `requeueStaleInProgressItems()` job (multi-day) handles them.

```bash
hydra backlog ls | python3 -c "
import json,sys,datetime
d=json.load(sys.stdin)
now=datetime.datetime.now(datetime.timezone.utc)
cutoff_min=90
for i in d.get('inProgress',[]):
    moved=i.get('movedAt')
    if not moved:
        continue
    try:
        mt=datetime.datetime.fromisoformat(moved.replace('Z','+00:00'))
    except Exception:
        continue
    age_min=(now-mt).total_seconds()/60
    if age_min>cutoff_min:
        print(f'{i[\"id\"]}\t{int(age_min)}min\t{i.get(\"claimedBy\") or \"-\"}\t{i[\"title\"][:60]}')
"
```

For each row printed (id, age, claimer, title):

1. Auto-recover: move back to `queued` so it's pickable again.
   ```bash
   hydra backlog move $ITEM_ID queued
   ```
2. Log the action in the report under "Stall recoveries" with id, age, prior claimer, and reason `stalled-90min`.
3. If the same item shows up here on consecutive sweeps, flag it for operator attention — repeated stalls usually mean a structural blocker, not a transient agent crash.

This step complements (does not replace) the daily `requeueStaleInProgressItems()` cleanup that uses a multi-day cutoff. The 90-minute version gives operators a fast feedback signal when the WIP slots silently fill up.

### 6. Clean prior failures

Cap at 10. For each:
1. Underlying work completed by a different cycle → remove
2. Age >48h with no resolution → escalate to reframe or remove
3. Remove stale:
   ```bash
   docker exec hydra-redis-1 redis-cli LREM hydra:anchors:prior-failures 1 '<json>'
   ```

### 7. Detect completed backlog items

Scan all active lanes for items whose title matches recent merge titles. Move completed → done.

### 8. Report

```
## Target Sweep — <date>

### Triage: <before> → <after>
- Promoted: N to queued
- Completed: N (already done)
- Flagged: N (vague, need operator)

### Blocked: <before> → <after>
- Unblocked: N
- Still blocked: N

### Reframe: <before> → <after>
- Cleared: N (work already done)
- Re-queued: N (narrowed scope)
- Needs operator: N

### Stall recoveries (>90 min in inProgress)
- Recovered: N (moved back to queued)
- Repeat offenders: N (flagged for operator)

### Prior failures: <before> → <after>
- Cleared stale: N
- Still active: N

### Operator actions needed
- <list>
```

## Rules

- Never delete backlog items — move to done or leave
- Never modify item descriptions — only move between lanes
- Re-queuing reframe items: always narrow the scope in the reference
- Log every action for the report
- Unsure if completed → leave it. False negatives are safer than false positives.
- **Vocabulary.** When narrowing a reframe item or promoting a triage item, name it using the target's canonical vocabulary — `~/hydra-betting/CONTEXT-MAP.md` and the per-context `CONTEXT.md` files. Don't invent synonyms; if the noun you need isn't in the glossary, leave the item for the operator instead of inventing language. The per-context layout is documented in `~/hydra-betting/docs/agents/domain.md`.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
