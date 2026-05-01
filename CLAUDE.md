# Hydra Orchestrator

Autonomous multi-agent development framework. Runs a control loop that grounds → plans → challenges → executes → verifies → merges code changes in ~/hydra-betting, using Codex CLI agents for planning and execution, hard verification (npm test, tsc), Redis for state, and OpenViking for knowledge search.

## Architecture

Two codex agent calls per cycle (three for high-risk, four if fixer runs): **planner** (frontier model), **executor** (codex model). The former skeptic agent is replaced by a deterministic preflight gate + nano-model review for high-risk tasks only. All runtime state in Redis; configs git-tracked in `~/hydra/config/`; agents query OpenViking for semantic knowledge context. Event bus (Redis Streams) connects all subsystems; knowledge indexer keeps OpenViking in sync with config files and Redis reports.

```
Control loop (src/control-loop.ts):
  1a. prepareWorkspace()       — git cleanup (gated on safety checks)
  1b. groundProject()          — npm test, tsc, git status (READ-ONLY)
  1.5 loadContinuity()         — last cycle report + repo diff since last commit
  2.  selectAnchor()           — pick work (see Anchor Selection Priority below)
  2.5 isAnchorStale()          — skip completed/blocked items before planner
  3.  runPlannerAgent()         — propose 1 bounded task (scope-adaptive: quick-fix uses codex model)
  3.1 classifyComplexity()      — quick-fix / standard / complex based on scope
  3.5 detectDrift()             — reject near-duplicates of recent work
  4.  preflightCheck()          — deterministic 4-point checklist (duplicate, scope, grounding, verification)
  4b. runHighRiskReview()       — nano-model safety review (HIGH-RISK TASKS ONLY)
  5.  runExecutorAgent()        — write code in isolated worktree on feature branch
  6.  runVerification()         — npm test + tsc + npm run build (NOT an agent)
  6.5 runFixerAgent()           — if verification failed, one-shot fixer attempt + re-verify
  6.5 reconcilePlanVsActual()   — diff planned scope vs actual files changed
  6.7 runMutationTests()        — kill rate quality gate (<30% blocks merge for non-quick-fix)
  6.8 jitTestGeneration()       — diff-aware test generation for surviving mutants (kill rate <80%)
  6.9 scopeEnforcement()        — hard gate: >80% out-of-scope files blocks merge
  7.  mergeToMain()             — acquire merge lock, git merge --no-ff + push
  8.  report + metrics          — reality report to Redis, metrics to Redis, auto-rollback if regression
  8.1 detectPatterns()          — systemic issue detection across recent cycles
  8.2 markUsed()                — tell OV which resources were used (relevance weighting)
  8.5 ovSession.commit()        — OV session commit triggers automatic memory extraction
  8.7 adversarialValidation()   — nano-model self-play: find edge cases, queue fix tasks

Circuit breaker: if same anchor is abandoned 3x consecutively, auto-escalate to reframe queue.
Merge lock: short-lived Redis lock (60s TTL) serializes merges across Codex and Claude Code.
```

## Anchor Selection Priority

Determined by `selectAnchor()` in `src/anchor-selection.ts`. Priority order:

1. **Explicit operator request** — passed via `opts.anchor`
2. **Kanban queued lane** — atomic claim (Lua script), gated by WIP limit
3. **Active specs** — next unchecked task from oldest active spec
4. **Failing tests** — from grounding report
5. **Typecheck errors** — from grounding report
6. **Work queue** — items from POST /queue or research auto-queue (LMOVE to processing)
7. **Reframe queue** — tasks that failed repeatedly, need diagnosis
8. **Prior failures** — stored in Redis, capped at 2 retries before escalation
9. **TODO/FIXME markers** — from codebase
10. **Regression hunt** — every 10 merges, adversarial testing of recent features
11. **Codebase health** — reductive improvements (split, consolidate, document)
12. **Priorities doc** — fallback to `config/direction/priorities.md` (auto-refreshed if stale)

## Key Files

