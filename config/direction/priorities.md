---
updated: 2026-04-29
refreshedBy: claude-research
researchCycle: claude-research-2026-04-29
tags: [hydra, hydra/direction]
---
# Current state
Hydra's sports-first arbitrage stack is architecturally complete through M6. Polymarket CLOB V2 went live April 28, 2026 with pUSD collateral, new order structs, and per-sport fee divergence (NHL zero-fee, NBA/MLB higher base). Kalshi now exposes fractional trading (per-market, _fp fields mandatory since March 12), per-fill `fee_cost`, `/account/limits` with tiered token-bucket rate limits, and `order_group_updates` WebSocket channel. The CFTC ANPRM comment period closes April 30; the Third/Ninth Circuit split makes a Supreme Court cert petition near-certain. NBA playoffs are in first round with peak liquidity. FIFA World Cup 2026 markets show sustained 5-8 cent Kalshi-Polymarket spreads. Arb half-lives collapsed to ~3.6s in NBA markets (SSRN 6624718). Polymarket is distributing $5M in April liquidity incentives. MLB season is underway with Polymarket as exclusive MLB prediction market partner via Sportradar data.

The test suite is green at 3045 passing tests with clean typecheck. Recent merges: scanner route ranking with stream freshness, Kalshi fill fee_cost persistence, verified-pairs test isolation fix, forecast_outcomes migration, collateralAsset evidence for Polymarket buying-power.

# Priority tasks
## 1. Validate Polymarket CLOB V2 execution paths end-to-end
The CLOB V2 exchange upgrade went live April 28. Order structures changed (removed nonce/feeRateBps, added timestamp/metadata/builder), collateral moved from USDC.e to pUSD, SDK migrated to `@polymarket/clob-client-v2`. Per-sport fee rates now diverge (NHL = 0, NBA/MLB = higher). The codebase has `sdk-v2-compat.ts` but production execution needs validation.
- **Why now**: V1 orders fail post-cutover. V2 fee divergence means mispricing EV by 1-3% across sports. Blocking prerequisite for all Polymarket live execution.
- **Done when**: Polymarket execution runner successfully places and tracks an order through V2 CLOB with pUSD collateral, per-sport fee rate consumed in route EV, reconciliation handles V2 fill structures, `sdk-v2-compat.ts` confirmed active in all execution modules.

## 2. Instrument execution latency tracking end-to-end
No systematic latency instrumentation exists for order submission-to-terminal-state flows. With NBA arb half-lives at 3.6s, latency attribution is critical for determining which opportunities are executable.
- **Why now**: Without latency attribution, cannot diagnose whether missed fills are from price movement vs. execution delay. Dual-leg execution requires synchronized timing.
- **Done when**: Track Kalshi submitOrder() latency, Polymarket createAndPostOrder() latency, polling interval vs. fill detection time. Persist executionLatency to venue_orders metadata. Dashboard can display latency distributions.

## 3. Wire OpticOdds unified odds API as sharp-line benchmark
Pinnacle closed public API access July 2025, cutting off the primary CLV benchmark source. OpticOdds aggregates real-time odds from 200+ sportsbooks (including sharp books) in under 800ms, with built-in injury data, lineups, and game schedules.
- **Why now**: Unblocks priority 5 (source trust weights need CLV data). NBA playoffs and MLB season generate daily CLV opportunities. Current Pinnacle pipeline is degraded.
- **Done when**: OpticOdds API integration fetches real-time sharp odds for active sports; closing line snapshots captured at game start for CLV calculation; CLV values flow into source trust weight computation.

## 4. Add opportunity half-life tracking with NBA playoff calibration
Track how long each verified sports spread remains executable. Research shows NBA arb windows average 3.6s. The scan-history module already has `topPairHalfLife` structure with firstSeenAt/lastSeenAt/seenCount/disappearedAt but the decay computation is missing.
- **Why now**: NBA first-round playoffs provide the richest possible training set. Data decays in value once playoffs end. Half-life directly determines which opportunities are worth executing.
- **Done when**: Spread observations timestamped at detection and re-sampled; per-market-type half-life curves computed; scanner uses half-life to prioritize; dashboard displays half-life distributions.

