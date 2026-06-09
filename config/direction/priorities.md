---
updated: 2026-06-08
refreshedBy: claude-research
researchCycle: research-target-2026-06-08c
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable. Tests are green (5340 passing, 3 skipped — verified baseline 2026-06-08c). Active backlog is 68 queued items. Work queue is empty — fresh items queued this cycle.

M7 wiring sprint continues. Three of seven prior M7 items have shipped since the last priorities write: WC settlement-timing (PR #57), opportunity half-life accumulator (PR #59), and ranking evidence row mapper (PR #55 — mapper built, persistence wiring is priority #1 below). Two pure modules still have zero non-test callers: `sports-time-to-signal-buckets.ts` and `nba-finals-pair-seeding.ts`. The `PolymarketExecutionResult.executed` rename remains open. Per-sport P&L attribution (item-386) is the closest "close the learning loop" item for real-money readiness.

World Cup 2026 group stage begins June 12 (4 days). `loadOpportunityHalfLifeHistory` I/O wrapper shipped in PR #59 but has no callers — the half-life data is available but not surfaced anywhere yet.

Per operator preference: selection quality over backlog volume, sports edge over everything else.

# Verified external venue state (2026-06-08, third cycle)
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map operational. `kalshiFeeSource: "ticker-specific"` producible on NBA Finals tickers.
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts`. Token-budget headroom advisory live in dual-leg submit preflight.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — RFQ accepted-quote promotion verified; `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts` (#48, #49).
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — opens June 12. `WORLD_CUP_2026_VERIFIED_PAIRS` seeded; settlement-timing wired into scanner Opportunity output (PR #57). Arb-clustering-heatmap exists as a pure function with no production callers.
- **Opportunity half-life** — `loadOpportunityHalfLifeHistory` I/O wrapper shipped (PR #59). No production callers yet — the wrapper reads `scanner_opportunities` across a 24h lookback but nothing calls it.

# Priority tasks

## 1. Persist `SportsPairRankingEvidenceRow` array to DB from the prediction-market-cycle route (domain / deepen-structural-understanding / close-the-learning-loop)
`run-cycle.ts` calls `mapStructuredSportsPairCandidatesToRankingEvidenceRows` and returns the rows in `RunCycleResult.sportsPairRankingEvidenceRows`. Neither `app/api/prediction-market-cycle/route.ts` nor `app/api/scheduled/prediction-market-cycle/route.ts` reads this field and persists the rows. Fee-adjusted ranking evidence (live fee-map, CLV lead-time bucket, rank-delta) is computed and thrown away every cycle.
- **Why now**: PR #55 built the mapper and PR #54 made live fee-rates operational. The persistence leg is the only remaining step before these fee-adjusted ranking rows are inspectable after a cycle run.
- **Done when**: at least one prediction-market-cycle route reads `result.sportsPairRankingEvidenceRows` and writes rows to a durable store; at least one Kalshi and one Polymarket row is retrievable after a cycle run; tests cover a ticker-specific-fee row differing from a default-fee row in `feeSource` and `rankDelta`.

## 2. Wire `summarizeSportsTimeToSignalBuckets` into a calibration runner and/or scheduled job (domain / compress-time-to-signal / close-the-learning-loop)
`summarizeSportsTimeToSignalBuckets` in `lib/markets/sports-time-to-signal-buckets.ts` is a complete, tested pure function with zero non-test callers. `SportsDataIO` injury feed and `BallDontLie` injury signals produce catalyst events. The scanner produces per-market price observations. No code assembles them through the bucket summarizer.
- **Why now**: NBA Finals catalyst events are live now. World Cup group stage (June 12) is the next high-catalyst window. The bucket report would immediately show prediction-market reaction lag on finals injury/lineup events.
- **Done when**: a calibration runner or scheduled job calls `summarizeSportsTimeToSignalBuckets` with injury/lineup signals and price-move observations, persists or logs the `SportsTimeToSignalReactionReport` per sport+league+event; at least one test covers a real catalyst-to-bucket assignment against a simulated price-move sequence; the bucket distribution for NBA Finals events is inspectable from the dashboard or logs.

## 3. Wire `buildNbaFinalsPairSeedCandidates` into the verified-pair registry seeding workflow — enables World Cup pair discovery (domain / deepen-structural-understanding / compress-time-to-signal)
`buildNbaFinalsPairSeedCandidates` in `lib/arbitrage/nba-finals-pair-seeding.ts` identifies NBA Finals market pairs from live Kalshi + Polymarket market discovery outputs. Zero non-test callers. The `WORLD_CUP_2026_VERIFIED_PAIRS` registry is seeded statically; dynamic live-discovery from feeds is not yet wired.
- **Why now**: World Cup group stage starts June 12 (4 days). The same seeding pattern that discovers Finals pairs can discover WC group-stage pairs dynamically. Wiring now makes the pattern available before WC begins.
- **Done when**: a scheduler or runner calls `buildNbaFinalsPairSeedCandidates` with live Kalshi and Polymarket market discovery results; fresh candidates with `rankScore > 0` are upserted into the verified-pair registry or surfaced in operator review; tests cover at least one live-discovered pair within the 30-minute freshness window; the scanner can consume newly-seeded pairs without restart.

## 4. Surface `loadOpportunityHalfLifeHistory` in a scanner API route or calibration endpoint (execution / improve-execution-discipline / close-the-learning-loop)
`loadOpportunityHalfLifeHistory` in `lib/scanner/opportunity-half-life-history.ts` is the I/O wrapper for the half-life accumulator shipped in PR #59. Zero callers. The measured half-life per pair key is computed nowhere despite the infrastructure being complete.
- **Why now**: PR #59 wired `summarizeArbitrageOpportunityHalfLifeAndDepth` but stopped at the pure layer. Making measured half-life visible is one function call away. This turns the depth penalty in `sports-candidate-ranking.ts` from a static assumed default to a measured value.
- **Done when**: `loadOpportunityHalfLifeHistory` is called by at least one production route (e.g. `GET /api/scanner/half-life-history` or appended to the existing scanner history loader); the measured `halfLifeMs` per pair key is readable by the dashboard; tests cover the route returning a non-empty map when `scanner_opportunities` rows span multiple cycles.

## 5. Rename `PolymarketExecutionResult.executed` to `submitted` (technical / protect-the-operation)
`PolymarketExecutionResult.executed: boolean` in `lib/execution/polymarket-executor.ts` means "we sent the order" — identical semantics to `KalshiExecutionResult.submitted` after the 2026-05-27 rename. 25+ call sites. The field name collides with the `executed` VenueOrderLifecycleStatus terminal state and the `Execution` arbitrage noun.
- **Why now**: smallest friction item in this priority list. Zero new logic. Bounded blast radius. Defer and it keeps compounding as more code is written against the confusing name.
- **Done when**: `PolymarketExecutionResult.executed` is renamed to `submitted` everywhere; callers in `execute-arbitrage.ts` and the execute API route are updated; TypeScript strict-mode clean; full test suite passes; CONTEXT.md flagged ambiguity section updated.

## 6. Per-sport and per-pair P&L attribution breakdown (execution / close-the-learning-loop)
Implement a P&L attribution summary that groups settled `venueOrders` by sport and pair key, computing realized P&L, fee costs, settlement velocity, and win rate per group (backlog item-386).
- **Why now**: the system is approaching first real-money dual-leg runs. Without per-sport P&L attribution, the operator has no way to distinguish which sports or pairs are profitable from which are losing.
- **Done when**: a new API route or dashboard data loader returns `{ sport, pairKey, totalRealizedPnlDollars, feesPaidDollars, settlementVelocityP50Ms, winRate, tradeCount }[]` for trailing N settled executions; the PnL page surfaces per-sport and per-pair rows; tests cover at least one sport-grouped attribution from a set of mixed-sport settled VenueOrders.

## 7. Retire deprecated `pinnacle*` field aliases from `SportsbookPredictionEdgeSignal` (technical / protect-the-operation)
`scanner-contract-types.ts` carries 11 `@deprecated` `pinnacle*` field aliases (`pinnaclePairKey`, `pinnacleFairProbability`, `pinnacleProviderMarketId`, etc.) alongside `fair*` replacements. 35 live non-test call sites across `sportsbook-prediction-edge-verdicts.ts`, `sportsbook-prediction-edge-paper-review.ts`, `sportsbook-prediction-edge-scanner-row-mapper.ts`, and `sportsbook-prediction-edge.ts`.
- **Why now**: the scanner-row-mapper is the canonical write path; migrating it to `fair*` names removes all downstream `pinnacle*` reads in one sweep. The deprecated aliases can then be deleted, shrinking the type surface before more code is written against the old names.
- **Done when**: all 35 non-test call sites migrated to `fair*` field names; deprecated `pinnacle*` alias fields removed from `SportsbookPredictionEdgeSignal`; TypeScript strict-mode clean; full test suite passes.

# What's been completed (DO NOT re-propose)
- Wire live Kalshi GET /margin/fee_tiers into per-market sports fee resolution — `kalshi-margin-fee-tiers.ts`, `kalshi-margin-fee-tier-map.ts`, wired into `resolveKalshiFeeRate` (#43, #44, #47 merged 2026-06-06/06-08).
- Surface Kalshi earned rate-limit tier (grants array, Premier/Paragon/Prime) + token-budget headroom on the dual-leg submit preflight — `kalshi-rate-limit-tier-headroom.ts` merged 2026-06-08.
- Fix web/src/lib/arbitrage/scanner.test.ts standalone @/-alias resolution — `npx vitest run scanner.test.ts` passes standalone (#42 merged 2026-06-06).
- Persist fee-adjusted ranking evidence into durable candidate rows — `sports-pair-ranking-evidence-row.ts` mapper built (#46 merged 2026-06-08); persistence wiring (priority #1 above) is the open follow-up.
- Rank executable depth and opportunity half-life ahead of raw edge — penalty terms wired into `sports-candidate-ranking.ts`; measurement infrastructure to feed observed values back (priority #4 above) is the open follow-up.
- Add lineup/inactive catalyst response cohorts — `sports-time-to-signal-buckets.ts` built; wiring into calibration (priority #2 above) is the open follow-up.
- Verify Kalshi RFQ accepted-quote promotion carries post_only — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts`; `PostOnlyCrossCancel` glossary added (#48, #49 merged 2026-06-08).
- Build Kalshi 0DTE in-game sports contract scanner for NBA Finals and World Cup live markets — scanner structure built; WC verified-pairs wired in the API route.
- Wire World Cup 2026 settlement-timing into scanner Opportunity output — `resolveWorldCupGroupStageSettlementTiming` wired in `scanner.ts`; `worldCupSettlementTiming` surfaced on Opportunity output (#57 merged 2026-06-08).
- Wire opportunity-half-life-and-depth summarizer into scan-history accumulation — `opportunity-observation-accumulator.ts` + `scanner/opportunity-half-life-history.ts` built and wired (#59 merged 2026-06-08). Surface via API (priority #4 above) is the open follow-up.
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
- Do NOT re-propose `opportunity-observation-accumulator` or `scanner/opportunity-half-life-history` builds — both shipped in PR #59. Open work is surfacing measured half-life via an API route (priority #4 above).
- Do NOT re-propose `resolveWorldCupGroupStageSettlementTiming` wiring into the scanner — completed in PR #57.
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
