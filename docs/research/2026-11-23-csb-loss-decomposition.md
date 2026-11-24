# Loss decomposition: is there gross edge under the three Archetypes' costs?

Wayfinder map #5687, ticket #5689. Research only: no venue, instrument or strategy is recommended here (the cost-structure pivot ticket #5693 decides). Run 2026-11-23/24.

## Answer in short

| Archetype | Frozen cost c | Frozen pick: gross / cost / net (bps per trade) | Gross across the grid (min / median / max) | Points with gross > 0 (t > 2) | Verdict |
|---|---|---|---|---|---|
| trend-ema | 51 | -0.2 / 51.1 / -51.3 | -40.5 / -9.6 / +1.5 (76 points) | 12 (0) | No gross edge at any cost |
| meanrev-bbrsi | 51 | -0.1 / 53.5 / -53.6 | -84.3 / -5.0 / +14.3 (216 points) | 36 (0) | No gross edge at any cost |
| breakout-donchian | 66 | +4.4 / 66.7 / -62.3 | -3.8 / +3.4 / +29.4 (15 points) | 12 (0) | Not rescued as frozen; one thin, unproven lead at 1h |

- The loss is cost. No grid point has significantly positive gross expectancy (0 of 307 with a gross t-statistic above 2), and 60 are significantly negative (t below -2: 23 trend-ema, 37 meanrev-bbrsi). The realised cost of 51-69 bps per trade is charged on top of that.
- A cheaper cost structure alone rescues none of the three frozen picks. Their gross is between -0.2 and +4.4 bps, so the expectancy floor (net at least half the cost) would be met only at a hypothetical round-trip cost x below 0 / 0 / 2.9 bps. Here x is a what-if cost; c stays the frozen Cost Model value (51 / 51 / 66).
- At near-zero cost the breakout-donchian and meanrev-bbrsi frozen picks do not beat random long entries: the breakout pick sits at the 63rd percentile of its Control Fleet and the meanrev pick at the 11th. Random long entries had a positive median Sharpe at zero cost over this window (+0.2 to +0.5), which is consistent with a market that drifted up and signals that added nothing to it. No cheaper-cost fleet was run for trend-ema, whose frozen pick has gross below zero.
- The single exception is breakout-donchian at ONE_HOUR, channelBars 100: gross +29.4 bps (t = 1.83, 459 trades). It clears the floor at x below about 19.6 bps round trip. It beats its fleet p95 at 10.5 bps and misses at 16.5 bps, the only two costs tested in that range (a straight line between them crosses at about 14-15 bps). It is the best of 15 points, it is not significant, and it projects 113 trades per 180 days against the 400-trade per-stage floor. Treat it as a lead for a pre-registered hypothesis, not as evidence.

## Method

- **Source of truth.** The committed sweep evidence in claw-street-bets, `docs/sweeps/2026-11-02-{trend-ema,meanrev-bbrsi,breakout-donchian}.json` (window 2024-11-02 to 2026-11-02, BTC/ETH/SOL/XRP-USD, `csbGitSha` 4dc2c2c, graduation gate v3). The artifacts store net expectancy only, so the split needed a re-run.
- **Re-run.** Every grid point was replayed through the repo's own Backtest Clock (`runBacktest`) with the sweep runner's inputs: the same one-minute Bars from the candle store, `aggregateGridBars`, `freezeEntryStrategy`, `FROZEN_COST_MODEL` (maker 15, taker 30, slippage floor 3 bps per side, funding 0), the paper bankroll and Risk Template. Each settled trade's `grossPnl`, `slippage`, `fees` and `netPnl` were dumped, in bps of entry notional. Gross is the move between the entry and exit reference prices, so gross PnL does not depend on the cost model (in bps it moves by under 0.01, through the entry-notional denominator). The replay and analysis scripts were session scratch and are not committed; this section states everything they did.
- **Reconciliation.** Trade counts are identical to the artifact on all 307 points, and net expectancy agrees to 1e-12 bps. The numbers below are therefore the artifact's own trades, itemised.
- **The ticket's figures.** The ticket quotes nets of about -43, -58 and -104 bps. Those are the artifacts' Level 2 check (`selection.level2Run.check.level2ExpectancyNetBps`: -42.9, -57.8, -104.3 on 82, 100 and 79 trades in the short window with recorded books). This document itemises the frozen picks over the full 730-day window instead (-51.3, -53.6, -62.3 on 1,633 to 1,747 trades), because that is the sample the sweep ranked on. The Level 2 window trades were not itemised.
- **Fleet at other costs.** Selected points and their Control Fleet (200 paths, entry probability 0.05, seed 1, pooled over the four products, as `runSweepOverUniverse` does) were re-run through the exported `runControlFleet`, `pooledReadout` and `fleetPercentile` under cheaper cost models. At the frozen cost this reproduces the artifact's fleet p95 exactly (-0.7233 for breakout ONE_HOUR). With fees and slippage floor at zero, 1-8 bps of synthetic book-walk slippage remains; the tables give the realised cost.
- **Floor arithmetic.** At a hypothetical round-trip cost x, net = gross - x, and the expectancy floor wants net >= 0.5 x, so a point clears the floor when x <= gross / 1.5.
- Read-only: nothing was written to claw-street-bets or its database. CSB main was at e9500c8 to 6f12fc8 during the replays.

