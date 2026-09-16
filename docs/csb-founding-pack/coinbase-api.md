# Coinbase Advanced Trade: API reference for CSB

What a CSB agent needs to know about the venue before writing market-data, fill-model or execution code. Facts marked **(observed)** were read live from the operator's account on 2026-09-16; facts marked **(docs)** come from the CDP documentation on the same date; anything marked **unverified** must be checked before code depends on it.

Placement in the CSB repo: `docs/venue/coinbase-api.md`. Keep it current; an agent that finds a fact here wrong fixes this file in the same PR.

## Two ways in

| Surface | Use it for | Auth |
|---|---|---|
| **Advanced Trade REST + WebSocket** | Everything CSB's services do (market-data recorder, paper clock, later the live router) | CDP API key → per-request JWT (ES256 or Ed25519) for private calls; public market data needs no auth (docs) |
| **Coinbase MCP server** (`https://agents.coinbase.com/mcp`, OAuth) | Interactive operator/Claude inspection only: fee tier, portfolios, spot checks of books and candles | OAuth grant in the operator's Claude client |

**Rule:** no CSB service, test or agent-built code depends on the MCP server. It is an operator convenience in an interactive session. It also has trading and transfer tools, so autopilot dispatches must never be relied on to have it or to call it.

## REST

Base URL (docs): `https://api.coinbase.com/api/v3/brokerage`

### Public market data (no auth, docs)

| Endpoint | Returns |
|---|---|
| `GET /market/products` | product list |
| `GET /market/products/{product_id}` | one product: increments, min/max sizes, status |
| `GET /market/products/{product_id}/candles` | OHLCV candles |
| `GET /market/products/{product_id}/ticker` | recent trades + best bid/ask |
| `GET /market/product_book` | order book |
| `GET /time` | server time (use it to check clock skew before signing JWTs) |

Prefer the `/market/*` endpoints for the recorder and backfill: they need no key, so the market-data service can run with zero credentials in paper phase.

### Private (JWT; key needs `view`, `trade` or `transfer` depending on the call, docs)

| Endpoint | Purpose | Key permission CSB needs |
|---|---|---|
| `GET /transaction_summary` | fee tier, maker/taker rates, 30-day volume | view |
| `GET /portfolios`, `GET /accounts` | portfolio and balance reads | view |
| `GET /best_bid_ask`, `GET /products/...`, `GET /product_book` | authenticated duplicates of market data | view |
| `POST /orders/preview` | fee / fill / slippage estimate without placing | trade (unverified whether view suffices) |
| `POST /orders`, `POST /orders/edit`, `POST /orders/batch_cancel` | live execution | trade — **live stage only** |
| `GET /orders/historical/batch`, `GET /orders/historical/fills` | order and fill history (fills carry commission + maker/taker flag) | view |
| `POST /portfolios`, transfers, `POST /convert/*` | account mutation | **never granted to a CSB key** |

### Candles (observed)

- Granularities: `1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 1d`.
- **Hard cap 350 candles per request.** A 500-candle 1m window returned exactly 350 bars with `truncated: true`. Backfill must page by time window (350 × granularity), never by count.
- Bars come back **newest first**; `start` is **epoch seconds as a string**; OHLCV values are **decimal strings**. Parse to a decimal type, never float, before storing.
- A minute with no trades can be absent. The gap detector must distinguish "no trades" from "missing fetch" (re-request the window before flagging).
- 24 months of 1m history = ~1.05M bars per product ≈ 3,000 requests per product. Pace the backfill; rate limits below are unverified.

### Product constraints (observed, BTC-USD)

`base_increment 0.00000001`, `base_min_size 0.00000001`, `base_max_size 3400`, `quote_increment 0.01`, `quote_min_size 1`, `status online`. Every order the fill model or router produces must round to `base_increment` / `quote_increment` and respect min sizes; read these per product from `GET /market/products/{id}` at startup, never hardcode.

## WebSocket (docs)

| Endpoint | Channels |
|---|---|
| `wss://advanced-trade-ws.coinbase.com` (public, no JWT) | `heartbeats`, `candles` (5-minute buckets), `status`, `ticker`, `ticker_batch` (5 s), **`level2`** (snapshot + incremental updates), `market_trades` (batched over 250 ms) |
| `wss://advanced-trade-ws-user.coinbase.com` (private, JWT) | `user` (open orders, positions), `futures_balance_summary` |

