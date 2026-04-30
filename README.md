# Hydra

Hydra is an autonomous software development orchestrator. It runs continuous development cycles against a target codebase — grounding itself in real project state, selecting work, planning a bounded task, challenging it through a skeptic gate, executing the change, verifying with hard checks, and merging to main. Every cycle produces a structured reality report backed by evidence in Redis.

Hydra uses [Codex CLI](https://github.com/openai/codex) as its agent runtime. Three agent calls per cycle: **Planner**, **Skeptic**, **Executor**. Verification and merge are deterministic command execution — not agents making claims.

> **Dashboard**: [admin.clawstreetbets.xyz](https://admin.clawstreetbets.xyz) — orchestrator dashboard
> **App**: [hydra.clawstreetbets.xyz](https://hydra.clawstreetbets.xyz) — the [hydra-betting](https://github.com/gaberoo322/hydra-betting) web app

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │            V2 Control Loop               │
                    │                                          │
  POST /api/       │  1. PREPARE ──► 2. GROUND ──► 3. ANCHOR  │
  cycle/start ────►│       │              │              │     │
                    │       ▼              ▼              ▼     │
                    │  Clean workspace  npm test     Pick work  │
                    │  (safety-gated)   tsc          (priority  │
                    │                   git state     order)    │
                    │                                    │      │
                    │  4. PLAN ◄─────────────────────────┘      │
                    │     │  Codex agent: 1 bounded task        │
                    │     ▼                                     │
                    │  5. SKEPTIC ─── reject ──► abandoned      │
                    │     │  (skip for quick-fix)               │
                    │     ▼ approve                             │
                    │  6. EXECUTE                               │
                    │     │  Codex agent: feature branch        │
                    │     ▼                                     │
                    │  7. VERIFY ─── fail ──► prior-failure     │
                    │     │  npm test + tsc + build             │
                    │     ▼ pass                                │
                    │  8. MERGE ──► 9. REPORT + LEARN           │
                    │     git merge --no-ff + push              │
                    └─────────────────────────────────────────┘
```

## Key Concepts

**Anchor Selection** — Strict priority order determines what Hydra works on:
1. Operator queue (`POST /api/queue`)
2. Failing tests
3. Typecheck errors
4. Reframe queue (tasks failed 2+ times)
5. Prior failures (retry)
6. Priorities document

**Scope-Adaptive Routing** — Tasks are classified after planning: quick-fix (1-2 files) skips the skeptic and uses a cheaper model. Complex tasks (5+ files) get full ceremony.

**Evidence-Backed State** — Every task transition stores proof in Redis (`hydra:task:{id}:evidence:{state}`). Verification output, test results, diffs, skeptic verdicts.

**Automatic Rollback** — If tests regress after merge, Hydra reverts the commit, pushes, and stores the task as a prior-failure for the next cycle.

**Compound Learning** — After each cycle, Hydra extracts WHEN/CHECK/BECAUSE prevention rules from failures and surprises. These accumulate as agent memory and prevent repeated mistakes.

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

The **Meta agent** (frontier model) runs every 20 cycles as a strategic review, or immediately when 2+ of the last 5 cycles fail. It receives comprehensive context: 20 cycles of metrics, reality reports, spending data, backlog state, agent memory rules, current agent configs, and all recent proposals.

Proposals that target config files (personality tweaks, feedback updates) can be auto-applied via `appendLines`. Proposals that require code changes create a backlog item automatically. All proposals are visible on the dashboard for operator review.

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
├── agents/           # Agent system prompts
│   ├── planner.md
│   ├── executor.md
│   ├── skeptic.md
│   └── meta.md
├── feedback/         # Operator guidance to agents
│   ├── to-planner.md
│   ├── to-executor.md
│   └── to-skeptic.md
├── direction/        # Strategic direction
│   ├── vision.md     # Operator north star (you write this)
│   ├── priorities.md # Auto-generated from vision + system state
│   ├── goals.md      # Project goals with success metrics
│   └── tech-preferences.md
└── research/         # Research agent configs
```

### Steering Hydra

- **Vision** — Edit `config/direction/vision.md` (or via dashboard) to set high-level direction
- **Feedback** — Edit `config/feedback/to-*.md` to correct agent behavior
- **Queue** — `POST /api/queue` for specific work items (highest priority)
- **Backlog** — Add/prioritize items via dashboard Kanban board

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

| Agent | Model | Purpose |
|-------|-------|---------|
| Planner | gpt-5.4 (frontier) | Decompose anchor into bounded task. Codex model for quick-fix/low-risk. |
| Skeptic | gpt-5.3-codex | Challenge assumptions, veto bad proposals. Skipped for quick-fix. |
| Executor | gpt-5.3-codex | Code changes on feature branch. |
| Meta | gpt-5.4 (frontier) | Strategic analysis every 20 cycles. Comprehensive system context. |

## Systemd Services

Production deployment uses systemd user services:

| Service | Description |
|---------|-------------|
| `hydra-orchestrator` | Main API + cycle engine |
| `hydra-dashboard` | Vite dev server for operator UI |
| `hydra-openai-proxy` | Embedding proxy for OpenViking |
| `hydra-docker` | Docker Compose infrastructure |
| `hydra-vault-watcher` | Knowledge indexer for OpenViking |
| `hydra-tunnel` | Cloudflare tunnel for external access |
| `hydra-cycle.timer` | Cycle trigger (every 4 hours) |
| `hydra-orchestrator-watchdog.timer` | Health check (every 2 minutes) |
| `hydra-deploy.timer` | Vercel production deploy (hourly) |

## Design Principles

1. **Evidence over claims** — Every state transition is backed by proof. Agents don't self-report success; the system verifies it.
2. **Single task per cycle** — One thing at a time, done properly, with full audit trail.
3. **Hard verification** — Real commands, real output, real exit codes. Not an agent claiming tests pass.
4. **Fail forward** — Failed tasks become prior-failures with context for the next cycle.
5. **Operator in the loop** — Vision, feedback, queue, proposal approvals. The human steers; Hydra executes.
6. **Self-improvement from measurement** — Meta agent proposes changes from cycle metrics, not vibes.

## Stats

- 10,155 lines across 32 source files
- 50 regression tests (node:test, zero dependencies beyond express + ioredis)
- 100% merge rate over last 30 cycles on hydra-betting
- ~$3.40 average cost per cycle

## License

UNLICENSED