## Gross and cost per Archetype

Cost per trade is almost all fees: 45 bps (maker in, taker out) for trend-ema and meanrev-bbrsi, 60 bps (taker both ways) for breakout-donchian, plus slippage that grows with the granularity: 6-14 bps per point for trend-ema, 6-22 for meanrev-bbrsi, 6-9 for breakout-donchian.

**trend-ema (76 points).** Gross is positive on 12 points, 10 of them at FIVE_MINUTE, and never above +1.5 bps. The best gross t-statistic is 0.97. Gross falls as the granularity lengthens.

**meanrev-bbrsi (216 points).** Gross is positive on 36 points. The best five-minute point is +1.5 bps on 5,206 trades. The larger values are at thin points: +14.3 bps at THIRTY_MINUTE (bb 20 / 2.5, rsi 14 / 20) on 174 trades (t = 0.64), +11.1 bps at ONE_HOUR on 603 trades (t = 0.80). The frozen pick is -0.1 bps on 1,726 trades.

**breakout-donchian (15 points).** Gross is positive on 12 points, mostly +2 to +8 bps. ONE_HOUR channelBars 100 is the outlier at +29.4 bps; its neighbour channelBars 80 is +10.7 and channelBars 55 is -1.1, so it is not a plateau.

### By entry granularity (all points pooled, bps per trade)

| Granularity | Mean hold | trend-ema gross | meanrev-bbrsi gross | breakout-donchian gross |
|---|---|---|---|---|
| FIVE_MINUTE | 1.4-1.5 h | +0.1 | -0.5 | not in grid |
| FIFTEEN_MINUTE | 4.2-4.7 h | -5.0 | -6.7 | +1.5 |
| THIRTY_MINUTE | 8.2-9.3 h | -13.6 | -4.2 | +4.2 |
| ONE_HOUR | 15.9-16.9 h | -22.1 | -10.4 | +4.4 |

### By product (all points pooled, gross bps per trade)

| Product | trend-ema | meanrev-bbrsi | breakout-donchian |
|---|---|---|---|
| BTC-USD | -3.1 | +1.1 | -2.7 |
| ETH-USD | -5.3 | -6.1 | -0.7 |
| SOL-USD | -4.1 | -1.5 | +1.6 |
| XRP-USD | -8.3 | -4.3 | +13.0 |

No product carries a significant gross edge at any frozen pick (largest t: BTC under meanrev 1.40, XRP under breakout 1.27). The largest pooled cell, XRP under breakout-donchian at +13.0, pools all 15 points, and no single product-by-point cell for breakout-donchian or trend-ema reaches t > 2 (0 of 60 and 0 of 304; meanrev-bbrsi has 2 of 824, fewer than chance would give).

## Gross edge against holding time

Two different readings, and only the first is usable for design.

1. **Designed horizon (granularity).** Lengthening the bar, and with it the mean hold from about 1.5 h to about 16 h, does not add gross edge. It makes trend-ema and meanrev-bbrsi worse and lifts breakout-donchian by 3 bps. The spread of a trade's gross outcome grows with the horizon (per-point standard deviation 73-125 bps at five minutes, 175-294 at thirty minutes, 259-432 at one hour) while its mean stays near zero.
2. **Realised hold.** Trades that happened to last longer earned more, in every Archetype:

