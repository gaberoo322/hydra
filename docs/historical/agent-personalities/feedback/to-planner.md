<!-- Last audit: 2026-05-07 | Lines: 138 (was 214) -->
<!-- Pruning criteria: removed rules redundant with config/agents/planner.md core rules, -->
<!-- removed stale rules with 0 pattern hits in 14 days, consolidated overlapping rules. -->
<!-- Redis evidence: hydra:memory:planner:patterns queried 2026-05-07. -->

# Planner Guidance

## OPENAI_API_KEY Is Already Configured — Do Not Propose Configuration Tasks

`OPENAI_API_KEY` is set and working in all environments (local-runtime + scheduler-runtime). It routes through a Codex OAuth proxy — there is no separate OpenAI API subscription. Do NOT propose any tasks about:
- Configuring, provisioning, or checking `OPENAI_API_KEY`
- Switching AI providers or adding direct OpenAI access
- Readiness probes that gate on `OPENAI_API_KEY` presence

If you see code that checks `OPENAI_API_KEY`, it WILL pass because the env var is set. Treat it as configured and move on to the actual feature work.
<!-- Retained despite 0 pattern hits: operator directive preventing wasted cycles on a permanently resolved config question -->

## Queue Bypass Discipline

When queued items exist, prefer a `queue` anchor. If you propose any non-queue anchor while queued work is available, include a one-sentence `queueBypassReason` citing the concrete blocker, priority override, or evidence that makes the non-queue task more urgent for this cycle.

## Duplicate and Repeated Task Guard

Before proposing ANY task, check the completed list in `priorities.md` AND the last 10 git commits (`git log --oneline -10`) for matching titles or overlapping scope. If the proposed work matches a completed item, reject it immediately and choose different work.

When proposing a task whose title or acceptance criteria closely matches any task from the last 20 cycles, include a one-sentence `priorCycleDifferentiator` that names the earlier cycle and the new missing artifact, changed requirement, or additional proof that makes this cycle non-duplicate. If no concrete differentiator exists and queued work is available, choose a different queued item instead.

## Doc-Anchor Scope Control

When anchoring to documentation, propose exactly one executable proof from the doc rather than a broad readiness surface. The task should name the single behavior, evidence field, or UI/API exposure being proved, and the scopeBoundary should usually stay within one implementation area plus its focused test. If the documented item implies several venues, states, or cockpit surfaces, split it and schedule only the first independently verifiable proof.

When anchoring to direction/docs for live arbitrage, reconciliation, or venue-order proof work, propose a single persistence, audit, API, or UI surface per cycle. If the candidate task includes both execution-ordering changes and downstream reporting/audit exposure, split it and choose the smallest slice that produces one verifiable new fact.

## Blocker Management

When the system has a clean green streak and blocked items remain for real Kalshi or dual-leg arbitrage execution, prefer a blocker-reduction task over another adjacent instrumentation slice. The task must name exactly one blocked item, state the specific missing prerequisite, and produce a verifiable artifact that either removes the blocker or turns it into a concrete queued follow-up. Do not propose live-money execution unless operator direction explicitly authorizes it; instead choose the smallest safe prerequisite check, dry-run proof, guardrail validation, config audit, or evidence capture that moves the blocked item toward execution readiness.

When telemetry shows a blocked item and the recent merged cycles have changed the same workflow, dependency chain, or acceptance surface, re-check whether the item is still truly blocked before proposing more adjacent work. If it remains blocked, either propose the smallest explicit unblocker, split the blocked item into a verifiable next step, or record the concrete external dependency that prevents selection. Do not leave a blocked priority stale while continuing to merge nearby enabling work without reassessing it.

When `backlog=0` and `queued=0`, check whether 2 or more blocked items share the same prerequisite. If they do, prefer the smallest anchored repo-local task that advances that blocker chain over another adjacent polish or observability slice.

## Stability-Window Pruning Trigger

When the recent cycle window is overwhelmingly healthy (for example: mostly `anchor:user-request`, low-risk, merged, and verification-pass cycles with no queue pressure), treat additional caution rules as a cost center.

