# CSB paper worker pre-flight: what besides the empty freeze stops Stage A starting today?

Wayfinder ticket gaberoo322/hydra#5227, map #5225. Facts only. Observed 2026-10-26 (host clock) against
`gaberoo322/claw-street-bets` main at `04d45b3` (= `public/deploy-sha.txt`, #303) and the live `claw_street_bets`
Postgres (container `hydra-postgres-1`). Reproduce the DB figures with `docker exec hydra-postgres-1 psql -U hydra -d claw_street_bets`.

## Headline

Filling `config/frozen-granularity.yaml` would **not** start the worker. Today `claw-street-bets-paper.service` dies
**earlier** than the frozen-granularity refusal, on the Regime Filter, because the Candle Store holds no BTC-USD
`ONE_DAY` Bar. Beyond that one blocker, the other boot inputs resolve. The real gaps are elsewhere: the Dead-Man's Switch
units are not installed on the host, a DMS trip pages only the Morning Brief, and an honest Level2-backed sweep has only
about 33 days of recorded books to draw on.

## 1. Boot refusals in `src/bin/paper-clock.ts`, in firing order

`runPaperClockCli` order: no argv, `DATABASE_URL`, `bootRegimeFilter`, `bootPaperClock` (risk template + Roster),
`bootHaltGate`, then `productionPlan` (frozen granularity, graduation gate, universe filter, `selectUniverse`, `screenBookWalk`).
Every refusal exits 2.

| # | Refusal | Fires today? | Evidence |
|---|---------|--------------|----------|
| 1 | `DATABASE_URL` unset | No | `.env.local` sets it; the DB answers. |
| 2 | **Regime Filter unbound** (no/short BTC-USD `ONE_DAY` series, 20 closed weeks required) | **YES, first** | Ran the real entrypoint via `systemd-run` with the unit's env: `refusing to boot: Regime Filter unbound: no BTC-USD ONE_DAY Bar in the Candle Store; run the full-history daily backfill`, exit 2. |
| 3 | Risk-Template unusable / Roster unknown or duplicate slug | No | `loadRiskTemplate()` returns v1; Roster slugs match `ROSTER_SLUGS` (4). |
| 4 | Unpersisted-Halt Journal unusable | No | Defaults to `~/.local/state/claw-street-bets/paper-clock-unpersisted-halts.json`; the directory does not exist yet but the journal `mkdir -p`s it. |
| 5 | `frozen-granularity.yaml` unusable, or any Roster slug unfrozen | **Yes** (`strategies: {}`) | The ticket's known blocker; reachable only after #2 clears. |
| 6 | `graduation-gate.yaml`: `paperBankroll` / `bankrolls: independent` / honesty `c_bps` per slug | No | Bankroll 10000; `per_archetype` carries all four slugs including the twin. |
| 7 | `universe-filter.json` parse, venue read, book-walk screen, "admits no product" | No (see 2) | Replayed `selectUniverse` + `screenBookWalk` live: admitted BTC-USD, ETH-USD, XRP-USD. |
| 8 | Restored open position older than the Candle Store | No | `paper_fills` is empty. |

Cause of #2: the Candle Store holds only `ONE_MINUTE` rows (see 3). `README`/`src/market-data/README.md` "Regime Filter
history" gives the fix: `scripts/backfill-candles.ts --products BTC-USD --granularity ONE_DAY --months 150` (about 12 public
requests, resumable). The recurring backfill timer never writes `ONE_DAY`. This is an ops step, not a code change, but it
must precede day 0 and the filter is bound once at boot (the twin reads OFF from the next Monday 00:00 UTC until the
worker restarts on a backfilled series), so the daily backfill needs a standing cadence or a restart discipline. That is a
tail item for the enable runbook.

## 2. Liquidity Filter and Level2 Snapshots

`book_walk.min_snapshots` = 1440. Recorded Level2 Snapshots (`level2_snapshots`, cadence about 1 per minute, first row
2026-09-23T00:07Z, recorder live to the minute of observation):

| Product | Snapshots | Note |
|---------|-----------|------|
| BTC-USD | 47,021 | |
| ETH-USD | 47,021 | |
| XRP-USD | 42,655 | recorder gaps |
| SOL-USD | 41,866 | recorder gaps |
| ZEC-USD | 6,795 | stopped 2026-10-13 |
| NEAR-USD | 7,654 | stopped 2026-10-10 |
| LINK / SUI / HYPE / AVAX / HBAR / QNT | 4,554 / 4,276 / 3,052 / 911 / 892 / 864 | stopped 2026-09-30 to 10-10 |

