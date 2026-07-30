---
date: 2026-07-29
reviewer: claude-architect
focus: general
overall_score: 5.5
previous_score: 6.8 (2026-07-02)
previous_scores: [6.1 (2026-04-30), 6.8 (2026-07-02)]
---

# Hydra Architecture Review — 2026-07-29

## Executive Summary

The last review's headline finding is **resolved**: the primary-path metric is no longer dark. `forecast_outcomes` holds **5,140 resolved rows** spanning 2026-07-09 → 2026-07-29, the producer writes `metrics/forecast-calibration-brier.txt` on a live cadence (last write 21:45 today), and the value it writes — 0.178899 — reproduces exactly when recomputed from the raw table. Issue #1657's producer landed and works. That is real, and it is the biggest capability gain since April.

It also revealed the thing this review exists to say. Recomputing the same 5,140 rows against the market's own prices gives a **market Brier of 0.154747** versus Hydra's **0.178899**. Lower is better. **Hydra's forecaster is 15.6% worse than the consensus it is built to beat** — and because `outcomes.yaml` benchmarks the metric against an absolute constant (`target: 0.18`) rather than against the market, the orchestrator reads this as *goal achieved*. The steering signal turns green at the exact moment the evidence says there is no edge. This is textbook wrong-target measurement: a self-improving system whose evaluator scores the proxy rather than the thing that matters will optimize the proxy, and Hydra now has 5,140 rows of proof that it is doing so.

Underneath that, three live defects were found running, not hypothesized:

1. **`/api/usage` and `/api/usage/eligibility` no longer complete.** Five consecutive probes hung; a 180-second probe never returned. The scan serially `stat`s and fully `readFile`s **34,813 transcript files / 1.38 GB** per cache miss, behind a **60-second** cache TTL — it has crossed its own TTL, so the cache is permanently cold and the endpoint never serves. This is not a slow endpoint; it is an endpoint that has stopped working.
2. **That wedge silently disarms autonomy.** `hydra-pace-gate` reads exactly that endpoint to decide admission, and on unreachability it fails closed: `WARN eligibility endpoint unreachable — failing safe (not launching)`. Six such refusals appear in today's journal. `/api/health` returns 200 OK throughout, so the watchdog is blind. The only reason autopilot is running right now is that the endpoint happened to answer once at 21:12.
3. **Prod is behind master, right now** — deployed `bd0837fe`, `origin/master` at `61ae5822`, two commits adrift, exactly the drift class CLAUDE.md documents.

Meanwhile the machine's dominant output is itself, and compounding. In 30 days: 518 commits, **+118,775 / −43,865 code lines — net +74,910 on a ~208k base, +36% in one month**. 154 `refactor` + 91 `cleanup` = **47% of all commits are self-directed churn**, against 112 `feat`. The test suite is now 128,315 lines against 79,781 source lines (1.6:1, up from 1.45:1) and takes **600 seconds** to run. The learning plane that should be metabolizing all this motion into judgment is nearly empty: `config/feedback/` holds two files, the newest dated 2026-07-07 and one of them a test fixture; `hydra:learning:*` has 5 keys and `hydra:friction:*` has 2, against 568 keys of `hydra:autopilot` dispatch bookkeeping. The `orchestrator-self-improvement-share` outcome reads a literal `0` against a target of `0.25`.

The verdict: the execution engine remains genuinely strong — 6,792/6,794 tests green, zero failed/abandoned/rolled-back cycles in the last 50, enforced Redis and schema seams, six runtime deps, a lean documentation router. But it is now growing 36%/month, spending half its commits on itself, unable to measure what any of it costs, steered by direction docs that assert things the running system contradicts, and reporting success against a benchmark that inverts its own primary goal. The frontier is not more machinery. It is **re-pointing the scoreboard and paying down three live outages** — most of which is one day's work.

## Scorecard

