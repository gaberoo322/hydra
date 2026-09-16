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
status: superseded
started: 2026-06-12
completed:

**SUPERSEDED 2026-06-22 — cross-venue arbitrage retired as a strategy ([ADR-0002](../docs/adr/0002-retire-cross-venue-arbitrage-strategy.md)).** This milestone aimed to prove the cross-venue arbitrage funnel produces its first opportunity end-to-end. The funnel never produced one (every scan candidate dropped at `softBookNotReady`; 0 opportunities ever), and arbitrage is now retired in favor of forecast-driven single-leg directional execution. The funnel this milestone chased is no longer a strategy. The unfinished items (execute WC pair seeder, seed R16 pairs, prove first opportunity) are **cancelled, not deferred.** The execution/risk/recovery machinery built here is salvaged into `lib/execution/` per ADR-0002. The `[x]` history below is preserved as a record. Forecast-directional execution supersedes this in M13.

Prove the pipeline produces. The wiring surface is complete through M11, but the funnel has never produced one opportunity end-to-end. With the WC ingestion fix (#118/#119) landed, the group stage live since June 12, and WC pair seeder + post-ingest scan trigger merged, M12 proves real flow through the existing stack. Machine-execution promotion gates stay default-off throughout.

Root cause (confirmed 2026-06-21): Three structural blockers remain. (1) `seedVerifiedPairRegistryFromWorldCup2026StaticPairs()` bin runner merged (PR #161) but never executed — registry holds 0 WC rows (`registryPairs: 0` in live funnel). (2) `scan-after-ingest.service` built (item-509) but not in `systemctl --user list-units`. (3) `hydra-betting-forecast-outcomes.timer` unit committed but not installed — `brierScore: null`. Three additional default-off autonomy timers committed but not deployed: arbitrage-recovery (item-526), automated-pair-review (item-529), arbitrage-auto-approval (item-536).

- [x] Verify WC ingestion flowing in production post-#118 — CONFIRMED: soccer_fifa_world_cup 44 events / 616 snapshots as of June 19 04:00 PDT
- [x] Wire ScannerFunnelBreakdown through scanner-alert-runner → executeScannerCycle — CONFIRMED LIVE (GET /api/scanner/latest returns funnelBreakdown; binding gate `softBookNotReady`)
- [x] Expose funnel breakdown counts on GET /api/scanner/latest (item-507) — CONFIRMED LIVE
- [x] Add pair-resolution stage to funnel breakdown
- [x] WC 2026 knockout-stage pair discovery workflow (item-505) — pure builder built
- [x] WC pair settlement-eligibility predicate (item-508) — skips settled pairs
- [x] Passive fill-probability estimate from orderbook snapshots — built AND wired into live ranking (PR #163)
- [x] PassiveFillProbability scanner detail view — operator can inspect fillProbability + source per opportunity (item-558, PR #196)
- [x] Run-packet replay scorer (item-409) + batch scorer (item-411) + per-strategy summaries
- [x] CLV scan-time bucketing pipeline (sport/source/lead-time) + Pinnacle CLV bridge wired
- [x] Sports strategy benchmark packet (item-454)
- [x] Derive injuryImpactSignal from BallDontLie runner output in verified-pair ranking
- [x] Build production bin runner for seedVerifiedPairRegistryFromWorldCup2026StaticPairs (PR #161) — MERGED, not yet run in production
- [x] Operator-triggerable WC-2026 knockout pair-discovery seed route POST /api/scanner/wc-knockout-seed (PR #162)
- [x] Scan/ingest cadence freshness signal on GET /api/status (item-511)
- [x] Post-ingest scan trigger module built (item-509, PR #173) — NOT YET deployed as systemd unit
- [x] WC 2026 R16 bracket scaffold + overlay builder (item-512, PR #171)
- [x] BallDontLie injury timer production-deployable + deployed as hydra-betting-nba-injuries.timer (PR #167)
- [x] BallDontLie injury timer window widened to WC knockout kickoffs 10:00–20:00 ET (item-557, PR #197)
- [x] Live-submit gated on local Ollama endpoint (PR #174)
- [x] Terminality-lead first-leg route decision + Kalshi token-bucket headroom wired (PRs #156–#158)
- [x] Automated verified-pair reviewer built + wired into default-off scheduled runner (item-529, PRs `850f0d52` + `5bfe8900`)
- [x] Stuck-order timeout tuning + auto-recovery trigger (item-374, PR `8a19e262`)
- [x] Scheduler-runtime readiness gate on local LLM base URL (item-542 slice 1/2, PR `8d64d2ac`)
- [x] Sports time-to-signal reaction report on calibration dashboard (PR `922d8e27`)
- [x] Guaranteed-stale scan indicator on operator homepage (PR `d847ac7c`)
- [x] Supervised auto-clear loop for arbitrage circuit breaker (item-528, PR `7bad04e7`)
- [x] Reset route + guarded auto-reset for machine-approval trip (item-527, PR `8e3d4cb8`)
- [x] Unattended stranded-leg recovery systemd unit committed AND deployed (item-526, PR `904f8dab`) — `hydra-betting-arbitrage-recovery.timer` CONFIRMED RUNNING
- [x] item-502 paper-proof done-criterion re-anchored on venue_orders rows (item-561, PR `2eee5630`)
- [x] north-star.md archived; README repointed to direction/ (item-532)
- [x] Deploy scan-after-ingest systemd chain — CONFIRMED DEPLOYED; fired at 2026-06-21T11:07Z post-ingest (priorities #2 from 2026-06-21a)
- [x] Deploy forecast-outcomes timer — CONFIRMED DEPLOYED; active (waiting); next Mon 03:00 PDT (priorities #6 from 2026-06-21a)
- [x] Deploy default-off autonomy timers: arbitrage-recovery, automated-pair-review, arbitrage-auto-approval — ALL CONFIRMED DEPLOYED (priorities #7 from 2026-06-21a)
- [x] Wire discoverDisagreementPairs into GET /api/scanner/disagreement-candidates (PR `44be4600`)
- [ ] Execute seed-wc-2026-pairs against production DB — `registryPairs > 0` (priorities #1 — operator CLI step)
- [ ] Seed R16 knockout pairs before June 29 via POST /api/scanner/wc-knockout-seed (priorities #2)
- [ ] Prove first opportunity end-to-end, or decompose zero_opportunities per gate with counts (item-501, priorities #3)
- [x] Build paper-execution CLI runner for executePolymarketNegativeRiskPaperBatch (item-502, PR #215) — DONE: 2 venue_orders audit rows confirmed
- [x] Surface CLV scan-time vs closing-line delta distribution on calibration dashboard (item-554, PR #211) — DONE
- [x] Per-pair paper P&L tracking with net paper ROI on PnL page (PR #214) — DONE
- [x] Retire 15 unused provider barrel files flagged by knip (PR #212) — DONE
- [x] Surface RunPacket replay batch score via GET /api/arbitrage/run-packet/replay-summary (item-411, PR #219) — CONFIRMED DONE
- [x] Add scheduled paper LLM edge-feed unit — M13 forecast-pipeline headwater (item-718, PR #373) — DONE
- [x] Surface per-source Brier calibration panel on dashboard (item-707, PR #381) — DONE
- [x] Warm cold Ollama before paper-edge-feed batch (PR #380) — DONE
- [x] Paper-edge-feed: reasoning_effort:low + trailing-prose tolerance + cap at 18 markets (PRs #375/#383/#384/#385) — DONE
- [x] Fix Kalshi: drop malformed series fee-change rows (PR #382) — DONE
- [x] Directional paper-nomination replay scorer M13 (PR #379) — DONE
- [x] Retire dead Kalshi/Polymarket/nav exports (PRs #371/#372/#374/#376/#377/#378) — DONE
- [x] ADR-0002 Step 1 tail: arbitrage-auto-approval.timer + automated-pair-review.timer stopped (operator action 2026-07-01) — DONE
- [ ] Rename readiness shape requiredEnvVar from OPENAI_API_KEY to HYDRA_PAPER_LLM_API_BASE_URL (item-543, priorities #5)
- [ ] Confirm forecast_outcomes non-zero + brierScore non-null after first directional paper nomination (priorities #6)

## M13: Forecast-Directional Execution
status: active
started: 2026-06-22
completed:

**Reframed 2026-06-22 ([ADR-0002](../docs/adr/0002-retire-cross-venue-arbitrage-strategy.md)).** With cross-venue arbitrage retired, M13 is the new primary program: express forecast edge as **single-leg directional positions** on Kalshi/Polymarket, routed through the execution/risk/recovery layer salvaged from arbitrage. The forecasting substrate already exists (LLM probability estimator paper-mode, calibration dashboard, CLV/Brier, `llm/live-nomination`, pre-game directional scanner); the missing wire is forecast nomination → single-leg `execute()`. Graduate via the vision's Graduated Capital stages (paper → live proof). Arbitrage-strategy wiring items are dropped; forecast/learning-loop items are kept.

Arbitrage retirement (ADR-0002 staged migration):
- [x] Step 1 — Freeze: `hydra-betting-scan-after-ingest.service` stopped (confirmed); `hydra-betting-arbitrage-auto-approval.timer` still running — operator stop pending
- [x] Step 2 — Relocate `arbitrage/executable-edge.ts` fee-math to `lib/markets/executable-edge.ts`; update importers — COMPLETE (2026-06-22 cycle)
- [x] Step 3 (tail) — COMPLETE (verified 2026-07-11): `run-packet.ts` relocated (PR #450); shared scan-history types extracted (PR #454). No production imports from `@/lib/arbitrage/` in `lib/execution/` or `app/api/` — confirmed via grep.
  - [x] 25+ files relocated in prior PRs — DONE
  - [x] `execution-error-taxonomy`, `kalshi-rfq-route-quality`, daily-loss/drawdown guardrail math relocated (PRs #436/#439) — DONE
  - [x] Dead arbitrage execute surface retired (PR #440) — DONE
  - [x] `run-packet.ts` relocated to lib/execution/ (PR #450) — DONE
  - [x] Shared scan-history types extracted into `scan-history-shared` (PR #454) — DONE
- [ ] Step 4 — Delete remaining strategy files from `lib/arbitrage/`, retire dead bin runners; tracked as #622 (ready-for-agent)
  - [x] `kalshi-combo-rfq-mispricing.ts` + `residual-correlation-risk.ts` + `kalshi-public-market-stream.ts` — retired (PRs #290-292)
  - [x] Dead execution + correlation bin runners retired (PR #357)
  - [x] Dead nomination-source strategy module retired (PR #455) — DONE
  - [x] Orphaned kalshi-rfq-liquidity-runner retired (PR #458) — DONE
  - [x] PolymarketNegativeRiskBundle import redirect (PR #619) — DONE
  - [x] Half-life/fill-probability subgraph relocated to lib/scanner/ — DONE
  - [x] Misfiled execution test files relocated — DONE
  - [x] Dead cross-venue execution modules retired (PRs #612/#617) — DONE
  - [x] polymarket-negative-risk-live-plan.ts retired (PR #625) — DONE
  - [x] hydra-betting-arbitrage-recovery.timer retired (PR #648/#653) — DONE
  - [ ] Final deletion: 24 remaining strategy/test files in lib/arbitrage/ + 4 dead bin runners — #622 ready-for-agent
- [x] Step 5 — Wire forecast nominations → scheduled directional paper execute() through the salvaged layer: nomination runner deployed (PR #368), cadence fixed (PR #415), 373+ paper VenueOrders persisted. Graduated Capital paper stage actively accumulating. DONE — 2–4 nominations per :45 run confirmed 2026-07-11.

Pre-game directional scanner (epic #2394):
- [x] Slice 1 — Per-game Kalshi market grouping (`groupKalshiMarketsByGame`) — DONE (PR before #253)
- [x] Slice 2 — WC pre-game dislocation scanner core (`scanKalshiPregameWorldCupDislocations`) — DONE (PR #253)
- [x] Slice 2b — Pre-game scan-horizon glossary entry — DONE (PR #254)
- [x] Slice 3 — Fair-value derivation (`buildPregameFairProbabilityMap`) — DONE
- [x] Slice 4 — Idempotent candidate-persistence mapper + scanner orchestration runner (`pregame-scanner-runner.ts`) — DONE (PRs #261-262)
- [x] Slice 5 — Bin runner (`web/src/bin/pregame-scanner-runner.ts`) + systemd unit files committed (PR #369) — DONE; unit files not yet installed in production (systemctl not-found, priorities #2)
- [x] Deploy pregame scanner timer to production — `hydra-betting-pregame-scanner.timer` installed and running every 15 min (verified 2026-07-06) — DONE
- [x] Wire live Kalshi↔Pinnacle fair-value resolver into scanner runner (PR #427) — DONE
- [x] Fix pregame scanner series ticker mismatch (KXWC vs KXWCGAME) — DONE (env action completed before July 14); post-WC transition to KXMLB via Priority 3 operator action

Directional execution chain (M13 step 5 keystone):
- [x] Slice 1 — DirectionalNomination contract + mapper (`directional-nomination.ts`, PR #349) — DONE
- [x] Slice 2 — Directional single-leg order planner (`directional-single-leg-order.ts`, PR #350) — DONE
- [x] Slice 3 — Directional single-leg persist (`directional-single-leg-persist.ts`, PR #351) — DONE
- [x] Slice 4 — DirectionalSingleLegExecute orchestrator (`directional-single-leg-execute.ts`, PR #353) — DONE
- [x] CLV sizing wired into directional nominations (`directional-clv-sizing.ts`, PR #356) — DONE
- [x] Disagreement oracle wired into directional nomination scoring (`directional-disagreement-signal.ts`, PR #360, item-671) — DONE
- [x] Directional paper-execution review surface on /markets (`directional-paper-review.ts`, PR #359, item-672) — DONE
- [x] Directional paper-stage exit/kill criteria (`directional-paper-exit-criteria.ts`, PR #366, item-667) — DONE
- [x] Bin runner (`web/src/bin/directional-nomination-runner.ts`) + systemd timer deployed (PR #368) — DONE; fires hourly but cadence mismatch causes 0 nominations (see priorities #1 — fix timer to :45)
- [x] Fix nomination timer cadence: PR #415 changed `:25` → `:45`, deployed and running at `:45` (verified 2026-07-06) — DONE; now OnSuccess= event-driven (primary) + :45 backstop
- [x] Wire NBA injury/lineup signal into paper-edge-feed prompt (PR #452) — DONE
- [x] Wire per-market NewsAPI context into paper-edge-feed batch (PR #449) — DONE
- [x] Add 3-way soccer base-rate framing to paper-LLM prompt (PR #457) — DONE; Brier improvement expected after July 13 settlements

Forecast / learning-loop:
- [x] Rename `requiredEnvVar: "OPENAI_API_KEY"` → `HYDRA_PAPER_LLM_API_BASE_URL` in `readiness.ts` (item-543, PR #401) — DONE
- [x] Brier score accumulation from WC group-stage settlements visible on calibration dashboard — CONFIRMED: 459 forecast_outcomes rows, Brier = 0.299 (verified 2026-07-17)
- [x] Brier trend accumulation chart wired on calibration dashboard (PR #365, item-668) — DONE
- [x] Forecast_outcomes accumulation count + last-recorded timestamp surfaced (PR #358, item-674) — DONE
- [x] Wire `run-profitability-timeline.ts` into `GET /api/pnl/profitability-timeline` (PR #226 — DONE)
- [x] Wire `sports-dislocation aggregator` into `POST /api/calibration/sports-dislocation` (PR merged 2026-06-22 — DONE)
- [x] Surface per-market-type dislocation breakdown panel on calibration dashboard UI (PR merged June 22 — DONE)
- [x] RunPacket replay batch scorecard surfaced on `/api/arbitrage/run-packet/replay-summary` (item-411, PR #219 — DONE)

Portfolio-IA (epic #2434 — all slices complete as of 2026-06-25):
- [x] Slice 1 — nav registry + 4-tab shell + `derivePositions()` + Portfolio open-positions (PR #279)
- [x] Slice 2 — History surface + equity curve + closed positions + realized P&L (PR #280)
- [x] Slice 3 — Markets surface + forecast-edge candidates + PAPER Enter (PR #286)
- [x] Slice 4 — Cull dead /arbitrage + /verified-pairs routes + dead nav links (PRs #287-289)
- [x] Slice 5 — System index + nav-completeness CI guard + ADR (PR #293)

WC 2026 QF/SF/Final (July 4–13):
- [x] WC R16 market ticker discovery — KXWC ticker round classifier (`world-cup-2026-r16-bracket.ts`, PR #362, item-670) — DONE
- [x] Duplicate-conflicting Kalshi anchor audit in `buildPregameFairProbabilityMap` (PR #363) — DONE
- [x] Extend WC pre-game grouper to R32/QF/SF/Final rounds (item-708, PR #387) — DONE
- [x] Surface DirectionalPaperExitCriteria verdict on markets/calibration dashboard (item-702, PR #390) — DONE
- [x] Wire evaluateOllamaForecastLift into GET /api/calibration/ollama-forecast-lift (item-701, PR #389) — DONE
- [x] Extend directional single-leg path to nominate Polymarket CLOB venue (item-706, PR #388) — DONE
- [x] Isolate per-market LLM failures + add client-side request timeout in paper-edge feed (PR #392) — DONE
- [x] Fix env: report HYDRA_PAPER_LLM_API_BASE_URL as requiredEnvVar label (item-543, PR #401) — DONE
- [x] Fix ui: /pnl /bankroll /operator-health degrade instead of 500 on incomplete venue balance checkpoint (item-737, PR #408) — DONE
- [x] Fix ui: /ingestion no longer 500s on unrecognized sport keys (item-738, PR #406) — DONE
- [x] Fix paper-edge-feed: batch wall-clock budget + persist partial batch before SIGTERM (item-722, PR #403) — DONE
- [x] Feat risk: add Target Verifier Core path list + classifyTargetRisk classifier (PR #405) — DONE
- [x] Feat execution: directional venue_orders CLV closing-line attribution (item-728, PR #398) — DONE
- [x] Feat calibration: add KXNFL + KXCOPA sports series to scheduled paper-edge defaults (item-729, PR #396) — DONE
- [x] Seed bankroll_snapshots: extend seed-reconciliation-balances.ts (PR #418) — DONE
- [x] Fix paper-edge-feed: stamp evaluated_at per estimate + feed-trigger nomination (PR #421, closes #2885) — DONE
- [x] Fix calibration: withhold market probability from paper-LLM prompt to stop edge dead-zero (PR #422, closes #2886) — DONE
- [x] Fix nomination timer cadence (PR #415) + fix status auto-detect (PR #416) — DONE
- [x] ADR-0004: model-anchoring diagnosis accepted (2026-07-04) — DONE
- [x] Kalshi↔Pinnacle fixture resolver pure module (item-736, PR #409) — DONE
- [x] docs(adr): ADR-0005 design language operator UI rubric (PR #420) — DONE
- [x] feat(web): styling-consistency ratchet — named state tokens + no-adhoc-state-colors lint (PR #423, closes #2738) — DONE
- [x] feat(web): nav spine + label-coherence enforcement (PR #424, closes #2737) — DONE
- [x] feat(portfolio): shed Portfolio (/) to 4 sections per ADR-0005 §3 density (PR #425, closes #2895) — DONE
- [x] feat(pregame): wire live Kalshi↔Pinnacle fair-value resolver into pregame scanner runner (PR #427) — DONE
- [x] Expand APPROVED_KALSHI_LIVE_SUBMIT_TICKER_PATTERN to include KXWCGAME/KXNFL/KXCOPA (PR #429) — DONE
- [x] Widen freshness window from 15 min to 45 min to match 35B model batch timing (PR #430) — DONE
- [x] Add .hydra/manifest.json v1 per ADR-0026 Target Manifest (PR #431) — DONE
- [x] Extend `extractPrediction` for directional audit shape; wire Kalshi settlement poll + writeback (PRs #432-435) — DONE: 208 forecast_outcomes rows, Brier ~0.315 (2026-07-12)
- [x] Relocate execution-error-taxonomy, kalshi-rfq-route-quality + retire dead arbitrage execute surface (PRs #436/#439/#440) — DONE
- [x] Pregame scanner diagnostic: add bundle-count logging + make series configurable + extend to KXNBA/KXNFL (PRs #437/#438/#441) — DONE
- [x] knip sweep: retire 7 unused exports post step-4 (PR #442) — DONE
- [x] Provider switch: score paper-LLM edges via Claude Sonnet subscription / claude-cli (PR #443) — DONE
- [x] Fix ops: TimeoutStopSec=10 + KillSignal=SIGKILL + surface claude-cli error envelope (PRs #444/#445/#451) — DONE
- [x] ADR-0002 step 3 COMPLETE: run-packet.ts relocated + scan-history-shared extracted (PRs #450/#454) — DONE (verified 2026-07-11)
- [x] Wire NBA injury/lineup signal into paper-edge-feed prompt (PR #452) — DONE
- [x] Wire per-market NewsAPI context into paper-edge-feed batch (PR #449) — DONE
- [x] Add 3-way soccer base-rate framing to paper-LLM prompt (PR #457) — DONE
- [x] KXNBA/KXNFL pregame fair-value map + KXCOPA coverage (PRs #447/#448) — DONE
- [x] KXNBA nickname resolver for Pinnacle name-matching (PR #453) — DONE
- [x] Retire dead nomination-source module (PR #455) + kalshi-rfq-liquidity-runner (PR #458) — DONE (ADR-0002 step 4 in progress)
- [x] Demote unused ClvSizeGateDecision export (PR #460) — DONE
- [x] Retire dead cftc-rulemaking-watch + opticodds modules (PR #462) — DONE
- [x] Retire dead seed-wc-2026-pairs CLI runner (PR #461) — DONE
- [x] Relocate polymarket-reward-ev-simulator.ts + polymarket-reward-phase.ts to lib/markets/ (PR #464 — ADR-0002 step 4 progress) — DONE
- [x] Per-venue (Kalshi vs Polymarket) Brier breakdown on calibration dashboard (PR #467) — DONE (2026-07-15)
- [x] Test pin: forecast-lift feed provider-agnosticism post-Sonnet switch (PR #466) — DONE (2026-07-15)
- [x] Step 5: Nomination pipeline fully operational — 4 candidates/4 executed at 2026-07-15 20:45 PDT (WC SF: FRA-ENG Jul 18, ESP-ARG Jul 19). DONE — pipeline confirmed end-to-end. 457 forecast_outcomes rows, Brier = 0.300.
- [x] Wire KXMLB into pregame scanner series + fair-value map + MLB team-identity canonicalizer (PR #469) — DONE (2026-07-15); operationally inactive pending env config
- [x] Wire `attributeDirectionalClv` into `sync-forecast-outcomes.ts` settlement hook (item-728, PR #471) — DONE (2026-07-16); production runner still passes null resolver (priorities #2 activates it)
- [x] Surface `bySourceLeague` Brier breakdown on calibration dashboard (PR #472) — DONE (2026-07-16); panel renders empty until multi-sport data accumulates
- [x] CLV persist keystone: thread `pinnacleEventId`+`startsAt` from `DirectionalNominationCandidate` through `directional-single-leg-persist` into `venue_orders.metadata.audit` + parse in `load-venue-orders.ts` (issue #477, PR #490) — DONE (2026-07-17c); unblocks Pinnacle CLV resolver (priorities #2)
- [x] ADR-0002 step 4 partial: `PolymarketNegativeRiskBundle` type relocated to `lib/execution/polymarket-bundle-types.ts` (PR #488) + `ArbitrageReviewCandidate` inlined in `lib/markets/verified-sports-pairs.ts` (PR #489) — DONE (2026-07-17c); zero cross-boundary imports in `lib/execution/` and `lib/markets/`
- [x] Delete confirmed-dead scanner routes post ADR-0002 step 4 (PR #508) — DONE (2026-07-18)
- [x] Increase forecast-outcomes sync to 2x/day — 06:00 ET + 18:00 ET (issue #486, PR #509) — DONE (2026-07-18)
- [x] Rename ollama-forecast-lift modules to paper-llm-forecast-lift post-Sonnet switch (issue #480, PR #510) — DONE (2026-07-18)
- [x] Add unit tests for json-extract.ts (PR #511) — DONE (2026-07-18)
- [x] Add universal overconfidence guardrail to paper-LLM prompt (PR #512, closes #498) — DONE (2026-07-18)
- [x] Surface per-market-type Brier on calibration dashboard (PR #513, closes #499) — DONE (2026-07-18)
- [x] Per-confidence-bucket Brier reliability diagram (PR #514, closes #493) — DONE (2026-07-18)
- [x] Surface paper exit criteria verdict + sample size on calibration page (PR #515, closes #502) — DONE (2026-07-18)
- [x] Live integration smoke for pregame scanner KXMLB path (PR #516, closes #507) — DONE (2026-07-18)
- [x] Surface pregame scanner bundle-count + last-run status on operator dashboard (PR #517) — DONE (2026-07-18)
- [x] Alert on two consecutive zero-candidate nomination runs (PR #519, closes #505) — DONE (2026-07-18)
- [x] Instrument paper-edge-feed claude-cli per-run token cost + duration (PR #521, closes #500) — DONE (2026-07-18)
- [x] Series-aware default paper-edge-feed batch cap (KXNBA=36, PR #522, closes #494) — DONE (2026-07-18)
- [x] Extend PREGAME_SCANNER_SERIES_TICKER to comma-list KXMLB,KXNBA (PR #527, closes #483) — DONE (2026-07-18)
- [x] Wire SportsDataIO MLB injury context into paper-edge-feed for KXMLB (PR #528, closes #523) — DONE (2026-07-18)
- [x] Production smoke check: verify direction/priorities.md readable + freshness-dated (PR #529, closes #501) — DONE (2026-07-18)
- [x] Add MLB moneyline base-rate framing to paper-LLM prompt for KXMLB (PR #530, closes #525) — DONE (2026-07-18)
- [x] Wire Pinnacle closing-line resolver into forecast-outcomes-runner.ts (PR #531, closes #478) — DONE (2026-07-18); `clvBps` will populate for new KXMLB/KXNBA settlements
- [x] Add SportsDataIO probable-starter context (pitcher + ERA) into KXMLB paper-edge-feed (PR #555, closes #534) — DONE (2026-07-18); activates post-WC env transition
- [x] Add MLB standings context into paper-edge-feed (PR #558, closes #538) — DONE (2026-07-18)
- [x] Surface KXMLB nomination count on operator dashboard (PR #559, closes #553) — DONE (2026-07-18)
- [x] Wire outdoor-game weather context from SportsDataIO into paper-edge-feed for KXMLB (PR #532, closes #524) — DONE (2026-07-18)
- [x] Extend KXMLB dense-series batch cap to 36 markets (PR #565, closes #485) — DONE (2026-07-18c)
- [x] Per-league paper-LLM forecast lift breakdown KXMLB vs KXNBA (PR #566, closes #547) — DONE (2026-07-18c)
- [x] ADR-0002 step 4 scope correction: clear 2 additional cross-boundary imports (PR #578, issue #567) — DONE (2026-07-24)
- [x] Wire directional-clv-sizing into nomination runner — CLV cohort stake weighting (PR #581, closes #568) — DONE (2026-07-24)
- [x] Wire directional-disagreement-signal into nomination runner as corroboration annotation (PR #582) — DONE (2026-07-24)
- [x] Add KXMLB to live-submit ticker allow-list (PR #583, closes #536) — DONE (2026-07-24)
- [x] Wire directional-replay-score to /api/calibration/directional-replay + dashboard scorecard panel (PR #580) — DONE (2026-07-24)
- [x] Retire latency-stats + kalshi combo-rfq-live cluster deadcode (PR #596, closes #570) — DONE (2026-07-24)
- [x] Persist Pinnacle no-vig closing as sportsbook_fair_line sibling rows (PR #595, closes #479) — DONE (2026-07-24)
- [x] Retire paper-LLM Ollama fallback — collapse to claude-cli (PR #593, closes #592) — DONE (2026-07-24)
- [x] Add Polymarket MLB game-winner paper-LLM estimate producer (PR #590, closes #587) — DONE (2026-07-24)
- [x] Apply pending migrations + fail-loud deploy step (PR #589, closes #588) — DONE (2026-07-24)
- [x] Schedule runPolymarketMlbPaperEdgeFeed on paper-edge cadence (PR #597, closes #591) — DONE (2026-07-24)
- [x] Shed backward-looking execution/history sections from /markets (PR #599, closes #585) — DONE (2026-07-24)
- [x] Shed duplicate open-positions/bankroll tables from Portfolio home (PR #598, closes #586) — DONE (2026-07-24)
- [x] Verify MLB weather-context time-correctness (PR #600, closes #552) — DONE (2026-07-24)
- [x] Brier score sub-0.18 target reached: July 19 WC SF session Brier = 0.189 (718 total forecasts, aggregate 0.274) — CONFIRMED (2026-07-24)
- [x] ADR-0002 step 4 slice 2: PolymarketNegativeRiskBundle import redirect (PR #619) — DONE (2026-07-25)
- [x] ADR-0002 step 4 slice 3: half-life/fill-probability subgraph relocated to lib/scanner/ — DONE (2026-07-25)
- [x] ADR-0002 step 4 slice 4: misfiled execution test files relocated — DONE (2026-07-25)
- [x] Retire dead cross-venue execution modules (PRs #612/#617) — DONE (2026-07-25)
- [x] Retire polymarket-negative-risk-live-plan.ts (PR #625) — DONE (2026-07-25)
- [x] ScannerFunnelBreakdown wired on operator-health page (PRs #628/#638) — DONE (2026-07-25)
- [x] directional-paper-exit-criteria verdict on directional-replay route (4422c254) — DONE (2026-07-25)
- [x] forecast-outcomes skip counter split by reason (df07a43f) — DONE (2026-07-25)
- [x] Per-series paper-edge feed-run summary on operator dashboard (PRs #611/#616) — DONE (2026-07-25)
- [x] Pivot paper-edge-feed to KXBTC + extend APPROVED_KALSHI_LIVE_SUBMIT_TICKER_PATTERN (priorities #1, 2026-07-25) — DONE; KXBTC confirmed live paper-edge-feed series (verified 2026-07-31)
- [x] Apply migration 0079 — paper_edge_zero_discovery_streak_status (priorities #2, 2026-07-25) — DONE (#647 confirmed closed 2026-07-31)
- [ ] ADR-0002 step 4 completion: delete 23 lib/arbitrage/ strategy/test files + 2 bin runners + retire arbitrage API routes; stop arbitrage-recovery.timer — **blocked** on live `run-cycle.ts` → `runArbitrageScanner` dependency (#622, found + blocked by operator 2026-07-25 cycle c); needs scoping decision before re-filing. Note: commit `b965f776` (2026-07-31) cut the dead `runArbitrageScanner` branch from run-cycle — may partially unblock; re-verify #622's premise next cycle before re-scoping.
- [x] Confirm KXBTC nominations → forecast_outcomes accumulation (priorities #4, 2026-07-25 cycle c) — DONE (#649 confirmed closed 2026-07-31)
- [x] Wire the operator-decided, narrowly-scoped kill-switch (#662) and loss/drawdown halt (#659) into the live-submit path — **re-scoped, not superseded**: both issues now carry explicit operator rulings (2026-07-26/29/30) with agent-safe fail-closed specs; `ready-for-agent` + `money-critical` as of 2026-07-31. See M14 section below for the full history; see `priorities.md` Priority 3–4 (2026-07-31 cycle) for build sequencing (#662 first, #659 second).
- [ ] Retire wire-or-retire: dashboard-ingestion-coverage-heatmap + scanner-replay (priorities #7, 2026-07-25)
- [x] Fix stale #636 priority-1 premise + close #674 (research cycle d, 2026-07-26) — DONE
- [x] Extract replay-batch scoring into arbitrage-replay-summary.ts (#636, commit c84325c7) — DONE (2026-07-26)
- [x] Wire risk-preflight into kalshi-executor.ts — primary venue for KXBTC+KXMLB has zero pre-submit exposure gating (#720, research cycle e, 2026-07-26) — DONE, commit `540630bf` (PR #783), verified 2026-07-31
- [x] Wire sport-cluster + per-event correlation exposure guard into directional order path — implemented, tested, unwired (#722, research cycle e, 2026-07-26) — DONE, same commit `540630bf`, verified 2026-07-31
- [ ] Fix orphaned rolling realized-slippage circuit breaker — doc claims live enforcement deleted under ADR-0002 (#723, research cycle e, 2026-07-26) — still open, carried forward as Priority 7 (2026-07-31 cycle)
- [x] Authenticate settings-mutation routes (kill-switch/daily-loss-limit/circuit-breaker-threshold) — currently unauthenticated (#724, research cycle e, 2026-07-26) — DONE, commit `4c105a46` (#768), verified 2026-07-31
- [x] Authenticate Telegram webhook route — no origin verification, reflects attacker-supplied chat_id (#725, research cycle e, 2026-07-26) — DONE, commit `c664d87b` (#763), verified 2026-07-31
- [ ] Give KXBTC an independent spot/vol-derived fair-value anchor — no external reference price exists today (#726, research cycle e, 2026-07-26) — still open, carried forward as Priority 6 (2026-07-31 cycle)
- [x] Correct stale Polymarket sports fee constants to July 2026 schedule (#734) — DONE, commit `ba0621ba`, verified 2026-07-31
- [x] Give directional single-leg orders a settlement-verification SLA lens (#736) — DONE, commit `f3f18044`, verified 2026-07-31
- [x] Remove unused `@polymarket/clob-client` v1 runtime dependency (#730) — DONE, commit `a54a91c6`, verified 2026-07-31
- [ ] **New (2026-07-31 cycle, Priority 1): fix the hydra-betting deploy path** — `#743`, money-critical: a merged, money-critical fix (#718, commit `8d2e15c7`) was confirmed NOT serving in production while several commits ahead on `origin/main`. No `deploy.yml`, no deploy timer exists. Highest-leverage item on the board — every "DONE" line above is unverified as *serving* until this closes.
- [ ] **New (2026-07-31 cycle, Priority 2): wire the equivalent Polymarket single-market exposure gate** — `#784`, money-critical: `polymarket-executor.ts`'s gate is wired to a field no caller populates (always inert) and would receive the wrong exposure quantity if it did. Direct follow-on to #720/#722.
- [ ] **Reconfirmed still-broken (2026-07-31 cycle, Priority 5): pregame scanner has never produced a row** — `#747`: 672 consecutive runs, 100% `no-pinnacle-match`, all reporting `success`. KXMLB's dedicated forecast-signal path has generated zero learning-loop output since at least 2026-07-22.

Dropped (arbitrage-strategy wiring — retired by ADR-0002, do not re-propose):
- ~~Wire `kalshi-tail-zone.ts` into scanner scoring~~ (done in PR #225; scanner deleted in step 4)
- ~~Wire `resolution-criteria-mismatch.ts` into verified-pair seeding~~ (done in PR #229; pair-seeding retired)
- ~~Wire `polymarket-sports-route-timing-class.ts` into scanner ranking~~ (done in PR #230; scanner deleted in step 4)
- ~~Wire `negative-risk-paper-strategy.ts` into scheduled route~~ (in DELETE surface)
- ~~Promote first verified arbitrage Opportunity through Graduated Capital~~ (replaced by step 5)
- ~~R16 pair seeding via `POST /api/scanner/wc-knockout-seed`~~ (pair-registry in DELETE surface)
- ~~Fix R32/R16 knockout scaffold taxonomy~~ (PR #231 DONE; bracket scaffold to be deleted in step 4)

## M14: Autonomous Execution
status: planned
started:
completed:

> **Implementation status: the machinery described below does NOT exist on `main`.**
> Commit `029cada1` (#440, ADR-0002 Step 4 PR-2b) deleted the entire
> machine-approval enforcement chain — `machine-approval-limits-preflight.ts`,
> `approval-envelope-author.ts`, `execution-preflight-gates.ts`, the
> `execute/operator-preflights/*` gates, and the #1665 auto-approval dispatcher
> `bin/arbitrage-auto-approval-runner.ts` (which held `evaluateLiveProofPromotion`).
> What survives is **state + operator-reset + display only**:
> `machine-approval-limits.ts` (its `evaluateMachineApprovalLimits` has zero
> non-test callers), the `machine-approval-trip/reset` route, and the
> `operator-health.ts` status field. Two consequences a reader must not
> re-derive:
> 1. **No execution path on `main` halts on a daily-loss or drawdown breach** —
>    the loss/drawdown breaker `machine-approval-loss-guardrail-preflight.ts` is
>    orphaned (`docs/agents/wiring-status.md`: `awaiting-wiring | tests only`).
>    Tracked as [#659](https://github.com/gaberoo322/hydra-betting/issues/659),
>    which needs an **operator decision** — not autonomous work.
> 2. This milestone's ladder was authored around **dual-leg cross-venue
>    arbitrage**, the strategy ADR-0002 retired. The surviving execution path is
>    **single-leg forecast-directional** (M13). The promotion *doctrine* below
>    still stands; the specific modules named in it must be re-scoped to the
>    directional path, not restored as written.
>
> Sections below are retained as the target design. Every module name in them is
> a **historical** reference unless marked otherwise — grep before planning
> against one. Canonical glossary: `web/src/lib/execution/CONTEXT.md`.

**The full-autonomy program (epic item-522).** M13 proves forecast edge can be
*authored* as a single-leg directional paper position; M14 is the ladder that
carries a proven strategy from paper, through human-approved live, to
machine-approved live with **no human in the loop** — the "run the funnel
end-to-end with no human operator" goal of epic item-522. This milestone is
deliberately gated *behind* M13's paper proof: the three money-critical
promotion levers below stay default-off and operator-gated until a directional
strategy has demonstrated paper edge, so no autonomy machinery can move real
money before the evidence exists. The promotion semantics live canonically in
`web/src/lib/execution/CONTEXT.md` (Graduated Capital doctrine, epic #1661);
this milestone tracks them as roadmap goals so autonomy stops being an untracked
aspiration sitting only in code comments.

### The promotion ladder (paper → human-approved live → machine-approved live)

Three rungs, each a strictly higher trust tier; a strategy never skips a rung:

1. **Paper** — `execute()` runs in paper mode (Graduated Capital stage 1); no
   real capital. The default state for every new directional nomination
   (M13 keystone, step 5). Edge is measured via per-pair paper P&L + CLV/Brier
   calibration before any promotion is considered.
2. **Human-approved live** — a human authors each live approval envelope
   (`liveDualLegApprovalProof`, not machine-authored). Real capital flows, but
   every submission is operator-gated. This rung accumulates the *evidence*
   the next rung's promotion check reads.
3. **Machine-approved live** — the machine authors live approval envelopes
   autonomously, dispatched by an auto-approval runner. Reached only once the
   evidence gate below is satisfied; this is the no-human-in-the-loop terminal
   state. *(Historical: the dual-leg implementation was `ApprovalEnvelopeAuthor`
   / `authorLiveDualLegApprovalEnvelope` + the #1665 runner — both deleted in
   `029cada1`. A directional-path equivalent has not been written.)*

### The three independent operator-gated levers

Promotion to **machine-approved live** is gated by three *independent* switches
(canonical definitions in `web/src/lib/execution/CONTEXT.md`) — all three must
permit before the auto-approval dispatcher acts, and each fails CLOSED when its
state is unreadable:

1. **LiveProofPromotion** (evidence gate; *deleted in `029cada1` — the symbol
   `evaluateLiveProofPromotion` no longer exists on `main`*) — the
   manual→machine authorship step. Promoted iff run history shows ≥ N completed
   *human-approved* live runs AND ≥ 1 completed Recovery (a stranded first leg
   unwound to `unwind_completed` in production). Evidence-based, not an operator
   toggle — the operator cannot promote without the proof. This is the
   "bootstrap-class promotion" lever.
2. **MachineApprovalLimits** (per-day spend/behavior guards) — once promoted, a
   daily cap on machine-approved notional, a max count of machine-approved runs
   per UTC day, and the **Consecutive-Failure Trip** (halts all machine
   approvals after N consecutive non-completed runs until an explicit operator
   reset). *Status: the limit **state** survives in
   `machine-approval-limits.ts`, but its enforcement point
   `machine-approval-limits-preflight.ts` was deleted in `029cada1`, so
   `evaluateMachineApprovalLimits` gates nothing today — see #659.* The
   **$5/leg** dual-leg envelope cap (`authorLiveDualLegApprovalEnvelope`) was
   deleted with that module; the per-trade bound actually in force today is the
   single-leg `KALSHI_LIVE_SUBMIT_APPROVED_MAX_STAKE_DOLLARS = 5` in
   `kalshi-live-submit-approval.ts`. Raising either remains an explicit non-goal
   (epic #1661).
3. **Env enable flag** — a plain operator switch (not evidence, not a per-day
   guard) that independently arms the #1665 auto-execution dispatcher. The
   master "autonomy on/off" toggle the operator holds regardless of evidence.

### Goals

- [ ] Wire unattended risk guardrails — daily-loss / drawdown limits that halt
      execution on the human-approved live-submit path (item-530, child of
      item-522). **Operator decision made 2026-07-26/29:**
      [#659](https://github.com/gaberoo322/hydra-betting/issues/659) is now
      `ready-for-agent` + `money-critical` with a narrow, fail-closed scope
      (wire the existing evaluators as refusals on the human-approved path;
      explicitly do NOT rebuild the deleted M14 machine-approval chain).
      The evaluators (`lib/risk/daily-loss-limit.ts`, `lib/risk/drawdown-limit.ts`)
      and the preflight that consumes them
      (`lib/execution/machine-approval-loss-guardrail-preflight.ts`) all exist and
      are tested, but the preflight is orphaned and no execution path halts on a
      breach. Do NOT close this by wiring the preflight into `operator-health.ts`
      as a display field — that clears the dead-code ratchet while creating no
      halt at all. **Sequenced behind [#662](https://github.com/gaberoo322/hydra-betting/issues/662)**
      (the kill-switch fix) — build #662 first, reuse its refusal shape, per the
      operator's own note on #659 (avoids two agents editing the same guard
      surface concurrently).
- [ ] Document the promotion ladder + three operator-gated levers in the
      roadmap (item-531, child of item-522) — DONE by this milestone entry
- [ ] Promote first directional strategy paper → human-approved live once M13
      paper edge is proven (depends on M13 step 5 keystone)
- [ ] Satisfy LiveProofPromotion evidence gate (≥ N human-approved live runs +
      ≥ 1 completed Recovery) before enabling machine authorship
- [ ] Operator-arm the env enable flag for machine-approved live only after all
      three levers independently permit

Deferred until M13 paper proof (do NOT promote ahead of evidence): the three
money-critical levers above stay default-off; raising the $5/leg cap and
arming machine authorship are operator decisions, never autonomous ones.
