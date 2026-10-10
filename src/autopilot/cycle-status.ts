/**
 * Autopilot **cycle-status taxonomy** — the cross-cutting domain fact of which
 * recorded cycle statuses count as *merged* vs *failed*.
 *
 * Extracted from `run-projections.ts` (issue #2548). The status sets were
 * originally defined in the read-projection module because the digests needed
 * them first, but "which statuses are merged vs failed" is a domain invariant
 * the WRITE path establishes (`recordCycle` in `runs.ts` buckets a cycle into a
 * terminal status) and BOTH read sides consume (`retro-projections.ts`'s
 * `bucketOf`, `run-projections.ts`'s `projectRunDigest`). Homing the taxonomy in
 * a neutral module flattens that backwards dependency — the writer no longer
 * reaches into a downstream read-projection module for a constant it owns the
 * meaning of.
 *
 * Pure constants + one pure predicate. No Redis, no clock, no I/O.
 *
 * Note (issue #1919): this module is the canonical home of the TWO-way
 * merged/failed split only. The write-side THREE-way bucketing
 * (merged / failed / *unaccounted*) lives in `recordCycle` — a status in
 * NEITHER set is "unaccounted" so the `cyclesRun == merged + failed +
 * unaccounted` identity holds. The read sites have no unaccounted concept, so
 * the shared predicate intentionally returns `null` (not a third bucket) for a
 * status in neither set.
 */

/**
 * Status values that count toward `cycles-merged` (vs `cycles-failed`).
 * Aligned with the autopilot taxonomy: a "cycle" merged when the dispatched
 * subagent landed a PR.
 */
export const MERGED_STATUSES: ReadonlySet<string> = new Set([
  "merged",
  "completed",
  "succeeded",
]);

/**
 * Status values that count toward `cycles-failed`: the cycle abandoned, timed
 * out, or its PR closed unmerged.
 */
export const FAILED_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "abandoned",
  "aborted",
  "timeout",
  "timed-out",
]);

/**
 * Shared two-way bucketing predicate. Lowercases `status` before the membership
 * test (every call site did this independently — the predicate preserves it so
 * there is no case-handling regression). Returns `null` for a null/empty status
 * or one in NEITHER set; the write path layers its own "unaccounted" third
 * bucket on top of this `null` (issue #1919).
 */
export function bucketCycleStatus(
  status: string | null | undefined,
): "merged" | "failed" | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (MERGED_STATUSES.has(s)) return "merged";
  if (FAILED_STATUSES.has(s)) return "failed";
  return null;
}

/**
 * READ-side four-way dispatch-outcome bucketing (issue #4856, the #4343
 * pattern applied to the retro-bundle read sites). Autopilot reaps record a
 * dispatch's terminal status as `completed` regardless of what it produced,
 * and `MERGED_STATUSES` contains `completed` because the WRITE side's
 * three-way identity depends on it — so {@link bucketCycleStatus} maps every
 * normally-ended dispatch to `"merged"`, and a read surface that asks "did
 * this dispatch land a PR?" gets a confident yes for a QA FAIL, a 28-second
 * no-op hand-off, anything. This predicate splits that conflation WITHOUT
 * touching the write side:
 *
 *   - the LITERAL `merged` status → `"merged"` — a confirmed merge (the
 *     `completed → merged` upgrade the merge-watch / cycle-merge-reconcile
 *     backstop posts when a PR is confirmed landed; a true-but-undercounted
 *     signal because the reconcile horizon is bounded);
 *   - every OTHER `MERGED_STATUSES` member (`completed`, `succeeded`) →
 *     `"completed"` — a finished session with no confirmed merge;
 *   - `FAILED_STATUSES` → `"failed"`;
 *   - anything else (null / unknown / in-flight) → `null`.
 *
 * Defines NO second status set — it reuses {@link MERGED_STATUSES} /
 * {@link FAILED_STATUSES} and the literal `"merged"` token, keeping this
 * module the one canonical home of the status taxonomy (#1919). The read
 * projections that must not conflate completion with merger —
 * `retro-projections.ts`'s `bucketOf` and `cross-run-trend.ts`'s fold — call
 * THIS predicate; `bucketCycleStatus` stays byte-identical for the write side
 * and the digest read that owns the three-way identity.
 */
export function bucketDispatchOutcome(
  status: string | null | undefined,
): "merged" | "completed" | "failed" | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === "merged") return "merged";
  if (FAILED_STATUSES.has(s)) return "failed";
  if (MERGED_STATUSES.has(s)) return "completed";
  return null;
}
