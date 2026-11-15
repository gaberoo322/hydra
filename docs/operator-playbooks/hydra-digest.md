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

### 1. Collect

```bash
cd ~/hydra && npx tsx scripts/ops-collect.ts --collectors cycles,cost-by-class,scheduler,board,alerts,today,target-git,kill-chain,reframe-saves --window-hours 24 --count 50 2>/dev/null || echo "ops-collect unavailable"
git -C ~/hydra log --oneline --since="24 hours ago"
```

Set `--window-hours` and `--since` to `$period` (`7d` is 168 hours) and raise `--count` for a longer period. The first command prints one JSON document with a result per collector; field meanings: `npx tsx scripts/ops-collect.ts --help`. `ops-collect unavailable` means the CLI crashed: report it under Operator Actions Needed.

- A result with `ok: false` has no data: print `n/a (<code>: <reason>)` for the rows it feeds and keep going. One missing collector never blanks the rest of the digest.
- `target.resolved: false` is worth a line under Operator Actions Needed; the Target collectors are then `skipped`.
- The collector reads committed Target files and never regenerates the wiring ledger.

### 2. Compute

Every number comes from a collector field; the only arithmetic left is cost per merge (`cycles.totalCostUsd` over `cycles.merged`, `n/a` when the cost is null or `merged` is 0).

| Section | Read |
|---------|------|
| Headline, Cycle Performance | `cycles`: `cycles`, `merged`, `mergeRatePct`, `failed`, `totalCostUsd`, `anchors` |
| Per-class cost | `cost-by-class`: `source`, `classes` |
| Test Suite | `cycles`: `testsFirst`, `testsLast`, `testsDelta` |
| What Was Built | `today.merges`, `target-git.commitSample` (a capped sample; `commits` is the true count), the `git log` lines |
| What Failed | `cycles`: `failed`, `abandoned`, the non-merged entries of `recent`, `repeatedTasks` |
| Backlog Flow | `board.byLabel` (`board.truncated` makes every count a floor) |
| Kill-chain | `reframe-saves`: `count`, `undateable`; `kill-chain`: `verdict`, `ledger`, `baseline` |
| Alerts & Issues | `alerts.active`, `today.issuesOpened`, `today.issuesClosed` (when null, quote `issuesClosedNote`) |
| Operator Actions Needed | `board.samples` for the blocked and ready-for-human lanes; `scheduler` when `running` is false or `consecutiveErrors` is above 0 |

`cycles.coverage.classesNotRecorded` lists classes that write no cycle record: their absence from the counts is not a zero. `recent` holds only the newest few cycles: report failures beyond it as a count. `repeatedTasks` is retry context (titles seen more than once, merged or not), not a failure list. Give a failure reason only when the output carries one.

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
| Total cost | $X.XX |
| Cost per merge | $X.XX |

### Per-class cost (24h)
| Class | Tokens | Share | Quota weight |
|--------|--------|-------|--------------|
| dev-orch | N | X% | N |
| qa | N | X% | N |
| interactive | N | X% | N |
| research | N | X% | N |
| cleanup | N | X% | N |
<Render from `classes`, which arrives sorted by tokens. Include the `interactive`
row only when non-zero. With `source` reading `transcript-24h`, `Share` is a true
fraction of real burn across every session. If `source` reads `dispatch-surrogate`,
coverage is partial: do NOT rank classes on it. `Quota weight` is 0 when the
per-family weight is uncalibrated; read the table as a raw-token ranking then.>

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
| `needs-triage` | N |
| `ready-for-agent` | N |
| `in-progress` | N |
| `blocked` | N |
| `needs-qa` | N |

### Kill-chain
| Signal | Value |
|--------|-------|
| Reframe-saves (period) | N prevented build cycle(s) |
| Wire-or-retire ledger rows | N (oldest Xd past grace) |
| Deadcode baseline | unusedExports=N · unreachable=N · testOnly=N |
| Soft SLO (>30d wire-or-retire, no verdict) | clean / N breach(es) |
<Soft-SLO breaches (`kill-chain.verdict` reading `FLAG`) are surfaced-only — never
CI-blocking. Omit this section entirely when `kill-chain` is skipped.>

### Priority Progress
<Compare priorities.md tasks against merged work — which got closer to done?>

### Alerts & Issues
- Active alerts: N
- GitHub issues opened: N
- GitHub issues closed: N

### Operator Actions Needed
<accumulated items needing input — blocked, ready-for-human>
```

### 4. Output

Print to conversation. Don't write to files unless operator asks.

## Variants
- `/hydra-digest` — default 24h
- `/hydra-digest 12h` — mid-day check
- `/hydra-digest 7d` — weekly summary, more aggregated, includes trend lines
