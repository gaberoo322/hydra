---
updated: 2026-07-01
refreshedBy: claude-research
researchCycle: research-target-2026-07-01b
tags: [hydra, hydra/direction]
---
# Current state
Hydra is sports-first, executing the M13 (Forecast-Directional Execution) program. Tests are green (6820 passing, 3 skipped — verified baseline 2026-07-01b). Active backlog is 9 items (all cleanup); work queue is empty (0). Backlog gap: 21 items to target of 30.

**M13 deployment is live but producing zero nominations.** The directional nomination runner (`hydra-betting-directional-nomination.timer`) fires hourly at `:25` and has run successfully every hour. However, every run reports `candidatesConsidered: 0` and `note: "no forecast-divergence candidates surfaced"`. Root cause confirmed 2026-07-01: the `loadKalshiPaperTradeCandidates` freshness window is **15 minutes** (`KALSHI_LIVE_SUBMIT_MAX_ESTIMATE_AGE_MS`), but the paper-edge-feed runner frequently takes **14–28 minutes** to complete — and on some hours **fails entirely** (exit 143 / timeout, or exit 1 / LLM parse error). The nomination timer fires at `:25`, finding estimates from the prior hour's feed run (45+ minutes old), which are beyond the 15-minute freshness window. The timing design assumed a sub-7-minute feed run; actual Ollama inference time over the gaming-PC Tailnet routinely exceeds that.

**Paper LLM edge estimates are accumulating (324 rows total, 25 with edge ≥ 3% in past 7 days).** The headwater is working; the freshness-window mismatch is the integration gap. High-edge estimates exist (postFeeEdge up to 0.51 on WC QF/SF fixtures), but they are evaluated-at timestamps that fall outside the 15-minute candidate-loader window by the time the nomination runner fires.