| File | Lines | Role |
|---|---|---|
| src/control-loop.ts | 1583 | The loop. Orchestrates all steps above. |
| src/api.ts | 1620 | Express REST API on port 4000. Dashboard served from /api. |
| src/research-loop.ts | 831 | Multi-agent research (domain/technical/market researchers + strategist). |
| src/backlog.ts | 644 | Redis-backed Kanban backlog. Lanes: Triage→Backlog→Queued→Blocked→InProgress→Done. |
| src/agent-memory.ts | 634 | Two-tier pattern learning: Redis patterns + auto-promote to feedback files. Episodic reflections. |
| src/scheduler.ts | 618 | 5-min cycle timer, research throttle, daily spend cap. |
| src/task-tracker.ts | 566 | 9-state task machine + Redis state. Fan-in: 7 modules. |
| src/anchor-selection.ts | 493 | Anchor priority chain + circuit breaker + prior failure escalation. |
| src/proposals.ts | 491 | Meta agent proposals. Approval/rejection workflow. |
| src/planner-prompt.ts | 477 | Planner prompt assembly, schema validation, plan cache, OV context. |
| src/priorities-refresh.ts | 426 | Inline refresh of priorities.md when stale. |
| src/codex-runner.ts | 408 | Spawns `codex exec` with personalities. Model routing. |
| src/preflight.ts | 374 | Deterministic 4-point preflight gate + nano-model high-risk review. |
| src/grounding.ts | 370 | Read-only repo inspection. Runs npm test, tsc, git. |
| src/index.ts | 324 | Entry point. Boots EventBus, API, scheduler, consumers, WebSocket. |
| src/adversarial-validation.ts | 310 | Post-merge self-play: nano-model adversary finds edge cases. |
| src/mutation-testing.ts | 295 | Zero-dep mutation testing. Negate booleans, swap comparisons, remove returns. |
| src/digest.ts | 291 | Telegram digest: batches events, sends periodic summaries. |
| src/specs.ts | 275 | Persistent multi-cycle task decomposition. Redis-backed spec lifecycle. |
| src/ov-session.ts | 272 | OpenViking session manager. Per-cycle conversation tracking + memory extraction. |
| src/verifier.ts | 266 | Hard verification. Runs command plans, captures output. |
| src/event-bus.ts | 242 | Redis Streams event bus. Publish/subscribe + consumer groups + DLQ + WebSocket broadcast. |
| src/codebase-analyzer.ts | 238 | Analyzes target project structure for research context. |
| src/pattern-detector.ts | 220 | Detects systemic patterns across recent cycles. Publishes alerts. |
| src/metrics.ts | 219 | Cycle metrics in Redis. Drift detection. Aggregate stats. |
| src/codebase-health.ts | 218 | Identifies reductive improvement opportunities (large files, low coverage). |
| src/project-goals.ts | 216 | Loads and formats project goals for agent prompts. |
| src/notify.ts | 213 | Notification routing (Telegram). |
| src/knowledge-indexer.ts | 208 | Watches config files + polls Redis. Indexes into OpenViking. |
| src/plan-cache.ts | 184 | LRU plan cache to avoid re-planning identical anchors. |
| src/cleanup.ts | 167 | Delete cycle-summaries >2d, keep 50 reality-reports, requeue stale in-progress. |
| src/ov-skills.ts | 156 | Registers agent skills (planner, executor, skeptic, director) with OpenViking. |
| src/merge.ts | 138 | Git merge + push. Never throws — returns result object. |
| src/cycle.ts | 134 | Cycle lifecycle: start, status, history, kill. |
| src/prepare-workspace.ts | 132 | Cleanup before grounding. Gated on shouldCleanWorkingTree(). |

## Running

```bash
# Service (production)
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -f

# Development
npx tsx src/index.ts       # direct run (check port 4000 first!)
npm test                    # 71 regression tests (node:test, zero deps)

# Health
curl http://localhost:4000/api/health
curl http://localhost:4000/api/scheduler/status
curl http://localhost:4000/api/cycle/status
curl "http://localhost:4000/api/cycle/history?limit=5"
```

## Testing

Tests are regression tests -- each corresponds to a real bug. Located in `test/*.test.mts`. Run with `npm test`. Zero external dependencies (uses `node:test`).

Always run `npm test` before committing.

## Config (~/hydra/config/) -- git-tracked

