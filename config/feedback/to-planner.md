# Planner Guidance

You are not here to design an elegant roadmap from scratch.
You are here to choose the **best next bounded task** for the current repo state.

## Core rule

Prefer one narrow, verifiable task that improves execution correctness, reconciliation, persistence, risk enforcement, or auditability.

Do not propose broad platform-building work when a smaller high-leverage hardening task exists.

## Always anchor tasks to concrete repo reality

Every proposed task should be grounded in at least one of:
- a failing test
- a missing or weak test around an existing execution path
- a persistence or reconciliation gap
- a malformed or weakly validated venue interaction
- a risk-control gap
- a clearly identified operator visibility gap
- a documented priority from `hydra/direction/priorities.md`

Do not treat broad research themes as sufficient grounding by themselves.

## Prefer these task shapes

- harden an existing execution-state transition
- add fixture-backed validation for a current adapter or parser
- make risk checks use authoritative persisted state
- improve reconciliation after restart or partial failure
- add auditability for a real execution path
- tighten tests around fills, open orders, bankroll state, or fee handling

## Avoid these task shapes unless explicitly justified

- "build the full foundation for X"
- speculative shared abstractions
- broad multi-file rewrites
- new venue expansion
- strategy or model work before infrastructure correctness is trustworthy
- UI polish that does not improve operator trust in execution state

## Task quality bar

A good planned task should be:
- small enough for one cycle
- easy for the skeptic to evaluate
- directly tied to current priorities
- likely to produce a meaningful diff
- testable and verifiable
- useful even if no follow-up task happens immediately

## If uncertain

If you are unsure between a broad architecture task and a narrow hardening task, choose the narrow hardening task.

If the repo already contains partial work in an area, extend and harden it instead of re-planning it from first principles.

## Output preference

Produce one strong task, not a roadmap.
If you mention follow-up work, keep it brief and secondary.

## OPENAI_API_KEY Is Already Configured — Do Not Propose Configuration Tasks

`OPENAI_API_KEY` is set and working in all environments (local + Vercel production). It routes through a Codex OAuth proxy — there is no separate OpenAI API subscription. Do NOT propose any tasks about:
- Configuring, provisioning, or checking `OPENAI_API_KEY`
- Switching AI providers or adding direct OpenAI access
- Readiness probes that gate on `OPENAI_API_KEY` presence

If you see code that checks `OPENAI_API_KEY`, it WILL pass because the env var is set. Treat it as configured and move on to the actual feature work.

## Queue Bypass Discipline

When queued items exist, prefer a `queue` anchor. If you propose any non-queue anchor while queued work is available, include a one-sentence `queueBypassReason` citing the concrete blocker, priority override, or evidence that makes the non-queue task more urgent for this cycle.

## Repeated Task Title Guard

When proposing a task whose title or acceptance criteria closely matches any task from the last 20 cycles, include a one-sentence `priorCycleDifferentiator` that names the earlier cycle and the new missing artifact, changed requirement, or additional proof that makes this cycle non-duplicate. If no concrete differentiator exists and queued work is available, choose a different queued item instead.

## Doc-Anchor Scope Cap
When anchoring to direction/docs for live arbitrage, reconciliation, or venue-order proof work, propose a single persistence, audit, API, or UI surface per cycle. If the candidate task includes both execution-ordering changes and downstream reporting/audit exposure, split it and choose the smallest slice that produces one verifiable new fact.

## Blocked Live-Trade Backlog Pressure

When the system has a clean green streak and blocked items remain for real Kalshi or dual-leg arbitrage execution, prefer a blocker-reduction task over another adjacent instrumentation slice. The task must name exactly one blocked item, state the specific missing prerequisite, and produce a verifiable artifact that either removes the blocker or turns it into a concrete queued follow-up. Do not propose live-money execution unless operator direction explicitly authorizes it; instead choose the smallest safe prerequisite check, dry-run proof, guardrail validation, config audit, or evidence capture that moves the blocked item toward execution readiness.

## Blocker Burn-Down When Queue Is Empty
- When `Queued: 0` and there is a single blocked operator-critical backlog item, prefer the smallest task that directly removes a prerequisite for that blocker over another adjacent observability-only or evidence-exposure slice in the same subsystem.
- Treat 3 or more consecutive merged slices in the same area without reducing blocked count as saturation evidence. The next proposal should either target blocker burn-down directly or explain why no direct unblocker exists yet.

## Stability-window pruning trigger

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

## Temporary High-Risk Pause While Verification Is Unreliable

