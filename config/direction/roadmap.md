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
status: active
started: 2026-04-21
completed:

Deliver real-money cross-venue proof, hardened execution controls, and operator-grade monitoring for sports-first arbitrage.

- [x] Add Kalshi Fill Latency Percentile Helper
- [x] Add AI Agent Margin Compression Helper
- [x] Add Dashboard Exposure Risk Matrix
- [x] Add Polymarket CLOB provider rate limiting
- [x] Fix Kalshi IOC partial-fill second-leg sizing to actual fill_count_fp
- [x] Fix fee-inclusive arbitrage run profitability timeline P&L
- [-] Project proposed trade size in single-market exposure preflight
- [-] Fail closed on pending migration drift
- [-] Require Kalshi price_ranges or price_level_structure for live execution
- [-] Persist Polymarket US side-inversion evidence in run packets
- [ ] Add venue-native sports identity matching before title fallback
- [ ] Add OpticOdds supported-market capability gating to scanner scope
- [x] Wire Polymarket CLOB V2 client (sdk-v2-compat, pUSD collateral) — went live upstream 2026-04-28
- [x] Verify Polymarket CLOB V2 live submit path end-to-end (pUSD signing, keyset<=100 pagination clamp, 200 req/s rate-limit ceiling) — item-402 closed; corrected from the false "V3 / June-15" premise
- [x] Adopt Kalshi order_group_updates WS account channel for live execution-state lead (item-483)
- [x] Migrate Kalshi off deprecated /portfolio/orders to V2 /trade-api/v2/orders (guard test in place)
- [x] Extend SportsDataIO injury feed to MLB + MLS
- [x] Add sharp-book lead-lag evidence to sports route ranking (item-429)
- [x] Wire live Kalshi GET /margin/fee_tiers per-market maker/taker map into resolveKalshiFeeRate — kalshi-margin-fee-tiers.ts + kalshi-margin-fee-tier-map.ts wired (#43, #44, #47 merged 2026-06-06/06-08) — priorities #2 COMPLETE
- [x] Surface Kalshi earned rate-limit tier (grants array, Premier/Paragon/Prime) + token-budget headroom on the dual-leg submit preflight — kalshi-rate-limit-tier-headroom.ts wired into live-submit-preview-draft.ts — completed 2026-06-08
- [x] Fix web/src/lib/arbitrage/scanner.test.ts standalone @/-alias resolution so the scanner's 162 tests run in isolation — #42 merged 2026-06-06 — priorities #1 COMPLETE
- [x] Build sports-pair-ranking-evidence-row mapper (mapStructuredSportsPairCandidatesToRankingEvidenceRows) — #46 merged 2026-06-08 — priorities #4 partial; persistence wiring is M7 #1
- [x] Wire depth/half-life penalty terms into sports-candidate-ranking.ts — observationHalfLifeMs + executableDepth penalty inputs live — priorities #5 partial; measurement feedback loop is M7 #4
- [x] Build sports-time-to-signal-buckets.ts (summarizeSportsTimeToSignalBuckets) — priorities #6 partial; calibration wiring is M7 #2
- [x] Verify Kalshi RFQ accepted-quote promotion carries post_only; detect PostOnlyCrossCancel in kalshi-executor.ts — #48, #49 merged 2026-06-08 — priorities #7 COMPLETE
- [ ] Wire SportsPairRankingEvidenceRow into run-cycle persistence — priorities #1 (new)
- [ ] Wire sports-time-to-signal-buckets into calibration output — priorities #2 (new)
- [x] Wire World Cup 2026 settlement-timing into scanner Opportunity output — #57 merged 2026-06-08; worldCupSettlementTiming live on Opportunity output
- [x] Wire opportunity-half-life-and-depth summarizer into scan-history accumulation — #59 merged 2026-06-08; opportunity-observation-accumulator + scanner/opportunity-half-life-history built and wired
- [ ] Rename PolymarketExecutionResult.executed to submitted — priorities #5 (new)
- [ ] Wire nba-finals-pair-seeding into the verified-pair registry seeding workflow — priorities #3 (new)
- [ ] Per-sport and per-pair P&L attribution breakdown — priorities #6 (new)

## M7: Signal Wiring & Learning Loop Closure
status: complete
started: 2026-06-08
completed: 2026-06-09

Wire the built pure modules into production paths and close the measurement feedback loops. No new pure modules — this milestone is about connecting existing signal infrastructure to durable outputs.

- [x] Wire SportsPairRankingEvidenceRow into run-cycle persistence (fee-adjusted ranking now durable) — #65 COMPLETE 2026-06-09
- [x] Wire sports-time-to-signal-buckets into calibration output (catalyst reaction lag measurable) — #61 COMPLETE; accumulator wiring is M8 #1
- [x] Wire World Cup 2026 settlement-timing into scanner Opportunity output (June 12 deadline) — #57 COMPLETE
- [x] Wire opportunity-half-life-and-depth summarizer into scan-history accumulation (observed half-life feeds ranking) — #59 COMPLETE
- [x] Surface loadOpportunityHalfLifeHistory in a scanner API route (measured half-life readable by dashboard) — #65 COMPLETE 2026-06-09
- [x] Rename PolymarketExecutionResult.executed to submitted (closes CONTEXT.md naming smell) — #60 COMPLETE 2026-06-08
- [x] Wire nba-finals-pair-seeding into verified-pair registry seeding (live pair discovery, enables WC) — #62 COMPLETE 2026-06-09
- [x] Per-sport and per-pair P&L attribution breakdown (closes learning loop for real-money readiness) — #63 COMPLETE 2026-06-09
- [x] Retire deprecated pinnacle* field aliases from SportsbookPredictionEdgeSignal (35 call sites) — #64 COMPLETE 2026-06-09

## M8: Catalyst Wiring & Pre-Live Safety
status: complete
started: 2026-06-09
completed: 2026-06-09

Wire the remaining zero-caller pure modules, close the last learning-loop gaps before first real-money dual-leg runs, and add operator-visibility tools for WC 2026.

- [x] Wire accumulateSportsTimeToSignal into a calibration route (catalyst reaction lag populated for WC) — POST /api/calibration/sports-time-to-signal + sports-catalyst-response-cohorts COMPLETE
- [x] Surface buildWorldCupArbClusteringHeatmap via API route (operator divergence-by-phase visibility ahead of June 12) — #69 COMPLETE
- [x] Wire buildSportExposureClusters into preflight risk check (sport-cluster correlation guard for real-money safety) — #68 COMPLETE
- [x] Wire summarizeVenueOrderPnlPhasesByPolicy into PnL page (scan edge vs slippage vs fee decomposition) — #67 COMPLETE
- [x] Add circuit breaker status indicator to SiteNav (at-a-glance execution health on every page) — #66 COMPLETE
- [x] Add error observability to WebSocket silent catch blocks (audit + annotate all provider WS handlers) — bd11a263 COMPLETE
- [x] Wire detectSettlementOrphans into reconciliation health route (pre-live orphan detection baseline) — c6eb5a7c COMPLETE
- [x] Wire Kalshi incentive-maker ranking into KXWC+KXNBA scanner candidate ranking — 8a36ad23 COMPLETE (beyond-plan)
- [x] Wire settlement-criteria preflight into arbitrage execute route — 88ac675d COMPLETE (beyond-plan)
- [x] Wire Kalshi 0DTE sports scanner into GET /api/scanner/0dte-sports — #73 COMPLETE (beyond-plan)
- [x] Wire phase-aware Polymarket maker-reward EV into sports candidate ranking — #72 COMPLETE (beyond-plan)
- [x] Wire fill-rate-discrepancy + slippage attribution into operator-health — #71 COMPLETE (beyond-plan)
- [x] Surface sequential dual-leg latency-SLA breaches in execution-timeline — #70 COMPLETE (beyond-plan)
- [x] Wire sports-catalyst-response-cohorts into calibration route — #74 COMPLETE (beyond-plan)
- [x] Source Polymarket reward phase overrides into run-cycle ranking — #75 COMPLETE (beyond-plan)

## M9: Capital Velocity & Execution Lifecycle
status: active
started: 2026-06-09
completed:

Wire the remaining zero-caller execution and accounting modules to complete the pre-live operator readiness picture. Focused on capital allocation, settlement verification, GTD order lifecycle, and daily P&L accounting.

- [ ] Wire operator-day-accounting.ts into daily P&L summary route + build /wagers page — priorities #1
- [ ] Wire fund-distribution-monitor.ts into operator health dashboard (venue rebalancing alerts) — priorities #2
- [ ] Wire settlement-velocity-allocation.ts into dual-leg sizing preflight (settlement-speed-aware stake) — priorities #3
- [ ] Wire settlement-verification-polling.ts into reconciliation polling job (active divergence detection) — priorities #4
- [ ] Wire maker-order-lifecycle.ts into Polymarket GTD maker order management (drift-triggered cancel/refresh) — priorities #5
- [ ] Wire polymarket-builder-revenue-share-reconciler.ts into daily reconciliation job (fee credit accounting) — priorities #6
- [ ] Wire venue-maintenance-deferral.ts into execute route preflight (maintenance-window execution deferral) — priorities #7
