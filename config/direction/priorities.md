---
updated: 2026-06-13
refreshedBy: claude-research
researchCycle: research-target-2026-06-13a
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable — but the funnel still has not produced. Tests are green (6107 passing, 3 skipped — verified baseline 2026-06-13). Active backlog is 42 queued items (41 queued + 1 blocked).

M11 is complete (all items shipped — see "What's been completed"). The machine-execution stack is wired and default-off. WC 2026 ingestion is confirmed flowing: `soccer_fifa_world_cup` persisted 68 events / 878 snapshots as of June 13 (the #118 fix held). But the scanner still reports `{"matched":0,"opportunities":0}` on every run — even with WC data now arriving.

**Root cause identified (2026-06-13 research cycle)**: The cross-venue scanner (`scanForArbitrage` in `arbitrage-scanner-runner.ts`) loads verified pairs exclusively from the `kalshi_polymarket_pair_registry` database table via `loadVerifiedKalshiPolymarketPairKeySet`. That table holds 13 rows — NBA/NFL/MLB/BTC pairs that are all expired or stale. **The WC 2026 pairs (`KXWCGAME-*`) defined as static constants in `web/src/lib/sports/world-cup-2026.ts` have never been seeded into the registry database**. Until current, active WC pairs exist in the DB, `matched:0` is structural and will continue regardless of how much ingestion data flows. Secondary: the funnel breakdown accounting module (`web/src/lib/markets/scanner-funnel-breakdown.ts`) was built to explain zero-opportunity runs but `scanner-alert-runner.ts` never passes a `funnelBreakdown` when calling `executeScannerCycle` — so the binding-gate evidence infrastructure is also inactive.

M12 focus: seed WC 2026 pairs into the pair registry, wire funnel breakdown into the production scan path, then prove one opportunity end-to-end.

Per operator preference: selection quality over backlog volume, sports edge over everything else. Do not pad the backlog.

# Verified external venue state (2026-06-13)
All M10/M11 state carried forward, plus:
- **Kalshi `GET /margin/fee_tiers`** — live per-market `maker_fee_rates`/`taker_fee_rates` map operational, spliced into sports discovery pre-ranking (#90).
- **Kalshi rate-limit tiers (Premier/Paragon/Prime)** — `kalshi-rate-limit-tier-headroom.ts` wired into `live-submit-preview-draft.ts`.
- **Kalshi `post_only` / `PostOnlyCrossCancel`** — `isKalshiPostOnlyCrossCancel` wired in `kalshi-executor.ts`.
- **Polymarket CLOB V2** — correctly wired (sdk-v2-compat, pUSD, keyset≤100, 200 req/s). No V3. No June-15 deadline. Do not re-verify.
- **World Cup 2026** — group stage live since June 12. WC ingestion CONFIRMED flowing: 68 events / 878 snapshots per June 13 ingest run. Tournament winner NegRisk live plan wired (#88) with exit pricing (#92); paper-default, env-gated. WC verified pairs (`KXWCGAME-*`) exist in static code but are NOT yet in `kalshi_polymarket_pair_registry` DB (root cause of matched:0).
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
- **Scanner funnel breakdown** — `web/src/lib/markets/scanner-funnel-breakdown.ts` built and tested; `scanner-service.ts` accepts optional `funnelBreakdown` param; NOT yet passed through `scanner-alert-runner.ts` (unwired production path).

# Priority tasks

M12 is funnel production. The pair registry gap is the blocking constraint; every priority below addresses it or the downstream proof sequence.

## 1. Seed WC 2026 pairs into `kalshi_polymarket_pair_registry` (compress-time-to-signal / deepen-structural-understanding)
The `WORLD_CUP_2026_VERIFIED_PAIRS` static constant in `web/src/lib/sports/world-cup-2026.ts` defines three initial WC group-stage pairs (`KXWCGAME-26JUN14GERCUR-GER`, `KXWCGAME-26JUN13BRAMAR-BRA`, `KXWCGAME-26JUN13QATCHE-CHE`). None are in `kalshi_polymarket_pair_registry`. The scanner loads pairs from DB only; static code constants are invisible to it. The `polymarket-us-sports-pair-seed-runner.ts` provides the seeding infrastructure pattern.
- **Why now**: This is the structural `matched:0` cause. With WC ingestion flowing but no pairs registered, every scan run exits before reaching any gate. WC group stage is live now — each unregistered day is lost signal during the highest-liquidity sports window of the year. Round-of-16 matches begin June 29.
- **Done when**: WC 2026 group-stage pair rows exist in `kalshi_polymarket_pair_registry` with `status: "verified"` for the current and upcoming matches; the scanner's `matched` count transitions from 0 to non-zero on the next scan run; pair seeding is repeatable for future WC matches.

## 2. Wire `ScannerFunnelBreakdown` into the production scan path (deepen-structural-understanding / close-the-learning-loop)
`scanner-alert-runner.ts` calls `executeScannerCycle` without passing a `funnelBreakdown`. The `ScannerFunnelBreakdown` infrastructure in `scanner-funnel-breakdown.ts` and `scanner-service.ts` is complete and tested but never activated in the production scan-to-alert path. Zero-opportunity runs produce no gate-level accounting.
- **Why now**: Once pairs are seeded (priority 1), some runs may still produce zero opportunities if edge thresholds, depth, or staleness gates eliminate all candidates. Without the funnel breakdown those outcomes remain unexplained. This is M12 item-501's missing half — the per-gate evidence collection that turns `zero_opportunities` into an actionable diagnosis.
- **Done when**: `scanner-alert-runner.ts` creates a `ScannerFunnelBreakdown`, passes it through `executeScannerCycle`, and logs/persists `summarizeFunnelBreakdown` output (binding gate + counts) on every scan run; the binding gate is visible to the operator without reading raw logs.

## 3. Prove the first opportunity end-to-end (backlog item-501) (sharpen-forecasts / deepen-structural-understanding)
With pairs seeded and funnel breakdown wired, the scanner should produce its first non-zero `matched` count. Either an opportunity is persisted or the breakdown names the next binding gate.
- **Why now**: This is the system's reason to exist. All ranking/fee/depth refinements from M7–M11 are untested against real flow.
- **Done when**: at least one scanner opportunity is persisted from a production run, OR the funnel breakdown (priority 2) explains exactly which gate is eliminating all candidates with counts for each stage.

## 4. Prove the first end-to-end PAPER execution through the M7–M11 stack (backlog item-502) (improve-execution-discipline / protect-the-operation)
The full execution stack has never processed a single real candidate. Promotion gates stay OFF; this is a paper proof. Unblocked only after priority 3 produces a persisted opportunity.
- **Why now**: First real-money runs cannot be authorized on an execution path that has never demonstrably worked end-to-end even on paper.
- **Done when**: one paper run packet traverses scan → rank → preflight (adverse-selection, exposure clusters, maintenance deferral, settlement criteria) → paper submit → reconciliation with proof artifacts persisted at each stage; the dispatcher (#117) and live gates remain default-off throughout; the run packet is reviewable from the dashboard.

## 5. Get real samples into the calibration/learning loop (close-the-learning-loop / sharpen-forecasts)
The calibration surfaces (sports-time-to-signal, sports-catalyst-response-cohorts, CLV cohorts, opportunity half-life) are all wired but have only ever seen test fixtures. WC group-stage flow is the first chance to accumulate real samples. The BallDontLie injury runner (`ball-dont-lie-injury-runner.ts`) exists with no systemd timer.
- **Why now**: The learning loop only compounds if it receives production data. Group-stage matches resolve daily — settlement and CLV ground truth arrives now or not at all for this phase.
- **Done when**: at least one calibration accumulator shows non-zero samples sourced from production WC group-stage cycles; counts are visible on the calibration dashboard; any accumulator still at zero is explained.

## 6. Expand WC 2026 verified pair coverage to upcoming matches (compress-time-to-signal / deepen-structural-understanding)
The three initial WC pairs cover June 13-14 matches. Upcoming group-stage and round-of-16 matches need pair definitions seeded before their events go live on Kalshi/Polymarket. A repeatable seeding workflow (or automated discovery) is needed to cover the full WC 2026 schedule.
- **Why now**: Round-of-16 begins June 29. Without a discovery path for new WC matches, pair coverage degrades back to zero after the three seed matches settle.
- **Done when**: a workflow exists (even operator-run) to discover and seed upcoming WC match pairs into the registry; at least the next 3 upcoming WC matches have verified pair rows seeded before their markets open.

## 7. Wire BallDontLie injury poller as a scheduled timer (close-the-learning-loop / compress-time-to-signal)
`web/src/lib/markets/ball-dont-lie-injury-runner.ts` and `web/src/bin/ball-dont-lie-injury-runner.ts` exist with no systemd timer. No injury catalyst signals flow into the `sports-time-to-signal` calibration accumulator. The runner feeds the POST `/api/calibration/sports-time-to-signal` endpoint which is already wired.
- **Why now**: WC group stage is live. Injury/lineup signals are the primary catalyst for pre-game price movements in soccer — a signal the system can't learn from without a live poller.
- **Done when**: a `hydra-betting-ball-dont-lie.timer` systemd unit runs the injury runner on a cadence (e.g. 30 min); `acceptedSignalCount` is non-zero in at least one run log; the runner's output is visible in the calibration dashboard.

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
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, timestamp-locked nomination replay metrics, half-life execution-priority weighting, resolution criteria mismatch classifier, Polymarket maker rebate sports routing, or Polymarket route timing classification.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not propose the Hyperliquid HIP-4 monitor as a priority — secondary domain; monitor but do not prioritize.
- Do not pad the backlog. The 42 active items are well-targeted; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput).