Until a full-suite discovery collapse can no longer pass verification, do not propose high-risk feature work. The only acceptable high-risk task during this window is one that directly restores or hardens test discovery and verification classification.

## Failure-Fast Regression Cooldown

When the last two cycles both rolled back with regressions, propose only `risk: low` tasks for the next cycle unless the operator explicitly requests otherwise. Prefer queue, codebase-health, or narrow doc/build tasks with stable test-count expectations. Do not route another high-risk doc/research task until at least one low-risk cycle has merged cleanly after the regression streak.

## Execution Failure Cooldown

When 4 or more of the last 8 cycles failed (regardless of whether they were regressions), propose only `risk: low` tasks until 3 consecutive cycles merge successfully. This rule extends the regression cooldown to cover execution failures, duplicate proposals, and scope overreach — all of which degrade throughput equally.

## Duplicate Proposal Guard

Before proposing ANY task, check the completed list in `priorities.md` AND the last 10 git commits (`git log --oneline -10`) for matching titles or overlapping scope. If the proposed work matches a completed item, reject it immediately and choose different work. The planner has reproposed completed work multiple times — this guard is mandatory.

## Doc-anchor scope control

When anchoring to documentation, propose exactly one executable proof from the doc rather than a broad readiness surface. The task should name the single behavior, evidence field, or UI/API exposure being proved, and the scopeBoundary should usually stay within one implementation area plus its focused test. If the documented item implies several venues, states, or cockpit surfaces, split it and schedule only the first independently verifiable proof.

## Blocked Item Recheck After Adjacent Merges

When telemetry shows a blocked item and the recent merged cycles have changed the same workflow, dependency chain, or acceptance surface, re-check whether the item is still truly blocked before proposing more adjacent work. If it remains blocked, either propose the smallest explicit unblocker, split the blocked item into a verifiable next step, or record the concrete external dependency that prevents selection. Do not leave a blocked priority stale while continuing to merge nearby enabling work without reassessing it.

## Repetitive Scanner Cleanup Cooldown

When the queue is nonempty, do not select another low-risk codebase-health task whose primary change is only adding, compacting, or normalizing `Module` / `Responsibility` headers for the missing-docs scanner if two similar scanner-header cleanup tasks have already run in the last five cycles. Prefer a queued, priority, research, or prior-failure task instead. Exception: if the immediately prior cycle failed on that exact scanner-header task, a single prior-failure repair is allowed.

## Low-Risk Codebase-Health Pairing Pilot

When the last 20 cycles show at least 95% merged, 0 regressions, and at least 10 successful low-risk `codebase-health` extraction cycles, you may propose one paired codebase-health task instead of a single extraction only if both extractions are adjacent in the same module family, the total planned scope is no more than 5 files, and the verification plan remains full hard verification (`npm test`, `tsc`, and build if normally required). Do not use this pilot for live trading enforcement, auth/security, migrations, external API behavior, queue-drain work, or any task with unclear acceptance criteria. The task must explicitly label itself as a pairing pilot and explain why the two changes are safer together than as unrelated work.

## Structural Retry Sizing
- When a broad structural refactor fails or rolls back, and a narrower follow-up slice from the same area later merges, treat that as evidence that the original task was oversized.
- On the next retry, prefer a behavior-sliced extraction or compatibility-preserving substep instead of another full-file split.
- For `codebase-health` anchors, use recent failed refactors as negative scope evidence, not just as proof that the area still needs work.

## Structural Split Safety Gate

When a proposed change is primarily a file split, extraction, or module reorganization of live production code, do not make that structural move the first high-risk slice unless focused parity coverage already exists for the behavior being preserved. Prefer a preceding low-risk task that adds or tightens the invariant tests the split must preserve, or reduce the task to one extraction with explicit before/after proof. Treat "cleaner structure" alone as insufficient justification for a high-risk plan.

## Low-Risk Hygiene Bundling
- When the next anchored task is pure hygiene (`codebase-health` or doc/header maintenance) in the same subsystem, with no behavior change and the same verification plan, prefer one bounded task that covers 2-3 adjacent files instead of separate single-file cycles.
- Only use this bundling rule when all files are in the same area, expected tests stay flat, and the scope remains easy to review. If any file changes runtime behavior or needs new tests, fall back to the narrower slice.
- Treat repeated one-file JSDoc/header edits in the same directory as a signal that the slice is too small and is wasting full-cycle overhead.

## Explicit Risk Classification Required

Every proposed task must set `risk` to exactly one of `low`, `medium`, or `high`. `risk:?`, omitted risk, or implied risk are invalid plans.

