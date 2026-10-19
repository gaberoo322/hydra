/**
 * The single "did this metrics-trend row merge a PR?" predicate (issue #4747).
 *
 * Pure leaf: no Redis, no I/O. Every merge-rate / cost-per-merge reader routes
 * through {@link countsAsMerge} instead of re-implementing `tasksMerged > 0`,
 * because `tasksMerged=1` is also written for every `completed` dispatch
 * (dev rows before their PR merges, every grill row, every qa-review row).
 *
 * The `tasksMerged` WRITE semantics are unchanged (the Empty Cycle predicate,
 * which uses `=== 0`, stays in lockstep with the writer and is NOT routed here).
 */

import { ANCHOR_TYPE_BY_CLASS } from "../autopilot/anchor-type.ts";

/** anchorTypes of classes that never merge a PR: qa_orch/qa_target -> qa-review, design_concept_orch -> grill. */
export const NON_MERGING_ANCHOR_TYPES: ReadonlySet<string> = new Set([
  ANCHOR_TYPE_BY_CLASS.qa_orch,
  ANCHOR_TYPE_BY_CLASS.qa_target,
  ANCHOR_TYPE_BY_CLASS.design_concept_orch,
]);

/**
 * True only when the row carries `tasksMerged > 0`, is not a non-merging anchor
 * type, AND has merge evidence: `status === "merged"` when status is present,
 * else (legacy row, 7-day TTL tail) a non-empty `prNumber`. Never throws.
 */
export function countsAsMerge(row: unknown): boolean {
  if (row === null || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  if (!(Number(r.tasksMerged) > 0)) return false;
  if (typeof r.anchorType === "string" && NON_MERGING_ANCHOR_TYPES.has(r.anchorType.trim())) {
    return false;
  }
  if (r.status !== undefined && r.status !== null) {
    return String(r.status).trim().toLowerCase() === "merged";
  }
  return r.prNumber !== undefined && r.prNumber !== null && String(r.prNumber).trim() !== "";
}
