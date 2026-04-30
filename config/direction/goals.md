---
name: Algorithmic Betting Platform
updated: 2026-04-07
status: active
owner: strategist
tags: [hydra, hydra/direction]
---

# Goals

## Current Phase

The project is in the **paper trading and strategy validation phase**.

The execution infrastructure is built. The focus now shifts to:
- Proving the pipeline works with real market data via Kalshi's demo environment
- Building cross-platform arbitrage detection (lowest-risk profitable strategy)
- Extending Polymarket to execution parity
- Replacing the placeholder edge model with real probability estimates

## Success Metrics

| Metric | Target | Category | Source |
|--------|--------|----------|--------|
| Demo dry-run completes without errors | 100% | reliability | npm run kalshi:dry-run |
| Demo live-run places and tracks orders | >95% success | reliability | demo venue_orders |
| Cross-platform price discrepancy detection | working | profitability | arbitrage scanner |
| Arbitrage opportunities per day | track count | profitability | scanner logs |
| Bet execution success rate (demo) | >99% | reliability | venue_orders table |
| System uptime | >99.5% | reliability | process monitor |
| Test coverage | >80% critical paths | architecture | npm test --coverage |
| TypeScript strict mode | clean | architecture | npm run typecheck |
| Monthly ROI (when live) | >15% | profitability | metrics/app-metrics.json |
| Max drawdown (when live) | <15% | risk_management | metrics/app-metrics.json |
| Win rate (when live) | >55% | profitability | metrics/app-metrics.json |

## Focus Weights

- profitability: 30
- reliability: 25
- architecture: 20
- risk_management: 15
- ui_ux: 10

## Constraints

- Must support Kalshi and Polymarket as primary platforms
- Paper trade on Kalshi demo before using real money
- Never risk more than 2% of total bankroll on a single bet
- Never have more than 20% of bankroll in open positions simultaneously
- All bets must be logged with timestamps, reasoning, odds, and outcomes
- Must gracefully handle API outages — never bet on stale data
- No hardcoded API keys or secrets in source code
- Must be recoverable from any crash state without manual intervention
- NEVER delete provider or execution files

## AI Provider Policy

All LLM inference in this project uses **Codex** (OpenAI Codex subscription) via an OpenAI-compatible proxy. There is NO separate OpenAI API key.

- `OPENAI_API_KEY` is set to a proxy auth token that routes through `http://localhost:4001/v1` (local) or `https://admin.clawstreetbets.xyz/api/openai-proxy/v1` (external).
- The proxy translates `/chat/completions` requests into `codex exec` calls using the Codex OAuth token.
- **Do NOT create tasks about configuring, provisioning, or checking OPENAI_API_KEY.** It is already configured and working.
- **Do NOT propose switching to direct OpenAI API access.** Codex is the only authorized LLM provider.
- The `isLiveNominationAvailable()` check that gates on OPENAI_API_KEY will pass because the env var is set (to the proxy token).

## Infrastructure

The system runs on a dedicated Intel NUC (always-on home server). All agents, services, and the target project run locally. No Vercel — everything self-hosted behind Cloudflare tunnel.

**Hardware:**
- CPU: 13th Gen Intel i3-1315U (8 threads)
- RAM: 64 GB
- Storage:
  - `/` — 2TB NVMe (Solidigm), 100GB LVM partition, hosts OS + code + working trees
  - `/mnt/hydra-ssd` — 500GB Samsung 860 EVO (USB 3.0), hosts Docker, npm cache, Playwright browsers
- Network: Cloudflare tunnel — admin.clawstreetbets.xyz (orchestrator API), hydra.clawstreetbets.xyz (betting app)

**Deployment architecture:**
- Hydra orchestrator, Redis, OpenViking, dashboard, openai-proxy — all run locally as systemd user services
- hydra-betting web app — Next.js production server locally (port 3333), served via Cloudflare tunnel
- Checkpoint refresh, ingestion, scanner, alerts, prediction-market-cron — systemd timers
- All LLM inference via Codex CLI (OAuth, no API key) or Codex-compatible proxy (port 4001)