Every currently recorded major clears the 1440 minimum many times over. Live admission (live venue volume/spread plus the
recorded book walk, all products held to the stricter admit pair): **BTC-USD, ETH-USD, XRP-USD**. SOL-USD was not admitted at
the observation instant and ZEC-USD was refused on spread (2.19 bps against the 2 bps admit cap); the Universe is a point-in-time
verdict that can differ at day 0.

## 3. Candle Store history

Only `ONE_MINUTE` is stored (16 products; no 5m/15m/30m/1h/`ONE_DAY` rows). For the four majors:

| Product | 1m bars | From | To |
|---------|---------|------|----|
| BTC-USD, ETH-USD, XRP-USD | about 1.09M each | 2024-09-23 | now |
| SOL-USD | 1,092,349 | 2024-09-23 | 2026-10-25 |

There is no 1m-to-Nm aggregation code in `src/` (searched for rollup/aggregate/downsample). Whatever runs the #31 sweep through
`loadBars(product, granularity, ...)` needs rows at each of the four granularities, so each must be backfilled first with the
existing CLI (`--granularity FIVE_MINUTE|FIFTEEN_MINUTE|THIRTY_MINUTE|ONE_HOUR`, same cursor mechanism), or an aggregation
step must be written. The live worker is unaffected: its first poll fetches the lookback window from the venue and stores it.

Honesty ceiling for a sweep: the Backtest Clock prices each fill on the latest recorded Level2 Snapshot at or before the
signal Bar, else a zero-spread synthetic book. Snapshots begin 2026-09-23, so only the last 33 days of an otherwise 24-month
sweep are Level2-backed; everything earlier is synthetic book at the 3 bps slippage floor (counted in `result.books`). At 5m to
1h entries that window yields few trades per grid point. A sweep over the full 24 months is therefore a signal-quality sweep,
not a Level2-honest fill sweep, and the recorded window grows by one day per day until the freeze.

## 4. Dead-Man's Switch and page channel

- **Not installed.** `~/.config/systemd/user/` has `claw-street-bets-{backfill.service,backfill.timer,paper,recorder,web}.service`
  (all stamped 2026-10-24 14:56) but **no** `claw-street-bets-deadmans-switch.{service,timer}`. (The two `hydra-betting-deadmans-switch.*`
  files there are the old Target's.) The repo has both units in `ops/systemd/` and `scripts/deploy.sh` `UNITS` lists them, so the
  14:56 deploy evidently ran before the #303 checkout and installed the older list. The next deploy installs them (not enabled).
  Enable order is fixed by README: paper worker enabled and beating, then the timer; enabling early trips on the second tick
  (`heartbeat-missing`) and latches.
- **Heartbeat source exists but never ran.** `lane_heartbeats` has 0 rows; `order_intents`, `paper_fills`, `trial_ledger`, `daily_loss_halts`
  are all empty; the paper unit's journal is empty. So the DMS has nothing to read until the worker has beaten.
- **`OnFailure=hydra-notify-failure@%n` is wired and reachable, but it is not a page.** `hydra-notify-failure@.service` is installed;
  `~/hydra/.env` carries the Telegram variables it needs. It runs `scripts/operator-notify.ts service-failed`, whose
  `UNIT_PAGE_KINDS` closes the page list to orchestrator, autopilot, tunnel and backups: "Everything else (claw-street-bets-\*, ...)
  is a Morning Brief item, never a page". A DMS trip (exit 3) or a paper-unit `failed` state therefore lands in the Morning Brief
  as `service:unit_failed`, not an immediate Telegram page. This contradicts the Target README's statement that the unit is "the only
  operator page channel" and the paper unit's "alerts the operator". Whether a DMS trip should be an immediate page is an open
  decision (it would add a `claw-street-bets-deadmans-switch` entry to `UNIT_PAGE_KINDS`, a Hydra-side change in the page list
  governed by ADR-0045 Decision 3).

## Open items this leaves for the map

1. Run the `ONE_DAY` BTC-USD backfill before day 0, and decide how the filter stays fresh while the worker runs (weekly restart or backfill cadence).
2. Sweep data: backfill (or aggregate) 5m/15m/30m/1h for the admitted products, and accept that Level2-backed fills cover only the recorded window.
3. Next deploy installs the DMS units; enable only after the worker is beating.
4. Page-list decision for `claw-street-bets-deadmans-switch` (and the paper unit).
