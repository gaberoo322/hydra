# Hydra

Hydra is an autonomous software development orchestrator. It runs continuous development against a target codebase — grounding itself in real project state, selecting work, dispatching a bounded task to a Claude Code subagent in an isolated worktree, verifying with hard checks (tests, typecheck, build, mutation kill-rate, scope enforcement), and merging to main via PR. Every dispatch produces a structured reality report backed by evidence in Redis. Hydra steers itself via two vision documents (target product + orchestrator-self) and improves its own architecture gradually within safety bounds.

Hydra is driven by **`hydra-autopilot`** — a long-running Claude Code session that dispatches background subagents in parallel, one per **class** (`dev_orch`, `dev_target`, `research_orch`, `research_target`, `sweep_orch`, `sweep_target`, `discover_orch`, `discover_target`, `health`, `qa`). Code-writing classes (`hydra-dev`, `hydra-target-build`) run in fresh `git worktree`s and open PRs; CI is the merge gate. Verification, merge, and the tier classifier are deterministic command execution — not agents making claims. The Codex CLI runtime was retired on 2026-05-14 (see [ADR-0006](./docs/adr/0006-codex-cli-removed-autopilot-only.md)).

> **Dashboard**: [admin.clawstreetbets.xyz](https://admin.clawstreetbets.xyz) — orchestrator dashboard (also at `http://localhost:4000`)
> **App**: [hydra.clawstreetbets.xyz](https://hydra.clawstreetbets.xyz) — the [hydra-betting](https://github.com/gaberoo322/hydra-betting) web app

For the language and architectural decisions that shape the codebase, see [CONTEXT.md](./CONTEXT.md), [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) (orchestrator-self vision), and the [ADR set](./docs/adr/).

## Architecture

```
                    ┌────────────────────────────────────────────────────┐
                    │                hydra-autopilot                      │
                    │   (long-running Claude Code session, parallel BGs)  │
                    │                                                     │
                    │  1. health probe        — /api/health               │
                    │  2. budget + cooldowns  — daily-spend, per-class    │
                    │  3. pick eligible cls   — health / qa / dev_orch /  │
                    │                           dev_target / research /   │
                    │                           sweep / discover           │
                    │  4. dispatch in parallel — one BG subagent per       │
                    │                            eligible class            │
                    │  5. collect lessons     — subagent-capture hook      │
                    │  6. sleep / next tick                                │
                    └────────────────────────────────────────────────────┘
                                            │
                       ┌────────────────────┴─────────────────────┐
                       ▼                                          ▼
            ┌──────────────────────────┐         ┌──────────────────────────┐
            │  Code-writing subagents  │         │  Read-only subagents     │
            │  (worktree-isolated)     │         │                          │
            │                          │         │  hydra-doctor (health)   │
            │  hydra-dev    → PR       │         │  hydra-qa     (PR review)│
            │  hydra-target-build → PR │         │  hydra-research          │
            │                          │         │  hydra-sweep             │
            │  ── CI gate ──►          │         │  hydra-discover          │
            │      npm test                       │  hydra-target-research   │
            │      npm run typecheck              │  hydra-target-sweep      │
            │      dashboard build                │  hydra-target-discover   │
            │      tier-gate                      │                          │
            │      mutation kill ≥ 30%            │  Output: Redis updates,  │
            │      scope ≤ 80% in                 │  GitHub issues, lessons. │
            │  ── merge ──►                       │                          │
            │      Tier-2 holdback watcher        │                          │
            │      (auto-revert on regression)    │                          │
            └──────────────────────────┘         └──────────────────────────┘
                       │
                       ▼
            Hydra orchestrator service (port 4000)
              — Dashboard + REST API
              — Redis state (backlog, queue, reports, memory, reflections)
              — Event bus + WebSocket
              — Knowledge plane (OpenViking)
              — Scheduler (research-floor, daily-spend)
              — Merge-gate facade + tier classifier
```

## Key Concepts

**Two-Vision Steering** — Hydra answers to two vision documents that the operator edits:
- [`config/direction/vision.md`](./config/direction/vision.md) — the *target* product vision (prose for humans)
- [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) — what good autonomous building looks like
- [`config/direction/outcomes.yaml`](./config/direction/outcomes.yaml) (when configured) — structured *target outcome metrics* the orchestrator optimizes against

**Anchor Selection** — `selectAnchor()` in `src/anchor-selection.ts` runs a priority waterfall, first-match-wins. Notable slots:
1. Explicit operator request (passed via `opts.anchor`)
2. Capacity-floor pre-emption (reframe-queue floor; see `src/anchor-selection/capacity-floors.ts`)
3. Kanban queued lane (atomic Lua-script claim, gated by WIP limit)
4. Failing tests / Typecheck errors (from grounding)
5. Work queue (LMOVE to processing)
6. Reframe queue (failed 3+ times)
7. Prior failures (capped at 2 retries)
8. TODO/FIXME markers
9. Regression hunt (every 10 merges)
10. Codebase health
11. Priorities doc

**Untouchable Core** — A designated set of files Hydra cannot self-modify (only the operator can): the merge gate, rollback, watchdog, cost guardrails, and the protected-paths list itself. Enforced via CI: PRs touching protected paths require an `operator-approved` label. See [ADR-0001](./docs/adr/0001-untouchable-core-and-gate-extraction.md) and `src/untouchable.ts`.

**Self-Modification Tiers** — Hydra's PRs against itself are classified by blast radius. Tier 0 = Untouchable, operator-only. Tier 1 = prompt-shaped changes, auto-merge. Tier 2 = skill / weight / verification-additions, auto-merge with **Outcome Holdback** (5-cycle watch + auto-revert on regression). Tier 3 = everything else in `src/`, operator merges. See [ADR-0004](./docs/adr/0004-self-modification-tiers.md).

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
- **Claude Code** — installed and authenticated (the harness that runs `hydra-autopilot` and its subagents)
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
├── direction/              # Target product direction
│   ├── vision.md           # Target vision (prose, operator-edited)
│   ├── outcomes.yaml       # Target outcome metrics (parsed by orchestrator)
│   ├── priorities.md       # Refreshed by /hydra-target-research
│   ├── goals.md
│   └── tech-preferences.md
├── orchestrator/           # Orchestrator-self direction
│   └── vision.md           # What good autonomous building looks like
└── research/               # Research agent configs (director, researchers, strategist)
```

> Pre-2026-05-14, `config/agents/` and `config/feedback/` held in-process
> planner/executor/skeptic/meta personalities and operator feedback files.
> Those were moved to `docs/historical/agent-personalities/` when the Codex
> CLI runtime was retired. Subagent personalities now live under
> `~/.claude/skills/` (operator's Claude Code install), not in this repo.

### Steering Hydra

- **Target vision** — Edit `config/direction/vision.md` (or via dashboard) to set what the target product should become
- **Orchestrator vision** — Edit `config/orchestrator/vision.md` to set the trade-offs Hydra makes when ambiguous
- **Outcomes** — Declare named target metrics in `config/direction/outcomes.yaml` (role: leading | terminal, direction, baseline, target). Surfaced on the dashboard and consumed by the Tier-2 outcome holdback watcher.
- **Feedback** — Edit `config/feedback/to-*.md` to correct agent behavior
- **Queue** — `POST /api/queue` for specific work items (highest priority)
- **Backlog** — Add/prioritize items via dashboard Kanban board
- **Operator approval** — Apply the `operator-approved` GitHub label to merge a Tier-0 PR

## Services

| Service | Port | Purpose |
|---------|------|---------|
| Hydra API | 4000 | REST API + WebSocket + autopilot data plane |
| Dashboard | 3000 | React operator UI (Vite dev server) |
| OpenAI Proxy | 4001 | OAuth-bridged proxy used by OpenViking for embeddings (legacy of the Codex OAuth setup; retained because OV's embedding model still routes through it) |
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

## Subagent Routing

The orchestrator no longer routes per-call models. Claude Code's harness picks the model when it dispatches a subagent; the operator's subscription determines the model pool. Indicative routing:

| Subagent | Typical model | Purpose |
|----------|--------------|---------|
| hydra-dev / hydra-target-build | claude-opus-4-7 (1M context) | Deep multi-file edits, plan + implement + verify, isolated-worktree PRs |
| hydra-research / hydra-target-research / hydra-architect | claude-opus-4-7 | Multi-source research and strategic design |
| hydra-sweep / hydra-target-sweep / hydra-qa / hydra-doctor | claude-sonnet-4-6 | Board/PR/health work with structured outputs |
| hydra-discover / hydra-target-discover | claude-haiku-4-5 | Patrol and runtime diagnostics; small/fast/cheap |
| lesson-capture hook | claude-haiku-4-5 | Per-dispatch lesson extraction for the feedback loop |

Daily token spend (when the harness exposes it) flows into `hydra:scheduler:daily-spend` for the same dashboard widget that previously tracked Codex usage. Pricing is determined by the operator's Claude Code plan, not by this repo.

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
6. **Outcome signal over cycle metrics** — Green cycles ≠ working orchestrator. Target outcomes are the success signal, not test status. The Tier-2 outcome holdback watcher reads them to auto-revert regressions.
7. **Reversibility over speed** — Tier-2 with outcome holdback + auto-revert is preferred over Tier-3 operator review when both are options.
8. **Stay autonomous** — Operator escalation is reserved for a narrow closed list (creds, external accounts, Tier-0 changes, vision conflicts). Everything else, Hydra researches and tries.

## Stats

- 1200+ regression tests (node:test, zero external deps; each test corresponds to a real bug)
- 4 runtime dependencies: `express`, `ioredis`, `ws`, `@sentry/node` (Codex SDK removed 2026-05-14)
- Two-vision steering (target prose + orchestrator-self), structured outcomes config, 6 ADRs

## License

UNLICENSED
