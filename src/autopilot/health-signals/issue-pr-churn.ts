/**
 * Health-signal heuristic 4: issue/PR churn (issue #2866 — extracted from the
 * combined `autopilot/run-health.ts` heuristic bag).
 *
 * A run digest may carry an issue/PR ref the run worked (issue_ref / pr_ref /
 * anchor). When the same ref recurs across runs in the window without any
 * merged outcome on those runs, it is churning. The reader tolerates several
 * field-name aliases; refs are extracted defensively. This leaf owns that
 * heuristic and its file-private ref-extraction helper; it evolves with
 * dispatch-identity tracking independently of the other three evaluators.
 */

import {
  type AutopilotHealthThresholds,
  type RunDigest,
  type StuckSignal,
  type StuckSignalSeverity,
  toNum,
} from "./common.ts";

export function detectIssuePrChurn(
  history: RunDigest[],
  thresholds: AutopilotHealthThresholds,
): StuckSignal[] {
  // ref → { count, merged }
  const byRef = new Map<string, { count: number; merged: number }>();
  for (const run of history) {
    const refs = extractRefs(run);
    const mergedHere = toNum(run.merged_count);
    for (const ref of refs) {
      const prev = byRef.get(ref) ?? { count: 0, merged: 0 };
      prev.count += 1;
      prev.merged += mergedHere;
      byRef.set(ref, prev);
    }
  }

  const out: StuckSignal[] = [];
  for (const [ref, agg] of byRef) {
    if (agg.count < thresholds.churnMinRecurrences) continue;
    // If something merged on a run carrying this ref, it isn't pure churn.
    if (agg.merged > 0) continue;
    const severity: StuckSignalSeverity =
      agg.count >= thresholds.churnCriticalRecurrences ? "critical" : "warn";
    out.push({
      type: "issue-pr-churn",
      severity,
      summary: `${ref} was re-dispatched across ${agg.count} runs without resolving.`,
      evidence: {
        ref,
        recurrences: agg.count,
        windowRuns: history.length,
      },
    });
  }
  // Most-churned first within this heuristic; the top-level rank re-sorts by
  // severity but keeps this relative order for ties.
  out.sort((a, b) => toNum(b.evidence.recurrences) - toNum(a.evidence.recurrences));
  return out;
}

/**
 * Extract the issue/PR ref(s) a run digest worked. Tolerates several field
 * names (`issue_ref`, `issueRef`, `pr_ref`, `prRef`, `anchor`,
 * `anchor_reference`) since the digest shape is read-only here and we don't
 * want to couple to one exact key. Returns a de-duplicated list.
 */
function extractRefs(run: RunDigest): string[] {
  const candidate = run as Record<string, unknown>;
  const keys = [
    "issue_ref",
    "issueRef",
    "pr_ref",
    "prRef",
    "anchor",
    "anchor_reference",
    "anchorReference",
  ];
  const out = new Set<string>();
  for (const key of keys) {
    const v = candidate[key];
    if (typeof v === "string" && v.trim().length > 0) out.add(v.trim());
  }
  return Array.from(out);
}
