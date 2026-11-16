# hydra-autopilot — Phase 6 operational detail

Read this file when debugging a missing cycle record, a missing holdback
enrollment or a token metric that did not move. The running autopilot calls
`dispatch.sh cycle-record` and `dispatch.sh holdback-pending` directly. The
orchestrator runs no self-driving cycle (ADR-0006), so subagent outcomes
reach `hydra:cycle:*` records only through the writes this file describes.

## Cycle-record contract

`POST /api/autopilot/cycle-record` (`src/api/autopilot-lifecycle.ts`, invoked by
`dispatch.sh cycle-record`) writes the cycle record at **reap time**:

1. **`reap.py completion`** — when a code-writing class (`hydra-dev` /
   `hydra-target-build`) reaps, it files the record with `status=completed`, or
   `status=failed` when the soft token cap tripped. The `cycleId` is the
   dispatch's `effective_cycle_id = worktree_branch or task_id` (the `reap.py`
   symbol of the same name): a worktree dispatch keys on its synthesised branch
   (`worktree-agent-<runToken>-t<N>-<slot>`), and only a branch-less
   signal-class completion keys on the bare autopilot `task_id`. The id gives
   dedup across retries. Reap runs before the merge lands, so this write carries
   no PR number and no files data.
2. **Merged-status enrichment** — once the registered PR lands, the
   merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`)
   fetches the merged PR's `changedFiles` and calls
   `recordCycle({cycleId, prNumber, filesChanged})` in-process. `recordCycle` is
   idempotent on `cycleId`, so the second call enriches the existing record
   without re-firing any lifetime counter. The enrichment must key on the SAME
   `effective_cycle_id`; a different key mints an un-joinable twin with no
   `anchorType`, which classifies as `unclassified`. The arming step therefore
   forwards the worktree branch to `holdback-pending`.

The reap-time write covers three surfaces atomically, server-side:

- `hydra:cycle:<id>` hash and the `hydra:cycle:index` ZSET, read by
  `/api/cycle/history`
- `hydra:metrics:<id>` via `recordCycleMetrics(source: "claude")`, read by
  `/api/metrics` and `mergeRateWindow` from `GET /api/scheduler/status`
- the `hydra:scheduler:cycles-run`, `cycles-merged`, `cycles-failed` and
  `cycles-unaccounted` lifetime counters, read as `mergeRateLifetime` from
  `GET /api/scheduler/status`

`dispatch.sh cycle-record` is best-effort: a 5xx or unreachable API is logged to
the run log and the autopilot proceeds.

## Register handoff on auto-merge

`gh pr merge --auto --squash` runs only once `scripts/ci/qa-merge-guard.ts`
allows it (see the `auto-merge` action row in the main playbook). It arms the
merge, so the PR may land seconds to minutes later, out-of-band from the turn.
The handler therefore **registers** the armed PR and hands both merge-coupled
follow-ups, the Outcome-Holdback enrollment and the merged cycle-record
enrichment, to the merge-completion watcher.

After the guarded arm succeeds, fire ONE register call:

```bash
# pr_number: the armed PR. pr_tier: state.actions[].tier (1-4), or null. task_id: the autopilot task_id.
# HYDRA_ARM_SKILL: the hydra-* skill of the class that produced the action; dispatch.sh maps it to an
#   anchorType, and an unmapped skill omits the field (honest `unclassified` beats a wrong lane).
# pr_worktree_branch: state.slots.<class>.branch of the dispatch that opened the PR (empty for a
#   branch-less signal class, so the cycleId stays $task_id). A literal 4th arg beats HYDRA_ARM_SKILL.
# Best-effort: a non-2xx or unreachable endpoint is logged and the cycle proceeds.
HYDRA_ARM_SKILL="${pr_arm_skill:-}" \
scripts/autopilot/dispatch.sh holdback-pending \
  "$pr_number" "${pr_tier:-null}" "$task_id" "${pr_anchor_type:-}" "${pr_worktree_branch:-}"
```

`POST /api/holdback/pending` (`src/api/holdback.ts`) records the armed PR in the
durable **pending-enroll registry**. It is idempotent on `prNumber` and records
intent only; it never arms, blocks or performs a merge. The cycle-merge-reconcile
chore self-arms any confirmed-merged PR missing from the registry, so a dropped
arm recovers on the next housekeeping tick. Each housekeeping tick, the watcher
consumes the registry and, for each entry whose merge has landed, fires both
follow-ups:

1. **Outcome-Holdback enroll** — `enrollHoldback({commitSha, prNumber, tier})`
   against the landed squash SHA (ADR-0015 owns the holdback step). Outcome
   Holdback carries up the monotonic tier ladder: T2, T3 and T4 merges enroll,
   while T1 and unknown-tier merges are exempt. `enrollHoldback` enforces the
   exemption server-side, so the watcher posts the `tier` verbatim and the
   playbook adds no client-side tier guard.
2. **Merged cycle-record enrichment** — `recordCycle({cycleId, prNumber,
   filesChanged})`, as in the cycle-record contract.

The watcher is idempotent through a per-PR enrolled marker, leaves a still-open
PR in the registry for a later tick, and never throws. The handler holds no merge
SHA and makes no enroll or cycle-record call itself. The `hydra-qa` Post-merge
Regression Check section B watches each enrolled merge.

Historical: ADR-0004 first described the holdback enroll step. <!-- ref-check: example -->

## Token-surrogate write

`reap.py` posts the token surrogate on every reap that has authoritative
`total_tokens` (the `wait_or_reap` and `reap` action-table rows in the main
playbook). The parent never hand-posts `/api/metrics/tokens`, which would
double-count. The post is best-effort and idempotent: the reaper dedupes by
`task_id` through `reaped_task_ids` before firing follow-up writes. The endpoint
bumps three Redis keys:

- `hydra:metrics:tokens:autopilot:daily:<YYYY-MM-DD>` — INT total
- `hydra:metrics:tokens:by-skill:daily:<YYYY-MM-DD>` — HASH {skill -> tokens}
- `hydra:metrics:tokens:by-cycle:<cycleId>` — HASH {tokens, skill}

The key TTLs live in the handler behind `POST /api/metrics/tokens`. The
dashboard `CostWidget` reads these keys via `GET /api/metrics/cost` and labels
its `source`, so surrogate USD is never mistaken for billed spend. Dollar
conversion uses `HYDRA_TOKEN_USD_RATE` (USD per million tokens; the default
makes the dollar figure zero until an operator sets a trusted rate).
