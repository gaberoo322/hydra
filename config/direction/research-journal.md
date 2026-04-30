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
- 2026-04-29 | moderate | Sports calibration lifecycle and source attribution: CLV and settlement feedback are promising sizing inputs, but unresolved outcomes can be hidden from future updates and source trust needs explicit attribution before sizing can safely compound. Cooldown: 2026-05-13.
- 2026-04-30 | moderate | Net-edge sports arbitrage economics: Kalshi fill-level fees/rounding and Polymarket per-market fees can erase small spreads, so dynamic venue-fee evidence should be persisted directly in sports arbitrage run packets and candidate ranking. Cooldown: 2026-05-14.
- 2026-04-30 | moderate | Competitive arbitrage landscape: continuous Kalshi/Polymarket scanning, live pairs, API access, and automated-execution roadmaps make raw spread detection less durable; opportunity half-life is the better differentiator. Cooldown: 2026-05-14.
- 2026-04-30 | moderate | Execution-realistic replay standard: PredictionMarketBench-style evaluation emphasizes raw books, trades, lifecycle, settlement, maker/taker semantics, and fees, validating Hydra's evidence-heavy paper/live proof direction. Cooldown: 2026-05-14.
- 2026-04-30 | moderate | Sports calibration-to-sizing path: forecast outcomes, Pinnacle no-vig CLV, Brier score, and log-loss should become source trust weights now that settlement-updatable outcomes and fair-line sizing evidence exist. Cooldown: 2026-05-14.
- 2026-04-30 | moderate | Platform API changes for live execution: Kalshi nested token bucket account limits and endpoint costs, plus Polymarket US preview/slippage/automation fields, are high-value bounded additions to run-packet proof. Cooldown: 2026-05-14.

## Promising Leads

- Build a fee-aware sports arbitrage economics layer that compares raw spread, venue-fee drag, rounding drag, and final executable cents per contract.
- Measure opportunity half-life per verified sports pair and use it as an execution-priority feature for dual-leg routes.
- Convert Pinnacle CLV and settled forecast outcomes into source-level trust weights that adjust sports candidate sizing.
- Use Polymarket US private WebSockets for repeated order/position state once credentials and live volume justify moving beyond REST proof capture.
- Persist Kalshi endpoint-cost and account-limit snapshots so live sports submit timing can be explained from actual account constraints.

## Unexplored Frontiers

- Referee tendencies, player prop injury sensitivity, and lineup announcement latency as sports forecast features.
- In-game state ingestion for sports markets where platform rules and liquidity support fast repricing.
- Sports resolution-rule discrepancy mining across Kalshi, Polymarket, and sportsbook market definitions.
- Behavioral liquidity patterns around recreational sports events, especially primetime games and playoff narratives.
- Maker-versus-taker route selection for Polymarket sports reward capture versus fast arbitrage execution.
- Portfolio-level correlation between simultaneous sports arbitrage positions across teams, leagues, and venues.
