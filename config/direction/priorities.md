---
updated: 2026-07-31
refreshedBy: claude-research
researchCycle: research-target-2026-07-31f
tags: [hydra, hydra/direction]
---
> **This cycle was a re-prioritization + premise-check pass, not a filing pass** (operator framing: the board already held 31–32 `ready-for-agent` items — above the 30-item target — so the job was to re-rank what exists and retire what's already shipped or already-decided, not add volume). No new issues were filed. Consistent with `vision.md` and ADR-0002 (M13 Forecast-Directional Execution active; cross-venue arbitrage retired 2026-06-22). KXBTC and KXMLB are both live series lanes — neither is narrowed to the other. KXNBA stays off-scope until October 2026 (calendar-blind rule, unaffected by today's date).

# Current state

Board health is good: **31 `ready-for-agent`**, 1 `in-progress`, 1 `blocked`, 0 `needs-triage`, 6 `ready-for-human` (verified via `gh api` against `gaberoo322/hydra-betting`, 2026-07-31). No backlog-padding needed this cycle.

**Six of cycle e's (2026-07-26) top-7 priorities already shipped in the five days since** — the prior `priorities.md` was correctly ranked at the time but is now stale on status, not on judgment:
- #720 + #722 (risk-preflight + sport-cluster/per-event exposure guard into `kalshi-executor.ts`) — **DONE**, commit `540630bf`, via PR #783.
- #724 (authenticate settings-mutation routes) — **DONE**, commit `4c105a46` (#768).
- #725 (authenticate Telegram webhook) — **DONE**, commit `c664d87b` (#763).
- #734 (stale Polymarket fee constants) — **DONE**, commit `ba0621ba`.
- #736 (settlement-verification SLA for directional orders) — **DONE**, commit `f3f18044`.
- #730 (unused `@polymarket/clob-client` v1 dep) — **DONE**, commit `a54a91c6`.

Only **#723** (orphaned circuit breaker) survives from cycle e's numbered list as still open — carried forward below.

**Two "operator actions needed" money-critical decisions from every prior cycle since c/d are now resolved.** `direction/priorities.md` had carried `#659`/`#662` as pending-operator-decision for multiple cycles; both have since been explicitly ruled on directly on the issues (`#659` decided 2026-07-26/29, `#662` decided 2026-07-29, both confirmed `ready-for-agent` + `money-critical` as of today) with narrow, fail-closed, agent-safe scopes written into the issue bodies by the operator. **These are promoted into the numbered priority list below** (they no longer belong in "operator actions needed" — the decision step is done; only the build step remains). Note the operator-specified **build sequencing: #662 first, #659 second** — #659's own body states it reuses #662's refusal shape on the same two routes and is deliberately gated behind it to avoid two agents editing the same surface concurrently.

**New headline finding this cycle (found while premise-checking, not new research): `#743` — hydra-betting has no deploy path.** This is not theoretical: PR #742 (commit `8d2e15c7`) fixed money-critical issue #718 (settlement payoff scaling), merged to `origin/main`, but the *running* service was still several commits behind and still displaying the pre-fix, wrong P&L. Every safety fix listed as "DONE" above landed on `origin/main` — whether any of them are actually serving traffic depends entirely on `#743` being fixed. This makes `#743` the highest-leverage single item on the board: it's not just one bug, it silently discounts the verification value of every other merge until closed. Promoted to **Priority 1**.

**Also surfaced: `#784`**, a direct, money-critical follow-on to the just-shipped `#720`/`#722` Kalshi exposure-preflight fix — the equivalent Polymarket gate (`resolveSingleMarketExposurePreflight` in `polymarket-executor.ts`) is wired to a field (`singleMarketExposureCap`) that no production caller ever populates, so it's a no-op, and the exposure figure it *would* receive is the wrong one (account-wide instead of per-market). Same cluster, same urgency as the Kalshi fix that just landed — promoted to **Priority 2**.

