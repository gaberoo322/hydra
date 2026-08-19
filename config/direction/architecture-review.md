---
date: 2026-08-19
reviewer: claude-architect
focus: general (control loop, outcome instrumentation, cost)
overall_score: 4.1
---

# Hydra Architecture Review — 2026-08-19

## Executive summary

Hydra's mechanical loop is healthy and its engineering discipline is real: 98% merge
rate over the last 50 cycles, zero regressions, zero rollbacks, strong seam hygiene
(typed Redis adapters, zod schemas, sub-routers, a 39-ADR roster with a test-enforced
format). The machine runs.

What it is running *on* is the problem. Three findings dominate, and they compound:

1. **The loop is feeding on its own exhaust.** 61 of the last 94 merged orchestrator
   PRs (65%) are repairs to Hydra's own test/CI/autopilot machinery. In the same
   7-day window every *producer* class — `research_orch`, `discover_orch`,
   `architecture_orch`, `scout_orch`, `retro_orch`, `cleanup_orch`, `wayfinder_orch`,
   `tickets_orch` — logged **zero** dispatches. The only live classes were `dev_orch`
   (14), `design_concept_orch` (29) and `qa_orch` (1). The channel that sources work
   from outside the system is dark, so the system sources work from its own failures.

2. **The instruments that would have caught #1 read zero.** `/api/builder-health`
   returns `selfImprovementShare: 0`, `autonomyRate: 0/0`, `timeToMerge: null`
   (0 samples), `mutationKillRateTrend: []` — while 99 commits landed in 7 days. Worse,
   it reports **`floorMet: true`** against a 0.25 floor on a share of 0, because the
   window is empty. The single dial designed to detect "the builder is not compounding"
   renders green when it has no data at all. Vector 6 of the orchestrator vision
   ("Green cycles ≠ working orchestrator") is unmet by its own instrument.

3. **Capacity, not ideas, is the binding constraint — and it just stopped the system.**
   Weekly quota is at 92% consumed with a 115% projection; `weeklyEmergencyStop` is
   armed and autopilot is **paused** as of this review. That capacity bought ~48
   orchestrator merges and ~1 Target merge — roughly **1.9% of the weekly quota per
   merged PR**, spent almost entirely on machinery repair. `hydra-autopilot` itself —
   the decision loop, on Opus — consumed **1.61B tokens (~17% of the entire weekly
   quota) before a line of code was written**.

The Target, whose adversarial success metric is the entire justification for the
builder, received **1 commit in the last 7 days**. Its calibration metric
(`forecast-calibration-brier`) sits at 0.24773 against a 0.25 baseline — a 0.00227
move against a 0.005 noise floor, i.e. **flat**. `vision.md` states that sustained
flatness here "is itself a finding to research, not background noise." No research
class has run in 7 days.

The operator has already diagnosed part of this: `limits.scope` was reverted to `all`
today after the orch-only pin backfired (Target 176→1 merges). What is missing is the
*automatic* brake — and it is missing because the metric that would drive it is dead.

## Scorecard