**Storage rules for agents:**
- Large generated artifacts (test fixtures, execution receipts, data dumps) go to `/mnt/hydra-ssd/` not the NVMe
- Docker is on the SSD — do not move it back to NVMe
- npm cache and Playwright browsers are symlinked to the SSD
- The NVMe has ~58GB free — do not let it fill below 20GB

## Pain Points

- No paper trading yet — can't prove the system works without risking money
- No cross-platform market matching — can't detect arbitrage without it
- Edge model is spread-based placeholder — not a real probability estimate
- Polymarket execution not built — SDK installed but no execution service
- Dashboard pages exist but aren't connected (no navigation)
- Migrations not applied to production Postgres

## Supported Platforms

- **Kalshi**: Full pipeline + demo environment (demo-api.kalshi.co)
- **Polymarket US**: REST + WS + CLOB SDK. Execution service not built yet.
- **The Odds API**: Sportsbook pipeline fully operational.

## Strategy Research Summary

Research identified these viable strategies (ranked by risk):
1. **Arbitrage** (lowest risk): 4-7.5% guaranteed profit from cross-platform price gaps
2. **Market making**: 2-8%/month from bid-ask spreads on liquid markets
3. **Event-driven**: Position ahead of catalysts (debates, votes) — 10-90% moves
4. **Informational edge**: Domain expertise in 3-5 market categories
5. **Contrarian**: Fade emotional crowd overpricing — 15-20% returns on corrections

Current implementation: spread capture (similar to market making).
Next target: cross-platform arbitrage (lowest risk, highest certainty).

## Technical Context

- Runtime: Next.js 15 with TypeScript (strict mode)
- UI: Tailwind CSS + shadcn/ui + React Query
- Database: PostgreSQL + Drizzle ORM with 16 migrations
- Testing: vitest with 491 passing tests
- Notifications: Telegram via OpenClaw CLI (digest mode)
- API routes: 17 routes
- Pages: 3 (homepage, venue-orders, preview)
- Execution: 4 modules (executor, persistence, reconciliation, venue loader)
- Providers: 10 modules (Kalshi, Polymarket REST/WS/CLOB, Odds API, etc.)
- Runners: 7 CLI scripts
- Deployment: Vercel (config ready), VPS for runners
- Orchestration: Hydra with research, agent memory, Kanban backlog

## 2026-04-22 Current-State Override

The earlier phase and pain-point notes in this file are stale where they conflict with `direction/priorities.md` or current cycle telemetry. Treat the latest priorities file as authoritative for current execution state.

Current verified baseline:
- `main` is green with 2232 passing tests and clean typecheck in the 2026-04-22 cycle window.
- Kalshi single-venue live trading is code-complete and operator-approved; do not plan additional generic preflight or hardening work for that path unless a new failing verification or operator directive appears.
- Cross-venue KXNBA arbitrage execution is wired for approved Kalshi-Polymarket pairs with persisted per-leg submit/no-submit artifacts and terminal-proof requirements.
- Remaining hard blockers are operator live execution of one real dual-leg run and missing `OPENAI_API_KEY` for live LLM nominations.

## Blocker Deduplication
- When multiple blocked items share the same external dependency, missing credential, or operator action, treat them as one unblock campaign.
- Prefer the smallest task that retires the shared blocker for every linked item instead of tracking parallel blocked work with the same root cause.

## Empty-Intake Blocker Retirement Rule

When `Backlog: 0` and `Queued: 0` but one or more operator-important items remain `Blocked`, treat blocked-item retirement as the primary throughput goal for the next planning window. Prefer the smallest verifiable unblocker, readiness probe, or dependency confirmation for one blocked item over another adjacent doc, proof-surface, or research slice. If no unblock step is currently possible, the selected task or report must name the exact external dependency that still prevents movement.