**Pregame scanner timer is not deployed.** `web/ops/systemd/hydra-betting-pregame-scanner.{service,timer}` files are committed (PR #369), but `systemctl --user is-enabled hydra-betting-pregame-scanner.timer` returns `not-found`. No `forecast_outcomes` rows with `source: "scanner"` have been recorded.

**`forecast_outcomes` is still at 0 rows.** The daily `hydra-betting-forecast-outcomes.timer` ran July 1 03:00 PDT: scanned 2 venue_orders (old arbitrage rows from June 21), recorded 0, skipped 2. The 2 rows are not directional paper orders — they predated M13, so no Brier signal has accumulated. The calibration loop has nothing to score.

**ADR-0002 step 3 tail still open (verified 2026-07-01).** Multiple imports from `@/lib/arbitrage/` remain in `lib/execution/` production modules: `run-packet.ts`, `execution-error-taxonomy.ts`, `kalshi-rfq-route-quality.ts`, `scanner-provider-degradations.ts`; also in `app/api/` (history route, execute route, run-packet route, scheduled route). These must be relocated before step 4 deletes the strategy surface.

**Stale arbitrage timers confirmed stopped.** `hydra-betting-arbitrage-auto-approval.timer` and `hydra-betting-automated-pair-review.timer` are both `inactive` — operator action complete.

**Item-543 still open.** `web/src/lib/env/readiness.ts` still exports `requiredEnvVar: "OPENAI_API_KEY"` at lines 30, 37, 63, 107.

Per operator preference: selection quality over backlog volume, sports edge over everything else. Do not pad the backlog.

# Verified external venue state (2026-07-01)
All prior state carried forward, plus:
- **WC 2026 Quarter-Finals** — underway. QF fixtures live on Kalshi (`KXWCGAME-26JUL05*`, `KXWCGAME-26JUL06*`). Semi-finals July 8–9; Final July 13.
- **Paper-edge-feed reliability**: ~60% of daily runs succeed in 2–4 min; ~20% timeout (SIGTERM exit 143 after 10-minute timeout); ~10% fail with LLM parse error (exit 1). The 18-market batch cap (PR #375) and `reasoning_effort: low` fix (PR #385) improved but didn't fully eliminate the tail.
- **Directional nomination runner timing**: designed for `:00` feed → `:07` nomination, deployed as `:00` feed → `:25` nomination. At `:25` the feed has been done for 21+ minutes on fast runs; or in slow-run hours it is still running and `:25` finds stale prior-hour estimates. Either way, the 15-minute freshness gate fails.
- **ADR-0002 step 4 surface**: 54 non-CONTEXT files remain in `lib/arbitrage/` (including test files); ~25 are strategy surface scheduled for deletion. Multiple `app/api/` routes still import from `lib/arbitrage/`.
- **Stale arbitrage timers**: `arbitrage-auto-approval.timer` and `automated-pair-review.timer` — confirmed `inactive` (operator stopped them). ADR-0002 Step 1 tail complete.

# Priority tasks

M13 is the active program. Priority 1 fixes the nomination-runner timing gap so paper candidates are actually persisted. Priority 2 deploys the pregame scanner. Priority 3 closes the ADR-0002 step 3 tail. Priority 4 deletes the step 4 strategy surface. Priorities 5–6 close bounded open items. Priority 7 closes the calibration proof loop.

## 1. Fix directional nomination runner: align timer cadence with paper-edge-feed completion window (sharpen-forecasts / close-the-learning-loop)
The nomination runner fires at `:25` past the hour; the paper-edge-feed starts at `:00`. When the feed takes >7 min (common: typical 3–27 min, some runs time out), estimates are stale or absent by `:25`. The 15-minute freshness window (`KALSHI_LIVE_SUBMIT_MAX_ESTIMATE_AGE_MS`) then gates out all candidates — producing the `candidatesConsidered: 0` result observed on every hourly run since deploy.

Fix: move the nomination timer from `:25` to `:45` — gives the feed a 45-minute window, covering all observed successful run durations (longest observed success: 27 min on July 1). No code change; only the `.timer` file needs updating. Update `web/ops/systemd/hydra-betting-directional-nomination.timer` from `OnCalendar=*-*-* *:25:00` to `OnCalendar=*-*-* *:45:00`, commit, and deploy the updated unit file.
- **Why now**: The nomination runner has been live since PR #368 but has produced `candidatesConsidered: 0` every single run (verified 2026-07-01). WC QF matches are live now; each hour without a nomination is a missed paper sample. The calibration learning loop cannot accumulate Brier signal until at least one `venue_orders` row with `source: "directional"` exists.
- **Done when**: `web/ops/systemd/hydra-betting-directional-nomination.timer` has `OnCalendar=*-*-* *:45:00`; updated unit deployed; next `:45` run logs `candidatesConsidered > 0` or `executedCount > 0` for at least one WC QF fixture with postFeeEdge ≥ 0.03; OR if still 0, the exact reason from the candidate-loader is logged (not the short-circuit "no forecast-divergence candidates surfaced").

## 2. Deploy pregame scanner timer to production (sharpen-forecasts / close-the-learning-loop)
`web/ops/systemd/hydra-betting-pregame-scanner.{service,timer}` were committed in PR #369 but `hydra-betting-pregame-scanner.timer` is not installed (confirmed `not-found` in `systemctl --user is-enabled`). The bin runner (`web/src/bin/pregame-scanner-runner.ts`) is built and tested. No `forecast_outcomes` rows with `source: "scanner"` exist.
- **Why now**: WC QF fixtures are live; pre-game dislocations against Pinnacle fair values are the primary forecast signal for the calibration loop. Without the timer, `forecast_outcomes` never accumulates `source: "scanner"` rows.
- **Done when**: `hydra-betting-pregame-scanner.timer` appears in `systemctl --user list-timers`; at least one successful service run; at least one row in `forecast_outcomes` with `source: "scanner"` confirmed via DB.

## 3. ADR-0002 Step 3 tail — relocate remaining arbitrage files imported by lib/execution/ and app/api/ (protect-the-operation / improve-execution-discipline)
Multiple `@/lib/arbitrage/` imports remain in production code (verified 2026-07-01):
- `lib/execution/run-packet-replay-score.ts` → imports `ArbitrageRunPacket` from `@/lib/arbitrage/run-packet`
- `lib/execution/run-packet-replay-batch-score.ts` → imports `loadArbitrageRunPacket` from `@/lib/arbitrage/run-packet`
- `lib/execution/kalshi-bundle-decomposition.ts` → imports from `@/lib/arbitrage/kalshi-rfq-route-quality`
- `lib/execution/execute-arbitrage.ts` → imports `classifyExecutionError` from `@/lib/arbitrage/execution-error-taxonomy`
- `lib/execution/execution-error-category-summary.ts` → imports from `@/lib/arbitrage/execution-error-taxonomy`
- `lib/execution/scan-history.ts` → imports from `@/lib/arbitrage/scanner` and `@/lib/arbitrage/scanner-provider-degradations`
- `lib/execution/polymarket-negative-risk-paper-batch.ts` → imports from `@/lib/arbitrage/scanner`
- `app/api/arbitrage/history/route.ts` → imports from `@/lib/arbitrage/run-packet`
- `app/api/arbitrage/execute/pair-verification.ts` → imports from `@/lib/arbitrage/verified-pairs`
- `app/api/arbitrage/execute/live-submit-preview-draft.ts` → imports from `@/lib/arbitrage/route-scoring`
- `app/api/arbitrage/execute/route.ts` → imports from `@/lib/arbitrage/verified-pairs`
- `app/api/arbitrage/run-packet/[runId]/route.ts` → imports from `@/lib/arbitrage/run-packet`
- `app/api/scheduled/prediction-market-cycle/route.ts` → imports from `@/lib/arbitrage/nomination-source`

Relocate `run-packet.ts`, `execution-error-taxonomy.ts`, `kalshi-rfq-route-quality.ts`, `scanner-provider-degradations.ts` to `lib/execution/`. For `scanner.ts` type imports (`PolymarketNegativeRiskBundle`, `ScanGateRejections`), extract only the needed types into `lib/execution/`. Update all import paths.
- **Why now**: Step 4 (bulk delete of the strategy surface) cannot proceed safely while these files are still in `lib/arbitrage/` — the delete would break execution and API modules. Step 3 completion unblocks the full codebase cleanup.
- **Done when**: No `lib/execution/*.ts` or `app/api/*.ts` file imports from `@/lib/arbitrage/` (except CONTEXT.md prose); `npm run typecheck && npm test` green.

## 4. ADR-0002 Step 4 — delete the strategy surface from `lib/arbitrage/` and retire scanner/arbitrage app routes (protect-the-operation)
With step 3 complete (priority 3), the remaining ~25 strategy files in `lib/arbitrage/` are no longer imported by live code. Delete them and their test files. Retire `app/api/arbitrage/` routes (`/run-packet/`, `/history/`, `/execute/`); retire remaining scanner routes (`/api/scanner/complete-set-candidates`, `/disagreement-candidates`, `/half-life-history`, `/sports-pair-eligibility`, `/threshold-replay`). Survey and delete arbitrage-era bin runners that import from the deleted surface (`arbitrage-scanner-runner.ts`, `arbitrage-replay-runner.ts`, `arbitrage-auto-approval-runner.ts`, `kalshi-rfq-liquidity-runner.ts`, `polymarket-us-sports-pair-seed-runner.ts`).
- **Why now**: The strategy surface spans ~54 files (including tests) and carries dead code across ~24% of the codebase. Clearing it shrinks the blast radius for all future changes and removes the import confusion that muddies module boundaries.
- **Done when**: `lib/arbitrage/` contains only `CONTEXT.md` (or is deleted); arbitrage app routes return 410 or are removed; bin runners that only exercised the deleted surface are deleted; `npm run typecheck && npm test` green.

## 5. Rename `requiredEnvVar` from `OPENAI_API_KEY` to `HYDRA_PAPER_LLM_API_BASE_URL` in readiness.ts (item-543) (protect-the-operation / close-the-learning-loop)
`web/src/lib/env/readiness.ts` still exports `requiredEnvVar: "OPENAI_API_KEY"` at lines 30, 37, 63, 107. The actual runtime gate checks `HYDRA_PAPER_LLM_API_BASE_URL`. Every `/api/status` and `/api/calibration` diagnostic call surfaces the wrong signal.
- **Why now**: Two-file fix, bounded scope. Confirmed still open 2026-07-01. Misleads operator diagnostics daily.
- **Done when**: `readiness.ts` exports `requiredEnvVar: "HYDRA_PAPER_LLM_API_BASE_URL"`; all existing tests pass; `/api/calibration` no longer shows `OPENAI_API_KEY` in the readiness shape.

## 6. Confirm `forecast_outcomes` rows appear after first successful directional paper run (close-the-learning-loop / sharpen-forecasts)
Once priority 1 produces a `venue_orders` row with `source: "directional"` and the WC match settles, the daily `hydra-betting-forecast-outcomes.timer` (runs 03:00 PDT) should sync it to `forecast_outcomes`. Verify this happens and that `brierScore` becomes non-null on the calibration dashboard.
- **Why now**: The calibration learning loop has no Brier signal (0 rows in `forecast_outcomes`, confirmed 2026-07-01). WC QF matches settle within 90 minutes of kickoff — the first paper run from priority 1 can produce a scannable outcome within hours. If the sync still returns 0 after a settled match, `sync-forecast-outcomes.ts` resolution logic needs investigation.
- **Done when**: `forecast_outcomes` row count > 0 confirmed via DB; calibration dashboard shows non-null `brierScore`; OR if still 0 after a settled match, root cause identified and remediation filed.

## 7. Paper-edge-feed reliability: further reduce failure rate after PR #392 isolation fix (close-the-learning-loop / sharpen-forecasts)
PR #392 isolated per-market LLM failures (added client-side `AbortSignal.timeout`, isolated per-market errors so one failure no longer aborts the batch). This should eliminate the exit-143 whole-batch kill and reduce the ~30% hourly failure rate significantly. Whether the fix is sufficient requires monitoring over a 24-hour window (first post-fix cadence starts 2026-07-02 00:00 PDT).

If failure rate remains above ~10% after PR #392: investigate whether (a) the 120-second per-request timeout is still too long for the Ollama model load latency from idle (gaming PC wakeup), (b) markets that always time out should be gated out of the batch, or (c) the nomination timer offset (priority 1) is still not wide enough after per-market isolation changed the per-batch completion time distribution.
- **Why now**: Each failed feed run is one hour without nomination candidates. Even partial per-market failures now degrade candidate coverage without aborting the batch.
- **Done when**: Over any 24-hour window, fewer than 10% of paper-edge-feed timer runs log zero recommendations; the nomination runner (priority 1) sees `candidatesConsidered > 0` at least once per hour in that window.

# What's been completed (DO NOT re-propose)
All M7, M8, M9, M10, M11, M12 items — full list in prior cycles. Additionally since 2026-06-27 research cycle:
- Isolate per-market LLM failures + client-side request timeout in paper-edge feed (PR #392). DONE — addresses priority 7.
- Surface DirectionalPaperExitCriteria verdict on markets/calibration dashboard (item-702, PR #390). DONE.
- Wire evaluateOllamaForecastLift into GET /api/calibration/ollama-forecast-lift (item-701, PR #389). DONE.
- Add Polymarket directional nomination path — extend executeDirectionalSingleLeg (item-706, PR #388). DONE.
- Extend WC pre-game grouper to R32/QF/SF/Final rounds (item-708, PR #387). DONE.
- Fix calibration: name yes-side outcome in buildLlmProbabilityPrompt (PR #386). DONE.
- Fix calibration: use reasoning_effort:low / disable reasoning / tolerate trailing prose (PRs #383/#384/#385). DONE.
- Add scheduled paper LLM edge-feed unit — M13 forecast-pipeline headwater (item-718, PR #373). DONE.
- Surface per-source Brier calibration panel on dashboard (item-707, PR #381). DONE.
- Warm cold Ollama before paper-edge-feed batch (PR #380, closes #2600). DONE.
- Fix Kalshi: drop malformed series fee-change rows instead of crashing (closes #720, PR #382). DONE.
- Directional paper-nomination replay scorer M13 (PR #379). DONE.
- Retire dead Kalshi runtime schema exports, Polymarket provider exports, dead nav exports (PRs #371/#372/#374). DONE.
- Cap paper-edge-feed batch to 18 markets + bump TimeoutStartSec to 1800 (PR #375, closes #2595). DONE.
- Retire dead exports (PRs #376/#377/#378). DONE.
- Deploy directional nomination runner + scheduled cadence M13 step-5 keystone (PR #368). DONE — cadence mismatch means 0 nominations (priority 1 fixes this).
- Deploy pre-game directional scanner as scheduled bin runner epic #2394 slice 5 (PR #369). DONE — unit not installed in production (priority 2 fixes this).
- ADR-0002 Step 1 tail: stale arbitrage timers stopped (operator action). DONE.
- All prior "What's been completed" from 2026-06-27 cycle carried forward.

# What NOT to work on
- Do NOT propose new module wiring into the scanner/arbitrage strategy surface — it is being deleted per ADR-0002 step 4.
- Do NOT promote machine-execution gates to live — auto-execution dispatcher stays default-off until paper-stage exit criteria are evaluated and M14 evidence gate is satisfied.
- Do NOT re-propose any M7, M8, M9, M10, or M11 items — all shipped.
- Do NOT propose sportsbook wager execution — explicitly tests-only by design.
- Do NOT re-propose scanner funnel breakdown, pair registry seeding, WC knockout pair discovery pipeline — in DELETE surface (ADR-0002 step 4).
- Do NOT pad the backlog. Selection quality over throughput.
- Do NOT re-propose: per-source Brier panel (DONE), paper-edge-feed deploy (DONE), directional nomination runner deploy (DONE — cadence fix in priority 1), pregame scanner bin runner (DONE — deploy in priority 2), disagreement oracle wiring (DONE), paper exit criteria (DONE), portfolio-IA slices (DONE), pre-game scanner lib slices 1–4 (DONE), fill-symmetry relocation (DONE), WC R16 ticker discovery (DONE), Brier trend chart (DONE), per-market-type dislocation panel (DONE), directional-single-leg-execute slices 1–4 (DONE).
- Do not re-propose the Hyperliquid HIP-4 monitor — secondary domain.
- Do not propose cloud LLM fallback — local Ollama only (vision constraint).
- Do not propose raising the $5/leg envelope cap or machine-authorship — operator-gated, not autonomous.

# Operator actions needed
- **Priority 1 deploy**: After updating `hydra-betting-directional-nomination.timer` to `:45`, run `cp web/ops/systemd/hydra-betting-directional-nomination.timer ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user restart hydra-betting-directional-nomination.timer`.
- **Priority 2 deploy**: `cp web/ops/systemd/hydra-betting-pregame-scanner.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now hydra-betting-pregame-scanner.timer`.
- **DB migration drift**: `web/drizzle/` has 77 local migration files but only 76 are applied in the running DB (confirmed via `/api/health/full` `migrationDrift: "local=77 applied=76"`). Run `cd ~/hydra-betting && npm run db:migrate` to apply the pending migration.
