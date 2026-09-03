---
updated: 2026-09-03
refreshedBy: operator-wayfinder-seed
researchCycle: csb-founding-pack
tags: [hydra, hydra/direction, csb]
---
> **This is the founding seed, not a research-cycle output.** It was drafted during wayfinder map [CSB founding pack](https://github.com/gaberoo322/hydra/issues/4313) before the repo existed, from the founding-grill decisions. The first `hydra-target-research` cycle after repo creation replaces it with a measured `priorities.md` + `roadmap.md`; until then this ordering is authoritative. Consistent with `vision.md` and the ADR-0013 CSB amendment.

# Current state

**Pre-repo.** `gaberoo322/claw-street-bets` does not exist yet; its creation is the first act after the founding map closes. No code, no data, no trades. Every item below is a founding milestone, ordered as tracer bullets: each one produces a thin end-to-end slice the next one widens, and nothing is built ahead of the slice that needs it.

Locked decisions this seed is built on (detail lives in the map's tickets, never restated here):

- Venue: Coinbase Advanced Trade; Kraken fallback on fees.
- Universe: crypto spot majors via a config-driven liquidity filter; long-only; 5m–1h bars.
- Roster: three archetypes (dual-EMA trend, Bollinger/RSI mean reversion, Donchian breakout), k = 3, no personal picks; per-candidate random-entry control fleets (≥ 200 paths) plus a computed buy-and-hold line.
- Gate: two-stage paper screen-then-confirm, ≥ 400 trades and ≥ 180 days per stage, numbers pre-registered in `outcomes.yaml` and operator-only-editable.
- Stack: TypeScript, Next.js dashboard, Postgres, systemd workers, app at repo root (`appSubdir: ""`).
- Salvage: ~10 named carries from hydra-betting (credential fence, fail-closed loss composition, dead-man's-switch verdict layer, sizing caps, order/risk-change schema shapes, manifest/CI/automerge/deploy patterns, ratchet mechanism, CONTEXT.md convention); nothing from the arb machinery; no Brier pipeline; the fill model is new.

# Priority tasks

## 1. Repo scaffold + manifest + CI — the verify loop exists before any feature (keep-it-boring)

Create the repo at root (`appSubdir: ""`), with `.hydra/manifest.json` (install/test/typecheck/build verify block, `riskCritical.surface` globs derived from the five invariants, `mutationKillFloor`), the typecheck-and-test CI workflow plus the automerge shape mirrored from hydra-betting, Postgres and systemd unit naming, and a `CONTEXT.md` seed. `npm test` is the real suite from day one — never a count gate aliased over it. Done when Hydra can open a PR against the empty app and CI judges it.

## 2. Market data: candle store + liquidity-filter universe (keep-the-fill-model-honest)

Coinbase Advanced Trade adapter, read-only keys: websocket trades + top-of-book, REST candles, into a Postgres candle store keyed by product and bar size. The liquidity filter (min 24h volume, max spread) is config and selects the universe on a schedule. Backfill depth and storage layout are decided here (venue-dependent; still fog on the map). Done when the store has continuous 5m–1h history for the filtered universe and a gap detector that halts anything downstream on stale data.

## 3. The fill model + minimal event-driven backtester (keep-the-fill-model-honest)

One fill simulator — itemised fees, modelled slippage, book-aware limit-fill rules — and an in-repo event-driven backtester that consumes the candle store through it. The round-trip cost model `c` is itemised and frozen at gate pre-registration (Coinbase One's effect on Advanced Trade fees must be verified first — operator action below). Done when a trivial strategy backtests end to end and the fee and slippage components are separately observable in the result.

## 4. Strategy interface + roster + control fleets (prove-edge-honestly)

A strategy interface that exposes its **risk template** (sizing, stop distances, holding-time distribution) so a random-entry control fleet can inherit it mechanically. Implement the three archetypes with parameters delegated to backtest sweeps under the frozen-parameter protocol, the ≥ 200-path control fleets per candidate, and the buy-and-hold benchmark line. Done when each candidate's backtest reports its Sharpe against its own control-fleet p95.

## 5. Paper trading loop + trial ledger + outcome writers (compound-the-learning-loop)

A systemd worker runs the roster on live data through the same fill model, one independent $10k nominal bankroll per candidate, with an append-only trial ledger recording every Stage-A entry forever. Outcome writers emit the numeric files `outcomes.yaml` reads: rolling paper expectancy/Sharpe, max drawdown, settled-trade count, and paper-vs-shadow-backtest divergence. Done when a full day of paper trades settles and every leading outcome reads a real number.

## 6. Risk invariants as enforced code (protect-the-capital)

Bracket-order shape through the venue adapter (paper lane simulates the venue-side stop identically), per-trade risk cap, fail-closed daily-loss halt with operator reset, dead-man's switch cancelling open orders on heartbeat loss, and the credential fence separating dev-time code from live keys. Each invariant gets a test that proves the *failure* path, and the manifest's risk-critical surface covers all five. Done when the mutation floor holds over that surface.

## 7. Operator dashboard + live-lane interface stub (protect-the-capital / keep-it-boring)

Next.js dashboard showing per-strategy graduation records against the pre-registered bar, fill-model divergence, halt and kill-switch state, and the trial ledger. The live lane exists as an interface with no keys behind it; the paper phase never provisions `can_trade`. Done when the operator can read the state of every gate from one page without a database query.

# What's been completed (DO NOT re-propose)

Nothing has been built. The following are **decided** on the founding map and are not open questions:

- Destination, business definition, ADR-0013 stays (B), real-money scale and gating, crypto-first, full betting mothball — founding grill.
- Launch venue and fallback, paper-phase key scopes, dedicated portfolio — venue decision.
- Graduation-bar statistics and gate shape — graduation-bar research.
- Strategy roster, control design, long-only, independent bankrolls, k = 3 — roster grill.
- Salvage carries and do-not-carry list — salvage audit.
- ADR-0013 CSB amendment — merged.

# What NOT to work on

- Cross-venue or multi-venue anything. One venue at launch.
- A stocks lane, memecoins, derivatives, short selling.
- Scalping or tick-latency infrastructure.
- Any LLM call in the trading process. Any ML meta-model.
- An off-the-shelf strategy framework in place of the in-repo backtester.
- Editing the graduation bar. Hydra proposes in an issue; the operator merges.
- Live trading keys, `can_trade`, or any real-money path before both paper stages pass.
- Porting hydra-betting's arb machinery, Brier pipeline, venue ticker fences, or the npm-test count gate.

# Operator actions needed

- **Verify Coinbase One's effect on Advanced Trade / API fees** on the primary fee page (bot-blocked; a browser read). Must settle before the cost model `c` is frozen for the gate.
- **Create the dedicated Coinbase portfolio** and provision market-data + read-only (`can_view`) portfolio-scoped keys for the paper phase. Never the personal account's keys; never `can_transfer`.
- **Lock the graduation numbers** in `outcomes.yaml` once drafted (map ticket), and decide the per-trade risk % and daily-loss cap % the invariants parameterise.
