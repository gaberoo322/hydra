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
- [ ] Step 3 (tail) — Relocate remaining files: `run-packet.ts`, `execution-error-taxonomy.ts`, `kalshi-rfq-route-quality.ts`, `scanner-provider-degradations.ts` from `lib/arbitrage/` to `lib/execution/`; extract needed types from `scanner.ts`; update 13 identified import paths in lib/execution/ and app/api/ (priorities #3, verified 2026-07-01)
  - [x] 25+ files already relocated (fill-symmetry, fill-rate-discrepancy, recovery, circuit-breaker, server-risk-limits, execute-arbitrage, operator-health, terminal-outcome, execution-history, settlement-tracking, leg-status, run-profitability-timeline, rolling-slippage-alarm, kalshi-bundle-decomposition, sequential-dual-leg-*, run-packet-replay-score, run-packet-replay-batch-score, post-submit-audit, settlement-orphan-detection, realized-slippage-loader, kalshi-token-bucket-execution-evidence) — DONE
- [ ] Step 4 — Delete the 25-file strategy surface from `lib/arbitrage/`, retire remaining scanner routes, survey + retire/relocate arbitrage-era bin runners
  - [x] `kalshi-combo-rfq-mispricing.ts` + `residual-correlation-risk.ts` + `kalshi-public-market-stream.ts` — retired (PRs #290-292)
  - [x] Dead execution + correlation bin runners retired (PR #357)
- [ ] Step 5 — Wire forecast nominations → scheduled directional paper execute() through the salvaged layer; first directional paper VenueOrder persisted; Graduated Capital paper stage accumulating (M13 keystone)

Pre-game directional scanner (epic #2394):
- [x] Slice 1 — Per-game Kalshi market grouping (`groupKalshiMarketsByGame`) — DONE (PR before #253)
- [x] Slice 2 — WC pre-game dislocation scanner core (`scanKalshiPregameWorldCupDislocations`) — DONE (PR #253)
- [x] Slice 2b — Pre-game scan-horizon glossary entry — DONE (PR #254)
- [x] Slice 3 — Fair-value derivation (`buildPregameFairProbabilityMap`) — DONE
- [x] Slice 4 — Idempotent candidate-persistence mapper + scanner orchestration runner (`pregame-scanner-runner.ts`) — DONE (PRs #261-262)
- [x] Slice 5 — Bin runner (`web/src/bin/pregame-scanner-runner.ts`) + systemd unit files committed (PR #369) — DONE; unit files not yet installed in production (systemctl not-found, priorities #2)
- [ ] Deploy pregame scanner timer to production — enable hydra-betting-pregame-scanner.timer (priorities #2)

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
- [ ] Fix nomination timer cadence: move from :25 to :45 so feed completion (0–27 min) lands inside the 15-min freshness window (priorities #1)

Forecast / learning-loop:
- [ ] Rename `requiredEnvVar: "OPENAI_API_KEY"` → `HYDRA_PAPER_LLM_API_BASE_URL` in `readiness.ts` (item-543)
- [ ] Brier score accumulation from WC group-stage settlements visible on calibration dashboard (June 26 03:00 PDT timer fire — unconfirmed as of 2026-06-27)
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
   autonomously (`ApprovalEnvelopeAuthor` / `authorLiveDualLegApprovalEnvelope`),
   dispatched by the #1665 auto-approval runner. Reached only once the evidence
   gate below is satisfied; this is the no-human-in-the-loop terminal state.

### The three independent operator-gated levers

Promotion to **machine-approved live** is gated by three *independent* switches
(canonical definitions in `web/src/lib/execution/CONTEXT.md`) — all three must
permit before the auto-approval dispatcher acts, and each fails CLOSED when its
state is unreadable:

1. **LiveProofPromotion** (evidence gate, `evaluateLiveProofPromotion`) — the
   manual→machine authorship step. Promoted iff run history shows ≥ N completed
   *human-approved* live runs AND ≥ 1 completed Recovery (a stranded first leg
   unwound to `unwind_completed` in production). Evidence-based, not an operator
   toggle — the operator cannot promote without the proof. This is the
   "bootstrap-class promotion" lever.
2. **MachineApprovalLimits** (per-day spend/behavior guards,
   `machine-approval-limits-preflight.ts`) — once promoted, a daily cap on
   machine-approved notional, a max count of machine-approved runs per UTC day,
   and the **Consecutive-Failure Trip** (halts all machine approvals after N
   consecutive non-completed runs until an explicit operator reset). The
   **$5/leg** envelope cap (`authorLiveDualLegApprovalEnvelope`) is imported,
   non-configurable, and an explicit non-goal to raise (epic #1661).
3. **Env enable flag** — a plain operator switch (not evidence, not a per-day
   guard) that independently arms the #1665 auto-execution dispatcher. The
   master "autonomy on/off" toggle the operator holds regardless of evidence.

### Goals

- [ ] Wire unattended risk guardrails — daily-loss / drawdown limits that halt
      autonomous execution (item-530, child of item-522)
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
