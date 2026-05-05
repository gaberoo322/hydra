---
updated: 2026-05-05
refreshedBy: claude-research
researchCycle: claude-research-2026-05-05
tags: [hydra, hydra/direction]
---
# Current state
Hydra's sports-first arbitrage stack is architecturally complete through M6. The test suite is green at 3614 passing tests with clean typecheck. The current scheduler session has 90% merge rate (18/20 merged, 0 rollbacks). Recent merges: structured Polymarket sports pair candidate mapper, slippage tolerance for Polymarket sports scanner sizing, Kalshi reconciliation mismatch fix, CLV sizing multiplier on prediction candidates, fill-adjusted EV delta to sports replay comparator, odds-only probability on prediction candidates.

Polymarket CLOB V2 went live April 28 with pUSD collateral, new order structs, and per-sport fee divergence. **Critical: v1/v2 API keys expire June 1, 2026 — v3 keys with Trading permission scope required.** Kalshi has fractional trading (mandatory since March 12), per-fill fee_cost, /account/limits with tiered rate limits, and order_group_updates WebSocket channel. Kalshi is also deprecating /portfolio/orders* endpoints no earlier than May 6.

FIFA World Cup 2026 starts June 11 with $341M+ traded and sustained 5-8 cent Kalshi-Polymarket spreads. NBA second round active, Finals start June 3. MLB season underway with Polymarket as exclusive MLB prediction market partner via Sportradar data. Polymarket sports maker rebates at 25% create incentive for maker-side liquidity provision.

Regulatory: CFTC ANPRM comment period closed April 30. Third/Ninth Circuit split headed to Supreme Court. Curtis-Schiff bill would reclassify sports contracts as gambling. 38 state AGs filed against prediction markets. Polymarket MLB-Sportradar MOU restricts certain market types.

# Priority tasks
## 1. Migrate to Polymarket v3 API keys before June 1 deadline
Polymarket's CLOB V2 migration deprecated v1/v2 API keys with a hard cutoff on June 1, 2026. v3 keys introduce explicit permission scopes (Read-Only vs Trading).
- **Why now**: 27 days until v1/v2 keys stop working. Hard prerequisite for all Polymarket live trading.
- **Done when**: v3 API keys generated and configured in all execution modules; health check validates key version on startup; auth error monitoring alerts on 401/403; v1/v2 key references removed.

## 2. Enforce daily loss limit and kill switch in the execution pipeline
The daily loss limit and operator kill switch are only enforced at the API route layer (operator-preflights). executeArbitrage() has no awareness of either gate. Any caller that invokes it directly bypasses both safeguards.
- **Why now**: Before the first real-money trade, every execution path must respect the kill switch and loss limit. A direct call from the scheduler without these gates could produce unbounded losses.
- **Done when**: executeArbitrage() checks kill switch and daily loss limit before venue submission. Daily loss limit aggregates realized + unrealized exposure. Tests verify rejection regardless of caller.

## 3. Seed FIFA World Cup 2026 verified pair registry
FIFA World Cup 2026 starts June 11 with 48 teams across 12 groups. Both Kalshi and Polymarket offer markets with $341M+ volume and sustained 5-8 cent spreads (2-3x wider than NBA).
- **Why now**: June 11 start is 37 days away. Peak opportunity window is group stage (first 2 weeks) when uncertainty is highest.
- **Done when**: Scanner discovers and matches Kalshi-Polymarket World Cup pairs for tournament winner and group winner markets; pair registry seeded with at least 48 tournament-winner outcomes; scanner prices spreads with per-sport fee rates.

## 4. Add execution alerting for partial_needs_unwind, circuit breaker trips, and stuck orders
Zero alerting integration in the arbitrage execution path. When a run transitions to partial_needs_unwind (one leg exposed), the operator learns about it only if they check the dashboard.
- **Why now**: A partial_needs_unwind means real money at risk with naked single-venue exposure. Without alerting, the operator could be asleep while the market moves against a naked position.
- **Done when**: Telegram notifications fire for: partial_needs_unwind status, recovery unwind failure, circuit breaker opening, stuck orders exceeding threshold. Alert delivery is idempotent.

## 5. Implement WebSocket-based Kalshi price monitoring via orderbook and ticker channels
Kalshi's WebSocket API provides real-time orderbook, ticker, and market_lifecycle channels. Replace REST polling with WebSocket subscriptions for actively scanned sports markets.
- **Why now**: With 3.6s NBA arb half-life, REST polling is too slow. WebSocket delivers sub-100ms updates — the single highest-leverage latency reduction available. NBA Finals (June 3) and World Cup (June 11) provide immediate calibration.
- **Done when**: Kalshi WebSocket connection with auto-reconnect; subscribed to orderbook+ticker channels for active sports markets; scanner consumes WebSocket updates; scan-to-detection time under 500ms.

