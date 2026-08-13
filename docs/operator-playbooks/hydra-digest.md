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
# `hydra backlog ls` (Redis kanban) was retired by ADR-0031 (#3439, PR
# #3455) — `hydra backlog` is now a retired stub (issue #3745). Board flow
# is GitHub Issues on gaberoo322/hydra:
gh issue list --repo gaberoo322/hydra --state open --limit 200 \
  --json labels --jq '[.[] | .labels[].name] | group_by(.) | map({(.[0]): length}) | add'
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue

cd ~/hydra-betting && git log --oneline --since="24 hours ago"
cd ~/hydra && git log --oneline --since="24 hours ago"

hydra alerts ls --limit 20

docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:prior-failures
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:reframe-queue

gh issue list --repo gaberoo322/hydra --state all --json number,title,state,closedAt,createdAt \
  --jq '[.[] | select(.createdAt > "'$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)'" or .closedAt > "'$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)'")] | length'
```

#### Kill-chain observability (dead-code kill-chain epic #2720)

Three read-only signals surface the direct value of the dead-code kill-chain: the
wiring-ledger trend, the deadcode-baseline totals, and the **reframe-save count** —
each reframe-save is a grounding-preflight STOP that prevented a doomed build cycle,
so the count is the token-savings receipt this epic exists for. No new attribution
machinery: cross-class value attribution belongs to the Outcome Attribution Spine
(#2628). Every signal degrades to an explicit `n/a` line on missing input — a
stale/absent ledger must never blank the rest of the digest.

```bash
# (1) Wiring-ledger trend + soft SLO (Target's committed ledger + deadcode baseline).
# Read-only: parse the committed markdown/JSON, NEVER regenerate (regeneration is a
# Target-side `npm run deadcode:ledger` concern, not the digest's).
LEDGER="$HOME/hydra-betting/docs/agents/wiring-status.md"
BASELINE="$HOME/hydra-betting/web/deadcode-baseline.json"
python3 - "$LEDGER" "$BASELINE" <<'PY'
import sys, os, re, json, datetime
ledger_path, baseline_path = sys.argv[1], sys.argv[2]
GRACE_DAYS = 45          # wire-or-retire grace window (matches the Target ledger renderer)
SLO_DAYS   = 30          # soft SLO: days a module may sit wire-or-retire past grace w/o a verdict
today = datetime.date.today()

# Deadcode baseline totals (JSON produced by the Target's deadcode ratchet).
if os.path.exists(baseline_path):
    b = json.load(open(baseline_path))
    print("deadcode-baseline:",
          f"unusedExports={b.get('unusedExports','?')}",
          f"unreachableProductionFiles={b.get('unreachableProductionFiles','?')}",
          f"testOnlyModules={b.get('testOnlyModules','?')}",
          f"orphanModules={b.get('orphanModules','?')}")
else:
    print("deadcode-baseline: n/a (deadcode-baseline.json absent)")

# Wiring-ledger: count by status + oldest past-grace wire-or-retire age + soft-SLO breaches.
if not os.path.exists(ledger_path):
    print("wiring-ledger: n/a (wiring-status.md absent)")
    print(f"soft-SLO(>{SLO_DAYS}d wire-or-retire past grace, no verdict): n/a")
    sys.exit(0)

# Same strict row parse as scripts/ci/hydra-target-wire-or-retire-emit.ts::parseLedger.
rows = []
for line in open(ledger_path):
    m = re.match(r'^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$', line)
    if m:
        rows.append({"path": m.group(1).strip(), "status": m.group(2).strip(),
                     "lastTouched": m.group(4).strip()})
wor = [r for r in rows if r["status"] == "wire-or-retire"]
aw  = [r for r in rows if r["status"] == "awaiting-wiring"]
pp  = [r for r in rows if r["status"] == "protected-provider"]
print(f"wiring-ledger: {len(rows)} modules | "
      f"wire-or-retire={len(wor)} awaiting-wiring={len(aw)} protected-provider={len(pp)}")

