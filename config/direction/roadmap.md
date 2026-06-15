# Roadmap

## M1: Project Foundation
status: complete
started: 2026-03-30
completed: 2026-03-31

Scaffold the project, define architectural contracts, and establish the schema baseline.

- [x] Scaffold Next.js project with TypeScript, Tailwind, shadcn/ui
- [x] Set up PostgreSQL with Drizzle ORM and migration system
- [x] Define market ingestion contract (Odds API runtime shape)
- [x] Define EV scanner contract (matching, freshness, +EV output)
- [x] Define Pinnacle fair line contract (no-vig derivation)
- [x] Project README and north-star PRD

## M2: Market Data Pipeline
status: complete
started: 2026-03-31
completed: 2026-04-01

Ingest odds from multiple books, derive Pinnacle fair lines, scan for +EV, and deliver alerts.

- [x] Odds API ingestion pipeline (60-second cadence, per-sport serialization)
- [x] Market snapshot normalization and idempotent persistence
- [x] Pinnacle no-vig fair line calculator
- [x] +EV scanner with deterministic event/market matching
- [x] Telegram alert delivery for actionable +EV opportunities
- [x] Basic dashboard with upcoming events and odds coverage

## M3: Prediction Market Providers
status: complete
started: 2026-04-01
completed: 2026-04-05

Integrate Kalshi and Polymarket as trading venues with full API client coverage.

- [x] Kalshi API client (orders, fills, balances, positions)
- [x] Polymarket CLOB API client (orders, fills, book state)
- [x] Market snapshot normalization for prediction markets
- [x] LLM probability estimator (paper mode)
- [x] Calibration dashboard for model evaluation
- [x] Paper trade candidate selection pipeline

## M4: Execution & Reconciliation
status: complete
started: 2026-04-05
completed: 2026-04-10

Build the execution pipeline: order placement, fill tracking, reconciliation, and bankroll controls.

- [x] Kalshi order placement pipeline
- [x] Polymarket order placement pipeline
- [x] Reconciliation worker with terminal state tracking
- [x] Bankroll caps and exposure limits
- [x] Venue order persistence and audit trails
- [x] Structured rejection evidence (buying-power, drift, malformed)
- [x] Combined prediction-market reconciliation worker

## M5: Cross-Venue Arbitrage Foundation
status: complete
started: 2026-04-08
completed: 2026-04-19

Scan for cross-venue arbitrage, execute-ready nominations, and durable audit trails.

- [x] Arbitrage opportunity scanner (Kalshi + Polymarket verified pairs)
- [x] Sequential dual-leg submission flow with second-leg routing safeguards
- [x] Per-leg venue order proof mapping and residual exposure tracking
- [x] Arbitrage preflight/readiness checks with structured no-submit evidence
- [x] Verified KXNBA Kalshi-Polymarket pair registry seeded and consumed
- [x] Execute-path nomination sizing and deterministic candidate ordering
- [x] Persisted cycle-run metadata and execution/reconciliation audit trails

## M6: Live Arbitrage Proof & Premium Operator Monitoring
status: complete
started: 2026-04-21
completed: 2026-06-09

Deliver real-money cross-venue proof, hardened execution controls, and operator-grade monitoring for sports-first arbitrage.

