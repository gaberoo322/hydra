# Hydra Orchestrator

Autonomous software-building framework. The orchestrator is a control plane for **Claude Code subagents** (`hydra-dev` for orchestrator work, `hydra-target-build` for target-project work) dispatched in parallel by **`hydra-autopilot`**. State lives in Redis; configs are git-tracked under `~/hydra/config/`; agents query OpenViking for semantic knowledge. Hard verification (npm test, tsc, build) is deterministic, never an agent claim.

> **Codex CLI was retired on 2026-05-14.** The in-process planner/executor/skeptic/fixer/meta agents and the `@openai/codex-sdk` dependency are gone. All code-writing work flows through Claude Code subagents under autopilot. See [ADR-0006](./docs/adr/0006-codex-cli-removed-autopilot-only.md) and [`docs/codex-removal-measurement.md`](./docs/codex-removal-measurement.md) for the cut-over record.

## Documentation Map

Read these first when working on the orchestrator:

- [`README.md`](./README.md) — system overview, dashboard/API surface, design principles
- [`CONTEXT.md`](./CONTEXT.md) — **canonical glossary**. Use these terms exactly (Target, Orchestrator, Untouchable Core, Pre-merge Gate, Modification Tier, Outcome Holdback, Operator-Required Intervention)
- [`docs/adr/`](./docs/adr/) — architectural decision records:
  - ADR-0001 — Untouchable Core & gate extraction (protected paths, operator-only)
  - ADR-0002 — Single target per orchestrator instance
  - ADR-0003 — Terminal goal hierarchy (Target Outcomes + 25% self-improvement floor)
  - ADR-0004 — Self-modification tiers (Tier 0/1/2/3 + Outcome Holdback)
  - ADR-0005 — Operator escalation is narrow (closed list)
  - ADR-0006 — Codex CLI fully removed; autopilot is the only execution path
  - ADR-0010 — Stuckness detector retired; self-improvement floor is operator-curated
- [`docs/codex-removal-measurement.md`](./docs/codex-removal-measurement.md) — the original Phase A/B/C measurement plan and the cut-over outcome
- [`config/direction/vision.md`](./config/direction/vision.md) — **target product** vision (what hydra-betting should become)
- [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) — **orchestrator-self** vision (what good autonomous building looks like)
- [`config/direction/outcomes.yaml`](./config/direction/outcomes.yaml) — structured Target Outcome metrics
- [`docs/operator-playbooks/hydra-autopilot.md`](./docs/operator-playbooks/hydra-autopilot.md) — the autopilot class taxonomy + dispatch contract

## Architecture

`hydra-autopilot` is a long-running decision loop. A single Claude Code session dispatches background subagents in parallel — one per **class** — subject to per-class cooldowns and a global token budget. The orchestrator HTTP service (port 4000) is now the **data plane** for these subagents: it serves the dashboard, backlog, metrics, health probes, event bus, and Redis-backed work queues. It no longer runs a self-driving control loop.

```
autopilot tick:
  1. health probe          — /api/health, /api/health/services
  2. budget check          — daily token spend, per-class cooldowns
  3. pick eligible classes — see taxonomy below
  4. dispatch in parallel  — one BG subagent per class (Agent tool, worktree isolation)
  5. collect lessons       — subagent-capture hook funnels lessons into Redis/feedback files
  6. sleep                 — until next tick or class cooldown expires

class taxonomy (docs/operator-playbooks/hydra-autopilot.md):
  health           — hydra-doctor                 (read-only health check)
  qa               — hydra-qa                     (review target PRs)
  dev_orch         — hydra-dev                    (orchestrator feature work, worktree-isolated)
  dev_target       — hydra-target-build           (target feature work, worktree-isolated)
  research_orch    — hydra-research, hydra-issue-research
  research_target  — hydra-target-research
  sweep_orch       — hydra-sweep                  (orchestrator board hygiene)
  sweep_target     — hydra-target-sweep           (target board hygiene)
  discover_orch    — hydra-discover               (patrol; produces issues)
  discover_target  — hydra-target-discover        (runtime diagnostics on the target)
```

Each code-writing class (`dev_orch`, `dev_target`) runs inside a fresh `git worktree` and opens a PR. CI is the merge gate: `npm test`, `npm run typecheck`, `dashboard && npm run build`, mutation kill-rate, scope-enforcement, and the tier classifier are all enforced on the PR, not inside a cycle.

The orchestrator service still owns:
- Redis state (backlog, work queue, reality reports, agent memory, reflections, holdback)
- Event bus (`hydra:*` Redis streams) and notifications
- Scheduler (research-floor enforcement, daily-spend tally, cycle metrics aggregation)
- Knowledge plane (OpenViking indexing, search)
- Dashboard + REST API
- Merge-gate facade (`src/gate.ts`), tier classifier, and Tier-2 outcome holdback

