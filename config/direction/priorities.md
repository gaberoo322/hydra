---
updated: 2026-06-06
refreshedBy: claude-research
researchCycle: research-target-2026-06-06
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable, and venue integration is currently fresh: the codebase already consumes Kalshi `/markets/orderbooks` batch reads, `/account/endpoint_costs`, V2 `/trade-api/v2/orders` (off the deprecated `/portfolio/orders`), `order_group_updates` WS, and the corrected Polymarket CLOB V2 (pUSD, keyset≤100 clamp, 200 req/s ceiling). Tests are green on a full run (5237 passing, 2026-06-06). Active backlog is deep (68 queued, work-queue empty); per operator preference the gate is **selection quality and external-state correctness, NOT backlog volume** — do not pad. This cycle surfaced a small set of verified, sports-edge findings against first-party changelogs plus one real test-isolation defect. Market context strongly reaffirms the sports-first mandate: prediction markets crossed a $5.6B week with Kalshi taking ~71% of volume, and the 2026 NBA Finals champion is the single largest market on BOTH Kalshi (~$274M) and Polymarket (~$413M) — sports forecast and execution edge is exactly where the money is right now.

# Verified external venue state (2026-06-06, first-party changelogs)
- **Kalshi `GET /margin/fee_tiers` was restructured 2026-05-11** to return per-market `maker_fee_rates`/`taker_fee_rates` maps, and a **2026-06-11** fix restores active (non-zeroed) rates. The codebase has the *resolver* (`resolveKalshiFeeRate`, ticker-vs-default selection) wired into sports-candidate ranking (#18), but **nothing fetches the live per-market fee map** — ticker fees are caller-supplied and effectively default today. Wiring the live fetch sharpens fee-adjusted sports edge (money-critical).
- **Kalshi automated rate-limit tiers (Premier/Paragon/Prime) went live 2026-06-05**, earned from trailing volume and visible via the `grants` array; **legacy order-mutation rate-limit costs rose to 10x V2 on 2026-06-04**. The codebase already migrated to V2 order endpoints and schematizes `endpoint_costs`, but has **no `grants`/earned-tier awareness** — the live submit path cannot see its current token-budget headroom, risking silent throttling during a dual-leg burst.
- **Kalshi `POST /communications/quotes` accepts `post_only` (2026-05-05)** and post-only crossing now reports `PostOnlyCrossCancel` (2026-06-04). `post_only` already appears in `kalshi-orders/order-submission`; the open question is verification, not new code (the RFQ-accepted-quote promotion path should not cross).
- **Polymarket CLOB V2 is correctly wired** (sdk-v2-compat, pUSD, keyset≤100 clamp via item-402, 200 req/s ceiling guard). There is **NO V3 API and NO June-15 forced-liquidation deadline** — that prior premise was FALSE (third-party SEO blogs). Always pin venue assumptions to docs.polymarket.com/changelog and docs.kalshi.com/changelog.
- **Polymarket `builderCode` attribution fields (2026-05-18)** were added to builder leaderboard/volume endpoints — relevant only if pursuing builder-revenue-share accounting (a reconciler already exists); not a priority.

# Priority tasks
## 1. Fix `scanner.test.ts` standalone test isolation (technical / close-the-learning-loop)
`web/src/lib/arbitrage/scanner.test.ts` (162 tests) passes in a full `npm test` run but fails 162/162 when run alone with `Cannot find package '@/lib/providers/polymarket'` (and sibling `@/`-alias errors from `scanner.ts`/`verified-pairs.ts`). The `@/` path alias is not resolved when vitest runs this file outside the full project graph.
- **Why now**: this breaks targeted CI/dev test runs of the single most safety-critical module (the arbitrage scanner) and lets regressions hide behind a green full-suite. A self-evaluating system must be able to run its scanner tests in isolation. Concrete and bounded.
- **Done when**: `npx vitest run web/src/lib/arbitrage/scanner.test.ts` passes standalone (alias resolution fixed in vitest config or via the importing chain), and the full suite stays green. Add a guard, if cheap, that the scanner test file resolves its `@/` imports independently.

## 2. Wire live Kalshi `GET /margin/fee_tiers` into per-market sports fee resolution (domain / sharpen-forecasts / improve-execution-discipline)
Fetch the live per-market `maker_fee_rates`/`taker_fee_rates` map and feed the matched ticker's rate into `resolveKalshiFeeRate` so `feeAdjustedEdge` reflects the venue's actual per-market fee instead of a caller default.
- **Why now**: executable sports edge is fee-constrained; the resolver already exists but is fed defaults, so the fee-adjusted ranking can over- or under-state edge on the exact NBA/sports markets carrying the most volume right now. The endpoint was just restructured (2026-05-11) and its zeroed-response bug fixed (2026-06-11), so the data is finally trustworthy. Money-critical, bounded, sports-first.
- **Done when**: a provider fetch loads `/margin/fee_tiers` into a per-ticker fee map (cached/normalized), the sports candidate path supplies `tickerKalshiTakerFeeRate`/`tickerKalshiMakerFeeRate` from that map when present, `kalshiFeeSource` reports `"ticker-specific"` on at least one live sports ticker, and tests cover a ticker-specific rate changing `feeAdjustedEdge` vs the default path.

## 3. Surface Kalshi earned rate-limit tier (`grants`) and token-budget headroom on the live submit path (protect-the-operation / compress-time-to-signal)
Read the `grants` array / `/account/limits` refill-rate + bucket-capacity and expose current earned tier (Premier/Paragon/Prime) and remaining token headroom to the dual-leg execution preflight and operator health surface.
- **Why now**: legacy mutation costs are now 10x V2 (2026-06-04) and tiers are volume-earned (2026-06-05); a dual-leg arbitrage burst that exceeds the current bucket gets silently throttled, turning a hedged pair into one-legged exposure. The codebase schematizes `endpoint_costs` but is blind to its earned tier. Protects live execution.
- **Done when**: the execution preflight (or operator-health payload) reports active Kalshi rate-limit tier and remaining token headroom for the submit endpoints, with a test asserting a low-headroom state is detectable before a dual-leg submit.

## 4. Persist fee-adjusted sports ranking evidence (carried forward — domain / deepen-structural-understanding)
Promote the fee, rounding, slippage, depth, source-trust, and CLV evidence already computed in sports candidate mapping into durable sports edge candidate rows or structured metadata. Pairs naturally with #2 (live fee map) — together they make fee-adjusted edge both correct AND inspectable.
- **Why now**: executable sports edge is depth- and fee-constrained, and the richest ranking inputs are currently lost after in-memory scoring.
- **Done when**: persisted sports candidates expose pre-fee edge, fee-adjusted edge, fee source, rounding assumption, depth evidence, CLV bucket, source trust, and final rank delta, with mapper and persistence tests covering at least one Kalshi and one Polymarket row.

## 5. Rank executable depth and opportunity half-life ahead of raw edge (carried forward — improve-execution-discipline / compress-time-to-signal)
Wire existing depth previews and timing evidence into sports opportunity ordering so shallow or fleeting opportunities are discounted before they reach operator review.
- **Why now**: Polymarket NBA executable arbitrage windows can last only seconds and many combinatorial opportunities are size-constrained, so raw percentage edge is not enough for profitable ranking.
- **Done when**: sports review candidates include executable depth, observed half-life or stale-duration estimate, depth-adjusted expected value, and rank impact, with tests showing a smaller raw edge outranking a larger but non-executable edge.

## 6. Add lineup/inactive catalyst response cohorts (carried forward — compress-time-to-signal / sharpen-forecasts)
Convert existing injury and lineup signal plumbing into measurable sports catalyst cohorts that report prediction-market lag after sharp-book movement.
- **Why now**: lineup and inactive timing can become a measurable catalyst edge, and the repo already has injury signal modules (now extended to MLB+MLS) plus recency ranking. Advances time-to-signal without adding generic freshness labels.
- **Done when**: candidate or calibration output groups catalyst candidates by catalyst type, observed timestamp, lead-time bucket, sharp-line move, prediction-market response delay, and CLV result, with tests for at least one injury or inactive-style catalyst.

## 7. Verify Kalshi RFQ-accepted-quote promotion uses `post_only` (execution / verify-only)
Confirm the RFQ accepted-quote → submit-ready promotion path (`accepted-rfq-promotion-handoff`) carries `post_only` so a promoted maker quote cannot accidentally cross and pay taker fees, and that `PostOnlyCrossCancel` is handled rather than treated as a generic rejection.
- **Why now**: `post_only` exists in order-submission but the RFQ promotion handoff should be explicitly verified post the 2026-05-05/2026-06-04 changes. Smallest item; verify-or-fix.
- **Done when**: a test asserts the RFQ-promoted submit packet sets `post_only` and that a `PostOnlyCrossCancel` update reason is classified as a no-cross outcome, not a failure.

# What's been completed (DO NOT re-propose)
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
- Promote Kalshi RFQ accepted quotes into submit-ready execution packets (item-467) — `post_only` carry-through is the open verify (priority 7).
- Expose sports forecast edge evidence on dashboard review flows (item-469).
- Polymarket CLOB V2 client wiring AND verification: sdk-v2-compat, pUSD collateral, gamma keyset≤100 clamp, 200 req/s ceiling guard (item-402 closed).
- Adopt Kalshi `order_group_updates` WS account channel for live execution-state lead (item-483).
- Migrate Kalshi off deprecated `/portfolio/orders` to V2 `/trade-api/v2/orders` (guard test in place).
- Consume Kalshi `/markets/orderbooks` batch read and `/account/endpoint_costs`.
- Wire `resolveKalshiFeeRate` into sports-candidate ranking (#18) — live fee-map fetch is the open follow-up (priority 2).
- Extend SportsDataIO injury feed to MLB + MLS.
- Add sharp-book lead-lag evidence to sports route ranking (item-429).
- Add standalone `pair_key` indexes on scanner_opportunities + alert_states (item-316).
- Enforce Polymarket CLOB 200 req/s server rate ceiling guard (item-402).

# What NOT to work on
- **Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real.** FALSE premise from third-party SEO blogs, contradicted by the official changelog. The real venue change is CLOB V2 (2026-04-28), already wired and verified.
- Do not re-build the Kalshi `resolveKalshiFeeRate` resolver — it exists (#18). Priority 2 is the live fee-map *fetch* that feeds it, not the resolver.
- Do not re-migrate Kalshi order endpoints to V2 — already done with a guard test. Do not re-clamp the Polymarket gamma keyset limit — done (item-402). Do not re-add the Polymarket 200 req/s ceiling guard — done (item-402).
- Do not prioritize defensive hardening, fail-closed rewrites, generic preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks. (Exception: the narrow, money-critical rate-limit-headroom probe in priority 3 is execution-protection, not generic hardening.)
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available — market data this week confirms sports IS the volume.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- Do not re-propose "Promote clean SportsGameOdds discovery matches into verified-pair candidates" or any variant wiring SGO discovery into verified-pair promotion as a multi-cycle drift loop.
- Do not propose broad multi-cycle abstractions like "improve edge model" without a concrete single-cycle implementation target.
- **Do not pad the backlog.** It holds 68 queued items across all five dimensions; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput). Prefer correcting stale/false items and pulling the best existing items into the work queue over inventing new ones.