| # | Dimension | Score | Jul 2 | Key Finding |
|---|-----------|-------|-------|-------------|
| 1 | Control Loop Quality | 7 | 8 | 98% window merge rate, 0 failed/abandoned/rolled in 50 cycles — but 6 open PRs (was 0), 3 with no auto-merge at all, 1 conflicted; run accounting reads `merged_count=0, failed_count=0` on **14/14** runs and `total_tokens=0` on 10/14; all 14 runs terminate `handoff`, never clean completion |
| 2 | Research → Action Pipeline | 5 | 6 | Board recovered from starvation (15 `ready-for-agent`, was 5) but **16 of 28 open issues are `bug`** — the pipeline mostly feeds itself repair work; `priorities.md` state verified 2026-07-01 (28d stale) and now factually wrong (claims pregame scanner undeployed — it runs every 15 min; claims `forecast_outcomes` at 0 rows — it holds 5,140); `vision.md` still asserts "no cloud inference APIs" while the paper-LLM runs on Sonnet |
| 3 | Grounding & Verification | 7 | 8 | 6,792/6,794 green, 0 fail, deepest gate stack reviewed — but suite runtime is now **600s** at 1.6:1 test:src, and `/api/alerts` throws in prod (`aggregator threw despite never-throw contract`), so the documented invariant is violated on a live route |
| 4 | Agent Quality | 5 | 6 | Nothing to score improvement from: `config/feedback/` = 2 files (newest 2026-07-07, one a test fixture), `hydra:friction:*` = 2 keys, `hydra:learning:*` = 5 keys. The T1 prompt-shaped lane — cheapest, highest-leverage self-improvement channel — has produced ~nothing in 3 weeks |
| 5 | Autonomy Level | 5 | 8 | The admission gate is **wedged**: `/api/usage/eligibility` hung on 5/5 probes and never returned at 180s; pace-gate fails closed with a WARN; `/api/health` stays 200 so the watchdog is blind. Autonomy currently survives on one lucky 21:12 launch. (Scored on the mechanism, not the operator's deliberate 2.5-day pause.) |
| 6 | Knowledge & Learning | 5 | 5 | Split verdict, nets flat: the Target outcome side went **dark → live** (5,140 rows, producer verified reproducible) — a real win; but the orchestrator-self side still reads literal `0` vs `0.25`, and the now-live metric is **mis-benchmarked**, reading "target met" at 0.1789 while market is 0.1547 |
| 7 | Architecture Fitness | 6 | 8 | Seams, deps (6), and doc router still clean — but **+74,910 net code LOC in 30 days (+36%)**, 47% of commits self-directed, 231 branches, 5 locked worktrees; and the dispatch brain (`scripts/autopilot/decide.py`, **4,192 lines**) classifies **T3**, identical to any leaf in `src/` |
| 8 | Cost Efficiency | 4 | 5 | Worse, not better: the endpoint that computes the budget **no longer completes**; cycle `tokenCost` is internally inconsistent by ~2,000× within one response (208,920,000 alongside 98,997); run `total_tokens=0` on 10/14. No routing or budget decision is currently defensible on this data |

**Overall: 5.5/10** (Jul 2: 6.8 · Apr 30: 6.1)

The 1.3-point drop is dominated by three *live defects* — a wedged usage scan, a fail-closed admission gate, and a mis-benchmarked primary outcome — not by a design regression. Two are same-day fixes. The structural concerns (growth rate, churn share, learning-plane emptiness) are slower, were visible in trend at the last review, and have compounded since.

## Key Findings

### F1 — The primary outcome is benchmarked against a constant, not against the market (critical)

`config/direction/outcomes.yaml` declares:

```yaml
- name: forecast-calibration-brier
  kind: leading
  direction: down
  target: 0.18
  baseline: 0.25   # "the uninformed coin-flip baseline"
```

Measured on the 5,140 resolved rows in `forecast_outcomes`:

| Forecaster | n | Brier | vs market |
|---|---|---|---|
| **Hydra (all sources)** | 5,140 | **0.178899** | **+0.0242 worse** |
| Market (`market_probability`, same rows) | 5,140 | **0.154747** | — |
| `paper_llm_estimate` | 4,367 | 0.1647 | +0.0100 worse |
| `paper_llm` | 773 | 0.2591 | +0.1044 worse |

Two things follow. First, `0.1789 < 0.18` means the orchestrator's own outcome loader reports this leading metric **at target**, and every holdback decision that reads it inherits that verdict — the system believes its primary path is solved. Second, the right baseline was never the coin flip; for a system whose vision is "forecasting more accurately than consensus," the only meaningful baseline is consensus, and against consensus the forecaster is losing on every source split. This independently reproduces the A/B conclusion already in operator memory (neither paper-LLM variant beats market Brier) — but that conclusion was never written back into `outcomes.yaml`, so the steering signal never learned it.

The `paper_llm_estimate` (0.1647, n=4,367) vs `paper_llm` (0.2591, n=773) gap is 0.0944 — larger than either source's gap to market. Most of the loss is concentrated in one pipeline path, which is a far more tractable target than "improve the model."

### F2 — The usage scan has crossed a scaling cliff and wedges the autonomy gate (critical, live)

`src/cost/transcript-scan.ts` walks every transcript, `stat`s it, skips on mtime, then `await readFile(file, "utf-8")` and `content.split("\n")` + `JSON.parse` per line — serially, in one loop. Current working set:

- `/home/gabe/.claude/projects` — 2.7 GB, 39,790 `.jsonl` files
- within the 7-day window — **34,813 files, 1.38 GB** (largest single file 5.8 MB)
- snapshot cache TTL — **60 seconds**

A scan that cannot finish inside its own TTL means the cache is never warm, so every caller triggers a fresh full scan. Measured: `curl /api/usage` returned `000` at 20s, 45s, and **180s**. `/api/health` answers in 0.035s, so the process is fine — this one path is unbounded and now permanently over budget. It is O(all history) and grows daily.

The consequence is not a slow dashboard. `scripts/hydra-pace-gate.sh` reads `/api/usage/eligibility` to decide whether autopilot may launch, and fails closed:

```
21:12:08  eligible (paceState=behind) — launching hydra-autopilot.service
20:56:18  WARN eligibility endpoint unreachable — failing safe (not launching)
20:40:48  WARN eligibility endpoint unreachable — failing safe (not launching)
18:02:45  WARN eligibility endpoint unreachable — failing safe (not launching)
15:23:03  WARN eligibility endpoint unreachable — failing safe (not launching)
14:51:04  WARN eligibility endpoint unreachable — failing safe (not launching)
13:16:54  WARN eligibility endpoint unreachable — failing safe (not launching)
```

Six refusals in one day, ~15% of ticks. Failing safe is the correct instinct for a *quota* gate, but the practical effect here is that **an unbounded local file scan is a single point of failure for all autonomy**, and it announces itself only as a WARN in a unit log. `/api/health` returns 200 throughout; the watchdog checks health, so nothing alarms. When the current run ends, the next launch depends on the scan happening to win a race it now loses.

Contributing but secondary: `[oauth-usage] oauth-usage-rate-limited: 429` appears 7× in 24h with `retryAfterMs: 0`. The OAuth layer has correct AbortSignal timeouts, single-flight, and exponential backoff (`src/cost/oauth-read-cache.ts`), so it is not the hang — but it is a second reason this path is fragile.

### F3 — Prod is behind master, right now

```
deployed (via /api/health):  bd0837fe
origin/master:               61ae5822
drift:                       2 commits
```

`61ae5822` (#3774, alerts routed through the pushAlert seam) and `07a8a783` (#3772, wayfinder orphan exclusion) are merged and not serving. This is the documented `cancel-in-progress` drift class. Per operator memory the watchdog's #734 detector exists but is log-only, so this self-heals only by luck or by hand.

### F4 — `/api/alerts` violates the never-throw contract in production

```
routeLabel: "api/alerts"
err: SyntaxError: Unexpected end of JSON input
     at JSON.parse (dist/api/alerts.js:31:36)
msg: "aggregator threw despite never-throw contract"
```

`GET /api/alerts` returns HTTP 500 with `{"error":"Unexpected end of JSON input"}`. A truncated entry in the stored alert list poisons the whole route via an unguarded `JSON.parse` inside a `.map`. The alerting surface is the wrong thing to have down while three other defects are live. The fix is already written and sitting in open PR **#3773**.

### F5 — Half the merge queue has no auto-merge armed

| PR | mergeable | auto-merge | failing checks |
|---|---|---|---|
| #3777 | **dirty** | none | 1 |
| #3776 | unknown | none | 0 |
| #3775 | unknown | none | 0 |
| #3774 | unknown | enabled | 0 |
| #3773 | blocked | enabled | 1 |
| #3771 | unknown | none | 1 |

All six were created 2026-07-27, then autopilot was paused by the operator for ~2.5 days. This is the documented consequence of a paused autopilot: nothing arms auto-merge at creation time, so **3 of 6 PRs will sit indefinitely** even now that the pause is lifted — including #3776 and #3775, which are clean with zero failing checks. #3777 has drifted into conflict while waiting.

### F6 — The machine's main product is itself, and the rate is accelerating

30 days on `master`:

| Metric | Value |
|---|---|
| Commits | 518 |
| Code churn (`src`/`test`/`scripts`/`dashboard`) | +118,775 / −43,865 = **net +74,910** |
| Docs churn | +9,096 / −3,957 = net +5,139 |
| Current code base | 79,781 src + 128,315 test ≈ 208k |
| **Growth rate** | **≈ +36% / month** |
| `refactor` commits | 154 (30%) |
| `cleanup` commits | 91 (18%) |
| `feat` commits | 112 (22%) |
| `fix` commits | 98 (19%) |

**47% of commits are self-directed churn.** Operator memory records one net-shrink month as a milestone; the trend since is strongly the other way. Two structural costs are already binding: the test suite takes **600 seconds** (it gates every dispatch's verification loop, so it taxes every cycle), and the test:src ratio has risen 1.45 → 1.6:1. Current research is directly relevant — agent test-writing *volume* shows **no statistically significant effect on task resolution rate**, so a growing test corpus is not self-justifying. Hydra already has the right instrument (mutation kill-rate); the count is what's growing.

Against all of this, `orchestrator-self-improvement-share` — the one outcome that would tell you whether any of the churn is paying off — reads a literal `0` (`metrics/orchestrator-share.txt` contains `0`) against a target of `0.25`.

### F7 — The dispatch brain sits outside the tier ladder's attention

`scripts/autopilot/decide.py` is **4,192 lines** of Python holding all dispatch policy — selectors, cooldown enforcement, scope masks, cost-cap gates, the stagger set. `classes.json` beside it is the class-taxonomy alphabet. Verified classification:

```
scripts/autopilot/decide.py      => tier 3  "operator-review change"  matched: null
scripts/autopilot/classes.json   => tier 3  "operator-review change"  matched: null
src/index.ts                     => tier 3  "operator-review change"  matched: null
.github/workflows/ci.yml         => tier 4  Verifier Core
```

The brain, its config, and an arbitrary leaf module all require identical verification depth. There is real test coverage (11 `decide-*.test.mts` files including a golden suite), which is why this is a finding and not an emergency — but a 4,192-line single file that decides what the entire system does next is a blast radius the ladder currently cannot see.

### F8 — Steering documents assert facts the running system contradicts

`priorities.md` (`updated: 2026-07-11`, state verified 2026-07-01, **28 days stale**) tells discovery classes that:

- "Pregame scanner timer is not deployed" — it is `active waiting`, firing every 15 minutes, last run 6 minutes ago
- "`forecast_outcomes` is still at 0 rows" — it holds 5,140 rows and has been accumulating since 2026-07-09
- "work queue is empty (0)... Backlog gap: 21 items to target of 30" — the board now holds 28 open issues, 15 `ready-for-agent`

`vision.md` **Constraints** states: "All LLM inference runs on local Ollama (Tailnet gaming-PC endpoint) — **no cloud inference APIs**." The paper-LLM edge feed runs on subscription Sonnet, and operator memory records the gaming-PC retirement as undeployed-but-superseded. A hard constraint that the system routinely violates is worse than no constraint: it teaches every agent that reads it to discount the constraints section.

## Recommendations

### Quick wins (< 1 day)

**Q1 — Re-benchmark the primary outcome against the market.** *(do this first)*
- **What:** Add a `forecast-vs-market-brier-delta` leading outcome to `config/direction/outcomes.yaml` (`direction: down`, `baseline: +0.0242`, `target: <= 0`) with a producer writing `metrics/forecast-brier-vs-market.txt` from the same query that already produces the absolute Brier. Retire `target: 0.18` on `forecast-calibration-brier` or demote it to diagnostic.
- **Why:** It is the only change in this report that alters what the machine is *trying to do*. Everything else makes a system that is optimizing the wrong quantity do so more reliably.
- **Evidence:** F1 — 0.178899 vs market 0.154747 on n=5,140; current config reports "target met."
- **Risk:** Low mechanically (one producer + one YAML row). Non-trivial in effect: the delta will read red, which will correctly re-open the forecast question (see S2). That is the point.
- **Dependency:** None. The producer, the table, and the loader all already work.

**Q2 — Stop the usage scan from wedging, and stop it from being unbounded.**
- **What:** Two parts. (a) *Mitigation now:* `/api/usage` must never make a caller wait on a cold scan — serve the last-good snapshot with `stale: true` and refresh out of band. (b) *Fix:* make the scan incremental — persist a per-file `(path, mtimeMs, size) → tokens` fold in Redis and re-read only files whose mtime or size changed. Files: `src/cost/transcript-scan.ts`, `src/api/usage.ts`.
- **Why:** A 60s cache in front of a scan that cannot finish in 60s is a cache that never hits. Growth guarantees this gets worse daily.
- **Evidence:** F2 — 34,813 files / 1.38 GB scanned serially; probes returned `000` at 20s, 45s, 180s.
- **Risk:** Low. The incremental fold is a pure memoization of an already-deterministic per-file computation; a missing cache entry degrades to today's behavior for that file only.
- **Dependency:** None. Clearing the current wedge needs an orchestrator restart — **operator call**, since an autopilot run is in flight.

**Q3 — Alarm on the failure this hides.**
- **What:** Add a watchdog check for "no autopilot launch in N hours **while** pace-gate is logging `unreachable`", escalating as an alert rather than a unit-log WARN. Optionally give pace-gate a bounded fail-open (launch on last-known-good eligibility if it is under a staleness cap).
- **Why:** The current failure mode is total autonomy loss that presents as a healthy system. `/api/health` is 200 throughout.
- **Evidence:** F2 — six fail-closed refusals in one day, no alarm raised.
- **Risk:** A bounded fail-open could launch against a stale quota read. Cap the staleness window tightly and keep the emergency brake authoritative.
- **Dependency:** Independent of Q2, and worth doing even after Q2 — this is the class of bug, not the instance.

**Q4 — Land the three loose ends.** Merge #3773 (fixes F4's unguarded `JSON.parse`); arm auto-merge on #3775/#3776 and rebase #3777 (F5); run `bash scripts/deploy.sh` once the current run settles, to clear the 2-commit drift (F3). Risk: low, but do the deploy *after* the wave, not during — it races the queued CI deploy.

**Q5 — Make the steering docs true.** Refresh `priorities.md` against measured state, and either fix or delete `vision.md`'s "no cloud inference APIs" constraint. Evidence: F8. Risk: none. This is the cheapest correctness win available, and every discovery-class dispatch reads these files.

### Medium efforts (1–5 days)

**M1 — Instrument net value, not motion.**
- **What:** Make `orchestrator-self-improvement-share` actually compute instead of writing `0`. Add two companions: `net-code-growth-30d` and `self-directed-commit-share` (`refactor`+`cleanup` ÷ total). Then adopt the two research-recommended trend metrics — **first-attempt success rate** (rising) and **corrections per task** (falling) — derived from the dispatch-outcome stream you already write.
- **Why:** The system's headline number is 98% cycles-merged, which measures whether dispatches complete, not whether capability accrues. This is precisely the "cases closed vs cases resolved" trap the self-improving-agent literature warns about, and F6 shows Hydra is in it: 47% of commits are self-directed and the one metric that would price that reads 0.
- **Evidence:** F6, and `metrics/orchestrator-share.txt` containing a literal `0` against `target: 0.25`.
- **Risk:** Medium — these metrics will read unflattering, and they feed holdback. Introduce them as diagnostic before wiring them to gates.
- **Dependency:** M2, for anything cost-denominated.

**M2 — Repair run-level accounting.**
- **What:** Fix `merged_count` / `failed_count` / `total_tokens` in the autopilot run records, and resolve the `tokenCost` unit inconsistency.
- **Why:** Cost-per-merged-PR is currently unknowable, so no model-routing or budget decision is defensible on evidence.
- **Evidence:** Scorecard row 8 — `merged_count=0, failed_count=0` on **14/14** runs, `total_tokens=0` on 10/14; and one metrics response carrying both `tokenCost: 208920000` and `tokenCost: 98997`, a ~2,000× mismatch within the same array.
- **Risk:** Low — additive instrumentation on an existing stream.
- **Dependency:** None. Note this is the third consecutive review to score Cost Efficiency ≤ 5 for the same reason.

**M3 — Put the verification cost curve under control.**
- **What:** Add change-scoped test selection for the *in-cycle* dev verification loop (impact analysis from the diff), while the **full suite stays the CI merge gate, unchanged**. Keep ratcheting mutation kill-rate; stop treating test count as progress.
- **Why:** 600s × every dispatch × every retry is now a material tax on throughput, and it grows with a corpus that is itself growing 36%/month.
- **Evidence:** F6 — 600s runtime, 128,315 test LOC vs 79,781 src (1.6:1, up from 1.45:1); plus the research finding that agent test-writing volume has no significant effect on resolution rate.
- **Risk:** Real — selection that under-selects lets a regression reach CI. Mitigated by keeping the full suite as the merge gate: selection only shortens the inner loop, it never becomes the gate.
- **Dependency:** None.

**M4 — Bring the dispatch brain into the ladder.**
- **What:** Add `scripts/autopilot/decide.py` and `scripts/autopilot/classes.json` to the tier classifier as T4 (or T3-with-deep-QA). Per operator memory, add it as a *separate* workflow rather than editing `ci.yml`, which is itself exact-match Verifier Core.
- **Why:** 4,192 lines deciding everything the system does next currently require the same verification depth as any leaf module.
- **Evidence:** F7 — verified classification output.
- **Risk:** Raising the tier slows legitimate autopilot-policy iteration. The 11 existing `decide-*` test files plus the golden suite should absorb most of that.
- **Dependency:** Editing the classifier is itself T4 — expect the deep-QA path.

### Strategic shifts (1–2 weeks, operator buy-in)

**S1 — Put a price on self-directed work.**
- **What:** Adopt an explicit net-LOC budget per month, and require every `refactor` / `cleanup` class dispatch to name a measured outcome it moves. Classes that cannot cite one get demoted below feature work in the anchor ordering.
- **Why:** The stated operator preference is maintainability over throughput. +36% LOC/month with 47% self-directed commits is not maintainability — it is throughput pointed inward, and it is the fastest-moving number in this review.
- **Evidence:** F6.
- **Risk:** Genuine cleanup is valuable and some of this growth is the ADR-0002 deletion program doing exactly what it should. A blunt cap could starve real hygiene. Hence: cite an outcome, don't just cap the count.
- **Dependency:** M1, to have anything to cite.

**S2 — Decide the forecast question on the evidence.** *(operator escalation — vision-level, per ADR-0005)*
- **What:** The measured result across 5,140 resolved events is that Hydra's forecaster loses to the market on every source split. `vision.md` names forecast accuracy as the primary path. Either commit to a materially different signal, or re-open the microstructure lane the vision currently forecloses.
- **Why:** This is now a measured finding rather than a hypothesis, and it contradicts the document that steers every research and discovery dispatch. Nothing downstream can be correctly prioritized until it is resolved.
- **Evidence:** F1. **The most actionable detail:** the `paper_llm_estimate` (0.1647, n=4,367) vs `paper_llm` (0.2591, n=773) gap is **0.0944** — larger than either source's gap to market. Most of the loss is concentrated in one pipeline path, not distributed across the model's judgment. That points at a pipeline defect, which is far more tractable than "forecast better," and it should be characterized before any vision change is contemplated.
- **Risk:** High-stakes and irreducibly the operator's call — a vision conflict, exactly the ADR-0005 escalation class. Operator memory records forecast-first as recently reaffirmed; this review does not re-litigate that, it supplies the measurement that was missing when it was reaffirmed.
- **Dependency:** Q1, so the delta is on the scoreboard before the conversation.

**S3 — Ask whether the data plane earns its size.**
- **What:** Audit the aggregator/API surface against the decisions it actually informs. 79,781 lines of `src/` across 26 domains exist to serve a 4,192-line decision loop.
- **Why:** Probing the API during this review, `/api/events`, `/api/heartbeat`, `/api/holdback`, `/api/pattern-memory`, `/api/knowledge/search`, and `/api/autopilot/status` all returned 404; `/api/alerts` returned 500; `/api/reflections` returned 400. Some are documented-retired, which is fine — but the ratio of surface to consumed signal deserves a deliberate look, and `knip` is already wired for exactly this.
- **Evidence:** F6 growth figures; the 404/500/400 sweep above.
- **Risk:** Medium — a demote-only sweep is safe; deleting a seam an agent path still reads is not. Operator memory notes cleanup that removes an export orphans its importers.
- **Dependency:** S1's outcome-citation discipline, so the audit has a criterion beyond "unused."

## Comparison to state of the art

| Dimension | Hydra today | State of the art (2026) | Verdict |
|---|---|---|---|
| Merge outcomes | 98% window merge rate, 0 rolled back / 50 cycles | Devin ~67% PR merge rate; industry 20–50% | **Ahead** on completion — but this measures dispatch completion, not value delivered |
| Improvement measurement | 98% cycles-merged as headline; self-improvement-share reads `0` | Rising first-attempt success rate; falling corrections-per-task; explicit warning against proxy metrics ("cases closed vs cases resolved") | **Behind** — F1 and F6 are the exact documented failure mode |
| Outcome grounding | 5,140 resolved forecasts, reproducible producer, live cadence | Compiler/test/outcome feedback as the self-evolution substrate | **At parity in plumbing**, wrong in benchmark choice |
| Verification stack | Tier ladder + mutation ratchet + scope gate + holdback + deep-QA | Meta ACH-class layered gates, progressive delivery | **At parity in shape**; cost curve (600s) now the binding constraint |
| Test economics | 1.6:1 test:src, 128k test LOC, growing | Volume shows **no significant effect** on resolution rate; dynamic change-scoped selection is standard | **Behind** — growing the count, not the selectivity |
| Self-modification safety | Tier ladder + Verifier Core exact-match paths | Self-referential agents 17% → 53% SWE-Bench under explicit safety + resource constraints | **Ahead** on discipline; gap is the brain sitting at T3 (F7) |
| Knowledge retrieval | OV semantic + ast-grep / comby / probe lanes | RepoGraph / CodexGraph structural-graph RAG (+32.8% relative) | Parity for search; still **no repo-graph lane** — carried forward from July as a scout candidate |

## Next-review triggers

Review again when **any** of these fires:

1. **Q1 lands** — the market-delta outcome goes live and reads red. That changes what the system optimizes; re-score dimensions 2 and 6 immediately after.
2. **Autonomy stalls again** — no autopilot launch for > 6h with pace-gate logging `unreachable`. Signals Q2/Q3 were insufficient.
3. **Net code growth exceeds +50k LOC in a 30-day window**, or self-directed commit share exceeds 50%. Either means S1 is overdue.
4. **Test suite exceeds 900s**, or test:src exceeds 1.8:1. M3 has become urgent.
5. **`forecast-vs-market-brier-delta` crosses ≤ 0** — the forecaster starts beating consensus. That is the trigger for a *positive* review: it unblocks the Graduated Capital ladder and changes every priority downstream.
6. **Routine:** 30 days (2026-08-28), whichever comes first.

## Method note

Every number in this report was measured on the running system on 2026-07-29, not inferred from code or docs. The Brier figures were recomputed directly from Postgres and reproduce `metrics/forecast-calibration-brier.txt` to six decimals, which is what makes the market comparison trustworthy. The endpoint hangs were confirmed across independent probes at 10s, 20s, 45s, and 180s. Where operator memory already recorded a finding (the paper-LLM A/B result, the paused-autopilot merge-queue freeze, the deploy-drift class), this review re-derived it from live state rather than restating it — and where the two diverge, the divergence is itself reported (F8).

## Sources (external research)

- [Toward Self-Improving Agents — Salesforce](https://www.salesforce.com/news/stories/toward-self-improving-agents/) — the wrong-target/proxy-metric failure mode
- [A Survey of Self-Evolving Agents](https://arxiv.org/pdf/2507.21046) — measuring improvement, explicit vs learned judges
- [A Self-Improving Coding Agent](https://arxiv.org/pdf/2504.15228) — 17% → 53% SWE-Bench under safety + resource constraints
- [EvoCodeBench](https://arxiv.org/pdf/2602.10171) — human-performance benchmark for self-evolving coding systems
- [Scaling Test-Time Compute for Agentic Coding](https://www.emergentmind.com/papers/2604.16529) — PDR+RTV rollout aggregation
- [AI-Powered Automated Test Generation](https://zylos.ai/research/2026-03-05-ai-agent-automated-test-generation/) — test-writing volume vs resolution rate
- [How Agentic AI Improves QA and Testing in 2026](https://autify.com/blog/ai-agent-testing) — dynamic change-scoped test selection
