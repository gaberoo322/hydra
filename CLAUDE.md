# Hydra Orchestrator

Autonomous multi-agent development framework. Runs a control loop that grounds → plans → challenges → executes → verifies → merges code changes in ~/hydra-betting, using Codex CLI agents for planning and execution, hard verification (npm test, tsc), and Obsidian vault for state.

## Architecture

Three codex agent calls per cycle: **planner** (frontier model), **skeptic** (codex model, skipped for quick-fix/research tasks), **executor** (codex model). Everything else is command execution or file I/O.

```
Control loop (src/control-loop.mjs):
  1a. prepareWorkspace()    — git cleanup (gated on safety checks)
  1b. groundProject()       — npm test, tsc, git status (READ-ONLY)
  2.  selectAnchor()        — pick work: queue > failing-test > prior-failure > TODO > priorities doc
  3.  runPlannerAgent()      — propose 1 bounded task (scope-adaptive: quick-fix uses codex model)
  3.1 classifyComplexity()   — quick-fix / standard / complex based on scope
  3.5 detectDrift()          — reject near-duplicates of recent work
  4.  runSkepticAgent()      — challenge task (skipped for quick-fix + research)
  5.  runExecutorAgent()     — write code on feature branch
  6.  runVerification()      — npm test + tsc (NOT an agent)
  6.5 reconcilePlanVsActual() — diff planned scope vs actual files changed
  7.  mergeToMain()          — git merge --no-ff + push (extracted to merge.mjs)
  8.  report + metrics       — reality report to vault, metrics to Redis
  8.5 compoundLearnings()    — extract WHEN/CHECK/BECAUSE prevention rules
```

## Key Files

| File | Lines | Role |
|---|---|---|
| control-loop.mjs | 1300 | The loop. Orchestrates all steps above. |
| task-tracker.mjs | 544 | 9-state task machine + Redis state. Fan-in: 7 modules. |
| codex-runner.mjs | 338 | Spawns `codex exec` with personalities. Model routing. |
| scheduler.mjs | 509 | 5-min cycle timer, research throttle, daily spend cap. |
| grounding.mjs | 370 | Read-only repo inspection. Runs npm test, tsc, git. |
| verifier.mjs | 266 | Hard verification. Runs command plans, captures output. |
| agent-memory.mjs | 325 | WHEN/CHECK/BECAUSE prevention rules (Sage pattern). |
| backlog.mjs | 331 | Obsidian Kanban backlog. Lanes: Backlog→Queued→Blocked→InProgress→Done. |
| merge.mjs | 112 | Git merge + push. Never throws — returns result object. |
| prepare-workspace.mjs | 116 | Cleanup before grounding. Gated on shouldCleanWorkingTree(). |
| metrics.mjs | 197 | Cycle metrics in Redis. Drift detection. |
| research-loop.mjs | 510 | Multi-agent research (domain/technical/market researchers). |
| api.mjs | 529 | Express REST API on port 4000. |
| cleanup.mjs | 105 | Delete cycle-summaries >2d, keep 50 reality-reports. |

## Running

```bash
# Service (production)
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -f

# Development
node src/index.mjs          # direct run (check port 4000 first!)
npm test                     # 42 regression tests (node:test, zero deps)
node --check src/*.mjs       # syntax check all files

# Health
curl http://localhost:4000/health
curl http://localhost:4000/scheduler/status
curl http://localhost:4000/cycle/status
curl "http://localhost:4000/cycle/history?limit=5"
```

## Testing

Tests are regression tests — each corresponds to a real bug. Located in `test/*.test.mjs`. Run with `npm test`. Zero external dependencies (uses `node:test`).

Always run `node --check src/<file>.mjs` after editing and `npm test` before committing.

## Obsidian Vault (~/obsidian-vault/hydra/)

**Operator edits these:**
- `direction/priorities.md` — what Hydra should work on next
- `direction/goals.md` — high-level project goals
- `agent-feedback/to-planner.md` — correct planner behavior
- `agent-feedback/to-executor.md` — correct executor behavior  
- `agent-feedback/to-skeptic.md` — correct skeptic behavior
- `backlog.md` — Kanban board (drag items between lanes in Obsidian)