In those windows:
- Prefer proposing work using existing guidance rather than inventing new guardrails.
- If planning feels constrained by many old prevention rules, explicitly note that operator pruning is warranted instead of adding another rule.
- Assume stable low-risk user-request throughput is evidence that older caution may be stale unless a fresh regression proves otherwise.

## Efficiency During Healthy Windows
- When the last 10+ cycles show zero failures/regressions and work is dominated by low-risk `user-request` anchors, you may bundle two tightly related operator-visible changes into one task if all of the following hold:
  - both changes touch the same user surface or evidence path
  - the combined scope still fits one cycle and one verification plan
  - the planned file list remains explicit and bounded
- Prefer this only when separate micro-slices would create obvious repeated overhead with no added risk reduction.
- Do not use this allowance for research, blocked-item work, or tasks with unclear acceptance criteria.

## Failure Cooldown

When the last two cycles both rolled back with regressions, propose only `risk: low` tasks for the next cycle unless the operator explicitly requests otherwise. Prefer queue, codebase-health, or narrow doc/build tasks with stable test-count expectations.

When 4 or more of the last 8 cycles failed (regardless of whether they were regressions), propose only `risk: low` tasks until 3 consecutive cycles merge successfully. This rule covers execution failures, duplicate proposals, and scope overreach — all of which degrade throughput equally.

## Research Anchor Evidence Gate

When proposing a task from a `research` anchor, first confirm the evidence names the exact artifact, file path, or failing observable the executor will change. If the anchor only describes a desired status surface, latest artifact, or inferred behavior, propose the smallest proof/discovery slice instead of implementation. The verification plan must prove the artifact exists or the observable is reproducible before any live behavior change is attempted.
<!-- Retained despite low hits: safety gate for a high-cost failure mode -->

## Repro Gate For Recent Failed User Requests

If a user-request task is in the same venue/domain as a recent failed cycle and the new plan does not introduce fresh grounding evidence, plan a repro-first or proof-first slice before implementation. The plan should name the prior failed cycle ID, the new evidence it will collect, and the command that proves the failure mode is isolated.

## High-Risk User-Request Slice Gate

When a user-request task is classified `risk: high`, propose only one primary implementation surface per cycle: persistence, API contract, dashboard/UI exposure, execution/recovery behavior, or migration/grounding repair. If the request naturally spans multiple surfaces, choose the smallest verifiable slice that creates durable progress and name the deferred surfaces in `scopeBoundary.out`. Only keep multiple surfaces in one high-risk task when the operator explicitly requested an indivisible end-to-end change and the verification plan proves each surface independently.

## No-Task Diagnostic Requirement

When you cannot produce a valid task, do not return an empty or non-task response. Return a structured no-task diagnostic that names: the anchors inspected, the exact rule or missing evidence that blocked task creation, whether a queued/backlog/priority item was available, and the smallest concrete change needed to unblock the next planning attempt. This is required so abandoned planner cycles create actionable telemetry instead of silent churn.

## Auto-Promoted Rules

Rules below were auto-promoted from agent memory after proving themselves
across multiple cycles. They represent durable patterns, not one-off incidents.

### scope-creep (231x since 2026-04-27)
The executor consistently touches 1-3 files beyond the planned scopeBoundary.in, especially adjacent test files and shared utility modules. When setting scopeBoundary.in, include the test file for each source file and any shared module in the same directory.
Last: cycle-2026-05-07-1219
<!-- auto-promoted 2026-04-28, last hit 2026-05-07 -->

### verification-failure (438x since 2026-04-27)
Ensure verification will pass before proposing. Tests pass + typecheck + build must all succeed.
Last: cycle-2026-05-07-1026
<!-- auto-promoted 2026-04-28, last hit 2026-05-07 -->

### broad-scope-success (17x since 2026-04-28)
Broad scope (5+ files) can work when each file is needed. Do not reject a plan solely for file count.
Last: cycle-2026-05-07-2125
<!-- auto-promoted 2026-04-29, last hit 2026-05-07 -->

### high-risk-rejection (5x since 2026-05-03)
High-risk tasks require path-specific verification plans, not just broad `npm test` + `tsc`. The high-risk review will reject plans with only generic verification.
Last: cycle-2026-05-07-2242
<!-- auto-promoted 2026-05-03, last hit 2026-05-07 -->
