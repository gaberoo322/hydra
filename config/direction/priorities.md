---
updated: 2026-04-30
refreshedBy: claude-research
researchCycle: claude-research-2026-04-30
tags: [hydra, hydra/direction]
---
# Current state
Hydra's sports-first arbitrage stack is architecturally complete through M6. The Polymarket CLOB V2 exchange upgrade went live April 28, 2026 — the codebase already has `@polymarket/clob-client-v2` and `sdk-v2-compat.ts`, but production execution paths need V2 validation. Kalshi API now exposes per-fill `fee_cost`, `/account/limits` with token-bucket rate limits, and fractional trading. The regulatory landscape is volatile: CFTC is suing 4 states to assert exclusive jurisdiction over prediction markets, 38 AGs oppose, and Congress introduced legislation to reclassify sports event contracts as gambling. Arbitrage opportunity half-lives have collapsed to ~3.6 seconds in NBA markets (SSRN 6624718), making execution speed critical. The orchestrator received major architecture improvements (mutation testing, adversarial validation, scope enforcement, worktree isolation) that should reduce the ~1 revert/day rate.

Two test failures exist in `verified-pairs.test.ts` — Zod validation throws instead of returning `registry_unavailable` when DATABASE_URL is missing. This is a test isolation issue, not a production bug.

# Priority tasks
## 1. Validate Polymarket CLOB V2 execution paths end-to-end
The CLOB V2 exchange upgrade went live April 28. Order structures changed (removed `nonce`, `feeRateBps`; fees now operator-decided at match time), collateral moved from USDC to pUSD, and the SDK migrated to `@polymarket/clob-client-v2`. The codebase has `sdk-v2-compat.ts` but production execution needs validation.
- **Why now**: "No update means no execution" — V1 orders will fail post-cutover. This is a blocking prerequisite for all Polymarket live execution.
- **Done when**: The Polymarket execution runner successfully places and tracks an order through the V2 CLOB, the reconciliation worker handles V2 fill structures, and `sdk-v2-compat.ts` is confirmed as the active path in all execution modules.

## 2. Fix verified-pairs test isolation (2 failing tests)
`verified-pairs.test.ts` has 2 failures: the test expects `registry_unavailable` when the database is unreachable, but `getDatabaseEnv()` throws a ZodError on missing DATABASE_URL instead of being caught. The test needs either a DATABASE_URL fixture or the lookup function needs to catch Zod validation errors.
- **Why now**: 2 failing tests in the suite. Clean grounding is a prerequisite for Hydra cycles.
- **Done when**: `npx vitest run src/lib/arbitrage/verified-pairs.test.ts` passes all 33 tests without DATABASE_URL being set.

## 3. Persist dynamic venue fee evidence in sports arbitrage run packets
Wire Kalshi per-fill `fee_cost` (available since Jan 28) and Polymarket V2 operator-decided fees into the sports arbitrage scanner/run-packet path so candidates are ranked by executable net edge, not raw spread.
- **Why now**: Kalshi now exposes `fee_cost` on every fill. Polymarket V2 moved fees to match-time operator decision. The codebase has run-packet proof surfaces ready for this data.
- **Done when**: Sports arbitrage run packets show per-leg fee assumptions, expected net cents/contract after fees, and candidates below net-edge threshold are excluded.

## 4. Add opportunity half-life tracking for sports arbitrage spreads
Track how long each verified sports spread remains executable after first detection. Recent research shows NBA arb windows average 3.6 seconds — Hydra needs to know which dislocations survive long enough for dual-leg execution.
- **Why now**: Competitive research shows arb half-lives have collapsed from 12.3s (2024) to 2.7s (2026 avg). Without half-life data, Hydra can't distinguish executable from fleeting opportunities.
- **Done when**: Each sports arbitrage opportunity records first-seen, last-seen, observed duration, and the arbitrage dashboard can rank opportunities by half-life-adjusted edge.

## 5. Convert calibration outcomes and Pinnacle CLV into source trust weights
Build a bounded source-trust module using settled forecast outcomes, Pinnacle no-vig closing-line evidence, and Brier/log-loss to produce source-specific sizing multipliers.
- **Why now**: Settlement sync is complete, fair-line edge flows into previews. The next alpha step is letting proven sources size larger.
- **Done when**: Run-cycle candidate previews include source trust weight, CLV/log-loss inputs, and adjusted size.

## 6. Wire Kalshi account limits and rate-limit token buckets into live run packets
Kalshi now provides `/account/limits` with per-tier token bucket rate limits and endpoint-cost introspection. Live sports execution needs this evidence for route viability decisions.
- **Why now**: Kalshi rolled out tiered token-cost rate limits. Live execution that exceeds the bucket causes 429s and missed legs.
- **Done when**: Live Kalshi run packets include parsed token bucket values, endpoint costs, and route-level submit budget.

## 7. Wire Polymarket US preview and automation proof into live sports legs
Ensure every Polymarket US sports live-submit path captures `/v1/order/preview`, explicit slippage tolerance (ticks-based), and automation indicator proof before submit.
- **Why now**: Polymarket V2 simplified order structures but slippage behavior remains dangerous without explicit preview-before-submit.
- **Done when**: No live Polymarket leg can be submitted without preview response, automation indicator, and slippage tolerance in the proof payload.

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

# What NOT to work on
- Do not re-propose completed items listed above.
- Do not prioritize politics, economics, or crypto markets over sports.
- Do not build new provider abstractions when existing modules can be extended.
- Do not spend cycles on generic defensive work, broad refactors, or test-only hygiene unless directly required by a priority task.
- Do not propose OPENAI_API_KEY configuration tasks — it's already configured.
- Do not propose V1 CLOB work — V2 is now live and V1 is deprecated.

# Regulatory awareness
The CFTC-vs-states jurisdictional battle is escalating. 38 state AGs vs CFTC, with Congress introducing legislation to reclassify sports event contracts as gambling. Kalshi prediction markets on sports events remain operational but face regulatory uncertainty. Monitor weekly; no code changes needed unless platform rules change.
