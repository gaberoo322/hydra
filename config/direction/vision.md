# Vision

Extract durable, risk-adjusted alpha from prediction markets by forecasting more accurately than consensus, acting faster than consensus, and operating with deeper structural understanding of the platforms, rules, and microstructure than the majority of market participants.

Profit is the terminal goal. **Forecast accuracy is the primary path.** The 2026-Q2 build-out proved the structural cluster first — cross-venue arbitrage, fee-tier optimization, maker rebates, settlement-velocity capital allocation — and that machinery is real edge worth defending. But it is scaffolding and float, not the destination: structural edge decays as venues close loopholes and competitors arrive; a calibrated forecasting advantage compounds. The execution and microstructure layer exists to let forecast edge be expressed safely, cheaply, and at speed. Research cycles that find the forecasting vector starved should steer work back toward it rather than indefinitely deepening the structural cluster.

**Cross-venue arbitrage is retired as a strategy (2026-06-22, hydra-betting [ADR-0002](https://github.com/gaberoo322/hydra-betting/blob/main/docs/adr/0002-retire-cross-venue-arbitrage-strategy.md)).** It never produced a live opportunity and carried ~24% of the codebase; the bet is that forecast accuracy compounds where structural arbitrage decays. The scanning/harvesting surface (spread scanning, combo-basket, maker-reward harvesting, RFQ mispricing, pair-registry seeding) is being deleted; the execution, risk, recovery, and settlement machinery is salvaged as a **single-leg directional-execution layer** that expresses forecast edge on the same Venues. **Do not file or deepen cross-venue arbitrage work** (scanners, combo baskets, pair seeding, maker-reward harvesting); steer execution work toward expressing forecast edge directionally. Vector 3 (deepen structural understanding) still applies — directional betting needs venue fee/resolution/settlement mechanics — but no longer means harvesting cross-venue spreads.

Edge also comes from liquidity dynamics, resolution mechanics, market design quirks, and behavioral patterns of other participants. We pursue all of these within platform rules and applicable law.

# Domain Priority

**Sports markets are our primary domain.** They offer high event frequency, rich historical data, well-understood statistical foundations, rapid feedback loops, and a participant base ranging from sharp to deeply recreational. The system should be optimized first and most aggressively for sports. Capabilities, models, data pipelines, and agent specializations are developed with sports as the leading use case.

Secondary domains (politics, economics, culture, crypto-adjacent events) are traded opportunistically when edge is clear, but must not pull resources from compounding our sports advantage.

# Decision Vectors

Every feature, task, and system must advance at least one of these six vectors. Features advancing multiple are prioritized. Features advancing sports edge are prioritized over equivalent features in secondary domains. Work that advances none should be rejected.

1. **Sharpen forecasts** — Improve accuracy, calibration, and confidence quantification relative to market consensus. In sports: player/team performance, situational factors, injury/lineup data, weather, referee tendencies, schedule effects, and any domain-specific signal that moves outcomes. This is the primary vector: when measured calibration (`forecast-calibration-brier` in `outcomes.yaml`) is flat or unread for sustained windows, that is itself a finding to research, not background noise.

2. **Compress time-to-signal** — Surface information, market dislocations, and resolution-relevant events faster than competitors can price them. In sports: low-latency ingestion of news, lineup announcements, in-game state, and line movements across books and exchanges.

3. **Deepen structural understanding** — Model each platform's mechanics (Kalshi, Polymarket): order book behavior, fee structures, resolution criteria, settlement timing, liquidity profiles. Trade the actual instrument, not an abstraction of it.

4. **Improve execution discipline** — Size positions correctly, manage risk, exit when edge expires, avoid trades made on conviction without underlying advantage.

5. **Protect the operation** — Stay within platform terms of service, legal bounds, and risk parameters that let edge compound rather than blow up in a tail event.

6. **Close the learning loop** — Systematically evaluate past performance and feed results back into the system. Track forecast calibration, attribute P&L to strategies and signals, identify real vs illusory edge, and continuously refine models and agent behaviors based on measured outcomes. A system that cannot evaluate itself cannot improve itself.

# Graduated Capital

Strategies earn capital in stages; no strategy skips a stage, and each promotion is gated on measured results from the prior one.

1. **Paper** — full pipeline against live market data, simulated fills. Graduates when the strategy shows positive expected edge over a meaningful sample with persisted proof artifacts.
2. **Live proof** — real money at minimum viable stake. Graduates when realized results confirm the paper thesis: fill quality, realized-vs-expected edge, and slippage/fee drag all within modeled bounds, with per-leg/per-run proof persisted.
3. **Scaled** — stake grows stepwise within the bankroll constraints below, never in one jump.

**Kill criteria are defined per stage before the stage begins** (e.g. realized edge below modeled edge beyond noise for N consecutive runs, drawdown breach, fill-quality collapse). A strategy that trips its kill criteria demotes a stage; it does not get tuned in place while continuing to trade at the same stake.

# Constraints

- Never risk more than 2% of bankroll per trade
- Never have more than 20% of bankroll in open positions
- Every strategy passes through Graduated Capital stages — paper first, always
- All LLM inference runs on local Ollama (Tailnet gaming-PC endpoint) — **no cloud inference APIs**. OpenAI was removed; Anthropic was evaluated and rejected. Forecast edge must be economically viable at local-inference cost.
- Keep all tests passing — never ship a regression
