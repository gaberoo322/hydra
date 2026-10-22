# Hydra

Hydra is an **autonomous software development orchestrator**: a control plane that builds software continuously — selecting its own work, dispatching Claude Code subagents in isolated git worktrees, verifying with hard checks, and merging via PR — without a human in the per-change loop. The operator steers through vision documents, outcome metrics, and a narrow escalation channel, not per-PR review.

Hydra is a **swappable single-target builder** ([ADR-0013](./docs/adr/0013-swappable-single-target-builder.md)): one instance points at exactly one target codebase and specializes into it. The current target is [claw-street-bets](https://github.com/gaberoo322/claw-street-bets) — the defaults live in `src/target-config.ts` and are overridable via `HYDRA_TARGET_NAME` / `HYDRA_TARGET_GITHUB_REPO` / `HYDRA_TARGET_WEB_URL`; the earlier target, hydra-betting, is mothballed. The durable asset is the builder itself — generality lives in the *swap*, never in the session.

> **Dashboard**: [admin.clawstreetbets.xyz](https://admin.clawstreetbets.xyz) — orchestrator dashboard (also at `http://localhost:4000`)

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                       hydra-autopilot                        │
│        long-running Claude Code session — the brain          │
│                                                              │
│  health probe → budget + per-class cooldowns → decide.py     │
│  picks eligible classes → dispatches one background          │
│  subagent per class, in parallel → collects lessons          │
└──────────────────────────────┬───────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────┐       ┌───────────────────────────┐
│  Code-writing subagents   │       │  Read-only subagents      │
│  (fresh git worktree each)│       │                           │
│                           │       │  qa · research · sweep    │
│  hydra-dev          → PR  │       │  discover · health ·      │
│  hydra-target-build → PR  │       │  cleanup · retro          │
│                           │       │                           │
│  ── CI is the merge gate ─│       │  Output: GitHub issues,   │
│     typecheck + tests     │       │  Redis state, lessons     │
│     dashboard build       │       │                           │
│     tier-gate             │       │                           │
│     mutation kill-rate    │       │                           │
│     scope enforcement     │       │                           │
└─────────────┬─────────────┘       └───────────────────────────┘
              ▼
   Orchestrator service (port 4000) — the data plane
     Dashboard + REST API · Redis state + event bus ·
     observability heartbeat · tier classifier
```

Three layers:

1. **The brain — [`hydra-autopilot`](./docs/operator-playbooks/hydra-autopilot.md).** A long-running Claude Code session and the single decision loop ([ADR-0012](./docs/adr/0012-autopilot-is-the-single-brain.md)). Each tick, `decide.py` turns the Turn Snapshot ([ADR-0043](./docs/adr/0043-turn-snapshot-is-a-typed-ts-module-collect-state-is-strangled.md): board labels, budgets, cooldowns) into typed dispatch actions — one background subagent per work class, routed to a right-sized model per class.
2. **The hands — Claude Code subagents.** Code-writing classes (`hydra-dev` for orchestrator work, `hydra-target-build` for target work) each run in a fresh `git worktree` and open a PR. **CI is the merge gate** — verification is deterministic command execution (tests, typecheck, build, mutation kill-rate, scope enforcement; see [quality gates](./docs/quality-gates.md)), never an agent claim. Read-only classes (QA, research, discovery, sweeps, health, cleanup, retro) emit issues, Redis updates, and lessons.
3. **The data plane — the orchestrator HTTP service (port 4000).** Express + Redis: state, the `hydra:*` event streams, the dashboard and [REST API](./docs/reference.md), and the tier classifier. Every task transition stores evidence in Redis, so state is proof-backed, not self-reported.

## Key Concepts

Terms in **bold** are defined precisely in [`CONTEXT.md`](./CONTEXT.md); [`CONTEXT-MAP.md`](./CONTEXT-MAP.md) maps domain language to code areas.

- **Two-Vision Steering** — [`config/direction/vision.md`](./config/direction/vision.md) describes what the *target product* should become; [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) describes what good autonomous building looks like and how Hydra resolves ambiguous trade-offs. [`config/direction/outcomes.yaml`](./config/direction/outcomes.yaml) declares the **Target Outcomes** — the terminal success signal ("outcome signal over cycle metrics").
- **Self-Modification Tiers** — every PR, regardless of author, is classified by blast radius on a monotonic ladder T1→T4; the tier names required *verification depth*, not merge authority ([ADR-0004](./docs/adr/0004-self-modification-tiers.md), [ADR-0015](./docs/adr/0015-verification-depth-replaces-merge-authority.md)). See [Safety Model](#safety-model).
- **Verifier Core** — the files that prove the work shipped (CI workflows, the tier classifier, the protected-paths list itself, `src/untouchable.ts`; the exact list is `VERIFIER_CORE_PATHS` in that file). Hydra cannot quietly modify its own brakes ([ADR-0001](./docs/adr/0001-untouchable-core-and-gate-extraction.md)).
- **Outcome Holdback** — Tier-2 changes auto-merge but enter a multi-cycle watch against the pre-merge outcome baseline; regressions auto-revert. Reversibility over speed.
- **Evidence-Backed State** — verification output, test results, diffs, and verdicts are stored in Redis per task transition. Agents don't self-report success; the system records proof.
- **Compound Learning** — per-dispatch lesson capture, failure-pattern consolidation in Redis (recurring patterns are promoted in Redis and escalated to GitHub issues), and retro skills that turn completed runs into capped, deduplicated improvement proposals.
- **Capacity floor** — 25% of capacity is reserved for orchestrator self-improvement regardless of target state; under-investing in the builder is the most expensive mistake to discover late ([ADR-0003](./docs/adr/0003-terminal-goal-hierarchy.md)).

## Safety Model

| Tier | Scope | Required verification depth |
|------|-------|-----------------------------|
| T1 — Prompt-shaped | Prompt-only tweaks (nothing classifies T1 today — the agent-personality and feedback directories were removed, see [`docs/historical/README.md`](./docs/historical/README.md)) | QA PASS → auto-merge |
| T2 — Skill / verification | Dashboard | QA PASS + Outcome Holdback → auto-merge |
| T3 — Core `src/` | Everything else in `src/`, watchdog scripts, deploy script, skill playbooks | QA PASS → auto-merge |
| T4 — Verifier Core | CI workflows, tier classifier, the protected-paths list | Deep-QA pass; operator only via an exhausted remediation loop |

Exact path lists per tier are generated into [`docs/generated/tier-paths.json`](./docs/generated/tier-paths.json).

Operator escalation is a **closed list** ([ADR-0005](./docs/adr/0005-operator-escalation-is-narrow.md)): credentials/secrets, external-account actions, T4/Verifier-Core changes, vision-level conflicts. Everything else Hydra researches and retries autonomously — "I tried and it didn't work" is a reason to research harder, not to escalate. Spend is paced against the subscription quota by the Pace Gate rather than a dollar cap (see **Cost** and **Pace Gate** in [`CONTEXT.md`](./CONTEXT.md)).

## Operating Hydra

The intended rhythm: the autopilot runs unattended (overnight operation is the design point), and the operator periodically reviews a small queue of genuine decisions and adjusts direction. Steering levers, in order of leverage:

- **Vision documents** — edit `config/direction/vision.md` (target) or `config/orchestrator/vision.md` (builder trade-offs)
- **Outcomes** — declare named metrics in `config/direction/outcomes.yaml` (role, direction, baseline, target); consumed by the dashboard and the Outcome Holdback producer and chores
- **Priorities** — curate `config/direction/priorities.md`; for "do this next", label the issue `ready-for-agent` — `hydra-dev` self-selects from that label (there is no queue endpoint)
- **Review skills** — `/hydra-review` drains the decision queue, `/hydra-hitl-grill` drains the parked-idea lane, `/hydra-digest` summarizes activity, `/hydra-doctor` diagnoses health

The dashboard (React + Vite, served by Express from `dashboard/dist/` — gitignored build output) names its sidebar entries by label: the journey group is Today, Health, Work, Runs, Builder and Now, and a separate reference group holds Docs (the cockpit that renders this documentation corpus, [ADR-0034](./docs/adr/0034-orchestrator-dashboard-page-inventory.md) §10). Run and transcript detail views and legacy redirects sit outside the nav. The page list is generated into [`docs/generated/pages.json`](./docs/generated/pages.json). `/now` is an in-nav journey-group page.

## Getting Started

### Prerequisites

- **Node.js** — the exact version pinned in `.nvmrc` (range in `package.json`'s `engines.node`, enforced by `test/toolchain-pin.test.mts`)
- **Docker** + **Docker Compose** (Postgres, Redis)
- **Claude Code** — installed and authenticated (the harness that runs `hydra-autopilot` and its subagents)
- A target project with a `main` branch, a remote, and working `npm test` / `npm run typecheck` / `npm run build`

### Quick Start

```bash
git clone https://github.com/gaberoo322/hydra.git
cd hydra && npm install

cp .env.example .env
# Edit .env: set HYDRA_PROJECT_WORKSPACE to your target project path

docker compose up -d          # infrastructure
npm start                     # orchestrator service (port 4000)
open http://localhost:4000    # dashboard (after `cd dashboard && npm run build`)
```

Production runs as systemd user services with timer-driven autopilot pacing; deploy happens automatically on merge to master via a self-hosted runner. The full deploy recipe, service list, environment variables, Redis keys, and API endpoints live in [`docs/reference.md`](./docs/reference.md).

## Development

```bash
npm test                  # regression suite (node:test, zero test-framework deps)
npm run typecheck
npx tsx src/index.ts      # dev service — check port 4000 is free first
```

- All changes to `master` go through a PR; branch protection enforces CI. The suite is the `test/*.test.mts` files; the per-file floor is `test/fixtures/suite-count-baseline.json`.
- Runtime dependencies are operator-approved only: `express`, `ioredis`, `ws`, `@sentry/node`, `zod`, `pino` — Node stdlib for everything else ([ADR-0005](./docs/adr/0005-operator-escalation-is-narrow.md) is the operator-approval rule; `pino` is the logger seam, [ADR-0027](./docs/adr/0027-pino-structured-logger.md); simplicity discipline: [ADR-0014](./docs/adr/0014-simplicity-discipline.md)).
- Coding conventions, common pitfalls, and agent contracts: [`CLAUDE.md`](./CLAUDE.md).

## Documentation Map

| Doc | What it covers |
|-----|----------------|
| [`CLAUDE.md`](./CLAUDE.md) | Agent/contributor entry point: conventions, pitfalls, tier rules |
| [`CONTEXT.md`](./CONTEXT.md) / [`CONTEXT-MAP.md`](./CONTEXT-MAP.md) | Domain glossary and where each term lives in code |
| [`docs/adr/`](./docs/adr/) | Architectural decision records — the "why" behind every major shape |
| [`docs/reference.md`](./docs/reference.md) | Redis keys, event streams, API endpoints, model tiers, config, deploy |
| [`docs/quality-gates.md`](./docs/quality-gates.md) | CI gate details: mutation kill-rate, scope enforcement, tier-gate |
| [`docs/operator-playbooks/hydra-autopilot.md`](./docs/operator-playbooks/hydra-autopilot.md) | Autopilot class taxonomy and dispatch contract |
| [`docs/generated/`](./docs/generated/) | Generated feature inventories (routes, pages, chores, tier paths, counts) — the canonical record, rendered by the `/docs` cockpit page |
| [`docs/historical/`](./docs/historical/) | Retired subsystems — full roster in [`docs/historical/README.md`](./docs/historical/README.md) |

## Design Principles

1. **Evidence over claims** — agents don't self-report success; the system verifies it with real commands and real exit codes.
2. **Never bypass the gate** — a Verifier Core change is judged by the live gate (the Live-Gate Invariant) and the Deep-QA Remediation Loop, never by the gate it proposes. Better slow than brakes-less.
3. **Outcome signal over cycle metrics** — green CI ≠ working system; Target Outcomes are the success signal.
4. **Reversibility over speed** — auto-merge with holdback-and-revert beats waiting on human review.
5. **Maintainability over throughput** — fewer, cleaner merges beat a noisy log of green debt.
6. **Stay autonomous** — escalation is a narrow closed list; everything else Hydra researches and tries.

## License

[GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0-only). The AGPL's network-use clause (§13) is deliberate: anyone who runs a modified Hydra as a network service must offer their source to its users — the strongest copyleft protection for a server-side autonomous system.