**Operator edits these (or uses dashboard):**
- `config/direction/priorities.md` -- what Hydra should work on next
- `config/direction/goals.md` -- high-level project goals
- `config/direction/vision.md` -- operator vision (short intent document)
- `config/feedback/to-planner.md` -- correct planner behavior
- `config/feedback/to-executor.md` -- correct executor behavior
- `config/feedback/to-skeptic.md` -- correct skeptic behavior

**Agent personalities:**
- `config/agents/{planner,executor,skeptic,meta}.md` -- system prompts loaded by codex-runner
- `config/research/` -- research agent configs (director, domain/technical/market researchers, strategist)

**Runtime state (all in Redis):**
- Backlog -- `hydra:backlog:*` (Redis sorted sets + hashes, stable IDs)
- Agent memory -- `hydra:memory:{agent}:patterns` (Redis strings, consolidated JSON patterns)
- Reality reports -- `hydra:reports:reality:*` (Redis keys, kept 50)
- Cycle summaries -- `hydra:reports:summary:*` (Redis keys, 2-day TTL)
- Research reports -- `hydra:reports:research:*` (Redis keys, kept 20)
- Proposals -- `hydra:proposals:*` (Redis hashes)
- Specs -- `hydra:specs:*` (Redis hashes, 30-day TTL) + `hydra:specs:index` (sorted set)

**Specs (multi-cycle task decomposition):**
- Created by research loop (complex opportunities) or operator (POST /api/specs)
- Each spec has a slug, title, rationale, and ordered task list
- `selectAnchor()` picks the next unchecked task from the oldest active spec (priority 3)
- On merge, the spec task is marked complete; when all tasks done, spec status -> "completed"
- API: GET /api/specs, GET /api/specs/:slug, POST /api/specs, POST /api/specs/:slug/archive

