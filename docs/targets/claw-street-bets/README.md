# Claw Street Bets — founding pack

Drafted target-side files for **Claw Street Bets (CSB)**, crucible #2
([ADR-0013 amendment](../../adr/0013-swappable-single-target-builder.md),
founding map [#4313](https://github.com/gaberoo322/hydra/issues/4313), decision
record [#4314](https://github.com/gaberoo322/hydra/issues/4314)). Each file here
is content that is **ready to drop into the CSB repo or config dir on repo
creation** — the map plans, the first post-map session executes. Nothing in
this directory is read by orchestrator code; the orchestrator only ever reads a
target's direction docs through `HYDRA_CONFIG_PATH` after the swap.

| File | Ticket | Where it goes at swap time |
|---|---|---|
| `direction/outcomes.yaml` | [#4319](https://github.com/gaberoo322/hydra/issues/4319) | `HYDRA_CONFIG_PATH/direction/outcomes.yaml` ([swap runbook](../../target-swap-runbook.md) Step 2a) |
| `direction/vision.md` | [#4320](https://github.com/gaberoo322/hydra/issues/4320) (pending) | `HYDRA_CONFIG_PATH/direction/vision.md` |
| `.hydra/manifest.json` + scaffold spec | [#4322](https://github.com/gaberoo322/hydra/issues/4322) (pending) | the CSB repo root |

The CSB swap checklist ([#4326](https://github.com/gaberoo322/hydra/issues/4326),
the map's capstone) consumes this directory.

## `direction/outcomes.yaml`

Same schema and loader as the orchestrator's own
[`config/direction/outcomes.yaml`](../../../config/direction/outcomes.yaml)
(`src/outcomes.ts`). It declares:

- **one terminal outcome** — real-money cumulative P&L net of fees, which
  honestly reads 0 until a strategy graduates (issue #4301's lesson applied
  from day one);
- **five leading paper outcomes** — rolling net Sharpe, net expectancy per
  trade, max drawdown, cumulative settled-trade count, and the
  paper-vs-backtest fill divergence (is the fill model lying?);
- the builder-self `orchestrator-self-improvement-share` outcome, carried
  verbatim so ADR-0003's 25% floor keeps its metric across the swap;
- the **pre-registered graduation gate** as a delimited comment block,
  operator-only-editable by convention. `test/csb-founding-pack-outcomes.test.mts`
  loads the file through the real loader and pins every number in the gate, so
  a PR that moves the bar reddens the required `test` job.

The gate's numbers come from the graduation-bar research ticket
([#4318](https://github.com/gaberoo322/hydra/issues/4318)); they are a DRAFT
until the locking ticket on the map closes, which must happen before the first
Stage-A paper trade is counted.
