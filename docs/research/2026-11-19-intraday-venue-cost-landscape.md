# Venue and instrument cost landscape for intraday crypto (spot and perps)

Wayfinder map #5687, ticket #5688. Research only: no venue is recommended here (the cost-structure pivot ticket #5693 decides). Gathered 2026-11-19 from public pages via web fetch/search.

## Method and confidence

- Round-trip (RT) cost in bps = 2 x per-side fee + spread + slippage (+ funding for perps, per holding period).
- Fees are tier-0 / entry-tier list prices. Several official fee pages (Coinbase help, coinbase.com fee pages) returned HTTP 403 to the fetcher, so Coinbase figures come from secondary reporting and MUST be re-verified from the CSB account (`GET /api/v3/brokerage/transaction_summary` or the order preview) before the pivot ticket relies on them (Premise rule, map #5687).
- Spread/slippage: no 2026 same-window study across these venues was found. Sources give conflicting snapshots (Hyperliquid vs Binance depth claims come from partisan sources). So spread+slippage is NOT cited below; use the placeholder band "+1 to +3 bps RT on BTC/ETH at small size" as an assumption and replace it with a measured number (record L2 books per venue for a week; see follow-up).

## Comparison table (fees cited, spread/slippage excluded)

| Option | Maker / taker per side (entry tier) | Fee-only RT, maker+maker / taker+taker | Funding | Server-side stop/bracket | Testnet / paper | Jurisdiction |
|---|---|---|---|---|---|---|
| Coinbase Advanced spot, US entry tier ($10K threshold, from 2026-09-16) | 50 / 90 bps (secondary source) | 100 / 180 bps | none | yes: `stop_limit_stop_limit_gtc/gtd`, `trigger_bracket_gtc/gtd`, attachable bracket; downside protection "not guaranteed" in volatility | no sandbox mentioned on the orders page | US ok |
| Coinbase Advanced spot, top (VIP8) | 0 / 2 bps | 0 / 4 bps | none | same | same | tier is the most favourable of 30d volume, derivatives volume or USDC balance (Advanced 1 needs $500K USDC); unreachable at CSB size |
| Coinbase US futures (nano BTC/ETH perpetual-style, CFTC) | "as low as" 2 bps per contract (launch coverage; exchange/NFA fees not verified) | about 4 / 4 bps | not verified (5-year expiry contracts tracking spot) | not verified | not verified | US; up to 10x |
| Coinbase international perps (Deribit-powered gateway since 2026-10-01, replacing INTX) | 0 / 3 bps promo | 0 / 6 bps | not found | docs page (marked reference-only) lists Market and Limit only | not found | non-US eligible regions only; JSON-RPC 2.0, CDP key exchanged for short-lived token |
| Binance USDT-M perps, VIP0 | 2 / 5 bps (secondary) | 4 / 10 bps | 8h default; interest 0.01% per 8h, so about 1 bp per 8h baseline paid by longs; interval drops to 1h at cap/floor; cap/floor +-2% on non-listed symbols | yes: `POST /fapi/v1/algoOrder` STOP_MARKET, TAKE_PROFIT_MARKET, `closePosition` | yes: `demo-fapi.binance.com` | not retrieved; confirm Terms (US users are on Binance.US, no perps) |
| Bybit USDT perps, non-VIP | 2 / 5.5 bps (official help page) | 4 / 11 bps | 8h (secondary source) | not retrieved | not retrieved | listed as unavailable in the US (secondary) |
| Kraken Pro spot, tier 1 | 40 / 80 bps | 80 / 160 bps | none | not retrieved | n/a | US ok |
| Kraken Pro futures/perps, tier 1 | 2 / 5 bps | 4 / 10 bps | hourly (UK/EU/global); US about 8h (marketing wording) | not retrieved | `demo-futures.kraken.com` exists but a decommission notice (year unclear) was seen | entity varies by residence |
| Hyperliquid perps, base tier | 1.5 / 4.5 bps | 3 / 9 bps | hourly (secondary; official page silent) | not retrieved | not retrieved | not retrieved |

Funding is a holding-cost, not an entry cost: at the Binance baseline (1 bp/8h) an intraday trade held a few hours pays roughly 0.3-1 bp; it rises sharply in trend regimes when the rate hits cap.

## Against the frozen 51-66 bps

- Perps tier-0 taker/taker fee-only RT (9-11 bps) is about one fifth of the frozen band; maker/maker (3-4 bps) about one fifteenth. The founding-map assumption of about 15 bps RT on perps (#4318) is consistent with these numbers once spread/slippage and funding are added.
- A discrepancy to resolve: the frozen band is 51-66 bps, but the cited US Coinbase spot entry tier would imply 100-180 bps. Either CSB is on an older Coinbase schedule (the pre-Sep-2026 base was 40/60 bps per side, which fits poorly with 51-66 as well) or the secondary source is wrong. Pull the account's real fee tier first.
- Coinbase spot at any tier CSB can reach stays an order of magnitude above perps; the VIP8 2-4 bps RT is gated by volume or USDC balances far above this account.

## Data and access notes

- Coinbase candles: the candles endpoint page could not be fetched (404); history depth not verified.
- Hyperliquid info `candleSnapshot` serves a 5000-candle window; sources disagree on whether that is a page size or a retention cap, and a Nov 2026 test found history short and uneven. Treat deep history as needing a third-party provider.
- Binance `data.binance.vision` archive and Kraken historical endpoints were not verified in this pass.
- API key permission scoping and IP allow-listing were not retrieved for any venue. The map's Out of scope line (no transfer/withdrawal permission for Hydra credentials) needs a per-venue check of whether a trade-only key exists.

## Gaps for the pivot ticket (#5693)

1. Real CSB fee tier from the account.
2. Measured spread+slippage per venue/size (record books).
3. Per-venue: bracket/stop semantics, testnet, key scoping, jurisdiction (not retrieved: Bybit, Kraken, Hyperliquid, Coinbase US futures).

## Sources

- Coinbase order types: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders
- Coinbase fee restructuring coverage: https://cryptodaily.co.uk/2026/09/coinbase-advanced-fees-usdc-vip-tiers
- Coinbase INTX retirement / Deribit gateway: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/perpetual and https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/derivatives/overview
- Coinbase US perpetual-style futures launch: https://www.theblock.co/news/business/2025-07-22-coinbase-launches-perpetual-futures-363796
- Binance funding mechanics: https://www.binance.com/en/support/faq/360033525031
- Binance fee structure: https://www.binance.com/support/faq/360033544231 (rates via secondary: https://cryptopotato.com/binance-fees/)
- Binance conditional orders/testnet: https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order
- Bybit fees: https://www.bybit.com/en/help-center/article/Perpetual-Futures-Contract-Fees-Explained
- Kraken fees: https://www.kraken.com/pro/fees ; demo: https://support.kraken.com/articles/360024809011
- Hyperliquid fees: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
- Hyperliquid candles: https://docs.chainstack.com/reference/hyperliquid-info-candle-snapshot
