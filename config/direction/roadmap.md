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

Deliver real-money cross-venue proof, route-level execution evidence, and operator-visible monitoring for sports-first arbitrage.

- [x] Expose Polymarket matched-vs-confirmed residual exposure states in run packets
- [x] Add Polymarket CLOB V2 production smoke proof to arbitrage run packets
- [x] Add route-level sports execution quality summary
- [x] Add sports route-mode decision to run-cycle packets
- [x] Add Polymarket reward price-distance discount evidence
- [x] Persist Kalshi batch orderbook timestamp evidence in run packets
- [x] Add Kalshi RFQ visible-book route quality comparator
- [ ] Migrate to Polymarket v3 API keys before June 1 deadline
- [ ] Validate Polymarket CLOB V2 execution end-to-end (V2 went live April 28)
- [ ] Add Polymarket ghost-fill detection and position reconciliation
- [ ] Persist Polymarket V2 per-sport fee evidence and pUSD collateral lifecycle
- [ ] Enforce daily loss limit and kill switch in executeArbitrage() (not just API route)
- [ ] Add execution alerting (Telegram) for partial_needs_unwind, circuit breaker trips, stuck orders
- [ ] Instrument execution latency tracking end-to-end
- [ ] Track sports arbitrage opportunity half-life from first detection through expiry
- [ ] Wire Polymarket US preview, slippage, and AUTOMATIC proof into live sports legs
- [ ] Persist Kalshi account limits, rate-limit token buckets, and fractional trading fields

## M7: Sports Forecast Trust & Sizing Compounding
status: planned
started:
completed:

Use settled sports outcomes, CLV, and source reliability to compound sizing toward the most accurate signals.

- [x] Expose settlement update audit fields for forecast outcome sync
- [x] Update unresolved sports forecast outcomes on settlement sync
- [x] Persist sportsbook fair-line sizing basis on candidates
- [x] Carry sportsbook fair-line edge into run-cycle sizing preview
- [x] Expose sports replay summaries on calibration dashboard
- [x] Add OpticOdds sharp-line fair-value adapter for CLV benchmarking
- [ ] Convert calibration outcomes and Pinnacle CLV into source trust weights
- [ ] Feed source trust weights into sports run-cycle sizing previews
- [ ] Show calibration-backed sizing rationale on the calibration dashboard

## M8: Sports Operator Workflow & Scale
status: planned
started:
completed:

Improve operator throughput once the live proof and trust-weighted sizing loops are in place.

- [ ] Make kill switch, daily loss limit, and risk settings editable from dashboard
- [ ] Add auto-refresh / live polling to dashboard pages
- [ ] Surface circuit breaker state and recovery queue in dashboard
- [ ] Add execution timeline / unified activity log page
- [ ] Add venue maintenance window visibility and execution-blocking indicators
- [ ] Add a compact live sports opportunity queue across arbitrage, markets, and venue orders
- [ ] Optimize forecast outcome sync away from full-table terminal order scans when history grows

## M9: Execution Speed & Latency Optimization
status: planned
started:
completed:

Address the collapsing arb half-life (2.7s avg, 3.6s NBA) by optimizing execution latency.

- [ ] Implement WebSocket-based Kalshi price monitoring via orderbook and ticker channels
- [ ] Profile and benchmark dual-leg submission latency end-to-end
- [ ] Add parallel first-leg and second-leg pre-positioning for near-simultaneous execution
- [ ] Add venue API timeout and retry budget enforcement for dual-leg execution
- [ ] Add execution-speed metrics to run packets (time-to-first-fill, total-round-trip)
- [ ] Consume Kalshi order_group_updates WebSocket channel for real-time lifecycle events
- [ ] Consume Kalshi fractional trading and settlement_value fields for precision sizing

## M10: Sharp-Line Benchmarking & Multi-Venue Expansion
status: planned
started:
completed:

Replace restricted Pinnacle API with aggregated sharp-line data and explore new venue opportunities.

- [x] Add OpticOdds odds-fetching capability (fetchOdds with Zod schemas)
- [ ] Wire OpticOdds unified odds API as sharp-line benchmark
- [ ] Seed FIFA World Cup 2026 verified pair registry (June 11 - July 19)
- [ ] Build NBA Finals rapid pair seeding pipeline (Finals start June 3)
- [ ] Integrate SportsDataIO injury and lineup feed for line-movement alpha
- [ ] Add MLB Polymarket-Sportradar official data advantage to scanner pair matching
- [ ] Model Kalshi combo contracts for multi-leg correlation arbitrage
- [ ] Implement Polymarket builderCode attribution and maker rebate tracking
- [ ] Integrate Oddpool cross-venue spread alerts as secondary scanner validation
- [ ] Evaluate FanDuel Predicts (CME Group) and Hyperliquid HIP-4 as future venues