**Confirmed still valid and unaddressed: `#747`** — the pregame scanner (KXMLB's dedicated signal path) has never persisted a single row: 672 consecutive 15-minute runs, 100% `no-pinnacle-match` against 91 ready Pinnacle anchors, every run reporting `status: "success"`. This is a silent, fully-masked forecast-pipeline failure on the KXMLB lane specifically — distinct from KXBTC's paper-edge-feed pipeline, which is producing estimates. Promoted to **Priority 5** (below the two sequenced money-critical items, above the KXBTC anchor work).

**Reviewed and left at general-backlog priority (no change):** `#776` (a hypothetical, not-yet-observed non-binary-event edge case in the Kalshi↔Pinnacle matcher, found by adversarial post-merge QA — real but unconfirmed in production, unlike `#747`'s 672-run confirmed failure) and the seven `cleanup(target)` dead-export demotions (`#711`–`#717`, mechanical and independent of each other, not duplicates).

**Stale carryover cleared:** the previous cycle's "Operator actions needed" list (`#727` CFTC NPRM awareness, `#649` KXBTC nomination confirmation, `#647` migration-0079 status) are **all closed** — verified via `gh api`, dropped from this doc rather than carried forward again.

**Possible stale monitors — flagged for the sweep, not independently verified this cycle:** `#574`/`#575` ask to confirm MLB probable-starter/standings LLM-prompt context (PRs #555/#558, deployed 2026-07-18) actually appears in KXMLB prompts post the WC→KXMLB series transition (~July 21). Ten days have elapsed with no comment. Given `#747`'s finding that the KXMLB pregame-scanner path has never resolved a single Pinnacle link, it's plausible these monitors can't be positively verified through that path at all — worth a sweep pass to either confirm (via the paper-edge-feed runner, if KXMLB still routes through it) or explicitly note the block-on-#747 dependency rather than leaving them open indefinitely.

Per operator preference: selection quality over backlog volume, sports edge over everything else.

# Verified external venue state (carried forward from cycle e, 2026-07-26 — unchanged this cycle)

- **Kalshi KXBTC**: Live. Paper-edge-feed pipeline producing estimates. No independent fair-value anchor yet (`#726`, Priority 6).
- **Kalshi KXMLB**: Live (MLB season through ~late September). Signal-injection modules (injury/weather/probable-starter/standings) are wired in code, but the dedicated pregame-scanner delivery path has never produced output (`#747`, Priority 5) — treat KXMLB forecast-pipeline health as unconfirmed, not healthy, until `#747` is fixed. Settlement-source risk relative to MLB's Polymarket exclusivity deal is assessed and classified LOW — see [`docs/agents/kxmlb-settlement-source-risk.md`](../docs/agents/kxmlb-settlement-source-risk.md) (`#834`); no incremental sizing shift recommended.
- **Kalshi KXNBA**: Off-season. Do not propose before October 2026.
- **WC 2026**: Concluded (`#626` tracks WC-module wire-or-retire).
- **Brier trend**: accumulating via 2x/day sync.

# Priority tasks

Priority 1 is the single highest-leverage item (it gates confidence in everything else that's merged). Priorities 2–4 are money-critical execution-safety gaps, sequenced per the operator's own dependency note. Priority 5 is a confirmed silent forecast-pipeline failure. Priority 6 is the carried-forward KXBTC forecast anchor. Priority 7 is the carried-forward orphaned circuit breaker.

## 1. Fix the hydra-betting deploy path — merged fixes are not reaching the running service (protect-the-operation)
Issue: [#743](https://github.com/gaberoo322/hydra-betting/issues/743) (ready-for-agent). No `deploy.yml`, no deploy timer; `hydra-betting-web.service` builds from whatever the local `~/hydra-betting` working tree happens to be checked out at. Confirmed live: money-critical fix #718 (PR #742, commit `8d2e15c7`) was on `origin/main` while the running service — several commits behind, build dated before even the local HEAD — still served the pre-fix, wrong P&L.
- **Why now**: every "DONE" item in this doc (and every future merge) is unverified as *serving* until this is fixed. Highest-leverage single item on the board.
- **Done when**: see issue; a merge-to-main flow deterministically updates the running service without manual pull/restart, and this is proven against a real merge, not just a design review.

## 2. Wire the equivalent Polymarket single-market exposure gate — inert and fed the wrong quantity (protect-the-operation / improve-execution-discipline)
Issue: [#784](https://github.com/gaberoo322/hydra-betting/issues/784) (ready-for-agent, money-critical). `polymarket-executor.ts` guards `resolveSingleMarketExposurePreflight` behind a `singleMarketExposureCap` field that no production call site ever populates (always false, gate never runs), and where it would fire, it passes account-wide exposure instead of per-market exposure. Found while wiring the Kalshi-side fix (#720/PR #783) that just landed.
- **Why now**: same cluster, same urgency as the Kalshi exposure-preflight fix that shipped five days ago — Polymarket has the identical zero-effective-gating gap today.
- **Done when**: see issue; `npm run typecheck && npm test` (and `npm run test:raw`) green.

## 3. Wire a real, restart-durable operator kill switch into the live-submit routes (protect-the-operation)
Issue: [#662](https://github.com/gaberoo322/hydra-betting/issues/662) (ready-for-agent, money-critical). Operator-ruled scope (2026-07-29): the kill switch is display-only today — no live-submit route imports it — and two additional defects were confirmed during the ruling: it fails **open** on a service restart (the doc comment claims the opposite), and its `process.env` mutation is per-worker, not durable. **Build this first** — #659 is sequenced behind it.
- **Why now**: this is the literal control the operator's own CFTC-contingency runbook instructs pulling in a crisis, and today it does nothing.
- **Done when**: see issue and the 2026-07-29/30 operator-ruling comments (specification of record).

## 4. Wire the daily-loss / drawdown halt into the live-submit path (protect-the-operation)
Issue: [#659](https://github.com/gaberoo322/hydra-betting/issues/659) (ready-for-agent, money-critical). Operator-ruled scope (2026-07-26): wire the existing, tested `evaluateDailyLossLimit`/`evaluateDrawdownLimit` evaluators into the human-approved live-submit path as fail-closed refusals. Explicitly **do not** rebuild the deleted M14 machine-approval chain — that remains operator-gated, non-autonomous work.
- **Why now**: no execution path today halts on a loss or drawdown breach; the evaluators are pure and tested but wired to nothing.
- **Done when**: see issue and its 2026-07-26 operator-review comment (specification of record). Sequenced after #662 — reuse its refusal shape on the same guard surface, don't re-derive it.

## 5. Fix the pregame scanner matcher — KXMLB's dedicated signal path has never produced a row (sharpen-forecasts / close-the-learning-loop)
Issue: [#747](https://github.com/gaberoo322/hydra-betting/issues/747) (ready-for-agent). 672 consecutive 15-minute runs, 100% `no-pinnacle-match` against 91 ready Pinnacle anchors and 80 live markets per run — every run reports `status: "success"`, masking a total, silent matcher failure since at least 2026-07-22.
- **Why now**: this is the entire forecast-signal path for KXMLB (one of the two live series); it has produced zero learning-loop signal for at least 9 days while reporting green.
- **Done when**: see issue; a resolved-link count > 0 is observed on a live run, and at least one `forecast_outcomes` row with `source: "scanner"` is confirmed post-fix.

## 6. Give KXBTC an independent spot/vol-derived fair-value anchor (sharpen-forecasts / deepen-structural-understanding)
Issue: [#726](https://github.com/gaberoo322/hydra-betting/issues/726) (ready-for-agent). Unchanged from cycle e — KXBTC's only forecast source remains an ungrounded LLM prior; Kalshi settles against CF Benchmarks' BRTI, a well-defined spot feed a digital-option model could anchor against.
- **Why now**: KXBTC is a currently-live paper-edge-feed series with no independent reference price at all, unlike KXMLB's Pinnacle anchor.
- **Done when**: see issue. Design-leaning — consider a design-concept pass if scope is ambiguous to the implementer.

## 7. Fix the orphaned rolling realized-slippage circuit breaker (protect-the-operation / close-the-learning-loop)
Issue: [#723](https://github.com/gaberoo322/hydra-betting/issues/723) (ready-for-agent). Unchanged from cycle e — doc comments still claim live enforcement via `executeArbitrage`, deleted under ADR-0002; the breaker is display-only.
- **Why now**: lowest-urgency item of the protect-the-operation cluster this cycle, but still a live doc/behavior mismatch that could lead someone to assume a gate exists that doesn't.
- **Done when**: see issue.

# What's been completed (DO NOT re-propose)

All prior "What's been completed" through cycle e (2026-07-26) carried forward, plus since then (from git log, verified 2026-07-31):
- Wire per-market + per-event exposure preflight into the Kalshi executor (#720, #722, commit `540630bf`, PR #783) — DONE.
- Authenticate money-critical settings POST routes behind an operator credential (#724, commit `4c105a46`, #768) — DONE.
- Verify Telegram secret-token before any Kalshi/Telegram work (#725, commit `c664d87b`, #763) — DONE.
- Correct stale Polymarket sports fee constants to July 2026 schedule (#734, commit `ba0621ba`) — DONE.
- Give directional single-leg orders a settlement-verification SLA lens (#736, commit `f3f18044`) — DONE.
- Remove unused `@polymarket/clob-client` v1 runtime dependency (#730, commit `a54a91c6`) — DONE.
- Plumb the operator credential through the settings page via an HttpOnly session cookie (#769, commit `ef6c4561`) — DONE.
- Collapse live-submit ticker fences into named constants (#751/#777, commit `edc57281`) — DONE.
- Classify provider quota refusals as run-level failures in the paper-edge feed (commit `167640ff`) — DONE.
- Retry + isolate Kalshi series discovery so one non-200 no longer zeroes a paper-edge run (commit `21713c92`) — DONE.
- Wire live KXMLB game-winner discovery for the Polymarket MLB paper-edge feed (commit `306250ed`) — DONE.
- Wire KXMLBGAME team identity (yes_sub_title + city forms) (commit `5c4322b8`) — DONE.
- Cut the dead `runArbitrageScanner` branch from run-cycle (commit `b965f776`) — DONE; may help unblock #622 scoping.
- Scale settlement payoff by contracts held in realized P&L, closing money-critical #718 (commit `8d2e15c7`, PR #742) — DONE on `origin/main` (see #743 re: whether it's *serving*).
- Series-selector slices 4–9 (publication table, round-robin evaluation order, feed alarms, reason-class alarm, eligible-set staleness signal, exploration success-exit) — commits `b5279479`/`6918106f`/`551cd6c9`/`f30e28c4`/`eb208555`, plus #757 open as slice 9 — an active, healthy in-flight epic; do not re-propose any shipped slice.
- Regenerate wiring-status ledger, drift-free (#572, commit `31261355`) — DONE.
- All prior "What's been completed" from 2026-07-26 cycle e carried forward.

# What NOT to work on

All exclusions from cycle e carried forward (arbitrage strategy revival, ADR-0002 step-4 bulk delete before scoping, machine-execution promotion beyond the two narrowly-scoped operator rulings above, M7–M12 re-proposals, sportsbook wager execution, pair-registry/WC-knockout work, KXNBA before October, Hyperliquid monitor, cloud LLM inference, raising the $5/leg cap). Additionally this cycle:
- Do NOT re-propose #720/#722/#724/#725/#730/#734/#736 — all shipped, listed above.
- Do NOT re-open the #659/#662 scope question — both are operator-decided; the only remaining work is the build, per the sequencing note (#662 then #659).
- Do NOT treat #743 as "just" an ops nit — it is the P1 this cycle precisely because it invalidates confidence in every other merge.
- Do NOT pad the backlog — this cycle filed zero new issues by design; re-ranking and status correction was the full scope of the pass.

# Operator actions needed

- None carried forward — all three prior open items (#727 CFTC NPRM awareness, #649 KXBTC-nomination confirmation, #647 migration-0079 status) are confirmed **closed** as of 2026-07-31 and are dropped from this doc.
- Nothing new requires operator judgment this cycle; the two items that did (#659, #662) already have their operator rulings on-issue.
