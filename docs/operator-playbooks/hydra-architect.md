---
name: hydra-architect
description: Strategic architecture review of Hydra as an autonomous software building system. Evaluates the control loop, research pipeline, agent quality, autonomy level, and knowledge systems against the operator's vision, then produces ranked recommendations.
when_to_use: "When the user wants to assess Hydra's architecture, think about system improvements, evaluate the autonomous builder design, or asks 'how can we improve Hydra'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Agent(*) WebSearch(*) WebFetch(*)
arguments: [focus]
---

# Hydra Architect

Systems architect evaluating Hydra — not the betting app, **the machine itself**. Assess how well Hydra's architecture serves its meta-goal: autonomously building software grounded by research, with minimal operator intervention.

If `$focus` provided, weight analysis toward that dimension.

## Worktree Setup — read FIRST (issue #4174)

This skill is operator-invoked, so you start with cwd at `~/hydra` — the
**live deploy checkout** that `scripts/deploy.sh` refuses to deploy from when
it carries any uncommitted tracked change. Every read in Phases 1–4 below
(`vision.md`, `goals.md`, `priorities.md`, `CLAUDE.md`, the metrics/research/
backlog queries) is safe to run against `~/hydra` as-is — reads never dirty
the tree. Two things are NOT safe to run against `~/hydra` directly: the
`npm test` invocation in **Architecture Shape** below, and the report write in
**Phase 5**. A prior version of this playbook pointed both at `~/hydra`
directly; the resulting uncommitted report write blocked two consecutive
`deploy` jobs and left prod six commits behind with only a WARN-level alarm.

Before running **Architecture Shape** (or any earlier phase, if you prefer to
set this up up front), create and enter a throwaway worktree:

```bash
WT="/home/gabe/hydra/.claude/worktrees/architect-$(date +%s)"
git -C ~/hydra worktree add -b "docs/architecture-review-$(date +%Y-%m-%d)-$(date +%s)" "$WT" master
cd "$WT"
git rev-parse --git-dir   # must print .../.git/worktrees/... -- abort if it doesn't
```

From here on, `$WT` is your cwd for the rest of this run. **Architecture
Shape**'s `npm test` and **Phase 5**'s report write both resolve against
`$WT`, never `~/hydra/...`. Everything else (the absolute `~/hydra/...` reads
listed above) is untouched — reading the live checkout is fine, only writing
to it and running the test suite there are the problem.

## What Hydra Is

Autonomous development system: research → prioritize → plan → challenge → execute → verify → merge → learn. Vision in `~/hydra/config/direction/vision.md`. Architecture in `~/hydra/`.

## Phase 1: Collect Evidence (parallel)

### Cycle Performance (quantitative)
```bash
hydra metrics --count 50 | python3 -c "
import json,sys
from collections import Counter
d=json.load(sys.stdin)
trend=d.get('trend',d.get('metrics',[]))
if not trend: print('No metrics'); sys.exit()
merged=sum(1 for m in trend if int(m.get('tasksMerged',0))>0)
failed=sum(1 for m in trend if int(m.get('tasksFailed',0))>0)
abandoned=sum(1 for m in trend if int(m.get('tasksAbandoned',0))>0)
rolled=sum(1 for m in trend if m.get('rolledBack') in ['true',True])
durations=[int(m.get('totalDurationMs',0)) for m in trend if int(m.get('totalDurationMs',0))>0]
costs=[float(m.get('costUsd',0)) for m in trend if float(m.get('costUsd',0))>0]
tests_start=int(trend[-1].get('testsAfter',0))
tests_end=int(trend[0].get('testsAfter',0))
anchors=Counter(m.get('anchorType','unknown') for m in trend)
print(f'Cycles: {len(trend)} | Merged: {merged} | Failed: {failed} | Abandoned: {abandoned} | Rolled: {rolled}')
print(f'Merge rate: {100*merged//max(len(trend),1)}%')
if durations: print(f'Cycle: avg {sum(durations)//len(durations)//1000}s, median {sorted(durations)[len(durations)//2]//1000}s')
if costs: print(f'Cost: avg \${sum(costs)/len(costs):.2f}/cycle, total \${sum(costs):.2f}')
print(f'Tests: {tests_start} -> {tests_end} (delta: {tests_end-tests_start})')
print(f'Anchors: {dict(anchors)}')
titles=[m.get('taskTitle','') for m in trend]
repeats=[(t,c) for t,c in Counter(titles).items() if c>1 and t]
if repeats: print(f'Repeated tasks: {repeats}')
"
```

### Research → Build Pipeline
```bash
hydra research history | python3 -c "
import json,sys
d=json.load(sys.stdin)
if isinstance(d,list):
    total_opps=sum(r.get('opportunityCount',0) for r in d)
    total_queued=sum(r.get('autoQueued',0) for r in d)
    print(f'Research cycles: {len(d)} | Opportunities: {total_opps} | Auto-queued: {total_queued}')
    print(f'Conversion: {100*total_queued//max(total_opps,1)}%')
"
echo -n "Work queue depth: "
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null

# `hydra backlog ls` (Redis kanban lanes) was retired by ADR-0031 (#3439, PR
# #3455) — `/api/backlog` 404s and `hydra backlog` is a retired stub
# pointing at the replacement (issue #3745). Orchestrator work tracking is
# now GitHub Issues on gaberoo322/hydra:
gh issue list --repo gaberoo322/hydra --state open --limit 200 \
  --json labels --jq '[.[] | .labels[].name] | group_by(.) | map({(.[0]): length}) | add' 2>/dev/null
```

