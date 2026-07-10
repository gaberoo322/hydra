# hydra-autopilot — Phase 6 operational detail

Read this file for the full implementation contract of Phase 6: cycle-record
writes, register handoff on auto-merge, and token-surrogate write. The running
autopilot calls `dispatch.sh cycle-record` and `POST /api/holdback/pending`
directly — read this when debugging a missing record or metric.

### Phase 6 cycle-record contract (issue #430)

After PR-3 (#383) deleted the in-process control loop, `src/cycle.ts`
declared that autopilot subagents would write their own `hydra:cycle:*`
records. That handoff is implemented by `POST /api/autopilot/cycle-record`
(see `src/api/autopilot.ts`), invoked via `dispatch.sh cycle-record`.

The cycle-record write fires at **reap time**:

1. **`reap.py completion`** — when a code-writing class (`hydra-dev` /
   `hydra-target-build`) reaps, it fires cycle-record with `status=completed`
   (or `status=failed` if the soft cap was tripped). The autopilot task_id
   is the `cycleId`, which gives natural dedup across retries. This write has
   no PR number (reap.py runs before the merge lands), so it files the record
   with NO PR/files data.

The **merged-status enrichment** — the follow-up that stamps `filesChanged` +
`prNumber` on the already-recorded metrics hash (issue #2063) — is NO LONGER
posted by the auto-merge handler. It now fires **in-process** from the
merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`, issue
#2623): once a registered PR (see the register handoff below) lands, the watcher
fetches the merged PR's `changedFiles` and calls `recordCycle({cycleId,
prNumber, filesChanged})` itself. Because `recordCycle` is idempotent on
`cycleId`, that duplicate post ENRICHES the existing record WITHOUT re-firing any
lifetime counter — the same enrichment semantics the auto-merge follow-up used
to carry, but coupled to the merge event in-process rather than shelled out from
the playbook.

The reap-time write covers three surfaces atomically server-side:

- `hydra:cycle:<id>` hash + `hydra:cycle:index` ZSET → `/api/cycle/history`
- `hydra:metrics:<id>` via `recordCycleMetrics(source: "claude")` →
  `/api/metrics` and `/api/scheduler/status.mergeRateWindow` (carries the
  enriched `filesChanged` count once the watcher posts the merged enrichment)
- `hydra:scheduler:cycles-{run,merged,failed,unaccounted}` lifetime counters →
  `/api/scheduler/status.mergeRateLifetime`

`dispatch.sh cycle-record` is best-effort: a 5xx or unreachable API is logged
to the nightly run log and the autopilot proceeds.

### Phase 6 register handoff on auto-merge (issues #2055, #2621–#2624)

The auto-merge handler no longer holds the merge — `gh pr merge --auto --squash`
ARMS auto-merge, so the PR may land seconds to minutes later, out-of-band from
this print-mode turn. Rather than block the turn waiting for the squash SHA, the
handler simply **registers** the armed PR and hands both merge-coupled
follow-ups (Outcome-Holdback enroll + the merged cycle-record enrichment) to the
in-process **merge-completion watcher** (`src/scheduler/chores/holdback-merge-watch.ts`,
issue #2623).

After `gh pr review --approve && gh pr merge --auto --squash` succeeds for an
`auto-merge` action, fire ONE register call:

```bash
# The ONLY post-merge follow-up the handler makes. $pr_number is the just-armed
# PR; $pr_tier is the integer tier from the auto-merge action payload
# (state.actions[].tier, 1–4 per ADR-0015, or empty/`null` for unknown-tier);
# $task_id is the autopilot cycleId. Best-effort: a non-2xx or unreachable
# endpoint is logged and the autopilot cycle proceeds — registration NEVER blocks
# or delays a merge.
#
# Issue #3078: this arming step is now the AUDITED `dispatch.sh holdback-pending`
# subcommand (mirroring `cycle-record` / `capacity-writeback`), NOT an inlined
# `curl … | jq …`. That inlined step was the drop-prone spaghetti that left the
# Outcome Attribution Spine ledger dark for 7+ days when a print-mode turn dropped
# the POST. The subcommand centralises the body-shape + the HYDRA_API_BASE origin
# resolution, and the cycle-merge-reconcile chore now self-arms any confirmed-
# merged PR still missing from the registry — so a dropped arm is recovered on the
# next housekeeping tick with no new event surface.
#
# Issue #2800: pass an EXPLICIT anchorType (4th arg) so the merge-watch enrichment
# classifies the cycle even when it becomes the FIRST cycle-record write (the
# qa_orch relay case, where reap never wrote a record for this cycleId). Without
# it, the bare-UUID cycleId falls through the slot-suffix inference to the
# `unclassified` sentinel — the 32%-unclassified data-quality gap. Map the
# auto-merge action's dispatch class to its anchorType, mirroring
# `scripts/autopilot/dispatch.sh`: code-writing dispatches (dev_orch/dev_target)
# are `work-queue`; a bare `auto-merge` action with no resolvable class defaults
# to `work-queue` (the dominant armed-PR case). Omitting the 4th arg degrades to
# the prior inference-then-`unclassified` behaviour.
pr_anchor_type="${pr_anchor_type:-work-queue}"
scripts/autopilot/dispatch.sh holdback-pending \
  "$pr_number" "${pr_tier:-null}" "$task_id" "$pr_anchor_type"
```

`POST /api/holdback/pending` (`src/api/holdback.ts`, issue #2622) records the
armed PR into the durable **pending-enroll registry** (idempotent on `prNumber`;
it records intent only — it never arms, blocks, or performs a merge). The
merge-completion watcher then consumes that registry each housekeeping tick and,
for each entry whose merge has landed, fires BOTH merge-coupled follow-ups
in-process:

1. **Outcome-Holdback enroll** — `enrollHoldback({commitSha, prNumber, tier})`
   against the landed squash SHA (ADR-0004 step 4, #786). Outcome Holdback
   **carries up** the monotonic tier ladder (#741, ADR-0015) — **T2, T3, and T4
   merges all enroll** while **T1 (prompt-shaped) and unknown-tier merges are
   exempt** (`enrollHoldback` enforces the carry-up exemption server-side, so the
   single source of truth for the invariant stays on the server). The watcher
   POSTs the `tier` from the register call verbatim; do NOT add a client-side
   `if tier in {2,3,4}` guard.
2. **Merged cycle-record enrichment** — `recordCycle({cycleId, prNumber,
   filesChanged})` (issue #2063), idempotent-enriching the reap-time record.

The watcher is idempotent (per-PR enrolled marker), leaves a still-open PR in the
registry for a later tick, and never throws (all best-effort). So the auto-merge
handler is reduced to *arm the merge, register the PR* — it holds no merge SHA
and makes no enroll/cycle-record call itself. The **check** mechanism that
watches each enrolled merge lives in the `hydra-qa` Post-merge Regression Check
section B.

### Phase 6 token-surrogate write (issue #394)

After PR-3 (#383) deleted `codex-runner.ts`, the legacy `recordSpend` writer
that fed `hydra:scheduler:daily-spend` for code-writing work was removed.
The autopilot now owns the daily-spend signal via a token surrogate. On
each subagent reap that has authoritative `total_tokens`, the autopilot
SHOULD fire:

```bash
curl -fsS -X POST -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg skill "$cls_skill" \
    --argjson tokens "$total_tokens" \
    --arg cycleId "$task_id" \
    '{skill: $skill, tokens: $tokens, cycleId: $cycleId}')" \
  "${HYDRA_API:-http://localhost:4000/api}/metrics/tokens" >/dev/null 2>&1 || \
  echo "[autopilot] dispatch: tokens write failed for cycle=$task_id (non-fatal)" >&2
```

This is best-effort and idempotent at the autopilot's `reaped_task_ids`
layer (the reaper already dedupes by `task_id` before firing follow-up
writes, so the same `cycleId` never bumps the counter twice). The endpoint
bumps three Redis keys:

- `hydra:metrics:tokens:autopilot:daily:<YYYY-MM-DD>` — INT total
- `hydra:metrics:tokens:by-skill:daily:<YYYY-MM-DD>` — HASH {skill -> tokens}
- `hydra:metrics:tokens:by-cycle:<cycleId>` — HASH {tokens, skill}

The first two have a 30-day TTL; the per-cycle hash has 7 days. The
dashboard `CostWidget` (Metrics page) reads these via `GET /api/metrics/cost`
and surfaces a clearly-labelled `source` so the operator never mistakes
surrogate USD for real billed spend. Dollar conversion uses
`HYDRA_TOKEN_USD_RATE` (USD per million tokens, default 0 — operators must
opt in to a rate they trust).

The per-cycle write keeps the per-cycle cost-cap in `src/cost/cap.ts`
alive: `checkCostCap()` now sums the legacy `costMicrodollars` reader and
the surrogate so a runaway subagent can still trip
`HYDRA_PER_CYCLE_COST_CAP_USD` even though codex is gone.