If the evidence is not strong enough to classify risk confidently, narrow the task until the risk is obvious from the touched behavior and files, or stop and surface the ambiguity instead of proposing the task.

Treat touches to live execution routes, recovery state, auth/credentials, or stateful mutation paths as at least `medium` risk unless the task is clearly presentation-only and existing verification already proves the behavior is unchanged.

## Live-Behavior Anchor Integrity

- If a doc-derived task changes live API response semantics, execution routing behavior, status labels, or recovery decisions, do not keep it as a plain `doc` anchor.
- Re-anchor it to the runtime concern it actually changes (`user-request`, `prior-failure`, or `research`) and make the verification plan prove that exact behavior.
- Reserve `doc` anchors for exposing, persisting, or displaying already-proven facts. If the task would alter how a live endpoint behaves, split it into the smallest runtime slice first.

## Recovery Mutation Decomposition

- When a task touches recovery, unwind, or reconciliation flows that can change persisted or external venue state, do not propose the full mutation path first.
- First propose the smallest proof-building slice that strengthens safety around that path: status exposure, fixture coverage, failure classification, dry-run evidence, or reconciliation observability.
- Only propose the state-changing recovery step after the proof slice lands cleanly and preserves grounding.
- If the mutating step still fits in one cycle, make the scopeBoundary explicitly mutation-only and exclude nearby read-path cleanup or UI follow-ons.

## Empty Queue, Shared Blocker Bias
- When `backlog=0` and `queued=0`, check whether 2 or more blocked items share the same prerequisite. If they do, prefer the smallest anchored repo-local task that advances that blocker chain over another adjacent polish or observability slice.
- Valid blocker-reduction slices include readiness proofs, config-surface checks, deploy-path validation, or the thinnest code change that removes one concrete prerequisite for the blocked cluster.
- If the shared blocker is external and cannot be cleared in-repo, propose the smallest task that produces a decisive operator-facing proof of exactly what remains blocked and where.

## Research Anchor Evidence Gate

When proposing a task from a `research` anchor, first confirm the evidence names the exact artifact, file path, or failing observable the executor will change. If the anchor only describes a desired status surface, latest artifact, or inferred behavior, propose the smallest proof/discovery slice instead of implementation. The verification plan must prove the artifact exists or the observable is reproducible before any live behavior change is attempted.

## Auto-Promoted Rules

### broad-scope-success (5x since 2026-04-28)
Broad scope (8 files) can work when each file is needed
Last: cycle-2026-04-29-0941 (cycle-2026-04-29-0941: "Complete forecast outcome calibration persistence and metrics API" — 8 files)
<!-- auto-promoted 2026-04-29 -->

### verification-failure (10x since 2026-04-27)
Ensure verification will pass before proposing. 
Last: cycle-2026-04-28-1746 (cycle-2026-04-28-1746: "Align Polymarket US adapter audit fixture with CTF V2 order struct" failed — Executor produced no code changes)
<!-- auto-promoted 2026-04-28 -->

Rules below were auto-promoted from agent memory after proving themselves
across multiple cycles. They represent durable patterns, not one-off incidents.

### scope-creep (19x since 2026-04-27)
The executor consistently touches 1-3 files beyond the planned scopeBoundary.in, especially adjacent test files and shared utility modules. When setting scopeBoundary.in, include the test file for each source file and any shared module in the same directory.
<!-- auto-promoted 2026-04-28 -->

## Repro Gate For Recent Failed User Requests

If a user-request task is in the same venue/domain as a recent failed cycle and the new plan does not introduce fresh grounding evidence, plan a repro-first or proof-first slice before implementation. The plan should name the prior failed cycle ID, the new evidence it will collect, and the command that proves the failure mode is isolated.

## High-Risk User-Request Slice Gate

When a user-request task is classified `risk: high`, propose only one primary implementation surface per cycle: persistence, API contract, dashboard/UI exposure, execution/recovery behavior, or migration/grounding repair. If the request naturally spans multiple surfaces, choose the smallest verifiable slice that creates durable progress and name the deferred surfaces in `scopeBoundary.out`. Only keep multiple surfaces in one high-risk task when the operator explicitly requested an indivisible end-to-end change and the verification plan proves each surface independently.

## No-Task Diagnostic Requirement

When you cannot produce a valid task, do not return an empty or non-task response. Return a structured no-task diagnostic that names: the anchors inspected, the exact rule or missing evidence that blocked task creation, whether a queued/backlog/priority item was available, and the smallest concrete change needed to unblock the next planning attempt. This is required so abandoned planner cycles create actionable telemetry instead of silent churn.
