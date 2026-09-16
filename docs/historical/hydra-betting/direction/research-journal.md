# Research Journal

This journal tracks what has been explored, what was fruitful, and what remains unexplored.
The Director updates it after each research cycle. Researchers read it to avoid re-treading
old ground and to deepen investigation in promising areas.

## Explored Areas

<!-- Areas that have been researched. Each entry has a date, depth level (surface/moderate/deep),
     key findings, and a cooldown date (don't re-research until after this date). -->

- 2026-04-29 | moderate | Execution-aware sports prediction-market trading across Kalshi and Polymarket US: rate-limit token budgets, WebSocket freshness, Polymarket matched-vs-confirmed terminality, and drawdown-aware sizing are now the most useful execution-quality inputs for sports arbitrage packets. Cooldown: 2026-05-13.
- 2026-04-29 | moderate | Technical architecture and calibration lifecycle: the repo has strong execution/reconciliation proof surfaces, but sports calibration can lose later settlement updates because forecast outcome sync is insert-only; source attribution should distinguish sportsbook_fair_line from paper_llm. Cooldown: 2026-05-13.
- 2026-04-29 | moderate | Current platform API changes for live sports execution: Kalshi exchange status, historical endpoint partitioning, fractional/subpenny fields, and Polymarket CLOB V2 production cutover on 2026-04-28 should inform bounded live-run proof surfaces. Cooldown: 2026-05-13.
- 2026-04-29 | moderate | Polymarket US sports reward and execution microstructure: sports liquidity rewards use target sizes, price-distance discounts, per-second random snapshots, and score-share dilution; sports orders also face start-time cancellation and marketable-order delay, so maker reward capture and taker arbitrage need separate route logic. Cooldown: 2026-05-13.
- 2026-04-29 | moderate | Sports calibration lifecycle and source attribution: CLV and settlement feedback are promising sizing inputs, and forecast outcome updates need durable source attribution so sportsbook_fair_line, paper_llm, catalyst, and cross-venue signals are not blended together. Cooldown: 2026-05-13.
- 2026-05-11 | moderate | Sports-first feature direction after defensive-heavy work: the system already has execution, reconciliation, verified pairs, CLV-gated sizing, injury recency ranking, and fair-line ingestion, so next priorities should wire existing evidence into ranking and replay rather than add broad hardening. Cooldown: 2026-05-25.
- 2026-05-11 | moderate | Normalized prediction-market depth APIs: OpticOdds documents exchange depth, source IDs, streaming updates, limits, and historical prices across Kalshi, Polymarket, Polymarket USA, SX Bet, Sporttrade, Novig, BetDEX, and Betfair, making verified pair intake a practical integration target. Cooldown: 2026-05-25.
- 2026-05-11 | moderate | Fee-aware sports edge ranking: Polymarket sports fees, maker economics, and Kalshi centicent fee rounding can materially change realized edge, and the repo already has fee-economics modules that can be promoted from reconciliation evidence into candidate scoring. Cooldown: 2026-05-25.
- 2026-05-11 | moderate | Prediction-market calibration by venue, domain, horizon, and liquidity: recent calibration research supports sports-specific correction and cohort reporting rather than treating raw market prices as uniform probabilities. Cooldown: 2026-05-25.
- 2026-05-11 | surface | May 2026 Kalshi and Polymarket API changes: Kalshi ts_ms, endpoint costs, orderbook_delta snapshots, post_only quotes, canonical outcome_side/book_side fields, and Polymarket CLOB V2 production cutover create useful timestamp and execution evidence, but this cycle converted them into feature priorities rather than hardening tasks. Cooldown: 2026-05-18.
- 2026-05-11 | moderate | Executable sports arbitrage half-life and depth constraints: 2026 Polymarket NBA research found very few executable in-game arbitrage windows, short median duration, and severe executable-size limits for many combinatorial opportunities, so Hydra should rank depth-adjusted tradable value ahead of headline edge. Cooldown: 2026-05-25.
- 2026-05-11 | moderate | Sports ranking persistence gaps: the codebase computes richer fee, rounding, slippage, CLV, source-trust, and depth evidence than it persists, and paper review currently excludes Polymarket candidates despite ranking support. Cooldown: 2026-05-25.
- 2026-05-11 | moderate | Catalyst timing as sports edge: lineup, inactive, and injury timestamps can be measured as price-response cohorts against sharp-book movement and prediction-market lag, making time-to-signal a forecast feature rather than a generic freshness flag. Cooldown: 2026-05-25.
- 2026-05-11 | surface | Polymarket orderbook trade-ground-truth limits: public orderbook feed inference should be separated from confirmed trade, matched, mined, and settlement evidence when reporting paper replay or execution quality. Cooldown: 2026-05-18.

## Promising Leads

- Polymarket sports candidates should be wired into paper review before larger cross-venue calibration work, because it is a bounded path to venue parity.
- Fee-adjusted candidate ranking should persist pre-fee edge, fee-adjusted edge, fee source, rounding assumption, depth evidence, CLV bucket, source trust, and rank delta.
- Timestamp-locked sports nomination replay can convert run-packet, Kalshi `ts_ms`, venue snapshot, and Pinnacle fair-line evidence into a decision-quality metric.
- Lineup, inactive, and injury catalysts should be measured as response cohorts before being used as larger automated timing boosts.
- Executable depth and opportunity half-life should become ranking inputs for sports arbitrage and complete-set candidates.
- Provider-native depth IDs from OpticOdds, Oddpool, or Kwery remain promising for expanding verified pair intake after ranking evidence is durable.

## Unexplored Frontiers

- SportsGameOdds and Odds-API.io normalized prediction-market coverage compared directly against OpticOdds for event ID stability, depth quality, latency, and cost.
- Soccer 1X2 complete-set scanning with fair-line comparison and variable tick-size handling.
- Maker-style sports experiments using Kalshi post_only quotes and Polymarket reward economics, kept separate from taker arbitrage routing.
- Referee, weather, travel, rest, and schedule-derived sports signals as first-class candidate source cohorts.
- In-game state ingestion for low-latency sports dislocation detection once pre-game ranking and replay metrics are measurable.
- Trade-ground-truth evaluation for Polymarket paper replay using confirmed transaction, matched, mined, and settlement evidence rather than public orderbook inference alone.

> Research-loop codex agents disabled 2026-05-13 (#342). New research flows through /hydra-target-research.
