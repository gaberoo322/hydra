# Hydra Orchestrator

Autonomous multi-agent development framework. Runs a control loop that grounds → plans → challenges → executes → verifies → merges code changes in ~/hydra-betting, using Codex CLI agents for planning and execution, hard verification (npm test, tsc), Redis for state, and OpenViking for knowledge search.

## Documentation Map

Read these first when working on the orchestrator:

- [`README.md`](./README.md) — system overview, dashboard/API surface, design principles
- [`CONTEXT.md`](./CONTEXT.md) — **canonical glossary**. Use these terms exactly (Target, Orchestrator, Untouchable Core, Gate, Stuckness, Modification Tier, Outcome Holdback, Operator-Required Intervention)
- [`docs/adr/`](./docs/adr/) — architectural decision records:
  - ADR-0001 — Untouchable Core & gate extraction (protected paths, operator-only)
  - ADR-0002 — Single target per orchestrator instance
  - ADR-0003 — Terminal goal hierarchy (Target Outcomes + 25% self-improvement floor)
  - ADR-0004 — Self-modification tiers (Tier 0/1/2/3 + Outcome Holdback)
  - ADR-0005 — Operator escalation is narrow (closed list)
- [`config/direction/vision.md`](./config/direction/vision.md) — **target product** vision (what hydra-betting should become)
- [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) — **orchestrator-self** vision (what good autonomous building looks like)
- [`config/direction/outcomes.yaml`](./config/direction/outcomes.yaml) — structured Target Outcome metrics that drive Stuckness detection

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
2. **Stuckness-driven research** — when `getAllStuckness()` reports a fired Target Outcome, build a `research` anchor (`outcome-stuckness:<name>`, `domain: orchestrator-self-improvement`) instead of pulling backlog. Enforces ADR-0003 vision vector 1. 5-cycle cooldown per outcome.
3. **Spec capacity-floor pre-emption** — every Nth eligible cycle (default N=3, `HYDRA_SPEC_CAPACITY_FLOOR_N`), if a spec task exists AND `cyclesSinceSpecLastServed >= N`, the spec tier pre-empts kanban *and* stuckness. Prevents the active-specs lane from being indefinitely shadowed (issue #301). Instrumented at `/api/metrics/spec-starvation`.
4. **Kanban queued lane** — atomic claim (Lua script), gated by WIP limit
5. **Active specs** — next unchecked task from oldest active spec (also reachable below kanban when the capacity-floor has not fired)
6. **Failing tests** — from grounding report
7. **Typecheck errors** — from grounding report
8. **Work queue** — items from POST /queue or research auto-queue (LMOVE to processing)
9. **Reframe queue** — tasks that failed repeatedly, need diagnosis
10. **Prior failures** — stored in Redis, capped at 2 retries before escalation
11. **TODO/FIXME markers** — from codebase
12. **Regression hunt** — every 10 merges, adversarial testing of recent features
13. **Codebase health** — reductive improvements (split, consolidate, document)
14. **Priorities doc** — fallback to `config/direction/priorities.md` (auto-refreshed if stale)

### Scheduler-level capacity floors (cross-cutting, not part of `selectAnchor`)

These floors are evaluated by `src/scheduler.ts` (the tick loop), not by `selectAnchor()`. They decide whether the scheduler *enqueues a research cycle* alongside the normal build pipeline — they don't choose between build anchors.

- **Research capacity floor** — `RESEARCH_BUILD_RATIO_MIN` (default 1/20, env `HYDRA_RESEARCH_BUILD_RATIO_MIN`). Symmetric to `RESEARCH_BUILD_RATIO_MAX`. When the rolling 24h research:build ratio drops below the floor AND `HYDRA_RESEARCH_MIN_INTERVAL_MS` has elapsed AND the daily cost cap (`HYDRA_DAILY_COST_CAP_USD`) is not exhausted, the scheduler forces a research cycle even if queue depth would normally suppress it. Prevents the target-direction (research-driven) lane from being indefinitely shadowed by user-request anchors (issue #327). Surfaced on `/api/scheduler/status` as `research.buildRatioMin` and `research.researchFloorTriggered` (per-tick boolean). The floor never overrides the daily cost cap.

## Key Files

See `docs/reference.md` for full file inventory, Redis keys, event bus streams, and API endpoints.

## Running

```bash
# Service (production)
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -f

# Development
npx tsx src/index.ts       # direct run (check port 4000 first!)
npm test                    # 1035+ regression tests (node:test, zero deps)

# Health
curl http://localhost:4000/api/health
curl http://localhost:4000/api/scheduler/status
curl http://localhost:4000/api/cycle/status
curl "http://localhost:4000/api/cycle/history?limit=5"
```

## CI/CD & Deployment

**All changes to master must go through a PR.** Branch protection enforces CI passing before merge.

**CI** (`.github/workflows/ci.yml`) runs on every PR:
- `npm run typecheck` + `npm test` (orchestrator)
- `cd dashboard && npm run build` (dashboard build check)

**Deploy** runs automatically on merge to master via a self-hosted GitHub Actions runner on this server:
1. `git pull --ff-only origin master`
2. `npm ci` (orchestrator deps)
3. `cd dashboard && npm ci && npm run build` (dashboard static assets)
4. `systemctl --user restart hydra-orchestrator.service`
5. Health check: `curl http://localhost:4000/api/health`

Manual deploy (emergency): `./scripts/deploy.sh`

**Never deploy by manually restarting the service without building the dashboard first.** The Express server serves `dashboard/dist/` — stale builds mean stale UI.

**Claude Code / Hydra agents:** Always push changes on a feature branch and open a PR. Never push directly to master.

## Testing

Tests are regression tests -- each corresponds to a real bug. Located in `test/*.test.mts`. Run with `npm test`. Zero external dependencies (uses `node:test`).

Always run `npm test` before committing.

## Config (~/hydra/config/) -- git-tracked

**Operator edits these (or uses dashboard):**
- `config/direction/vision.md` -- **target product** vision (prose; what hydra-betting should become)
- `config/direction/outcomes.yaml` -- structured Target Outcome metrics (drives Stuckness; see ADR-0003)
- `config/orchestrator/vision.md` -- **orchestrator-self** vision (trade-offs the orchestrator makes when ambiguous)
- `config/direction/priorities.md` -- what Hydra should work on next (auto-refreshed from vision + system state)
- `config/direction/goals.md` -- high-level project goals
- `config/feedback/to-planner.md` -- correct planner behavior
- `config/feedback/to-executor.md` -- correct executor behavior
- `config/feedback/to-skeptic.md` -- correct high-risk-review behavior (file is named "skeptic" for legacy reasons; loaded only on high-risk tasks via `agentName: "skeptic"` in `src/preflight.ts`)

**Agent personalities:**
- `config/agents/{planner,executor,meta}.md` -- system prompts loaded by codex-runner
- `config/agents/skeptic.md` -- still loaded as the personality for the **high-risk review** path (mini-model safety review); the low/medium-risk skeptic agent was replaced by the deterministic preflight gate
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


## Model Tiers

| Tier | Model | Used by | Cost (in/out per 1M) |
|---|---|---|---|
| frontier | gpt-5.4 | Planner (standard tasks) | $2.50 / $15.00 |
| codex | gpt-5.3-codex | Executor, Fixer, JIT tester, Planner (quick-fix) | $1.75 / $14.00 |
| mini | gpt-5.4-mini | Meta agent, classification, adversarial validation, high-risk review | $0.75 / $4.50 |

## Codex Telemetry (OTel)

Codex CLI emits OTel traces natively. Hydra correlates them with cycles by injecting per-call resource attributes (`hydra.cycle_id`, `hydra.agent_role`, `hydra.task_id`, `hydra.model_tier`, `hydra.complexity`) into the spawned CLI process when `HYDRA_OTEL_ENABLED=true`. See `docs/reference.md` for the full env-var contract and `~/.codex/config.toml` exporter setup. Disabled by default — opt in once a backend (SigNoz / Tempo / Jaeger) is ready.

## Scope-Adaptive Planning

Tasks are classified post-planner based on `scopeBoundary.in` and `acceptanceCriteria`:
- **quick-fix** (<=2 files, <=3 criteria, or failing-test/codebase-health anchor): skip all gates, use codex model for planner, compressed prompt
- **standard** (default): deterministic preflight check, no agent call
- **complex** (>5 files or >8 criteria): deterministic preflight + log warning
- **high-risk** (any complexity with `risk: high`): deterministic preflight + nano-model safety review

## Coding Conventions

- **TypeScript** (.ts, import/export). Source in `src/`, tests in `test/*.test.mts`.
- **Four dependencies**: express, ioredis, ws, @openai/codex-sdk. Plus @sentry/node for error tracking. Use Node.js stdlib for everything else.
- **Never throw from merge/grounding/verification** -- return result objects so callers decide how to report failures.
- **Fail loud**: every `catch` must either log `console.error` with context or be annotated `/* intentional: reason */`. Silent catches caused every major incident in the 2026-04-07/08 debug session.
- **Kanban updates go through `safeKanban()`** -- logs errors AND publishes events. Never call moveToInProgress/moveToDone/returnToBacklog directly without error handling.
- **Redis access through redis-adapter.ts or src/redis/*** -- new code should use adapter methods instead of creating `new Redis()` connections or importing redis-keys.ts directly. After the issue #269 split, `redis-adapter.ts` is a thin re-export shim; new call sites may import directly from the domain modules under `src/redis/` (connection, plan-cache, cycle-metrics, reality-reports, backlog, proposals, agent-memory, reflections, utility, alerts, adversarial, calibration, cycle-tracking, research-reports, health-anchor, work-queue, scheduler, kv). Migration in progress; some modules still have legacy direct access.
- **API routes in sub-routers** -- `src/api.ts` is a thin mount point. Route handlers live in `src/api/{domain}.ts`. Each sub-router is a factory function receiving `eventBus` if needed.
- **grounding.ts is read-only** -- workspace mutation lives in prepare-workspace.ts.
- **eventBus scope**: `eventBus` is a parameter of `runControlLoop()`, not a module global. Helper functions that need it must receive it as a parameter.

## Self-Modification: Untouchable Core & Tiers

The orchestrator classifies its own PRs by blast radius (see [ADR-0004](./docs/adr/0004-self-modification-tiers.md)):

| Tier | Scope | Who merges | Notes |
|------|-------|-----------|-------|
| 0 — Untouchable | Merge gate, rollback, watchdog, cost guardrails, the protected-paths list itself | **Operator only** | Enforced via CI; PR needs `operator-approved` label |
| 1 — Prompt-shaped | `config/agents/*`, `config/feedback/*` | Auto-merge | |
| 2 — Skill / verification additions | New tests, new verification steps, scoring tweaks | Auto-merge with **Outcome Holdback** | 5-cycle watch + auto-revert on Target Outcome regression |
| 3 — Everything else in `src/` | Control-loop changes, agent logic, infra | Operator merges | |

Protected paths live in `src/untouchable.ts` (see [ADR-0001](./docs/adr/0001-untouchable-core-and-gate-extraction.md)). Before proposing or applying a change to anything that smells load-bearing — merge, rollback, scope enforcement, mutation gate, cost caps — check the untouchable list first. **Never bypass the gate.**

Operator escalation is reserved for the **closed list** in [ADR-0005](./docs/adr/0005-operator-escalation-is-narrow.md): credentials/secrets, external-account actions, Tier-0 changes, vision-level conflicts. Everything else, Hydra researches and tries autonomously.

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


## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on gaberoo322/hydra via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, target-backlog). `target-backlog` is for findings about the target project (~/hydra-betting) — sweep queues these to Hydra's work queue via `POST /api/queue` and closes the issue. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
