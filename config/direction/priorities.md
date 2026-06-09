---
updated: 2026-06-09
refreshedBy: claude-research
researchCycle: research-target-2026-06-09a
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable. Tests are green (5386 passing, 3 skipped — verified baseline 2026-06-09a). Active backlog is 65 queued items. Work queue is empty — fresh priorities set this cycle.

M7 is complete. All 7 milestone items have shipped: `SportsPairRankingEvidenceRow` persistence (PR #65), half-life history API route (PR #65), `PolymarketExecutionResult.executed` rename (PR #60), NBA Finals pair seeding wiring (PR #62), sports-time-to-signal calibration accumulator (PR #61), per-sport P&L attribution (PR #63), and `pinnacle*` alias retirement (PR #64). M8 starts now.

World Cup 2026 group stage opens June 12 (3 days). `WORLD_CUP_2026_VERIFIED_PAIRS` is seeded and the scanner consumes them. The `buildWorldCupArbClusteringHeatmap` pure function has zero production callers — the divergence-by-phase heatmap data exists but is not surfaced for operator review ahead of kickoff.

Two additional pure modules remain unwired after M7: `accumulateSportsTimeToSignal` (the bridge from catalyst signals to the bucket summarizer) and `buildSportExposureClusters` / `summarizeVenueOrderPnlPhasesByPolicy` (P&L phase decomposition and sport-cluster correlation guarding). Both compute data the system already has but throws away.

Per operator preference: selection quality over backlog volume, sports edge over everything else.

# Verified external venue state (2026-06-09, first cycle)
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map operational.
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts`.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts` (#48, #49).
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — opens June 12. `WORLD_CUP_2026_VERIFIED_PAIRS` seeded; settlement-timing wired into scanner Opportunity output (PR #57). NBA Finals pair seeding wired into verified-pair registry (PR #62).
- **Opportunity half-life** — `GET /api/scanner/half-life-history` live (PR #65). Measured `halfLifeMs` per pair key readable by dashboard.
- **SportsPairRankingEvidenceRow** — persisted from prediction-market-cycle route (PR #65). Fee-adjusted ranking evidence durable.
- **Sports time-to-signal calibration** — `accumulateSportsTimeToSignal` built (PR #61); zero non-test production callers. Catalyst-to-accumulator wiring is open (priority #1 below).

# Priority tasks

## 1. Wire `accumulateSportsTimeToSignal` into a calibration route or scheduled job (domain / compress-time-to-signal / close-the-learning-loop)
`accumulateSportsTimeToSignal` in `lib/markets/sports-time-to-signal-accumulator.ts` is the bridge between catalyst signal events (BallDontLie injury/lineup signals from `ball-dont-lie-injury-signals.ts`) and the bucket summarizer `summarizeSportsTimeToSignalBuckets`. It accepts a list of catalyst events plus price-move observations and returns an `AccumulatedSportsTimeToSignalReport` keyed by catalyst ID. Zero non-test callers. `summarizeSportsTimeToSignalBuckets` is already wired in PR #61 to an accumulator output — but nothing calls the accumulator with real data, so the calibration report is empty every cycle.
- **Why now**: World Cup group stage begins June 12 (3 days). NBA Finals catalyst events are live. The bucket report would immediately show prediction-market reaction lag on live injury/lineup events. Without this wiring the calibration output is permanently empty.
- **Done when**: a calibration runner or scheduled job calls `accumulateSportsTimeToSignal` with BallDontLie injury/lineup signals and scanner price-move observations; the `AccumulatedSportsTimeToSignalReport` is persisted or logged per sport+league+event; at least one test covers a real catalyst-to-bucket assignment using actual injected signals; the catalyst reaction distribution for NBA Finals events is inspectable from the dashboard or logs.

## 2. Surface `buildWorldCupArbClusteringHeatmap` in a scanner API route or dashboard panel (domain / deepen-structural-understanding / compress-time-to-signal)
`buildWorldCupArbClusteringHeatmap` in `lib/arbitrage/world-cup-arb-clustering-heatmap.ts` is a complete pure function that produces a `WorldCupArbClusteringHeatmapCell[]` keyed by `(matchPhase, newsCatalystType)` with `averageDivergenceBps`, `maxDivergenceBps`, and a `latencyBudgetTier`. Zero non-test callers. The verified-pair registry and scanner have WC pairs seeded; accumulated scan history will produce divergence samples from the first game (June 12).
- **Why now**: WC group stage opens in 3 days. The heatmap is one function call away from being surfaced. Without it, the operator has no per-phase divergence visibility when deciding whether to authorize live dual-leg arb on WC markets.
- **Done when**: `buildWorldCupArbClusteringHeatmap` is called by at least one production route (e.g. `GET /api/scanner/world-cup-heatmap`) or dashboard panel; the `WorldCupArbClusteringHeatmapCell[]` is readable by the operator; tests cover at least one seeded divergence sample producing a non-empty heatmap cell; the route returns a 200 with an empty array (not an error) when no scan history exists yet.

## 3. Wire `buildSportExposureClusters` into the preflight risk check and/or dashboard exposure panel (execution / protect-the-operation / improve-execution-discipline)
`buildSportExposureClusters` in `lib/arbitrage/sport-exposure-clustering.ts` groups open `SportExposureRow` records by `(sport, correlationKey)` to produce per-cluster `totalNotionalExposure` and per-venue breakdown. Zero non-test callers. `cross-venue-exposure-limits.ts` enforces aggregate exposure caps but does not cluster by sport — the portfolio-level sport-cluster correlation guard (backlog item-325) needs this function to detect when notional exposure within one sport/correlationKey combination exceeds safe bounds.
- **Why now**: The system is approaching first real-money dual-leg runs. The current exposure check is per-venue aggregate; sport-cluster correlation is the missing guard for preventing over-concentration in a single sports outcome (e.g. two KXNBA legs correlated by series outcome). This is the smallest step to close that gap.
- **Done when**: `buildSportExposureClusters` is called from the pre-execution preflight (or a dedicated route); if any sport+correlationKey cluster exceeds the per-sport exposure cap, the preflight returns `no_submit` with reason `sport_cluster_correlation_limit`; at least one test covers a two-leg NBA Finals scenario being blocked by the cluster cap; the current cluster state is readable from the operator health dashboard.

## 4. Wire `summarizeVenueOrderPnlPhasesByPolicy` into the PnL page (execution / close-the-learning-loop)
`computeVenueOrderPnlPhaseAttribution` and `summarizeVenueOrderPnlPhasesByPolicy` in `lib/arbitrage/venue-order-pnl-phase-attribution.ts` and `venue-order-pnl-phase-summary.ts` decompose realized P&L into four phases: scan edge, fill slippage, fee drag, and settlement. Zero non-test callers. The PnL page (`app/pnl/page.tsx`) loads per-sport attribution but does not break down realized P&L by phase — the operator cannot distinguish whether losses are due to price slippage, fee drag, or scan-edge erosion.
- **Why now**: Per-sport P&L attribution shipped in PR #63. The natural next step is phase decomposition of that attribution — it surfaces whether execution quality (fill slippage) or fee costs are the dominant drag, directly informing maker vs taker routing decisions.
- **Done when**: the PnL page or a dedicated API route calls `summarizeVenueOrderPnlPhasesByPolicy` over the trailing settled VenueOrders; the operator can see `scanEdgePnlDollars`, `fillSlippagePnlDollars`, `feeDragPnlDollars`, and `settlementPnlDollars` broken out per sport+pair; tests cover at least one mixed-sport settled-order set producing non-zero phase breakdowns; TypeScript strict-mode clean.

## 5. Add circuit breaker status indicator to the dashboard SiteNav (operator / protect-the-operation)
The circuit breaker (`lib/arbitrage/circuit-breaker.ts`) halts execution when fill-rate or latency thresholds are exceeded. There is no visible status indicator in the main dashboard navigation or homepage. The operator must navigate to `/arbitrage` to see circuit breaker state — a slow path when the system has tripped mid-session.
- **Why now**: The circuit breaker is live and guards real-money execution. At-a-glance visibility is a pre-condition for confident first real-money runs. Backlog item-52 at priority=2 already captures this.
- **Done when**: a circuit breaker indicator (status badge or icon) is visible in `SiteNav` on every page; the indicator reflects the live circuit breaker state (open/closed/half-open) without a page navigation; at least one test covers the indicator rendering in each state; the `GET /api/arbitrage/circuit-breaker` route is polled at the same interval as the status live poller.

## 6. Add error observability to WebSocket silent catch blocks (technical / protect-the-operation)
Several WebSocket handlers in Kalshi/Polymarket providers contain silent `catch` blocks that swallow connection and message errors without logging context. These match the `/* intentional: reason */` enforcement gap called out in CLAUDE.md. Silent catches caused major incidents in 2026-04 and are explicitly forbidden without annotation.
- **Why now**: The system is approaching live trading. Silent catch blocks in live WS handlers create blind spots when connections degrade during an active execution. Each unannotated silent catch is a potential incident root cause.
- **Done when**: every `catch` block in `lib/providers/` WebSocket handlers either logs `console.error` with a structured context object OR carries a `/* intentional: reason */` annotation; TypeScript strict-mode clean; no new silent catches introduced; tests verify that error paths call the logging function.

## 7. Wire `detectSettlementOrphans` into the reconciliation health route (execution / close-the-learning-loop / protect-the-operation)
`detectSettlementOrphans` in `lib/arbitrage/settlement-orphan-detection.ts` identifies three discrepancy types: fills without a matching settlement, settlements without a fill, and balance events without a settlement link. Zero non-test callers. The reconciliation health route (`lib/reconciliation/health.ts`) checks checkpoint staleness but does not run orphan detection — orphaned settlements can cause permanently incorrect P&L accounting.
- **Why now**: First real-money runs are imminent. Settlement orphans that accumulate before first live trades will corrupt baseline P&L accounting from the start. Running orphan detection in the health route surfaces these discrepancies before they compound.
- **Done when**: `detectSettlementOrphans` is called from the reconciliation health route or a dedicated `GET /api/health/settlement-orphans` route; any `OrphanSettlementFinding` or `UnlinkedBalanceEventFinding` causes the health check to return a non-healthy status; tests cover at least one missing-fill orphan and one missing-balance-event orphan; the operator health dashboard surfaces orphan count.

# What's been completed (DO NOT re-propose)
- Wire live Kalshi GET /margin/fee_tiers into per-market sports fee resolution — `kalshi-margin-fee-tiers.ts`, `kalshi-margin-fee-tier-map.ts`, wired into `resolveKalshiFeeRate` (#43, #44, #47 merged 2026-06-06/06-08).
- Surface Kalshi earned rate-limit tier (grants array, Premier/Paragon/Prime) + token-budget headroom on the dual-leg submit preflight — `kalshi-rate-limit-tier-headroom.ts` merged 2026-06-08.
- Fix web/src/lib/arbitrage/scanner.test.ts standalone @/-alias resolution — `npx vitest run scanner.test.ts` passes standalone (#42 merged 2026-06-06).
- Persist fee-adjusted ranking evidence into durable candidate rows — `sports-pair-ranking-evidence-row.ts` mapper built (#46); persistence via prediction-market-cycle route (#65) merged 2026-06-09.
- Rank executable depth and opportunity half-life ahead of raw edge — penalty terms wired into `sports-candidate-ranking.ts`; measured half-life surfaced via `GET /api/scanner/half-life-history` (#65 merged 2026-06-09).
- Wire `summarizeSportsTimeToSignalBuckets` into calibration accumulator output (#61 merged 2026-06-08). Accumulator wiring (priority #1 above) is the open follow-up.
- Verify Kalshi RFQ accepted-quote promotion carries post_only — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts`; `PostOnlyCrossCancel` glossary added (#48, #49 merged 2026-06-08).
- Build Kalshi 0DTE in-game sports contract scanner for NBA Finals and World Cup live markets — scanner structure built; WC verified-pairs wired in the API route (#51).
- Wire World Cup 2026 settlement-timing into scanner Opportunity output — `resolveWorldCupGroupStageSettlementTiming` wired in `scanner.ts`; `worldCupSettlementTiming` surfaced on Opportunity output (#57 merged 2026-06-08).
- Wire opportunity-half-life-and-depth summarizer into scan-history accumulation — `opportunity-observation-accumulator.ts` + `scanner/opportunity-half-life-history.ts` built and wired (#59 merged 2026-06-08).
- Rename `PolymarketExecutionResult.executed` to `submitted` everywhere (25+ call sites) — #60 merged 2026-06-08.
- Wire `buildNbaFinalsPairSeedCandidates` into verified-pair registry seeding workflow — #62 merged 2026-06-09.
- Per-sport and per-pair P&L attribution breakdown (item-386) — `load-sport-pair-pnl-attribution.ts` + API route + PnL page — #63 merged 2026-06-09.
- Retire deprecated `pinnacle*` field aliases from `SportsbookPredictionEdgeSignal` (35 call sites) — #64 merged 2026-06-09.
- Report CLV cohorts by source and lead-time bucket.
- Normalize Kalshi `price_ranges` start/end fields at provider parse boundary.
- Fix league-scoped CLV bucket matching to require exact league equality.
- Handle missing World Cup team names before odds-api event schema parse.
- Surface zero-persistence diagnostics in arbitrage execute health.
- Rank fresher NBA injury catalysts within shock candidates.
- Wire CLV-gated sizing into sports review candidates.
- Expose sharp-line sizing provenance on sports paper candidates.
- Expose fee-adjusted sports candidate ranking delta.
- Add timestamp-locked sports nomination replay metrics.
- Kalshi and Polymarket execution and reconciliation foundations.
- Verified KXNBA Kalshi-Polymarket pair registry seeded and consumed.
- Paper LLM probability estimator and calibration dashboard.
- Pinnacle fair-line ingestion and no-vig derivation; Pinnacle CLV slices for injury-adjusted candidates.
- Negative-risk and sports combinatorial scan modules.
- Promote Kalshi RFQ accepted quotes into submit-ready execution packets.
- Expose sports forecast edge evidence on dashboard review flows.
- Polymarket CLOB V2 client wiring AND verification (item-402 closed).
- Adopt Kalshi `order_group_updates` WS account channel for live execution-state lead.
- Migrate Kalshi off deprecated `/portfolio/orders` to V2 `/trade-api/v2/orders`.
- Consume Kalshi `/markets/orderbooks` batch read and `/account/endpoint_costs`.
- Extend SportsDataIO injury feed to MLB + MLS.
- Add sharp-book lead-lag evidence to sports route ranking.
- Add standalone `pair_key` indexes on scanner_opportunities + alert_states.
- Enforce Polymarket CLOB 200 req/s server rate ceiling guard.
- Rename `KalshiExecutionResult.executed` to `submitted` (2026-05-27).

# What NOT to work on
- Do NOT re-propose the pure module builds for `sports-pair-ranking-evidence-row`, `sports-time-to-signal-buckets`, `nba-finals-pair-seeding`, `world-cup-arb-clustering-heatmap`, `opportunity-half-life-and-depth`, `settlement-orphan-detection`, `sport-exposure-clustering`, or `venue-order-pnl-phase-attribution` / `venue-order-pnl-phase-summary` — all are built. The work is the wiring, not the module.
- Do NOT re-propose `opportunity-observation-accumulator` or `scanner/opportunity-half-life-history` builds — both shipped in PR #59. The API route is live (#65).
- Do NOT re-propose `resolveWorldCupGroupStageSettlementTiming` wiring into the scanner — completed in PR #57.
- Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real. FALSE premise. The real venue change is CLOB V2 (2026-04-28), already wired and verified.
- Do not re-build the Kalshi `resolveKalshiFeeRate` resolver or re-fetch `/margin/fee_tiers` — both done.
- Do not re-migrate Kalshi order endpoints to V2 — done with guard test. Do not re-clamp Polymarket gamma keyset — done. Do not re-add Polymarket 200 req/s ceiling guard — done.
- Do not re-propose the Kalshi earned rate-limit tier / grants array / token-budget headroom — completed 2026-06-08.
- Do not re-propose the RFQ post_only verification or `PostOnlyCrossCancel` detection — completed 2026-06-08.
- Do not re-propose `PolymarketExecutionResult.executed` rename — completed 2026-06-08 (#60).
- Do not re-propose NBA Finals pair seeding wiring — completed 2026-06-09 (#62).
- Do not re-propose per-sport P&L attribution — completed 2026-06-09 (#63).
- Do not re-propose `pinnacle*` alias retirement — completed 2026-06-09 (#64).
- Do not re-propose persistence of `sportsPairRankingEvidenceRows` from prediction-market-cycle route — completed 2026-06-09 (#65).
- Do not re-propose `GET /api/scanner/half-life-history` route — completed 2026-06-09 (#65).
- Do not prioritize defensive hardening, fail-closed rewrites, generic preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not propose the Hyperliquid HIP-4 monitor as a priority — it is a pure module in a secondary domain. Monitor but do not prioritize.
- Do not pad the backlog. It holds 65 queued items; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput).