## Key Files

See `docs/reference.md` for the file inventory, Redis keys, event bus streams, and API endpoints.

## Running

```bash
# Service (production)
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -f

# Development
npx tsx src/index.ts       # direct run (check port 4000 first!)
npm test                    # 1200+ regression tests (node:test, zero deps)

# Health
curl http://localhost:4000/api/health
curl http://localhost:4000/api/scheduler/status
curl "http://localhost:4000/api/cycle/history?limit=5"
```

## CI/CD & Deployment

**All changes to master must go through a PR.** Branch protection enforces CI passing before merge.

**CI** (`.github/workflows/ci.yml`) runs on every PR:
- `npm run typecheck` + `npm test` (orchestrator)
- `cd dashboard && npm run build` (dashboard build check)
- `tier-gate` (blocks Tier-0 paths without `operator-approved` label)
- Mutation kill-rate + scope-enforcement quality gates (re-homed from the in-cycle loop; see [`docs/quality-gates.md`](./docs/quality-gates.md))

**Deploy** runs automatically on merge to master via a self-hosted GitHub Actions runner on this server:
1. `git pull --ff-only origin master`
2. `npm ci` (orchestrator deps)
3. `bash scripts/sync-skills.sh` (regenerate `~/.claude/skills/` + `~/.codex/skills/` from playbooks — fails fast on non-zero exit to avoid half-synced deploys; introduced in issue #433 after the 2026-05-15 silent-wedge incident)
4. `cd dashboard && npm ci && npm run build` (dashboard static assets)
5. `systemctl --user restart hydra-orchestrator.service`
6. Health check: `curl http://localhost:4000/api/health`

**Operator setup (one-time):** run `bash scripts/setup-git-hooks.sh` to install an opt-in `post-merge` git hook that re-runs `scripts/sync-skills.sh` whenever a `git pull` brings in changes to `docs/operator-playbooks/*.md`. Uninstall with `bash scripts/setup-git-hooks.sh --remove`.

Manual deploy (emergency): `./scripts/deploy.sh`

**Never deploy by manually restarting the service without building the dashboard first.** The Express server serves `dashboard/dist/` — stale builds mean stale UI.

**Claude Code / Hydra agents:** Always push changes on a feature branch and open a PR. Never push directly to master.

## Testing

Tests are regression tests — each corresponds to a real bug. Located in `test/*.test.mts`. Run with `npm test`. Zero external dependencies (uses `node:test`).

Always run `npm test` before committing.

## Config (~/hydra/config/) — git-tracked

**Operator edits these (or uses dashboard):**
- `config/direction/vision.md` — **target product** vision (prose; what hydra-betting should become)
- `config/direction/outcomes.yaml` — structured Target Outcome metrics (see ADR-0003)
- `config/orchestrator/vision.md` — **orchestrator-self** vision (trade-offs the orchestrator makes when ambiguous)
- `config/direction/priorities.md` — what Hydra should work on next. Refreshed by the operator-scheduled `/hydra-target-research` skill.
- `config/direction/goals.md` — high-level project goals
- `config/research/` — research agent configs (director, domain/technical/market researchers, strategist)

The legacy in-process agent personalities (`config/agents/{planner,executor,skeptic,meta}.md`) and operator feedback files (`config/feedback/to-{planner,executor,skeptic}.md`) were retired with the codex cut-over and moved to `docs/historical/agent-personalities/` for posterity. The autopilot subagents (hydra-dev, hydra-target-build, etc.) carry their own personalities under `~/.claude/skills/` rather than in this repo's config. The `~/.codex/config.toml` exporter setup is no longer needed and can be removed from operator machines.

**Runtime state (all in Redis):**
- Backlog — `hydra:backlog:*` (Redis sorted sets + hashes, stable IDs)
- Agent memory — `hydra:memory:{agent}:patterns` (Redis strings, consolidated JSON patterns)
- Reality reports — `hydra:reports:reality:*` (Redis keys, kept 50)
- Cycle summaries — `hydra:reports:summary:*` (Redis keys, 2-day TTL)
- Research reports — `hydra:reports:research:*` (Redis keys, kept 20)
- Proposals — `hydra:proposals:*` (Redis hashes)
- Lessons (subagent capture) — `hydra:lessons:*` (per-agent rolling JSON; promotes into operator-facing lesson files at 3 hits — `PROMOTION_THRESHOLD` in `src/learning/agent-memory.ts`)
- Friction patterns (issue #512) — `hydra:friction:{skill}:patterns` (per-skill soft-friction items; threshold-crosses auto-open a `meta-friction` GitHub issue)

> **Specs retired (issue #513).** The Specs subsystem (auto-decompose, `/api/specs`, the active-spec anchor tier, the spec capacity-floor, and the `spec-starvation` instrumentation) was deleted. It was already dead in production — the in-process control loop that produced and consumed specs was removed in PR #383, and the autopilot's child-dispatch model superseded multi-cycle task decomposition. Residual `hydra:specs:*` keys are no longer read or written; run `bash scripts/cleanup/retire-specs.sh` to drop them.

**Dashboard:** React + Vite + Tailwind served from port 4000 (`~/hydra/dashboard/`)
- `npm run dev` in dashboard/ for development
- API calls at /api/* paths
- WebSocket for real-time events

**Knowledge:** OpenViking (port 1933) — agents query via the OV HTTP API
- `knowledge-indexer.ts` watches config files and polls Redis for new reports to index
- `ov-session.ts` manages per-cycle sessions: logs subagent interactions, commits for memory extraction
- `ov-skills.ts` registers subagent capabilities (hydra-dev, hydra-target-build, hydra-research, etc.) on startup

## Learning System

**OpenViking-primary, Redis-fallback.** Three tiers:

1. **OpenViking (primary):** Each autopilot tick or subagent dispatch creates an OV session (`ov-session.ts`). Subagent interactions are logged as session messages. At session close, `ovSession.commit()` triggers automatic memory extraction — OV analyzes the full conversation and stores learned patterns as searchable embeddings. Subagents query `getAgentContext()` and `searchKnowledge()` for relevant past experience.

2. **Redis patterns (fallback):** Consolidated patterns in `hydra:memory:{agent}:patterns` with hit counts. Similar incidents merge into one pattern. When a pattern reaches `PROMOTION_THRESHOLD` (3) occurrences, it auto-promotes to a durable lesson file (e.g. `~/.claude/skills/<skill>/lessons.md`) as a cardinal rule, AND a `meta-friction` GitHub issue is opened so chronic problems become tracked work (issue #512). Stale one-offs are pruned after 14 days.

   **Cue taxonomy (issue #524).** Two QA cues are split because they describe different things:
   - `acceptance-criterion-unmet` — the diff didn't satisfy the criterion (true defect). Default threshold (3): auto-promotes to `to-planner.md` and escalates to a GitHub issue.
   - `acceptance-criterion-deferred` — the criterion can only be verified post-deploy / at runtime / by an operator (metadata, not a defect). Escalation threshold is 20+ and the cue does NOT write a rule to `to-planner.md`. The per-cue table lives in `src/learning/escalation.ts::CUE_ESCALATION_THRESHOLDS`. Existing pre-split entries can be migrated with `bash scripts/cleanup/reclassify-deferred-acs.sh --apply`.

3. **Episodic reflections:** When a subagent fails, a structured reflection (what was attempted, why it failed, what should change) is stored in `hydra:reflections:{ref}` with 7-day TTL. When the same anchor/issue is retried, reflections are injected as subagent context.

## Model Tiers

The orchestrator no longer routes per-call models — model selection is the harness's job. Claude Code dispatches subagents on whichever model the operator's subscription chooses. For accounting/limits visibility:

| Tier | Model (Claude Code) | Typical use |
|---|---|---|
| frontier | claude-opus-4-7 (1M context) | hydra-dev, hydra-target-build, hydra-research, hydra-architect — deep multi-file edits and design work |
| balanced | claude-sonnet-4-6 | hydra-sweep, hydra-target-sweep, hydra-qa, hydra-doctor — board/health work with structured outputs |
| fast | claude-haiku-4-5 | hydra-discover, hydra-target-discover, lesson-capture hooks, classification — small/fast/cheap calls |

Daily spend tracking still flows through `hydra:scheduler:daily-spend` (renamed semantics — it now tracks Claude Code token usage where the harness exposes it, or stays at 0 when the harness owns billing).

## Coding Conventions

- **TypeScript** (.ts, import/export). Source in `src/`, tests in `test/*.test.mts`.
- **Runtime dependencies are operator-approved only** (ADR-0005). Today: `express`, `ioredis`, `ws`, `@sentry/node` for error tracking, plus `zod` for typed-schema parsing at boundaries (approved 2026-05-24 in #562; seed PR pending — `src/schemas/`). Use Node.js stdlib for everything else. (`@openai/codex-sdk` was removed in PR-3 of the cut-over.)
- **Never throw from merge/grounding/verification** — return result objects so callers decide how to report failures.
- **Fail loud**: every `catch` must either log `console.error` with context or be annotated `/* intentional: reason */`. Silent catches caused every major incident in the 2026-04-07/08 debug session.
- **Kanban updates go through `safeKanban()`** — logs errors AND publishes events. Never call moveToInProgress/moveToDone/returnToBacklog directly without error handling.
- **Redis access through redis-adapter.ts or src/redis/*** — new code should use adapter methods instead of creating `new Redis()` connections or importing redis-keys.ts directly. After the issue #269 split, `redis-adapter.ts` is a thin re-export shim; new call sites may import directly from the domain modules under `src/redis/` (connection, plan-cache, cycle-metrics, reality-reports, backlog, proposals, agent-memory, reflections, utility, alerts, adversarial, calibration, cycle-tracking, research-reports, health-anchor, work-queue, scheduler, kv).
- **API routes in sub-routers** — `src/api.ts` is a thin mount point. Route handlers live in `src/api/{domain}.ts`. Each sub-router is a factory function receiving `eventBus` if needed.
- **grounding.ts is read-only** — workspace mutation lives in prepare-workspace.ts.
- **eventBus scope**: `eventBus` is a parameter of `runControlLoop()` / route factories, not a module global. Helpers that need it must receive it as a parameter.

## Self-Modification: Untouchable Core & Tiers

The tier system classifies every PR by blast radius, regardless of which agent proposed it (see [ADR-0004](./docs/adr/0004-self-modification-tiers.md)):

| Tier | Scope | Who merges | Notes |
|------|-------|-----------|-------|
| 0 — Untouchable | Merge gate, rollback, watchdog, cost guardrails, the protected-paths list itself | **Operator only** | Enforced via CI; PR needs `operator-approved` label |
| 1 — Prompt-shaped | Subagent lesson files, prompt-only tweaks under `~/.claude/skills/` | Auto-merge | |
| 2 — Skill / verification additions | New tests, new verification steps, scoring tweaks, dashboard, `src/anchor-selection.ts` | Auto-merge with **Outcome Holdback** | 5-cycle watch + auto-revert on Target Outcome regression |
| 3 — Everything else in `src/` | Control-loop changes, gate logic, infra | Operator merges | |

Protected paths live in `src/untouchable.ts` (see [ADR-0001](./docs/adr/0001-untouchable-core-and-gate-extraction.md)). Before proposing or applying a change to anything that smells load-bearing — merge, rollback, scope enforcement, mutation gate, cost caps — check the untouchable list first. **Never bypass the gate.**

Operator escalation is reserved for the **closed list** in [ADR-0005](./docs/adr/0005-operator-escalation-is-narrow.md): credentials/secrets, external-account actions, Tier-0 changes, vision-level conflicts. Everything else, Hydra researches and tries autonomously.

## Common Pitfalls

- **Port 4000 conflict**: If you run `npx tsx src/index.ts` manually while the service is running, the port guard will abort. Always check `lsof -ti:4000` first.
- **Stale process**: The systemd service may hold port 4000 after a crash. `systemctl --user restart hydra-orchestrator.service` is the safe restart.
- **Kanban title matching**: Use `anchor.reference` (not `task.title`) when calling backlog.ts functions. Subagents generate titles that don't always match Kanban rows.
- **Test environment**: Tests use `node:test` with no mocking framework. Grounding tests mock `execFileAsync` by testing pure functions (parseTestCounts, shouldCleanWorkingTree) instead of running real git commands.
- **Worktree isolation**: Every code-writing subagent dispatch (`hydra-dev`, `hydra-target-build`) MUST run inside a fresh `git worktree`. The harness aborts if cwd is the main repo working tree (`/home/gabe/hydra` or `/home/gabe/hydra-betting`). See `feedback_bg_agent_worktree_hygiene` in operator memory and the PR #245 incident.

## Watchdog

`hydra-orchestrator-watchdog.timer` runs every 2 minutes. Checks:
1. `/health` responds with `status: "ok"` and `redis: true`
2. Scheduler `lastTickAt` not stale (>15 min with no cycle in progress) — post-#397, this is the heartbeat surface, not `lastCycleAt`
3. Skips if a cycle is actively running
4. **Respects deliberate operator stops (issue #388).** `POST /scheduler/stop` writes a `stopReason: "deliberate"` flag (persisted in Redis as `hydra:scheduler:deliberate-stop` with a 24h TTL so it survives a service bounce). When the watchdog sees this flag it leaves the scheduler stopped — the historical failure mode was the watchdog ticking the scheduler back on within ~2 minutes of every operator stop. Auto-pause reasons (`circuit-breaker`, `error-cap`) do NOT set this flag, so the watchdog can still recover from genuine self-stops. `POST /scheduler/start` clears the flag explicitly. The flag also self-clears after 24h to keep a forgotten stop from permanently disabling the watchdog.

Script source of truth: `scripts/hydra-orchestrator-watchdog.sh` (deployed to `~/.local/bin/hydra-orchestrator-watchdog.sh`).


## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on gaberoo322/hydra via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, target-backlog). `target-backlog` is for findings about the target project (~/hydra-betting) — sweep queues these to Hydra's work queue via `POST /api/queue` and closes the issue. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.
