/**
 * Autopilot **cycle-close** coordinator — the cross-domain orchestration point
 * for "a code-writing dispatch just finished; stamp the outcome record across
 * the runs (cycle-hash), metrics, and scheduler-counter domains."
 *
 * This Module was split out of `runs.ts` (issue #2768). `runs.ts` retains the
 * narrow **run/turn-lifecycle write** path (`startRun`/`endRun`/`recordTurn`);
 * this sibling owns the wider
 * `recordCycle` coordination, which pulls from three domains at once. It follows
 * the same per-concern sibling-extraction precedent as `run-projections.ts`
 * (read projections, #1183) and `sweep-reader.ts` (dead-pid sweep, #2568): one
 * Module per concern, with a downward import edge into the zero-I/O leaf
 * `run-result.ts` for the shared result-type primitives (issue #3087).
 *
 * Concepts (see `CONTEXT.md`):
 *   - **Cycle record** — the per-dispatch outcome hash `hydra:cycle:<id>` plus
 *     its ZSET index membership, the metrics-hash feed, and the lifetime
 *     scheduler counters. `recordCycle` is its SOLE writer (ADR-0016/ADR-0012):
 *     it must NOT set `hydra:cycle:active`, the `:agents`/`:costs` sub-keys, or
 *     any `hydra:task:*` / `hydra:deps:*` keys.
 *
 * Errors are returned as result objects, never thrown, matching the
 * `merge/grounding/verification` convention in CLAUDE.md — the shared
 * `Ok`/`Err` result types and the `errRedis`/`numberOrDefault` helpers live in
 * the zero-I/O leaf `run-result.ts` (their single source of truth, shared with
 * the run/turn writers and the read orchestrators; issue #3087) and are imported
 * here. (The `ErrorCode` union that `Err` is built from stays module-internal to
 * that leaf — it has no external importer.)
 */

import {
  initCycleHash,
  getCycleHash,
  addCycleToIndex,
  updateCycleHash,
} from "../redis/cycle-tracking.ts";
import {
  incrSchedulerCyclesRun,
  incrSchedulerCyclesMerged,
  incrSchedulerCyclesFailed,
  incrSchedulerCyclesUnaccounted,
} from "../redis/scheduler.ts";
import { recordCycleMetrics, type CycleMetricsInput } from "../metrics/record.ts";
import {
  putDispatchOutcome,
  upgradeDispatchOutcome,
} from "../redis/dispatch-outcomes.ts";
import { getCycleTokensRaw } from "../redis/cost.ts";
import type { CycleRecordBody } from "./schemas.ts";
import { bucketCycleStatus } from "./cycle-status.ts";
// The dispatch-outcome record concern (issue #2942) — attribution
// instrumentation, extracted into its own focused leaf in issue #3323 so it is
// no longer entangled with the three lifecycle-accounting writes here. This
// coordinator calls `writeDispatchOutcomeRecord` on the first-write path and
// `upgradeDispatchOutcomeRecord` on the completed→merged dedup arm; the leaf
// owns the token resolution, record construction, and dark-tolerance contract,
// and it — not this coordinator — imports `redis/dispatch-outcomes.ts`.
import {
  writeDispatchOutcomeRecord,
  upgradeDispatchOutcomeRecord,
  type AutopilotDispatchOutcomesFacade,
} from "./outcome-record.ts";
// Shared result-type primitives + coercion helpers. They live in the zero-I/O
// leaf `run-result.ts` (issue #3087), imported DOWN from here — the same leaf
// the run/turn writers (`runs.ts`) import — so this write module no longer
// reaches sideways into the write-lifecycle module for its result types.
// `filesChangedCount` moved down there in issue #3323 (a second importer, the
// dispatch-outcome leaf, made the private helper a shared primitive).
import {
  type Ok,
  type Err,
  errRedis,
  numberOrDefault,
  filesChangedCount,
} from "./run-result.ts";
// Anchor-type classification POLICY — the pure, zero-I/O leaf extracted in
// issue #2858. `recordCycle` uses `classifyAnchorType` (and, transitively,
// `UNCLASSIFIED_ANCHOR_TYPE`) to classify a cycle-record's anchorType. The
// policy has no Redis imports and is exercisable with string inputs alone;
// keeping it in a named sibling means the read-path callers (`metrics/trend.ts`,
// `api/metrics.ts`) import it from its own home rather than from this write
// coordinator. See `anchor-type.ts` for the split rationale.
import { classifyAnchorType } from "./anchor-type.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CYCLE_TTL_SECONDS = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// Injectable cycle-close deps (split out of AutopilotRunsDeps, issue #2158/#2768)
//
// `recordCycle` touches THREE Redis-adjacent domains — the cycle-hash + index
// accessors, the lifetime scheduler counters, and the per-cycle metrics writer
// — plus the shared `now()` clock. The run/turn writers in `runs.ts` touch NONE
// of these (they use `deps.runs`/`deps.isPidAlive`/`deps.now`), so the deps bag
// splits cleanly along the extraction boundary: this Module defines the narrow
// `CycleCloseDeps`, and `AutopilotRunsDeps` keeps only `{ runs, isPidAlive, now }`.
//
// Default deps route through the exact same accessors + clock as before, so
// omitting the `deps` arg is byte-for-byte the previous production behaviour and
// the two production call sites (autopilot-lifecycle route, holdback-merge-watch
// chore) are unchanged apart from the import specifier.
// ---------------------------------------------------------------------------