- **`level2` is public.** The checklist question "does level2 need an authenticated connection?" resolves to **no**: the day-one level2 recorder needs no API key.
- Subscribe to `heartbeats` alongside data channels: most channels close after 60–90 s without updates (docs). Treat a missing heartbeat as a disconnect and resubscribe; on resubscribe, `level2` sends a fresh snapshot, so the recorder must mark a book discontinuity rather than splice.
- `level2` updates carry sequence information; a sequence gap means the local book is wrong until the next snapshot (verify the exact field name before coding against it).
- The `candles` channel only emits 5-minute buckets. CSB's 1m source bars come from REST backfill + `market_trades` aggregation, not from the WS `candles` channel.

## Fees (observed 2026-09-16)

- Account tier **Intro: maker 0.50%, taker 0.90%**, trailing 30-day fees 0.
- The graduation gate's cost model is frozen at **Advanced 2 (12.5 / 25 bps)** as a live-turnover projection. It is not the realized tier. Details and the first-live-month cost gap: hydra#4359.
- Published schedules disagree (hydra#4359 recorded a 0.60/1.20 bottom tier on 2026-09-04; a third-party page dated 2026-04-07 lists 0.60/1.20 under $1K, 0.35/0.75 at $1K+, 0.25/0.40 at $10K+, 0.15/0.25 at $50K+). **The only trusted source for CSB's tier is `transaction_summary` on its own account.** Read it at startup and on a daily schedule; a change is a venue fee-schedule change under the gate's re-freeze rule.
- **Tier scope (operator-confirmed 2026-09-16):** the tier is **shared across all portfolios** on the account and is set by **total USD trading volume over the trailing 30 days across all order books** (non-USD trades converted at the most recent fill price). Asset balance is not a tier input. So the operator's own trading in other portfolios lowers CSB's live fees, and CSB cannot control its tier. Never count a better-than-frozen tier as strategy edge: evaluate live expectancy against the frozen `c`, and log `transaction_summary` with each live stage (hydra#4359).
- Fills (`/orders/historical/fills`) report actual commission and maker/taker. The fill-divergence gate compares against these, not against the schedule.

## Book depth: what the slippage floor is up against (observed)

Snapshot 2026-09-16 16:33Z:

- **BTC-USD**: best bid/ask 1 cent apart at ~$75,733 (≈0.001 bps), but only 0.00009 BTC at the best bid.
- **ETH-USD**: spread 15 cents at ~$2,390 (≈0.6 bps). Top 10 levels: bids ≈ 10.6 ETH (~$25K) within ~1.0 bp of best, asks ≈ 44.9 ETH (~$107K) within ~1.8 bps; the best bid held only 0.001 ETH.
- **SOL-USD**: spread 1 cent at ~$97 (≈1 bp).

Top-of-book size is often tiny even when the spread is one tick. The fill model must walk the recorded book for the full order notional (as SCAFFOLD.md specifies) and never price a fill off best bid/ask alone. At the risk template's position sizes, the 3 bps/side floor is likely the binding term on majors, not the book walk.

## Keys and portfolios (operator state, 2026-09-16)

- A dedicated portfolio named **`claw-street-bets`** exists on the account (created via MCP). The API reports its type as `CONSUMER`; the original is `DEFAULT`. It is unfunded. Its UUID lives only in `~/claw-street-bets/.env.local`, never in git.
- The CSB API key is still to be created (checklist A2): scope it to the `claw-street-bets` portfolio with **view** only for paper. Add **trade** only at live graduation, never **transfer**.
- Orders placed through the MCP server are capped at 15,000 USD notional per order. That is an MCP-tool limit, not a venue limit (BTC-USD `quote_max_size` is 150,000,000).

## Open questions (verify before depending on them)

1. REST and WebSocket rate limits (public and private, per second; connections and subscriptions per connection). The CDP rate-limit page URL moved and was not fetched.
2. Whether `POST /orders/preview` works with a view-only key.
3. The exact `level2` sequence field and the snapshot semantics after reconnect.
4. Whether `/market/*` public endpoints are rate-limited per IP more tightly than authenticated ones (matters for a long backfill from one host).
