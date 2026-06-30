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

hydra backlog ls | python3 -c "
import json,sys
d=json.load(sys.stdin)
for lane in ['queued','inProgress','blocked','triage','done']: print(f'  {lane}: {len(d.get(lane,[]))}')
"
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
echo "=== Orchestrator ==="; ls ~/hydra/src/*.ts ~/hydra/src/*.mjs 2>/dev/null | wc -l; cd ~/hydra && npm test 2>&1 | tail -3
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

`~/hydra/config/direction/architecture-review.md`:

```yaml
---
date: <today>
reviewer: claude-architect
focus: <focus area>
overall_score: <weighted avg>
---
```

Include: executive summary, scorecard, key findings, 3-tier recommendations, comparison to state of the art, next-review triggers.

## How the scorecard feeds downstream (issue #2554)

`hydra-architect` files **no GitHub issues** — by design. Its product is the
ranked scorecard + 3-tier recommendations written to
`config/direction/architecture-review.md`. That file is the seam into the
board-filling skills:

- **`hydra-research` consumes it** in Phase 1 (it loads
  `architecture-review.md` as context) and again in Phase 3b scoring, where the
  architect's lowest-scoring dimensions and "Quick wins / Medium efforts"
  recommendations weight which research findings to file. The architect names
  *where the architecture is weak*; research turns the weak spots into
  ready-for-agent issues.
- **`hydra-discover` compares against its baselines** (Tier 3 §3b reads
  `architecture-review.md` for the coupling/size baselines).

So the scorecard is not orphaned: it is the strategic prior that biases the
two issue-producing skills, kept as a standalone report (not auto-filed issues)
so the operator reviews direction before research mass-produces work from it.
Keep recommendations specific (file paths, expected impact) so research can map
them onto findings without re-deriving the analysis.

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

Full report: ~/hydra/config/direction/architecture-review.md
```
