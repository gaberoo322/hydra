---
updated: 2026-06-15
refreshedBy: claude-research
researchCycle: research-target-2026-06-15a
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable — and the funnel now has gate-level visibility. Tests are green (6303 passing, 3 skipped — verified baseline 2026-06-15). Active backlog is 28 queued items (27 queued + 1 blocked).

M12 is active. The funnel breakdown is wired and confirmed working: `GET /api/scanner/latest` now returns `funnelBreakdown` with per-gate counts on every scan run. The binding gate is unambiguous: `registryPairs: 0` / binding gate `softBookNotReady` — every scan run enters with 14,402 candidates but zero exit the pair-resolution stage because `kalshi_polymarket_pair_registry` still holds only 13 stale NBA/NFL/MLB/BTC rows from May 13.

Root cause of `registryPairs: 0` (confirmed 2026-06-15): The `seedVerifiedPairRegistryFromWorldCup2026StaticPairs()` function was built and committed (commit `0121549a`), but NO caller exists in production — no bin runner, no API trigger, no scheduled task executes it against the live DB. The seeding function is dead code until a runner calls it. The BallDontLie injury runner has the same gap: the systemd unit files were committed but `hydra-betting-ball-dont-lie.timer` is NOT in the running timer list (confirmed `systemctl --user list-timers`).

Per operator preference: selection quality over backlog volume, sports edge over everything else. Do not pad the backlog.