### Agent Quality
```bash
for agent in planner executor skeptic; do
  count=$(docker exec hydra-redis-1 redis-cli LLEN "hydra:memory:${agent}:rules" 2>/dev/null || echo 0)
  echo "${agent}: ${count} rules"
  [ "$count" -gt 0 ] && docker exec hydra-redis-1 redis-cli LRANGE "hydra:memory:${agent}:rules" 0 2 2>/dev/null | head -3
done
```

### Architecture Shape
```bash
echo "=== Orchestrator ==="; ls ~/hydra/src/*.ts ~/hydra/src/*.mjs 2>/dev/null | wc -l; npm test 2>&1 | tail -3  # runs against $WT (your worktree cwd), never ~/hydra directly -- see Worktree Setup above
echo "=== Target ==="; cd ~/hydra-betting/web && find src -name '*.ts' -o -name '*.tsx' | wc -l; npx vitest run 2>&1 | tail -3
echo "=== Config ==="; find ~/hydra/config -name '*.md' | wc -l
```

### Autonomy
```bash
hydra scheduler status | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'Scheduler: {\"running\" if d.get(\"running\") else \"stopped\"} | Cycles: {d.get(\"cyclesRun\",0)} | Errors: {d.get(\"consecutiveErrors\",0)}')
print(f'Daily spend: \${d.get(\"research\",{}).get(\"dailySpendUsd\",0):.2f}/\${d.get(\"research\",{}).get(\"dailyCostCapUsd\",50)}')
"
systemctl --user list-units --type=service --state=failed 2>/dev/null | grep hydra
cd ~/hydra-betting && git log --oneline --since="7 days ago" --author="$(git config user.name)" 2>/dev/null | wc -l
echo "operator commits/7d"; cd ~/hydra-betting && git log --oneline --since="7 days ago" | wc -l; echo "total commits/7d"
```

### Context files (parallel)
- `~/hydra/config/direction/vision.md`
- `~/hydra/config/direction/goals.md`
- `~/hydra/config/direction/priorities.md`
- `~/hydra/CLAUDE.md`
- `~/hydra-betting/CLAUDE.md`

## Phase 2: External Research

Search current best practices in autonomous software development:
1. Multi-agent dev systems (Devin, SWE-Agent, OpenHands, Aider) — loop architecture, what works
2. Research-grounded development — connecting research → code
3. Self-improving systems — memory/learning architectures
4. Verification beyond tests — property-based, formal methods, mutation, AI review
5. Cost optimization — model routing, caching, prompt compression, speculative execution

Surface specific techniques, not vague advice.

## Phase 3: Evaluate (8 dimensions, 1-10 each, with evidence)

1. **Control Loop Quality** — merge rate, ceremony overhead, efficiency
2. **Research → Action Pipeline** — conversion rate, repeated topics, idea death
3. **Grounding & Verification** — bug categories slipping through, rollback frequency
4. **Agent Quality** — planner novelty, preflight gate effectiveness (high-risk review catches for risk:high tasks), executor minimalism
5. **Autonomy Level** — operator intervention rate, recurring manual steps
6. **Knowledge & Learning** — memory rule usefulness, OV search quality
7. **Architecture Fitness** — bottlenecks, maintainability, simpler alternatives
8. **Cost Efficiency** — cost/merged feature, model routing, ROI of research vs build

Be honest — 10 = world-class, not "working".

## Phase 4: Recommend (3 tiers)

For each: **What / Why / Evidence / Risk / Dependency**.

- **Quick wins** (<1 day) — specific files, expected impact
- **Medium efforts** (1-5 days) — architectural changes with implementation sketch
- **Strategic shifts** (1-2 weeks) — fundamental, needs operator buy-in

## Phase 5: Write Report

Write `config/direction/architecture-review.md` **resolved against `$WT`**
(your worktree cwd from Worktree Setup above) — never the absolute
`~/hydra/config/direction/architecture-review.md` path. That absolute path IS
the live deploy checkout; an uncommitted write there is exactly the #4174
bug (it blocked `scripts/deploy.sh`'s dirty-tree guard for two consecutive
deploys):

```yaml
---
date: <today>
reviewer: claude-architect
focus: <focus area>
overall_score: <weighted avg>
---
```

Include: executive summary, scorecard, key findings, 3-tier recommendations, comparison to state of the art, next-review triggers.

Then commit it on the branch created in Worktree Setup and open a PR — never
leave the report as an uncommitted worktree edit:

```bash
cd "$WT"
git add config/direction/architecture-review.md
git commit -m "docs(direction): architecture review $(date +%Y-%m-%d)"
git push -u origin HEAD
gh pr create --title "docs(direction): architecture review $(date +%Y-%m-%d)" \
  --body-file /dev/stdin <<'EOF'
## What

Architecture review report -- scorecard, key findings, 3-tier recommendations.

## Files in scope

config/direction/architecture-review.md
EOF
```

Once the PR is open, clean up the worktree so it doesn't leak (`hydra-branch-prune`
will also reap it eventually, but tidy up now if convenient):

```bash
cd ~/hydra
git worktree remove --force "$WT" 2>/dev/null || true
```

## Board-filling relationship (issue #2554)

`hydra-architect` files **no GitHub issues** — by design. It is
operator-invoked and off the autopilot path, so it is NOT a member of the
`orch_backfill_idle` board-filling set. Keep recommendations specific (file
paths, expected impact) so that when the operator turns one into tracked work,
the board-filling skill that files it (`hydra-discover` /
`hydra-architecture-scan` / `hydra-research`) can dedup it against the existing
board.

## Output to operator (concise summary)

```
## Hydra Architect — <date>

### Overall: X/10

| Dimension | Score | Key Finding |
| ... | ... | ... |

### Top 3 Recommendations
1. ...
2. ...
3. ...

Full report (PR opened in Phase 5): <PR URL>
```
