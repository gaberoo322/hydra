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
- 2026-04-29 | moderate | Sports calibration lifecycle and source attribution: CLV and settlement feedback are promising sizing inputs, and forecast outcome updates need durable source attribution so sportsbook fair-line and paper LLM estimates can be evaluated separately. Cooldown: 2026-05-13.
- 2026-05-07 | moderate | Sports-first Kalshi-Polymarket arbitrage strategy validation: structured sports identity, Polymarket US side inversion, OpticOdds capability metadata, and draw-aware soccer accounting are the highest-leverage domain findings. Cooldown: 2026-05-21.
- 2026-05-07 | moderate | Execution architecture health: the test baseline is strong and execution/reconciliation coverage is broad, but live safety should focus on projected exposure, fail-closed migration drift, oversized execute modules, and silent proof gaps. Cooldown: 2026-05-21.
- 2026-05-07 | moderate | Platform API changes for May 2026: Kalshi external-api hosts, fixed-point price_ranges, token-bucket limits, and order endpoint deprecation are immediate execution concerns; public Polymarket CLOB V2 docs do not independently confirm a V3-key migration deadline. Cooldown: 2026-05-21.
- 2026-05-07 | moderate | Research cycle research-2026-05-07-0748: Kalshi fixed-point pricing, Kalshi token budgets, Polymarket CLOB V2 execution metadata, projected exposure preflight, production migration drift, and provider degradation evidence are the most actionable sports execution hardening themes. Cooldown: 2026-05-21.

## Promising Leads

- Use Kalshi milestone IDs, target IDs, source IDs, and Polymarket structured sports metadata to replace title-overlap matching for verified sports pair seeding.
- Persist Polymarket US side-inversion route evidence in run packets to make long-side order semantics auditable.
- Gate sports scanner scope with OpticOdds supported-market and sportsbook activity metadata before attempting sharp-line comparisons.
- Add draw-aware fair-probability accounting for World Cup 1X2 markets before mapping compatible binary slices.
- Snapshot Polymarket CLOB V2 market metadata at execution time so fees, tick sizes, minimum order sizes, RFQ status, reward config, and taker-order-delay fields cannot drift from scan-time assumptions.
- Add route-level Kalshi token budget feasibility evidence before dual-leg execution, including remaining write budget before submit.
- Split the live execute route and execute-arbitrage module only after narrow fail-closed safety fixes land.
- Validate any Polymarket V3 credential deadline with operator or partner communications before treating it as public-doc-backed roadmap work.

## Unexplored Frontiers

- In-game sports state ingestion for lineup, injury, weather, referee, and schedule effects with explicit time-to-signal measurement.
- Market participant behavior modeling for liquidity withdrawal, stale quotes, and recreational overreaction around sports news.
- Settlement-rule and resolution-mechanics edge catalog for recurring sports contract families.
- Capital efficiency comparison between binary arbitrage, negative-risk sets, RFQ bundles, and maker-reward strategies under real fee schedules.
- Operator-facing live proof quality scoring that combines route freshness, projected exposure, migration health, venue latency, and reconciliation confidence.
- Venue-auth mode separation for Polymarket US retail versus Polymarket CLOB L2, pending operator credential confirmation.
