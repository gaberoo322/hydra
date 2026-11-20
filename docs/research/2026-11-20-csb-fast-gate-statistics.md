# Statistics for a fast gate: sequential tests, futility stops and trial counting at backtest scale

**Date:** 2026-11-20
**Ticket:** gaberoo322/hydra#5690 (wayfinder map #5687). Starts from the founding statistics ticket #4318 (`origin/research/csb-graduation-bar:docs/research/2026-09-02-csb-graduation-bar.md`).
**Consumers:** the backtest-first experiment-loop design and the graduation-gate redesign for `claw-street-bets` (CSB).
**Status:** research, not decision. Operator choices are marked **[operator]**.
**CSB state read:** `/home/gabe/claw-street-bets` at `e9500c8`, read-only; running app on port 3334 queried over HTTP on 2026-11-20.

## Summary of findings

1. **The binding test is the expectancy floor, and it is a large effect.** Net expectancy >= 0.5 x c (25.5 or 33 bps) against the per-trade dispersion in the sweep files (78 to 246 bps) is a standardised effect of 0.10 to 0.33 per trade. A fixed-sample test at 5% / 80% power needs **57, 249 and 575 trades** for the three Archetypes' dispersions. The 400-trade floor is about 7x more than needed at trend-ema's dispersion and about 30% too few at meanrev-bbrsi's.
2. **Sequential designs buy little on the way up and a great deal on the way down.** A 5-look group-sequential design with a futility stop cuts the expected sample under "no edge" to about 0.63 to 0.68 of the fixed sample; Wald's SPRT cuts it to about 0.45. At the means actually observed in the sweeps (-51 to -62 bps), every design stops at its first opportunity: **7 to 57 trades for the SPRT, one look of 80 trades (about 34 days) for a 5 x 80 group-sequential design**, against 180 days today.
3. **The 2.0 Sharpe floor stops binding at k = 8.** Under the gate's formula, SR0(k) at 180 days is 1.50 at k = 4, 1.98 at k = 7, 2.08 at k = 8, 3.60 at k = 100 and **4.14 at k = 311** (the 4 launch trials plus the 307 sweep grid points). Entering every backtest candidate into the Stage A count makes the paper bar unreachable in practice.
4. **The same k is cheap at backtest length.** SR0 scales with sqrt(365/T). Over the 730-day sweep window, 307 trials give SR0 = 2.05 and 1,000 give 2.30. Trial count grows the bar like sqrt(2 ln k); window length shrinks it like 1/sqrt(T). The expensive combination is a backtest-scale k applied to a 180-day variance, which is what `sr0(k, 180)` would do if grid points were ledgered as Stage A trials.
5. **A held-out window resets k to 1 only if it is used once.** A single pre-registered test on a 180-day hold-out (about 420 trades) has a 95% bar of observed Sharpe 2.34 and no SR0 term. Reusing it 10 times gives a 40% chance of at least one false pass.
6. **A short paper run adds almost no edge information.** 4 trades give a standard error of 39 to 123 bps on the mean; the 24-month backtest already has about 1,700 trades per Archetype. What paper adds is one clean out-of-sample look and the order path. It cannot show queue position, real maker fill rate or market impact.
7. **Canary size is set by the fill-gap dispersion, which no artifact records.** To detect a paper-versus-live gap of 0.25 x c (12.75 bps) at 5% / 80%: 15 trades if the per-trade gap sd is 20 bps, 61 at 40 bps, 243 at 80 bps. Confirming a +-10 pp maker fill rate needs about 165 to 196 orders. Edge confirmation on real money needs the same trade count as on paper (finding 1).
8. **Three premises in the brief were wrong or untraceable** (section 0): the "-43 / -58 / -104 bps" figures are 40-day Level-2-window numbers, not the 24-month backtest; "4 trades in 13 days" is a count taken under an active halt, not a pace; the Trial Ledger is empty, so k = 4 is the configured launch value.

Every CSB number below comes from a real artifact, named with its path. Nothing is taken from a test fixture. Worked numbers were computed by a stdlib Python script (formulas and inputs are given inline; the essential functions are in the appendix).

## 0. Inputs and premise check

### 0.1 The gate as configured

`/home/gabe/claw-street-bets/config/graduation-gate.yaml` (version 3):

| Item | Value |
|---|---|
| Stage floors | 400 settled paper trades and 180 calendar days, each stage |
| Stage A | net annualised Sharpe > max(2.0, SR0(k)); beats p95 of >= 200 Control Fleet paths; net expectancy >= 0.5 x c; one look (`look: first-floor-met`); hard fail day 365 |
| Stage B | PSR(SR* = 0) >= 0.95; earliest day 180, hard fail day 365 |
| Fill-model honesty | abs(mean(paper - shadow backtest)) <= 0.25 x c per rolling 100 trades; one-sided t-test at 95%; fill rate within +-10 pp |
| Multiple testing | append-only Trial Ledger; k = every Strategy ever entered into Stage A; 24-month window; `k_at_launch: 4` |
| Live proof | $5,000 per graduated Strategy, x2 steps per 90 days, $20,000 ceiling |

Round-trip cost c is 51 bps (trend-ema, meanrev-bbrsi; maker entry, taker exit) and 66 bps (breakout-donchian; taker both sides), from Coinbase Advanced maker 15 / taker 30 bps plus a 3 bps per side slippage floor. The expectancy floors are 25.5 and 33 bps.

SR0 in code (`src/graduation/sharpe-statistics.ts`):

```
SR0(k, T) = sqrt(365 / T) * g(k)
g(k)      = (1 - gamma) * Phi^-1(1 - 1/k) + gamma * Phi^-1(1 - 1/(k*e)),  gamma = 0.5772156649,  g(1) = 0
```

