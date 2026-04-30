---
updated: 2026-04-07
status: active
owner: meta
tags: [hydra, hydra/direction]
---

# Proposal Auto-Approval Policy

This file configures which Meta agent proposal categories can be auto-approved versus requiring manual review.

### Current Policy: All proposals require manual approval

Until trust is established through several cycles of successful proposals, all changes to Hydra require explicit approval via:
- API: `curl -X POST http://localhost:4000/proposals/{id}/approve`
- Dashboard: Click "Approve" on the Proposals page at admin.clawstreetbets.xyz/proposals

### Future Graduated Trust

Once proposals are consistently high-quality, these categories can be upgraded to auto-approve:

| Category | Auto-approve? | Rationale |
|---|---|---|
| Agent personality tweaks | Not yet | Low risk, but want to observe patterns first |
| OpenViking context tuning | Not yet | Doesn't change code |
| Event routing changes | No | Review first few |
| Orchestrator code changes | Never auto | Always review |
| Eval config changes | Never auto | Quality gate itself |

### How to Enable Auto-Approval

When ready, add entries to the `auto_approve` list below. The Meta agent reads this file each cycle.

```yaml
auto_approve: []
# Future: auto_approve: ["personality"]
```

## Healthy Window Policy

When the last 20 cycles are 100% merged with 0 regressions and 0 failed verifications:
- Do **not** propose new prevention rules unless there is specific evidence of a repeated near-miss or operator complaint
- Prefer proposals that reduce stale guidance, improve routing/cost, or improve measurement quality
- Prefer zero proposals over adding behavioral constraints
- If accumulated prevention rules exceed 30 across agents, prefer pruning/consolidating over adding

## Green-Streak Queue Drain Pilot

When the last 20 cycles have a 100% merge rate, 0 regressions, 0 blocked items, and the queue contains 8 or more items, prefer draining existing queued low-risk doc/research tasks before introducing new research-derived work. Keep each task bounded to the normal one-task cycle rule, but require the planner to select from queued work unless it can cite a higher-priority operator directive or a failing verification anchor. Track success by queue depth, merge rate, and regression rate over the next 20 cycles.

## Telemetry Rate Consistency

Before Meta classifies health from aggregate rates, recompute abandoned and regression rates from per-cycle detail and reality reports. If aggregate fields disagree with source records, report the mismatch as telemetry inconsistency and do not use the conflicted aggregate field for system-health classification or proposal justification.

## Queue-Drain Pilot Telemetry

When the Green-Streak Queue Drain Pilot is active, periodic Meta review inputs must include queue depth at the start and end of the reviewed window, the count of queue-anchored cycles, and any recorded `queueBypassReason` values with representative cycle IDs. Meta should treat missing pilot fields as a telemetry gap, not as evidence of planner failure.

## High-Risk Research Gate

Research-anchored tasks may skip Skeptic only when `risk` is `low` or `medium`. If a research task is classified as `high`, route it through Skeptic before execution. Skeptic should either approve the bounded scope or reject with a narrower lower-risk slice.

## Verification Consistency: Test Count Collapse

If a cycle's post-change test count drops by more than 10% from grounding, verification must be classified as failed even when the test command exits 0. Record the mismatch explicitly in the reality report as `verificationStatus=test_count_collapse` and block merge until full test discovery is restored.

## Meta Proposal Backlog Throttle

When periodic review classifies system health as `healthy` and there are 8 or more pending proposals, Meta should default to zero new proposals unless the new proposal addresses a fresh regression, a telemetry inconsistency that blocks correct health classification, or a critical operator-alignment failure not covered by any pending proposal. In that state, report observed patterns but avoid adding more guidance churn until pending proposals are approved, rejected, or applied.

## Healthy-Window Prevention Memory Pruning

When the last 20 cycles show >=90% merged, <=5% regression, and no blocked backlog items, Meta should prioritize identifying stale, redundant, or overly broad prevention rules before proposing new planner/executor/skeptic constraints. New prevention guidance should require repeated evidence or a high-severity failure mode not already covered by existing rules or pending proposals.

## Global Test Discovery Regression Gate

When verification compares grounding and final test output, treat a material discovered-test-count drop as a hard failure even if the test command exits successfully. A material drop is any decrease greater than 1% or greater than 5 tests, unless the approved plan explicitly expected test deletion and the final diff proves that deletion was intentional. This applies to every anchor type, including codebase-health and documentation-adjacent cleanup work.

## Periodic Review Aggregate Consistency

Before sending periodic review telemetry to Meta, recompute merged/failed/abandoned/regression rates directly from the per-cycle detail included in the same payload. If recomputed rates differ from the aggregate summary, include a telemetry mismatch note and prefer the recomputed per-cycle rates for system-health classification and proposal gating.

## Verified-Unmerged Cycle Reporting

When a cycle reaches passing verification but is not merged, do not collapse it into a generic `ABANDONED` state. Preserve the verified outcome and record a machine-readable `finalizationReason` such as `merge-conflict`, `branch-missing`, `policy-hold`, `duplicate`, `operator-hold`, or `telemetry-error`. Meta reviews must treat verified-unmerged cycles as telemetry/finalization issues unless at least two independent sources agree that the agent failed the task.

## Low-Risk Codebase-Health Model Routing

When the next task is anchored to `codebase-health`, marked low risk, and limited to documentation/comments/module headers or other test-neutral helper clarification, route planning through the cheaper codex path instead of frontier. Do not use this shortcut for research anchors, live-trading behavior, execution semantics, ambiguous product decisions, or any task expected to change runtime behavior.

