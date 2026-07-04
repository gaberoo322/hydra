---
name: Algorithmic Betting Platform
updated: 2026-07-03
status: active
owner: strategist
tags: [hydra, hydra/direction]
---

# Goals

## Current Phase

The project is executing **M13 — Forecast-Directional Execution**. Cross-venue arbitrage was retired as a strategy (ADR-0002, 2026-06-22); the full execution, risk, recovery, and settlement layer is retained as a **single-leg directional execution** surface that expresses forecast edge. The focus now:

- Accumulate Brier-scored paper-trade evidence on WC 2026 and sports fixtures via the calibrated forecast pipeline
- Close the nomination timing gap so the directional nomination runner surfaces candidates consistently (freshness-window / timer alignment)
- Deploy the pregame scanner to generate `forecast_outcomes` rows with `source: "scanner"` and close the calibration feedback loop
- Complete the ADR-0002 step-3 tail (relocate remaining `lib/arbitrage/` imports in `lib/execution/` and `app/api/`) ahead of the step-4 deletion

**For current execution state, `priorities.md` and `roadmap.md` are authoritative** — this file carries the durable goals, constraints, and infrastructure facts that change rarely.

## Success Metrics

| Metric | Target | Category | Source |
|--------|--------|----------|--------|
| Forecast calibration (Brier, aggregate) | ≤0.18 | profitability | outcomes.yaml `forecast-calibration-brier` |
| Bet execution success rate | >99% | reliability | venue_orders table |
| System uptime | >99.5% | reliability | process monitor |
| Test suite + TypeScript strict mode | green | architecture | npm test / typecheck |
| Monthly ROI (live) | >15% | profitability | daily P&L accounting (M9) |
| Max drawdown (live) | <15% | risk_management | daily P&L accounting (M9) |
| Win rate (live) | >55% | profitability | daily P&L accounting (M9) |

## Focus Weights

- profitability: 30
- reliability: 25
- architecture: 20
- risk_management: 15
- ui_ux: 10

## Constraints

- Must support Kalshi and Polymarket as primary platforms
- Every strategy passes through Graduated Capital stages (`vision.md`) — paper first, always
- Never risk more than 2% of total bankroll on a single bet
- Never have more than 20% of bankroll in open positions simultaneously
- All bets must be logged with timestamps, reasoning, odds, and outcomes
- Must gracefully handle API outages — never bet on stale data
- No hardcoded API keys or secrets in source code
- Must be recoverable from any crash state without manual intervention
- NEVER delete provider or execution files
- All LLM inference runs on local Ollama (Tailnet) — no cloud inference APIs

## Infrastructure

The system runs on a dedicated Intel NUC (always-on home server). All agents, services, and the target project run locally. No Vercel — everything self-hosted behind Cloudflare tunnel.

**Hardware:**
- CPU: 13th Gen Intel i3-1315U (8 threads)
- RAM: 64 GB
- Storage:
  - `/` — 2TB NVMe (Solidigm), 100GB LVM partition, hosts OS + code + working trees
  - `/mnt/hydra-ssd` — 500GB Samsung 860 EVO (USB 3.0), hosts Docker, npm cache, Playwright browsers
- Network: Cloudflare tunnel — admin.clawstreetbets.xyz (orchestrator API), hydra.clawstreetbets.xyz (betting app)
- LLM inference: local Ollama on the Tailnet gaming PC (RTX 5080 16GB)

**Deployment architecture:**
- Hydra orchestrator, Redis, OpenViking — all run locally as systemd user services (the dashboard is served by the orchestrator's Express process from `dashboard/dist`)
- hydra-betting web app — Next.js production server locally (port 3333), served via Cloudflare tunnel
- Checkpoint refresh, ingestion, scanner, alerts, prediction-market-cron — systemd timers

**Storage rules for agents:**
- Large generated artifacts (test fixtures, execution receipts, data dumps) go to `/mnt/hydra-ssd/` not the NVMe
- Docker is on the SSD — do not move it back to NVMe
- npm cache and Playwright browsers are symlinked to the SSD
- The NVMe has ~58GB free — do not let it fill below 20GB

## Supported Platforms

- **Kalshi**: Full pipeline, live fee-tier and rate-limit-tier integration, post-only maker support
- **Polymarket US**: Full pipeline on CLOB V2 (REST + WS + SDK), GTD maker orders, builder revenue share
- **The Odds API**: Sportsbook ingestion pipeline fully operational (fair-line derivation, +EV scanning)

## Blocker Deduplication

- When multiple blocked items share the same external dependency, missing credential, or operator action, treat them as one unblock campaign.
- Prefer the smallest task that retires the shared blocker for every linked item instead of tracking parallel blocked work with the same root cause.

## Empty-Intake Blocker Retirement Rule

When `Backlog: 0` and `Queued: 0` but one or more operator-important items remain `Blocked`, treat blocked-item retirement as the primary throughput goal for the next planning window. Prefer the smallest verifiable unblocker, readiness probe, or dependency confirmation for one blocked item over another adjacent doc, proof-surface, or research slice. If no unblock step is currently possible, the selected task or report must name the exact external dependency that still prevents movement.