Stage A calls it with T = 180. The Trial Ledger page (`http://localhost:3334/trial-ledger`) shows SR0(4) = 1.4982 and SR0(5) = 1.6983, which the script reproduces.

### 0.2 Dispersion and cadence actually observed

Source: `/home/gabe/claw-street-bets/docs/sweeps/2026-11-02-{trend-ema,meanrev-bbrsi,breakout-donchian}.json` (24 months, 2024-11-02 to 2026-11-02, 730 days; BTC/ETH/SOL/XRP-USD pooled; generated at CSB `4dc2c2ca`). Per-trade sd is not stored; it is derived as `expectancyNetBps / sharpeNetPerTrade`, which is exact given the readout definitions in `src/backtest/performance-readout.ts`.

| Archetype | Grid points | Frozen point trades | Net expectancy | Per-trade Sharpe | Per-trade sd | Trades/day | Projected per 180 d |
|---|---|---|---|---|---|---|---|
| trend-ema | 76 | 1,633 | -51.31 bps | -0.660 | 77.7 bps | 2.24 | 402.7 |
| meanrev-bbrsi | 216 | 1,726 | -53.56 bps | -0.218 | 246.0 bps | 2.36 | 425.6 |
| breakout-donchian | 15 | 1,747 | -62.30 bps | -0.298 | 209.2 bps | 2.39 | 430.8 |

Across the three grids there are 307 points; none has positive net expectancy (best -39.2 bps). The mean cadence at the frozen points is 2.33 trades per day, about 851 per year. All calendar conversions below use 2.33 per day.

The three sd values are the scenarios used throughout: **low dispersion 78 bps, mid 209 bps, high 246 bps**. Two cautions: these are pooled over four correlated products, and they are measured on losing strategies. A profitable variant could have a different dispersion.

### 0.3 Premises from the brief