- [x] Add Kalshi Fill Latency Percentile Helper
- [x] Add AI Agent Margin Compression Helper
- [x] Add Dashboard Exposure Risk Matrix
- [x] Add Polymarket CLOB provider rate limiting
- [x] Fix Kalshi IOC partial-fill second-leg sizing to actual fill_count_fp
- [x] Fix fee-inclusive arbitrage run profitability timeline P&L
- [x] Wire Polymarket CLOB V2 client (sdk-v2-compat, pUSD collateral)
- [x] Verify Polymarket CLOB V2 live submit path end-to-end
- [x] Adopt Kalshi order_group_updates WS account channel
- [x] Migrate Kalshi off deprecated /portfolio/orders to V2 /trade-api/v2/orders
- [x] Extend SportsDataIO injury feed to MLB + MLS
- [x] Add sharp-book lead-lag evidence to sports route ranking
- [x] Wire live Kalshi GET /margin/fee_tiers per-market maker/taker map (#43, #44, #47)
- [x] Surface Kalshi earned rate-limit tier + token-budget headroom on submit preflight
- [x] Fix web/src/lib/arbitrage/scanner.test.ts standalone @/-alias resolution (#42)

## M7: Signal Wiring & Learning Loop Closure
status: complete
started: 2026-06-08
completed: 2026-06-09

Wire the built pure modules into production paths and close the measurement feedback loops.

- [x] Wire SportsPairRankingEvidenceRow into run-cycle persistence (#65)
- [x] Wire sports-time-to-signal-buckets into calibration output (#61)
- [x] Wire World Cup 2026 settlement-timing into scanner Opportunity output (#57)
- [x] Wire opportunity-half-life-and-depth summarizer into scan-history accumulation (#59)
- [x] Surface loadOpportunityHalfLifeHistory in a scanner API route (#65)
- [x] Rename PolymarketExecutionResult.executed to submitted (#60)
- [x] Wire nba-finals-pair-seeding into verified-pair registry seeding (#62)
- [x] Per-sport and per-pair P&L attribution breakdown (#63)
- [x] Retire deprecated pinnacle* field aliases from SportsbookPredictionEdgeSignal (#64)

## M8: Catalyst Wiring & Pre-Live Safety
status: complete
started: 2026-06-09
completed: 2026-06-09

Wire the remaining zero-caller pure modules, close the last learning-loop gaps before first real-money dual-leg runs, and add operator-visibility tools for WC 2026.

- [x] Wire accumulateSportsTimeToSignal into calibration route (#74)
- [x] Surface buildWorldCupArbClusteringHeatmap via API route (#69)
- [x] Wire buildSportExposureClusters into preflight risk check (#68)
- [x] Wire summarizeVenueOrderPnlPhasesByPolicy into PnL page (#67)
- [x] Add circuit breaker status indicator to SiteNav (#66)
- [x] Add error observability to WebSocket silent catch blocks (bd11a263)
- [x] Wire detectSettlementOrphans into reconciliation health route (c6eb5a7c)
- [x] Wire Kalshi incentive-maker ranking into KXWC+KXNBA scanner candidate ranking (8a36ad23)
- [x] Wire settlement-criteria preflight into arbitrage execute route (88ac675d)
- [x] Wire Kalshi 0DTE sports scanner into GET /api/scanner/0dte-sports (#73)
- [x] Wire phase-aware Polymarket maker-reward EV into sports candidate ranking (#72)
- [x] Wire fill-rate-discrepancy + slippage attribution into operator-health (#71)
- [x] Surface sequential dual-leg latency-SLA breaches in execution-timeline (#70)
- [x] Wire sports-catalyst-response-cohorts into calibration route (#74)
- [x] Source Polymarket reward phase overrides into run-cycle ranking (#75)

## M9: Capital Velocity & Execution Lifecycle
status: complete
started: 2026-06-09
completed: 2026-06-10

Wire the remaining zero-caller execution and accounting modules to complete the pre-live operator readiness picture.

- [x] Wire operator-day-accounting.ts into daily P&L summary route + /wagers page (#76)
- [x] Wire fund-distribution-monitor.ts into operator health dashboard
- [x] Wire settlement-velocity-allocation.ts into dual-leg sizing preflight (#77)
- [x] Wire venue-maintenance-deferral.ts into execute route preflight (#78)
- [x] Wire polymarket-builder-revenue-share-reconciler.ts into daily reconciliation runner (#79)
- [x] Wire maker-order-lifecycle.ts into Polymarket GTD maker order management (#80)
- [x] Wire settlement-verification-polling.ts into reconciliation poll seam (#81)

## M10: Route Performance & Execution Quality Closure
status: complete
started: 2026-06-10
completed: 2026-06-10

Close the remaining execution-quality feedback loops: route decision performance attribution, Polymarket maker rebate accounting, settlement capital efficiency measurement, pre-execution order ticket preview, fill truth joins, rate-cost proof tracking, and the first Polymarket NegRisk live execution path for WC 2026 tournament winner markets.

- [x] Wire route-decision-analytics.ts into route performance summary route — GET /api/execution/route-decision-summary (#83)
- [x] Wire polymarket-fee-details.ts into Polymarket reconciliation fill processing (#84)
- [x] Wire scanner-order-ticket-preview.ts into GET /api/scanner/order-ticket-preview (#85)
- [x] Wire polymarket-snapshot-fill-truth.ts into Polymarket reconciliation poll seam (#86)
- [x] Wire kalshi-rate-cost-proof-packet.ts into live Kalshi submit-audit proof (#87)
- [x] Wire polymarket-negative-risk-live-plan.ts into NegRisk live execution plan resolver (paper-default, env-gated) (#88)
- [x] settlement-capital-efficiency.ts — wired in M9 via settlement-velocity-allocation preflight

## M11: Combinatorial Expansion & Signal Completeness
status: complete
started: 2026-06-10
completed: 2026-06-11

Activate the remaining zero-caller scan and fee infrastructure: splice live Kalshi fee rates into the sports discovery ranking path (money-critical), complete the Polymarket maker order management adapter, wire NegRisk exit pricing to close the WC 2026 live plan loop, activate the Polymarket sports combinatorial scan and Kalshi combo basket scanner, close the maker reward ledger accounting gap, and wire the sports pair candidate eligibility marker into the discovery pipeline.

- [x] Wire kalshi-live-fee-rate-splice.ts into sports discovery match pre-ranking path (#90)
- [x] Wire polymarket-maker-order-management.ts into Polymarket GTD maker-order polling cycle (#91)
- [x] Wire polymarket-negative-risk-exit-pricing.ts into NegRisk exit-plan resolver (#92)
- [x] Wire buildAndRankNbaCombinatorialScanCandidates into GET /api/scanner/combinatorial-candidates (#94)
- [x] Wire detectComboVsBasketCandidates (+ kalshi-bundle-decomposition + kalshi-combo-probability) into combo-basket scan path (#95)
- [x] Wire projectPolymarketSportsMakerRewardLedgerEntries into builder revenue-share reconciliation (#96)
- [x] Wire markPolymarketSportsPairCandidatesScannerEligible into sports-pair eligibility scan route (#97)
- [x] Machine-execution stack: approval-envelope-author (#99), adverse-selection gates (#102), aggregate limits (#108), auto-execution dispatcher behind default-off promotion gate (#117) — beyond-plan
- [x] Fix WC normalization dropping all 72 odds-api events + warning samples/drop alert (#118, #119) — beyond-plan
- [x] Individual wager list + per-wager lifecycle audit page (item-321) — beyond-plan

## M12: Funnel Production
status: active
started: 2026-06-12
completed:

Prove the pipeline produces. The wiring surface is complete through M11, but the funnel has never produced one opportunity end-to-end (1,400+ scanner runs ended zero_opportunities). With the WC ingestion fix (#118/#119) landed and the group stage live since June 12, M12 proves real flow through the existing stack instead of adding surface area. Machine-execution promotion gates stay default-off throughout.

Root cause (confirmed 2026-06-15): `seedVerifiedPairRegistryFromWorldCup2026StaticPairs()` function was built and committed (0121549a) but has NO production caller — `kalshi_polymarket_pair_registry` still holds only 13 stale rows, all May 13. Funnel binding gate confirmed `softBookNotReady` with `registryPairs: 0` via live API. BallDontLie timer files committed but timer not installed in production.

- [x] Verify WC ingestion flowing in production post-#118 — CONFIRMED: soccer_fifa_world_cup 68 events / 878 snapshots persisted as of June 13
- [x] Wire ScannerFunnelBreakdown through scanner-alert-runner → executeScannerCycle — CONFIRMED LIVE (GET /api/scanner/latest returns funnelBreakdown; binding gate `softBookNotReady`, entered 14402, registryPairs 0)
- [x] Expose funnel breakdown counts on GET /api/scanner/latest (item-507) — CONFIRMED LIVE
- [x] Add pair-resolution stage to funnel breakdown
- [x] WC 2026 knockout-stage pair discovery workflow (item-505) — pure builder built
- [x] WC pair settlement-eligibility predicate (item-508) — skips settled pairs
- [x] Passive fill-probability estimate from orderbook snapshots — pure module built
- [x] Run-packet replay scorer (item-409) + batch scorer (item-411) + per-strategy summaries
- [x] CLV scan-time bucketing pipeline (sport/source/lead-time) + Pinnacle CLV bridge wired
- [x] Sports strategy benchmark packet (item-454)
- [x] Derive injuryImpactSignal from BallDontLie runner output in verified-pair ranking
- [ ] Build production bin runner for seedVerifiedPairRegistryFromWorldCup2026StaticPairs and execute against live DB (priorities #1, blocking matched>0)
- [ ] Install hydra-betting-ball-dont-lie.timer in production (priorities #2, systemd unit committed but not deployed)
- [ ] Prove first opportunity end-to-end, or decompose zero_opportunities per gate with counts (item-501, priorities #3)
- [ ] Prove first end-to-end PAPER execution through the M7–M11 stack — gates stay off (item-502, priorities #4)
- [ ] Wire passive fill-probability into live sports candidate ranking path (priorities #5, unblocked after first opportunity)
- [ ] Calibration/learning loop receiving real WC group-stage samples — non-zero accumulator counts (priorities #6)
- [ ] Expand WC 2026 verified pair coverage to round-of-16+ matches via knockout discovery route (priorities #7, round-of-16 June 29)
