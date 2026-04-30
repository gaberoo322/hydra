# Vision

Extract durable, risk-adjusted alpha from prediction markets by forecasting more accurately than consensus, acting faster than consensus, and operating with deeper structural understanding of the platforms, rules, and microstructure than the majority of market participants.

Profit is the terminal goal. Forecast accuracy is the primary path — but not the only one. Edge also comes from liquidity dynamics, resolution mechanics, market design quirks, and behavioral patterns of other participants. We pursue all of these within platform rules and applicable law.

# Domain Priority

**Sports markets are our primary domain.** They offer high event frequency, rich historical data, well-understood statistical foundations, rapid feedback loops, and a participant base ranging from sharp to deeply recreational. The system should be optimized first and most aggressively for sports. Capabilities, models, data pipelines, and agent specializations are developed with sports as the leading use case.

Secondary domains (politics, economics, culture, crypto-adjacent events) are traded opportunistically when edge is clear, but must not pull resources from compounding our sports advantage.

# Decision Vectors

Every feature, task, and system must advance at least one of these six vectors. Features advancing multiple are prioritized. Features advancing sports edge are prioritized over equivalent features in secondary domains. Work that advances none should be rejected.

1. **Sharpen forecasts** — Improve accuracy, calibration, and confidence quantification relative to market consensus. In sports: player/team performance, situational factors, injury/lineup data, weather, referee tendencies, schedule effects, and any domain-specific signal that moves outcomes.

2. **Compress time-to-signal** — Surface information, market dislocations, and resolution-relevant events faster than competitors can price them. In sports: low-latency ingestion of news, lineup announcements, in-game state, and line movements across books and exchanges.

3. **Deepen structural understanding** — Model each platform's mechanics (Kalshi, Polymarket): order book behavior, fee structures, resolution criteria, settlement timing, liquidity profiles. Trade the actual instrument, not an abstraction of it.

4. **Improve execution discipline** — Size positions correctly, manage risk, exit when edge expires, avoid trades made on conviction without underlying advantage.

5. **Protect the operation** — Stay within platform terms of service, legal bounds, and risk parameters that let edge compound rather than blow up in a tail event.

6. **Close the learning loop** — Systematically evaluate past performance and feed results back into the system. Track forecast calibration, attribute P&L to strategies and signals, identify real vs illusory edge, and continuously refine models and agent behaviors based on measured outcomes. A system that cannot evaluate itself cannot improve itself.

# Constraints

- Never risk more than 2% of bankroll per trade
- Never have more than 20% of bankroll in open positions
- Paper trade new strategies before real money
- All LLM inference uses Codex via the OpenAI-compatible proxy — no separate OpenAI API key
- Keep all tests passing — never ship a regression
