# Hydra

Hydra is an autonomous software development orchestrator. It runs continuous development cycles against a target codebase — grounding itself in real project state, selecting work, planning a bounded task, gating with a deterministic preflight + nano-model safety review, executing the change, verifying with hard checks (tests, typecheck, build, mutation kill-rate, scope enforcement), and merging to main. Every cycle produces a structured reality report backed by evidence in Redis. Hydra steers itself via two vision documents (target product + orchestrator-self) and improves its own architecture gradually within safety bounds.

Hydra uses [Codex CLI](https://github.com/openai/codex) as its agent runtime. Two codex agent calls per cycle (planner + executor), one more if the fixer retries verification, plus a nano-model review for high-risk tasks. The former Skeptic agent has been replaced by a deterministic 4-point preflight gate. Verification and merge are deterministic command execution — not agents making claims.

> **Dashboard**: [admin.clawstreetbets.xyz](https://admin.clawstreetbets.xyz) — orchestrator dashboard (also at `http://localhost:4000`)
> **App**: [hydra.clawstreetbets.xyz](https://hydra.clawstreetbets.xyz) — the [hydra-betting](https://github.com/gaberoo322/hydra-betting) web app

For the language and architectural decisions that shape the codebase, see [CONTEXT.md](./CONTEXT.md), [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) (orchestrator-self vision), and the [ADR set](./docs/adr/).

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │              Control Loop                     │
                    │                                               │
  POST /api/       │  1. PREPARE ──► 2. GROUND ──► 2.5 CONTINUITY  │
  cycle/start ────►│       │              │              │          │
                    │       ▼              ▼              ▼          │
                    │  Clean workspace  npm test    last report     │
                    │  (safety-gated)   tsc          + repo diff    │
                    │                   git state         │          │
                    │                                     ▼          │
                    │  3. SELECT ANCHOR ─── stuckness? ──► research  │
                    │     │  13-priority waterfall (see below)       │
                    │     ▼                                          │
                    │  4. PLAN — codex frontier (or codex for fix)   │
                    │     │  scope-adaptive: quick-fix / std / cplx  │
                    │     ▼                                          │
                    │  5. PREFLIGHT — deterministic 4-point gate     │
                    │     │  (+ nano review on high-risk only)       │
                    │     ▼                                          │
                    │  6. EXECUTE — codex on feature branch          │
                    │     │  isolated worktree                       │
                    │     ▼                                          │
                    │  7. VERIFY — npm test + tsc + build (Gate)     │
                    │     │  ── fail ──► FIXER (one-shot retry)      │
                    │     │  ── still fail ──► prior-failure         │
                    │     ▼ pass                                     │
                    │  7.5 MUTATION + JIT (kill-rate ≥ 30% / 80%)    │
                    │  7.6 SCOPE ENFORCEMENT (>80% out blocks)       │
                    │     ▼                                          │
                    │  8. MERGE — lock + git merge --no-ff + push    │
                    │     │                                          │
                    │     ▼                                          │
                    │  9. REPORT + LEARN + AUTO-ROLLBACK on regress  │
                    │     OpenViking session commit triggers memory  │
                    └──────────────────────────────────────────────┘
```

## Key Concepts

**Two-Vision Steering** — Hydra answers to two vision documents that the operator edits:
- [`config/direction/vision.md`](./config/direction/vision.md) — the *target* product vision (prose for humans)
- [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) — what good autonomous building looks like
- [`config/direction/outcomes.yaml`](./config/direction/outcomes.yaml) (when configured) — structured *target outcome metrics* the orchestrator optimizes against

**Anchor Selection** — `selectAnchor()` in `src/anchor-selection.ts` runs a 13-priority waterfall, first-match-wins. Notable slots:
1. Explicit operator request (passed via `opts.anchor`)
2. **Stuckness-driven research** — when a target outcome stops moving, return a research anchor instead of pulling backlog (per ADR-0003)
3. Kanban queued lane (atomic Lua-script claim, gated by WIP limit)
4. Active specs (next unchecked task)
5. Failing tests / 6. Typecheck errors (from grounding)
7. Work queue (LMOVE to processing)
8. Reframe queue (failed 3+ times)
9. Prior failures (capped at 2 retries)
10. TODO/FIXME markers
11. Regression hunt (every 10 merges)
12. Codebase health
13. Priorities doc

**Scope-Adaptive Planning** — Tasks are classified post-planner: quick-fix (≤2 files, ≤3 criteria) uses the cheaper codex model and skips most gates. Standard runs the deterministic preflight. Complex (>5 files) logs warnings; high-risk gets a nano-model safety review.

**Untouchable Core** — A designated set of files Hydra cannot self-modify (only the operator can): the merge gate, rollback, watchdog, cost guardrails, and the protected-paths list itself. Enforced via CI: PRs touching protected paths require an `operator-approved` label. See [ADR-0001](./docs/adr/0001-untouchable-core-and-gate-extraction.md) and `src/untouchable.ts`.

**Self-Modification Tiers** — Hydra's PRs against itself are classified by blast radius. Tier 0 = Untouchable, operator-only. Tier 1 = prompt-shaped changes, auto-merge. Tier 2 = skill / weight / verification-additions, auto-merge with **Outcome Holdback** (5-cycle watch + auto-revert on regression). Tier 3 = everything else in `src/`, operator merges. See [ADR-0004](./docs/adr/0004-self-modification-tiers.md).

**Stuckness Detection** — `src/stuckness.ts` tracks cycles-since-favorable-movement per target outcome. Distinct from cycle failure — green cycles can be stuck. Fires drive anchor selection to research/self-improvement rather than the next backlog item.

**Evidence-Backed State** — Every task transition stores proof in Redis (`hydra:task:{id}:evidence:{state}`). Verification output, test results, diffs, preflight verdicts, mutation kill rates.

**Automatic Rollback** — If tests regress after merge, Hydra reverts the commit, pushes, and stores the task as a prior-failure for the next cycle.

**Compound Learning** — Two-tier memory: OpenViking sessions log per-cycle agent interactions and trigger automatic memory extraction on commit. Redis-fallback patterns (`hydra:memory:{agent}:patterns`) consolidate failures; at 5 occurrences, a pattern auto-promotes to the durable feedback file as a cardinal rule. Episodic reflections (`hydra:reflections:{anchor}`) are injected as planner context on retry.

## Dashboard

React + Vite + Tailwind operator UI at port 3000 (or via Cloudflare tunnel). Features:

- **Overview** — system health, cycle status, scheduler controls, daily spend, recommended operator actions
- **Cycles** — pipeline visualization, task introspection with evidence timeline
- **Backlog** — 6-lane Kanban (Triage → Backlog → Queued → Blocked → In Progress → Done) with priority, labels, estimates, descriptions, and slide-in detail panel
- **Config** — edit agent personalities, feedback files, and direction configs
- **Proposals** — review and approve/reject Meta agent improvement suggestions
- **Vision** — edit the operator north-star document
- **Queue** — add work items, trigger research cycles
- **Metrics** — 30-cycle charts (outcomes, test trends, costs)
- **Health** — service status with latency probes for all infrastructure
- **Search** — OpenViking knowledge base semantic search

## Backlog System

Linear-inspired project management with priority-based promotion:

| Field | Description |
|-------|-------------|
| Priority | Urgent / High / Medium / Low / None — promotion picks highest first |
| Description | Markdown with acceptance criteria, rationale, prerequisites |
| Labels | Flexible tags (execution, scanner, infra, research, etc.) |
| Estimate | T-shirt sizes: XS, S, M, L, XL |
| Parent | Group related items under a parent |

**Triage lane** — Research suggestions land here for operator review before entering the backlog. Approve or reject from the dashboard.

## Research System

Three parallel research agents discover what to build next:

- **Domain Researcher** — web search for strategies, competitive intelligence
- **Technical Researcher** — codebase analysis, architecture assessment
- **Market Researcher** — external API capabilities, platform changes

A **Director** synthesizes findings into ranked opportunities. High-confidence items auto-queue; everything else goes to Triage for review.

## Self-Improvement

Hydra's terminal goal is to move the **Target Outcomes**. Self-improvement is instrumental, but with a **25% capacity floor** reserved for orchestrator work regardless of target state — the floor exists because under-investment in the builder is the most expensive mistake to discover late. See [ADR-0003](./docs/adr/0003-terminal-goal-hierarchy.md).

Three loops drive orchestrator self-improvement:

1. **Meta agent** (frontier model) — runs every 20 cycles or after consecutive failures. Receives 20 cycles of metrics, reality reports, spending, backlog state, memory rules, and current agent configs. Proposes config tweaks (auto-applied) or backlog items (operator approves).
2. **Pattern detection** — `detectPatterns()` runs each cycle, surfacing systemic issues across recent runs.
3. **Adversarial validation** — nano-model self-play after merge probes for edge cases and queues fix tasks.

Operator escalation is reserved for **Operator-Required Intervention** (credentials, external-account actions, Tier-0 changes, vision-level conflicts — see [ADR-0005](./docs/adr/0005-operator-escalation-is-narrow.md)). Everything else, Hydra researches and tries autonomously.

## Prerequisites

- **Node.js** >= 22
- **Docker** + **Docker Compose** (Redis, VikingDB, OpenViking)
- **Codex CLI** — installed and authenticated
- **Git** — target project with `main` branch and remote
- A target project with `npm test`, `npm run typecheck`, and `npm run build`

## Quick Start

```bash
# Clone and install
git clone https://github.com/gaberoo322/hydra.git
cd hydra && npm install

# Configure
cp .env.example .env
# Edit .env: set HYDRA_PROJECT_WORKSPACE to your target project path

# Start infrastructure
docker compose up -d

# Start Hydra
npm start

# Open dashboard
open http://localhost:3000
```

## Configuration

### Environment

```bash
HYDRA_PORT=4000                    # REST API port
REDIS_URL=redis://localhost:6379   # Redis connection
HYDRA_PROJECT_WORKSPACE=~/project  # Target project directory
HYDRA_CONFIG_PATH=~/hydra/config   # Agent configs and direction files
```

### Config Directory

```
config/
├── agents/                 # Agent system prompts (Tier 1 — auto-evolves)
│   ├── planner.md
│   ├── executor.md
│   ├── skeptic.md          # Legacy; preflight is deterministic now
│   └── meta.md
├── feedback/               # Operator guidance to agents (Tier 1)
│   ├── to-planner.md
│   ├── to-executor.md
│   └── to-skeptic.md
├── direction/              # Target product direction
│   ├── vision.md           # Target vision (prose, operator-edited)
│   ├── outcomes.yaml       # Target outcome metrics (parsed by orchestrator)
│   ├── priorities.md       # Auto-generated from vision + system state
│   ├── goals.md
│   └── tech-preferences.md
├── orchestrator/           # Orchestrator-self direction
│   └── vision.md           # What good autonomous building looks like
└── research/               # Research agent configs (director, researchers, strategist)
```

### Steering Hydra

- **Target vision** — Edit `config/direction/vision.md` (or via dashboard) to set what the target product should become
- **Orchestrator vision** — Edit `config/orchestrator/vision.md` to set the trade-offs Hydra makes when ambiguous
- **Outcomes** — Declare named target metrics in `config/direction/outcomes.yaml` (role: leading | terminal, direction, threshold, window). Stuckness fires when leading outcomes stop moving.
- **Feedback** — Edit `config/feedback/to-*.md` to correct agent behavior
- **Queue** — `POST /api/queue` for specific work items (highest priority)
- **Backlog** — Add/prioritize items via dashboard Kanban board
- **Operator approval** — Apply the `operator-approved` GitHub label to merge a Tier-0 PR

## Services

| Service | Port | Purpose |
|---------|------|---------|
| Hydra API | 4000 | REST API + WebSocket + cycle engine |
| Dashboard | 3000 | React operator UI (Vite dev server) |
| OpenAI Proxy | 4001 | Bridges Codex OAuth → OpenAI API for embeddings |
| Redis | 6379 | Event bus, state, metrics, backlog |
| VikingDB | 5000 | Vector database backend |
| OpenViking | 1933 | Knowledge base with semantic retrieval |

## API

All endpoints are under `/api/`. Full list:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/cycle/start` | Start a cycle. Body: `{"anchor": {"type": "...", "reference": "..."}}` |
| `GET` | `/api/cycle/status` | Current cycle state |
| `GET` | `/api/cycle/history` | Recent completed cycles |
| `GET` | `/api/cycle/report` | Structured report with agent runs and costs |
| `GET` | `/api/tasks` | All tasks in current cycle |
| `GET` | `/api/tasks/:id/evidence` | Full evidence chain |
| `POST` | `/api/queue` | Queue work. Body: `{"reference": "...", "reason": "..."}` |
| `GET` | `/api/backlog` | Full Kanban state (all lanes) |
| `POST` | `/api/backlog` | Add item with priority, description, labels, estimate |
| `PATCH` | `/api/backlog/:id` | Update item fields |
| `POST` | `/api/backlog/:id/approve` | Move triage item → backlog |
| `GET` | `/api/recommendations` | Operator action items from system state |
| `GET` | `/api/metrics` | Cycle metrics. `?count=N` |
| `GET` | `/api/spending` | Token usage and costs. `?count=N` |
| `GET` | `/api/health` | System health |
| `GET` | `/api/health/services` | Probe all infrastructure services |
| `POST` | `/api/scheduler/start` | Start auto-scheduling |
| `POST` | `/api/scheduler/stop` | Stop auto-scheduling |
| `GET` | `/api/proposals` | List proposals. `?status=pending` |
| `POST` | `/api/proposals/:id/approve` | Approve (auto-applies if possible, else creates backlog item) |
| `POST` | `/api/proposals/:id/reject` | Reject. Body: `{"reason": "..."}` |
| `POST` | `/api/research/start` | Run research cycle |
| `POST` | `/api/kill` | Emergency stop |
| `GET` | `/api/config/:section` | List config files in section |
| `GET` | `/api/config/:section/:name` | Read config file |
| `PUT` | `/api/config/:section/:name` | Update config file |

## Agent Model Routing

| Agent | Model tier | Model | Purpose |
|-------|-----------|-------|---------|
| Planner | frontier | gpt-5.4 | Decompose anchor into bounded task. Drops to `codex` for quick-fix/low-risk. |
| Executor | codex | gpt-5.3-codex | Code changes in isolated worktree on feature branch. |
| Fixer | codex | gpt-5.3-codex | One-shot retry if verification failed on first pass. |
| JIT tester | codex | gpt-5.3-codex | Diff-aware test generation for surviving mutants. |
| Meta | mini | gpt-5.4-mini | Strategic analysis every 20 cycles. |
| High-risk review | mini | gpt-5.4-mini | Nano safety review (high-risk tasks only). |
| Adversarial | mini | gpt-5.4-mini | Post-merge self-play for edge cases. |

Pricing (per 1M tokens): frontier $2.50 in / $15.00 out, codex $1.75 / $14.00, mini $0.75 / $4.50.

## Systemd Services

Production deployment uses systemd user services:

| Service | Description |
|---------|-------------|
| `hydra-orchestrator` | Main API + cycle engine. Express serves `dashboard/dist/` on port 4000. |
| `hydra-openai-proxy` | Embedding proxy for OpenViking |
| `hydra-docker` | Docker Compose infrastructure |
| `hydra-vault-watcher` | Knowledge indexer for OpenViking |
| `hydra-tunnel` | Cloudflare tunnel for external access |
| `hydra-cycle.timer` | Cycle trigger (every 15 minutes) |
| `hydra-orchestrator-watchdog.timer` | Health check (every 2 minutes) |

## CI/CD & Deployment

All changes to `master` go through a PR; branch protection enforces CI passing before merge.

**CI** (`.github/workflows/ci.yml`) on every PR:
- `npm run typecheck` + `npm test` (orchestrator)
- `cd dashboard && npm run build`
- `tier-gate` job (when [#243](https://github.com/gaberoo322/hydra/issues/243) lands) — blocks PRs touching Untouchable Core paths unless an `operator-approved` label is present

**Deploy** runs automatically on merge to master via a self-hosted GitHub Actions runner: `git pull`, `npm ci`, dashboard build, `systemctl restart`, health check. Manual emergency deploy: `./scripts/deploy.sh`.

## Design Principles

1. **Evidence over claims** — Every state transition is backed by proof. Agents don't self-report success; the system verifies it.
2. **Single task per cycle** — One thing at a time, done properly, with full audit trail.
3. **Hard verification** — Real commands, real output, real exit codes. Not an agent claiming tests pass.
4. **Fail forward** — Failed tasks become prior-failures with context for the next cycle.
5. **Never bypass the gate** — The Untouchable Core stays operator-only. Better slow than brakes-less.
6. **Outcome signal over cycle metrics** — Green cycles ≠ working orchestrator. Stuckness fires on target outcomes, not on test status.
7. **Reversibility over speed** — Tier-2 with outcome holdback + auto-revert is preferred over Tier-3 operator review when both are options.
8. **Stay autonomous** — Operator escalation is reserved for a narrow closed list (creds, external accounts, Tier-0 changes, vision conflicts). Everything else, Hydra researches and tries.

## Stats

- 929+ regression tests (node:test, zero external deps; each test corresponds to a real bug)
- 4 runtime dependencies: `express`, `ioredis`, `ws`, `@openai/codex-sdk` (+ `@sentry/node` for error tracking)
- Two-vision steering (target prose + orchestrator-self), structured outcomes config, 5 ADRs

## License

UNLICENSED
