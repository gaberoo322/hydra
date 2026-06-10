---
updated: 2026-06-09
refreshedBy: claude-research
researchCycle: research-target-2026-06-09b
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable. Tests are green (5504 passing, 3 skipped — verified baseline 2026-06-09b). Active backlog is 63 queued items. Work queue is empty — fresh priorities set this cycle.

M8 is complete. All 7 milestone items shipped: `accumulateSportsTimeToSignal` calibration wiring (sports-time-to-signal route + sports-catalyst-response-cohorts route, ~PR #74), `buildWorldCupArbClusteringHeatmap` API route (#69), `buildSportExposureClusters` preflight guard (#68), `summarizeVenueOrderPnlPhasesByPolicy` PnL page (#67), circuit breaker SiteNav indicator (#66), WebSocket silent catch observability (bd11a263), `detectSettlementOrphans` reconciliation health wiring (c6eb5a7c). M9 starts now.

Additional work merged beyond the M8 plan: Kalshi incentive-maker ranking wired into KXWC+KXNBA scanner (8a36ad23), settlement-criteria preflight wired into execute route (88ac675d), Kalshi 0DTE sports scanner API route live (#73), phase-aware Polymarket maker-reward EV in sports ranking (#72), fill-rate-discrepancy + slippage attribution in operator-health (#71), sequential dual-leg latency-SLA breaches surfaced (#70), sports-catalyst-response-cohorts calibration route (#74), Polymarket reward phase overrides sourced into run-cycle ranking (#75).

World Cup 2026 group stage is live (opened June 12). The system is at the threshold of first real-money dual-leg runs. Capital velocity tracking, settlement verification, and GTD maker order lifecycle management are the remaining readiness gaps.

Per operator preference: selection quality over backlog volume, sports edge over everything else. Do not pad the backlog — it holds 63 items.

# Verified external venue state (2026-06-09, second cycle)
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map operational.
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts`.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts` (#48, #49).
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — group stage live June 12. `WORLD_CUP_2026_VERIFIED_PAIRS` seeded; settlement-timing wired; divergence-by-phase heatmap API live (#69).
- **Opportunity half-life** — `GET /api/scanner/half-life-history` live (#65). Measured `halfLifeMs` per pair key readable by dashboard.
- **Kalshi incentive maker ranking** — wired into KXWC + KXNBA scanner candidate ranking (8a36ad23).
- **Settlement-criteria preflight** — wired into execute route; resolves settlement timing before authorization (88ac675d).
- **Kalshi 0DTE sports scanner** — `GET /api/scanner/0dte-sports` live with live Kalshi snapshot (#73).
- **Polymarket maker-reward EV** — phase-aware reward EV wired into sports candidate ranking (#72).
- **Sports-catalyst-response-cohorts** — `POST /api/calibration/sports-catalyst-response-cohorts` live (#74).

# Priority tasks

## 1. Wire `operator-day-accounting.ts` into a daily P&L summary route and build the /wagers page (execution / close-the-learning-loop)
`mapOperatorDayAccounting` in `lib/operator-day-accounting.ts` aggregates wager P&L and arbitrage-run realized P&L into a single daily total — zero non-test callers. A `/wagers` directory exists in the app but has no `page.tsx`. The daily accounting roll-up and the wager lifecycle audit are both pre-conditions for real-money operations: the operator needs to see daily net P&L and individual wager traces before authorizing live capital.
- **Why now**: The system is at the threshold of first real-money runs. Daily accounting and wager traceability are pre-live readiness requirements.
- **Done when**: `mapOperatorDayAccounting` is called from a `GET /api/pnl/daily-accounting` route or inline on the PnL page; the operator can see `wagerPnlDollars`, `arbitrageRunRealizedPnlDollars`, and `totalPnlDollars` for the current day; `/wagers` has a `page.tsx` that surfaces the individual wager lifecycle (status, P&L, resolution); tests cover the accounting roll-up with mixed wager/arbitrage inputs; TypeScript strict-mode clean.

## 2. Wire `fund-distribution-monitor.ts` into the operator health dashboard (execution / improve-execution-discipline / protect-the-operation)
`monitorFundDistribution` in `lib/execution/fund-distribution-monitor.ts` computes per-venue allocation drift, detects rebalance need, and surfaces recommendations — zero non-test callers. As real-money trading begins, capital imbalance between Kalshi and Polymarket is a live risk: too much capital on one venue means the other cannot execute its leg of a dual-leg arb.
- **Why now**: First real-money dual-leg runs are imminent. Venue allocation drift that goes undetected before a live cycle can cause one leg to fail for lack of capital while the other executes — leaving a stranded position.
- **Done when**: `monitorFundDistribution` is called from the operator health page or a dedicated route; the operator can see per-venue `currentAllocation`, `currentDriftFraction`, and any `recommendations` (rebalance-needed status); tests cover at least a two-venue drift scenario producing a `TARGET_DRIFT_EXCEEDED` recommendation; the panel is visible on the operator health dashboard.

## 3. Wire `settlement-velocity-allocation.ts` into the dual-leg sizing preflight (execution / improve-execution-discipline / deepen-structural-understanding)
`allocateBySettlementVelocity` in `lib/execution/settlement-velocity-allocation.ts` allocates stake between venues weighted by settlement latency — preferring the faster-settling venue within per-leg size bounds — with a full audit trail. Zero non-test callers. Kalshi and Polymarket settle on different schedules; the current preflight uses aggregate exposure limits but does not account for settlement velocity when dividing notional between legs.
- **Why now**: With real-money executions starting, capital held during settlement is dead capital. Weighting toward the faster-settling venue compounds returns at the margin while staying within existing exposure caps.
- **Done when**: `allocateBySettlementVelocity` is called from the dual-leg sizing step in the execute preflight or in `live-submit-preview-draft.ts`; the `SettlementVelocityAllocationResult.audit.fastestVenue` is recorded in the run packet proof; tests cover a scenario where Kalshi settles faster and receives higher stake within its bounds; TypeScript strict-mode clean.

## 4. Wire `settlement-verification-polling.ts` into the reconciliation polling job (execution / close-the-learning-loop / protect-the-operation)
`buildSettlementVerificationPollPlan` in `lib/execution/settlement-verification-polling.ts` produces a prioritized list of venue orders whose settlement status should be verified — distinguishing orders needing polling (`unsettled`, `recently_settled`) from orders to skip with a machine-readable reason. Zero non-test callers. `runSettlementVerificationDivergence` detects divergence between venue state and persisted state. The reconciliation health route checks orphans but does not run active settlement verification polling.
- **Why now**: Real-money trades will accumulate settled and recently-settled orders that need active verification to close the settlement accounting loop. Missing this wiring means divergences compound silently.
- **Done when**: `buildSettlementVerificationPollPlan` is called from the reconciliation scheduled job or `GET /api/reconciliation/settlement-verification`; any `divergent` finding causes the health check to surface it; tests cover at least one `recently_settled` order that would be polled and one `already_verified` skip; TypeScript strict-mode clean.

## 5. Wire `maker-order-lifecycle.ts` into the Polymarket GTD maker order management flow (execution / improve-execution-discipline)
`evaluateMakerOrderLifecycle` in `lib/execution/maker-order-lifecycle.ts` decides whether a resting GTD maker order should be kept, cancelled, or refreshed based on expiration proximity and price drift — zero non-test callers. Polymarket maker orders are GTD (good-till-date); the current execution path submits them but has no lifecycle management for in-flight resting orders that drift from fair value.
- **Why now**: GTD maker order lifecycle management is a prerequisite for Polymarket maker strategies (backlog: "Pilot Kalshi post-only sports maker quotes"). Orders submitted at a price that drifts from the market degrade fill quality and expose the operator to adverse selection.
- **Done when**: `evaluateMakerOrderLifecycle` is called from the Polymarket reconciliation poller or a dedicated GTD-order management step; orders with `drift > maxPriceDrift` trigger a cancel or refresh action; tests cover expiry and drift scenarios; the lifecycle decision is recorded in structured venue order evidence.

## 6. Wire `polymarket-builder-revenue-share-reconciler.ts` into a daily reconciliation job (execution / close-the-learning-loop / deepen-structural-understanding)
`reconcilePolymarketBuilderRevenueShare` in `lib/execution/polymarket-builder-revenue-share-reconciler.ts` aggregates Polymarket `/builder-trades` records into daily/per-market/per-maker totals of `fee_credit_usdc` — zero non-test callers. The builder-attribution revenue is a real cash flow that offsets execution costs; not accounting for it means the P&L phase decomposition (PR #67) misses a favorable credit line.
- **Why now**: Phase-decomposed P&L is live (PR #67). Builder revenue share credits reduce net fee drag — visible in the `feeDragPnlDollars` phase. Wiring the reconciler closes the accounting gap before real-money volume accumulates.
- **Done when**: `reconcilePolymarketBuilderRevenueShare` is called from a scheduled job or `POST /api/reconciliation/polymarket-builder-revenue` that fetches `/builder-trades` from the Polymarket API and persists the daily aggregate; the PnL phase page or a dedicated panel surfaces `feeCreditUsdc` per day; tests cover deduplication by `tradeId` and `builderCode` filtering; TypeScript strict-mode clean.

## 7. Wire `venue-maintenance-deferral.ts` into the execute route preflight (execution / protect-the-operation)
`resolveVenueMaintenanceDeferral` in `lib/execution/venue-maintenance-deferral.ts` detects whether a Kalshi or Polymarket maintenance window is active and defers execution accordingly — zero non-test callers. The execute route preflight checks live account readiness but does not gate on venue maintenance windows. During a Kalshi or Polymarket maintenance window, order submission produces indeterminate results.
- **Why now**: Live trading makes maintenance window deferral a real incident prevention mechanism. Orders submitted during a window can result in orphaned fills and stuck-state detection failures. Prevention is cheaper than recovery.
- **Done when**: `resolveVenueMaintenanceDeferral` is called in the execute route preflight before order submission; if `allow: false`, the execute route returns `no_submit` with `reason: "venue_maintenance_deferral"` and the `resumeAt` timestamp; tests cover at least one Kalshi and one Polymarket maintenance-window scenario; the deferral reason is surfaced in the run packet proof.

# What's been completed (DO NOT re-propose)
- Wire live Kalshi GET /margin/fee_tiers into per-market sports fee resolution — `kalshi-margin-fee-tiers.ts`, `kalshi-margin-fee-tier-map.ts`, wired into `resolveKalshiFeeRate` (#43, #44, #47 merged 2026-06-06/06-08).
- Surface Kalshi earned rate-limit tier (grants array, Premier/Paragon/Prime) + token-budget headroom on the dual-leg submit preflight — `kalshi-rate-limit-tier-headroom.ts` merged 2026-06-08.
- Fix web/src/lib/arbitrage/scanner.test.ts standalone @/-alias resolution — #42 merged 2026-06-06.
- Persist fee-adjusted ranking evidence into durable candidate rows — #46 merged; persistence via prediction-market-cycle route (#65) merged 2026-06-09.
- Rank executable depth and opportunity half-life ahead of raw edge — penalty terms wired; measured half-life surfaced via GET /api/scanner/half-life-history (#65 merged 2026-06-09).
- Wire `summarizeSportsTimeToSignalBuckets` into calibration accumulator output (#61 merged 2026-06-08). Accumulator wiring completed via POST /api/calibration/sports-time-to-signal.
- Verify Kalshi RFQ accepted-quote promotion carries post_only — `isKalshiPostOnlyCrossCancel` wired (#48, #49 merged 2026-06-08).
- Build Kalshi 0DTE sports scanner for NBA Finals and World Cup live markets — GET /api/scanner/0dte-sports live (#73 merged).
- Wire World Cup 2026 settlement-timing into scanner Opportunity output — #57 merged 2026-06-08.
- Wire opportunity-half-life-and-depth summarizer into scan-history accumulation — #59 merged 2026-06-08.
- Rename `PolymarketExecutionResult.executed` to `submitted` — #60 merged 2026-06-08.
- Wire `buildNbaFinalsPairSeedCandidates` into verified-pair registry seeding — #62 merged 2026-06-09.
- Per-sport and per-pair P&L attribution breakdown — #63 merged 2026-06-09.
- Retire deprecated `pinnacle*` field aliases from `SportsbookPredictionEdgeSignal` — #64 merged 2026-06-09.
- Surface circuit breaker status indicator on every dashboard page via SiteNav — #66 merged.
- Wire `detectSettlementOrphans` into `GET /api/reconciliation/health` — c6eb5a7c merged.
- Add error observability to WebSocket silent catch blocks (Kalshi + Polymarket) — bd11a263 merged.
- Wire `summarizeVenueOrderPnlPhasesByPolicy` into PnL page — #67 merged.
- Wire `buildSportExposureClusters` into preflight risk check — #68 merged.
- Surface `buildWorldCupArbClusteringHeatmap` via GET /api/scanner/world-cup-heatmap — #69 merged.
- Surface sequential dual-leg latency-SLA breaches in execution-timeline — #70 merged.
- Wire fill-rate-discrepancy + slippage attribution into operator-health — #71 merged.
- Wire phase-aware Polymarket maker-reward EV into sports candidate ranking — #72 merged.
- Wire `accumulateSportsTimeToSignal` into POST /api/calibration/sports-time-to-signal — merged.
- Wire Kalshi incentive-maker ranking into KXWC+KXNBA scanner candidate ranking — 8a36ad23 merged.
- Wire settlement-criteria preflight into arbitrage execute route — 88ac675d merged.
- Source Polymarket reward phase overrides into run-cycle ranking — #75 merged.
- Sports-catalyst-response-cohorts calibration route — #74 merged.
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
- Do NOT re-propose the pure module builds — all are built. The remaining work is wiring, not module creation.
- Do NOT re-propose `opportunity-observation-accumulator` or `scanner/opportunity-half-life-history` builds — shipped in PR #59. The API route is live (#65).
- Do NOT re-propose `resolveWorldCupGroupStageSettlementTiming` wiring — completed in PR #57.
- Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real. FALSE premise. CLOB V2 is the real change, already wired.
- Do not re-propose any M7 or M8 items — all shipped (see "What's been completed").
- Do not re-propose Kalshi incentive-maker ranking, settlement-criteria preflight, or Polymarket reward phase override sourcing — all merged.
- Do not re-propose `accumulateSportsTimeToSignal` calibration wiring, `buildWorldCupArbClusteringHeatmap` route, `buildSportExposureClusters` preflight, `summarizeVenueOrderPnlPhasesByPolicy` PnL page, circuit breaker SiteNav indicator, WebSocket observability, or `detectSettlementOrphans` health wiring — all merged.
- Do not prioritize defensive hardening, fail-closed rewrites, generic preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not propose the Hyperliquid HIP-4 monitor as a priority — secondary domain; monitor but do not prioritize.
- Do not pad the backlog. It holds 63 queued items; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput).
