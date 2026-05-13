// ---------------------------------------------------------------------------
// Priorities-doc tier — fallback when no other anchor source has work
// ---------------------------------------------------------------------------
//
// Handles:
//   - saturation gate (issue #285): when last N doc cycles were all drift-
//     rejected, return no-work to break the loop. The doc is refreshed
//     out-of-band by `/hydra-target-research` (operator-scheduled) rather
//     than inline (issue #347, Phase A codex-removal refactor).
//   - drift pre-filter on the returned anchor

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_PATH } from "./constants.ts";
import { isAnchorDriftDuplicate } from "./drift-filter.ts";

export interface DocAnchor {
  type: "doc";
  reference: string;
  whyNow: string;
  context: string;
}

/**
 * Build the priorities-doc fallback anchor, returning `null` when the doc is
 * missing, the saturation gate fires, or the candidate is itself
 * drift-rejected.
 *
 * Note: this tier no longer triggers inline priorities-refresh codex calls.
 * priorities.md is owned by `/hydra-target-research` (operator-scheduled).
 * When saturation or staleness is detected, the tier returns no-work and the
 * caller continues anchor selection (or records a noWork outcome) — the next
 * research cycle will refresh the doc.
 */
export async function selectPrioritiesDocAnchor(
  _grounding: any,
): Promise<DocAnchor | null> {
  try {
    const priorities = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
    const DOC_REF = "direction/priorities.md";

    // Issue #285 / #347: pre-planner saturation gate. If the last N consecutive
    // doc-anchor cycles were ALL drift-rejected, the priorities doc is
    // semantically stale even if the file hasn't been touched — the planner
    // keeps generating titles that drift-match recent merges. Return no-work
    // so the scheduler records a noWork outcome WITHOUT a frontier-tier
    // planner call. The doc will be refreshed by the next
    // `/hydra-target-research` run.
    const { isDocAnchorSaturated } = await import("../anchor-actionability.ts");
    const saturation = await isDocAnchorSaturated("doc", DOC_REF);
    if (saturation.saturated) {
      console.log(`[ControlLoop] Doc-anchor saturated: ${saturation.reason} — returning no-work (priorities.md refresh deferred to /hydra-target-research)`);
      return null;
    }

    // Check how many recent cycles used this same anchor (any outcome). Logged
    // for visibility only — staleness no longer triggers an inline refresh.
    const recentDocCycles = await (async () => {
      try {
        const { getMetricsTrend } = await import("../metrics.ts");
        const trend = await getMetricsTrend(10);
        return trend.filter((m: any) => m.anchorType === "doc" && m.anchorReference === DOC_REF).length;
      } catch (err: any) {
        console.error(`[ControlLoop] Failed to check recent doc-cycle trend: ${err.message}`);
        return 0;
      }
    })();

    if (recentDocCycles >= 5) {
      // Priorities doc looks stale — surface this for operator visibility, but
      // do not trigger an inline refresh. `/hydra-target-research` owns the
      // doc; the operator should run it (or it should be scheduled) when this
      // log appears repeatedly.
      console.log(`[ControlLoop] Priorities doc used ${recentDocCycles}x in last 10 — refresh deferred to /hydra-target-research`);
    }

    const candidate: DocAnchor = {
      type: "doc",
      reference: DOC_REF,
      whyNow: recentDocCycles >= 5
        ? `Priorities doc (used ${recentDocCycles}x recently — refresh deferred to /hydra-target-research)`
        : "Next priority from operator direction document",
      context: priorities,
    };
    // Drift pre-filter (issue #233) — symmetry with queue/reframe sources.
    // The doc reference itself ("direction/priorities.md") doesn't typically
    // match recent task titles, so this is a near-no-op today. Kept here so
    // a future planner that emits a deterministic anchor.reference (e.g.
    // first heading from priorities.md) is automatically guarded.
    const driftResult = await isAnchorDriftDuplicate(candidate);
    if (driftResult.drift) {
      console.log(`[ControlLoop] Priorities-doc anchor pre-filtered as drift duplicate — returning no-work`);
      return null;
    }
    return candidate;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[ControlLoop] selectAnchor: failed to read priorities.md: ${err.message}`);
    }
    return null;
  }
}
