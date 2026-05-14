---
updated: 2026-05-11
refreshedBy: director
researchCycle: research-2026-05-11-0549
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first and execution-capable: Kalshi/Polymarket routing, reconciliation, verified pairs, Pinnacle fair lines, CLV cohorts, injury recency ranking, and paper calibration are already in place. The next cycle should stop adding defensive proof surfaces and convert existing sports evidence into durable, fee-aware, timestamp-locked opportunity ranking that can explain why a candidate should be traded now.

# Priority tasks
## 1. Enqueue Polymarket sports candidates into paper review
Extend the existing sports paper review enqueue path so Polymarket candidates are included alongside Kalshi candidates instead of being dropped after ranking.
- **Why now**: Technical research found the ranking path can evaluate Kalshi and Polymarket rows, but scheduled paper review only enqueues Kalshi rows. This is a small wiring task that improves cross-venue profitability evidence without broad refactoring.
- **Done when**: The paper review path persists eligible Polymarket candidates with venue identity, edge, price, and source evidence, and tests cover one Kalshi and one Polymarket candidate being enqueued in the same review run.

## 2. Persist fee-adjusted sports ranking evidence
Promote the fee, rounding, slippage, depth, source-trust, and CLV evidence already computed in sports candidate mapping into durable sports edge candidate rows or structured metadata.
- **Why now**: Domain research shows executable sports edge is depth- and fee-constrained, and technical research identified that the richest ranking inputs are currently lost after in-memory scoring.
- **Done when**: Persisted sports candidates expose pre-fee edge, fee-adjusted edge, fee source, rounding assumption, depth evidence, CLV bucket, source trust, and final rank delta, with mapper and persistence tests covering at least one Kalshi and one Polymarket row.

## 3. Add lineup/inactive catalyst response cohorts
Convert existing injury and lineup signal plumbing into measurable sports catalyst cohorts that report prediction-market lag after sharp-book movement.
- **Why now**: Domain research found lineup and inactive timing can become a measurable catalyst edge, and the repo already has injury signal modules plus recency ranking. This advances time-to-signal without adding generic freshness labels.
- **Done when**: Candidate or calibration output groups catalyst candidates by catalyst type, observed timestamp, lead-time bucket, sharp-line move, prediction-market response delay, and CLV result, with tests for at least one injury or inactive-style catalyst.

## 4. Rank executable depth and opportunity half-life ahead of raw edge
Wire existing depth previews and timing evidence into sports opportunity ordering so shallow or fleeting opportunities are discounted before they reach operator review.
- **Why now**: 2026 Polymarket NBA research found executable arbitrage windows can last only seconds and many combinatorial opportunities are size-constrained, so raw percentage edge is not enough for profitable ranking.
- **Done when**: Sports review candidates include executable depth, observed half-life or stale-duration estimate, depth-adjusted expected value, and rank impact, with tests showing a smaller raw edge outranking a larger but non-executable edge.

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
- Add timestamp-locked sports nomination replay metrics (shipped cycle-2026-05-11-0606).
- Kalshi and Polymarket execution and reconciliation foundations.
- Verified KXNBA Kalshi-Polymarket pair registry seeded and consumed.
- Paper LLM probability estimator and calibration dashboard.
- Pinnacle fair-line ingestion and no-vig derivation.
- Negative-risk and sports combinatorial scan modules.

# What NOT to work on
- Do not prioritize defensive hardening, fail-closed rewrites, preflights, guard rails, migration-drift gates, or broad executor refactors unless the operator explicitly asks.
- Do not pull focus into politics, economics, culture, or crypto-adjacent markets while sports forecast and signal compounding work remains available.
- Do not re-propose completed CLV cohort reporting, Kalshi price range normalization, exact league CLV matching, World Cup team normalization, zero-persistence diagnostics, injury-recency ranking, CLV-gated sizing integration, sharp-line sizing provenance, fee-adjusted ranking delta, or timestamp-locked nomination replay metrics.
- Do not re-propose the abandoned generic sharp-line movement boost; future sharp-line work must be cohort-based, timestamp-locked, or tied to catalyst response measurement.
- **Do not re-propose "Promote clean SportsGameOdds discovery matches into verified-pair candidates" or any variant wiring SGO discovery into verified-pair promotion.** This task burned $300+ across 6 cycles on 2026-05-11 (drift + cost-cap failures). It is blocked on missing `settlementRuleEvidence` schema fields tracked under backlog item-445; only revisit after item-445 ships.
- Do not re-propose verified-pair intake expansion with provider-native depth IDs or non-KXNBA verified-pair discovery — speculative item-444 was abandoned 2026-05-11 after no concrete scope materialized.
- Do not propose broad multi-cycle abstractions like "improve edge model" without a concrete single-cycle implementation target.
