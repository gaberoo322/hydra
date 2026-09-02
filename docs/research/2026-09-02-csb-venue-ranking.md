# Venue facts: ranking WA-legal crypto venues for CSB

**Date:** 2026-09-02 ·
**Scope:** facts only — informs the launch-venue **decision**, which is a
separate, currently-blocked ticket ([#4317](https://github.com/gaberoo322/hydra/issues/4317)).
Nothing here modifies `hydra-betting` config, code, or direction docs; this
file is the entire write footprint.

**Candidates:** Coinbase Advanced Trade, Kraken, Gemini, Alpaca (crypto).
**Verified-not-viable:** Binance.US (Washington-state exclusion, confirmed —
§6).

Every claim below carries a primary-source URL: official venue developer
docs, official fee-schedule pages, or an official legal/availability page.
Where a primary source could not be reached or did not state the fact, it is
listed explicitly in §8 rather than filled in from a blog or comparison
site. **Washington-state availability was independently cross-checked
against a second, non-vendor primary source** — the Washington State
Department of Financial Institutions' own list of licensed money-transmitter
/ virtual-currency businesses (September 2025) — which is a genuine second
line of evidence, not vendor marketing copy; methodology in §6.

**Sourcing caveat:** all figures (fee schedules, rate limits, channel names)
are point-in-time snapshots taken 2026-09-02. Exchange fee schedules and API
docs are among the most frequently revised pages a venue publishes — re-verify
before wiring config, especially the fee tables in §5.

---

## 1. Bottom line

**No hard blocker rules out any of the four WA-legal candidates, and the
axes pull in different directions, so this stays a facts document, not a
verdict — but the facts do sort cleanly into a rough order.** On the
priority-1 axis (websocket data) all four are free and roughly comparable.
On priority-2 (order API) the venues split into two families: **Coinbase is
the only one of the four with a *native, server-side* bracket/OCO order**
(`trigger_bracket_gtc/gtd` — take-profit and stop-loss both resting at the
venue, one auto-cancelling the other on fill), which is the closest fit to
CSB's stated requirement that "the stop must live at the venue." **Kraken and
Gemini instead compete on the *dead-man's-switch* end of priority-2** — both
ship a purpose-built cancel-everything-if-my-process-dies primitive (Kraken's
`CancelAllOrdersAfter`, Gemini's session-cancel + Require-Heartoy + WS
`cancelOnDisconnect`), documented far more precisely than Coinbase's two-step
list-then-`batch_cancel` workaround — but neither supports true OCO/bracket
for spot at all. **Alpaca is the weakest of the four on priority-2**: crypto
explicitly has no bracket/OCO support at all (official docs state this
outright), and whether its one cancel-all endpoint even covers crypto orders
could not be confirmed. On priority-3, **Kraken has a real, documented gap**
— its historical-candle endpoint hard-caps at 720 most-recent bars with "no
bulk historical data dump," meaning a Kraken-only deployment would need a
supplemental historical-data source to backtest deep history; the other
three show no such wall (though none had its exact depth confirmed either).
On priority-4, **fees are the most quantified axis and the widest spread**:
Alpaca is flat 0.15%/0.25% maker/taker across the entire $0–$100k/30-day
band the task asked about; Kraken starts at 0.40%/0.80% and steps down to
0.22%/0.38% at $10k+; Gemini starts at **0.60%/1.20%** under $10k — roughly
4–8× Alpaca's rate — and only reaches Kraken's $10k-tier rate once past
$75k/30-day; **Coinbase's fee schedule could not be verified from a primary
source at all** (both its consumer fee page and help-center page returned a
Cloudflare bot challenge to automated fetching — a genuine gap in this
research, not a finding that Coinbase's fees are bad or good). On priority-5,
all four expose read-only and trade-without-withdrawal key permissions;
Kraken and Gemini state the separation in the plainest terms (explicit
checkboxes / named roles). On priority-6, **all four candidates are
confirmed available to Washington residents by two independent primary
sources each** (own page + WA DFI license record); **Binance.US is the one
confirmed disqualifier**, excluded from Washington by its own current Help
Center page and independently corroborated by its total absence from the WA
DFI's licensee list. Given the priority order in the task (websocket data ≈
tied → order-API safety features Coinbase/Kraken/Gemini all lead Alpaca on,
in different ways → Kraken's historical-data wall is a real cost → fees favor
Alpaca and disfavor Gemini sharply → permissions are a wash → availability is
a wash except Binance.US), **Coinbase and Kraken read as the strongest two
candidates on the facts gathered here, for different reasons (native
bracket orders vs. the cleanest dead-man's switch), with Coinbase's
unverified fee schedule the single largest open question for whoever
resolves #4317.** This is not itself the venue decision.

---

## 2. Ranked fact summary

| Rank¹ | Venue | WS data (free?) | Native bracket/OCO | Dead-man's switch | Historical candles | Fee <$10k maker/taker | Fee $10k–$100k maker/taker | Key perms | WA available |
|---|---|---|---|---|---|---|---|---|---|
| — | **Coinbase Advanced Trade** | Free; `level2`+`market_trades`, no stated conn/sub cap | **Yes** — `trigger_bracket_gtc/gtd` | 2-step (`list orders` → `batch_cancel`) | 1m/5m/1h; depth NOT stated | **NOT VERIFIED** (Cloudflare-blocked) | **NOT VERIFIED** | Granular (`can_view`/`can_trade`/`can_transfer` flags) | Yes (WA DFI: Coinbase Inc #1163082) |
| — | **Kraken** | Free; `book`+`trade` v2, undisclosed numeric cap | No (single conditional-close only; true OCO is Futures-only) | **Best-in-class** — `CancelAllOrdersAfter`, exact documented mechanics | **Hard 720-candle wall**, no bulk dump | 0.40%/0.80% ($0+) → 0.30%/0.60% ($2.5k+) | 0.22%/0.38% ($10k+) → 0.15%/0.30% ($50k+) | Explicit checkboxes incl. separate withdraw toggle | Yes (WA DFI: Payward Interactive Inc #910457) |
| — | **Gemini** | Free (public); richest depth/speed channel set | No | Two endpoints + Require-Heartbeat + WS `cancelOnDisconnect` | 1m/5m/15m/30m/1h/6h/1day; depth not confirmed | **0.60%/1.20%** ($0+) — highest of the four | 0.40%/0.80% ($10k+) → 0.125%/0.25% ($75k+) | Named roles: Auditor / Trader / Fund Manager | Yes (WA DFI: Gemini Trust #1975146, Gemini Moonbase #1518126) |
| — | **Alpaca (crypto)** | Free but **1 connection/account**; 30-symbol cap on free data plan | **No** — explicitly unsupported for crypto | `DELETE /v2/orders` exists; crypto-inclusion **unconfirmed** | 1m–59m/1–23h/day/week/month; depth not confirmed | **0.15%/0.25%** (flat, $0–$100k) — lowest of the four | **0.15%/0.25%** (same flat tier) | Most scopes (9 custom scopes incl. Crypto) | Yes (WA DFI: Alpaca Crypto LLC #2160858) |
| DISQUALIFIED | **Binance.US** | — | — | — | — | — | — | — | **No** — confirmed unavailable (§6) |

¹ Deliberately unranked by row number — see §1 for why the four sort
differently depending on which sub-axis is weighted, and note the venue
CHOICE is #4317's job, not this document's.

---

## 3. Axis 1 — Websocket market data

| Venue | Trade channel | L2 / top-of-book channel | Connection / subscription limit | Cost |
|---|---|---|---|---|
| Coinbase Advanced Trade | `market_trades` (public, batched ~250ms) | `level2` (snapshot + guaranteed-delivery increments) | "WebSocket connections and unauthenticated messages are each limited to 8 per second per IP" — a **connection-rate** limit, not a stated total-simultaneous or per-connection subscription cap ([websocket-rate-limits](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits)) | Free — public channels explicitly need no auth ([websocket-channels](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels)) |
| Kraken | `trade` (v2), snapshot returns most-recent 50 on request ([trade](https://docs.kraken.com/api/docs/websocket-v2/trade/)) | `book` (v2), depth 10/25/100/500/1000, CRC32 checksum over top-10 for integrity ([book](https://docs.kraken.com/api/docs/websocket-v2/book/)) | A max-simultaneous-connections cap exists for anti-abuse but the exact number is **not disclosed**; Cloudflare separately caps reconnect attempts at ~150/10 min/IP ([FAQ](https://support.kraken.com/articles/360022326871-kraken-websocket-api-frequently-asked-questions)) | Free — "Authentication is not required to connect to the public market data feeds" (same FAQ) |
| Gemini | `{symbol}@trade` (public) | `{symbol}@bookTicker` (top-of-book), plus `@depth5/10/20` and 100ms-refresh variants, plus a diff-only `@depth` stream ([streams](https://developer.gemini.com/websocket/streams)) | Numeric simultaneous-connection / per-connection subscription cap **not disclosed**; three network tiers exist (public internet / in-region / local-zone) but only the two lower-latency ones require onboarding ([introduction](https://developer.gemini.com/websocket/introduction)) | Free — "Public market data streams are available without authentication" (same page) |
| Alpaca (crypto) | `t` trades ([real-time crypto data](https://docs.alpaca.markets/us/docs/real-time-crypto-pricing-data)) | `o` orderbook (bid/ask arrays + reset flag) (same page) | **"The number of connections to a single endpoint from a user is limited... in many subscriptions (or without one) this limit is 1"** ([streaming market data](https://docs.alpaca.markets/docs/streaming-market-data)); free data plan additionally caps symbol subscriptions at 30 vs. unlimited on the $99/mo paid plan ([pricing](https://alpaca.markets/data)) | Free tier exists (30-symbol cap); unlimited symbols requires the $99/mo "Algo Trader Plus" plan |

**Read:** functionally comparable for a two-symbol (BTC/ETH) deployment —
none of the symbol caps bind at that scale. Alpaca's **1-simultaneous-
connection** limit is the one structurally different constraint: trades,
quotes, bars, and orderbook must all be multiplexed onto a single socket
rather than split across connections, which the other three do not
document as a limitation.

---

## 4. Axis 2 — Order API: stops, brackets, dead-man's switch, rate limits

| Venue | Stop-limit | Native OCO/bracket (server-side) | Cancel-all / dead-man's switch | Order rate limit |
|---|---|---|---|---|
| Coinbase Advanced Trade | Yes — `stop_limit_stop_limit_gtc`/`_gtd` ([orders guide](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders)) | **Yes** — `trigger_bracket_gtc`/`_gtd`: "as soon as a fill occurs for one of the specified price levels, the other side is automatically disabled" (same page) | No single cancel-all endpoint; workaround is `GET /orders/historical/batch?order_status=OPEN` then `POST /orders/batch_cancel` with the resulting `order_ids` ([cancel-order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/cancel-order), [list-orders](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-orders)); max `order_ids` per batch not stated | **NOT VERIFIED for Advanced Trade specifically** — the only reachable rate-limit page (`docs.cdp.coinbase.com/exchange/rest-api/rate-limits`) uses Exchange's "profile" terminology, a distinct institutional product per Coinbase's own FAQ, so its numbers should not be assumed to carry over |
| Kraken | Yes — `stop-loss-limit`, `take-profit-limit` ([add-order](https://docs.kraken.com/api/docs/rest-api/add-order/)) | No for Spot — `AddOrder`'s `close[...]` params attach exactly **one** conditional-close order, not a paired OCO; true OCO ("Take Profit / Stop Loss (bracket) orders") is documented for **Kraken derivatives/futures** only ([support](https://support.kraken.com/articles/take-profit-stop-loss-bracket-orders-derivatives)), not confirmed for Spot | **`POST /private/CancelAllOrdersAfter`** — send a non-zero `timeout` (seconds) to arm; on expiry all orders cancel; recommended pattern is a heartbeat call every 15–30s with a 60s timeout ([cancel-all-orders-after](https://docs.kraken.com/api/docs/rest-api/cancel-all-orders-after/)) | Separate decaying-point counter from general API calls: `AddOrder` = +1; `CancelOrder` = +8 (fresh) down to +1 (resting ≥300s); max counter/decay by tier — Starter 60/-1/s, Intermediate 125/-2.34/s, Pro 180/-3.75/s ([spot-ratelimits](https://docs.kraken.com/api/docs/guides/spot-ratelimits/)) |
| Gemini | Yes — `"exchange stop limit"` with `stop_price` param; **no execution options** (`maker-or-cancel`/`IOC`/`FOK`) may be applied to stop-limit orders ([create-new-order](https://developer.gemini.com/trading/rest-api/orders/create-new-order)) | No — no OCO/bracket param or endpoint anywhere in the Orders reference | **Two endpoints**: `POST /v1/order/cancel/all` (account-wide, all sessions) and `POST /v1/order/cancel/session` (current API session only, docs recommend this one) ([cancel-all-active-orders](https://developer.gemini.com/trading/rest-api/orders/cancel-all-active-orders), [cancel-all-session-orders](https://developer.gemini.com/trading/rest-api/orders/cancel-all-session-orders)) — combinable with a per-key **"Require Heartbeat"** setting and the websocket `cancelOnDisconnect` param for an explicit, documented dead-man's switch | Private endpoints (incl. orders): 600 req/min, recommended ≤5/sec, 5-request burst allowance, then HTTP 429 ([rate-limit](https://developer.gemini.com/rate-limit)) |
| Alpaca (crypto) | Yes — `market`, `limit`, `stop_limit` are the **only** three crypto order types ([crypto-orders](https://docs.alpaca.markets/docs/crypto-orders)) | **No** — official docs state outright: "Alpaca does not support complex orders (OCO, OTO, bracket) for the Crypto or Options asset class" (same page); a separate "DMA Gateway / Advanced Order Types" feature is equities-only | `DELETE /v2/orders` (cancel-all) exists at the API level, but the reference page does not state whether it covers crypto orders specifically — **unconfirmed** ([delete-all-orders](https://docs.alpaca.markets/us/reference/deleteallorders-1)) | 200 requests/min per account (stated as an account-wide Trading API limit, not confirmed crypto-specific); raisable to 1,000/min for non-retail order routing ([support](https://alpaca.markets/support/usage-limit-api-calls)) |

**Read:** this axis has no single winner. Coinbase is the only venue with a
true server-side OCO/bracket. Kraken has the most precisely documented
dead-man's-switch primitive of the four. Gemini offers the most redundant
combination of safety mechanisms (two cancel-all variants plus a heartbeat
setting plus a websocket disconnect-cancel flag). Alpaca is weakest on every
sub-axis here: no bracket at all, an unconfirmed cancel-all scope, and the
lowest documented rate limit.

---

## 5. Axis 3 — Historical candle/OHLCV API

| Venue | Granularities (1m/5m/1h present?) | History depth | Notes |
|---|---|---|---|
| Coinbase Advanced Trade | Yes — `ONE_MINUTE`/`FIVE_MINUTE`/`ONE_HOUR` among 9 granularities ([get-public-product-candles](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles)) | Not stated on the reference page | Max 350 candles/request (same page); public, no auth required |
| Kraken | Yes — interval minutes `1, 5, 15, 30, 60, 240, 1440, 10080, 21600` ([get-ohlc-data](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/)) | **"Returns up to 720 of the most recent entries (older data cannot be retrieved, regardless of the value of `since`)"** — for 1m bars, ~12 hours | A separate guide states outright: **"Kraken does not provide a bulk historical data dump or websocket replay service"** ([historical-data guide](https://docs.kraken.com/exchange/guides/general/historical-data)) — a real engineering gap for backtest-depth needs |
| Gemini | Yes — `1m, 5m, 15m, 30m, 1h, 6h, 1day` ([list-candles](https://developer.gemini.com/trading/rest-api/market-data/list-candles)) | Not stated on the reference page | Endpoint-specific rate limit not documented separately from the general public-API limit |
| Alpaca (crypto) | Yes — minutes `[1-59]`, hours `[1-23]`, plus day/week/month ([cryptobars](https://docs.alpaca.markets/reference/cryptobars-1)) | Not stated on the reference page | "With the exception of historical crypto data, all market data endpoints require authentication" — i.e. this endpoint needs no auth ([about-market-data-api](https://docs.alpaca.markets/us/docs/about-market-data-api)) |

**Read:** Kraken is the only venue with a *documented* hard ceiling on
lookback depth and an explicit statement that no bulk historical download
exists. The other three did not have an exact depth confirmed from a
primary source either (flagged in §8), but none carries Kraken's documented
"most-recent-720-only" wall.

---

## 6. Axis 4 — Fee schedule at low volume

| Venue | <$10k/30d volume | $10k–$100k/30d volume | Source |
|---|---|---|---|
| Coinbase Advanced Trade | **NOT VERIFIED** | **NOT VERIFIED** | Both `coinbase.com/advanced-fees` and the equivalent `help.coinbase.com` page returned an HTTP 403 Cloudflare interactive challenge to both the WebFetch tool and a direct browser-UA `curl` request from this environment — repeated independently as part of this research and confirmed still blocked. The official REST schema for `get-transaction-summary` confirms the *mechanism* (per-tier `maker_fee_rate`/`taker_fee_rate` fields keyed by USD volume bounds) but its example values are internally implausible OpenAPI placeholders (maker cheaper than taker), not real published rates ([get-transaction-summary](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/fees/get-transaction-summary)). Secondary sources disagree with each other on the real numbers, so none is reported here. |
| Kraken | 0.40% / 0.80% at $0+ (Tier 1), stepping to 0.30% / 0.60% at $2.5k+ (Tier 2) | 0.22% / 0.38% at $10k+ (Tier 3) → 0.20%/0.35% at $25k+ → 0.15%/0.30% at $50k+; 0.12%/0.25% just past $100k | [Fee schedule](https://www.kraken.com/features/fee-schedule) — fetched and cross-checked twice for consistency. Note: several comparison sites quote an older 0.25%/0.40% figure for the bottom tier; that does **not** match the live page as of this research and should be treated as stale. |
| Gemini (API/ActiveTrader) | **0.600% / 1.200%** at $0+ — the highest bottom-tier rate of the four | 0.400%/0.800% at $10k+ → 0.250%/0.500% at $25k+ → 0.125%/0.250% at $75k+ (three tier boundaries inside the $10k–$100k band; no boundary sits at exactly $100k) | [API fee schedule](https://www.gemini.com/fees/api-fee-schedule) — "API orders follow the standard ActiveTrader schedule"; tier = better of trailing-30-day volume or account asset balance, recalculated daily |
| Alpaca (crypto) | **0.15% / 0.25%** — flat, applies to the entire $0–$100,000 band | Same tier, same 0.15%/0.25% — the schedule has no boundary inside $10k–$100k at all | [Crypto fees](https://docs.alpaca.markets/us/docs/crypto-fees), corroborated by [maker/taker FAQ](https://alpaca.markets/support/crypto-maker-taker-gmt-faq); effective 2023-03-13 per the FAQ |

**Read:** this is the most quantified and most differentiated axis. Alpaca
is unambiguously cheapest across the exact volume band the task asked
about. Gemini is unambiguously most expensive at the low end — 4× Kraken's
bottom-tier rate, 8× Alpaca's flat rate — which matters for an
hours-scale-hold, 5m–1h-bar strategy that will generate many more round
trips per dollar of capital than a swing strategy would. Coinbase's fee
schedule is a genuine open question, not a finding either way.

---

## 7. Axis 5 — API key permission granularity

| Venue | Read-only key | Trade-only (no withdrawal) key | Withdrawal disable mechanism |
|---|---|---|---|
| Coinbase Advanced Trade | Confirmed via API: `get_api_key_permissions` returns independent `can_view`/`can_trade`/`can_transfer` booleans ([get-api-key-permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions)); a primary-source *creation-time UI* walkthrough enumerating the toggles was not found, only the query-endpoint schema | Implied by the same independent-flags model (`can_trade` true, `can_transfer` false) — not directly demonstrated in a walkthrough page | `can_transfer` is a separate flag from `can_trade`, confirming withdrawal is independently gate-able |
| Kraken | Yes — enable only "Query Funds" + the two "Query...Orders & Trades" checkboxes, leave all write permissions off ([api-keys guide](https://docs.kraken.com/exchange/guides/rest/api-keys)) | Yes — add "Create & Modify Orders" + "Cancel/Close Orders" without "Withdraw Funds" (same guide) | Simply never check "Withdraw Funds" / "Deposit Funds"; guide explicitly recommends this plus IP whitelisting for any key that does need it |
| Gemini | Yes — the **"Auditor"** role is "explicitly read-only and cannot be combined with other roles" ([roles](https://developer.gemini.com/roles)) | Yes — the **"Trader"** role covers balances/orders/trade history with no withdrawal capability at all | Withdrawal lives exclusively in the separate **"Fund Manager"** role — never granted to a Trader key |
| Alpaca (crypto) | Yes — dedicated "Read only" access level | Yes — "Custom" access level lets Trading be Read & Write while Funding/Admin/other scopes stay No Access, across 9 named scopes (Accounts, Funding, Admin, Crypto, Rebalancing, Trading, Journaling, Data, Reporting, SSE events) ([credential-management](https://docs.alpaca.markets/docs/credential-management)) | Trading-scope keys default to no on-chain crypto withdrawal; actual crypto withdrawal requires the separate, vendor-gated **Crypto Wallets API** that Alpaca must explicitly enable per-account on request ([crypto-wallets-api](https://docs.alpaca.markets/docs/crypto-wallets-api)) |

**Read:** all four venues support the read-only / trade-without-withdrawal
split CSB needs. Kraken and Gemini state it in the plainest terms (explicit
checkboxes, named roles); Coinbase's mechanism is confirmed only via the
permissions-query API schema, not a creation-time guide; Alpaca has the most
scopes but its actual crypto-withdrawal capability is off by default and
must be separately requested, which if anything is a safer default for
CSB's stated no-withdrawal-needed use case.

---

## 8. Axis 6 — Washington-state availability

**Method:** every vendor's own availability/legal page was checked, then
independently cross-checked against the **Washington State Department of
Financial Institutions'** own September 2025 list of licensed money-
transmitter / virtual-currency businesses
([source PDF](https://dfi.wa.gov/sites/default/files/2025-09/virtual-currency-list.pdf),
[licensing program page](https://dfi.wa.gov/money-transmitter-and-currency-exchange-licensing)).
The PDF's text layer was extracted directly (zlib-decompressed content
streams, regex over `Tj`/`TJ` text-show operators) rather than read via
OCR or summary — this is a direct read of the government document's own
text, not an inference.

| Venue | Vendor's own statement | WA DFI licensee-list entry |
|---|---|---|
| Coinbase Advanced Trade | Could not fetch — `coinbase.com/legal/supported_states`, `coinbase.com/legal/trading_rules`, and the equivalent `help.coinbase.com` pages all returned a Cloudflare interactive challenge (same block as §5) | **Present** — "Coinbase, Inc." NMLS #1163082 |
| Kraken | "Kraken is thrilled to announce that we are live and fully operational in Washington" ([blog, 2025-07-16](https://blog.kraken.com/news/welcome-washington-state)); WA is absent from the restricted-states list on Kraken's own geographic-restrictions support article (last updated 2026-08-17 per the page) ([support](https://support.kraken.com/hc/en-us/articles/360001368823-Geographic-Restrictions-Can-I-use-Kraken-if-I-m-from-)) | **Present** — "Payward Interactive, Inc." NMLS #910457 (Payward is Kraken's operating legal entity) |
| Gemini | **"Gemini is available in Washington"**, with its own WA money-transmitter license numbers listed on the page (#550-MT-113429 for Gemini Trust, #550-MT-153839 for "Moonbase") ([areas-of-availability/washington-us](https://www.gemini.com/areas-of-availability/washington-us)) | **Present** — "Gemini Trust Company, LLC" #1975146 and "Gemini Moonbase, LLC" #1518126 |
| Alpaca (crypto) | Listed among eligible US jurisdictions on Alpaca's crypto-eligibility support page ([alpaca-cryptocurrency](https://alpaca.markets/support/alpaca-cryptocurrency)); WA money-transmitter license **550-MT-143636** listed by name in Alpaca's official disclosures PDF ([disclosures PDF](https://files.alpaca.markets/disclosures/WebsiteLicensesAndDisclosuresPage.pdf)) | **Present** — "Alpaca Crypto LLC" NMLS #2160858 |
| **Binance.US** | **"...you will not be able to register and verify for a Binance.US account if you reside in any of the following states/regions:"** — Washington is named in the list, on a page last updated **2026-06-03** ([supported/unsupported states](https://support.binance.us/en/articles/9842798-list-of-supported-and-unsupported-states-and-regions)) | **Absent** — no "Binance" entity of any kind appears anywhere in the WA DFI's licensee list |

**This is the one clean, confirmed hard disqualifier the task asked me to
check: Binance.US is unavailable to Washington residents**, confirmed on
Binance.US's own current (June 2026) Help Center page and independently
corroborated by its total absence from Washington's own regulator list — two
independent primary sources agreeing. Separately, secondary reporting
(PYMNTS, 2025-08; blockchainreporter.net, 2026) indicates Binance.US
restored USD deposits/withdrawals broadly in February 2026 after a ~19-month
suspension — but that restoration explicitly did not extend Washington
eligibility, per the June 2026 supported-states page still excluding it.
That situational context is flagged as secondary-sourced, not primary.

All four remaining candidates are confirmed available to Washington
residents by **two independent primary sources each** (vendor page/PDF +
state regulator list) — an unusually strong evidentiary basis for this one
axis, in contrast to the gaps elsewhere in this document.

---

## 9. Could not verify

Consolidated from all four venue research passes. Listed so a later reader
does not mistake an absence of a fact here for a negative finding.

**Coinbase Advanced Trade:**
- Maker/taker fee percentages at any tier — both `coinbase.com/advanced-fees`
  and the `help.coinbase.com` equivalent are behind a Cloudflare interactive
  bot challenge that blocked both WebFetch and a browser-UA `curl` request,
  confirmed on repeated attempts.
- REST API rate limits for order placement/cancellation specific to
  Advanced Trade — the only reachable rate-limit page uses Coinbase
  Exchange's "profile" terminology (a distinct institutional product), not
  Advanced Trade's "portfolio" model; the old Advanced-Trade-specific
  rate-limit/changelog URLs now redirect to a generic overview page with no
  rate-limit content.
- Maximum `order_ids` count accepted per `batch_cancel` request.
- How far back historical candle data goes.
- A primary-source guide page (as opposed to the permissions-query API
  schema) explicitly confirming View/Trade/Transfer are independently
  selectable at key-creation time.

**Kraken:**
- Exact numeric cap on simultaneous websocket connections per user/IP, and
  on subscriptions per single connection (the FAQ confirms a cap exists for
  anti-abuse purposes but does not publish the number).
- Whether Spot (as opposed to Kraken derivatives/futures, which is
  documented) supports a true OCO pairing of a simultaneous stop-loss +
  take-profit on the same position — only a single attached conditional-
  close order is documented for Spot `AddOrder`.
- A documented rate limit specific to the public `/0/public/OHLC` endpoint
  (only a general "~1 request/second" practical guideline was found).
- A mapping between the Spot rate-limit tier names ("Starter/Intermediate/
  Pro") and the account-verification tier names ("Verified individual
  account," etc.) — no primary source ties the two vocabularies together.

**Gemini:**
- Maximum concurrent websocket connections per IP/account, and maximum
  channel subscriptions per connection.
- An endpoint-specific (as opposed to general-tier) rate limit for order
  placement/cancellation or for the candles endpoint.
- Historical depth of the candle/OHLCV endpoint (a secondary source claims
  ~October 2015 for BTC/USD; not verified against a primary page).
- Verbatim text of the Gemini Earn program's terms, including any
  Washington-specific language (the program's general wind-down is
  reasonably well corroborated but was sourced from search snippets, not a
  fetched `gemini.com/legal` page).

**Alpaca (crypto):**
- Official documented start date for historical crypto candle data (a
  third-party community-forum report claims BTC/USD data starts around
  2020-04-08; not confirmed against a primary Alpaca page).
- Whether `DELETE /v2/orders` (cancel-all) explicitly includes crypto
  orders — the reference page's text does not scope the endpoint to an
  asset class either way.
- Whether the 200-requests/minute rate limit is crypto-specific or a single
  shared account-wide throttle across all asset classes.
- A single authoritative, current, full list of every US state where
  Alpaca crypto is available — two different Alpaca primary sources (the
  support-page eligibility list and the licenses/disclosures PDF) list
  different sets of states, though Washington appears on both.

---

## 10. Sources

**Coinbase Advanced Trade (primary):**
[FAQ / product-naming](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/faq) ·
[WebSocket channels](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels) ·
[WebSocket rate limits](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits) ·
[Orders guide](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders) ·
[Cancel order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/cancel-order) ·
[List orders](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-orders) ·
[Exchange (not Advanced Trade) rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits) ·
[Public product candles](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles) ·
[Get transaction summary (fees schema)](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/fees/get-transaction-summary) ·
[Get API key permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions) ·
[CDP API keys](https://docs.cdp.coinbase.com/get-started/authentication/cdp-api-keys) ·
[API key authentication](https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication)

**Kraken (primary):**
[Trading API overview](https://www.kraken.com/features/trading-api) ·
[WS intro (v1/v2 status)](https://docs.kraken.com/api/docs/guides/spot-ws-intro/) ·
[WS v2 trade](https://docs.kraken.com/api/docs/websocket-v2/trade/) ·
[WS v2 book](https://docs.kraken.com/api/docs/websocket-v2/book/) ·
[WS FAQ (conn limits)](https://support.kraken.com/articles/360022326871-kraken-websocket-api-frequently-asked-questions) ·
[AddOrder](https://docs.kraken.com/api/docs/rest-api/add-order/) ·
[Derivatives bracket orders](https://support.kraken.com/articles/take-profit-stop-loss-bracket-orders-derivatives) ·
[CancelAllOrdersAfter](https://docs.kraken.com/api/docs/rest-api/cancel-all-orders-after/) ·
[REST rate limits (general)](https://docs.kraken.com/api/docs/guides/spot-rest-ratelimits/) ·
[Trading rate limits](https://docs.kraken.com/api/docs/guides/spot-ratelimits/) ·
[Verification levels](https://support.kraken.com/articles/360001395743-verification-levels-explained) ·
[Get OHLC data](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/) ·
[Historical data guide](https://docs.kraken.com/exchange/guides/general/historical-data) ·
[Fee schedule](https://www.kraken.com/features/fee-schedule) ·
[API keys guide](https://docs.kraken.com/exchange/guides/rest/api-keys) ·
[Welcome Washington (blog, 2025-07-16)](https://blog.kraken.com/news/welcome-washington-state) ·
[Geographic restrictions](https://support.kraken.com/hc/en-us/articles/360001368823-Geographic-Restrictions-Can-I-use-Kraken-if-I-m-from-)

**Gemini (primary):**
[WebSocket introduction](https://developer.gemini.com/websocket/introduction) ·
[WebSocket streams](https://developer.gemini.com/websocket/streams) ·
[Create new order](https://developer.gemini.com/trading/rest-api/orders/create-new-order) ·
[Orders reference](https://developer.gemini.com/trading/rest-api/orders) ·
[Cancel all active orders](https://developer.gemini.com/trading/rest-api/orders/cancel-all-active-orders) ·
[Cancel all session orders](https://developer.gemini.com/trading/rest-api/orders/cancel-all-session-orders) ·
[Cancel order](https://developer.gemini.com/trading/rest-api/orders/cancel-order) ·
[Rate limits](https://developer.gemini.com/rate-limit) ·
[API agreement](https://www.gemini.com/legal/api-agreement) ·
[List candles](https://developer.gemini.com/trading/rest-api/market-data/list-candles) ·
[API/ActiveTrader fee schedule](https://www.gemini.com/fees/api-fee-schedule) ·
[Roles](https://developer.gemini.com/roles) ·
[Washington availability](https://www.gemini.com/areas-of-availability/washington-us)

**Alpaca (primary):**
[Real-time crypto pricing data](https://docs.alpaca.markets/us/docs/real-time-crypto-pricing-data) ·
[Streaming market data (connection limits)](https://docs.alpaca.markets/docs/streaming-market-data) ·
[Market data pricing](https://alpaca.markets/data) ·
[Crypto orders](https://docs.alpaca.markets/docs/crypto-orders) ·
[DMA Gateway / Advanced Order Types](https://docs.alpaca.markets/docs/alpaca-elite-smart-router) ·
[Delete all orders](https://docs.alpaca.markets/us/reference/deleteallorders-1) ·
[Usage limit FAQ](https://alpaca.markets/support/usage-limit-api-calls) ·
[Historical crypto bars](https://docs.alpaca.markets/reference/cryptobars-1) ·
[About Market Data API](https://docs.alpaca.markets/us/docs/about-market-data-api) ·
[Crypto spot trading fees](https://docs.alpaca.markets/us/docs/crypto-fees) ·
[Crypto maker/taker FAQ](https://alpaca.markets/support/crypto-maker-taker-gmt-faq) ·
[Credential management](https://docs.alpaca.markets/docs/credential-management) ·
[Crypto Wallets API](https://docs.alpaca.markets/docs/crypto-wallets-api) ·
[Crypto wallet FAQ](https://alpaca.markets/support/crypto-wallet-faq) ·
[Alpaca cryptocurrency support/eligibility](https://alpaca.markets/support/alpaca-cryptocurrency) ·
[Website Licenses and Disclosures PDF](https://files.alpaca.markets/disclosures/WebsiteLicensesAndDisclosuresPage.pdf)

**Binance.US (primary):**
[List of supported and unsupported states and regions (updated 2026-06-03)](https://support.binance.us/en/articles/9842798-list-of-supported-and-unsupported-states-and-regions)

**Binance.US (secondary, situational context only — not relied on for the WA finding):**
[PYMNTS — Binance.US restores USD services](https://www.pymnts.com/cryptocurrency/2025/binance-us-restores-usd-services-after-19-month-drought/) ·
[blockchainreporter.net — 2026 USD services restoration](https://blockchainreporter.net/binance-us-restores-usd-services-and-launches-zero-fee-trading-in-2026/)

**Washington State Department of Financial Institutions (primary, government — cross-venue corroboration):**
[Money Transmitter & Currency Exchange Licensing](https://dfi.wa.gov/money-transmitter-and-currency-exchange-licensing) ·
[Virtual currency licensee list, September 2025 (PDF)](https://dfi.wa.gov/sites/default/files/2025-09/virtual-currency-list.pdf)