| Realised hold | trend-ema gross | meanrev-bbrsi gross | breakout-donchian gross |
|---|---|---|---|
| 0-1 h | -16.4 | -37.1 | -10.9 |
| 1-2 h | -8.9 | -6.8 | -20.1 |
| 2-4 h | -9.7 | +5.1 | -21.1 |
| 4-8 h | -1.1 | +28.8 | +1.4 |
| 8-16 h | +5.6 | +53.8 | +35.6 |
| 16-24 h | +5.4 | +95.8 | +40.2 |
| 24-48 h | +52.3 | +81.9 | +29.9 |
| 48 h+ | +75.9 | +169.0 | +79.9 |

This is conditioned on the outcome: short holds are mostly stop-outs (71-85% of trades under one hour exit at the stop), long holds are the survivors. It is not a tradable signal and does not show that holding longer creates edge. What it does show is the shape of the loss: about 62% of trades stop out at -83 to -122 bps gross, 26-30% hit the take-profit at +154 to +239, and 10% time out at +40 to +64. The 2:1 reward multiple with a 26-30% hit rate nets to zero before costs.

## What round-trip cost would rescue the best point?

| Point | Gross (bps) | Trades per 180 days | Clears the expectancy floor when | Fleet check |
|---|---|---|---|---|
| trend-ema frozen (FIVE_MINUTE 50/100) | -0.2 | 403 | never | beats p95 at the frozen cost (artifact); no cheaper-cost fleet run, gross <= 0 |
| trend-ema best (FIVE_MINUTE 20/100) | +1.5 | 565 | x <= 1.0 | beats p95 at the frozen cost (artifact); no cheaper-cost fleet run |
| meanrev-bbrsi frozen (THIRTY_MINUTE bb 50/2, rsi 7/30) | -0.1 | 426 | never | 11th percentile of fleet at 3.0 bps cost |
| meanrev-bbrsi best (THIRTY_MINUTE bb 20/2.5, rsi 14/20) | +14.3 | 43 | x <= 9.5 | 58th percentile at 4.5 bps; 89th at 14.1 bps; beats p95 only at the frozen cost (artifact). Its percentile rises with cost, so floor and fleet are not met together at any tested cost |
| meanrev-bbrsi ONE_HOUR bb 20/2, rsi 7/20 | +11.1 | 149 | x <= 7.4 | 41st percentile at 7.7 bps |
| breakout-donchian frozen (THIRTY_MINUTE ch 40) | +4.4 | 431 | x <= 2.9 | 63rd percentile at 0.8 bps |
| breakout-donchian best (ONE_HOUR ch 100) | +29.4 | 113 | x <= 19.6 | beats p95 at 2.6 and 10.5 bps, misses at 16.5 bps |

Breakout best point against its fleet, by realised round-trip cost:

| Cost (bps) | Point Sharpe | Fleet p50 | Fleet p95 | Beats p95 |
|---|---|---|---|---|
| 68.6 (frozen) | -1.92 | -1.81 | -0.72 | no |
| 16.5 | 0.63 | -0.03 | 0.68 | no |
| 10.5 | 0.92 | 0.18 | 0.84 | yes |
| 2.6 | 1.31 | 0.47 | 1.10 | yes |

Two side facts from the artifacts. At the frozen cost, 13 of 76 trend-ema points and 53 of 216 meanrev-bbrsi points already beat their fleet p95, because a random maker-entry fleet loses even more per trade; the expectancy floor, not the fleet, is what fails them. No breakout-donchian point beats its fleet at the frozen cost.

## What this means for the pivot ticket (facts, not a ruling)

- Against the perps costs in `docs/research/2026-11-19-intraday-venue-cost-landscape.md` (3-4 bps maker both ways, 9-11 bps taker both ways, round trip, fees only, before spread, slippage and funding), trend-ema and meanrev-bbrsi still fail as frozen: their frozen picks' gross is at or below zero, and their best points clear the floor only at x <= 1.0 and x <= 9.5 on 43 trades per 180 days. Moving venue changes the size of their loss, not its sign.
- Breakout-donchian's 1h lead would sit near the edge of both tests at about 15 bps all-in (floor at 19.6, fleet crossing between 10.5 and 16.5), on a trade count far below the 400-trade per-stage floor and with no correction for having been picked as the best of 15.
- The grid held the exit fixed (stop 2 x ATR, reward multiple 2, 48-bar time stop) and is long-only. Nothing here measures other exits, shorting, or funding. Slippage comes from the synthetic book, not from measured fills.
- So the evidence supports "cheaper costs are necessary but not sufficient": the three Archetypes as specified have no measurable gross edge to uncover.
