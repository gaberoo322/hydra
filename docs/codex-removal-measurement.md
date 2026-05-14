# Codex-Removal Measurement Plan (Phase A → B → C)

> **Status: outcome-complete, 2026-05-14.** See [§6 Outcome](#6-outcome-2026-05-1314) at
> the bottom of this document for the cut-over record and the gates that were
> waived. Superseded by [ADR-0006](adr/0006-codex-cli-removed-autopilot-only.md).
> Kept as the historical record of the plan that *would* have run if the
> de-facto evidence from autopilot hadn't made it redundant.

> Tracking issue: [#348](https://github.com/gaberoo322/hydra/issues/348).
> Phase A is reversible. Phases B and C are not. This document gates the
> progression on data, not on a calendar.

The codex-removal refactor replaces Codex CLI agents with direct Anthropic SDK
calls in stages:

- **Phase A** — non-load-bearing call sites (research, classification, meta,
  high-risk review) move off the Codex CLI. Easily revertable.
- **Phase B** — the executor agent moves off the Codex CLI. Touches the merge
  path. Revertable in principle, painful in practice.
- **Phase C** — the planner moves off the Codex CLI and the Codex SDK
  dependency is removed entirely. Effectively a one-way door.

Each transition requires the conditions below to hold. Failing the trigger
condition is not a "wait longer" — it is a signal to investigate, fix, or
abandon the cut-over.

## 1. Baseline metrics (snapshot today, before Phase A merges)

Capture each of the following from production telemetry at the moment the first
Phase A PR merges to master. These values become the comparison floor for the
rest of the rollout. Persist the snapshot to
`hydra:metrics:codex-removal:baseline` (Redis) and copy the values into the
issue comment thread on #348 for durability.

| Metric | Source | Notes |
|---|---|---|
| **7-day rolling merge rate** | `/api/cycle/history` over the last 7 days; count successful merges vs. total cycles | The headline throughput metric; everything else is read against this |
| **Daily cost (USD)** | `hydra:metrics:cost:daily:*` averaged across the last 7 days | Sum of planner + executor + fixer + meta + adversarial spend |
| **Mean cycle duration** | `/api/cycle/history` `durationMs` field, mean over last 7 days of completed cycles | Detects regressions from added round-trips |
| **PR revert rate** | Count of merges to master in last 14 days whose follow-on commit message starts with `Revert "` | Use 14 days because reverts lag the original merge |
| **Operator-flagged bad merges** | Issues opened by the operator with the `bad-merge` label in the last 14 days | Captures quality regressions the automated revert path misses |

Snapshot script (manual today; can be automated later):

```bash
# Pseudocode — exact queries live in scripts/metrics/codex-removal-baseline.sh
redis-cli --json HSET hydra:metrics:codex-removal:baseline \
  mergeRate7d "$(curl -s localhost:4000/api/cycle/history?limit=200 | jq ...)" \
  dailyCostUsd "$(...)" \
  meanCycleMs "$(...)" \
  revertRate14d "$(...)" \
  badMergeCount14d "$(gh issue list --label bad-merge --search 'created:>NOW-14d' | wc -l)"
```

If any of the five values is unavailable when Phase A is ready to merge, **do
not** proceed. Fix the telemetry gap first — the whole plan rests on these
numbers.

## 2. Cut-over conditions: 5-day Phase A soak

After the last Phase A PR merges to master, run for **5 calendar days** with
all Phase A call sites on the new SDK path. During the soak:

- Watchdog and auto-revert must remain active.
- No deliberate config rollbacks of the SDK path. If the operator disables the
  SDK path mid-soak, the clock resets when it is re-enabled.
- At the end of day 5, snapshot the same five metrics from §1 against the live
  system. Store under `hydra:metrics:codex-removal:phaseA` with a timestamp.

Operator-visible artifact: a comparison table (baseline vs. Phase A) posted on
issue #348 or its successor tracking issue.

## 3. Phase B trigger conditions (ALL must hold)

Phase B (executor cut-over) proceeds only if **all three** of the following
hold against the Phase A snapshot:

1. **Throughput preserved** — Phase A 7-day rolling merge rate is within
   **30%** of baseline. Formula: `phaseA.mergeRate7d >= 0.70 *
   baseline.mergeRate7d`. (One-sided: higher is fine.)
2. **No operator-flagged quality drop** — `phaseA.badMergeCount14d <=
   baseline.badMergeCount14d` AND `phaseA.revertRate14d <=
   baseline.revertRate14d * 1.25` (allow 25% noise headroom on a low-base-rate
   metric).
3. **Cost reduced** — `phaseA.dailyCostUsd < baseline.dailyCostUsd`. Any
   reduction qualifies; the point is direction, not magnitude. If cost is flat
   or up, Phase A delivered no economic value and Phase B's risk is not
   justified.

If all three hold, open the Phase B implementation issue and link this document
in its body. If any condition fails, see §5.

## 4. Phase C trigger conditions

Phase C (planner cut-over + Codex SDK removal) proceeds only after **2
consecutive weeks of Phase B in production with no regressions**, defined as:

- No new `bad-merge`-labelled issues attributable to the executor cut-over.
- No auto-reverts triggered by the Outcome Holdback watcher on PRs whose
  executor ran via the SDK path.
- Phase B 7-day rolling merge rate stays within 30% of baseline for the full
  14 days (not just at the endpoints).
- Daily cost in Phase B remains at-or-below the Phase A daily cost.

Snapshot the metrics at the 7-day and 14-day marks. Both snapshots must
satisfy the conditions above. A failure at day 7 resets the clock — wait until
the underlying issue is fixed, then restart the 14-day window.

## 5. Abandonment conditions (what to revert and when)

The plan is reversible on purpose. If the data turns the wrong way, revert
without ceremony:

- **Phase A regression** — if any Phase B trigger condition (§3) fails at the
  5-day mark, revert the Phase A PRs (`refactor-batch-2026-05` label) and
  re-open #348's parent epic with the failure data attached. Do not "wait
  another week" — the metrics are the trigger, not the optimist.
- **Phase B mid-flight regression** — if the executor cut-over shows any of:
  - merge rate falling below 70% of baseline on any rolling 7-day window,
  - more than 2 operator `bad-merge` flags in any rolling 7-day window,
  - auto-revert rate above 2× baseline,
  then revert the executor SDK path PR and reopen the Phase B tracking issue
  with the metric snapshot. The planner stays on Codex.
- **Cost regression at any phase** — if daily cost exceeds the previous
  phase's daily cost by more than 10% for 3 consecutive days, treat as a
  regression and revert the most recent phase. SDK migration is supposed to
  reduce cost; if it doesn't, the trade is bad.
- **Operator override** — the operator may abandon at any phase based on
  qualitative signal (e.g. agent output quality feels worse, even if numbers
  look fine). Document the override on the tracking issue so future cut-over
  attempts learn from it.

Abandoned phases are not permanent — they are signals to instrument better,
fix the underlying gap, and try again with a fresh baseline.

## 6. Outcome (2026-05-13/14)

The cut-over completed without running Phase B and Phase C as separate soaks.
By the time PR-3 ([#400](https://github.com/gaberoo322/hydra/pull/400)) was
ready, the autopilot path had already been the primary code-writing source for
≥14 days, and the codex control loop's residual contribution was near-zero
unique merges — most of its cycles were "no-op anchor" or were preempted by
autopilot-side PRs on the same anchors.

**What was cut over and when**

| Phase | Plan | Actual |
|---|---|---|
| Phase A | Non-load-bearing call sites move off Codex CLI | Shipped 2026-04 → 2026-05 across the `refactor-batch-2026-05` label |
| Phase B | Executor cut-over (5-day soak gates Phase C) | Combined with Phase C — see below |
| Phase C | Planner + SDK removal (one-way door) | [PR #400](https://github.com/gaberoo322/hydra/pull/400) merged 2026-05-13. Soak gate waived. |

**Gates that were waived and why**

- **5-day Phase A soak (§2) → ran ~9 days** by accident-of-scheduling under
  the `HYDRA_CODEX_CYCLE_ENABLED` kill-switch ([PR #390](https://github.com/gaberoo322/hydra/pull/390)).
  Comparison vs baseline was net-favorable on all five metrics. No mid-soak
  rollback occurred.
- **Phase B trigger conditions (§3)** were satisfied by autopilot's own merge
  output during the same window — autopilot's `dev_target` class was already
  doing the executor's job in production. The §3 conditions were defined
  against the *Codex* executor; with that executor already shadowed by
  autopilot, evaluating them against autopilot output is what we did
  qualitatively in the daily digest.
- **2-week Phase C soak (§4) → waived** in favor of "autopilot has been the
  primary code-writing path for ≥14 days with no observed regression". The
  cost-reduction signal in particular was clearer than the original plan
  required — autopilot's per-merge cost was visibly below the Codex path's
  in `/api/spending` over the comparison window. Operator memory
  `feedback_bg_agent_worktree_hygiene` (PR #245 incident) reinforced the
  case: keeping the second execution path alive was a *negative* trade, not
  just a neutral one.

**What the abandonment-conditions check returned**

None of §5's abandonment triggers fired during the autopilot shadow period.
No spike in `bad-merge`-labelled issues, no auto-revert volume above
baseline, no cost regression. The decision to combine Phase B/C and waive
the calendar gate was made on the strength of the affirmative evidence, not
the absence of negative evidence.

**Pointers**

- PR-1 (kill-switch): [#390](https://github.com/gaberoo322/hydra/pull/390) (issue [#381](https://github.com/gaberoo322/hydra/issues/381))
- PR-2 (CI quality gates): [#393](https://github.com/gaberoo322/hydra/pull/393) (issue [#382](https://github.com/gaberoo322/hydra/issues/382))
- PR-3 (runtime removal): [#400](https://github.com/gaberoo322/hydra/pull/400) (issue [#383](https://github.com/gaberoo322/hydra/issues/383))
- PR-4 (docs cut-over): closes [#384](https://github.com/gaberoo322/hydra/issues/384)
- Epic: [#380](https://github.com/gaberoo322/hydra/issues/380)
- Successor decision record: [ADR-0006](adr/0006-codex-cli-removed-autopilot-only.md)

If the data in `/api/cycle/history` for the 2-week window leading up to
2026-05-13 ever needs to be revisited, the Redis baseline snapshots from §1
were captured to `hydra:metrics:codex-removal:baseline` and
`hydra:metrics:codex-removal:phaseA` and are still queryable. They are now
historical artifacts, not active comparison floors.
