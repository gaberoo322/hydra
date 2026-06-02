---
updated: 2026-06-01
refreshedBy: claude-research
researchCycle: research-target-2026-06-01
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable: Kalshi/Polymarket routing, reconciliation, verified pairs, Pinnacle fair lines, CLV cohorts, injury recency ranking, and paper calibration are in place. Tests green (5083 passing, 2026-06-01). Active backlog is deep (76 queued items spanning all five research dimensions); the gate on throughput is selection quality and external-state correctness, NOT backlog volume. This cycle's highest-value finding was a correction: a forced top-priority item (item-402, "Polymarket V3 / June-15 forced-liquidation") was built on a FALSE premise sourced from third-party SEO blogs and is contradicted by the official Polymarket changelog. It has been rewritten to the verified reality. Continue converting existing sports evidence into durable, fee-aware, timestamp-locked opportunity ranking that explains why a candidate should be traded now — and keep external venue assumptions pinned to first-party changelogs.

# Verified external venue state (2026-06-01, first-party changelogs)
- **Polymarket CLOB V2 went live 2026-04-28** — collateral USDC.e → pUSD; NO V1 compatibility (V1-signed orders rejected). There is **NO V3 API and NO June-15 forced-liquidation deadline** (docs.polymarket.com/changelog). Codebase already wires `sdk-v2-compat.ts` + pUSD in `provider.ts`; the open work is verification, not a new client.
- **2026-06-01 Polymarket rate limits raised** to 200/s sustained on POST/DELETE `/order`; batch 2000/10s burst. Check the CLOB rate-limiter does not under-throttle vs the new ceiling.
- **2026-05-14 Polymarket `GET /markets/keyset` max `limit` capped at 100.** The gamma client passes the caller `limit` through unclamped, so any caller requesting >100 silently truncates pagination.
- **Kalshi is current**: codebase consumes `_fp`/`_dollars` fields (post-2026-03-12 integer-field removal) and `/account/limits`; no deprecated-field exposure found.

# Priority tasks
## 1. Polymarket CLOB V2 verification: pUSD path, keyset clamp, rate-limit ceiling (item-402, corrected)
Verify the live execution path signs V2 (pUSD collateral) orders end-to-end with no V1 ClobClient on the submit path; clamp the gamma `keyset` limit to ≤100 with continuation so >100-row pulls paginate instead of truncating; confirm the CLOB rate-limiter is consistent with the 2026-06-01 ceiling.
- **Why now**: V2 has no V1 compatibility and went live 2026-04-28 — a stray V1 sign path or a silently-truncated market pull degrades the Polymarket leg without erroring. Protects the operation; concrete and bounded.
- **Done when**: a test asserts the live submit path uses the V2 client + pUSD collateral; gamma keyset >100-row pulls paginate correctly under test; rate-limiter ceiling matches the changelog.

## 2. Enqueue Polymarket sports candidates into paper review
Extend the existing sports paper review enqueue path so Polymarket candidates are included alongside Kalshi candidates instead of being dropped after ranking.
- **Why now**: the ranking path can evaluate Kalshi and Polymarket rows, but scheduled paper review only enqueues Kalshi rows. Small wiring task that improves cross-venue profitability evidence without broad refactoring.
- **Done when**: the paper review path persists eligible Polymarket candidates with venue identity, edge, price, and source evidence, and tests cover one Kalshi and one Polymarket candidate enqueued in the same run.

## 3. Persist fee-adjusted sports ranking evidence
Promote the fee, rounding, slippage, depth, source-trust, and CLV evidence already computed in sports candidate mapping into durable sports edge candidate rows or structured metadata.
- **Why now**: executable sports edge is depth- and fee-constrained, and the richest ranking inputs are currently lost after in-memory scoring.
- **Done when**: persisted sports candidates expose pre-fee edge, fee-adjusted edge, fee source, rounding assumption, depth evidence, CLV bucket, source trust, and final rank delta, with mapper and persistence tests covering at least one Kalshi and one Polymarket row.

## 4. Add lineup/inactive catalyst response cohorts
Convert existing injury and lineup signal plumbing into measurable sports catalyst cohorts that report prediction-market lag after sharp-book movement.
- **Why now**: lineup and inactive timing can become a measurable catalyst edge, and the repo already has injury signal modules plus recency ranking. Advances time-to-signal without adding generic freshness labels.
- **Done when**: candidate or calibration output groups catalyst candidates by catalyst type, observed timestamp, lead-time bucket, sharp-line move, prediction-market response delay, and CLV result, with tests for at least one injury or inactive-style catalyst.

## 5. Rank executable depth and opportunity half-life ahead of raw edge
Wire existing depth previews and timing evidence into sports opportunity ordering so shallow or fleeting opportunities are discounted before they reach operator review.
- **Why now**: Polymarket NBA executable arbitrage windows can last only seconds and many combinatorial opportunities are size-constrained, so raw percentage edge is not enough for profitable ranking.
- **Done when**: sports review candidates include executable depth, observed half-life or stale-duration estimate, depth-adjusted expected value, and rank impact, with tests showing a smaller raw edge outranking a larger but non-executable edge.

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
- Paper LLM probability estimator and calibration dashboard.
- Pinnacle fair-line ingestion and no-vig derivation.
- Negative-risk and sports combinatorial scan modules.
- Promote Kalshi RFQ accepted quotes into submit-ready execution packets (item-467).
- Expose sports forecast edge evidence on dashboard review flows (item-469).
- Add Pinnacle CLV slices for injury-adjusted candidates (item-477).
- Polymarket CLOB V2 client wiring (sdk-v2-compat, pUSD collateral) — verification still open (see priority 1).

# What NOT to work on
- **Do NOT build a "Polymarket V3" client or treat a June-15 forced-liquidation deadline as real.** This premise is FALSE — it came from third-party SEO blogs (laikalabs, tradoxvps) and is directly contradicted by the official Polymarket changelog. The real venue change is CLOB V2 (2026-04-28), already wired. Item-402 has been rewritten accordingly. Always pin venue assumptions to first-party changelogs before scoping migration work.
- Do not prioritize defensive hardening, fail-closed rewrites, preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- **Do not re-propose "Promote clean SportsGameOdds discovery matches into verified-pair candidates" or any variant wiring SGO discovery into verified-pair promotion** unless explicitly revisiting item-434 now that item-445 (`settlementRuleEvidence` schema) has merged — and even then, scope it as one bounded single-cycle task, not the prior 6-cycle drift loop.
- Do not re-propose verified-pair intake expansion with provider-native depth IDs or non-KXNBA verified-pair discovery without concrete scope.
- Do not propose broad multi-cycle abstractions like "improve edge model" without a concrete single-cycle implementation target.
- Do not pad the backlog. It already holds 76 items across all five dimensions; adding low-edge items to hit a volume target is counterproductive (operator preference: maintainability/selection-quality over throughput). Prefer correcting stale or false items over inventing new ones.
