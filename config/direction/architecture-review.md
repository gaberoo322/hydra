---
date: 2026-07-02
reviewer: claude-architect
focus: general
overall_score: 6.8
previous_score: 6.1 (2026-04-30)
---

# Hydra Architecture Review — 2026-07-02

## Executive Summary

Hydra has crossed the threshold the April review said it hadn't: it now **runs itself**. The scheduler has executed 7,710 cycles with zero consecutive errors; the autopilot fires on timers several times a day and terminates by handoff, not by crash; 98 PRs merged in the last 7 days with **zero open PRs and zero rollbacks**; operator commits are ~9% of target-repo activity. The verification stack (tier ladder, CI-as-merge-gate, mutation kill-rate, scope enforcement, deep-QA on T4, outcome holdback enrollment) is genuinely strong — 0 failed/abandoned/rolled-back cycles in the last 50, and the full suite is green (315 test files, 97.7k test LOC against 67.5k src LOC). OpenViking, dead in April, now returns relevant results.

The machine is healthy. **What it optimizes against is dark.** The vision's primary-path metric — forecast calibration Brier — has *never had a value*: the Target's `/api/calibration/forecast-metrics` returns `totalForecasts: 0`, the Brier producer chore silently declines to write on failure (by design), `metrics/forecast-calibration-brier.txt` does not exist, and every holdback baseline carries `value: null` for it. The outcome-attribution spine (#2628) is built but has nothing terminal to attribute against. Meanwhile the direction docs the discovery classes steer by are internally inconsistent: `vision.md` retired cross-venue arbitrage on 2026-06-22, but `priorities.md` (last refreshed 2026-06-15) and `goals.md` (2026-06-10) still direct work at the retired arb funnel. A world-class execution engine is being steered by stale priorities toward an unmeasured goal. Closing that gap — not more execution machinery — is the entire frontier.

## Scorecard

| # | Dimension | Score | Apr | Key Finding |
|---|-----------|-------|-----|-------------|
| 1 | Control Loop Quality | 8 | 7 | 30/50 cycles merged, 0 failed/rolled; 98 PRs/7d, 0 open; known frictions (cooldown bootstrap #2575, dependency-blind anchors) are papered over, not fixed |
| 2 | Research → Action Pipeline | 6 | 6 | Board nearly drained (5 ready-for-agent, queue depth 0) — throughput is now discovery-limited; priorities.md 17 days stale and contradicts vision.md |
| 3 | Grounding & Verification | 8 | 8 | Deepest gate stack reviewed against SOTA (mutation ratchet ≈ Meta ACH); but QA FAIL can't block auto-merge and seam checks are advisory |
| 4 | Agent Quality | 6 | 6 | Failure modes well-catalogued and alias-consolidated; but rule promotion is promote-then-demote — both recent promoted rules made post-rates 2.2–4.5× *worse* before demotion |
| 5 | Autonomy Level | 8 | 4 | Biggest gain since April: timer-driven unattended 8h runs, scope=all, ~9% operator commit share, $0/$50 daily API spend |
| 6 | Knowledge & Learning | 5 | 5 | OV search fixed and relevant; but the outcome side is dark — Brier never written, attribution ledger empty, reflection outcomes stale since 2026-05-13 |
| 7 | Architecture Fitness | 8 | 7 | 26 domains, 26 ADRs, 5 runtime deps, 1.45:1 test:src, enforced Redis/schema seams, lean CLAUDE.md router — clean and AI-navigable |
| 8 | Cost Efficiency | 5 | 6 | Cannot compute cost/merged-PR at all: cycle `costUsd` empty, run `cumulative_tokens: 0`, usage 100% unattributed; that opacity *is* the finding |

**Overall: 6.8/10** (Apr: 6.1)

## Key Findings

### What's working

1. **Autonomy arrived.** April's #1 gap (scheduler stopped, everything manual) is closed: 7,710 scheduler cycles, timer-fired autopilot runs (1–8 turns, 2–11 dispatches each), handoff-terminated, 2-week unattended run in progress. Operator commits are 10 of 112 (~9%) on the target in 7 days.

2. **The verification ladder is state-of-the-art in shape.** Tier-classified blast radius → CI-as-the-only-merge-gate → mutation kill-rate + scope enforcement → T2+ outcome-holdback enrollment → deep-QA + remediation loop on T4. The published SOTA equivalents (Meta ACH mutation gating, layered gate stacks, progressive-delivery holdbacks) map one-to-one onto machinery Hydra already has. 0 rollbacks in the last 50 cycles; 1.0%-class revert rates sustained since April.

3. **OpenViking is alive.** Search over accumulated knowledge returns relevant, scored results (verified with a live query against the worktree-write-fence cluster). April's "agents operate without any accumulated knowledge" no longer holds.

4. **Codebase health discipline is real.** 26 ADRs, enforced seams (`redis/<domain>` accessors, zod schema boundary, sub-router pattern), three complementary search lanes (ast-grep / comby / probe), dead-code kill-chain (#2720), and a test:src LOC ratio of 1.45:1. The repo is optimized for AI navigation, which is the correct optimization for this system.

5. **Issue-synthesis pipeline is ahead of published practice.** External research found no published equivalent of the hydra-prd research-finding → epic + dependency-ordered tracer-issues pipeline; the field's discovery→work-item tooling is thinner than Hydra's.

### What's not working

1. **The terminal learning signal has never existed.** `totalForecasts: 0, brierScore: null` from the Target — the LLM edge-estimate headwater has no systemd unit, so `paper_llm_edge_estimates` has 0 rows ever, so no forecast ever resolves, so the Brier chore (which "never writes on failure") has never written its file. Downstream: holdback leading-metric `forecast-calibration-brier: value null` in every baseline; outcome-attribution spine (#2628 — estimator/recorder/subscribe/windows all built) has an empty ledger; vision.md's own vector 1 says an unread calibration metric "is itself a finding to research" — and no mechanism surfaces it. The silence is invisible by design: fail-quiet producer + no liveness alarm on `null` leading outcomes.

2. **Direction docs steer at a retired strategy.** `priorities.md` (2026-06-15) still names the WC pair-registry seeding and arb funnel as priorities 1–3; `goals.md` (2026-06-10) still frames the phase as "cross-venue arbitrage... first real-money dual-leg runs." Both predate ADR-0002's arb retirement (2026-06-22) and the M13 pivot. Discovery/research classes that read these files inherit the contradiction; the operator has been catching it via session memory instead.

3. **Learning promotion is uncalibrated.** The `rule-actions` log shows the only two recent promoted planner rules were demoted for making post-promotion failure rates 2.2× and 4.5× **worse**. Promote-then-observe-then-demote is the inverted form of the DGM/ExpeRepair lesson (empirically validate *before* adopting a self-modification). The promptfoo eval lane (`npm run eval`, golden tasks) exists but isn't wired into promotion. Meanwhile the legacy reflection loop is confirmed severed (reflection outcomes zset last entry 2026-05-13; consumers report `reflectionMatchSource: 'none'` — #1119).

4. **The system cannot state its own cost.** Cycle metrics carry no `costUsd`; autopilot runs record `cumulative_tokens: 0`; usage attribution is 100% unattributed (SessionStart hook can't fire for Agent-tool dispatches; approved fix 99ef93a0 unimplemented). Model routing decisions (Haiku for cleanup, Sonnet escalation, subagent token caps) are therefore made on anecdote. SOTA reports 41–80% cost reductions from cache-stable prompting and cascade routing — none of it is verifiable here without measurement.

5. **Observability of the loop itself is decaying.** The architect's own quantitative base is rotting: `testsAfter` always 0 in cycle metrics, 34% of anchors classified `unknown`/`unclassified`, `hydra research history` endpoint 404 (retired without a successor metric for research→queue conversion). The system that measures the Target's drift does not measure its own instrumentation drift.

6. **Discovery is now the bottleneck — and it's self-referential.** With 0 open PRs, queue depth 0, and 5 ready-for-agent issues, execution capacity exceeds discovery output. Discovery classes propose what agents *notice*, not what moves an outcome — which is exactly the gap #2628 exists to close, but see finding 1: attribution needs a live terminal signal first.

## Recommendations

### Quick wins (< 1 day)

**1. Alarm on dark leading outcomes** ⭐ keystone quick-win
- **What**: Extend `src/scheduler/chores/wiring-liveness.ts` (or add a sibling chore): if any `kind: leading` outcome in `outcomes.yaml` has resolved to `null`/missing-file for > N days, emit a health event and file/refresh a `needs-triage` issue. Include producer identity (`forecast-calibration-brier` chore) in the payload.
- **Why**: Vision vector 1 explicitly declares an unread calibration metric a finding; today the fail-quiet producer makes 10 months of silence invisible. This converts the system's biggest blind spot into an autopilot-visible signal permanently.
- **Evidence**: `metrics/forecast-calibration-brier.txt` missing; every `hydra:holdback:baseline:*` carries `value: null`; producer logs `console.error` into journal noise nobody reads.
- **Risk**: None — additive, advisory. **Dependency**: none.

**2. Refresh the direction docs to post-ADR-0002 reality**
- **What**: Dispatch `research_target` (or hand-edit) to regenerate `config/direction/priorities.md` and update `goals.md`'s Current Phase to M13 Forecast-Directional Execution; strip the arb-funnel priorities 1–3 and the "dual-leg real-money" framing.
- **Why**: Every discovery/research class reads these files; they currently steer at a strategy the vision retired 10 days ago. Session memory is compensating — that knowledge should live in the files.
- **Evidence**: `priorities.md` header `updated: 2026-06-15`; `goals.md` 2026-06-10; vision.md arb retirement 2026-06-22.
- **Risk**: Low. **Dependency**: none.

**3. Repair cycle-metrics recording**
- **What**: Fix `testsAfter` (always 0), populate `costUsd`/token fields where obtainable, and close the 34% `unknown`/`unclassified` anchorType hole (likely a missing mapping after the autopilot class taxonomy replaced legacy anchor types).
- **Why**: Trend analysis (including this review) is degrading; merge-rate and cost-per-merge are the SOTA fitness metrics and both are currently uncomputable.
- **Evidence**: 50-cycle sample: tests 0→0, costs empty, 17/50 anchors unclassified.
- **Risk**: Low. **Dependency**: none.

### Medium efforts (1–5 days)

**4. Light the forecast headwater end-to-end** ⭐ highest-leverage item in the system
- **What**: Target-side: install/enable the systemd unit for the paper LLM edge-estimate runner (the missing headwater), verify `paper_llm_edge_estimates` rows flow → directional timer consumes → `forecast_outcomes` resolves → `/api/calibration/forecast-metrics` returns a real Brier → orchestrator chore writes `metrics/forecast-calibration-brier.txt` → holdback baselines carry real values. Add a row-count liveness probe at each of the 3 stages (the pipeline has failed silently at each before).
- **Why**: This single chain activates: the vision's primary metric, holdback's second leading outcome, and #2628's terminal attribution signal. Everything downstream of "make discovery goal-seeking" is blocked on it. The ongoing qwen-vs-Sonnet A/B (interim: local model incoherent) also needs settlement-time Brier to conclude.
- **Evidence**: `totalForecasts: 0`; memory-confirmed 3-stage gap with headwater unit absent; brier producer verified fail-quiet.
- **Risk**: Medium — local-Ollama-only constraint means forecast quality may be poor (interim A/B suggests so); but a *measured* bad Brier is infinitely more useful than no Brier. **Dependency**: none (pairs with #1 so future regressions self-report).

**5. Implement in-transcript usage attribution (approved design 99ef93a0)**
- **What**: Attribute subagent token usage per dispatch class from transcripts; surface cost/merged-PR and tokens/class/day on the dashboard; backfill `cumulative_tokens` in run hashes.
- **Why**: Enables the two decisions currently made blind: model-tier routing per class, and research-vs-build budget split. SOTA cascade/caching wins (41–80%) are unverifiable without a baseline.
- **Evidence**: 100% unattributed usage; `cumulative_tokens: 0` on every run.
- **Risk**: Low. **Dependency**: none.

**6. Cascade routing with the deterministic verifier as escalation trigger**
- **What**: For mechanical classes (cleanup_orch dev work, doc-only dev), dispatch the cheap tier first and auto-escalate to the standard tier when CI goes red or the agent exits without a PR (the Haiku-premature-exit signature). Encode as dispatch policy in decide.py, not per-skill prose.
- **Why**: Published result: cascades beat routers when a cheap deterministic verifier exists — Hydra has tests/tsc/CI free. Current experience (Haiku cleanup no-ops) failed because there was no escalate-on-fail wiring, not because tiering is wrong.
- **Evidence**: RouteLLM/FrugalGPT numbers (85% cost cut at 95% quality); cleanup_orch Haiku memory.
- **Risk**: Medium — wasted cheap attempts on hard tasks; bounded by escalation. **Dependency**: #5 (to measure whether it pays).

### Strategic shifts (1–2 weeks)

**7. Finish the Outcome Attribution Spine (#2628) as the system's fitness function**
- **What**: Complete ledger population (merge → per-metric attribution windows → ridge marginal-effect estimates) and feed the estimates back into discovery-class prompts and decide.py prioritization weights, replacing "what agents notice" with "what moved outcomes."
- **Why**: External research confirms merge→outcome-delta credit assignment is the field's acknowledged open gap — no published system closes it; Hydra's design has no precedent to copy and is the durable differentiator for the swappable-builder end-goal (ADR-0013). DGM's 20%→50% SWE-bench gain came precisely from empirically gating self-modifications on measured fitness.
- **Evidence**: `src/outcome-attribution/` built, ledger empty; discovery now the bottleneck (finding 6).
- **Risk**: Estimator quality on sparse data; the dark-tolerant design already accounts for it. **Dependency**: #4 (a live terminal signal) and #1 (dark-signal alarms).

**8. Validate-before-promote for learned rules (ablation-gated memory)**
- **What**: Before a pattern-memory rule promotes into a feedback file, run the candidate rule through the promptfoo golden-task eval lane (`evals/`, `npm run eval`) as an A/B: prompt-with-rule vs prompt-without. Promote only on non-regression. Keep the existing demotion machinery as the backstop, not the primary control.
- **Why**: Both recent promotions degraded post-rates (2.2×, 4.5×) before demotion caught them — live traffic is currently the eval set. ExpeRepair/ReasoningBank/DGM all show memory pays only with curation and empirical gating; SWE-Bench-CL now measures exactly this forward-transfer property.
- **Evidence**: `hydra:learning:rule-actions` demotion log; existing but unwired eval lane.
- **Risk**: Eval-set representativeness; start advisory (log the verdict) before making it blocking. **Dependency**: none technically; benefits from #3's metric hygiene.

## Comparison to State of the Art

| Dimension | Hydra today | State of the art (2025–26) | Verdict |
|-----------|-------------|---------------------------|---------|
| Merge outcomes | 98 PRs/7d merged, 0 open, 0 rollbacks/50 cycles | Devin: 67% PR merge rate; industry 20–50% | **Ahead** (self-verified via CI gate) |
| Verification stack | Tier ladder + mutation ratchet + scope gate + holdback + deep-QA | Meta ACH (73% test acceptance), layered gates, canary/progressive delivery | **At parity in shape**; holdback half-dark in signal |
| Knowledge retrieval | OV semantic + ast-grep/comby/probe lanes | RepoGraph/CodexGraph structural-graph RAG (+32.8% relative) | Parity for search; **no repo-graph lane** — possible future scout |
| Self-improvement | Pattern memory + promote/demote + retro caps | DGM/ExpeRepair: ablation-validated memory; ACE delta-updates | **Behind**: promote-then-demote inverts the SOTA gate |
| Outcome attribution | #2628 built, ledger dark | Acknowledged open gap field-wide | **Ahead in design, unshipped in practice** |
| Issue synthesis | hydra-prd epic + tracer-issue pipeline | Mostly bespoke; Spec Kit spec→plan→tasks | **Ahead** |
| Autonomy | Timer-driven unattended 8h runs, ~9% operator share | Long-running harness patterns (init/progress-file/subagent summaries) | **At parity or ahead** |
| Cost | Unmeasured (subscription, 0-attribution) | Cascades 60–85% savings; caching 41–80%; Agentless $0.34/issue floor | **Behind on measurement**, unknowable on efficiency |

## Next Review Triggers

Re-run this assessment when any of:
1. `forecast-calibration-brier.txt` exists with a real value (headwater lit) — re-score dimensions 2, 6.
2. #2628 ledger has ≥30 attributed merges — evaluate whether discovery prioritization actually shifted.
3. Usage attribution ships — first real cost/merged-PR number.
4. 60+ days of unattended operation, or the 2-week unattended run ends — audit operator-intervention log.
5. The Target swap (ADR-0013) is seriously proposed — this review's Target-coupling findings (Brier chore hardcodes the betting API shape) become blocking.
6. Rule-promotion eval gating ships — re-score dimension 4.