**Dashboard:** React + Vite + Tailwind served from port 4000 (`~/hydra/dashboard/`)
- `npm run dev` in dashboard/ for development
- API calls at /api/* paths
- WebSocket for real-time cycle events

**Knowledge:** OpenViking (port 1933) -- agents query via `searchKnowledge()` in codex-runner.ts
- `knowledge-indexer.ts` watches config files and polls Redis for new reports to index
- `ov-session.ts` manages per-cycle sessions: logs agent interactions, commits for memory extraction
- `ov-skills.ts` registers agent capabilities (planner, executor, skeptic, director) on startup

## Learning System

**OpenViking-primary, Redis-fallback.** Two tiers:

1. **OpenViking (primary):** Each cycle creates an OV session (`ov-session.ts`). Agent interactions (planner, skeptic, executor, verification) are logged as session messages. At cycle end, `ovSession.commit()` triggers automatic memory extraction -- OV analyzes the full conversation and stores learned patterns as searchable embeddings. Agents query `getAgentContext()` and `searchKnowledge()` for relevant past experience.

2. **Redis patterns (fallback):** Consolidated patterns in `hydra:memory:{agent}:patterns` with hit counts. Similar incidents merge into one pattern. When a pattern reaches 5 occurrences, it auto-promotes to the feedback file (`config/feedback/to-{agent}.md`) as a durable cardinal rule. Stale one-offs are pruned after 14 days.

3. **Episodic reflections:** When a cycle fails, a structured reflection (what was attempted, why it failed, what should change) is stored in `hydra:reflections:{anchor}` with 7-day TTL. When the same anchor is retried, reflections are injected as planner context.

## Redis Keys

| Pattern | Purpose |
|---|---|
| `hydra:cycle:active` | Currently running cycle ID |
| `hydra:cycle:active:{source}` | Per-source cycle registration (codex, claude). 15-min TTL. |
| `hydra:cycle:last` | Last completed cycle ID |
| `hydra:cycle:{id}` | Cycle hash (status, timestamps, counts) |
| `hydra:cycle:{id}:agents` | Agent runs for this cycle |
| `hydra:cycle:{id}:costs` | Token costs for this cycle |
| `hydra:task:{id}` | Task hash (state, evidence, scope) |
| `hydra:task:{id}:evidence:{state}` | Evidence chain per state transition |
| `hydra:anchors:work-queue` | Redis list -- items to work on (LMOVE to processing) |
| `hydra:anchors:processing` | Redis list -- items being processed (crash recovery) |
| `hydra:anchors:prior-failures` | Redis list -- failed tasks for retry |
| `hydra:anchors:reframe-queue` | Redis list -- tasks needing diagnosis after repeated failure |
| `hydra:anchors:abandonment-count:{ref}` | Counter per anchor, 24h TTL. Circuit breaker at 3. |
| `hydra:merge:lock` | Short-lived merge serialization lock (60s TTL) |
| `hydra:metrics:{id}` | Cycle metrics hash |
| `hydra:metrics:index` | Sorted set of cycle IDs by timestamp |
| `hydra:scheduler:state` | Persisted scheduler throttle state |
| `hydra:scheduler:daily-spend` | Daily codex spend counter |
| `hydra:backlog:items` | Hash -- backlog item data |
| `hydra:backlog:lane:{lane}` | Sorted set -- items per Kanban lane |
| `hydra:backlog:counter` | Monotonic ID counter for backlog items |
| `hydra:memory:{agent}:patterns` | String -- consolidated JSON patterns (15-slot rolling buffer) |
| `hydra:memory:last-consolidation` | Timestamp of last memory consolidation |
| `hydra:reflections:{ref}` | List -- episodic failure reflections (7-day TTL) |
| `hydra:reports:reality:{id}` | String -- reality report JSON |
| `hydra:reports:reality:index` | Sorted set -- reality report IDs |
| `hydra:reports:summary:*` | String -- cycle summary (2-day TTL) |
| `hydra:reports:research:*` | String -- research report JSON |
| `hydra:reports:research:index` | Sorted set -- research report IDs |
| `hydra:proposals:{id}` | Hash -- proposal data |
| `hydra:proposals:index` | Sorted set -- proposal IDs |
| `hydra:specs:*` | Hash -- spec data (30-day TTL) |
| `hydra:specs:index` | Sorted set -- spec IDs |
| `hydra:plans:cache:{hash}` | Cached plan results (LRU) |
| `hydra:alerts` | List -- dashboard alerts (kept 100) |
| `hydra:adversarial:stats` | Adversarial validation statistics |
| `hydra:adversarial:tracking` | Merge tracking for revert correlation |
| `hydra:regression-hunt:last` | Timestamp of last regression hunt (3-day cooldown) |
| `hydra:pattern-detector:cooldowns` | Pattern detector alert cooldowns |
| `hydra:blocked:last-escalation` | Timestamp of last blocked-item escalation |
| `hydra:deps:completed` | Completed dependency tracking |
| `hydra:deps:index` | Dependency index |
| `hydra:digest:last-weekly` | Timestamp of last weekly digest |
| `hydra:workspace:lock` | Workspace access lock |

## Event Bus

Redis Streams-based event bus (`src/event-bus.ts`). Streams:

| Stream | Purpose |
|---|---|
| `hydra:cycle` | Cycle start events |
| `hydra:tasks` | Task events (legacy) |
| `hydra:meta` | Meta analysis triggers |
| `hydra:proposals` | Proposal lifecycle events |
| `hydra:notifications` | All notifications (consumed by Telegram digest) |
| `hydra:dlq` | Dead letter queue (after 3 failed deliveries) |

Consumer groups: meta, orchestrator, telegram, dlq-processor. WebSocket broadcast to connected dashboard clients.

## Model Tiers

| Tier | Model | Used by | Cost (in/out per 1M) |
|---|---|---|---|
| frontier | gpt-5.4 | Planner (standard tasks) | $2.50 / $15.00 |
| codex | gpt-5.3-codex | Executor, Fixer, JIT tester, Planner (quick-fix) | $1.75 / $14.00 |
| nano | gpt-5.4-nano | Meta agent, classification, adversarial validation, high-risk review | $0.20 / $1.25 |

## Scope-Adaptive Planning

Tasks are classified post-planner based on `scopeBoundary.in` and `acceptanceCriteria`:
- **quick-fix** (<=2 files, <=3 criteria, or failing-test/prior-failure anchor): skip all gates, use codex model for planner, compressed prompt
- **standard** (default): deterministic preflight check, no agent call
- **complex** (>5 files or >8 criteria): deterministic preflight + log warning
- **high-risk** (any complexity with `risk: high`): deterministic preflight + nano-model safety review

## Coding Conventions

- **TypeScript** (.ts, import/export). Source in `src/`, tests in `test/*.test.mts`.
- **Three dependencies**: express, ioredis, ws. Plus @sentry/node for error tracking. Use Node.js stdlib for everything else.
- **Never throw from merge/grounding/verification** -- return result objects so callers decide how to report failures.
- **Fail loud**: every `catch` must either log `console.error` with context or be annotated `/* intentional: reason */`. Silent catches caused every major incident in the 2026-04-07/08 debug session.
- **Kanban updates go through `safeKanban()`** -- logs errors AND publishes events. Never call moveToInProgress/moveToDone/returnToBacklog directly without error handling.
- **grounding.ts is read-only** -- workspace mutation lives in prepare-workspace.ts.
- **eventBus scope**: `eventBus` is a parameter of `runControlLoop()`, not a module global. Helper functions that need it must receive it as a parameter.

## Common Pitfalls

- **Port 4000 conflict**: If you run `npx tsx src/index.ts` manually while the service is running, the port guard will abort. Always check `lsof -ti:4000` first.
- **Stale process**: The systemd service may hold port 4000 after a crash. `systemctl --user restart hydra-orchestrator.service` is the safe restart.
- **Kanban title matching**: Use `anchor.reference` (not `task.title`) when calling backlog.ts functions. The planner generates titles that don't match Kanban rows.
- **Test environment**: Tests use `node:test` with no mocking framework. Grounding tests mock `execFileAsync` by testing pure functions (parseTestCounts, shouldCleanWorkingTree) instead of running real git commands.
- **Merge lock contention**: Both Codex and Claude Code cycles acquire `hydra:merge:lock` (60s TTL) before merging. If a merge hangs, the lock auto-expires. Manual release: `redis-cli DEL hydra:merge:lock`.

## Watchdog

`hydra-orchestrator-watchdog.timer` runs every 2 minutes. Checks:
1. `/health` responds with `status: "ok"` and `redis: true`
2. Scheduler `lastCycleAt` not stale (>15 min with no cycle in progress)
3. Skips if a cycle is actively running

Script: `~/.local/bin/hydra-orchestrator-watchdog.sh`

## API Endpoints (port 4000, all under /api)

**Cycles**: POST /cycle/start, GET /cycle/status, GET /cycle/history, GET /cycle/report, POST /cycle/register, POST /cycle/complete
**Tasks**: GET /tasks, GET /tasks/:id, GET /tasks/:id/evidence
**Queue**: POST /queue `{reference, reason, context}`, GET /queue
**Grounding**: GET /grounding/latest
**Scheduler**: POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
**Research**: POST /research/start, GET /research/latest, GET /research/history, POST /research/veto
**Backlog**: GET /backlog, GET /backlog/counts, POST /backlog, POST /backlog/enhance, PATCH /backlog/:id, PATCH /backlog/:id/move, POST /backlog/:id/approve, GET /backlog/:id/children, DELETE /backlog/:id, POST /backlog/claim
**Specs**: GET /specs, GET /specs/:slug, POST /specs, POST /specs/:slug/archive
**Proposals**: GET /proposals, POST /proposals/:id/approve, POST /proposals/:id/reject
**Meta**: POST /meta/analyze
**Metrics**: GET /metrics, GET /spending, GET /summary
**Goals**: GET /goals, GET /goals/summary
**Config**: GET /config/:section, GET /config/:section/:name, PUT /config/:section/:name
**Alerts**: GET /alerts, POST /alerts/:id/dismiss, POST /alerts/dismiss-all
**Events**: GET /events/:stream, POST /events/publish
**Memory**: GET /memory/:agent, POST /memory/:agent/pattern
**Merge**: POST /merge/lock, POST /merge/unlock
**Metrics (write)**: POST /metrics/record
**Plan Cache**: GET /plan-cache/stats, POST /plan-cache/invalidate
**Digest**: POST /digest/send
**Health**: GET /health, GET /health/services, GET /health/deep, GET /recommendations
**OpenViking**: GET /openviking/search
**Calibration**: GET /calibration/outcomes, POST /calibration/outcomes/sync
**Env**: GET /env/:project, PUT /env/:project, DELETE /env/:project/:key
**OpenAI Proxy**: /openai-proxy/* (bearer token auth)
**Webhooks**: POST /webhooks/sentry
**Control**: POST /kill

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on gaberoo322/hydra via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
