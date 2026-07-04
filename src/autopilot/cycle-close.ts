/**
 * Autopilot **cycle-close** coordinator — the cross-domain orchestration point
 * for "a code-writing dispatch just finished; stamp the outcome record across
 * the runs (cycle-hash), metrics, and scheduler-counter domains."
 *
 * This Module was split out of `runs.ts` (issue #2768). `runs.ts` retains the
 * narrow **run/turn-lifecycle write** path (`startRun`/`endRun`/`recordTurn`/
 * `recordDispatchPr`/`recordReflectionOutcome`); this sibling owns the wider
 * `recordCycle` coordination, which pulls from three domains at once. It follows
 * the same per-concern sibling-extraction precedent as `run-projections.ts`
 * (read projections, #1183) and `sweep-reader.ts` (dead-pid sweep, #2568): one
 * Module per concern, a single one-directional `cycle-close → runs` import edge
 * for the shared result-type primitives.
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
 * `runs.ts` (their single source of truth, shared with the run/turn writers)
 * and are imported here. (The `ErrorCode` union that `Err` is built from stays
 * module-internal to `runs.ts` — it has no external importer.)
 */

import {
  initCycleHash,
  getCycleHash,
  addCycleToIndex,
} from "../redis/cycle-tracking.ts";
import {
  incrSchedulerCyclesRun,
  incrSchedulerCyclesMerged,
  incrSchedulerCyclesFailed,
  incrSchedulerCyclesUnaccounted,
} from "../redis/scheduler.ts";
import { recordCycleMetrics, type CycleMetricsInput } from "../metrics/record.ts";
import type { CycleRecordBody } from "./schemas.ts";
import { bucketCycleStatus } from "./cycle-status.ts";
// Shared result-type primitives + coercion helpers (single source of truth in
// runs.ts, used by both the run/turn writers and this cycle-close coordinator).
// One-directional edge: runs.ts never imports cycle-close.ts.
import { type Ok, type Err, errRedis, numberOrDefault } from "./runs.ts";

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
  now: Date.now,
};

// ---------------------------------------------------------------------------
// Helpers (cycle-close-only — sole caller is recordCycle)
// ---------------------------------------------------------------------------

/**
 * Sentinel anchorType for a cycle-record whose caller supplied no explicit,
 * non-empty anchorType (issue #2689). Making classification EXPLICIT here is
 * the server-side backstop that stops a cycle from silently bucketing as
 * "unknown" in the metrics aggregator (`src/metrics/aggregate.ts`, which maps
 * an absent/empty/whitespace anchorType to the literal string "unknown").
 *
 * Before this, `recordCycle` passed `anchorType: body.anchorType` straight
 * through and the field-stripping loop below deleted it when absent — so any
 * cycle-record POST that arrived without an anchorType (the schema field is
 * `.optional()`) landed as "unknown", a data-quality black hole invisible to
 * metrics-driven decisions (24% of recent cycles). "unknown" is a data-quality
 * FAILURE, not a valid terminal state; an explicit "unclassified" sentinel
 * makes the gap visible and attributable (and distinct from the aggregator's
 * catch-all "unknown", so a post-fix "unknown" bucket now means the record
 * predates this fix, never that classification silently fell through).
 */
export const UNCLASSIFIED_ANCHOR_TYPE = "unclassified";

/**
 * Map a dispatch-class slot name to its canonical anchorType, mirroring the
 * `case` mapping in `scripts/autopilot/dispatch.sh` (issue #2762).
 *
 * Used as a last-resort inference inside {@link classifyAnchorType} when the
 * caller did not supply an explicit anchorType but the cycleId embeds a slot
 * suffix we can decode (the `worktree-agent-*-{slot}` synthesised-branch
 * format that holdback-merge-watch.ts uses as its cycleId). The same mapping
 * lives in `dispatch.sh` so both writers agree on the vocabulary.
 */
const SLOT_ANCHOR_TYPE: Readonly<Record<string, string>> = {
  dev_orch: "work-queue",
  dev_target: "work-queue",
  qa_orch: "qa-review",
  qa_target: "qa-review",
  design_concept_orch: "grill",
  research_orch: "research",
  research_target: "research",
};