## 5. Convert calibration outcomes and Pinnacle CLV into source trust weights
Build a bounded source-trust module using settled forecast outcomes, sharp closing-line evidence, and Brier/log-loss to produce source-specific sizing multipliers.
- **Why now**: Settlement sync is complete, fair-line edge flows into previews. The next alpha step is letting proven sources size larger. Depends on priority 3 for CLV data.
- **Done when**: Run-cycle candidate previews include source trust weight, CLV/log-loss inputs, and adjusted size.

## 6. Wire Kalshi account limits, rate-limit token buckets, and fractional trading
Kalshi now provides `/account/limits` with tiered token-bucket rate limits (Basic 20r/10w through Prime 400/400), `order_group_updates` WebSocket channel, and per-market fractional trading with _fp fields (mandatory since March 12). All must be consumed for live execution.
- **Why now**: Live dual-leg arb will spike submission velocity. Without rate limiting, 429s cascade across both legs. Fractional trading enables tighter leg matching (reducing residual exposure). Integer fields were removed March 12.
- **Done when**: Live Kalshi run packets include parsed token bucket values and endpoint costs; all API interactions use _fp/_dollars fields; fractional sizing is used when market supports it; order_group_updates events logged.

## 7. Persist Polymarket V2 per-sport fee evidence and pUSD collateral lifecycle
Wire Polymarket V2 per-sport fee rates (from /fee-rate endpoint) and pUSD wrap/unwrap lifecycle into sports arbitrage run packets. NHL zero-fee legs should be correctly prioritized.
- **Why now**: V2 fee divergence across sports is live. NHL playoffs at zero fee vs NBA/MLB with taker fees creates systematic mispricing in route EV if fees are uniform.
- **Done when**: Route EV applies per-market fee rate; pUSD balance checked in buying-power readiness; automated wrap triggered when pUSD insufficient; fee evidence persisted in run packets.

# What's been completed (DO NOT re-propose)
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
- Fix verified-pairs missing DATABASE_URL isolation
- Add collateralAsset evidence to Polymarket live buying-power readiness
- Add forecast_outcomes migration and journal entry
- Add forecastOutcomes table schema and fix type narrowing
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
- Add pUSD collateral shortfall evidence to run packet and dashboard
- Add pUSD collateral readiness to venue-orders loader and display
- Persist poll-to-terminal latency for Polymarket and display on venue-orders dashboard
- Add Kalshi account-limit preflight evidence to venue-orders loader and display
- Persist pUSD collateralAsset in second-leg venue-sizing audit evidence
- Add odds-fetching capability to OpticOdds provider (fetchOdds with Zod schemas)
- Add OpticOdds sharp-line fair-value adapter for CLV benchmarking

# What NOT to work on
- Do not re-propose completed items listed above.
- Do not prioritize politics, economics, or crypto markets over sports.
- Do not build new provider abstractions when existing modules can be extended.
- Do not spend cycles on generic defensive work, broad refactors, or test-only hygiene unless directly required by a priority task.
- Do not propose OPENAI_API_KEY configuration tasks — it's already configured.
- Do not propose V1 CLOB work — V2 is now live and V1 is deprecated.
- Do not build Hyperliquid or FanDuel Predicts venue adapters until those platforms have confirmed mainnet/API availability.

# Regulatory awareness
The CFTC ANPRM comment period closes April 30. CFTC has sued 5 states (AZ, CT, IL, NY, WI) asserting CEA preemption. Third Circuit ruled 2-1 for Kalshi; Ninth Circuit panel appeared to lean Nevada's way in April 16 oral arguments — likely circuit split headed to Supreme Court. The Curtis-Schiff "Prediction Markets Are Gambling Act" would reclassify sports contracts as gambling. 38 state AGs filed against prediction markets April 28. Monitor weekly; no code changes needed unless platform rules change. Polymarket's MLB-exclusive deal with Sportradar/CFTC integrity MOU restricts certain market types (individual pitches, manager decisions, umpire performance) — scanner should filter these.
