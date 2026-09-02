# Graduation-bar math: paper sample size + thresholds for real money (CSB)

**Date:** 2026-09-02 ·
**Ticket:** [#4318](https://github.com/gaberoo322/hydra/issues/4318) ·
**Consumer:** #4319 (drafts the actual `outcomes.yaml` gate from these numbers)

Research pass to derive a defensible, PRE-REGISTERED paper-trading bar for
Claw Street Bets (CSB): autonomous intraday crypto trading, 5m–1h bars,
hours-scale holds, crypto majors, thousands-of-dollars scale, ~2–4 trades/day
per strategy. The bar must be written into `outcomes.yaml` before the first
paper trade and never edited by the system being measured.

Every external claim carries a URL; every derivation is shown. What could not
be traced to a primary source is listed in §9 — **read §9 before quoting §5's
fee numbers or §4's non-normality constants.**

House precedent: the predecessor (hydra-betting) computed it needed ~125–200
settled binary markets to distinguish Brier 0.18 from the 0.25 baseline, then
accumulated **1,180 settled forecasts at Brier 0.2307 — no edge**. The math
below is the same discipline applied to P&L instead of Brier: decide the
sample size and thresholds *before* looking, and make the null hypothesis
(zero edge, best-of-k selection luck) the thing that has to be defeated.

---

## 1. Question

How many settled paper trades, at what Sharpe/expectancy floor, drawdown cap,
fill-model divergence tolerance, and multiple-testing adjustment, before a CSB
strategy may touch real money?

---

## 2. Bottom line

**Calendar time, not trade count, is the binding clock for Sharpe inference —
and the honest numbers are brutal.** At daily P&L marking, the standard error
of an *annualized* Sharpe estimate is ≈ √(1/years) regardless of how many
trades fill inside the window (Lo 2002, §4.1): 180 days of paper buys you
SE ≈ 1.42 Sharpe units, a full year buys SE ≈ 1.0. Consequently a true
Sharpe-1.0 strategy takes **~2.7 years** to merely reject "zero edge" at 95%
(and ~6 years at 80% power); only strategies with true net Sharpe ≳ 2 are
*decidable* inside a one-year paper program. The gate below therefore demands
what intraday-frequency strategies must deliver to be worth real money at all:
**observed net Sharpe ≥ 2.0 to pass screening**. Trade count still matters —
it is the binding clock for *expectancy* and *fill-model* inference — so the
gate carries both floors (≥ 400 settled trades AND ≥ 180 calendar days per
stage). **The single most dangerous failure mode is selection: over a 180-day
window, the best of 10 zero-edge strategies is *expected* to print an
annualized Sharpe of ~2.2** (Bailey & López de Prado's expected-maximum
formula, §7.1) — which is why the gate is **two-stage**: a screening window
where selection happens, then a **fresh, frozen-parameter confirmation
window** where the survivor faces k=1 statistics on out-of-sample data.
Selection bias cannot survive fresh data; that, not a bigger z-score, is the
main defense. The full proposed gate is in §8. Worst-case honest timeline to
first real-money trade: **~12 months** (two 180-day stages). That is the cost
of not repeating the 1,180-forecasts-no-edge outcome with money attached.

---

## 3. Framing: two clocks, two floors

A trading record has two sample sizes and they answer different questions:

| Question | Binding clock | Why |
|---|---|---|
| "Is annualized Sharpe > 0?" | **Calendar time** | Per-period Sharpe is tiny at high frequency; annualizing multiplies both the estimate and its SE by √(periods/yr), so the SE in annual units collapses to ≈ √(1/years) (§4.1). More trades per day do not shorten this. |
| "Is per-trade expectancy > cost?" | **Trade count** | Per-trade mean/sd is estimated per trade; SE shrinks as 1/√N_trades (§4.3). |
| "Is the fill model honest?" | **Trade count** | Divergence is measured per fill (§6). |

Intraday frequency's real statistical gift is not faster Sharpe inference —
it is that genuine intraday edges, when they exist, run at *higher* annualized
Sharpe (many small independent bets per year), which is the only thing that
shortens the calendar. A strategy that can only sustain net Sharpe 1.0 at this
frequency is both statistically undecidable inside a year *and* economically
marginal after infra and tail risk; the gate is allowed to be blind to it.

Conventions used throughout: crypto trades 24/7, so daily P&L marking gives
365 observations/year and annualization factor √365; ~3 trades/day ≈ 1,000
settled trades/year per strategy; "net" always means net of exchange fees and
*modeled* slippage (§5.2).

---

## 4. Sample size — three framings, one answer

### 4.1 Lo (2002): the standard error of a Sharpe estimate

Lo, *The Statistics of Sharpe Ratios*, Financial Analysts Journal 58(4), 2002,
pp. 36–52 ([tandfonline](https://www.tandfonline.com/doi/abs/10.2469/faj.v58.n4.2453),
[CFA Institute](https://rpc.cfainstitute.org/research/financial-analysts-journal/2002/the-statistics-of-sharpe-ratios)):
for IID returns the estimator ŜR of the per-period Sharpe has asymptotic

```
SE(ŜR) = sqrt( (1 + SR²/2) / T )        # T = number of return observations
```

With daily marking, per-period SR is small (annual 2.0 → daily
2.0/√365 = 0.105, so SR²/2 ≈ 0.0055 — negligible), hence in *annualized*
units:

```
SE(ŜR_ann) ≈ sqrt(365) · sqrt(1/T_days) = sqrt(365 / T_days) = sqrt(1 / years)
```

| Paper window | SE of annualized Sharpe |
|---|---|
| 90 days | **2.01** |
| 180 days | **1.42** |
| 270 days | 1.16 |
| 365 days | **1.00** |
| 730 days | 0.71 |

The test statistic for H₀: SR = 0 is t = ŜR_ann · √years. Time needed for a
strategy of TRUE annualized net Sharpe S (one-sided α = 5%, z = 1.645;
80% power adds z_β = 0.8416):

```
T_detect = ((z_α + z_β) / S)² years
```

| True net SR_ann | 50% power | 80% power | trades @ 3/day (80%) |
|---|---|---|---|
| 1.0 | 988 d (2.7 y) | 2,257 d (6.2 y) | ~6,800 |
| 1.5 | 439 d (1.2 y) | 1,003 d (2.7 y) | ~3,000 |
| 2.0 | 247 d | 564 d (1.5 y) | ~1,700 |
| 2.5 | 158 d | 361 d | ~1,100 |
| 3.0 | 110 d | 251 d | ~750 |

Lo's headline caveat applies to us directly: annualizing by √(periods) is
invalid under serial correlation, and serially correlated daily P&L (e.g.
positions held across day boundaries) overstates annualized Sharpe — Lo
documents overstatement up to 65% for hedge-fund monthly data. Mitigation:
mark P&L daily at a fixed UTC time and compute Sharpe on those marks, not on
per-trade returns; report the lag-1 autocorrelation alongside.

### 4.2 Bailey & López de Prado: PSR and Minimum Track Record Length

*The Sharpe Ratio Efficient Frontier*, Journal of Risk 15(2), 2012
([SSRN 1821643](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1821643))
defines the Probabilistic Sharpe Ratio — the probability that the true Sharpe
exceeds a benchmark SR*, correcting the sampling variance for skewness γ₃ and
kurtosis γ₄ (per-period, non-annualized units):

```
PSR(SR*) = Z[ (ŜR − SR*) · sqrt(T − 1) / sqrt(1 − γ₃·ŜR + (γ₄−1)/4 · ŜR²) ]
```

and the Minimum Track Record Length — observations needed before PSR(SR*)
reaches confidence 1−α:

```
MinTRL = 1 + (1 − γ₃·ŜR + (γ₄−1)/4·ŜR²) · ( z_{1−α} / (ŜR − SR*) )²
```

Worked example at our frequency: observed ŜR_ann = 2.0 on daily marks
(ŝr = 0.1047/day), SR* = 0, α = 5%, and crypto-plausible non-normality
γ₃ = −0.5, γ₄ = 6:

```
bracket = 1 − (−0.5)(0.1047) + (5/4)(0.1047²) = 1.066
MinTRL  = 1 + 1.066 · (1.645/0.1047)² = 264 days
```

Gaussian returns would give 249 days — **fat tails and negative skew add only
~6% here; the calendar-time term dominates.** This confirms §4.1's numbers
survive non-normality at daily marking (per-trade marking is far more
non-normal; another reason to mark daily).

### 4.3 The simple expectancy t-test (per-trade clock)

Per-trade net expectancy μ and per-trade sd σ give t = (μ/σ)·√N_trades.
Per-trade Sharpe s = μ/σ relates to annualized Sharpe via
SR_ann = s·√(trades/yr). At 1,000 trades/yr:

| True net SR_ann | per-trade s | N to reject 0 (α=5%, 80% power) |
|---|---|---|
| 1.0 | 0.032 | ~6,200 trades |
| 1.5 | 0.047 | ~2,800 trades |
| 2.0 | 0.063 | ~1,550 trades |
| 3.0 | 0.095 | ~690 trades |

Identical answer to §4.1 once divided by trades/day — the framings are the
same test on different clocks. The per-trade framing is the one to use for
the expectancy-vs-cost floor (§5.2) and it sets the **400-trade floor**: below
~400 trades even a per-trade s of 0.1 (an excellent intraday strategy) has
t < 2, and fill-model divergence estimates (§6) are too noisy to act on.

### 4.4 What N to write into the gate

No fixed N makes a Sharpe-1.0 strategy decidable in tolerable time — so the
gate should not pretend to. The defensible structure is: **floors of 400
settled trades AND 180 calendar days per stage** (below which nothing is
decidable even for true SR ≈ 3), with the actual pass decided by a
significance condition (PSR / control-fleet percentile), not by N alone.
Two stages ≈ 800+ trades and ~12 months total — the same order as
hydra-betting's own 125–200-settled-markets Brier arithmetic once scaled to
the weaker per-observation signal of P&L vs binary outcomes.

---

## 5. Threshold levels

### 5.1 Sharpe floor — justified against the null, not against zero

"P&L > 0" is not a bar; over 180 days a literal coin-flip strategy shows
positive Sharpe 50% of the time and exceeds SR 1.42 one time in six (§4.1).
Two nulls must both be defeated:

1. **The zero-edge null with same risk template.** Operationalized as a
   **random-entry control fleet**: ≥ 200 simulated strategies with identical
   sizing, stop/target logic, hold-time distribution, universe, and
   time-of-day profile — entries randomized. The candidate's net Sharpe must
   exceed the **95th percentile** of the control fleet over the identical
   window. This is the spirit of White's Reality Check — bootstrap the
   distribution of the performance statistic under the null and demand the
   candidate clear it (White, *A Reality Check for Data Snooping*,
   Econometrica 68(5), 2000, pp. 1097–1126,
   [Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1111/1468-0262.00152)).
   The control fleet also empirically absorbs fee drag, funding, and any
   structural drift in the underlying — things a parametric z-test silently
   mis-models.
2. **The selection null** (best-of-k) — handled in §7.

Point floor: **observed net annualized Sharpe ≥ 2.0 at screening**. Three
independent justifications: (a) §4.1 — anything lower is statistically
undecidable within the program's calendar; (b) §7.1 — the expected maximum of
a handful of null strategies over 180 days is already ~1.2–2.2, so a floor of
2.0 is barely above selection noise, not conservatively above it; (c) Harvey &
Liu's argument that multiple testing demands a t ≈ 3 hurdle for any newly
claimed effect (*Backtesting*, Journal of Portfolio Management 42(1), 2015,
[SSRN 2345489](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2345489);
t = SR_ann·√years, so t = 3 at one cumulative year means SR ≈ 3, which the
two-stage structure approximates as 2.0-then-confirm).

### 5.2 Expectancy floor — net of an itemized cost model

The cost stack per round trip on crypto majors (perp futures, taker):
exchange fee ~5 bps/side (Binance USDT-M base tier: maker 2 bps / taker
5 bps — secondary sources, see §9;
[tradersunion](https://tradersunion.com/brokers/crypto/view/binance/futures-fees/),
[bitdegree](https://www.bitdegree.org/crypto/tutorials/binance-fees)), plus
modeled slippage (half-spread + impact; BTC/ETH books at thousands-of-dollars
clip are tight, but model conservatively at 2–5 bps/side), plus funding on
positions held across funding timestamps. Call the itemized modeled round-trip
cost **c** (plausibly 12–20 bps; must be computed per venue/instrument and
frozen into the gate config, not estimated post hoc).

**Floor: net per-trade expectancy ≥ 0.5 × c** (equivalently, gross edge
≥ 1.5 × c). Justification: a strategy netting less than half its own cost
stack has its *sign* decided by the fill model's error bars, not by alpha —
§6's tolerance (±0.25 c) would swamp it. Sanity check against the Sharpe
floor: with hours-scale holds on BTC (per-trade σ ≈ 100–160 bps) and
c ≈ 15 bps, net μ = 0.5c ≈ 7.5 bps gives per-trade s ≈ 0.05–0.075 →
SR_ann ≈ 1.6–2.4 at 1,000 trades/yr — the two floors are mutually consistent
rather than one silently dominating.

### 5.3 Max-drawdown cap

Under the zero-edge null, daily-vol-σ_d P&L behaves as driftless Brownian
motion, whose expected maximum drawdown over T days is E[MDD] = σ_d·√(πT/2)
(Magdon-Ismail, Atiya, Pratap & Abu-Mostafa, *On the Maximum Drawdown of a
Brownian Motion*, Journal of Applied Probability 41(1), 2004 — formula
standard; not read in full, see §9). At a 1%-daily-vol risk template over a
180-day stage: E[MDD | no edge] ≈ 1% · √(π·180/2) ≈ **16.8%**. A
genuine-edge strategy's expected MDD is materially smaller; the null's is the
yardstick.

**Cap, two-sided:**
- **Fail-fast kill:** paper MDD exceeding the **95th percentile of the
  random-entry control fleet's MDD** over the same window ⇒ immediate fail
  (don't wait for the window to end). If the controls themselves can do
  better 95 times out of 100, either there is no edge or the risk template is
  broken — both disqualify.
- **Absolute backstop: 20% of paper capital** at the 1%-daily-vol template
  (scale proportionally if the template's vol differs). This is ~1.2× the
  null's *expected* MDD — beyond it the strategy is indistinguishable from a
  martingale-style blowup pattern regardless of its mean.

### 5.4 Rolling-window vs whole-window measurement

The graduation statistics are computed on the **whole stage window** (rolling
sub-windows multiply the number of implicit tests and reintroduce selection
bias through the back door). Rolling windows appear only in the *monitoring*
clauses (divergence §6, drawdown fail-fast §5.3), where early detection is
the point and the action is conservative (halt/reset, never promote).

---

## 6. Fill-model honesty — paper-vs-backtest divergence tolerance

The paper account is only evidence if its fills mean something. Contract: the
backtester is re-run over the **exact live-paper period** on the same signal
stream ("shadow backtest"), and per-trade results are matched 1:1.

Declared tolerances (breach ⇒ **fill model is lying** ⇒ trading halts, model
is fixed, and the **stage clock resets** — divergent-period data may not count
toward graduation):

1. **P&L divergence:** over a rolling 100-trade window, the mean per-trade
   difference (paper − backtest) must satisfy |d̄| ≤ **0.25 × c** (c = modeled
   round-trip cost, §5.2). Justification: the expectancy floor's entire
   margin of safety is 0.5 c; a fill model drifting by half that margin can
   flip a passing strategy's true sign. With per-trade divergence noise ~σ_d
   and N = 100, this is detectable at ~2σ when real.
2. **Directional bias:** over the full stage, a one-sided t-test that
   d < 0 (paper systematically worse than backtest) significant at 95% ⇒
   breach, even if |d̄| is inside tolerance — a small consistent lie
   compounds.
3. **Fill-rate divergence (limit orders):** paper fill rate within
   **±10 percentage points** of the backtest's fill rate on matched order
   type/aggressiveness buckets. Fill-rate optimism is the classic way
   maker-style backtests lie without touching prices.

One-line rationale for the whole section: hydra-betting's lesson was that a
simulator whose outputs can't be falsified makes every downstream metric
unfalsifiable; the divergence tolerance is what makes "1,180 settled
forecasts" impossible to accumulate against a broken measurement device.

---

## 7. Multiple-testing hazard — the best-of-k trap, quantified

### 7.1 What selection alone manufactures

Bailey & López de Prado, *The Deflated Sharpe Ratio: Correcting for Selection
Bias, Backtest Overfitting and Non-Normality*, Journal of Portfolio
Management 40(5), 2014
([SSRN 2460551](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551),
[author PDF](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)):
the expected maximum of k independent zero-true-Sharpe estimates is

```
SR₀ ≈ sqrt(V[ŜR]) · [ (1−γ)·Z⁻¹(1 − 1/k) + γ·Z⁻¹(1 − 1/(k·e)) ],   γ ≈ 0.5772
```

With √V[ŜR] = the §4.1 standard error (1.42 annualized over 180 days; 1.00
over 365):

| k strategies trialed | E[max ŜR_ann], 180-day window | 365-day window |
|---|---|---|
| 3 | 1.21 | 0.85 |
| 5 | **1.70** | 1.19 |
| 10 | **2.24** | 1.58 |
| 20 | 2.71 | 1.90 |

**Read that table twice: the best of 10 dead strategies is *expected* to
print Sharpe 2.2 over a 180-day paper window.** The paper's own headline
example: after 1,000 independent trials the expected maximum is 3.26 with
zero true skill. Promoting the best of k on a bar calibrated for k = 1 is
exactly how CSB would go live on noise.

The Deflated Sharpe Ratio is then simply PSR (§4.2) evaluated at SR* = SR₀:
DSR ≥ 0.95 within a single 180-day window at k = 5 would require observed
SR ≈ SR₀ + 1.645·1.42 ≈ **4.1 annualized** — practically unreachable. That
is not a reason to weaken the bar; it is the reason the gate must not decide
selection and significance in the same sample.

### 7.2 The structural fix: two-stage design

Statistics cannot cheaply undo selection inside one sample, but **fresh data
resets k to 1** — the confirmation sample was not used to select. Hence:

- **Stage A (screen, selection allowed):** all k candidates run ≥ 180 days /
  ≥ 400 trades. Pass = net SR ≥ max(2.0, SR₀(k, 180 d)) AND > control-fleet
  p95 AND §5.2/§5.3/§6 clauses. The floor **rises with k by formula** — at
  k = 10 the screen floor is 2.24, not 2.0 — so running more parallel trials
  automatically stiffens the bar instead of silently cheapening it.
- **Stage B (confirm, k = 1 by construction):** the survivor runs a fresh
  window with **parameters frozen at Stage A close** — any edit resets
  Stage B to day zero. Pass = **PSR(SR* = 0) ≥ 0.95 on Stage B data alone**,
  evaluated no earlier than 180 days / 400 trades, **hard fail at 365 days**
  if never reached. (Numerically: the observed net SR needed is ≈ 2.4 if
  passing at day 180, declining to 1.65 at day 365.) All §5/§6 clauses apply
  throughout Stage B as well.

**k is counted from an append-only pre-registered trial ledger**: every
strategy that ever enters Stage A increments k for a trailing 24 months, and
failed/abandoned trials are never deleted (deleting failures is
retroactively lowering the bar — the file-drawer trick). Correlated variants
of one idea still count as distinct entries: the raw count is conservative in
the right direction, since the DSR formula assumes *independent* trials.
Simple fallback if the DSR machinery is unwanted: Šidák/Bonferroni the screen
(α/k), which at k = 5 doubles the required N for fixed power — the formula
route is cheaper and better targeted.

### 7.3 Operating characteristics of the combined gate (approximate, Gaussian)

- **True SR = 0** (k=1): P(pass A) ≈ Φ((0−2.0)/1.42) ≈ 8%, and jointly with
  the control-p95 clause ≈ 5%; P(pass B | passed A) ≈ 5% ⇒ **false-graduate
  ≈ 0.3% per strategy**; even at k = 10 trialed, ≲ 3% chance any dead
  strategy graduates.
- **True SR = 1.0:** ≈ 24% × 26% ≈ **6%** — the gate is nearly blind to
  marginal strategies, deliberately (§3).
- **True SR = 2.5:** ≈ 64% × 80% ≈ **50% per attempt** — a genuinely strong
  strategy graduates in one to two 12-month attempts.

---

## 8. PROPOSED CONCRETE `outcomes.yaml` gate (for #4319 to draft; a later ticket locks)

```yaml
# csb-graduation-gate — PRE-REGISTERED before first paper trade.
# Append-only; the system being measured may never edit it.
csb_graduation:
  cost_model:                 # frozen, itemized; all "net" figures use this
    round_trip_cost_c: "fees + modeled slippage + funding, itemized per venue/instrument"
  per_stage_floors:
    min_settled_paper_trades: 400     # below this, expectancy & divergence tests are undecidable (§4.3)
    min_calendar_days: 180            # Sharpe SE = 1.42 at 180d; less is astrology (§4.1)
  stage_a_screen:                     # selection allowed here, and priced in
    net_sharpe_floor: "max(2.0, SR0(k, window))"   # SR0 = expected max of k null trials (§7.1)
    beats_random_entry_controls: "net SR > p95 of >=200 same-risk-template random-entry controls (§5.1)"
    net_expectancy_floor: ">= 0.5 * c per trade"   # below half the cost stack, the fill model owns the sign (§5.2)
  stage_b_confirm:                    # fresh sample => k=1 by construction (§7.2)
    frozen_parameters: true           # any edit resets the stage clock
    pass: "PSR(SR*=0) >= 0.95 on stage-B data alone; earliest day 180, hard fail day 365"
  max_drawdown:
    fail_fast: "MDD > p95 of control-fleet MDD over same window"   # null expects ~17%/180d at 1% daily vol (§5.3)
    absolute_backstop: "20% of paper capital at 1%-daily-vol template"
  fill_model_honesty:                 # breach => halt, fix, stage clock resets (§6)
    pnl_divergence: "|mean(paper - shadow-backtest)| <= 0.25 * c over rolling 100 trades"
    directional_bias: "one-sided t-test paper<backtest at 95% over full stage => breach"
    fill_rate: "limit-order fill rate within +/-10pp of backtest per order-type bucket"
  multiple_testing:
    trial_ledger: "append-only; k = all strategies entering stage A, trailing 24mo; failures never deleted"
    rule: "stage-A floor and control percentile computed at current k; stage B immune via fresh sample"
```

One-line justifications:

- **≥ 400 trades AND ≥ 180 days per stage** — trades bound expectancy/fill
  inference, calendar bounds Sharpe inference; each floor is where its test
  first becomes decidable (§4).
- **Net Sharpe ≥ max(2.0, SR₀(k)) at screen** — below 2.0 is undecidable
  in-program and inside best-of-k selection noise (§5.1, §7.1).
- **PSR ≥ 0.95 on a frozen fresh window to confirm** — fresh data is the only
  cheap cure for selection bias; PSR makes the significance claim explicit
  and non-normality-adjusted (§4.2, §7.2).
- **Expectancy ≥ 0.5 × modeled round-trip cost** — keeps the strategy's sign
  outside the fill model's error bars (§5.2, §6).
- **MDD ≤ control-fleet p95, backstop 20%** — the null, not hope, sets the
  drawdown yardstick; a driftless walk already "expects" ~17% per stage (§5.3).
- **Divergence ≤ 0.25 × c per 100 trades, no significant negative bias, fill
  rate ±10 pp** — a fill model that drifts half the expectancy margin can
  flip the verdict; breach resets the clock (§6).
- **Append-only trial ledger; floor rises with k** — the best of 10 dead
  strategies is expected to show SR 2.2; the bar must know how many tickets
  were bought (§7.1).

These are proposals — #4319 drafts, a later ticket locks.

---

## 9. Claims I could not verify

1. **Binance fee levels (5 bps taker / 2 bps maker USDT-M; 10 bps spot)**
   come from secondary aggregators
   ([tradersunion](https://tradersunion.com/brokers/crypto/view/binance/futures-fees/),
   [bitdegree](https://www.bitdegree.org/crypto/tutorials/binance-fees)), not
   binance.com's authenticated fee page. The gate's cost model must be frozen
   from the actual venue's live schedule at pre-registration time; the §5.2
   arithmetic used these numbers only for consistency checks.
2. **Slippage of 2–5 bps/side on crypto majors** at thousands-of-dollars
   clips is an assumption, not a measurement — no live order book was probed
   in this pass. It must be measured during early paper trading and folded
   into c before it is frozen.
3. **Crypto-typical skew −0.5 / kurtosis 6** used in the MinTRL worked
   example (§4.2) is an illustrative assumption; the sensitivity shown (~6%)
   is the point, not the specific moments.
4. **E[MDD] = σ√(πT/2) for driftless Brownian motion** (§5.3) is the
   standard result attributed to Magdon-Ismail et al. (2004); the paper was
   not read in full — the constant was used only to justify an
   order-of-magnitude backstop, and the operative clause (control-fleet p95)
   does not depend on it.
5. **Harvey & Liu's t ≈ 3 hurdle** was confirmed via the SSRN abstract and a
   CME-hosted copy of *Backtesting*
   ([PDF](https://www.cmegroup.com/education/files/backtesting.pdf)) plus
   search summaries; the paywalled JPM version was not read in full.
6. **Lo (2002), Bailey & López de Prado (2012, 2014), White (2000)** formulas
   were cross-checked against multiple independent secondary write-ups
   ([Portfolio Optimizer on PSR/MinTRL](https://portfoliooptimizer.io/blog/the-probabilistic-sharpe-ratio-bias-adjustment-confidence-intervals-hypothesis-testing-and-minimum-track-record-length/),
   [Quantdare on DSR](https://quantdare.com/deflated-sharpe-ratio-how-to-avoid-been-fooled-by-randomness/),
   [Wikipedia: Deflated Sharpe ratio](https://en.wikipedia.org/wiki/Deflated_Sharpe_ratio))
   and the davidhbailey.com author PDF, but the journal versions themselves
   are paywalled. The arithmetic in §4 and §7 was computed independently here
   and any error in it is mine, not the sources'.
7. **The ~1,000 trades/yr and 2–4 trades/day figures** are the ticket's
   stated expectation for CSB, not a measurement of a system that does not
   yet exist; every table in §4 scales trivially if the realized cadence
   differs (the calendar-clock results, §4.1, do not change at all).

---

## 10. Sources

- Lo, A. W. (2002). *The Statistics of Sharpe Ratios.* Financial Analysts
  Journal 58(4), 36–52. [DOI 10.2469/faj.v58.n4.2453](https://www.tandfonline.com/doi/abs/10.2469/faj.v58.n4.2453) ·
  [CFA Institute copy](https://rpc.cfainstitute.org/research/financial-analysts-journal/2002/the-statistics-of-sharpe-ratios)
- Bailey, D. H., & López de Prado, M. (2012). *The Sharpe Ratio Efficient
  Frontier.* Journal of Risk 15(2), 3–44.
  [SSRN 1821643](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1821643)
- Bailey, D. H., & López de Prado, M. (2014). *The Deflated Sharpe Ratio:
  Correcting for Selection Bias, Backtest Overfitting and Non-Normality.*
  Journal of Portfolio Management 40(5), 94–107.
  [SSRN 2460551](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551) ·
  [author PDF](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
- Harvey, C. R., & Liu, Y. (2015). *Backtesting.* Journal of Portfolio
  Management 42(1), 13–28.
  [SSRN 2345489](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2345489) ·
  [CME-hosted PDF](https://www.cmegroup.com/education/files/backtesting.pdf)
- White, H. (2000). *A Reality Check for Data Snooping.* Econometrica 68(5),
  1097–1126. [DOI 10.1111/1468-0262.00152](https://onlinelibrary.wiley.com/doi/abs/10.1111/1468-0262.00152)
- Magdon-Ismail, M., Atiya, A., Pratap, A., & Abu-Mostafa, Y. (2004). *On the
  Maximum Drawdown of a Brownian Motion.* Journal of Applied Probability
  41(1). (Formula cited; not read in full — §9.4.)
- Fee references (secondary — §9.1):
  [Traders Union: Binance futures fees](https://tradersunion.com/brokers/crypto/view/binance/futures-fees/) ·
  [BitDegree: Binance fees](https://www.bitdegree.org/crypto/tutorials/binance-fees)
- House precedent: `docs/research/2026-08-27-nfl-prediction-markets-direction.md`
  §2, §5.1 (the 125–200-settled-markets Brier arithmetic and the
  1,180-forecasts-no-edge outcome); `config/direction/outcomes.yaml`
  (pre-registered metric conventions: baseline/target/noise_epsilon, null =
  no-data never fabricated).