| # | Dimension | Score | Evidence |
|---|-----------|-------|----------|
| 1 | Control Loop Quality | 5/10 | 98% merge rate (50-cycle window), 26% lifetime. But 65% of merged PRs are self-repair. 14,349 lines of autopilot shell/python (`decide.py` alone is 5,300). |
| 2 | Research → Action Pipeline | 3/10 | All 8 producer classes at 0 dispatches/7d. Board holds 28 open issues. #4115 exists *because* `discover_orch` went dark 3+ weeks. |
| 3 | Grounding & Verification | 5/10 | 0 regressions, 0 rollbacks, CI is a real gate. But the suite-count saga ran 8+ PRs over ~6 days and ended in "withdraw — the premise was wrong" (#4157). `mutationKillRateTrend` is empty. |
| 4 | Agent Quality | 5/10 | `dev_orch` 13/14 merged (92.9%). But the flagship promoted lesson `acceptance-criterion-unmet` measured preRate 2.71 → postRate 2.74 (**ratio 1.01**) over 65 days / 178 hits — a null result. `scope-creep` (305x) still in the prompt with `lastSeen 2026-05-14`. |
| 5 | Autonomy Level | 4/10 | Autopilot **paused** by weekly quota stop. `autonomyRate` reads 0/0. ~40 recurring operator workarounds documented in operator memory (reap by bare hex hash, null the stale `.pid`, DEL the orphaned cycle-lock…). |
| 6 | Knowledge & Learning | 3/10 | 1 retro artifact, dated 2026-06-13 (67 days stale). `config/feedback/` newest file 2026-07-07. `retro_orch` 0 dispatches. `reflection-health` verdict: `all-none-empty-store`. Semantic search retired (ADR-0033) with no replacement. Pattern-memory capture itself is genuinely good — it is the write-back that is dark. |
| 7 | Architecture Fitness | 5/10 | 371 src files / 79k LOC / 434 test files. Top two churn files over 30d are ratchet baselines: `suite-count-baseline.json` (24 edits), `skill-size-baseline.json` (23). The governing layer has outgrown the thing it governs. |
| 8 | Cost Efficiency | 3/10 | ~1.9% of weekly quota per merged PR. `dev_orch` scoreboard verdict is literally `"expensive"` (405M weighted quota/merge). Haiku = 0.01% of all tokens; no routing tier below Sonnet in practice. Projected weekly 115%. |

**Overall: 4.1/10** — a well-built machine pointed mostly at itself, with its
self-observation instruments returning false green.

## Key findings

### F1 — The capacity-floor recorder is dead, and it takes two systems down with it
`/api/capacity` shows `last20` as **100% `side: "idle"`**, newest entry 2026-08-11,
while 94 PRs merged. `orchestrator-share.txt` therefore reads `0` — not because the
share is zero but because nothing is recording. Consequences:
- `orchestrator-self-improvement-share`, one of only **two** declared outcomes, is
  structurally dead.
- `/api/attribution` returns `beta: 0, belowNoiseFloor: true` for every producer class
  across **181 observations** — the attribution regression runs and learns nothing.
- `builder-health.floorMet` renders `true` on an empty window (see F2).

`scripts/autopilot/dispatch.sh:14` carries a comment predicting exactly this failure
("without this, the orchestrator-share reads as 0% and the capacity-floor…"). The
prediction came true and nothing alarmed.

### F2 — `floorMet: true` on zero data is a false green on the one dial that matters
`{share: 0, floor: 0.25, window: 0, orchestratorCount: 0, floorMet: true}`. Vacuous
truth on an empty window is rendered identically to a genuinely satisfied floor. This
is the precise failure mode vision.md vector 6 was written to prevent.

### F3 — `outcomes.yaml` declares no terminal outcome at all
Both declared outcomes are `kind: leading`. Profit — the Target vision's stated
terminal goal — is measured nowhere the orchestrator reads. Current state of the art
is explicit that a self-improving deployment needs at least one metric the agent
**cannot directly optimize** inside its own loop, as an early-warning channel. Hydra
has zero such metrics: one of its two is dead, and the other is flat and unwatched.

### F4 — The system measured its own learning loop as ineffective and did nothing
`/api/learning/ineffective-rules` is a genuinely sophisticated piece of engineering —
it computes pre/post promotion rates per rule and flags the failures. It reports the
flagship rule at rateRatio **1.01** after 65 days, and a 3-month-stale rule still
sitting in the planner prompt. Nothing consumes this endpoint. The measurement exists;
the feedback edge does not.

### F5 — The verification machinery is the largest single generator of its own work
The suite-count gate cluster: #4020 → #4056 → #4062 → #4133 → #4137 → #4141 → #4152 →
#4157, ~6 days, terminating in "withdraw — the premise was wrong." One intermediate
step (#4133) was found to be burning 484 runner-minutes re-running the entire suite a
second time on every PR purely to obtain a blocking exit code — against `ci.yml`'s own
498. The root cause (`--test-force-exit` truncating the reporter stream) is
**unfixable while that flag is on**, and CLAUDE.md now documents this. Three
successive gates were built around a reporting artifact.

### F6 — Cost structure is inverted: the decision loop outweighs the work
| Skill | 7d tokens | Share |
|---|---|---|
| `hydra-dev` (Sonnet) | 5.20B | 53% |
| **`hydra-autopilot` (Opus)** | **1.61B** | **17%** |
| interactive | 0.71B | 7% |
| `hydra-grill` | 0.44B | 5% |
| `hydra-qa` | ~0.47B | 5% |
| `hydra-sweep` | 0.24B | 2% |

Deciding what to do costs a sixth of total capacity. Published routing results put
75–85% cost reduction at ~95% of frontier quality when only 14–26% of calls reach the
strong model; Hydra sends effectively 100% to Sonnet-or-above.

## Recommendations

### Quick wins (< 1 day)

**Q1 — Make `floorMet` unmeasurable-aware.**
*What:* When `window === 0`, emit `floorMet: null` / `state: "unmeasured"`; render grey,
never green. *Why:* the only dial for vector 6 currently reports success on no data.
*Evidence:* `{share: 0, floor: 0.25, window: 0, floorMet: true}` with 99 commits in 7d.
*Files:* `src/api/builder-health.ts`, `src/capacity-floor.ts`. *Risk:* low, observability
only. *Dependency:* none.

**Q2 — Repair the capacity-floor recorder.**
*What:* Find why `recordCycleSide` classifies every cycle `idle`; restore
orchestrator/target classification. *Why:* it silently kills one of two outcomes, the
attribution regression, and Q1's data source. *Evidence:* `/api/capacity` `last20` all
`idle`, newest 2026-08-11, vs 94 merged PRs; `/api/attribution` beta=0 across 181 obs.
*Files:* `src/notification/cycle-completed-reactor.ts`, `src/notification-consumer.ts`,
`scripts/autopilot/dispatch.sh`. *Risk:* low. *Dependency:* none — **unblocks Q1, M1, S2.**

**Q3 — Consume `ineffective-rules` instead of merely computing it.**
*What:* Auto-demote promoted rules with `rateRatio >= 0.95` and `daysSincePromotion > 30`;
drop rules whose `lastSeen` exceeds 60 days. At minimum, surface both in the digest.
*Why:* the system already proved its own learning loop is inert and ignored the proof.
*Evidence:* `acceptance-criterion-unmet` ratio 1.01 (2.71→2.74) over 65d/178 hits;
`scope-creep` 305x, `lastSeen 2026-05-14`. *Files:* `src/pattern-memory/demotion.ts`,
`src/pattern-memory/rule-effectiveness.ts`. *Risk:* low (T1/T2, prompt-shaped).

### Medium efforts (1–5 days)

**M1 — Declare a terminal outcome the builder cannot optimize.**
*What:* Add a `kind: terminal` outcome (paper P&L, or realized Brier vs market) sourced
from the Target's existing calibration dashboard. Keep it read-only to the loop.
*Why:* `outcomes.yaml` has zero terminal outcomes; the terminal goal is unmeasured, and
the surviving leading metric is flat inside its noise band with nothing responding.
*Evidence:* both outcomes `kind: leading`; brier 0.24773 vs baseline 0.25,
`noise_epsilon: 0.005`; 0 research dispatches in 7d. *Files:*
`config/direction/outcomes.yaml`, `src/outcomes.ts`. *Risk:* medium — it changes what
the loop optimizes for, which is the intent. *Dependency:* Q2 for the attribution path.

**M2 — Give producer classes a dispatch floor, not just a staleness ceiling.**
*What:* Generalize #4115's `discover_orch` 7-day staleness floor: any producer class dark
> N days outranks any dev anchor in `decide.py` selection. *Why:* the loop has no live
channel to the outside world and is consuming self-generated work. *Evidence:* 8 producer
classes at 0 dispatches/7d; `dev_orch` + `design_concept_orch` = 43 of 44 dispatches.
*Files:* `scripts/autopilot/decide.py`. *Risk:* medium — reduces raw merge count, which is
the correct trade under the operator's maintainability-first ranking.

**M3 — Stop paying Opus prices to decide.**
*What:* Move `collect-state.sh` summarization and `decide.py`'s deterministic state
assembly off the model entirely (both are already shell/python); demote routine
"nothing changed" autopilot ticks to Haiku and reserve Opus for genuine anchor
selection under contention. *Why:* the control plane costs ~17% of weekly capacity before
any work happens, and quota is the binding constraint that just halted the system.
*Evidence:* `hydra-autopilot` 1.61B Opus tokens/7d; Haiku 0.01% of all tokens;
`dev_orch` verdict `"expensive"` at 405M weighted quota/merge. *Files:*
`scripts/autopilot/collect-state.sh`, `scripts/autopilot/decide.py`,
`config/autopilot/classes.json`. *Risk:* medium — needs an eval (promptfoo,
`evals/`) against the decide.py golden suite to confirm no selection-quality drop.

### Strategic shifts (1–2 weeks, operator buy-in)

**S1 — Budget the verification machinery's share of its own output.**
*What:* Declare an explicit ceiling — **no more than 20% of merged PRs in a rolling
30-day window may touch only test/CI/ratchet infrastructure** — measure it in
`builder-health`, and de-prioritize in `decide.py` once breached. Retire ratchets that
require manual baseline regeneration in favour of self-updating ones or none.
*Why:* meta-work is the single largest consumer of the loop and it is self-sustaining:
each gate added to police the system becomes a new source of PRs.
*Evidence:* 61/94 merged PRs self-referential; top-2 churn files over 30d are ratchet
baselines (24 and 23 edits); the suite-count cluster spent 8+ PRs and 484 wasted runner-
minutes to reach "the premise was wrong." *Risk:* **high** — deliberately slows the
loop and will reduce the headline merge rate. That is the trade the operator's own
stated #1 value (maintainability over throughput) asks for, but it should be an explicit
decision, not a silent one.

**S2 — Put a ceiling on the 25% self-improvement floor.**
*What:* Once Q2 restores measurement, enforce a hard ceiling (~40%) on orchestrator-side
capacity in `decide.py` anchor selection, symmetric with the existing 25% floor.
*Why:* the vision reserves 25% as a floor with no ceiling; observed is ~99% over 7 days
and ~65% over 30. The operator already reverted `limits.scope` to `all` today after the
orch-only pin drove Target merges 176→1 — the diagnosis is shared, the automatic brake is
what is missing. *Evidence:* 99 orch vs 1 Target commit (7d); 222 vs 121 (30d).
*Risk:* high. *Dependency:* **strictly downstream of Q2** — enforcing a ceiling on a dead
metric would be worse than no ceiling.

## Comparison to state of the art

- **Where Hydra leads.** Tiered blast-radius verification with a protected Verifier Core,
  outcome-holdback auto-revert, and typed seam enforcement are ahead of what OpenHands or
  SWE-Agent ship. The pattern-memory *capture* layer — friction cues, alias consolidation,
  measured rule effectiveness — is genuinely novel; most published systems do not measure
  whether their learned rules work at all. Hydra does, and that is how F4 was findable.
- **Where Hydra lags.** (a) *Model routing*: none below Sonnet, against a documented
  75–85% cost reduction at ~95% quality from routed traffic. (b) *Un-optimizable metrics*:
  current guidance is that every self-improving deployment needs at least one metric the
  agent cannot touch inside its loop; Hydra has zero live ones. (c) *Meta-work discipline*:
  the reported failure mode of "$4,000 of frontier tokens in a weekend and merge nothing"
  is the same family as Hydra's suite-count cluster — cost and loop-safety controls that
  bound self-inflicted work. (d) *Rework ratio as a first-class metric*: the standing
  advice is to track churn rate, defect escape rate, and rework ratio together, and treat
  velocity rising while quality flattens as debt accumulation — Hydra's `reworkRate`
  reads 0 because it is unwired, not because rework is absent.

## Next-review triggers

- `orchestrator-share.txt` still reading 0 seven days after Q2 ships.
- `forecast-calibration-brier` remaining inside its noise band (±0.005) for another 14 days.
- Any producer class dark for > 14 consecutive days.
- Self-referential share of merged PRs exceeding 70% over a rolling 30 days.
- Weekly quota projection above 100% for two consecutive weeks.
- `builder-health.autonomyRate` still reporting 0/0 after Q2.

## Sources

- [When AI builds itself — Anthropic](https://www.anthropic.com/institute/recursive-self-improvement)
- [A Survey of Self-Evolving Agents](https://arxiv.org/pdf/2507.21046)
- [Self-Improving AI Agents: The 2026 Guide](https://o-mega.ai/articles/self-improving-ai-agents-the-2026-guide)
- [Best AI Gateway for OpenHands and SWE-Agent Autonomous Workflows in 2026](https://futureagi.com/blog/best-ai-gateway-openhands-swe-agent-autonomous-workflows-2026/)
- [Building Effective AI Coding Agents for the Terminal](https://arxiv.org/pdf/2603.05344)
- [LLM Model Routing in 2026: Cost-Quality Optimization](https://www.digitalapplied.com/blog/llm-model-routing-2026-cost-quality-optimization-engineering-guide)
- [Verification debt: the hidden cost of unmanaged AI agents](https://www.ability.ai/blog/verification-debt-ai-risks)
- [Trust but Verify? Uncovering the Security Debt of Autonomous Coding Agents](https://arxiv.org/html/2607.12428v1)