## 6. Add Polymarket ghost-fill detection and position reconciliation
Polymarket V2 did not fully resolve the ghost fill problem (off-chain match confirmed but on-chain settlement fails). Undetected ghost fills corrupt position tracking and P&L.
- **Why now**: V2 just launched and ghost fill behavior is not yet well-characterized. pUSD collateral migration adds another failure mode. Must be solved before live trading.
- **Done when**: Position reconciliation checks on-chain settlement status for every fill; ghost fills detected and logged with alerts; retry/cancel logic handles unmatched fills.

## 7. Validate Polymarket CLOB V2 execution paths end-to-end
The CLOB V2 exchange upgrade went live April 28. Order structures changed, collateral moved to pUSD, SDK migrated to @polymarket/clob-client-v2. Per-sport fee rates diverge.
- **Why now**: V1 orders fail post-cutover. V2 fee divergence means mispricing EV by 1-3% across sports.
- **Done when**: Polymarket execution runner successfully places and tracks an order through V2 CLOB with pUSD collateral, per-sport fee rate consumed in route EV, reconciliation handles V2 fill structures.

# What's been completed (DO NOT re-propose)
- Add JSDoc header to Polymarket CLOB provider
- Normalize Polymarket CLOB header for health scanner
- Expose Polymarket residual exposure states in run packets
- Add CLOB V2 smoke proof to arbitrage run packets
- Expose settlement update audit fields for forecast outcome sync
- Persist sportsbook fair-line sizing basis on candidates
- Add route-level sports execution quality summary
- Update unresolved sports forecast outcomes on settlement sync
- Add sports route-mode decision to run-cycle packets
- Add price-distance discount to Polymarket sports reward EV
- Carry sportsbook fair-line edge into run-cycle sizing preview
- Record insufficient-depth RFQ comparison outcomes
- Expose sports replay summaries on calibration dashboard
- Match sports pairs by Polymarket sports metadata
- Add RFQ versus visible-book execution comparison to Kalshi RFQ runner
- Persist Kalshi batch orderbook timestamp evidence in run packets
- Add Kalshi RFQ visible-book route quality comparator
- Prove scanner route ranking can consume stream freshness evidence
- Persist Kalshi fill fee_cost in arbitrage run packets
- Fix verified-pairs missing DATABASE_URL isolation
- Add collateralAsset evidence to Polymarket live buying-power readiness
- Add forecast_outcomes migration and journal entry
- Add forecastOutcomes table schema and fix type narrowing
- Add per-leg fee evidence to sports arbitrage run-packets
- Add pUSD collateral readiness evidence to sports arbitrage run-packets
- Add stream freshness quality score to scanner route ranking
- Add order submission latency tracking to Kalshi and Polymarket executors
- Add per-sport V2 fallback fee rates and sportLeague evidence to scanner
- Add sportLeague to dashboard polymarket fee metadata display
- Display pUSD collateral readiness on dashboard execution run cards
- Display submission latency on venue-orders dashboard
- Add estimated half-life seconds computation to spread decay tracking
- Display spread half-life evidence on arbitrage scanner dashboard
- Add pUSD collateral shortfall evidence to run packet and dashboard
- Add pUSD collateral readiness to venue-orders loader and display
- Persist poll-to-terminal latency for Polymarket and display on venue-orders dashboard
- Add Kalshi account-limit preflight evidence to venue-orders loader and display
- Persist pUSD collateralAsset in second-leg venue-sizing audit evidence
- Add odds-fetching capability to OpticOdds provider (fetchOdds with Zod schemas)
- Add OpticOdds sharp-line fair-value adapter for CLV benchmarking
- Structured Polymarket sports pair candidate mapper
- Slippage tolerance for Polymarket sports scanner sizing
- Kalshi reconciliation mismatch fix
- CLV sizing multiplier on prediction candidates
- Fill-adjusted EV delta to sports replay comparator
- Odds-only probability on prediction candidates

# What NOT to work on
- Do not re-propose completed items listed above.
- Do not prioritize politics, economics, or crypto markets over sports.
- Do not build new provider abstractions when existing modules can be extended.
- Do not spend cycles on generic defensive work, broad refactors, or test-only hygiene unless directly required by a priority task.
- Do not propose OPENAI_API_KEY configuration tasks — it's already configured.
- Do not propose V1 CLOB work — V2 is now live and V1 is deprecated.
- Do not build Hyperliquid or FanDuel Predicts venue adapters until those platforms have confirmed mainnet/API availability.
- Do not build DraftKings Predictions integration until API access is confirmed available.

# Regulatory awareness
The CFTC ANPRM comment period closed April 30. CFTC has sued 5 states (AZ, CT, IL, NY, WI) asserting CEA preemption. Third Circuit ruled 2-1 for Kalshi; Ninth Circuit panel leaned Nevada's way — likely circuit split headed to Supreme Court (64% market-implied cert probability by end of 2026). The Curtis-Schiff "Prediction Markets Are Gambling Act" (S.4160) would reclassify sports contracts as gambling with bipartisan support. 38 state AGs filed against prediction markets April 28. Arizona filed criminal charges against Kalshi in March. Monitor weekly; no code changes needed unless platform rules change. Polymarket's MLB-exclusive deal with Sportradar/CFTC integrity MOU restricts certain market types (individual pitches, manager decisions, umpire performance) — scanner should filter these.