def past_grace_days(last_touched):
    """Days a module has sat wire-or-retire = age-since-last-touch minus the 45-day grace.
    A blank/unparseable date yields None (age unknown — never flagged)."""
    try:
        d = datetime.date.fromisoformat(last_touched)
    except ValueError:
        return None
    return (today - d).days - GRACE_DAYS

ages = [(past_grace_days(r["lastTouched"]), r["path"]) for r in wor]
ages = [(a, p) for a, p in ages if a is not None]
if ages:
    oldest = max(ages)
    print(f"oldest wire-or-retire past-grace age: {oldest[0]}d ({oldest[1]})")
else:
    print("oldest wire-or-retire past-grace age: n/a")

# (2) Soft SLO — surfaced-only, NEVER CI-blocking (staleness must not punish an
# unrelated PR). A wire-or-retire module >30 days past grace still on the ledger is a
# stale-decision flag: the wire-or-retire triage verdict is overdue.
breaches = sorted(((a, p) for a, p in ages if a > SLO_DAYS), reverse=True)
if breaches:
    print(f"soft-SLO BREACH: {len(breaches)} wire-or-retire module(s) >{SLO_DAYS}d past grace without a verdict:")
    for a, p in breaches[:5]:
        print(f"  {a}d past grace — {p}")
else:
    print(f"soft-SLO: clean (no wire-or-retire module >{SLO_DAYS}d past grace without a verdict)")
PY

# (3) Reframe-save count over the period — each is a prevented doomed build cycle.
# target:reframe-save events land on the hydra:notifications stream (POST /events/publish,
# src/api/events.ts). readRecent's `id` field is NOT a Redis stream ms-seq id — it is a
# randomUUID() (see #3937), so it can never be used to window by age. Window on the
# envelope's ISO `timestamp` field instead; an event with a missing/unparseable timestamp
# is EXCLUDED from the period count (fail closed), never counted by default (#3940).
SINCE_MS=$(( $(date -u -d '24 hours ago' +%s) * 1000 ))   # tune to $period
hydra raw GET '/events/notifications?count=500' 2>/dev/null | python3 -c "
import json, sys
from datetime import datetime
since_ms = int('$SINCE_MS')
try:
    events = json.load(sys.stdin)
except Exception:
    print('reframe-saves: n/a (notifications stream unreadable)'); sys.exit(0)
if not isinstance(events, list):
    print('reframe-saves: n/a (notifications stream unreadable)'); sys.exit(0)
saves = []
undateable = 0
for e in events:
    if e.get('type') != 'target:reframe-save':
        continue
    ts = e.get('timestamp')
    if not ts:
        undateable += 1
        continue  # missing timestamp — fail closed, excluded from the period count
    try:
        dt = datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
    except ValueError:
        undateable += 1
        continue  # unparseable timestamp — fail closed, excluded from the period count
    ms = int(dt.timestamp() * 1000)
    if ms >= since_ms:
        saves.append(e)
print(f'reframe-saves (period): {len(saves)} prevented doomed build cycle(s)')
if undateable:
    print(f'reframe-saves undateable (excluded): {undateable}')
for e in saves[:5]:
    p = e.get('payload', {})
    print(f\"  {p.get('anchorRef','?')} — {str(p.get('reason','?'))[:80]}\")
"
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

### Kill-chain (dead-code kill-chain #2720)
| Signal | Value |
|--------|-------|
| Reframe-saves (period) | N prevented build cycle(s) |
| Wire-or-retire ledger rows | N (oldest Xd past grace) |
| Deadcode baseline | unusedExports=N · unreachable=N · testOnly=N |
| Soft SLO (>30d wire-or-retire, no verdict) | clean / N breach(es) |
<Soft-SLO breaches are surfaced-only — never CI-blocking. Omit this section
entirely if the ledger and baseline are both absent (n/a on all rows).>

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