/**
 * Attempt to infer an anchorType from a synthesised worktree-branch cycleId
 * (format: `worktree-agent-{runToken}-t{N}-{slot}`). Returns the mapped
 * anchorType when the suffix is a known slot; returns `undefined` when the
 * cycleId does not match the pattern or the slot has no mapping.
 *
 * The `{runToken}` is `_synthesize_worktree_branch`'s (decide.py) shortened
 * runId — normally the first 8 hex chars of the run UUID, but the literal
 * `local` when `state.run_id` is absent (legacy/test callers). So the run-token
 * class is `[0-9a-z]+` (hex OR the `local` fallback), not hex-only. The mandatory
 * `-t{N}-` middle segment keeps this from matching the harness's own
 * `worktree-agent-<longhash>` branch names, which carry no turn/slot suffix.
 */
function inferAnchorTypeFromCycleId(cycleId: string): string | undefined {
  // Pattern: worktree-agent-<runToken>-t<N>-<slot>
  const m = /^worktree-agent-[0-9a-z]+-t\d+-(.+)$/.exec(cycleId);
  if (!m) return undefined;
  return SLOT_ANCHOR_TYPE[m[1]];
}

/**
 * Classify a cycle-record body's anchorType EXPLICITLY (issue #2689). Returns
 * the trimmed body value when the caller supplied a non-empty one; otherwise
 * tries to infer from the cycleId's slot suffix (issue #2762 — covers cycles
 * written by holdback-merge-watch.ts, which uses the synthesised worktreeBranch
 * as its cycleId and does not forward an anchorType). Falls back to
 * {@link UNCLASSIFIED_ANCHOR_TYPE} when neither source yields a value — never
 * `undefined`, so the metrics record always carries an explicit, non-empty
 * anchorType and can never fall into the aggregator's "unknown" bucket. A
 * `console.warn` surfaces the remaining gap (fail-loud convention) so a truly
 * unclassifiable cycle is still visible.
 *
 * Exported (issue #2803) so the direct-write path — POST /metrics/record in
 * `src/api/metrics.ts`, which calls `recordCycleMetrics` WITHOUT going through
 * `recordCycle` — can apply the identical classification and stop leaving its
 * cycles in the aggregator's "unknown" bucket (~30% of cycles).
 */
export function classifyAnchorType(cycleId: string, raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  // Issue #2762: holdback-merge-watch.ts calls recordCycle({cycleId, prNumber,
  // filesChanged}) with no anchorType. Its cycleId is the autopilot's synthesised
  // worktreeBranch (`worktree-agent-{8hex}-t{N}-{slot}`), whose slot suffix
  // encodes the dispatch class. Decode it to recover the anchorType without
  // requiring the caller to forward the field.
  const inferred = inferAnchorTypeFromCycleId(cycleId);
  if (inferred !== undefined) return inferred;
  console.warn(
    `[autopilot] recordCycle: cycle '${cycleId}' has no explicit anchorType — recording '${UNCLASSIFIED_ANCHOR_TYPE}' (data-quality gap; the caller should send a mapped anchorType)`,
  );
  return UNCLASSIFIED_ANCHOR_TYPE;
}

/**
 * Coerce a `filesChanged` body value (number | numeric-string | absent) into a
 * non-negative integer COUNT, or `undefined` when the field is absent/garbage
 * (issue #2063). Returning `undefined` — never 0 — for an absent field is what
 * preserves the "unknown / never-written" vs "measured zero" distinction the
 * 95.6%-empty-rate alert needs: an absent field is stripped from the metrics
 * object and never written, while an explicit 0 records a truthful zero-file
 * cycle. Negative / non-finite inputs clamp to `undefined` (treated as unknown)
 * so a malformed positional can never write a nonsense count.
 */
function filesChangedCount(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return undefined;
    return Math.floor(v);
  }
  if (typeof v === "string") {
    if (v.length === 0) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.floor(n);
  }
  return undefined;
}

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

      let enriched = false;
      if (Object.keys(enrichment).length > 0) {
        // recordCycleMetrics does an additive HSET, so this updates only the
        // enriched fields on the existing metrics hash — counters untouched.
        await deps.metrics.recordCycleMetrics(cycleId, enrichment);
        enriched = true;
      }
      return {
        ok: true,
        cycleId,
        status: existing.status,
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

    return { ok: true, cycleId, status, bucketed, deduped: false, enriched: false };
  } catch (err: any) {
    return errRedis(err);
  }
}
