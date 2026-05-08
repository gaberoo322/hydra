---
updated: 2026-05-07
refreshedBy: director
researchCycle: research-2026-05-07-0748
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-ready in shape: ingestion, scanner, arbitrage execution, reconciliation, dashboards, and deep regression coverage are already in place. The next cycle should harden live sports execution before adding new strategy surface, because the most valuable gaps are narrow fail-closed controls around projected exposure, migration drift, venue price conformance, and provider degradation evidence.

# Priority tasks
## 1. Project proposed trade size in single-market exposure preflight
Update `web/src/app/api/arbitrage/execute/server-risk-limit-preflight.ts` so the single-market cap checks current exposure plus the proposed live trade, not current exposure alone.
- **Why now**: Technical research found a high-severity live-risk gap where a ticker just under its cap can pass preflight and breach the cap after submit.
- **Done when**: Preflight rejects trades whose projected post-trade exposure exceeds the configured single-market cap; tests cover just-under-cap, exactly-at-cap, and over-cap projected exposure cases.

## 2. Fail closed on pending migration drift
Change `web/src/bin/database-migration-drift-check.ts` so production-facing drift checks exit non-zero when applied migrations lag local migrations.
- **Why now**: Live venue orders, reconciliation checkpoints, and run packets depend on schema correctness; migration drift is a maintainability and execution-safety blocker.
- **Done when**: Pending local migrations cause a non-zero exit in production/smoke mode; local development behavior remains explicit and tested; the command reports which migrations are pending.

## 3. Require Kalshi price_ranges or price_level_structure before live execution
Make Kalshi live execution fail closed when market preflight lacks usable fixed-point pricing evidence, instead of falling through to unsnapped prices.
- **Why now**: Domain and market research show Kalshi fixed-point pricing is now an execution requirement; invalid price conformance creates avoidable live 400s and stale-edge risk.
- **Done when**: Live Kalshi submit paths require `price_level_structure` or `price_ranges` proof; run packets persist the conformance evidence; tests prove missing pricing metadata creates structured no-submit evidence.

## 4. Snapshot Polymarket CLOB market info at execution time
Wire an execution-time `getClobMarketInfo()` snapshot into Polymarket sports route evidence before live submit.
- **Why now**: Polymarket V2 exposes sports start time, min order size, tick size, fees, RFQ status, reward config, and taker-delay fields that can replace stale scanner assumptions.
- **Done when**: Execution packets include market-info fields used for sizing and route decisions; missing or stale market info yields structured degradation evidence; tests cover fee/tick/min-size changes between scan and submit.

## 5. Add structured provider degradation evidence for Polymarket CLOB reads
Stop converting Polymarket CLOB metadata and orderbook failures into silent empty/no-op scanner output.
- **Why now**: Silent provider degradation hides time-to-signal failures and can make the system look clean while sports routes are blind.
- **Done when**: Metadata/orderbook failures produce typed degradation records in scanner/run summaries; dashboards or API responses distinguish no opportunity from provider unavailable; tests cover failure classification.

## 6. Retire or quarantine divergent top-level src mirror files
Remove, redirect, or explicitly quarantine the legacy top-level `src/` mirror files that sit outside canonical `web/` typecheck and tests.
- **Why now**: Autonomous agents need one canonical implementation surface; divergent mirrors create false confidence and low-quality future changes.
- **Done when**: No production or verifier path depends on stale top-level mirrors; remaining files are documented as fixtures or removed; typecheck/test scope reflects the canonical code paths.

# What's been completed (DO NOT re-propose)
- Add Kalshi Fill Latency Percentile Helper
- Add AI Agent Margin Compression Helper
- Add Dashboard Exposure Risk Matrix
- Add Polymarket CLOB provider rate limiting
- Fix Kalshi IOC partial-fill second-leg sizing to actual fill_count_fp
- Fix fee-inclusive arbitrage run profitability timeline P&L
- Add JSDoc header to Polymarket CLOB provider
- Normalize Polymarket CLOB header for health scanner
- Expose Polymarket residual exposure states in run packets
- Add CLOB V2 smoke proof to arbitrage run packets
- Expose settlement update audit fields for forecast outcome sync
- Persist sportsbook fair-line sizing basis on candidates
- Add route-level sports execution quality summary
- Update unresolved sports forecast outcomes on settlement sync
- Add sports route-mode decision to run-cycle packets
- Add price-distance discount to Polymarket sports reward EV
- Carry sportsbook fair-line edge into run-cycle sizing preview
- Record insufficient-depth RFQ comparison outcomes
- Expose sports replay summaries on calibration dashboard
- Match sports pairs by Polymarket sports metadata
- Add RFQ versus visible-book execution comparison to Kalshi RFQ runner
- Persist Kalshi batch orderbook timestamp evidence in run packets
- Add Kalshi RFQ visible-book route quality comparator
- Prove scanner route ranking can consume stream freshness evidence
- Persist Kalshi fill fee_cost in arbitrage run packets
- Add collateralAsset evidence to Polymarket live buying-power readiness
- Add per-leg fee evidence to sports arbitrage run-packets
- Add pUSD collateral readiness evidence to sports arbitrage run-packets
- Add stream freshness quality score to scanner route ranking
- Add order submission latency tracking to Kalshi and Polymarket executors
- Add per-sport V2 fallback fee rates and sportLeague evidence to scanner
- Add sportLeague to dashboard polymarket fee metadata display
- Display pUSD collateral readiness on dashboard execution run cards
- Display submission latency on venue-orders dashboard
- Add estimated half-life seconds computation to spread decay tracking
- Display spread half-life evidence on arbitrage scanner dashboard
- Persist poll-to-terminal latency for Polymarket and display on venue-orders dashboard
- Add Kalshi account-limit preflight evidence to venue-orders loader and display
- Add odds-fetching capability to OpticOdds provider
- Add OpticOdds sharp-line fair-value adapter for CLV benchmarking
- Add schema-focused tests for sync forecast outcomes
- Flag zero-limit cross-venue exposure breaches
- Add sport exposure clustering helper
- Add live account readiness preflight helper
- Add sequential dual-leg timeout budget helper
- Add Kalshi tapered price-range rounding regression
- Add settlement orphan detection helper
- Add venue order PnL phase attribution helper
- Add cross-venue exposure limit classifier
- Recovery unwind idempotency guard
- Operator kill switch toggle API and UI control
- Kalshi price_level_structure executor regression tests
- Polymarket builder code V2 order metadata attribution
- Kalshi fee change snapshot capture during execution
- Venue order discriminated union types
- Add run-level profitability timeline to P&L page
- Add daily loss limit runtime edit control
- Add dual-leg fill-rate SLA classifier
- Add concurrent execution advisory lock for overlapping pair submission
- Fix Kalshi IOC partial-fill: size Polymarket second leg to actual fill_count_fp
- Add Polymarket CLOB provider rate limiting

# What NOT to work on
- Do not re-propose completed items listed above.
- Do not prioritize politics, economics, culture, or crypto-adjacent markets over sports.
- Do not build new venue integrations unless operator approval is explicit.
- Do not implement Polymarket V3 OAuth until the operator confirms account-specific requirements; public research this cycle did not validate that as a hard public-doc-backed deadline.
- Do not build broad refactors before the narrow live safety gaps above land.
- Do not add generic dashboards or monitoring pages unless they expose concrete execution proof, degradation, or sports edge evidence.
- Do not build Hyperliquid, FanDuel Predicts, DraftKings Predictions, Robinhood, XO Market, or Sequence Markets adapters in this cycle.
