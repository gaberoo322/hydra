---
name: hydra-digest
description: Generate a daily or on-demand summary of Hydra system activity — merges, failures, test growth, cost, backlog flow, and priority progress.
when_to_use: "When the user says 'digest', 'summary', 'what happened', 'daily report', 'overnight report', or wants to understand recent system activity."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
arguments: [period]
---

# Hydra Digest

Concise summary of recent Hydra system activity. Aggregates cycle metrics, test growth, cost, backlog flow, and priority progress.

## Parameters

`$period`: `24h` (default), `12h`, `48h`, or `7d`.

## Process

### 1. Collect (parallel)

```bash
CYCLE_COUNT=50  # tune to period

hydra metrics --count $CYCLE_COUNT
hydra scheduler status
hydra backlog ls
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue

cd ~/hydra-betting && git log --oneline --since="24 hours ago"
cd ~/hydra && git log --oneline --since="24 hours ago"

hydra alerts ls --limit 20

docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:prior-failures
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:reframe-queue

gh issue list --repo gaberoo322/hydra --state all --json number,title,state,closedAt,createdAt \
  --jq '[.[] | select(.createdAt > "'$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)'" or .closedAt > "'$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)'")] | length'
```

### 2. Compute

For each cycle in period:
- merged = `tasksMerged > 0`
- failed = `tasksFailed > 0`
- empty = title starts with "Planner produced no task" or "Skipped:"
- rolled_back = `rolledBack == true`
- cost = `costUsd`
- test_delta = `testsAfter - testsBefore`
- anchor_type, source

Aggregate: total_cycles, merged_count, failed_count, empty_count, rollback_count, merge_rate, total_cost, cost_per_merge, test_growth, top_anchor_types. Split by source (Codex / Claude). Collect merged_titles for highlight reel.

### 3. Format

```
## Hydra Digest — <period> ending <date>

### Headline
<1-2 sentences: X merges, Y% rate, Z test growth, $W spent>

### Cycle Performance
| Metric | Value |
|--------|-------|
| Total cycles | N |
| Merged | N (X%) |
| Failed | N |
| Empty (no task) | N (X%) |
| Rolled back | N |
| Total cost | $X.XX |
| Cost per merge | $X.XX |

### By Source
| Source | Cycles | Merged | Rate |
|--------|--------|--------|------|
| Codex | N | N | X% |
| Claude Code | N | N | X% |

### Test Suite
| Metric | Value |
|--------|-------|
| Start of period | N tests |
| End of period | N tests |
| Net growth | +N |

### What Was Built (merged)
<bulleted list, recent first, max 15>

### What Failed
<bulleted list with reasons, max 5>

### Backlog Flow
| Lane | Count |
|------|-------|
| Work queue | N |
| Queued | N |
| In progress | N |
| Blocked | N |
| Triage | N |
| Prior failures | N |
| Reframe | N |

### Priority Progress
<Compare priorities.md tasks against merged work — which got closer to done?>

### Alerts & Issues
- Active alerts: N
- GitHub issues opened: N
- GitHub issues closed: N

### Operator Actions Needed
<accumulated items needing input — blocked, reframe, ready-for-human>
```

### 4. Output

Print to conversation. Don't write to files unless operator asks.

## Variants
- `/hydra-digest` — default 24h
- `/hydra-digest 12h` — mid-day check
- `/hydra-digest 7d` — weekly summary, more aggregated, includes trend lines
