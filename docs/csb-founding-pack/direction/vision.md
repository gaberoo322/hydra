# Vision

Run an autonomous intraday crypto trading business on the operator's own capital. The business metric is **real-money cumulative P&L net of fees**. Nothing else — not signals, not subscribers, not a product — counts as success.

Profit is the terminal goal, and it reads **zero until a strategy graduates**. That number stays honestly at zero through the entire paper phase; a leading metric that moves is not a substitute for it. Claw Street Bets (CSB) exists to find out whether deterministic, cheap, well-measured strategies have a repeatable edge on liquid crypto majors at intraday horizons, and to put real money behind only the ones that prove it against a bar written down *before* the first paper trade.

The system is built by Hydra ([ADR-0013](https://github.com/gaberoo322/hydra/blob/master/docs/adr/0013-swappable-single-target-builder.md), CSB amendment): CSB is the builder's second crucible. LLMs research, write, and review the strategies and the machinery; they never sit in the per-trade decision path.

# Universe

**Crypto spot majors on one venue, Coinbase Advanced Trade, intraday on 5m–1h bars.**

- **Venue.** Coinbase Advanced Trade is the launch venue because its atomic server-side bracket order (entry + stop-loss + take-profit) is exactly the shape risk invariant #1 demands. Fees are tiered on trailing 30-day volume (0.60% maker / 1.20% taker at the bottom, 0.125% / 0.25% from $75K, 0.06% / 0.125% from $500K); paper trading accrues no tier volume, so every live start pays the bottom tier for one month before the template's turnover lifts it. Kraken is the named fallback, re-examined and not triggered once the primary schedule was read (2026-09-04): it is cheaper only below ~$75K/30d and has no spot bracket order. One venue at launch; the venue adapter is a seam, and a second adapter is its own later effort.
- **Universe = a config-driven liquidity filter, never a hardcoded list.** Minimum 24h volume and maximum spread thresholds select the tradable set from the venue's product list. Memecoins and microcaps are a different risk regime, not a wider filter.
- **Horizon = intraday-to-hours.** "Day trading" means holding periods from minutes to hours on 5m–1h bars. Scalping is structurally unwinnable from a home server against colocated firms; swing holds slow the learning loop below what a paper program can afford. Both are out of scope at launch.
- **Long-only spot at launch.** Flat is the short. Derivatives and short selling are a possible post-graduation effort with their own venue surface and their own gate.

# Decision Vectors

Every feature, task, and research cycle must advance at least one of these five vectors. Work advancing several is prioritised. Work that advances none is rejected.

1. **Prove edge honestly.** Confidence in a strategy is its *measured* per-strategy edge — rolling paper and backtest expectancy against strategy-shaped random-entry controls — never conviction, narrative, or a model's opinion. A strategy earns each trade by its own record. Beating zero is not the bar; beating the best of the controls is.

2. **Keep the fill model honest.** CSB owns one fill simulator (fees, slippage, book-awareness, limit-fill rules) that prices backtest, paper, and live identically: *one fill model, three clocks*. Paper-vs-backtest divergence is a first-class metric. When it breaches tolerance, the fill model is declared lying, trading halts, the model is fixed, and the stage clock resets. Edge measured on fantasy fills is not edge.

3. **Protect the capital.** The five risk invariants below are non-negotiable and are enforced in the same code path in paper and live. A strategy that trips a kill criterion demotes; it is never tuned in place while it keeps trading at the same stake.

4. **Compound the learning loop.** Every strategy ever entered into the screen stage is recorded forever in an append-only trial ledger, so the graduation bar always knows how many tickets have been bought. Hydra proposes new candidates, promotes what passes, and retires what fails — through the ledger, never around it.

5. **Keep the machinery boring and swappable.** Deterministic technical-analysis strategies, TypeScript, Postgres, systemd workers, one venue seam. Anything an LLM can do at development time it does there; nothing an LLM does happens at trade time. A strategy framework that would make CSB someone else's bot with Hydra reduced to writing its config is rejected.

# Graduated Capital

Capital is earned in stages. No strategy skips a stage, and every promotion is decided by a **pre-registered graduation bar** that lives in `outcomes.yaml`, is written before the first paper trade, and is editable only by the operator — never by the system being measured.

1. **Paper (Stage A — screen).** Full pipeline on live market data through the owned fill model, each candidate on its own independent nominal bankroll ($10k at launch). The screen prices in selection: the Sharpe floor rises with the number of strategies ever tried, and the candidate must beat the p95 of its own random-entry control fleet on the same risk template.
2. **Paper (Stage B — confirm).** Parameters frozen, fresh window, the same bar with selection removed. Any parameter edit resets the clock. Fill-model divergence beyond tolerance halts the stage and resets it.
3. **Live proof.** Real money at minimum viable stake, only after both paper stages pass. Realized fill quality, realized-vs-expected edge, and slippage/fee drag must sit inside the modelled bounds.
4. **Scaled.** Stake grows stepwise within the bankroll constraints, never in one jump.

The exact numbers — sample sizes, calendar minimums, Sharpe and expectancy floors, drawdown backstops, divergence tolerances — are in `outcomes.yaml`, derived in the graduation-bar research and locked by the operator. This file states the *shape* of the gate so the numbers cannot be argued back down under pressure from a promising-looking curve. **Kill criteria are defined per stage before the stage begins.**

# Risk Invariants

These five hold in every lane — backtest, paper, live — and derive the risk-critical surface in `.hydra/manifest.json`. A change that touches any of them is money-critical.

1. **Every entry carries a server-side stop.** Orders are placed as venue-side brackets (entry + stop-loss + take-profit). If our process dies, the stop lives at the venue.
2. **Per-trade risk is capped at a fixed percentage of bankroll.** The percentage is a risk-config parameter set by the operator, not by a strategy.
3. **A daily loss cap halts trading until the operator resets it.** The halt is fail-closed: an unreadable P&L is a halt, not a pass.
4. **A dead-man's switch cancels every open order on heartbeat loss.** Filled positions are protected by their venue-side stops; unfilled entries are cancelled client-side when the heartbeat stops.
5. **Live keys sit behind a credential fence that development-time code cannot read.** The paper phase provisions market-data and read-only keys only. Trading permission is granted only after the graduation bar passes; transfer permission is never granted. CSB trades from a dedicated venue portfolio with portfolio-scoped keys, isolated from the operator's personal holdings.

# Constraints

- The graduation bar in `outcomes.yaml` is **operator-only-editable**. Hydra may propose a change to it in an issue; it may not merge one.
- Real money is thousands-scale and enters only through the Graduated Capital stages above. Paper first, always.
- **No LLM inference in the trading process.** Not for signals, not for sizing, not for exits. LLMs work in the development loop (Hydra researching, writing, reviewing strategies and machinery). The prior crucible's paper-LLM A/B found neither a local model nor a frontier model beat the market, while burning the development quota.
- The fill model is shared code. A change to it is a change to every lane and is money-critical.
- The trial ledger is append-only. Retired and failed candidates are never deleted; they keep counting.
- Every order, fill, halt, and kill-switch event is logged with timestamps, the strategy that produced it, and the sizing inputs.
- Never trade on stale data: a stale feed is a halt, not a guess.
- Must be recoverable from any crash state without manual intervention — with all open orders cancelled and all positions still protected by their venue-side stops.
- No API keys or secrets in source code. Keep all tests passing; never ship a regression.

# What this is not

- **Not a product.** No customers, no signals-as-a-service, no copy-trading, no SaaS.
- **Not a stocks system at launch.** The architecture stays multi-asset; a stocks lane is a second venue adapter and its own effort after crypto proves the seam (the PDT rule also bites real-money stock day-trading under $25k).
- **Not a scalper, not a swing trader.** 5m–1h bars, intraday-to-hours holds.
- **Not an ML meta-model.** A possible later map, once a real trade corpus exists.
- **Not someone else's bot.** A minimal in-repo event-driven backtester shares the fill simulator with paper and live; off-the-shelf strategy frameworks are rejected.