# Verified external venue state (2026-06-15)
All M10/M11 state carried forward, plus:
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map operational, spliced into sports discovery pre-ranking (#90).
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts`.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts`.
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — group stage live since June 12. WC ingestion confirmed flowing (68 events / 878 snapshots, June 13). Tournament winner NegRisk live plan wired (#88) with exit pricing (#92); paper-default, env-gated. WC verified pairs (`KXWCGAME-*`) exist as static code constants and in `seedVerifiedPairRegistryFromWorldCup2026StaticPairs()`, but that function has NO production caller — DB still holds 0 WC rows.
- **Machine execution stack** — machine-built `liveDualLegApproval` envelopes (#99), adverse-selection blocking preflights (#102), aggregate limits (#108), scan-to-submit auto-execution dispatcher (#117). All behind default-off promotion gates.
- **Combinatorial scan** — `GET /api/scanner/combinatorial-candidates` live (#94); Kalshi combo vs. Polymarket basket scan path live (#95).
- **Maker reward accounting** — per-order projected sports maker rewards in builder revenue-share reconciliation (#96); maker-rebate fill classification (#84).
- **Sports pair eligibility** — `markPolymarketSportsPairCandidatesScannerEligible` scan route live (#97).
- **Opportunity half-life** — `GET /api/scanner/half-life-history` live.
- **Kalshi incentive maker ranking** — wired into KXWC + KXNBA scanner candidate ranking.
- **Settlement-criteria preflight** — wired into execute route.
- **Kalshi 0DTE sports scanner** — `GET /api/scanner/0dte-sports` live.
- **Polymarket maker-reward EV** — phase-aware reward EV wired into sports candidate ranking.
- **Daily P&L accounting** — `mapOperatorDayAccounting` wired; `GET /api/pnl/daily-summary` live; `/wagers` page live with per-wager lifecycle audit (item-321).
- **Execution lifecycle (M9/M10)** — fund distribution monitor, settlement velocity allocation, settlement verification polling, GTD maker order lifecycle, builder revenue share reconciler, venue maintenance deferral, route decision analytics — all wired.
- **Health surface** — `/api/health/full` database probe repaired (#113); ingestion warning samples + drop alerts (#119); StatusLivePoller enriched (#104).
- **Scanner funnel breakdown** — CONFIRMED LIVE in `scanner-alert-runner.ts`; `GET /api/scanner/latest` returns `funnelBreakdown` with per-gate counts. Binding gate: `softBookNotReady`, entered 14402, `registryPairs: 0`.
- **WC 2026 knockout-stage pair discovery** — `world-cup-knockout-pair-discovery.ts` (item-505) built as pure builder. No scheduled runner or API route calls it yet.
- **BallDontLie injury runner** — `web/src/bin/ball-dont-lie-injury-runner.ts` exists; systemd unit files committed but `hydra-betting-ball-dont-lie.timer` NOT in `systemctl --user list-timers`. No injury signals flowing.
- **Passive fill-probability estimate** — `passive-fill-probability-estimate.ts` built; `sports-arb-executable-size-fill-ranking.ts` accepts `fillProbability`. Not wired into live candidate ranking path.
- **Run-packet replay scorer** — `run-packet-replay-score.ts` (item-409), batch scorer (item-411), per-strategy summaries — all built. CLV scan-time bucketing pipeline live. Pinnacle CLV scan bridge wired into production runner.
- **WC pair settlement-eligibility predicate** — item-508 built: skips settled pairs.

# Priority tasks

M12 is still funnel production. The pair registry gap is the binding constraint. Priorities 1-3 address it directly; 4-7 address deployment gaps and learning-loop coverage.

## 1. Build and execute a production bin runner for `seedVerifiedPairRegistryFromWorldCup2026StaticPairs` (compress-time-to-signal / deepen-structural-understanding)
The function `seedVerifiedPairRegistryFromWorldCup2026StaticPairs()` in `web/src/lib/arbitrage/verified-pairs.ts` was committed but has no production caller — no bin runner, no API endpoint, no systemd service. The DB still holds 0 WC rows (confirmed 2026-06-15: `kalshi_polymarket_pair_registry` has 13 rows, all May 13, none are `KXWCGAME-*`). The funnel's `pairResolution.registryPairs: 0` is the direct symptom.
- **Why now**: Every scan run exits at pair-resolution with `softBookNotReady`. Until rows are in the DB, `matched` stays 0. WC group stage is live; each additional day without pairs is lost scan signal. Round-of-16 begins June 29.
- **Done when**: A bin runner (e.g. `web/src/bin/seed-wc-2026-pairs.ts`) is built and executed against the production DB; `docker exec hydra-postgres-1 psql ...` confirms KXWCGAME-* rows with `status: "verified"` exist; the next scanner run shows `pairResolution.registryPairs > 0`.

## 2. Install BallDontLie injury runner systemd timer in production (close-the-learning-loop / compress-time-to-signal)
`web/src/bin/ball-dont-lie-injury-runner.ts` exists. The systemd unit files were committed but `hydra-betting-ball-dont-lie.timer` is absent from `systemctl --user list-timers`. No injury catalyst signals flow into the `sports-time-to-signal` calibration accumulator.
- **Why now**: WC group stage is live. Injury/lineup signals are the primary catalyst for pre-game price movements in soccer. The runner is built — only the deployment step is missing.
- **Done when**: `hydra-betting-ball-dont-lie.timer` appears in `systemctl --user list-timers`; `systemctl --user status hydra-betting-ball-dont-lie.service` shows at least one successful run; `acceptedSignalCount` is non-zero in a run log.

## 3. Prove the first opportunity end-to-end (backlog item-501) (sharpen-forecasts / deepen-structural-understanding)
With WC pairs seeded (priority 1), the scanner should produce its first non-zero `pairResolution.registryPairs` count and potentially the first persisted opportunity. The funnel breakdown will name the next binding gate if `matched > 0` but `opportunities = 0`.
- **Why now**: This is the system's reason to exist. 1,400+ scan runs have ended at `zero_opportunities`; with the pair-registry gap closed, the next binding gate is finally answerable from real data.
- **Done when**: `latestScanSummary.opportunitiesFound > 0` at least once in a production scan run, OR the funnel breakdown explains exactly which gate is eliminating all candidates with counts for each stage after pairs are seeded.

## 4. Prove the first end-to-end PAPER execution through the M7–M11 stack (backlog item-502) (improve-execution-discipline / protect-the-operation)
The full execution stack has never processed a single real candidate. Promotion gates stay OFF; this is a paper proof. Unblocked only after priority 3 produces a persisted opportunity.
- **Why now**: First real-money runs cannot be authorized on an execution path that has never demonstrably worked end-to-end even on paper.
- **Done when**: one paper run packet traverses scan → rank → preflight (adverse-selection, exposure clusters, maintenance deferral, settlement criteria) → paper submit → reconciliation with proof artifacts persisted at each stage; the dispatcher (#117) and live gates remain default-off throughout; the run packet is reviewable from the dashboard.

## 5. Wire passive fill-probability into the live sports ranking path (improve-execution-discipline / sharpen-forecasts)
`passive-fill-probability-estimate.ts` and `sports-arb-executable-size-fill-ranking.ts` both exist and the ranker accepts `fillProbability`. The wiring step — computing `PassiveFillProbabilityInput` from live orderbook snapshot data and passing it into `rankSportsArbExecutableSize` — is not yet done. Unblocked after priority 3 surfaces live candidates.
- **Why now**: Fill probability directly affects candidate ranking for first live execution decisions. Without it the ranker falls back to the `prior` source.
- **Done when**: The live sports candidate ranking path computes `PassiveFillProbabilityInput` from current orderbook snapshot and passes `fillProbability` into the ranking call; the `fillProbabilitySource` field reads `"matched"` not `"prior"` for at least one live candidate.

## 6. Get real samples into the calibration/learning loop (close-the-learning-loop / sharpen-forecasts)
The calibration surfaces (sports-time-to-signal, sports-catalyst-response-cohorts, CLV cohorts, opportunity half-life) are wired. The CLV scan bridge and scan-time CLV bucketing pipeline are now live. WC group-stage flow is the first chance to accumulate real samples. The replay scorer (item-409/411) and strategy benchmark packet are ready to process samples the moment live scan data flows.
- **Why now**: Group-stage matches resolve daily — settlement and CLV ground truth arrives now or not at all for this phase.
- **Done when**: At least one calibration accumulator shows non-zero samples sourced from production WC group-stage cycles; counts are visible on the calibration dashboard; any accumulator still at zero is explained.

## 7. Expand WC 2026 verified pair coverage to upcoming matches via knockout discovery workflow (compress-time-to-signal / deepen-structural-understanding)
The knockout-stage pair discovery workflow (`world-cup-knockout-pair-discovery.ts`, item-505) is built: it takes upcoming fixture inputs and emits `SportsGameOddsDiscoveryMatchInput` records for the operator-review lane. There is no scheduled runner or API route that executes it.
- **Why now**: Round-of-16 begins June 29. The discovery workflow is built — connecting it to the seed path (even operator-triggered) is the last step before pair coverage extends past the three group-stage matches.
- **Done when**: A workflow (API route or operator-run script) takes upcoming knockout fixture data, calls `buildWorldCupKnockoutPairDiscoveryWorkflowOutput`, feeds results into `buildVerifiedSportsPairReviewCandidates`, and at least three R16 match pairs appear in the operator-review lane before June 29.

# What's been completed (DO NOT re-propose)
All M7, M8, M9, M10, M11 items — see full list below. Plus the following since the 2026-06-13 research cycle:

- Wire `ScannerFunnelBreakdown` into `scanner-alert-runner.ts` → `executeScannerCycle` — CONFIRMED LIVE (funnelBreakdown in API response, binding gate `softBookNotReady`).
- Expose funnel breakdown counts on `GET /api/scanner/latest` (item-507) — CONFIRMED LIVE.
- Add pair-resolution stage to scanner funnel breakdown.
- WC 2026 knockout-stage pair discovery workflow (`world-cup-knockout-pair-discovery.ts`, item-505) — pure builder built.
- WC pair settlement-eligibility predicate to skip settled pairs (item-508).
- Derive `injuryImpactSignal` from BallDontLie injury runner output in verified-pair ranking.
- Passive sports fill-probability estimate from orderbook snapshots (`passive-fill-probability-estimate.ts`) — pure module built.
- Per-strategy run-packet replay score summaries (verifiedPairKey grouping).
- Batch-score historical run packets (item-411).
- Deterministic run-packet replay scorer (`run-packet-replay-score.ts`, item-409).
- Kalshi KXNBA combo RFQ live execution path with fair-value decomposition gate.
- Normalize CLOB V2 INVALID + CANCELED_MARKET_RESOLVED order states (item-430).
- Extract post-submit reconciliation audit builders from `execute-arbitrage` (item-475).
- Extract terminal-outcome summary helpers from `execute-arbitrage` (item-474).
- Wire Pinnacle CLV scan bridge into production runner.
- Scan-time CLV derivation bridge.
- Scan-time CLV bucketing pipeline (sport/source/lead-time).
- Sports strategy benchmark packet with replay-grade scoring (item-454).
- Fail closed on missing Kalshi price conformance proof (item-331).
- Wire `applyKalshiLiveFeeRatesToDiscoveryMatches` into sports discovery pre-ranking (#90).
- Wire `managePolymarketMakerOrder` into the Polymarket GTD maker-order polling cycle (#91).
- Wire `pricePolymarketNegativeRiskExit` into the NegRisk exit-plan resolver (#92).
- Wire `buildAndRankNbaCombinatorialScanCandidates` into GET /api/scanner/combinatorial-candidates (#94).
- Wire `detectComboVsBasketCandidates` into the combo-basket scan path (#95).
- Account per-order projected sports maker rewards in builder revenue-share reconciliation (#96).
- Wire `markPolymarketSportsPairCandidatesScannerEligible` into a sports-pair eligibility scan route (#97).
- Machine-execution stack: approval-envelope-author (#99), adverse-selection gates (#102), machine-approval aggregate limits (#108), auto-execution dispatcher (default-off promotion gate) (#117).
- Fix WC normalization dropping all 72 odds-api events (#118); persist warning samples + 100%-drop alert (#119); ingestion CONTEXT.md glossary (#120).
- Individual wager list + per-wager lifecycle audit page (item-321).
- Enrich StatusLivePoller with ingestion, alerts, arb-ops, circuit breaker, and wager counts (#104).
- Repair always-failing database probe + surface migration drift on /api/health/full (#113).
- Dead-code ratchet — knip + runtime reachability, CI-gated (#93); wiring-status ledger (#98).
- In-session circuit-breaker threshold editor (#106); Recovery History primary nav (#105).
- Wire live Kalshi GET /margin/fee_tiers into per-market sports fee resolution (#43, #44, #47).
- Surface Kalshi earned rate-limit tier + token-budget headroom on the dual-leg submit preflight.
- Persist fee-adjusted ranking evidence into durable candidate rows (#46, #65).
- Rank executable depth and opportunity half-life ahead of raw edge (#65).
- Wire `summarizeSportsTimeToSignalBuckets` into calibration accumulator output (#61).
- Verify Kalshi RFQ accepted-quote promotion carries post_only (#48, #49).
- Build Kalshi 0DTE sports scanner for NBA Finals and World Cup live markets (#73).
- Wire World Cup 2026 settlement-timing into scanner Opportunity output (#57).
- Wire opportunity-half-life-and-depth summarizer into scan-history accumulation (#59).
- Wire `buildNbaFinalsPairSeedCandidates` into verified-pair registry seeding (#62).
- Per-sport and per-pair P&L attribution breakdown (#63).
- Retire deprecated `pinnacle*` field aliases from `SportsbookPredictionEdgeSignal` (#64).
- Surface circuit breaker status indicator on every dashboard page via SiteNav (#66).
- Wire `detectSettlementOrphans` into `GET /api/reconciliation/health` (c6eb5a7c).
- Add error observability to WebSocket silent catch blocks (bd11a263).
- Wire `summarizeVenueOrderPnlPhasesByPolicy` into PnL page (#67).
- Wire `buildSportExposureClusters` into preflight risk check (#68).
- Surface `buildWorldCupArbClusteringHeatmap` via GET /api/scanner/world-cup-heatmap (#69).
- Surface sequential dual-leg latency-SLA breaches in execution-timeline (#70).
- Wire fill-rate-discrepancy + slippage attribution into operator-health (#71).
- Wire phase-aware Polymarket maker-reward EV into sports candidate ranking (#72).
- Wire `accumulateSportsTimeToSignal` into POST /api/calibration/sports-time-to-signal (#74).
- Wire Kalshi incentive-maker ranking into KXWC+KXNBA scanner candidate ranking (8a36ad23).
- Wire settlement-criteria preflight into arbitrage execute route (88ac675d).
- Source Polymarket reward phase overrides into run-cycle ranking (#75).
- Wire `mapOperatorDayAccounting` into daily P&L summary route + /wagers page (#76).
- Wire `monitorFundDistribution` into operator health dashboard.
- Wire `allocateBySettlementVelocity` into dual-leg sizing preflight (#77).
- Wire `resolveVenueMaintenanceDeferral` into execute route preflight (#78).
- Wire `reconcilePolymarketBuilderRevenueShare` into daily reconciliation runner (#79).
- Wire `evaluateMakerOrderLifecycle` into Polymarket GTD maker-order management (#80).
- Wire `buildSettlementVerificationPollPlan` into reconciliation poll seam (#81).
- Wire `aggregateRouteDecisionOutcomes` into GET /api/execution/route-decision-summary (#83).
- Wire `classifyPolymarketFillMakerRebate` into Polymarket reconciliation fill processing (#84).
- Wire `buildScannerOrderTicketPreview` into GET /api/scanner/order-ticket-preview (#85).
- Wire `joinPolymarketSnapshotFillTruth` into Polymarket reconciliation poll seam (#86).
- Wire `attachKalshiRateCostProofPacket` into live Kalshi submit-audit proof (#87).
- Wire `resolvePolymarketNegativeRiskLivePlan` into NegRisk live execution plan (paper-default, env-gated) (#88).
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
- Pinnacle fair-line ingestion and no-vig derivation.
- Negative-risk and sports combinatorial scan modules.
- Promote Kalshi RFQ accepted quotes into submit-ready execution packets.
- Expose sports forecast edge evidence on dashboard review flows.
- Polymarket CLOB V2 client wiring AND verification.
- Adopt Kalshi `order_group_updates` WS account channel.
- Migrate Kalshi off deprecated `/portfolio/orders` to V2 `/trade-api/v2/orders`.
- Consume Kalshi `/markets/orderbooks` batch read and `/account/endpoint_costs`.
- Extend SportsDataIO injury feed to MLB + MLS.
- Add sharp-book lead-lag evidence to sports route ranking.
- Add standalone `pair_key` indexes on scanner_opportunities + alert_states.
- Enforce Polymarket CLOB 200 req/s server rate ceiling guard.
- Rename `KalshiExecutionResult.executed` to `submitted`; rename `PolymarketExecutionResult.executed` to `submitted` (#60).
- Structural half-life as execution-priority weight in sports route ranking (item-481).
- Build resolution criteria mismatch classifier for automated verified pair seeding.
- Wire Polymarket maker rebate capture into sports route ranking.
- Classify Polymarket sports routes by pre-game maker, live maker, and live taker timing.
- Pilot Kalshi post-only sports maker quote decision (item-420).
- Surface Kalshi matching-engine timestamp on execution receipts (item-455).
- WC 2026 ingestion confirmed flowing post-#118: soccer_fifa_world_cup 68 events / 878 snapshots (June 13 verified).

# What NOT to work on
- Do NOT propose new module wiring or new module builds while the funnel is unproven. M7–M11 completed the wiring surface; M12 is production proof. A new wiring item is only valid if priority 3's per-gate decomposition names it as the binding gate.
- Do NOT promote the machine-execution gates to live — the auto-execution dispatcher (#117) and live promotion gates stay default-off until M12 priorities 1–4 are proven.
- Do NOT re-propose any M7, M8, M9, M10, or M11 items — all shipped (see "What's been completed").
- Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real. FALSE premise. CLOB V2 is the real change, already wired.
- Do not prioritize defensive hardening, fail-closed rewrites, generic preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, timestamp-locked nomination replay metrics, half-life execution-priority weighting, resolution criteria mismatch classifier, Polymarket maker rebate sports routing, Polymarket route timing classification, the replay scorer (item-409), the batch replay scorer (item-411), the CLV scan-time bucketing pipeline, the Pinnacle CLV scan bridge, the sports strategy benchmark packet, the WC knockout-stage pair discovery pure builder (item-505), the passive fill-probability pure module, or the WC pair settlement-eligibility predicate (item-508).
- Do not re-propose wiring the scanner funnel breakdown — it is CONFIRMED LIVE as of 2026-06-15.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not propose the Hyperliquid HIP-4 monitor as a priority — secondary domain; monitor but do not prioritize.
- Do not pad the backlog. The 28 active items are well-targeted; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput).
