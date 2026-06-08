---
updated: 2026-06-08
refreshedBy: claude-research
researchCycle: research-target-2026-06-08b
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable. All 7 priorities from the 2026-06-08 morning research cycle shipped within the same day: scanner test isolation, live Kalshi fee-tiers wiring, 0DTE in-game scanner structure, fee-adjusted ranking evidence rows, depth/half-life ranking integration, lineup catalyst time-to-signal buckets, and RFQ post_only verification. Tests are green (5291 total, 5288 passing, 2 skipped — verified baseline 2026-06-08). Active backlog is 68 queued items. Work queue has 2 stale entries that match already-shipped work and will be pruned this cycle.

The pattern this cycle: several pure modules were built but left without production callers — `sports-pair-ranking-evidence-row.ts`, `sports-time-to-signal-buckets.ts`, `nba-finals-pair-seeding.ts`, `world-cup-arb-clustering-heatmap.ts`, and `opportunity-half-life-and-depth.ts` all have zero non-test importers. The next priorities close this wiring gap rather than building more orphaned pure modules.

World Cup 2026 starts June 12 (4 days) — group-stage settlement timing and WC market scanning are maximally timely now. Per operator preference: selection quality over backlog volume, sports edge over everything else.

# Verified external venue state (2026-06-08, second cycle)
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map now fetched in production (`kalshi-margin-fee-tiers.ts`), wired into `resolveKalshiFeeRate` via `kalshi-margin-fee-tier-map.ts`. The live fetch is operational; `kalshiFeeSource: "ticker-specific"` is now producible on NBA Finals tickers.
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts` as of 2026-06-08. Token-budget headroom advisory is live in the dual-leg submit preflight.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — RFQ accepted-quote promotion path verified to carry `post_only`; `isKalshiPostOnlyCrossCancel` detector wired in `kalshi-executor.ts` as of 2026-06-08 (#48). Glossary entry added to execution CONTEXT.md (#49).
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — opens June 12. `WORLD_CUP_2026_VERIFIED_PAIRS` seeded in `lib/sports/world-cup-2026.ts`; pair registry consumed by verified-pairs API route. Settlement-timing and arb-clustering-heatmap modules exist as pure functions with no production callers.

# Priority tasks

## 1. Wire `SportsPairRankingEvidenceRow` into run-cycle persistence (domain / deepen-structural-understanding / close-the-learning-loop)
`mapStructuredSportsPairCandidatesToRankingEvidenceRows` exists in `lib/markets/sports-pair-ranking-evidence-row.ts` and produces durable, flat fee-adjusted ranking-evidence rows from `StructuredSportsPairReviewCandidate[]`. Zero non-test callers. The run-cycle that produces `StructuredSportsPairReviewCandidate[]` in `lib/markets/verified-sports-pairs.ts` → `run-cycle.ts` discards this evidence after in-memory scoring.
- **Why now**: fee-adjusted ranking evidence (`preFeeEdge`, `feeAdjustedEdge`, `feeSource: "ticker-specific"` from the live fee-map now operational, `clvLeadTimeBucketId`, `rankDelta`, depth evidence) is being computed and thrown away every cycle. This is the persistence leg that completes priority #4. Without it, inspecting fee-accuracy improvements or debugging ranking deltas requires re-running a cycle.
- **Done when**: `run-cycle.ts` (or the appropriate post-preview stage) calls `mapStructuredSportsPairCandidatesToRankingEvidenceRows` after building candidates and persists the resulting rows to a durable store (JSONB column on `sportsbookPredictionEdgeCandidates`, or a dedicated row appended to the existing persistence pattern); at least one Kalshi and one Polymarket ranking-evidence row is retrievable after a cycle run; tests cover a ticker-specific-fee row differing from a default-fee row in `feeSource` and `rankDelta`.

## 2. Wire `sports-time-to-signal-buckets` into calibration output (domain / compress-time-to-signal / close-the-learning-loop)
`summarizeSportsTimeToSignalBuckets` in `lib/markets/sports-time-to-signal-buckets.ts` is a complete, tested pure function that bucketises catalyst to prediction-market reaction lag into `lt30s / s30_to_2m / m2_to_10m / m10_to_60m / gt60m / noReaction`. Zero non-test callers. The `BallDontLieInjurySignal` normalizer (`lib/markets/ball-dont-lie-injury-signals.ts`) and the SportsDataIO injury feed (`lib/providers/sportsdataio-injury-feed.ts`) produce the catalyst events. The scanner produces per-market price observations. No code assembles them through the bucket summarizer and outputs the result.
- **Why now**: the catalyst time-to-signal measurement is the stated outcome of priority #6 from the prior cycle. That priority was counted done when the module was built, but the wiring is what creates measurable edge signal. NBA Finals catalysts are live now and the bucket report would immediately show prediction-market reaction lag on finals injury/lineup events — after the Finals ends, the next high-catalyst window is World Cup group stage (June 12).
- **Done when**: a calibration runner or scheduled job calls `summarizeSportsTimeToSignalBuckets` with injury/lineup signals from the SportsDataIO feed (or BallDontLie) and price-move observations from the scanner, persists or logs the `SportsTimeToSignalReactionReport` per sport+league+event, and at least one test covers a real catalyst to bucket assignment against a simulated price-move sequence. The bucket distribution for NBA Finals events should be inspectable from the dashboard or logs.

## 3. Wire World Cup 2026 settlement-timing and arb-clustering-heatmap into scanner output (domain / deepen-structural-understanding / compress-time-to-signal)
`world-cup-settlement-timing.ts` defines `WorldCupGroupStageSettlementTimingEntry[]` with 104 group-stage matches and per-venue settlement windows. `world-cup-arb-clustering-heatmap.ts` bucketises arbitrage divergence samples by edge and latency budget. Both are pure modules with zero non-test callers. The verified-pairs route already serves WC pairs. The scanner and opportunity output do not surface settlement-window evidence or heatmap data.
- **Why now**: World Cup group stage begins June 12. Settlement timing is materially different from multi-day outright markets — a 1X2 group-stage bet on a June 13 match settles within 90-120 minutes of kickoff. Missing this means sizing and recovery decisions for WC pairs use generic assumptions that can misclassify 2-hour settlement windows as overnight. Four days of runway.
- **Done when**: scanner Opportunity output (or a supplemental WC metadata sidecar) includes `kalshiSettlementWindowEstimate` and `polymarketSettlementWindowEstimate` keyed from `world-cup-settlement-timing.ts` when the pair's canonical identity maps to a WC group-stage match; at least one `WorldCupArbClusteringHeatmapCell` is produced per scan cycle when WC divergence samples are present; tests cover settlement-window injection for a known WC match and a heatmap cell classification for a sample with `edgeBps > 200` and `latencyBudgetMs < 500`.

## 4. Wire `opportunity-half-life-and-depth` summarizer into scan-history persistence (execution / improve-execution-discipline / close-the-learning-loop)
`opportunity-half-life-and-depth.ts` computes per-opportunity half-life, peak depth, decay flag, and aggregate stats across observations. Zero non-test callers. The scanner (`scanner.ts`) finds Opportunities and `scan-history.ts` persists runs — but half-life and depth are not computed or stored across sequential scan cycles.
- **Why now**: the `observationHalfLifeMs` and `executableDepthDollars` fields are used as penalty inputs in `sports-candidate-ranking.ts` but they carry assumed/static values because no measurement infrastructure feeds observed values back. Closing this loop produces real per-pair half-life priors that sharpen the depth penalty in ranking. NBA Finals pairs — the highest volume pairs right now — are the first beneficiaries.
- **Done when**: sequential scan cycles accumulate `ArbitrageOpportunityObservation[]` per opportunity key (persisted in scan history or a Redis structure); `summarizeArbitrageOpportunityHalfLife` is called across those observations per pair; the resulting `halfLifeMs` and depth stats are written to `scan-history` or appended to the `scannerOpportunities` row; and at least two scan cycles on the same pair produce a meaningful half-life estimate that differs from the static default.

## 5. Rename `PolymarketExecutionResult.executed` to `submitted` (technical / protect-the-operation)
`PolymarketExecutionResult.executed: boolean` in `lib/execution/polymarket-executor.ts` means "we sent the order" — identical semantics to `KalshiExecutionResult.submitted` after the 2026-05-27 rename (item-482). The CONTEXT.md flags this explicitly: "has the same naming smell" and "symmetric rename is tracked as a follow-up." The field name collides with the `executed` VenueOrderLifecycleStatus terminal state and the `Execution` arbitrage noun.
- **Why now**: smallest friction item in this priority list. Zero new logic. Bounded blast radius (rename a field + all callers in the executor + callers of PolymarketExecutionResult). Eliminates the confusion the CONTEXT.md warns about. Defer it and it keeps compounding as more code is written against the confusing name.
- **Done when**: `PolymarketExecutionResult.executed` is renamed to `submitted` everywhere; callers in `execute-arbitrage.ts` and the execute API route are updated; TypeScript strict-mode clean; full test suite passes; CONTEXT.md flagged ambiguity section updated to reflect the rename is complete.

## 6. Wire `nba-finals-pair-seeding` into the verified-pair registry seeding workflow (domain / deepen-structural-understanding)
`buildNbaFinalsPairSeedCandidates` in `lib/arbitrage/nba-finals-pair-seeding.ts` identifies NBA Finals market pairs from live Kalshi + Polymarket market discovery outputs, with freshness-gating and exact-match scoring. Zero non-test callers. The `kalshiPolymarketPairRegistry` and the `VERIFIED_PAIRS` registry are the current durable sources of pair identity — dynamic pair discovery from live market feeds is not yet wired.
- **Why now**: if the NBA Finals run to Game 7 (June 20 at the latest), live-discovered Finals pairs have a short time window. More durably: the same seeding pattern can serve World Cup group-stage pair discovery, which starts June 12 and runs through July. Wiring it now makes the pattern available before the WC begins.
- **Done when**: a scheduler or runner calls `buildNbaFinalsPairSeedCandidates` with live Kalshi and Polymarket market discovery results; fresh candidates with `rankScore > 0` are upserted into the verified-pair registry or surfaced in operator review; tests cover at least one live-discovered pair with a freshness delta within the 30-minute window; the scanner can consume newly-seeded pairs without restart.

## 7. Per-sport and per-pair P&L attribution breakdown (execution / close-the-learning-loop)
Implement a P&L attribution summary that groups settled `venueOrders` by sport and pair key, computing realized P&L, fee costs, settlement velocity, and win rate per group. This is listed in the backlog at priority 2 and is the most direct "close the learning loop" item for real-money readiness.
- **Why now**: the system is approaching first real-money dual-leg runs. Without per-sport P&L attribution, the operator has no way to distinguish which sports or pairs are profitable from which are losing — raw aggregate P&L is insufficient for strategy refinement. The `venueOrders`, `arbitrageRuns`, and `venueOrderPnlPhase*` modules provide all the necessary inputs.
- **Done when**: a new API route or dashboard data loader returns `{ sport, pairKey, totalRealizedPnlDollars, feesPaidDollars, settlementVelocityP50Ms, winRate, tradeCount }[]` for the trailing N settled executions; the PnL page surfaces per-sport and per-pair rows; tests cover at least one sport-grouped attribution from a set of mixed-sport settled VenueOrders.

# What's been completed (DO NOT re-propose)
- Wire live Kalshi GET /margin/fee_tiers into per-market sports fee resolution — `kalshi-margin-fee-tiers.ts`, `kalshi-margin-fee-tier-map.ts`, wired into `resolveKalshiFeeRate` (#43, #44, #47 merged 2026-06-06/06-08).
- Surface Kalshi earned rate-limit tier (grants array, Premier/Paragon/Prime) + token-budget headroom on the dual-leg submit preflight — `kalshi-rate-limit-tier-headroom.ts` merged 2026-06-08.
- Fix web/src/lib/arbitrage/scanner.test.ts standalone @/-alias resolution — `npx vitest run scanner.test.ts` passes standalone (#42 merged 2026-06-06).
- Persist fee-adjusted ranking evidence into durable candidate rows — `sports-pair-ranking-evidence-row.ts` mapper built (#46 merged 2026-06-08); persistence wiring (priority #1 above) is the open follow-up.
- Rank executable depth and opportunity half-life ahead of raw edge — penalty terms wired into `sports-candidate-ranking.ts`; measurement infrastructure to feed observed values back (priority #4 above) is the open follow-up.
- Add lineup/inactive catalyst response cohorts — `sports-time-to-signal-buckets.ts` built; wiring into calibration (priority #2 above) is the open follow-up.
- Verify Kalshi RFQ accepted-quote promotion carries post_only — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts`; `PostOnlyCrossCancel` glossary added (#48, #49 merged 2026-06-08).
- Build Kalshi 0DTE in-game sports contract scanner for NBA Finals and World Cup live markets — scanner structure built; WC verified-pairs wired in the API route.
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
- Paper LLM probability estimator and calibration dashboard (paper-LLM edge backend now on local Ollama, #641).
- Pinnacle fair-line ingestion and no-vig derivation; Pinnacle CLV slices for injury-adjusted candidates (item-477).
- Negative-risk and sports combinatorial scan modules.
- Promote Kalshi RFQ accepted quotes into submit-ready execution packets (item-467).
- Expose sports forecast edge evidence on dashboard review flows (item-469).
- Polymarket CLOB V2 client wiring AND verification (item-402 closed).
- Adopt Kalshi `order_group_updates` WS account channel for live execution-state lead (item-483).
- Migrate Kalshi off deprecated `/portfolio/orders` to V2 `/trade-api/v2/orders`.
- Consume Kalshi `/markets/orderbooks` batch read and `/account/endpoint_costs`.
- Extend SportsDataIO injury feed to MLB + MLS.
- Add sharp-book lead-lag evidence to sports route ranking (item-429).
- Add standalone `pair_key` indexes on scanner_opportunities + alert_states (item-316).
- Enforce Polymarket CLOB 200 req/s server rate ceiling guard (item-402).
- Rename `KalshiExecutionResult.executed` to `submitted` (2026-05-27, item-482).

# What NOT to work on
- Do NOT re-propose the pure module builds for `sports-pair-ranking-evidence-row`, `sports-time-to-signal-buckets`, `nba-finals-pair-seeding`, `world-cup-arb-clustering-heatmap`, or `opportunity-half-life-and-depth` — all five are built. The work is the wiring, not the module.
- Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real. FALSE premise. The real venue change is CLOB V2 (2026-04-28), already wired and verified.
- Do not re-build the Kalshi `resolveKalshiFeeRate` resolver or re-fetch `/margin/fee_tiers` — both done. The open work is persistence (#1 above).
- Do not re-migrate Kalshi order endpoints to V2 — done with guard test. Do not re-clamp Polymarket gamma keyset — done. Do not re-add Polymarket 200 req/s ceiling guard — done.
- Do not re-propose the Kalshi earned rate-limit tier / grants array / token-budget headroom — completed 2026-06-08.
- Do not re-propose the RFQ post_only verification or `PostOnlyCrossCancel` detection — completed 2026-06-08.
- Do not prioritize defensive hardening, fail-closed rewrites, generic preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not propose the Hyperliquid HIP-4 monitor as a priority — it is a pure module in a secondary domain. Monitor but do not prioritize.
- Do not pad the backlog. It holds 68 queued items; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput).
