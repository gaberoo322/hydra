---
updated: 2026-06-12
refreshedBy: claude-research
researchCycle: research-target-2026-06-12a
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable — and the funnel has never produced. Tests are green (5943 passing, 3 skipped — verified baseline 2026-06-12). Active backlog is 58 queued items. Work queue is empty — fresh priorities set this cycle.

M11 is complete. All 7 milestone items shipped: live Kalshi fee-rate splice into sports discovery pre-ranking (#90), `managePolymarketMakerOrder` GTD polling-cycle adapter (#91), `pricePolymarketNegativeRiskExit` in the NegRisk exit-plan resolver (#92), NBA/WC combinatorial scan candidates via `GET /api/scanner/combinatorial-candidates` (#94), `detectComboVsBasketCandidates` combo-basket scan path (#95), per-order projected sports maker rewards in builder revenue-share reconciliation (#96), sports-pair eligibility scan route (#97).

Beyond the M11 plan, the machine-execution stack landed: approval-envelope-author (#99), adverse-selection blocking preflights (#102), machine-approval aggregate limits — daily notional cap, run-count cap, consecutive-failure trip (#108), and the auto-execution dispatcher behind a default-off promotion gate (#117). Also merged: individual wager list + per-wager lifecycle audit page (item-321), StatusLivePoller enrichment (#104), `/api/health/full` database-probe + migration-drift fix (#113), dead-code ratchet (#93), wiring-status ledger (#98).

**The keystone fact for M12: the pipeline has never produced one opportunity end-to-end.** 1,378 of 1,378 scanner runs ended `zero_opportunities`. Root cause #1 was found and fixed on group-stage eve: World Cup normalization dropped all 72 odds-api WC events (`soccer_fifa_world_cup` missing from `supportedSportSet`; unhandled 1X2 draw leg) — fixed in #118, with normalization warning-sample persistence and a 100%-drop alert added in #119. WC 2026 group stage is live (opened June 12). M12 is **funnel production**: prove ingestion flows, prove the first opportunity (or explain zero per gate), prove the first paper execution through the M7–M11 stack, and get real samples into the calibration loop. No new module wiring until the funnel is proven.

Per operator preference: selection quality over backlog volume, sports edge over everything else. Do not pad the backlog — it holds 58 queued items.

# Verified external venue state (2026-06-12)
All M10/M11 state carried forward:
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map operational, and now spliced into sports discovery pre-ranking via `applyKalshiLiveFeeRatesToDiscoveryMatches` (#90).
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts`.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts`.
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — group stage live since June 12. `WORLD_CUP_2026_VERIFIED_PAIRS` seeded; settlement-timing wired; divergence-by-phase heatmap API live. Tournament winner NegRisk live plan wired (#88) with exit pricing (#92); paper-default, env-gated.
- **WC ingestion fix** — `soccer_fifa_world_cup` added to `supportedSportSet`, 1X2 draw leg skipped at normalization (#118); warning samples persisted + 100%-drop-per-sport alert (#119). Production flow NOT yet verified — that is M12 priority 1.
- **Machine execution stack** — machine-built `liveDualLegApproval` envelopes (#99), adverse-selection blocking preflights (#102), aggregate limits (#108), scan-to-submit auto-execution dispatcher (#117). All behind default-off promotion gates; they stay off until the funnel is proven (M12 priorities 1–3).
- **Combinatorial scan** — `GET /api/scanner/combinatorial-candidates` live (#94); Kalshi combo vs. Polymarket basket scan path live (#95).
- **Maker reward accounting** — per-order projected sports maker rewards in builder revenue-share reconciliation (#96); maker-rebate fill classification (#84).
- **Sports pair eligibility** — `markPolymarketSportsPairCandidatesScannerEligible` scan route live (#97).
- **Opportunity half-life** — `GET /api/scanner/half-life-history` live. Measured `halfLifeMs` per pair key readable by dashboard.
- **Kalshi incentive maker ranking** — wired into KXWC + KXNBA scanner candidate ranking.
- **Settlement-criteria preflight** — wired into execute route.
- **Kalshi 0DTE sports scanner** — `GET /api/scanner/0dte-sports` live.
- **Polymarket maker-reward EV** — phase-aware reward EV wired into sports candidate ranking.
- **Daily P&L accounting** — `mapOperatorDayAccounting` wired; `GET /api/pnl/daily-summary` live; `/wagers` page live with per-wager lifecycle audit (item-321).
- **Execution lifecycle (M9/M10)** — fund distribution monitor, settlement velocity allocation, settlement verification polling, GTD maker order lifecycle (`evaluateMakerOrderLifecycle` + `managePolymarketMakerOrder` adapter #91), builder revenue share reconciler, venue maintenance deferral, route decision analytics (#83), fee details (#84), order ticket preview (#85), snapshot fill truth (#86), rate-cost proof (#87) — all wired.
- **Health surface** — `/api/health/full` database probe repaired + migration drift surfaced (#113); ingestion warning samples + drop alerts (#119); StatusLivePoller enriched (#104).

# Priority tasks

M12 is funnel production. The wiring surface is complete through M11; every priority below is about proving the existing stack produces real flow, not adding surface area.

## 1. Verify WC ingestion is flowing in production post-#118 (compress-time-to-signal / protect-the-operation)
PR #118 fixed the normalization that silently dropped all 72 odds-api World Cup events, and #119 added warning-sample persistence plus a 100%-drop-per-sport alert — but neither has been verified against live production flow with the group stage underway.
- **Why now**: Every downstream M12 proof depends on WC events actually reaching the scanner. The group stage is live; each unverified day is lost signal during the highest-liquidity sports window of the year.
- **Done when**: a production ingestion cycle persists non-zero `soccer_fifa_world_cup` events; the #119 100%-drop alert is quiet for soccer (or its firing is explained and fixed); normalization warning samples for WC payloads are reviewed and show no systematic drop class; the verified event count is recorded in the funnel evidence (backlog item-499 follow-through).

## 2. Prove the first opportunity end-to-end — or explain zero per gate (backlog item-501) (sharpen-forecasts / deepen-structural-understanding)
1,378 of 1,378 scanner runs ended `zero_opportunities`. With WC ingestion fixed, either the funnel produces its first persisted opportunity or the zero outcome must be decomposed per gate so the binding constraint is identified, not guessed.
- **Why now**: This is the system's reason to exist. All ranking/fee/depth refinements shipped in M7–M11 are untested against real flow until one opportunity traverses the funnel.
- **Done when**: at least one scanner opportunity is persisted from a production run, OR a per-gate funnel decomposition (ingestion → pair eligibility → event/market matching → edge threshold → depth/fee/half-life gates) reports candidate counts at each stage for at least one full scan cycle and names the binding gate with evidence.

## 3. Prove the first end-to-end PAPER execution through the M7–M11 stack (backlog item-502) (improve-execution-discipline / protect-the-operation)
The full execution stack — approval envelope (#99), adverse-selection preflights (#102), aggregate limits (#108), dispatcher (#117), reconciliation, P&L attribution — has never processed a single real candidate. Promotion gates stay OFF; this is a paper proof.
- **Why now**: First real-money runs cannot be authorized on an execution path that has never demonstrably worked end-to-end even on paper. The machine-execution stack merged in the last 48 hours needs its first live-shaped traversal.
- **Done when**: one paper run packet traverses scan → rank → preflight (adverse-selection, exposure clusters, maintenance deferral, settlement criteria) → paper submit → reconciliation with proof artifacts persisted at each stage; the auto-execution dispatcher (#117) and live promotion gates remain default-off throughout; the run packet is reviewable from the dashboard.

## 4. Get real samples into the calibration/learning loop (close-the-learning-loop / sharpen-forecasts)
The calibration surfaces (time-to-signal, sports-catalyst-response-cohorts, CLV cohorts, opportunity half-life) are all wired but have only ever seen test fixtures. WC group-stage flow is the first chance to accumulate real samples.
- **Why now**: The learning loop only compounds if it receives production data. Group-stage matches resolve daily — settlement and CLV ground truth arrives now or not at all for this tournament phase.
- **Done when**: at least one calibration accumulator (`sports-time-to-signal`, `sports-catalyst-response-cohorts`, CLV cohort, or half-life history) shows non-zero accumulated samples sourced from production WC group-stage cycles; the sample counts are visible on the calibration dashboard; any accumulator still at zero after live flow is explained (no flow vs. broken wiring).

# What's been completed (DO NOT re-propose)
All M7, M8, M9, M10, M11 items — see full list below.
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

# What NOT to work on
- Do NOT propose new module wiring or new module builds while the funnel is unproven. M7–M11 completed the wiring surface; M12 is production proof. A new wiring item is only valid if priority 2's per-gate decomposition names it as the binding gate.
- Do NOT promote the machine-execution gates to live — the auto-execution dispatcher (#117) and live promotion gates stay default-off until M12 priorities 1–3 are proven.
- Do NOT re-propose any M7, M8, M9, M10, or M11 items — all shipped (see "What's been completed").
- Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real. FALSE premise. CLOB V2 is the real change, already wired.
- Do not prioritize defensive hardening, fail-closed rewrites, generic preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not propose the Hyperliquid HIP-4 monitor as a priority — secondary domain; monitor but do not prioritize.
- Do not pad the backlog. It holds 58 queued items; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput).
