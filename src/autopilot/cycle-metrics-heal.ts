/**
 * Autopilot **cycle-metrics anchorType heal** — the focused leaf that owns the
 * enrichment-path anchorType HEAL (issue #3604), extracted out of the
 * `cycle-close.ts` coordinator in issue #3627.
 *
 * The cycle-close coordinator (`recordCycle`) sequences three *lifecycle
 * accounting* writes per reap — the cycle hash + index, the lifetime scheduler
 * counters, and the per-cycle metrics hash. The anchorType heal is a
 * qualitatively different, *data-quality repair* concern: on the dedup/enrichment
 * arm it inspects the STORED anchorType and, when it is a data-quality sentinel,
 * re-classifies it from the newly-arrived decode sources via the SAME never-guess
 * parser reap uses at first-write. That concern was the reason #3604 added a
 * FIFTH Redis-adapter import edge (`redis/cycle-metrics`) to an already-wide
 * coordinator — extracting it here removes that edge from the coordinator (it now
 * lives behind the injected `metrics` facade in this leaf).
 *
 * This mirrors the `outcome-record.ts` extraction (issue #3323), pulled from THIS
 * same coordinator: an additive + best-effort I/O leaf that receives the injected
 * facade (a structural super-type of `CycleCloseDeps`) rather than importing the
 * Redis adapter directly, so it stays testable without the full deps bag. Same
 * structure here — the heal is an I/O leaf, not a pure policy leaf like
 * `anchor-type.ts` (`healSentinelAnchorType` reads the stored metrics hash and
 * writes a recovered class).
 *
 * The heal is ADDITIVE and BEST-EFFORT: a failure logs and never alters the
 * caller's `CycleRecordResult` or blocks the reap path (observability, not
 * correctness). Errors are swallowed-and-logged (dark-tolerant), matching the
 * `merge/grounding/verification` never-throw convention in CLAUDE.md.
 *
 * The pure `isSentinelAnchorType` predicate moves with the heal (its sole caller)
 * and is exported for reuse: the metrics READ path (`metrics/trend.ts` /
 * `metrics/aggregate.ts`) can import the same sentinel test if it ever needs it,
 * rather than re-implementing the sentinel-set.
 */

import type { CycleRecordBody } from "./schemas.ts";
// Anchor-type classification POLICY — the pure, zero-I/O leaf extracted in
// issue #2858. The heal re-classifies via `classifyAnchorType` (the SAME
// never-guess parser reap uses at first-write) and compares against the
// `UNCLASSIFIED_ANCHOR_TYPE` sentinel.
import { classifyAnchorType, UNCLASSIFIED_ANCHOR_TYPE } from "./anchor-type.ts";
import type { CycleMetricsInput } from "../metrics/record.ts";
import { logger } from "../logger.ts";

/**
 * The per-cycle metrics seam the heal needs: the additive-HSET writer plus the
 * OPTIONAL stored-hash reader. Deliberately NOT the full `CycleCloseDeps` bag —
 * the leaf's concern is the metrics-hash anchorType repair, so it accepts only
 * that facade (issue #3627). `CycleCloseDeps` exposes a `metrics` field of this
 * shape, so the coordinator passes `deps.metrics` here directly.
 *
 * `getCycleMetrics` is OPTIONAL: a facade that omits it (older test fixtures)
 * simply skips the heal — it is best-effort observability, not correctness, so a
 * missing reader degrades to the prior behaviour.
 */
export interface CycleMetricsHealFacade {
  recordCycleMetrics(cycleId: string, metrics: CycleMetricsInput): Promise<void>;
  getCycleMetrics?(cycleId: string): Promise<Record<string, string>>;
}

/**
 * Is a stored anchorType a data-quality SENTINEL — a value the enrichment-path
 * heal is allowed to overwrite (issue #3604)? True for the explicit
 * `unclassified` sentinel, the aggregator's catch-all `unknown`, and every
 * absent/blank form (`""`, missing, and the `String(null)`/`String(undefined)`
 * flattenings a pre-#2689 write could persist). A genuine class
 * (`work-queue`/`qa-review`/…) returns false, so the heal never clobbers it.
 */
export function isSentinelAnchorType(stored: string | undefined): boolean {
  const t = (stored ?? "").trim().toLowerCase();
  return (
    t.length === 0 ||
    t === UNCLASSIFIED_ANCHOR_TYPE ||
    t === "unknown" ||
    t === "null" ||
    t === "undefined"
  );
}

/**
 * Enrichment-path anchorType HEAL (issue #3604). When an already-recorded
 * cycle's STORED anchorType is a {@link isSentinelAnchorType} data-quality
 * sentinel, re-classify from the newly-arrived decode sources on THIS
 * enrichment write — the explicit `body.anchorType`, the merged PR's head-branch
 * `body.worktreeBranch`, and the cycleId — via the SAME never-guess
 * {@link classifyAnchorType} parser reap uses at first-write. If a REAL
 * (non-sentinel) class is recovered, upgrade the stored anchorType in place with
 * a metrics-hash-only additive HSET (no lifetime counter re-fire). Returns true
 * iff it wrote a heal.
 *
 * Safety contract (mirrors the write-path invariants):
 *   - NEVER-DOWNGRADE / NEVER-OVERWRITE: fires ONLY when the stored value is a
 *     sentinel, so a genuine class is never clobbered — even if a later
 *     enrichment forwards a differently-decodable source.
 *   - NEVER-GUESS (#2822): the recovered value is written ONLY when it is itself
 *     a real class; an undecodable follow-up leaves `classifyAnchorType`
 *     returning the sentinel, which we do NOT re-write (the stored sentinel
 *     already stands).
 *
 * Best-effort: a read/write failure is logged and never alters the caller's
 * result — the heal is observability, not correctness.
 */
export async function healSentinelAnchorType(
  cycleId: string,
  body: CycleRecordBody,
  metrics: CycleMetricsHealFacade,
): Promise<boolean> {
  // A facade without a metrics reader (older fixtures) skips the heal — it is
  // best-effort observability, so the absence degrades to the prior behaviour.
  if (typeof metrics.getCycleMetrics !== "function") return false;
  try {
    const stored = await metrics.getCycleMetrics(cycleId);
    if (!isSentinelAnchorType(stored?.anchorType)) return false;
    const recovered = classifyAnchorType(cycleId, body.anchorType, body.worktreeBranch);
    // Only heal to a REAL class — if the parser still returns the sentinel there
    // was nothing new to decode, so leave the stored sentinel untouched (#2822).
    if (isSentinelAnchorType(recovered)) return false;
    await metrics.recordCycleMetrics(cycleId, { anchorType: recovered });
    return true;
  } catch (err: any) {
    logger.error(
      { cycleId, err },
      "cycle-close: enrichment-path anchorType heal failed (best-effort)",
    );
    return false;
  }
}
