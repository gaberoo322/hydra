# Claw Street Bets

Domain glossary for `gaberoo322/claw-street-bets`. Terms in **bold** are used exactly as defined here in every issue, PR, test name, and design concept; the `_Avoid_` line lists the synonyms not to drift into. Decisions are not restated here — each term links the founding-map ticket that holds its decision (map: gaberoo322/hydra#4313). Per-context glossaries live beside the code (`src/<context>/CONTEXT.md`) and are created lazily.

## Language

### The business

**CSB**:
Claw Street Bets — an autonomous intraday crypto trading business that trades the operator's own capital. The **Target** the Hydra orchestrator builds (its second crucible under ADR-0013). The business metric is **Real-Money P&L**; there are no customers. (#4314)
_Avoid_: the bot, the product, the app, "the system" (ambiguous with the orchestrator)

**Real-Money P&L**:
Cumulative live-lane profit and loss net of fees, in USD, across every **Graduated Strategy**. The single **terminal outcome**; reads 0 throughout the **Paper Phase** by design. (#4319)
_Avoid_: PnL (unqualified — paper P&L is a different number), returns, performance

**Operator**:
The human who owns the capital, holds the venue account, and alone may merge a change to an **Operator-Only File**. Speaks for themselves in HITL tickets; is never impersonated by an agent.
_Avoid_: user, admin, owner

### Universe and venue

**Venue**:
The exchange CSB trades on. At launch exactly one: **Coinbase Advanced Trade**, chosen for its atomic server-side **Bracket Order**; Kraken is the named fallback. (#4317)
_Avoid_: exchange, broker, platform

**Universe**:
The set of tradable products, selected on a schedule by the **Liquidity Filter** from the venue's product list. Never a hardcoded symbol list. (#4314 Q9)
_Avoid_: watchlist, symbol list, pairs

**Liquidity Filter**:
The config (`config/universe-filter.json`) of minimum 24h volume and maximum spread thresholds that admits a product to the **Universe**. Memecoins and microcaps are a different risk regime, not a wider filter. (#4314 Q9)
_Avoid_: allowlist, whitelist, screener

**Bar**:
One OHLCV candle at a fixed interval. CSB trades 5m–1h bars; 1m bars are the stored source and are aggregated upward. (#4314 Q16, #4322 §5)
_Avoid_: candle (when the interval matters), tick, period

**Candle Store**:
The Postgres tables holding **Bars** (1m source + aggregates), **Level2 Snapshots**, and trades per product, with 24 months of 1m backfill per **Universe** product. The one data source every **Clock** reads. (#4322 §5)
_Avoid_: the database (it holds more than candles), history, OHLCV table

**Level2 Snapshot**:
The recorded top-N order book for a product at a moment, captured at signal time and periodically from day one of paper. The input the **Fill Model**'s slippage walk requires; no venue backfill exists for it. (#4359 (d), #4322 §4)
_Avoid_: order book (the live thing, not the record), depth, L2 (in prose)

**Gap Detector**:
The market-data check that declares a feed gap or stale **Bar** and halts every downstream lane. Stale data is a halt, never a guess. (#4322 §5)
_Avoid_: staleness check, heartbeat (that is the dead-man's switch's word)

### The one fill model, three clocks

**Fill Model**:
The single simulator (`src/fill-model/`) that turns an order plus a market state into a fill: itemised fees from the **Cost Model**, slippage from walking the **Level2 Snapshot** for the order's notional plus half-spread, floored at 3 bps per side, limit-fill rules per order type, and **Bracket Order** semantics with the stop leg filling as taker. The only fill logic in the codebase; a change to it is **money-critical**. (#4314 Q8, #4359)
_Avoid_: paper engine, simulator (unqualified), execution model, matching engine

**Clock**:
The interface a lane plugs into the shared engine so strategy, risk, and graduation code never know which lane they run in. Three implementations: **Backtest Clock** (replays the **Candle Store**), **Paper Clock** (follows the live feed with **Fill Model** fills), **Live Clock** (follows the live feed and routes to the **Venue**). (#4322 §4)
_Avoid_: mode, environment, lane (a lane is what a clock drives, not the interface)

**Lane**:
One of the three runtime contexts a **Clock** drives: backtest, paper, live. "One fill model, three clocks" means the same **Fill Model** prices all three. (#4314 Q8)
_Avoid_: mode, stage (that word belongs to the graduation bar), environment

**Shadow Backtest**:
The **Backtest Clock** re-run over the exact live-paper period on the same signal stream, matched trade-for-trade to the paper record. The reference side of **Fill Divergence**. (#4318 §6)
_Avoid_: replay, reconciliation, backfill

**Expected Fill / Actual Fill**:
In the live **Lane**, the **Fill Model**'s prediction for an order versus the **Venue**'s real fill, recorded side by side. Their gap is the live analogue of **Fill Divergence**. (#4322 §4)
_Avoid_: simulated vs real (ambiguous with the paper lane), theoretical fill

### Strategies and controls

**Strategy**:
A deterministic technical-analysis rule set implementing the **Strategy Interface**. No LLM inference runs inside one. (#4314 Q10)
_Avoid_: bot, model (reserved for the fill model and statistical models), algo, signal (a strategy emits signals; it is not one)

**Strategy Interface**:
The contract every **Strategy** implements: emit signals, expose its **Risk Template**, and declare its **Entry Order Type**. Exposing the template is what lets a **Control Fleet** inherit it mechanically and the **Cost Model** derive **c** per archetype. (#4323 consumer note, #4322 §4)
_Avoid_: plugin API, strategy base class (an implementation detail)

**Risk Template**:
A **Strategy**'s sizing rule, stop distance, and holding-time distribution — everything a **Control Fleet** must copy to be a fair null. Distinct from the **Risk-Template Config**, the operator-only file of bankroll percentages every strategy obeys. (#4323 (4), #4341)
_Avoid_: risk profile, risk parameters (ambiguous between the two), risk settings

**Entry Order Type**:
Whether a **Strategy** enters with a resting limit order (maker-attempted) or a marketable order (taker). Declared on the **Strategy Interface**; fixes the fee side of **c**. Exit legs are always priced taker. (#4359 (b))
_Avoid_: order style, aggressiveness, maker/taker mix (that is the derived quantity)

**Roster**:
The set of **Strategies** admitted to the **Paper Phase**. At launch exactly three archetypes, k = 3, no operator personal picks: **trend-ema** (dual-EMA crossover + higher-timeframe trend filter), **meanrev-bbrsi** (Bollinger-band / RSI dip-buying), **breakout-donchian** (Donchian channel N-bar-high breakout). The slugs are fixed and reused verbatim in directories, outcome names, metric paths, and the **Trial Ledger**. Roster changes are config, entered through the ledger. (#4323)
_Avoid_: portfolio (that is capital allocation, a post-graduation concept), lineup, candidates (they are candidates only until entered)

**Archetype**:
One of the three canonical strategy families in the **Roster**. Parameters are delegated to backtest sweeps under the **Frozen-Parameter Protocol**; the archetype is what the founding grill fixed. (#4323 (2))
_Avoid_: strategy type, family, template (reserved for risk template)

**Control Fleet**:
For one **Strategy**, at least 200 simulated random-entry paths that inherit that strategy's exact **Risk Template** through the same **Fill Model** on the same data. The zero-edge null the **Stage A Screen** compares against (the candidate must beat the fleet's p95). Occupies no live paper slot. (#4318 §5.1, #4323 (4))
_Avoid_: benchmark (reserved for buy-and-hold), baseline, random strategy, monkey portfolio

**Buy-and-Hold Line**:
A benchmark P&L series computed from **Candle Store** data, never traded. Displayed beside every **Strategy**; not part of the gate. (#4323 (4))
_Avoid_: control (that is the fleet), index, market return

**Long-Only**:
CSB's launch posture: spot positions only, no shorts, no derivatives; flat is the short. Shorts are out of scope on the founding map. (#4323 (3))
_Avoid_: unhedged, directional (every strategy here is directional)

### Risk

**Risk Invariant**:
One of the five non-negotiable rules enforced identically in every **Lane**: (1) every entry carries a venue-side stop; (2) per-trade risk is capped at a fixed share of bankroll; (3) a daily loss cap halts trading until the **Operator** resets it; (4) a **Dead-Man's Switch** cancels open orders on heartbeat loss; (5) live keys sit behind the **Credential Fence**. They derive the **Risk Surface**. (#4314 Q14)
_Avoid_: risk rule, guardrail (betting's word for a specific composed check), safety check, limit

**Bracket Order**:
The **Venue**'s atomic server-side order carrying entry, stop-loss, and take-profit together, so the stop lives at the venue if the process dies. **Risk Invariant** #1's exact shape; the paper **Lane** simulates it identically. (#4317)
_Avoid_: OCO (Coinbase's term is bracket; OCO is the two-leg exit alone), stop order (one leg), protective order

**Per-Trade Risk**:
The share of a **Strategy**'s bankroll lost if its stop fills: 0.5% at the stop, 1% hard cap. Sizing = risk amount ÷ stop distance, so notional floats with the stop. **Risk Invariant** #2. (#4341 (1))
_Avoid_: position size (the derived notional), stake, bet size, Kelly fraction (sizing is fixed-fraction here)

**Daily-Loss Halt**:
The fail-closed stop that halts a **Strategy** for the rest of the UTC day once its realized plus unrealized loss reaches 3% of its bankroll, and stays halted until the **Operator** resets it. **Risk Invariant** #3. (#4341 (2))
_Avoid_: daily loss limit (betting's name for a different composition), circuit breaker, drawdown limit (drawdown is the stage-to-date metric)

**Open-Risk Cap**:
The 3% of bankroll ceiling on total **Per-Trade Risk** across concurrently open positions (six positions at 0.5%), so a single gap cannot exceed the **Daily-Loss Halt** in one bar. (#4341 (2))
_Avoid_: exposure cap (betting's 20% notional cap is a different quantity), max positions, concentration limit

**Dead-Man's Switch**:
The independent watchdog (salvaged from the retired target) that cancels every open order when the trading process's heartbeat stops. Filled positions stay protected by their **Bracket Order** stops; unfilled entries are cancelled client-side. **Risk Invariant** #4. (#4314 Q14, #4321 carry #1)
_Avoid_: kill switch (the operator's manual halt is a different control), watchdog (unqualified), heartbeat monitor

**Credential Fence**:
The salvaged auth and write-route guard that keeps live venue keys unreadable from development-time code and puts every operator write route behind an authenticated session. **Risk Invariant** #5. (#4321 carry #4)
_Avoid_: auth, key management, secrets handling

**Key Scope**:
What a **Venue** API key may do: `can_view` (market data + read), `can_trade`, `can_transfer`. The **Paper Phase** provisions `can_view` only; `can_trade` is granted only after the **Graduation Bar** passes; `can_transfer` is never granted. Keys are portfolio-scoped to a dedicated CSB portfolio, never the operator's personal account keys. (#4317)
_Avoid_: permissions (generic), API access, read-only keys (that is one scope, not the concept)

**Risk-Template Config**:
`config/risk-template.json` — the versioned, **Operator-Only File** holding the **Per-Trade Risk**, **Daily-Loss Halt**, **Open-Risk Cap**, and **Live-Proof Schedule** numbers every **Strategy** obeys. A version bump resets every stage clock. (#4341 (5))
_Avoid_: risk config (unqualified), risk settings, limits file

**Operator-Only File**:
A file only the **Operator** may merge a change to: `config/risk-template.json`, `config/graduation-gate.yaml`, `direction/outcomes.yaml`. Hydra may propose a change in an issue, never merge one. All three sit on the **Risk Surface**, so a PR touching them is **money-critical** and fenced from auto-merge. (#4319, #4322 §8)
_Avoid_: protected file, locked config, gate file (one of the three)

**Risk Surface**:
The `riskCritical.surface` list in `.hydra/manifest.json`: the eleven path entries (directory prefix or exact) whose diffs classify a PR **money-critical**. Derived from the five **Risk Invariants** plus gate integrity (**Fill Model**, **Stage Evaluator**, **Trial Ledger**, the **Operator-Only Files**). (#4322 §2)
_Avoid_: protected paths, critical files, Verifier Core (that is the orchestrator-side list; CSB's mirror is **Risk Core**)

**Risk Core**:
`src/risk/risk-core.ts` — CSB's frozen enumeration of the **Risk Surface** plus the pure `classifyRisk` returning `money-critical | standard`. The Target Verifier Core in the ADR-0031 sense; kept in sync with the manifest by a test. (#4322 §2)
_Avoid_: Verifier Core (the orchestrator's own six files), untouchable core (retired), core paths

**money-critical**:
The classification a PR receives when any changed path touches the **Risk Surface**; also the GitHub label that fences a PR or its closing issue from auto-merge. Everything else is `standard`. Lower-case, as the label is spelled. (#4322 §2, §7)
_Avoid_: high-risk, risky, sensitive, T4 (an orchestrator tier, not a CSB class)

### The graduation bar

**Graduation Bar**:
The pre-registered, two-stage set of thresholds a **Strategy**'s paper record must clear before real money: per-stage floors, the **Stage A Screen**, the **Stage B Confirm**, the drawdown clauses, and **Fill-Model Honesty**. Written into **Graduation-Gate Config** and mirrored in `direction/outcomes.yaml` before the first paper trade; an **Operator-Only File**. (#4318, #4319)
_Avoid_: gate (unqualified — CI has gates too), promotion criteria, go-live checklist, success criteria

**Graduation-Gate Config**:
`config/graduation-gate.yaml` — the versioned, machine-readable **Graduation Bar** the **Stage Evaluator** reads, pinned to a **Risk-Template Config** version. A test asserts it agrees with the outcomes file's comment block. (#4319)
_Avoid_: gate.yaml, the gate file, thresholds file

**Paper Phase**:
The period a **Strategy** trades on the **Paper Clock** against live data with **Fill Model** fills, on an independent $10k nominal bankroll, accumulating its graduation record through **Stage A** and **Stage B**. Accrues no venue fee-tier volume. (#4314 Q4, #4323 (5))
_Avoid_: simulation, dry run, demo, backtest (a different lane)

**Stage**:
One of the two 180-day, 400-trade-minimum windows of the **Paper Phase**: **Stage A Screen** then **Stage B Confirm**. A stage has a **Stage Clock** that resets on a parameter edit, a config version bump, or a **Fill-Model Honesty** breach. (#4318)
_Avoid_: phase (that is the whole paper period), round, epoch, period

**Stage Clock**:
The calendar-day and settled-trade counters for the current **Stage**. Calendar time, not trade count, binds Sharpe inference, which is why 180 days is a floor and not a target. (#4318 §4.1)
_Avoid_: timer, window (reserved for rolling metric windows), countdown

**Stage A Screen**:
The first **Stage**, where selection is allowed and priced in: net annualised Sharpe ≥ max(2.0, **SR0(k)**), net Sharpe above the **Control Fleet**'s p95, and net expectancy ≥ 0.5 × **c**. (#4318 §5)
_Avoid_: screening, qualification, phase 1

**Stage B Confirm**:
The second **Stage**, on frozen parameters and a fresh window, where k = 1 by construction: **PSR** ≥ 0.95 on Stage-B data alone, earliest pass day 180, hard fail day 365. (#4318 §7.2)
_Avoid_: validation, out-of-sample test (it is one, but the term is the stage), phase 2

**Frozen-Parameter Protocol**:
The rule that a **Strategy**'s parameters are fixed at the start of a **Stage** and any edit resets the **Stage Clock**; sweeps happen in backtest before a stage begins. (#4318 §7.2, #4323 (2))
_Avoid_: parameter lock, no-tuning rule, freeze (unqualified — the cost model also freezes)

**SR0(k)**:
The expected maximum annualised Sharpe of k zero-edge strategies over the stage window (the Bailey–López de Prado expected-maximum formula). The **Stage A Screen**'s Sharpe floor rises with k, and k is read from the **Trial Ledger**. (#4318 §7.1)
_Avoid_: multiple-testing correction (the mechanism, not the number), Bonferroni (the rejected alternative), selection penalty

**PSR**:
Probabilistic Sharpe Ratio — the probability that the true Sharpe exceeds a reference (here 0), adjusted for non-normality. The **Stage B Confirm** pass statistic. (#4318 §4.2)
_Avoid_: Sharpe confidence, p-value (related but not the same statistic), significance

**Trial Ledger**:
`src/paper/trial-ledger.ts` — the append-only record of every **Strategy** ever entered into **Stage A**, trailing 24 months, failures never deleted. Its count is k for **SR0(k)** and the **Control Fleet** percentile; k = 3 at launch. On the **Risk Surface**. (#4318 §7.1, #4323 (1))
_Avoid_: strategy log, registry, history, attempts table

**Cost Model**:
The frozen, itemised round-trip cost stack behind every "net" figure: **Venue** fees at the frozen tier (Coinbase Advanced 2, 0.125% maker / 0.25% taker), slippage from the **Fill Model**'s book walk floored at 3 bps per side, funding (0 for spot), with the exit leg priced taker. Re-frozen only at a **Stage** boundary, which resets the **Stage Clock**. (#4359)
_Avoid_: fee model (fees are one component), transaction costs (generic), c (the number, not the model)

**c**:
The **Cost Model**'s round-trip cost for one **Archetype**, in bps: trend-ema 44, meanrev-bbrsi 44, breakout-donchian 56. The **Stage A Screen**'s expectancy floor is 0.5 × c and the **Fill Divergence** tolerance is 0.25 × c. (#4359)
_Avoid_: cost (unqualified), fees, round-trip cost (write c once it is defined)

**Fill-Model Honesty**:
The clause set that decides whether paper fills mean anything: **Fill Divergence** within 0.25 × **c** per rolling 100 trades, no significant one-sided paper-worse-than-backtest bias over the stage, and limit-order fill rate within ±10 percentage points of backtest. A breach declares the **Fill Model** lying: trading halts, the model is fixed, the **Stage Clock** resets, and divergent-period trades never count. (#4318 §6)
_Avoid_: model validation, calibration (betting's Brier word), reconciliation

**Fill Divergence**:
|mean(paper − **Shadow Backtest**)| per trade over a rolling 100-trade window, in bps. One of the five per-strategy **leading outcomes**; its **Fill-Model Honesty** tolerance doubles as its holdback no-move band. (#4318 §6, #4319)
_Avoid_: slippage error, tracking error, drift (unqualified)

**Drawdown Backstop**:
The two drawdown clauses of the **Graduation Bar**: fail-fast if stage MDD exceeds the **Control Fleet**'s p95 MDD over the same window, and an absolute 20% of paper capital at the 1%-daily-vol **Risk Template**. The null, not hope, sets the yardstick. (#4318 §5.3)
_Avoid_: max drawdown limit (the metric is MDD; this is the clause), stop-out, ruin threshold

**Graduated Strategy**:
A **Strategy** that has passed both **Stages** and been admitted to the live **Lane** under the **Live-Proof Schedule**. Only graduated strategies contribute to **Real-Money P&L**. (#4341 (4))
_Avoid_: live strategy (ambiguous with a strategy merely running on the live clock for shadowing), promoted strategy, production strategy

**Live-Proof Schedule**:
The real-money ladder: $5k per **Graduated Strategy** at entry, identical **Risk Template** to paper, doubling after each 90-day window in which fill quality, realized-vs-expected edge, and fee/slippage drag stay inside modelled bounds, to a $20k total ceiling raised only by hand. The first ~30 live days at the venue's bottom fee tier are the **Tier-Climb Budget**, outside the gate. (#4341 (3)(4), #4359 (c))
_Avoid_: scaling plan, capital allocation, ramp

**Tier-Climb Budget**:
The known premium paid during the first ~30 live days while the venue account's trailing-30-day volume climbs from the bottom fee tier to the frozen Advanced 2 tier. Recorded as a one-off line, excluded from realized-vs-expected comparison; the 90-day clean window starts once Advanced 2 is reached. (#4359 (c))
_Avoid_: onboarding cost, fee drag (that is an ongoing component), launch cost

### Outcomes and the orchestrator

**Target Outcomes**:
`direction/outcomes.yaml` — the orchestrator-facing contract of 17 named metrics: one **terminal outcome** (**Real-Money P&L**), the orchestrator-self 25% floor, and five **leading outcomes** per **Roster** slug. An **Operator-Only File** that pins the **Graduation-Gate Config** and **Risk-Template Config** versions. (#4319)
_Avoid_: metrics, KPIs, outcomes.yaml (in prose), success criteria

**terminal outcome / leading outcome**:
The orchestrator's two outcome kinds: terminal = the thing that ultimately matters, too slow for holdback decisions; leading = moves first and drives the orchestrator's post-merge Outcome Holdback. CSB's five leading metrics per strategy are net expectancy, net Sharpe, max drawdown, settled-trade count, and **Fill Divergence**. Lower-case, as the orchestrator schema spells them. (#4319)
_Avoid_: lagging indicator, primary/secondary metric

**Outcomes API**:
`GET /api/outcomes` — returns every metric **Target Outcomes** declares, keyed by outcome name, `null` where no settled trades exist. The orchestrator's metrics publisher samples it hourly into `metrics/csb/<slug>/<metric>.txt`. A null is honest no-data, never a fabricated zero. (#4322 §8)
_Avoid_: metrics endpoint, stats API, telemetry

**Stage Evaluator**:
`src/graduation/` — the code that reads **Graduation-Gate Config**, the **Trial Ledger**, and the paper record and returns each **Strategy**'s stage verdict (continue, pass, fail, halt). On the **Risk Surface**. (#4322 §3)
_Avoid_: grader, judge, promotion engine, gate runner

**Gate-Agreement Test**:
The test that loads **Graduation-Gate Config** and asserts the numbers in `direction/outcomes.yaml`'s header comment block and targets match it, so the human-readable copy cannot drift from the machine-readable one. (#4319, #4322 §8)
_Avoid_: consistency check, drift test (the orchestrator has a different drift test)

## Relationships

- A **Strategy** implements the **Strategy Interface**, exposing its **Risk Template** and **Entry Order Type**; its **Control Fleet** inherits the template, and the **Cost Model** derives its **c** from the order type.
- Every **Lane** runs the same **Strategy** and **Risk Invariant** code through the same **Fill Model**; only the **Clock** differs. **Fill Divergence** (paper vs **Shadow Backtest**) and **Expected Fill / Actual Fill** (live) are the two honesty measurements.
- The **Graduation Bar** lives in **Graduation-Gate Config**, is mirrored in **Target Outcomes**, is enforced by the **Stage Evaluator**, and is kept honest by the **Gate-Agreement Test**. All three files are **Operator-Only Files** on the **Risk Surface**.
- The **Trial Ledger** supplies k to **SR0(k)**; the **Frozen-Parameter Protocol**, a config version bump, or a **Fill-Model Honesty** breach resets the **Stage Clock**.
- A **Graduated Strategy** enters the live **Lane** under the **Live-Proof Schedule** with **Key Scope** widened to `can_trade`; the **Tier-Climb Budget** absorbs the first month's fee premium outside the gate.
