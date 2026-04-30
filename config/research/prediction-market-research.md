# Prediction Market Research Library

Research papers curated by the operator to inform Hydra's trading strategy development. These findings should guide feature prioritization and strategy design.

---

## Paper 1: Prediction Markets and the Forecasting of Inflation Shocks (Kalshi Research — "Crisis Alpha")

**Source:** https://research.kalshi.com/articles/crisis-alpha

**Key finding:** Kalshi prediction markets exhibit "shock alpha" — they are substantially more accurate than bank forecasts during periods of heightened volatility, when market expectations diverge sharply from outcomes. Event contracts are especially informative when uncertainty is elevated and models calibrated on recent history struggle.

**Actionable for our system:**
- Build a volatility regime detector — when uncertainty is high, prediction market prices carry MORE signal, not less
- Our edge model should weight prediction market prices more heavily during volatile periods
- Crisis/shock events are where the biggest mispricings occur — focus arbitrage scanning during high-volatility windows
- Inflation and macro event contracts are the highest-alpha category on Kalshi

---

## Paper 2: Slowly, Then All At Once — What Mamdani's Victory Tells Us (Kalshi Research)

**Source:** https://research.kalshi.com/articles/mamdani-primary-victory

**Key finding:** Analysis of how prediction markets price political events, examining market microstructure, calibration quality, and how information gets incorporated into prices over time. Markets often price in information "slowly, then all at once" — gradual drift followed by sharp moves as consensus crystallizes.

**Actionable for our system:**
- Monitor price drift velocity as a signal — slow consistent movement in one direction often precedes a sharp move
- There may be alpha in detecting the "slow" phase and positioning before the "all at once" phase
- Political event markets have distinct microstructure from macro/economic markets
- Calibration analysis suggests these markets are well-calibrated but not perfectly efficient

---

## Paper 3: Forecasting Future Language — Context Design for Mention Markets (arXiv 2602.21229)

**Authors:** Sumin Kim, Jihoon Kwon, Yoon Kim, Nicole Kagan, et al.
**Source:** https://arxiv.org/abs/2602.21229

**Key finding:** LLMs can forecast prediction market outcomes (specifically "mention markets" — whether companies will mention keywords in earnings calls). The breakthrough technique is Market-Conditioned Prompting (MCP) — instructing the LLM to treat current market probability as a prior and update it with new textual evidence, rather than predicting from scratch.

**MixMCP** (hybrid approach combining market probability with MCP) outperforms either method alone for more robust predictions.

**Actionable for our system:**
- Our LLM edge model should use MCP — feed current market price as a prior, then ask the model to update based on evidence
- Don't ask "what is the probability of X?" — ask "the market says 65%, given this evidence, should it be higher or lower?"
- Mention markets (earnings call keyword prediction) are a concrete, automatable market type
- Ensemble multiple context strategies for robustness
- Calibration (Brier score) is the right metric for our probability estimator, not binary accuracy

---

## Paper 4: LLM as a Risk Manager — Semantic Filtering for Lead-Lag Trading (arXiv 2602.07048)

**Authors:** Sumin Kim, Minjae Kim, Jihoon Kwon, Yoon Kim, Nicole Kagan, et al.
**Source:** https://arxiv.org/abs/2602.07048

**Key finding:** LLMs can filter lead-lag trading signals in prediction markets, acting as semantic risk managers. Statistical lead-lag detection (Granger causality) finds pairs where one market's price movements predict another's, but many are spurious. Using an LLM to evaluate whether the causal relationship has "a plausible economic transmission mechanism" dramatically improves results.

**Specific results on Kalshi Economics markets:**
- Win rate increased from 51.4% to 54.5% with LLM filtering
- Average losing trade magnitude decreased from $649 to $347
- The LLM filters out "statistically fragile links prone to large losses"

**Actionable for our system:**
- Implement lead-lag detection across Kalshi markets using Granger causality
- Use our LLM to validate whether detected correlations make economic sense before trading
- This is a concrete, implementable strategy: scan for price leader-follower pairs, validate semantically, trade the follower
- Focus on reducing loss magnitude (risk management) not just increasing win rate
- The 51.4% → 54.5% win rate with smaller losses is a significant edge in prediction markets

---

## Paper 5: Kalshi and the Rise of Macro Markets (Federal Reserve FEDS 2026-010)

**Authors:** Anthony M. Diercks, Jared Dean Katz, Jonathan H. Wright (Federal Reserve Board)
**Source:** https://www.federalreserve.gov/econres/feds/kalshi-and-the-rise-of-macro-markets.htm

**Key findings:**
- Prediction markets perform AS WELL AS or BETTER THAN the Fed's own primary dealer survey for interest rate forecasting
- For headline CPI inflation, prediction markets produce SIGNIFICANTLY smaller forecast errors than Bloomberg consensus
- Kalshi correctly identified the most likely rate outcome on the eve of EVERY Fed meeting since 2022
- Markets provide continuous probability distributions, not just point forecasts
- During July 2025, probability of a rate hold fluctuated from below 80% to above 90% following different announcements — surveys and futures did NOT capture this

**Actionable for our system:**
- Macro event contracts (Fed funds rate, CPI, unemployment, GDP, nonfarm payrolls) are the HIGHEST CREDIBILITY markets on Kalshi
- Focus initial trading on these markets — they have the deepest liquidity and strongest evidence of accuracy
- The distributional nature of these markets (probability distributions, not point estimates) is a key advantage
- Real-time price movements around economic announcements are information-rich — our scanner should watch for these
- The Fed researchers validated Kalshi data quality — we can trust the price signals

---

## Synthesis: What This Means for Our Trading System

### Highest-priority strategies from the research:

1. **Lead-lag trading with LLM filtering** (Paper 4) — Most concrete, immediately implementable. Scan Kalshi markets for Granger-causal pairs, validate with LLM, trade the follower. Expected: 54.5% win rate with controlled downside.

2. **Market-Conditioned Probability Estimation** (Paper 3) — Use our LLM edge model with MCP: feed current market price as prior, update with evidence. This is how our probability estimator should work.

3. **Shock/Crisis Alpha** (Paper 1) — Increase position sizing and scanning frequency during high-volatility periods. The edge is LARGER when uncertainty is high.

4. **Macro event focus** (Paper 5) — Start with Fed funds rate, CPI, unemployment contracts. Deepest liquidity, highest credibility, Fed-validated accuracy.

5. **Drift detection** (Paper 2) — Monitor slow price drift as a leading indicator. Position before consensus crystallizes.