| Premise | Finding |
|---|---|
| Net expectancy "about -43 / -58 / -104 bps" | These are the frozen points' figures over the 40-day Level-2 window (2026-09-23 to 2026-11-02; 82 / 100 / 79 trades), field `selection.level2Run.check.level2ExpectancyNetBps`. The 24-month figures are -51.3 / -53.6 / -62.3 bps on 1,633 to 1,747 trades. |
| Round-trip cost 51 to 66 bps | Confirmed (`rule.cBps` in each sweep file; gate yaml). |
| "About 4 settled trades in 13 days" | The count is right: `GET /api/outcomes` on 2026-11-20 shows meanrev-bbrsi 3, breakout-donchian 1, trend-ema none (the btc20w twin repeats the parent's 3). It is not a pace. `http://localhost:3334/halts` shows a Roster Daily-Loss Halt active since 2026-11-08T22:00:01Z and never reset, so entries were refused for 12 of the 13 days. The backtest cadence is about 2.3 trades per day. |
| Day 0 = 2026-11-06, k = 4 | Not traceable to the ledger. The Trial Ledger page shows 0 rows; k = 4 is `k_at_launch`. The graduation page says no Stage Clock has started. |
| Founding math assumed about 15 bps on perps | Confirmed in the founding file, which also assumed about 1,000 trades per year and per-trade sd of 100 to 160 bps. Observed: 851 per year and 78 to 246 bps. |

## (a) Sequential tests and futility stops

### a.1 Baseline: the fixed-sample test

For i.i.d. per-trade net returns with mean mu and sd sigma, testing H0: mu <= 0 against mu = delta at one-sided alpha with power 1 - beta:

```
n = ((z_alpha + z_beta) * sigma / delta)^2          z_.05 = 1.645, z_.20 = 0.842, z_.10 = 1.282
```

| Scenario | sigma | delta | delta / sigma | n (80%) | n (90%) | Days at 2.33/day | Implied annual Sharpe |
|---|---|---|---|---|---|---|---|
| trend-ema | 78 | 10 | 0.129 | 374 | 518 | 160 | 3.8 |
| trend-ema | 78 | 25.5 (floor) | 0.328 | **57** | 80 | 25 | 9.6 |
| trend-ema | 78 | 51 (= c) | 0.656 | 14 | 20 | 6 | 19.1 |
| breakout-donchian | 209 | 10 | 0.048 | 2,706 | 3,749 | 1,161 | 1.4 |
| breakout-donchian | 209 | 33 (floor) | 0.158 | **249** | 344 | 107 | 4.6 |
| breakout-donchian | 209 | 66 (= c) | 0.315 | 62 | 86 | 27 | 9.2 |
| meanrev-bbrsi | 246 | 10 | 0.041 | 3,741 | 5,182 | 1,604 | 1.2 |
| meanrev-bbrsi | 246 | 25.5 (floor) | 0.104 | **575** | 797 | 247 | 3.0 |
| meanrev-bbrsi | 246 | 51 (= c) | 0.207 | 144 | 199 | 62 | 6.1 |

"Implied annual Sharpe" is (delta / sigma) x sqrt(851), the i.i.d. per-trade annualisation the sweep readout uses. It is not the gate's calendar-day statistic, but the two agree when trades are independent and evenly spread.

What this shows:

- A strategy that truly sits at the expectancy floor has an annualised Sharpe of 3.0 to 9.6. The floor, not the 2.0 Sharpe bar, is the harder test at these costs. The per-trade mean needed for Sharpe 2.0 alone is only 5.3 / 14.3 / 16.9 bps.
- The smallest edge 400 trades can detect (5% / 80%) is 2.486 x sigma / 20: **9.7 bps, 26.0 bps and 30.6 bps**. So 400 trades is over-sized for the low-dispersion case and marginally under-sized for the high-dispersion one.
- A 10 bps net edge at 209 to 246 bps dispersion needs 2,700 to 3,700 trades (3 to 4 years). No sequential design rescues that; it is outside what this gate can see.

On the calendar-day Sharpe itself, using the founding ticket's standard error sqrt(1 / years) (attributed there to Lo 2002, which I could not open): the time to detect a true Sharpe S against zero is `((z_alpha + z_beta) / S)^2` years, giving 564 days for S = 2.0, 361 for 2.5, 251 for 3.0, 141 for 4.0 and 63 for 6.0. The chance that the observed 180-day Sharpe exceeds 2.0 is 50% at S = 2.0, 64% at 2.5, 76% at 3.0 and 92% at 4.0.

### a.2 Wald's sequential probability ratio test

Test mu = 0 against mu = delta after every trade. The log-likelihood ratio adds `(delta / sigma^2) * (x - delta / 2)` per trade. Stop for H1 when it reaches ln A, for H0 when it falls to ln B, with A = (1 - beta) / alpha and B = beta / (1 - alpha). Expected sample sizes (Wald's approximation, ignoring overshoot):

```
E0[N] = ((1 - alpha) ln B + alpha ln A) / (-delta^2 / (2 sigma^2))
E1[N] = (beta ln B + (1 - beta) ln A) / (delta^2 / (2 sigma^2))
```

These formulas are the standard statement of Wald (1945). I could not open the paper, so I checked them by simulation (4,000 paths each) instead of by citation.

| Scenario (delta = floor) | Fixed n | E[N], mu = 0 (approx / simulated) | 90th pct, mu = 0 | Type I | E[N], mu = floor (approx / simulated) | 90th pct | Power | E[N] at observed mu |
|---|---|---|---|---|---|---|---|---|
| trend-ema | 57 | 25 / 28 | 60 | 0.044 | 35 / 41 | 79 | 0.83 | **7** |
| breakout-donchian | 249 | 108 / 118 | 251 | 0.049 | 153 / 164 | 317 | 0.82 | **28** |
| meanrev-bbrsi | 575 | 250 / 262 | 566 | 0.041 | 355 / 369 | 716 | 0.80 | **57** |

- Under no edge the SPRT stops in about 45 to 50% of the fixed sample on average, and under the floor-level edge in about 65 to 70%.
- The tail is real: one run in ten takes about as long as, or longer than, the fixed test. The SPRT has no maximum sample unless truncated.
- The worst case is a true mean halfway between the hypotheses. At delta / sigma = 0.10 the expected sample there is about 432 against a fixed 618.
- At the observed backtest means the test ends in 7 to 57 trades, which is 3 to 25 days.

Assumptions: i.i.d. normal per-trade returns with known sigma, and a specific alternative delta. Sigma has to be estimated in practice, which costs a little of the saving. A wrong delta does not break the error rates but changes the expected sample.

### a.3 Group-sequential designs (a few scheduled looks)

A group-sequential test looks K times at pre-set sample sizes and stops if the z-statistic crosses a boundary. Pocock (1977) describes it as "dividing patient entry into a number of equal-sized groups so that the decision to stop the trial or continue is based on repeated significance tests of the accumulated data after each group is evaluated" (abstract only opened). Lan and DeMets (1983) generalise the schedule: "The method is based on the choice of a function, alpha*(t), which characterizes the rate at which the error level alpha is spent" (abstract only opened). O'Brien and Fleming (1979) was not opened at all.

Because I could not read the boundary tables, I computed boundaries myself by Monte Carlo (400,000 Brownian paths, K = 5 equal looks, one-sided alpha = 0.05) for the two classic shapes: a constant z-boundary ("Pocock-shaped") and a boundary constant on the cumulative-sum scale, so z_k = c x sqrt(K / k) ("O'Brien-Fleming-shaped"). The futility rule is the simplest one: stop at an interim look if the running mean is at or below zero.

| Design | z-boundaries at looks 1 to 5 | Max n / fixed n | Type I | E[n] / fixed n, mu = 0 | E[n] / fixed n, mu = delta | E[n] / fixed n, mu = -delta |
|---|---|---|---|---|---|---|
| Pocock-shaped, no futility | 2.12 x 5 | 1.25 | 0.050 | 1.22 | 0.78 | 1.25 |
| Pocock-shaped + futility | 2.12 x 5 | 1.46 | 0.047 | 0.68 | 0.75 | 0.32 |
| OBF-shaped, no futility | 3.91, 2.77, 2.26, 1.96, 1.75 | 1.04 | 0.050 | 1.03 | 0.80 | 1.04 |
| OBF-shaped + futility | 3.91, 2.77, 2.26, 1.96, 1.75 | 1.29 | 0.043 | **0.63** | 0.83 | **0.29** |

All four are sized for 80% power at delta. The futility stop costs power, which is bought back with a 25 to 40% larger maximum sample.

Applied to the three scenarios at delta = floor, OBF-shaped with futility:

| Scenario | Fixed n | Max n | Look every | E[n], no edge | E[n], floor-level edge |
|---|---|---|---|---|---|
| trend-ema | 57 | 74 | 15 trades | 36 (15 d) | 48 (21 d) |
| breakout-donchian | 249 | 322 | 64 trades | 155 (67 d) | 207 (89 d) |
| meanrev-bbrsi | 575 | 745 | 149 trades | 360 (154 d) | 479 (206 d) |

If 400 trades stays the maximum and is split into 5 looks of 80 (OBF-shaped efficacy, futility at running mean <= 0):

| Scenario | True mean | P(pass) | E[trades] | E[days] |
|---|---|---|---|---|
| any | 0 | 0.043 | 193 | 83 |
| trend-ema | floor 25.5 | 0.998 | 154 | 66 |
| breakout-donchian | floor 33 | 0.864 | 247 | 106 |
| meanrev-bbrsi | floor 25.5 | 0.577 | 272 | 117 |
| all three | observed (-51 to -62) | 0.000 | 80 to 82 | 34 to 35 |

So a 5 x 80 schedule would have retired each of the three current Archetypes at the first look, about day 34, and would stop a zero-edge strategy at day 83 on average. It keeps the 400-trade ceiling and the 5% error rate. Its weakness is the high-dispersion case, where power at the floor is only 58% (the fixed 400-trade test has about 66% there).

### a.4 Always-valid inference (look whenever you like)

Johari, Pekelis and Walsh define always-valid p-values as those that "control Type I error at any data-dependent stopping time the user might choose" and show "Continuous monitoring does not inflate Type I error." They build them from the mixture SPRT (credited to Robbins 1970) and note the duality with "sequential tests of power one", tests "that do not accept H0 in finite time". Howard et al. give the matching interval form: "A confidence sequence is a sequence of confidence intervals that is uniformly valid over an unbounded time horizon."

The consequence for CSB: a mixture SPRT never accepts the null, so by itself it is not a futility stop. It becomes one when pointed at the floor. Test "mu = floor" and stop when the data reject it from below. With a normal mixture of sd tau over the alternative (my derivation by Gaussian integration; I could not read the equation in the extracted paper text):

```
Lambda_n = sqrt(sigma^2 / (sigma^2 + n tau^2)) * exp( n^2 tau^2 (xbar_n - floor)^2 / (2 sigma^2 (sigma^2 + n tau^2)) )
stop when Lambda_n >= 1 / alpha
```

Simulated with tau = 0.3 sigma and alpha = 0.05 (3,000 paths; false-stop rate 0.036 over a 2,000-trade horizon when mu equals the floor):

| Scenario | True mean | Median trades to kill | 90th pct | Median days | Fixed-n equivalent |
|---|---|---|---|---|---|
| trend-ema | observed -51.3 | 13 | 21 | 6 | 6 |
| trend-ema | 0 | 74 | 156 | 32 | 57 |
| breakout-donchian | observed -62.3 | 39 | 82 | 17 | 30 |
| breakout-donchian | 0 | 310 | 708 | 133 | 249 |
| meanrev-bbrsi | observed -53.6 | 78 | 166 | 33 | 60 |
| meanrev-bbrsi | 0 | 735 | 1,697 | 315 | 575 |

The price of unlimited looks is roughly 30% more trades than a fixed test that knew the effect size in advance. A strategy with half the floor's edge is expensive to kill this way (280 to 3,279 median trades); a hard-fail day still has to exist.

### a.5 Options compared

| Option | Expected time, no edge | Expected time, floor-level edge | Max | Assumes | Cost |
|---|---|---|---|---|---|
| Current: one look at 400 trades and 180 days | 180 d | 180 d | 365 d | nothing sequential | slowest in every case |
| Fixed n sized to dispersion | 25 / 107 / 247 d | same | same | sigma known in advance | still no early kill |
| Group-sequential, 5 looks, futility | 0.63 to 0.68 x fixed | 0.75 to 0.83 x fixed | 1.3 to 1.5 x fixed | looks fixed in advance, i.i.d. trades | simple to audit; looks cannot be added later |
| Wald SPRT | about 0.45 to 0.5 x fixed | about 0.65 to 0.7 x fixed | none unless truncated | point alternative, known sigma | long tail |
| Always-valid / mixture SPRT kill rule | about 1.3 x fixed | not a pass rule alone | none | sub-Gaussian trades, chosen tau | most robust to peeking; slowest of the sequential options |

What the evidence favours: the saving that matters is on the futility side, and every sequential option delivers it. A group-sequential schedule is the smallest change to the present gate, since it keeps a ceiling, a fixed error rate and a short list of looks. An always-valid kill rule is the safer choice if an automated loop will look after every trade. **[operator]** Which statistic the looks are taken on (per-trade mean against the floor, or the calendar-day Sharpe), the number of looks, and whether a pass may also come early or only a fail.

Shared caveats: all of this assumes independent trades. The four products are correlated and trades cluster in time, so the effective sample is smaller than the count. The gate's own observation unit is the calendar day for this reason. A sequential rule should be calibrated on a block or calendar-day basis, or by replaying it over the Control Fleet paths.

## (b) Counting trials at backtest scale

### b.1 What SR0 is and how the gate's version differs

Bailey and López de Prado: "the expected maximum of [the Sharpe estimates] after N independent trials can be approximated as" their Eq. (1), with the Euler-Mascheroni constant as in the gate's code, and "DSR is a PSR where the rejection threshold is adjusted to reflect the multiplicity of trials." The threshold "increases as more independent trials are attempted (N), or the trials involve a greater variance". In the paper V is the variance of the Sharpe estimates across the trials. The gate instead uses the theoretical sampling variance 365 / T. That is the right V only if every trial has true Sharpe zero and the same length; it is a modelling choice, not the paper's estimator.

I rebuilt the paper's worked example to check my reading: annualised Sharpe 2.5, T = 1,250 daily observations, N = 100, V = 0.5 annualised, skewness -3, kurtosis 10 gives SR0 = 0.1132 and DSR = 0.9004. Both values appear in the CSB code README. The same function returns 0.9505 at N = 46, and 0.9505 at N = 88 with normal returns. "N=46", "0.9505" and "N=88" are legible in the extracted paper text, so the reconstruction matches the source.

### b.2 How SR0(k) grows

| k | g(k) | SR0 at 180 d | SR0 at 365 d | SR0 at 730 d | Bonferroni z (5% / k) | Bonferroni Sharpe at 180 d | at 730 d |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 1.645 | 2.34 | 1.16 |
| 4 | 1.052 | 1.50 | 1.05 | 0.74 | 2.241 | 3.19 | 1.58 |
| 5 | 1.193 | 1.70 | 1.19 | 0.84 | 2.326 | 3.31 | 1.64 |
| 7 | 1.387 | 1.98 | 1.39 | 0.98 | 2.450 | 3.49 | 1.73 |
| 8 | 1.459 | **2.08** | 1.46 | 1.03 | 2.498 | 3.56 | 1.77 |
| 10 | 1.575 | 2.24 | 1.58 | 1.11 | 2.576 | 3.67 | 1.82 |
| 20 | 1.901 | 2.71 | 1.90 | 1.34 | 2.807 | 4.00 | 1.98 |
| 50 | 2.276 | 3.24 | 2.28 | 1.61 | 3.090 | 4.40 | 2.19 |
| 100 | 2.531 | 3.60 | 2.53 | 1.79 | 3.291 | 4.69 | 2.33 |
| 307 | 2.903 | 4.13 | 2.90 | **2.05** | 3.594 | 5.12 | 2.54 |
| 311 | 2.907 | **4.14** | 2.91 | 2.06 | 3.597 | 5.12 | 2.54 |
| 1,000 | 3.255 | 4.64 | 3.26 | 2.30 | 3.891 | 5.54 | 2.75 |
| 10,000 | 3.861 | 5.50 | 3.86 | 2.73 | 4.417 | 6.29 | 3.12 |

- At 180 days the 2.0 floor is the binding term up to k = 7. From k = 8 the SR0 term takes over. That is four more Stage A entries beyond the launch value.
- At the 730-day backtest window SR0 first exceeds 2.0 at k = 243.
- Rearranged, the backtest length needed to keep SR0(k) at or below a target is `T = (g(k) / target)^2` years: for a 2.0 target, 0.62 years at k = 10, 1.60 at k = 100, 2.11 at k = 307, 2.65 at k = 1,000, 3.73 at k = 10,000. This is derived from the gate's formula. It is the same idea as the "minimum backtest length" of Bailey, Borwein, López de Prado and Zhu, whose paper I could not open.
- SR0 is an expected maximum, so it is a 50%-ish bar, not a 5% one. Bonferroni at 5% is stricter at every k (right-hand columns).

### b.3 The options

**Option 1. Count every grid point as a Stage A trial (literal reading of the current rule).** k = 311 today and SR0 = 4.14 at 180 days. A loop that generates 1,000 candidates takes it to 4.64. Cost: no realistic strategy passes; a true Sharpe of 4 clears 4.14 less than half the time. Assumes all trials are independent, which grid neighbours are not.

**Option 2. Count hypotheses, not grid points.** One trial per Archetype idea: k = 4 + 3 = 7, SR0 = 1.98, the 2.0 floor still binds. One per Archetype-and-granularity cell (16) gives 2.56. Cost: it under-counts if the grid search itself did the selecting. The DSR paper is direct that hiding trials defeats the correction, and the PBO paper says "the researcher must provide full information regarding the actual trials conducted" and "Hiding trials will lead to an underestimation of the overfit". This option is honest only if the within-hypothesis search is corrected somewhere else (options 4 to 6).

**Option 3. Effective number of independent trials.** The DSR paper, Appendix A.3: "Suppose that we run M trials, where only N trials are independent, N<M. Clearly, using M instead of N will overstate" the threshold. It interpolates on the average correlation between trials; the equation glyphs did not survive extraction, and I use the linear form N = rho + (1 - rho) M, which matches the surrounding text ("interpolate between these two extreme outcomes").

| M | rho | N | SR0 at 180 d | SR0 at 730 d |
|---|---|---|---|---|
| 307 | 0 | 307 | 4.13 | 2.05 |
| 307 | 0.6 | 123 | 3.71 | 1.84 |
| 307 | 0.9 | 32 | 2.98 | 1.48 |
| 307 | 0.97 | 10 | 2.26 | 1.12 |
| 1,000 | 0.6 | 401 | 4.25 | 2.11 |
| 1,000 | 0.9 | 101 | 3.61 | 1.79 |

Cost: rho must be estimated from the candidates' return series, which the sweep files do not store (only summary readouts), and the paper warns that "correlation is a limited notion of linear dependence" and that the estimate "may itself be overfit". Because g(k) grows so slowly, even rho = 0.9 only moves the 180-day bar from 4.1 to 3.0.

**Option 4. Deflate at backtest length, then enter one survivor into Stage A.** Apply the trial count where the trials happened: over the 730-day window, with V = 365 / 730. The bar is 2.05 for 307 trials and 2.30 for 1,000, close to the existing 2.0 floor. The single selected candidate then enters paper as one Stage A trial. Cost: the paper stage is no longer protected against backtest selection by its own bar; it relies on the backtest deflation having been done honestly and on paper being genuinely out of sample. A stricter variant uses the paper's own V, the cross-trial variance. Across the 307 grid points the sd of per-trade Sharpe is 0.143, about six times the 0.024 sampling sd of one estimate at 1,700 trades, because the grid points have genuinely different (all negative) means. Plugging that in gives a bar 0.42 per-trade Sharpe units above the grid mean. That is strict, and it shows the gate's choice of V and the paper's are far apart on real data.

**Option 5. Held-out window.** Select on the first part of the history, test one pre-registered candidate once on the rest. For that single test k = 1 and there is no SR0 term.

| Hold-out | Trades at 2.33/day | SE of annual Sharpe | 95% bar on observed Sharpe | Smallest detectable edge (80%), in sd units |
|---|---|---|---|---|
| 90 d | about 210 | 2.01 | 3.31 | 0.172 |
| 180 d | about 420 | 1.42 | 2.34 | 0.121 |
| 365 d | about 851 | 1.00 | 1.64 | 0.085 |

Cost: it spends data, and it only works once. The DSR paper: "the holdout method cannot prevent backtest overfitting: Holdout assesses the generality of a model as if a single trial had taken place", and "If we apply the holdout method enough times (say 20 times for a 95% confidence level), false positives are no longer unlikely: They are expected." With a 5% test, the chance of at least one false pass is 14% after 3 uses, 23% after 5, 40% after 10 and 64% after 20. A loop that iterates against the hold-out needs its own ledger of hold-out looks. Note also that only the last 40 days of the 24 months have recorded Level-2 books, so a hold-out placed at the end of the window overlaps the only period with realistic fills.

**Option 6. Combinatorially symmetric cross-validation (PBO).** Bailey, Borwein, López de Prado and Zhu define overfitting as the case where "a strategy with optimal performance IS has an expected ranking below the median OOS" and PBO as the probability of it. CSCV splits the T x N performance matrix into S blocks, forms every half-and-half split (12,780 for S = 16), picks the in-sample best each time and records its out-of-sample rank. It "only requires time series of backtested performance" and avoids "a fixed 'hold-out'". Cost: it scores the selection process, not a strategy, so it gives no pass bar for one candidate; it needs per-period returns for every grid point, which the sweep files do not keep; and the paper lists its own limits, including that strong autocorrelation "may obscure the characterization especially when S is large". It is a natural health check on a backtest loop (a high PBO says the grid search is fitting noise) and a poor replacement for SR0.

**Option 7. Multiple-testing haircuts.** Harvey and Liu apply Bonferroni, Holm and BHY p-value adjustments to Sharpe ratios; the haircut is non-uniform ("when the number of trials is 50, the haircut is almost 50% for the least profitable ... strategy, but only 7.9% for the most profitable"), and BHY controls the false discovery rate, which "allow[s] the number of false discoveries to grow proportionally with the total number of tests". Harvey, Liu and Zhu conclude that "a newly discovered factor needs to clear a much higher hurdle, with a t-ratio greater than 3.0" and that their method "allows for correlation among the tests". In CSB units a t-ratio of 3.0 on a 180-day record is an annualised Sharpe of 4.3, and on 730 days 2.1. Cost: FWER methods are stricter than SR0 at every k (table b.2); FDR suits a loop that accepts some false graduates, which a real-money gate may not.

### b.4 What the evidence favours

The trial count belongs with the data the trials were run on. Deflating 307 or 1,000 backtest candidates over 730 days costs 0.05 to 0.30 of Sharpe above the existing floor; carrying the same count into a 180-day paper window costs more than 2.0. Options 2 and 4 together (ledger hypotheses for Stage A, deflate grid points at backtest length), with a single-use hold-out or the paper run as the out-of-sample check, keep the correction honest without making the paper bar unreachable. **[operator]** What counts as one hypothesis, whether the Stage A ledger stays at "every Strategy ever entered", and whether FWER or FDR is the error rate wanted for real money.

Every variant depends on the ledger being complete. The DSR paper also recommends planning the number of trials in advance: "Investment theory, not computational power, should motivate what experiments are worth conducting."

## (c) What a short paper run can and cannot establish

**Edge: almost nothing a backtest has not already said.** The standard error of the mean after n trades is sigma / sqrt(n):

| n | trend-ema (78) | breakout-donchian (209) | meanrev-bbrsi (246) |
|---|---|---|---|
| 4 | 38.9 bps | 104.6 bps | 123.0 bps |
| 40 | 12.3 bps | 33.1 bps | 38.9 bps |
| 100 | 7.8 bps | 20.9 bps | 24.6 bps |
| 400 | 3.9 bps | 10.5 bps | 12.3 bps |

The 4 settled paper trades (meanrev-bbrsi -103.10 bps on 3, breakout-donchian -94.65 bps on 1; `/api/outcomes`) are consistent with the backtest and with almost anything else. The backtest at the frozen points has about 1,700 trades, twenty times a 40-day paper run.

**What paper can establish that a backtest cannot:**

- *One uncontaminated look.* Paper data did not exist when the candidate was chosen, so a paper test is a k = 1 test. This is the same property as a hold-out (option 5), with the same warning about reuse.
- *The order path.* Signal timing on live bars, order construction, halts, the risk template and settlement accounting, all running end to end. The present halt (one Roster Daily-Loss Halt stopping all entries for 12 days) is exactly this kind of finding and no backtest would have produced it.
- *Fill-model drift against recorded books.* The gate's paper-versus-shadow-backtest check. So far: mean divergence 2.97 bps on 3 trades and 2.00 bps on 1 trade (`/api/outcomes`). The sweep's own synthetic-versus-Level-2 comparison gave -3.77, -0.61 and -0.58 bps on 79 to 100 trades against tolerances of 12.75 and 16.5 bps. Those are backtest-to-backtest gaps and say only that the two fill models agree with each other.
- *A fast kill.* Section (a): at the observed means, 7 to 80 paper trades are enough to retire a strategy.

**What paper cannot establish:**

- *Queue position and real maker fills.* A paper fill at the touch assumes the order would have been reached. Two of the three Archetypes depend on a maker entry for their 51 bps cost; if the maker order is not filled the cost is 66 bps or the trade is missed.
- *Market impact and adverse selection.* Paper orders do not move the book or get picked off.
- *Regime coverage.* Forty days of paper is one regime. The 24-month backtest spans more, at the price of selection bias.
- *A small positive edge.* Anything under about 10 bps at 200+ bps dispersion (table a.1).

So paper is the right place for a kill rule and for the operational and fill-drift checks, and a poor place to accumulate proof of edge.

## (d) The minimum real-money sample for a micro-live canary

The canary answers two different questions with very different sample sizes.

### d.1 Fill honesty

Compare each live fill with the paper fill for the same signal and test the mean per-trade gap. For a gap Delta and per-trade gap sd sigma_d (paired, one-sided 5%):

```
n = ((z_alpha + z_beta) * sigma_d / Delta)^2
```

Trades needed at 80% / 90% power:

| sigma_d | Delta = 3 bps | 6 bps | 12.75 bps (0.25 c) | 16.5 bps (0.25 c, donchian) | 25.5 bps |
|---|---|---|---|---|---|
| 5 bps | 17 / 24 | 4 / 6 | 1 / 1 | 1 / 1 | 1 / 1 |
| 10 bps | 69 / 95 | 17 / 24 | 4 / 5 | 2 / 3 | 1 / 1 |
| 20 bps | 275 / 381 | 69 / 95 | 15 / 21 | 9 / 13 | 4 / 5 |
| 40 bps | 1,099 / 1,522 | 275 / 381 | 61 / 84 | 36 / 50 | 15 / 21 |
| 80 bps | 4,396 / 6,090 | 1,099 / 1,522 | 243 / 337 | 145 / 201 | 61 / 84 |
| 150 bps | 15,456 / 21,410 | 3,864 / 5,352 | 856 / 1,185 | 511 / 708 | 214 / 296 |

Read the other way, the gap detectable with n trades at 80% power is 2.486 x sigma_d / sqrt(n): with 100 trades, 2.5 / 5.0 / 9.9 / 19.9 bps for sigma_d of 10 / 20 / 40 / 80 bps.

**sigma_d is not in any artifact I could read.** Only means are exposed. The table is therefore parametric. Three things follow:

- The gate's existing rule (0.25 x c per rolling 100 trades) is well-powered if sigma_d is at or below about 50 bps, and under-powered above that.
- The pairing matters enormously. If live and paper fills are compared trade by trade for the same signal, sigma_d is the dispersion of fill differences only (plausibly single or low double digits of bps for liquid majors, but that is a guess to be measured). If they are compared as two unpaired samples of trade returns, sigma_d is about sqrt(2) x 78 to 246 bps and the canary needs hundreds to thousands of trades.
- A sample of single-digit trades is enough to catch a gross fill-model error (a gap of c or more) if the pairing is tight, and nothing else.

**Fill rate.** The +-10 pp tolerance is a proportion test: `n = (z_.975 + z_.80)^2 * p (1 - p) / 0.1^2`, giving 196 orders at p = 0.5, 165 at p = 0.7 and 71 at p = 0.9 against a known reference rate, and twice that per arm if the paper rate is itself estimated. This is counted in orders placed, not settled trades, and is the item that needs real money, because paper cannot observe it.

A conservative reading: about 100 paired trades (43 days at 2.33 per day) confirms the 0.25 x c gap for sigma_d up to about 50 bps and gets most of the way on fill rate; about 200 orders is the fuller answer on fill rate.

### d.2 Edge

Real money does not speed up the detection of edge. The per-trade test is the same as in (a): 57 / 249 / 575 trades at the floor, more for anything smaller. After 50 canary trades the standard error of the mean is 11 / 30 / 35 bps; after 100 it is 8 / 21 / 25 bps. A canary sized for fill honesty (50 to 100 trades) can confirm only an edge well above the floor at low dispersion. It can refute an edge quickly, by the same kill rules as in (a).

The combined statement a canary of n trades supports is: "live fills are within Delta of paper fills, so the paper edge estimate carries over, less Delta". Edge evidence then accumulates across backtest, paper and canary together, and the canary's job is to bound Delta.

### d.3 Cost and exposure

Each round trip pays c: $5.10 or $6.60 per $1,000 of notional. A 100-trade canary pays $510 or $660 in costs per $1,000 of average notional before any edge; at the observed (negative) expectancies it loses about the same again. The risk template (`config/risk-template.json`) caps risk at 0.5% of bankroll per trade at the stop, $25 on the configured $5,000 live-proof bankroll. Average notional per trade depends on stop distance, which I could not read from a non-fixture artifact, so I give no dollar total. **[operator]** The canary bankroll, and whether a canary below the $5,000 live-proof size is wanted at all, since exchange minimum order sizes and the fee tier (c assumes a specific Coinbase tier) both shift at small size.

## Open points the statistics cannot settle

1. **Which statistic the gate looks at.** Per-trade mean against the floor is far better powered than the calendar-day Sharpe, but assumes independent trades. The dependence between the four products and across time needs measuring from per-trade data.
2. **What one "trial" is.** Idea, Archetype, granularity cell or grid point. The formulas price each choice (1.98 to 4.14 at 180 days); they do not choose.
3. **FWER or FDR.** Whether one false graduate into real money is to be prevented outright or tolerated at a rate.
4. **Whether any candidate has an edge to find.** All 307 grid points are net-negative and gross edge at the frozen points is near zero (net expectancy plus c is about -0.3, -2.6 and +3.7 bps). A faster gate retires these sooner; it does not produce a pass. The cost side is #5689's question.
5. **sigma_d.** The canary sample is unknown until the per-trade dispersion of the paper-versus-live (or paper-versus-shadow) gap is measured.
6. **Dispersion of a profitable strategy.** The 78 to 246 bps range comes from losing strategies. Sample sizes scale with sigma squared.
7. **How many looks, and who looks.** A human reviewing a few scheduled looks suits a group-sequential design; an automated loop looking after every trade needs an always-valid rule.
8. **Hold-out placement.** The only period with recorded Level-2 books is the last 40 days, which is also where a hold-out would go.
9. **The unexplained halt loss.** The halt page reports a $1,372.07 loss on a $40,000 roster bankroll while only 4 small trades have settled. I could not reconcile this without database access; it may be open-position mark-to-market.

## Claims I could not verify

- **Wald (1945)**, *Sequential Tests of Statistical Hypotheses*, Ann. Math. Statist. 16(2):117-186, doi:10.1214/aoms/1177731118. Not opened (Project Euclid returned an empty page, JSTOR blocked). The thresholds and expected-sample formulas in a.2 are stated from general knowledge and checked by simulation, not by reading the paper.
- **O'Brien and Fleming (1979)**, Biometrics 35:549-556. Not opened. **Pocock (1977)**, Biometrika 64(2):191-199, doi:10.1093/biomet/64.2.191, and **Lan and DeMets (1983)**, Biometrika 70(3):659-663, doi:10.1093/biomet/70.3.659: abstracts only. The boundaries in a.3 are my own Monte Carlo values for the two shapes; they were not compared with the published tables, and no alpha-spending function from Lan-DeMets was used.
- **Lo (2002)**, *The Statistics of Sharpe Ratios*, FAJ 58(4):36-52, doi:10.2469/faj.v58.n4.2453. Not opened. The sqrt(1 / years) standard error is carried over from the founding ticket, which itself relied on secondary write-ups.
- **Bailey, Borwein, López de Prado and Zhu (2014)**, *Pseudo-Mathematics and Financial Charlatanism* (minimum backtest length), Notices of the AMS 61(5). Not opened (403). The backtest-length figures in b.2 are derived from the gate's formula.
- **López de Prado's later work on effective trial counts by clustering.** Not opened; not used.
- **Equations inside the opened PDFs.** Text was extracted with a crude script; prose is legible, equation glyphs are not. The DSR formula was confirmed indirectly by reproducing the paper's worked numbers. The DSR Appendix A.3 interpolation and the mixture-SPRT closed form are reconstructions.
- **CSB database.** A read-only query was refused by the permission system and I did not work around it. Consequences: no per-trade paper returns, no Trial Ledger rows beyond what the web page shows, no fill-gap dispersion, no check of the Stage Clock day 0, no explanation of the halt loss.
- **Monte Carlo precision.** SPRT and mixture-SPRT figures use 3,000 to 4,000 paths (about +-2 to 3% on means); group-sequential boundaries use 400,000 paths (third decimal uncertain).

## Sources

Opened and read (full text unless noted):

- Bailey, D. H. and López de Prado, M. (2014). *The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality.* Journal of Portfolio Management 40(5):94-107. doi:10.3905/jpm.2014.40.5.094. Read from https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf
- Bailey, D. H., Borwein, J. M., López de Prado, M. and Zhu, Q. J. (2015 revision). *The Probability of Backtest Overfitting.* Journal of Computational Finance. SSRN 2326253. Read from https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf
- Johari, R., Pekelis, L. and Walsh, D. *Always Valid Inference: Bringing Sequential Analysis to A/B Testing.* arXiv:1512.04922. Read from https://arxiv.org/pdf/1512.04922
- Howard, S. R., Ramdas, A., McAuliffe, J. and Sekhon, J. *Time-uniform, nonparametric, nonasymptotic confidence sequences.* arXiv:1810.08240. Read from https://arxiv.org/html/1810.08240v9
- Harvey, C. R. and Liu, Y. (2015). *Backtesting.* Journal of Portfolio Management, Fall 2015. Read from https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF
- Harvey, C. R., Liu, Y. and Zhu, H. (2016). *... and the Cross-Section of Expected Returns.* Review of Financial Studies 29(1):5-68. Read from https://people.duke.edu/~charvey/Research/Published_Papers/P118_and_the_cross.PDF ; abstract quotes from NBER w20592, https://www.nber.org/papers/w20592
- Pocock (1977) and Lan and DeMets (1983): abstracts only, via the Biometrika DOIs above.

CSB artifacts (all under `/home/gabe/claw-street-bets`, commit `e9500c8`): `config/graduation-gate.yaml`, `config/risk-template.json`, `config/frozen-granularity.yaml`, `docs/sweeps/2026-11-02-*.json`, `docs/sweeps/README.md`, `src/graduation/sharpe-statistics.ts`, `src/graduation/README.md`, `src/backtest/performance-readout.ts`; live pages `/api/outcomes`, `/trial-ledger`, `/halts`, `/graduation` on port 3334, read 2026-11-20.

## Appendix: functions to re-derive the tables

The script ran from a session scratch directory and is not kept. Its core, stdlib only:

```python
from statistics import NormalDist
import math
Z, PHI, GAMMA = NormalDist().inv_cdf, NormalDist().cdf, 0.5772156649

def g(k):            # expected max of k iid N(0,1)
    return 0.0 if k <= 1 else (1-GAMMA)*Z(1-1/k) + GAMMA*Z(1-1/(k*math.e))
def sr0(k, days):    # gate formula
    return math.sqrt(365/days) * g(k)
def fixed_n(d, alpha=0.05, power=0.8):          # d = delta/sigma
    return ((Z(1-alpha) + Z(power)) / d) ** 2
def psr(sr, sr_star, n, skew, kurt):            # per-observation SR, raw kurtosis
    return PHI((sr-sr_star)*math.sqrt(n-1) / math.sqrt(1 - skew*sr + (kurt-1)/4*sr*sr))

# SPRT: add d*(x - d/2) per trade (x in sd units); stop at ln(0.8/0.05) or ln(0.2/0.95).
# Group-sequential: simulate cumulative sums S_k of K=5 N(0,1) group increments;
#   Pocock-shaped c = 95th pct of max_k S_k/sqrt(k) (2.118);
#   OBF-shaped    c = 95th pct of max_k S_k/sqrt(K) (1.750), z_k = c*sqrt(K/k);
#   power: add drift eta*k to S_k, solve eta for 0.80; inflation = (eta*sqrt(K)/2.486)^2.
# Mixture SPRT: log Lambda_n = -0.5*ln(1+n*t^2) + S_n^2*t^2/(2*(1+n*t^2)), t = tau/sigma = 0.3;
#   stop at ln(1/0.05); S_n is the sum of (x - floor)/sigma.
# Per-trade sd from a sweep readout: expectancyNetBps / sharpeNetPerTrade.
```