## Meta Telemetry Completeness

When periodic review telemetry includes any failed, abandoned, or regression cycle in the cycle metrics window, include that cycle's reality report even if it falls outside the normal recent-report count. Meta should not infer agent failure from per-cycle status alone when the matching reality report is missing; it should classify the gap as telemetry incomplete and request the missing failure context.

## Periodic Review Queue-Drain Telemetry

When the Green-Streak Queue Drain Pilot is active, periodic review telemetry should include enough fields to measure adoption without inference: queueDepthStart, queueDepthEnd, queueAnchoredCycleCount, and any queueBypassReason values emitted during the reviewed window. If a field is unavailable, the payload should explicitly mark it unavailable rather than omitting it.

## High-Risk Research Skeptic Gate

When a proposed task is `anchor:research` but `risk:high`, do not apply the normal research-task Skeptic skip. Route it through Skeptic before execution, with special attention to user-facing dashboard/action-row changes and live-trading approval paths. Low-risk research tasks may continue using the existing fast path.

## Failure Reality Report Completeness

When Meta reviews a cycle window, every cycle marked `FAILED` in aggregate or per-cycle metrics must have a matching reality report or an explicit missing-report marker. If any failed cycle is missing from reality reports, Meta should treat the window as telemetry-degraded and avoid attributing root cause to planner, executor, or skeptic behavior until the failure record is complete.

## Global High-Risk Skeptic Gate

When any proposed task is classified as `risk: high`, route it through Skeptic before execution regardless of anchor type. Do not allow the normal fast path for `user-request`, `doc`, `prior-failure`, or other anchors to bypass review when the task changes live execution behavior, status semantics, routing decisions, or recovery state. Meta should treat any high-risk task that skipped Skeptic as a policy violation rather than normal execution variance.

## Telemetry State Normalization
- Periodic review telemetry must emit a single normalized terminal-state field for every cycle and use the same value in aggregate metrics, per-cycle detail, and reality reports.
- Allowed terminal states are `merged`, `verification_failed`, `rolled_back`, and `abandoned`.
- When verification passes but the cycle is reverted for regression or grounding loss, report the cycle as `rolled_back` on every telemetry surface rather than mixing `failed` and `rolled-back` labels.

## Failed-Cycle Reality Report Requirement

When a cycle reaches a terminal `FAILED` state, the reporting layer must emit a reality report or explicit failure artifact for that cycle before Meta review treats the window as complete. The artifact should include the cycle id, task, anchor, verification result, failing command or merge blocker, and whether any regression was observed. If the artifact is missing, Meta should classify it as a telemetry reliability issue before attributing the failure to planner, skeptic, or executor behavior.

## Telemetry Reconciliation Before Health Scoring

When Meta review inputs disagree across aggregate metrics, per-cycle detail, and reality reports, quarantine the conflicting cycle IDs before computing agent-failure, abandonment, or regression conclusions. Emit a telemetry-consistency pattern with the exact cycle IDs and conflicting fields, and do not use those cycles as evidence for planner, executor, or skeptic behavior changes unless at least two telemetry sources agree on the terminal state.

## Verification Gate: Test Inventory Shrinkage

If a cycle's grounding or reality report shows the test inventory decreased, verification must be treated as failed unless the approved plan explicitly included deleting or consolidating tests and the reality report records that rationale. A cycle cannot be marked verified, merged, or regression-free when tests decrease unexpectedly, even if the shell verification commands pass.

## Telemetry Window Quarantine

When Meta receives cycle metrics and reality reports whose recency windows are incompatible, Meta must treat execution-health metrics as provisional. If the newest reality-report cycle IDs are absent from the reported cycle-metrics window, or if failed metric cycles lack matching reality reports, Meta should emit telemetry-consistency patterns first and avoid planner/executor/skeptic behavior proposals unless the same failure is confirmed by at least two consistent sources.

## Applied Policy Drift Gate

When a cycle outcome contradicts an approved/applied policy, Meta must classify the window as at least degraded and propose an enforcement audit rather than another agent-behavior tweak for the same concern. Examples include verification passing despite an unexplained test-inventory collapse, or a high-risk cycle apparently running on a non-frontier execution path after high-risk routing was approved. The audit should identify whether the policy is only documented, not loaded by the control loop, shadowed by another config file, or missing runtime assertions.

## Guard-Policy Negative Controls

When a cycle changes verification logic, test discovery, suite-count checks, or regression guards, the verification plan must include a negative-control proof that the guard fails on a deliberately bad condition. A passing normal suite is not enough for guard-policy work; the cycle must show the guard catches the class of failure it claims to prevent before the change is considered verified.

## Empty-Queue Idle Short-Circuit

When backlog, queued, and blocked counts are all zero, the control loop may emit an intentional `idle/no-task` outcome instead of launching another codebase-health planning cycle, unless a current priority, failing test, operator request, or prior failure provides a concrete anchor. Record the skipped anchor and state counts in telemetry so Meta can distinguish healthy idling from planner abandonment.

## High-Risk Research Requires Skeptic Review

Research-anchored tasks may only bypass Skeptic when the planner classifies them as `risk: low` or `risk: medium`. Any research-anchored task with `risk: high` must go through Skeptic before execution, because high-risk research can mutate broad runtime surfaces and has now produced a confirmed rollback/regression. Skeptic should verify that the plan is bounded, has a regression-focused verification plan, and does not rely on test-count shrinkage as acceptable progress.
