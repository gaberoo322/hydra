# Hydra Orchestrator

Autonomous multi-agent development framework. Runs a control loop that grounds → plans → challenges → executes → verifies → merges code changes in ~/hydra-betting, using Codex CLI agents for planning and execution, hard verification (npm test, tsc), Redis for state, and OpenViking for knowledge search.

## Architecture

Two codex agent calls per cycle (three for high-risk): **planner** (frontier model), **executor** (codex model). The former skeptic agent is replaced by a deterministic preflight gate + nano-model review for high-risk tasks only. All runtime state in Redis; configs git-tracked in `~/hydra/config/`; agents query OpenViking for semantic knowledge context.

```
Control loop (src/control-loop.ts):
  1a. prepareWorkspace()      — git cleanup (gated on safety checks)
  1b. groundProject()         — npm test, tsc, git status (READ-ONLY)
  2.  selectAnchor()          — pick work: queue > failing-test > prior-failure > reframe > TODO > priorities
  3.  runPlannerAgent()        — propose 1 bounded task (scope-adaptive: quick-fix uses codex model)
  3.1 classifyComplexity()     — quick-fix / standard / complex based on scope
  3.2 validateTaskSchema()     — deterministic schema check (risk, scope, anchor, criteria)
  3.5 detectDrift()            — reject near-duplicates of recent work
  4.  preflightCheck()         — deterministic 4-point checklist (duplicate, scope, grounding, verification)
  4b. runHighRiskReview()      — nano-model safety review (HIGH-RISK TASKS ONLY)
  5.  runExecutorAgent()       — write code on feature branch
  6.  runVerification()        — npm test + tsc (NOT an agent)
  6.5 reconcilePlanVsActual()  — diff planned scope vs actual files changed
  7.  mergeToMain()            — git merge --no-ff + push
  8.  report + metrics         — reality report to Redis, metrics to Redis
  8.5 compoundLearnings()      — extract WHEN/CHECK/BECAUSE prevention rules

Circuit breaker: if same anchor is abandoned 3x consecutively, auto-escalate to reframe queue.
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
| backlog.mjs | ~280 | Redis-backed Kanban backlog. Lanes: Backlog→Queued→Blocked→InProgress→Done. |
| merge.mjs | 112 | Git merge + push. Never throws — returns result object. |
| prepare-workspace.mjs | 116 | Cleanup before grounding. Gated on shouldCleanWorkingTree(). |
| metrics.mjs | 197 | Cycle metrics in Redis. Drift detection. |
| research-loop.mjs | 510 | Multi-agent research (domain/technical/market researchers). |
| api.mjs | 529 | Express REST API on port 4000. |
| cleanup.mjs | 105 | Delete cycle-summaries >2d, keep 50 reality-reports. |
| specs.ts | ~230 | Persistent multi-cycle task decomposition. Redis-backed spec lifecycle. |

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

## Config (~/hydra/config/) — git-tracked

**Operator edits these (or uses dashboard):**
- `config/direction/priorities.md` — what Hydra should work on next
- `config/direction/goals.md` — high-level project goals
- `config/feedback/to-planner.md` — correct planner behavior
- `config/feedback/to-executor.md` — correct executor behavior  
- `config/feedback/to-skeptic.md` — correct skeptic behavior

**Agent personalities:**
- `config/agents/{planner,executor,skeptic,meta}.md` — system prompts loaded by codex-runner
- `config/research/` — research agent configs

**Runtime state (all in Redis):**
- Backlog — `hydra:backlog:*` (Redis sorted sets + hashes, stable IDs)
- Agent memory — `hydra:memory:{agent}:rules` (Redis lists, WHEN/CHECK/BECAUSE JSON)
- Reality reports — `hydra:reports:reality:*` (Redis keys, kept 50)
- Cycle summaries — `hydra:reports:summary:*` (Redis keys, 2-day TTL)
- Research reports — `hydra:reports:research:*` (Redis keys, kept 20)
- Proposals — `hydra:proposals:*` (Redis hashes)
- Specs — `hydra:specs:*` (Redis hashes, 30-day TTL) + `hydra:specs:index` (sorted set)

**Specs (multi-cycle task decomposition):**
- Created by research loop (complex opportunities) or operator (POST /specs)
- Each spec has a slug, title, rationale, and ordered task list
- `selectAnchor()` picks the next unchecked task from the oldest active spec (priority 2.5)
- On merge, the spec task is marked complete; when all tasks done, spec status → "completed"
- API: GET /specs, GET /specs/:slug, POST /specs, POST /specs/:slug/archive

**Dashboard:** React + Vite + Tailwind on port 3000 (`~/hydra/dashboard/`)
- `npm run dev` in dashboard/ for development
- Proxies API calls to orchestrator on port 4000
- WebSocket for real-time cycle events

**Knowledge:** OpenViking (port 1933) — agents query via `searchKnowledge()` in codex-runner.mjs
- `knowledge-indexer.mjs` watches config files and polls Redis for new reports to index

## Redis Keys

| Pattern | Purpose |
|---|---|
| `hydra:cycle:active` | Currently running cycle ID |
| `hydra:cycle:last` | Last completed cycle ID |
| `hydra:cycle:{id}` | Cycle hash (status, timestamps, counts) |
| `hydra:task:{id}` | Task hash (state, evidence, scope) |
| `hydra:anchors:work-queue` | Redis list — items to work on (LMOVE to processing) |
| `hydra:anchors:processing` | Redis list — items being processed (crash recovery) |
| `hydra:anchors:prior-failures` | Redis list — failed tasks for retry |
| `hydra:metrics:{id}` | Cycle metrics hash |
| `hydra:metrics:index` | Sorted set of cycle IDs by timestamp |
| `hydra:scheduler:state` | Persisted scheduler throttle state |
| `hydra:backlog:items` | Hash — backlog item data |
| `hydra:backlog:lane:{lane}` | Sorted set — items per Kanban lane |
| `hydra:memory:{agent}:rules` | List — WHEN/CHECK/BECAUSE prevention rules |
| `hydra:reports:reality:{id}` | String — reality report JSON |
| `hydra:reports:reality:index` | Sorted set — reality report IDs |
| `hydra:reports:summary:*` | String — cycle summary (2-day TTL) |
| `hydra:reports:research:*` | String — research report JSON |
| `hydra:proposals:{id}` | Hash — proposal data |
| `hydra:proposals:index` | Sorted set — proposal IDs |
| `hydra:scheduler:daily-spend` | Daily codex spend counter |

## Model Tiers

| Tier | Model | Used by | Cost (in/out per 1M) |
|---|---|---|---|
| frontier | gpt-5.4 | Planner (standard tasks) | $2.50 / $15.00 |
| codex | gpt-5.3-codex | Executor, Skeptic, Planner (quick-fix) | $1.75 / $14.00 |
| nano | gpt-5.4-nano | Meta agent, classification | $0.20 / $1.25 |

## Scope-Adaptive Planning

Tasks are classified post-planner based on `scopeBoundary.in` and `acceptanceCriteria`:
- **quick-fix** (≤2 files, ≤3 criteria, or failing-test/prior-failure anchor): skip all gates, use codex model for planner, compressed prompt
- **standard** (default): deterministic preflight check, no agent call
- **complex** (>5 files or >8 criteria): deterministic preflight + log warning
- **high-risk** (any complexity with `risk: high`): deterministic preflight + nano-model safety review

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