/** Cycle-hash + index accessors `recordCycle` touches. */
interface AutopilotRunsCycleFacade {
  getCycleHash(cycleId: string): Promise<Record<string, string>>;
  initCycleHash(
    cycleId: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void>;
  addCycleToIndex(cycleId: string, score: number): Promise<void>;
  /**
   * Additive HSET of cycle-hash fields (issue #2860). Used ONLY by the
   * `completed→merged` status-upgrade on the dedup/enrichment path so the
   * cycle-hash `status` stays consistent with the metrics-hash `tasksMerged`
   * bump. Never re-initialises the hash and never fires a counter.
   */
  updateCycleHash(cycleId: string, fields: Record<string, string>): Promise<void>;
}

/** Lifetime scheduler counters `recordCycle` bumps (the #1919 buckets). */
interface AutopilotRunsSchedulerFacade {
  incrSchedulerCyclesRun(): Promise<number>;
  incrSchedulerCyclesMerged(): Promise<number>;
  incrSchedulerCyclesFailed(): Promise<number>;
  incrSchedulerCyclesUnaccounted(): Promise<number>;
}

/** The per-cycle metrics writer `recordCycle` feeds. */
interface AutopilotRunsMetricsFacade {
  recordCycleMetrics(cycleId: string, metrics: CycleMetricsInput): Promise<void>;
}

export interface CycleCloseDeps {
  cycle: AutopilotRunsCycleFacade;
  scheduler: AutopilotRunsSchedulerFacade;
  metrics: AutopilotRunsMetricsFacade;
  dispatchOutcomes: AutopilotDispatchOutcomesFacade;
  /**
   * Epoch-MS clock. A single source of truth: `*_epoch` seconds fields derive
   * via `Math.floor(now()/1000)` and ISO strings via `new Date(now())`.
   * Defaults to `Date.now`.
   */
  now: () => number;
}

const defaultCycleCloseDeps: CycleCloseDeps = {
  cycle: {
    getCycleHash,
    initCycleHash,
    addCycleToIndex,
    updateCycleHash,
  },
  scheduler: {
    incrSchedulerCyclesRun,
    incrSchedulerCyclesMerged,
    incrSchedulerCyclesFailed,
    incrSchedulerCyclesUnaccounted,
  },
  metrics: {
    recordCycleMetrics,
  },
  dispatchOutcomes: {
    put: putDispatchOutcome,
    upgrade: upgradeDispatchOutcome,
    readCycleTokens: getCycleTokensRaw,
  },
  now: Date.now,
};

// ---------------------------------------------------------------------------
// Helpers (cycle-close-only — sole caller is recordCycle)
//
// The dispatch-outcome record helpers (`resolveDispatchTokens`,
// `writeDispatchOutcomeRecord`) and the `filesChangedCount` coercion they used
// moved to focused leaves in issue #3323: the first two to `outcome-record.ts`
// (attribution instrumentation), `filesChangedCount` DOWN to `run-result.ts`
// (a shared zero-I/O coercion primitive with a second importer). The metrics
// path below still uses `filesChangedCount` (imported from `run-result.ts`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lifecycle: cycle-record
// ---------------------------------------------------------------------------

export type CycleRecordResult = Ok<{
  cycleId: string;
  status: string;
  // Issue #1919: "unaccounted" is the third terminal bucket — a status in
  // NEITHER MERGED_STATUSES nor FAILED_STATUSES (e.g. no-op / idle-drain /
  // dry-run / unknown). It still bumps cyclesRun + cyclesUnaccounted so the
  // run = merged + failed + unaccounted identity always holds. `null` is now
  // reserved for the dedup early-return (no counters touched at all).
  bucketed: "merged" | "failed" | "unaccounted" | null;
  deduped: boolean;
  // Issue #2063: true when a duplicate (already-recorded cycleId) post carried
  // NEW filesChanged/prNumber data that was written onto the existing metrics
  // hash. The count/bucket surface still no-ops (deduped:true, bucketed:null) —
  // enrichment updates the metrics record WITHOUT re-firing any lifetime
  // counter. A plain duplicate post with no new data stays `enriched:false`.
  enriched: boolean;
}> | Err;

/**
 * Record one autopilot turn's code-writing subagent outcome. Three
 * complementary writes:
 *   1. `hydra:cycle:<id>` hash + ZADD to `hydra:cycle:index`
 *   2. `recordCycleMetrics(...)` — feeds /api/metrics + scheduler's mergeRateWindow
 *   3. Lifetime counters on `hydra:scheduler:cycles-{run,merged,failed,unaccounted}`
 *      — issue #1919: every cyclesRun bump increments exactly one of
 *      {merged, failed, unaccounted}, so the run = merged + failed +
 *      unaccounted identity is queryable instead of an inferred subtraction.
 *
 * Idempotent on `cycleId`: if the hash already has a `status`, the
 * call is a no-op and returns `deduped: true`. Callers key by a
 * stable identifier (autopilot turn id, worktree branch) so retries
 * collapse cleanly.
 */
export async function recordCycle(
  body: CycleRecordBody,
  deps: CycleCloseDeps = defaultCycleCloseDeps,
): Promise<CycleRecordResult> {
  try {
    const cycleId = body.cycleId.trim();
    const status =
      typeof body.status === "string" && body.status.length > 0 ? body.status : "completed";

    // Idempotency + enrichment (issue #2063): if a status already exists the
    // count/bucket surface is already filed, so we NEVER re-fire a lifetime
    // counter or re-bucket — that invariant (counters fire exactly once per
    // cycleId) is preserved. BUT the reap-time write that filed this record had
    // no PR number (reap.py hardcodes pr_number=""), so it could not carry
    // filesChanged. The later merged/auto-merge follow-up write IS PR-aware, so
    // we let it ENRICH the already-recorded metrics hash with filesChanged (and
    // prNumber, if it newly arrived) instead of discarding it as a pure dedup.
    // A plain duplicate post carrying no new data stays a true no-op
    // (enriched:false), preserving AC4/AC9's "re-post does not double-count".
    const existing = await deps.cycle.getCycleHash(cycleId);
    if (existing && existing.status) {
      // Issue #2860: the `completed → merged` status UPGRADE.
      //
      // reap.py is the SOLE first-writer and always files a record at
      // status='completed' with tasksMerged UNSET (it runs BEFORE the merge
      // decision is known, #430). When that PR later lands, the merge-watch
      // enrichment (or the reconcile backstop) re-posts with status='merged' +
      // tasksMerged=1. But the pre-#2860 dedup branch only ever enriched
      // filesChanged/prNumber/duration and DROPPED the status + tasksMerged, so
      // an already-`completed` record's `tasksMerged` stayed 0 forever — and the
      // dashboard trend/aggregate reads `tasksMerged>0` as its SINGLE merged
      // predicate (metrics/aggregate.ts), so merged cycles showed 0% merged.
      //
      // This upgrades the metrics `tasksMerged` (and the cycle-hash `status`, so
      // the two stay consistent) WITHOUT touching any lifetime scheduler counter.
      // The counter invariant is preserved for free: 'completed' is already in
      // MERGED_STATUSES (cycle-status.ts), so the first write ALREADY bumped
      // `cyclesMerged` once — re-firing it here would double-count. The upgrade
      // is therefore metrics-hash-only, keeping "counters fire exactly once per
      // cycleId" intact. It fires ONLY for a `completed → merged` transition; an
      // existing 'merged'/'failed'/other status is terminal and never mutated.
      const incomingStatus =
        typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
      const existingStatus = existing.status.trim().toLowerCase();
      let statusUpgraded = false;
      if (existingStatus === "completed" && incomingStatus === "merged") {
        const upgradeMerged = numberOrDefault(body.tasksMerged, 1);
        await deps.metrics.recordCycleMetrics(cycleId, {
          tasksMerged: upgradeMerged > 0 ? upgradeMerged : 1,
        });
        await deps.cycle.updateCycleHash(cycleId, { status: "merged" });
        statusUpgraded = true;
      }

      const enrichFiles = filesChangedCount(body.filesChanged);
      const enrichPr = body.prNumber !== undefined ? String(body.prNumber) : undefined;
      const enrichment: CycleMetricsInput = {};
      if (enrichFiles !== undefined) enrichment.filesChanged = enrichFiles;
      if (enrichPr !== undefined && enrichPr.length > 0) enrichment.prNumber = enrichPr;
      // Issue #2364: forward a non-zero totalDurationMs on the dedup/enrichment
      // path too. The first write (reap-time `completed`) often lands a 0 span
      // (no slot start stamp, or — for qa_orch relay cycles — reap never wrote a
      // cycle-record at all and this follow-up is itself the first real write);
      // the post-merge `merged`/auto-merge follow-up is the writer that holds the
      // real duration. Without forwarding it here, that real span never reaches
      // recordCycleMetrics on the dedup path and the cycle stays `totalDurationMs=0`
      // despite merging. recordCycleMetrics enforces monotonic-max, so a 0 here
      // can never regress a stored non-zero — only a real span upgrades a stored 0.
      const enrichDuration = numberOrDefault(body.totalDurationMs, 0);
      if (enrichDuration > 0) enrichment.totalDurationMs = enrichDuration;

      let enriched = statusUpgraded;
      if (Object.keys(enrichment).length > 0) {
        // recordCycleMetrics does an additive HSET, so this updates only the
        // enriched fields on the existing metrics hash — counters untouched.
        await deps.metrics.recordCycleMetrics(cycleId, enrichment);
        enriched = true;
      }

      // Issue #2942: keep the durable per-dispatch outcome record's `outcome`
      // in lockstep with the cycle-hash status upgrade above. Fires ONLY on
      // the completed→merged transition (a plain dedup/enrichment post leaves
      // the record untouched — exactly one record per cycleId, put on the
      // first write below, upgraded in place here). Additive + best-effort:
      // a failure logs and never alters the returned CycleRecordResult. The
      // record-write logic lives in the `outcome-record.ts` leaf (issue #3323).
      if (statusUpgraded) {
        await upgradeDispatchOutcomeRecord(body, cycleId, enrichDuration, deps);
      }
      return {
        ok: true,
        cycleId,
        // Issue #2860: surface the upgraded status so a caller that just bumped
        // completed→merged observes 'merged', while a plain dedup still reports
        // the stored status.
        status: statusUpgraded ? "merged" : existing.status,
        bucketed: null,
        deduped: true,
        enriched,
      };
    }

    const source =
      typeof body.source === "string" && body.source.length > 0 ? body.source : "claude";
    const nowIso = new Date(deps.now()).toISOString();
    const startedAt = body.startedAt || nowIso;
    const completedAt = body.completedAt || nowIso;

    const total = numberOrDefault(body.total, 1);
    const completed = numberOrDefault(body.completed ?? body.tasksMerged, 0);
    const failed = numberOrDefault(body.failed ?? body.tasksFailed, 0);
    const abandoned = numberOrDefault(body.abandoned ?? body.tasksAbandoned, 0);

    await deps.cycle.initCycleHash(cycleId, {
      status,
      startedAt,
      completedAt,
      source,
      total: String(total),
      completed: String(completed),
      failed: String(failed),
      abandoned: String(abandoned),
    }, CYCLE_TTL_SECONDS);
    await deps.cycle.addCycleToIndex(cycleId, deps.now());

    const metrics: CycleMetricsInput = {
      source,
      // Issue #2689: classify EXPLICITLY. An absent/empty anchorType would be
      // stripped by the field-cleanup loop below and then bucket as "unknown"
      // in the aggregator — the data-quality failure that made 24% of cycles
      // invisible to metrics. classifyAnchorType always returns a non-empty
      // string (the caller's value, or the "unclassified" sentinel), so the
      // metrics record can never carry an absent anchorType.
      anchorType: classifyAnchorType(cycleId, body.anchorType),
      anchorReference: body.anchorReference,
      taskTitle: body.taskTitle,
      tasksAttempted: numberOrDefault(body.tasksAttempted, total),
      tasksMerged: numberOrDefault(body.tasksMerged ?? body.completed, completed),
      tasksFailed: numberOrDefault(body.tasksFailed ?? body.failed, failed),
      tasksAbandoned: numberOrDefault(body.tasksAbandoned ?? body.abandoned, abandoned),
      totalDurationMs: numberOrDefault(body.totalDurationMs, 0),
      prNumber: body.prNumber !== undefined ? String(body.prNumber) : undefined,
      // Issue #2063: the integer file-change COUNT, when the writer knew it
      // (the merged/auto-merge follow-up write). undefined → stripped below →
      // the field stays absent (truthful "unknown/never-written"); an explicit
      // 0 records a measured zero-file cycle. This is what makes the metrics
      // hash carry filesChanged instead of staying null on 95.6% of cycles.
      filesChanged: filesChangedCount(body.filesChanged),
      // Issue #2754: the grounding test-suite counts the code-writing dispatch
      // captured (total + passing, before + after). reap.py reads them from the
      // dispatch's grounding deposit and forwards them here. `filesChangedCount`
      // is reused as the non-negative-integer-or-undefined coercion: an absent
      // field is stripped by the loop below and stays absent (truthful
      // "unknown/never-written"), an explicit 0 records a measured zero-test
      // cycle. This is what stops `testsAfter` recording 0 on every cycle (the
      // coverage-trend observability regression the 2026-07-02 arch review
      // flagged). NUMERIC on the read side (aggregate.ts / trend.ts).
      testsBefore: filesChangedCount(body.testsBefore),
      testsAfter: filesChangedCount(body.testsAfter),
      testsPassingBefore: filesChangedCount(body.testsPassingBefore),
      testsPassingAfter: filesChangedCount(body.testsPassingAfter),
      // Issue #3269: the per-phase wall-clock spans reap.py forwards from the
      // dispatch's deposit (groundingDurationMs from groundProject, plus the
      // verification/planning/execution spans). `filesChangedCount` is reused as
      // the non-negative-integer-or-undefined coercion (matching testsBefore/
      // filesChanged): an absent field is stripped by the loop below and stays
      // absent (truthful "unknown/never-written"), an explicit 0 records a
      // measured zero-span cycle. These four are MONOTONIC in record.ts
      // (MONOTONIC_DURATION_FIELDS), so recordCycleMetrics enforces that a later
      // 0-carrying write never clobbers a stored non-zero span. This is the
      // plumbing that lets `groundingDurationMs` et al. stop recording null on
      // every cycle once the deferred measurement/deposit follow-up lands.
      groundingDurationMs: filesChangedCount(body.groundingDurationMs),
      verificationDurationMs: filesChangedCount(body.verificationDurationMs),
      planningDurationMs: filesChangedCount(body.planningDurationMs),
      executionDurationMs: filesChangedCount(body.executionDurationMs),
      // Issue #3338: the three cycle-COORDINATION spans (dispatch decision /
      // executor work / merge-wait latency). `filesChangedCount` is reused as the
      // non-negative-integer-or-undefined coercion (matching the #3269 phase spans
      // above): an absent field is stripped by the loop below and stays absent
      // (truthful "unknown/never-written"), an explicit 0 records a measured
      // zero-span. These three are MONOTONIC in record.ts, so recordCycleMetrics
      // enforces that a later 0-carrying write never clobbers a stored non-zero
      // span. This is the plumbing that lets the coordination spans ride the
      // metrics event-stream alongside the existing token/test-time observations.
      decisionLatencyMs: filesChangedCount(body.decisionLatencyMs),
      executionLatencyMs: filesChangedCount(body.executionLatencyMs),
      mergeLatencyMs: filesChangedCount(body.mergeLatencyMs),
      abandonReason: body.abandonReason,
      regressionIntroduced: body.regressionIntroduced === true ? true : undefined,
      autopilotTurnId: body.autopilotTurnId,
      worktreeBranch: body.worktreeBranch,
      // Issue #1136 (Slice 2 of #1119): PURE PASS-THROUGH of the planning-time
      // reflection bucket tokens the dispatch served itself. recordCycle MUST
      // NOT derive this — reap (the only caller) doesn't know what
      // `GET /api/reflections` served; the dispatch reports it back via reap's
      // deposit-file read. Persisting it is what makes `deriveReflectionMatchSource`
      // (src/metrics/trend.ts) read a real bucket instead of 'none' every cycle.
      // Absent body field → undefined → stripped below → stays absent ('none').
      reflectionSources:
        typeof body.reflectionSources === "string" && body.reflectionSources.length > 0
          ? body.reflectionSources
          : undefined,
    };
    for (const k of Object.keys(metrics)) {
      if (metrics[k] === undefined) delete metrics[k];
    }
    await deps.metrics.recordCycleMetrics(cycleId, metrics);

    await deps.scheduler.incrSchedulerCyclesRun();
    const twoWay = bucketCycleStatus(status);
    let bucketed: "merged" | "failed" | "unaccounted" = "unaccounted";
    if (twoWay === "merged") {
      await deps.scheduler.incrSchedulerCyclesMerged();
      bucketed = "merged";
    } else if (twoWay === "failed") {
      await deps.scheduler.incrSchedulerCyclesFailed();
      bucketed = "failed";
    } else {
      // Issue #1919: status in NEITHER set (no-op / idle-drain / dry-run /
      // unknown). Bump the third bucket so the run = merged + failed +
      // unaccounted identity always holds — every cyclesRun increment maps to
      // exactly one terminal bucket. Observability-only: MERGED/FAILED_STATUSES
      // membership is unchanged, so mergeRate / the rolling window / the
      // circuit breaker read identical values.
      await deps.scheduler.incrSchedulerCyclesUnaccounted();
      bucketed = "unaccounted";
    }

    // Issue #2942: persist the durable per-dispatch outcome record — the
    // write-time join of {run, turn, class} (parsed from the cycleId), skill
    // (taxonomy row), outcome (the cycle-hash status verbatim), tokens
    // (body → per-cycle token hash → null), and duration. AFTER the existing
    // hash/metrics/counter writes so recordCycle's pre-existing side effects
    // are byte-for-byte unchanged; best-effort so a record failure can never
    // alter the CycleRecordResult or block the reap path.
    await writeDispatchOutcomeRecord(body, cycleId, status, deps);

    return { ok: true, cycleId, status, bucketed, deduped: false, enriched: false };
  } catch (err: any) {
    return errRedis(err);
  }
}