**Auto-generated (don't edit):**
- `agent-memory/` — WHEN/CHECK/BECAUSE prevention rules from cycle outcomes
- `reports/reality-reports/` — cycle outcome JSON (control loop reads latest for continuity)
- `reports/cycle-summaries/` — raw agent outputs (auto-deleted after 2 days)
- `reports/research/` — research findings

**Agent personalities:**
- `agent-config/{planner,executor,skeptic,meta}.md` — system prompts loaded by codex-runner
- `research-methodology/` — research agent configs

## Redis Keys

| Pattern | Purpose |
|---|---|
| `hydra:cycle:active` | Currently running cycle ID |
| `hydra:cycle:last` | Last completed cycle ID |
| `hydra:cycle:{id}` | Cycle hash (status, timestamps, counts) |
| `hydra:task:{id}` | Task hash (state, evidence, scope) |
| `hydra:anchors:work-queue` | Redis list — items to work on (LPOP) |
| `hydra:anchors:prior-failures` | Redis list — failed tasks for retry |
| `hydra:metrics:{id}` | Cycle metrics hash |
| `hydra:metrics:index` | Sorted set of cycle IDs by timestamp |
| `hydra:scheduler:state` | Persisted scheduler throttle state |
| `hydra:scheduler:daily-spend` | Daily codex spend counter |

## Model Tiers

| Tier | Model | Used by | Cost (in/out per 1M) |
|---|---|---|---|
| frontier | gpt-5.4 | Planner (standard tasks) | $2.50 / $15.00 |
| codex | gpt-5.3-codex | Executor, Skeptic, Planner (quick-fix) | $1.75 / $14.00 |
| nano | gpt-5.4-nano | Meta agent, classification | $0.20 / $1.25 |

## Scope-Adaptive Planning

Tasks are classified post-planner based on `scopeBoundary.in` and `acceptanceCriteria`:
- **quick-fix** (≤2 files, ≤3 criteria, or failing-test/prior-failure anchor): skip skeptic, use codex model for planner, compressed prompt
- **standard** (default): full ceremony
- **complex** (>5 files or >8 criteria): log warning, proceed

## Coding Conventions

- **ESM only** (.mjs, import/export). No CommonJS.
- **Two dependencies**: express + ioredis. No others. Use Node.js stdlib for everything else.
- **Never throw from merge/grounding/verification** — return result objects so callers decide how to report failures.
- **Fail loud**: every `catch` must either log `console.error` with context or be annotated `/* intentional: reason */`. Silent catches caused every major incident in the 2026-04-07/08 debug session.
- **Kanban updates go through `safeKanban()`** — logs errors AND publishes events. Never call moveToInProgress/moveToDone/returnToBacklog directly without error handling.
- **Agent memory uses WHEN/CHECK/BECAUSE format** — only record failures and surprises, not "merged successfully" noise.
- **grounding.mjs is read-only** — workspace mutation lives in prepare-workspace.mjs.

## Common Pitfalls

- **Port 4000 conflict**: If you run `node src/index.mjs` manually while the service is running, the port guard will abort. Always check `lsof -ti:4000` first.
- **Stale process**: The systemd service may hold port 4000 after a crash. `systemctl --user restart hydra-orchestrator.service` is the safe restart.
- **eventBus scope**: `eventBus` is a parameter of `runControlLoop()`, not a module global. Helper functions that need it must receive it as a parameter.
- **Kanban title matching**: Use `anchor.reference` (not `task.title`) when calling backlog.mjs functions. The planner generates titles that don't match Kanban rows.
- **Test environment**: Tests use `node:test` with no mocking framework. Grounding tests mock `execFileAsync` by testing pure functions (parseTestCounts, shouldCleanWorkingTree) instead of running real git commands.

## Watchdog

`hydra-orchestrator-watchdog.timer` runs every 2 minutes. Checks:
1. `/health` responds with `status: "ok"` and `redis: true`
2. Scheduler `lastCycleAt` not stale (>15 min with no cycle in progress)
3. Skips if a cycle is actively running

Script: `~/.local/bin/hydra-orchestrator-watchdog.sh`

## API Endpoints (port 4000)

**Cycles**: POST /cycle/start, GET /cycle/status, GET /cycle/history, GET /cycle/report
**Tasks**: GET /tasks, GET /tasks/:id, GET /tasks/:id/evidence
**Queue**: POST /queue `{reference, reason, source}`, GET /queue
**Grounding**: GET /grounding/latest
**Scheduler**: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
**Research**: POST /research/start, GET /research/latest, GET /research/history
**Backlog**: GET /backlog
**Metrics**: GET /metrics, GET /spending
**Control**: POST /kill, GET /health
