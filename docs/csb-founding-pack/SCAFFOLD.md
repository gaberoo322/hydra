# Claw Street Bets — repo scaffold spec

Founding-pack deliverable for wayfinder map [CSB founding pack](https://github.com/gaberoo322/hydra/issues/4313), ticket [Draft CSB `.hydra/manifest.json` + repo scaffold spec](https://github.com/gaberoo322/hydra/issues/4322). It says what the empty `gaberoo322/claw-street-bets` repo must contain at creation so Hydra can open its first PR against it and CI can judge that PR. It is a **spec for the mechanical repo-creation session**, not code.

Inputs (all closed map tickets): founding grill #4314 (posture, Q12 `appSubdir: ""`), venue #4317, graduation bar #4318, salvage audit #4321, roster #4323, risk template #4341, cost model #4359, vision/priorities #4320, outcomes #4319. The manifest schema is `src/schemas/target-manifest.ts` in the orchestrator (ADR-0026); the swap procedure is `docs/target-swap-runbook.md`.

## 1. Identity

| Item | Value |
|---|---|
| Repo | `gaberoo322/claw-street-bets` (private), default branch `main` |
| `HYDRA_TARGET_NAME` | `claw-street-bets` |
| `HYDRA_PROJECT_WORKSPACE` | `/home/gabe/claw-street-bets` |
| `HYDRA_TARGET_GITHUB_REPO` | `gaberoo322/claw-street-bets` |
| `HYDRA_TARGET_WEB_URL` | `http://localhost:3334` |
| App root | repo root (`appSubdir: ""`) — betting's `web/` nesting caused the worktree / `node_modules` incident family (#4175, #4177) |
| Node | pinned via `.nvmrc` to the orchestrator's exact version (`22.23.1`) plus `engines.node` in `package.json`; a toolchain-pin test mirrors the orchestrator's |
| Stack | TypeScript strict, Next.js (dashboard + API routes), Postgres via Drizzle, systemd user units, vitest |

## 2. `.hydra/manifest.json`

The file is `./.hydra/manifest.json` in this founding pack; it validates against `TargetManifestSchema` (strict: exactly `version`, `verify`, `riskCritical`).

**Verify block.** `npm test` is the real vitest suite, directly. There is no count gate, no sentinel-file indirection, and no `test:raw` split — the salvage audit's do-not-carry #6. `npm run typecheck` is `tsc --noEmit`; `npm run build` is `next build`.

**Risk-critical surface.** Entries match by directory prefix (trailing `/`) or exact path, relative to the repo root; no globs. Each entry is derived from a risk invariant or from the integrity of the gate itself:

| Surface entry | Derived from |
|---|---|
| `src/execution/` | invariant #1 — every entry carries a venue-side stop (bracket order shape, order state machine, live lane, kill switch) |
| `src/risk/` | invariants #2 and #3 — per-trade cap, daily-loss halt, open-risk cap; plus `risk-core.ts`, the Target Verifier Core list |
| `src/monitoring/` | invariant #4 — dead-man's switch (salvaged `timer-deadmans-switch.ts` shape) |
| `src/auth/` | invariant #5 — credential fence (salvaged `operator-auth` / `write-route-guard`) |
| `src/fill-model/` | the one simulator; a change here moves every lane's numbers (fill-model honesty) |
| `src/graduation/` | the stage evaluator that reads the pre-registered gate |
| `src/bin/` | worker entrypoints — the process boundary each systemd unit runs |
| `src/paper/trial-ledger.ts` | append-only trial ledger; k for the multiple-testing floor |
| `config/risk-template.json` | the numbers behind invariants #2/#3 (operator-only) |
| `config/graduation-gate.yaml` | the pre-registered bar (operator-only) |
| `direction/outcomes.yaml` | the orchestrator-facing contract that pins gate + template versions |

`mutationKillFloor: 60` — betting's floor, carried as the starting value; the mutation gate runs over risk-critical files a PR touches.

**Target Verifier Core.** `src/risk/risk-core.ts` mirrors betting's `target-risk-core.ts`: a frozen path list plus a pure `classifyRisk` returning `money-critical | standard`, with a test asserting every listed path exists. The CI scope-check step and the QA money-critical fold read it. Its list is the manifest surface above, kept in sync by a test that loads both.

## 3. Directory layout

```
claw-street-bets/
├── .hydra/manifest.json
├── .github/workflows/{ci.yml, automerge.yml, deploy.yml}
├── .nvmrc  package.json  tsconfig.json  next.config.ts  vitest.config.ts  drizzle.config.ts
├── CONTEXT.md                  domain glossary (seed at creation; full draft is its own map ticket)
├── README.md  docs/adr/
├── direction/                  vision.md, priorities.md, outcomes.yaml (authoritative; swap copies into HYDRA_CONFIG_PATH)
├── config/                     risk-template.json, graduation-gate.yaml, universe-filter.json  (operator-only where noted)
├── drizzle/                    SQL migrations (CI `migrate` job applies on push to main)
├── ops/systemd/                unit files, installed-vs-repo reconciled
├── scripts/                    deploy.sh (flock + health poll + deploy-sha marker), check-nul-bytes, deadcode ratchet
└── src/
    ├── app/                    Next.js: dashboard pages + API routes (/api/health, /api/outcomes, /api/graduation, operator write routes behind the fence)
    ├── bin/                    one entrypoint per systemd unit
    ├── db/                     drizzle schema + client
    ├── market-data/            Coinbase Advanced adapter (WS trades + level2, REST candles), candle store, level2 recorder, universe filter, gap detector
    ├── fill-model/             THE simulator: fees (cost model reader), slippage (level2 book-walk, floor), limit-fill rules, bracket semantics
    ├── backtest/               event-driven engine replaying the candle + level2 store through fill-model
    ├── strategies/             Strategy interface; trend-ema/, meanrev-bbrsi/, breakout-donchian/; controls/ (random-entry fleet, buy-and-hold line)
    ├── paper/                  paper loop, per-strategy bankroll ledgers, trial-ledger.ts, shadow-backtest, outcome writers
    ├── execution/              venue order adapter (bracket shape), order state machine, live lane (interface only at launch), kill switch, stuck-order classifier/remediation (salvaged)
    ├── risk/                   risk-core.ts, risk-template loader, per-trade cap, daily-loss halt (salvaged composition), open-risk cap, consecutive-failure halt (salvaged)
    ├── graduation/             stage evaluator: per-stage floors, SR0(k), control percentile, PSR, MDD, divergence tests
    ├── auth/                   credential fence (salvaged), operator session
    └── monitoring/             timer dead-man's switch (salvaged), alerts
```

Roster slugs are fixed and reused verbatim everywhere (strategy directories, outcome names, metric file paths, trial ledger): `trend-ema`, `meanrev-bbrsi`, `breakout-donchian`.

## 4. One fill model, three clocks

The seam that makes paper evidence mean something (founding grill Q8):

- **`FillModel`** (`src/fill-model/`) is the only code that turns an order plus a market state into a fill: itemised fees from the frozen cost model, slippage from walking the recorded level2 book for the order's notional at signal time plus half-spread, floored at 3 bps/side, limit-fill rules per order type, and bracket semantics (entry, stop, take-profit; the stop leg always fills as taker).
- **`Clock`** is the interface every lane plugs into the same engine: `BacktestClock` replays the candle + level2 store; `PaperClock` follows the live feed with simulated fills; `LiveClock` follows the live feed and routes to the venue. The strategy, risk, and graduation code never know which clock they are on.
- **Live proof** uses `FillModel` as the *expected* fill and records the venue's *actual* fill beside it; the paper phase's divergence is paper-vs-shadow-backtest over the same signal stream. Both are the fill-model-honesty metric the gate reads.
- **Strategy interface** exposes its **risk template** (sizing rule, stop distance, holding-time distribution) and its **entry order type** (maker-attempted vs taker), so a random-entry control fleet inherits the template mechanically and the cost model c is derivable per archetype.
- **Level2 recording is a day-one requirement**: the slippage model cannot be honest without the book at signal time, so the market-data service records top-N levels alongside trades from the first day of paper.

## 5. Data

- **Universe** is `config/universe-filter.json` (min 24h volume, max spread) evaluated on a schedule against the venue product list; never a hardcoded symbol list.
- **Candle store**: Postgres, one `candles` table keyed `(product, bar, open_time)`, bars 1m (source) aggregated to 5m/15m/1h; **level2 snapshots** keyed `(product, ts)` at signal time plus periodic; **trades** streamed. Partition by product and month.
- **Backfill depth**: 24 months of 1m candles per universe product (Coinbase REST serves 350 candles per request with no hard history wall, unlike Kraken's 720), enough for the frozen-parameter backtest sweeps and two 180-day paper stages with a full year of out-of-sample history behind them. Level2 history starts at day one (no venue backfill exists).
- **Gap detector**: a feed gap or stale bar halts every downstream lane (stale data = halt, per the vision constraints).

## 6. Systemd + Postgres

Units are `claw-street-bets-<role>` (the orchestrator derives `${HYDRA_TARGET_NAME}-web.service`), living in `ops/systemd/` and installed by `scripts/deploy.sh`; `EnvironmentFile=%h/claw-street-bets/.env.local`, `WorkingDirectory=%h/claw-street-bets`.

| Unit | Kind | Role |
|---|---|---|
| `claw-street-bets-web.service` | long-running | Next.js dashboard + API on :3334 |
| `claw-street-bets-market-data.service` | long-running | WS trades + level2 + candle aggregation + gap detector |
| `claw-street-bets-paper-loop.service` | long-running | roster on PaperClock; bankroll ledgers; outcome writers |
| `claw-street-bets-deadmans-switch.timer` | every 20 min | salvaged watchdog over the other units; cancels open orders on heartbeat loss in the live lane |
| `claw-street-bets-alerts.timer` | hourly | Telegram alerts (salvaged channel) |
| `github-actions-runner-csb.service` | long-running | self-hosted runner for CI + deploy |

Postgres database `claw_street_bets`, Drizzle migrations in `drizzle/`, applied by the CI `migrate` job on push to `main` with betting's destructive-DDL guard and drift check.

## 7. CI workflow set (mirrors betting's shape)

- **`ci.yml`** — `typecheck-and-test` on `pull_request` and `push: main`, self-hosted, `fetch-depth: 0`, Node from `.nvmrc`: `npm ci` → risk scope-check (advisory, names money-critical diffs) → NUL-byte guard → `typecheck` → `lint` → `npm test` → dead-code ratchet. Plus the `migrate` job (push to `main` only, own non-cancelling concurrency group).
- **`automerge.yml`** — on `workflow_run` of CI success for a `pull_request`, squash-merge unless the PR or a closing issue carries `money-critical` or `hold-for-operator`; fails closed if the label lookup fails; closes linked issues after merge.
- **`deploy.yml`** — on push to `main` after CI: `scripts/deploy.sh` under `flock`, health poll on :3334, deploy-sha marker.
- **Branch protection on `main` from day one**: require the `typecheck-and-test` check. Betting shipped without it, and `--auto` merges bypassed CI as a result.

`package.json` scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `test` (vitest run), `db:generate`, `db:migrate`, `db:migrate:deploy`, `db:check-pending-ddl`, `deadcode:check`, `risk:scope-check`, `check:nul-bytes`.

## 8. Contracts the orchestrator reads

- **`GET /api/outcomes`** returns every metric `direction/outcomes.yaml` declares, keyed by outcome name, `null` where no settled trades exist; the orchestrator's metrics publisher samples it hourly and writes `metrics/csb/<slug>/<metric>.txt` under `HYDRA_ROOT` (the retired target's Brier-producer shape). Unit tests pin the name set against the yaml.
- **`GET /api/health`** for the deploy poll and the wiring-liveness chore.
- **Gate agreement test**: a test loads `config/graduation-gate.yaml` and asserts the numbers in `direction/outcomes.yaml`'s comment block and targets match it, so the human copy cannot drift from the machine copy.
- **Operator-only files** (`config/risk-template.json`, `config/graduation-gate.yaml`, `direction/outcomes.yaml`) are on the risk surface, so any PR touching them is `money-critical` and fenced from auto-merge.

## 9. Salvage plan (from #4321)

Carry, adapting paths and names: dead-man's switch, daily-loss/drawdown fail-closed composition, consecutive-failure halt, credential fence, stuck-order classifier/remediation split, half-Kelly-with-caps sizing (re-parameterised to the risk template: fixed 0.5% risk at stop, not Kelly-derived stake), position derivation, deploy script + workflow, CI `migrate` job, systemd unit shape and reconciliation discipline, CONTEXT.md convention, dead-code ratchet, NUL-byte guard.

Do not carry: any arb machinery, venue ticker fences, series selector, Brier pipeline, sports data providers, the count-gate `npm test`.

Build new: the fill model, the backtester, the strategy interface with risk template, control fleets, the trial ledger, the stage evaluator, level2 recording.

## 10. Repo-creation checklist (input to the capstone)

1. Create the private repo, `main`, Node pin, `package.json` with the scripts above, strict `tsconfig`.
2. Commit `.hydra/manifest.json` (this pack), `direction/` (vision, priorities, outcomes), `config/` (graduation-gate.yaml from this pack; risk-template.json v1 from #4341; universe-filter.json).
3. Commit the three workflows and enable branch protection on `main`.
4. Commit `src/risk/risk-core.ts` with the surface list and its existence test; commit the gate-agreement test and the outcomes-name test (red until the API exists is acceptable only if the suite is green at creation, so stub the endpoint returning `null`s).
5. Install the runner unit; verify a trivial PR runs CI green and auto-merges.
6. Point the orchestrator at the repo per the swap runbook Step 2.
