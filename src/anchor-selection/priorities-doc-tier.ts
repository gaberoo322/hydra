// ---------------------------------------------------------------------------
// Priorities-doc tier — fallback when no other anchor source has work
// ---------------------------------------------------------------------------
//
// Handles:
//   - saturation gate (issue #285): refresh inline when last N doc cycles
//     were all drift-rejected
//   - staleness gate: refresh when the doc has been used >=5x in last 10 cycles
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
 * missing, the saturation gate fires + refresh fails, or the candidate is
 * itself drift-rejected.
 */
export async function selectPrioritiesDocAnchor(
  grounding: any,
): Promise<DocAnchor | null> {
  try {
    const priorities = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
    const DOC_REF = "direction/priorities.md";

    // Issue #285: pre-planner saturation gate. If the last N consecutive
    // doc-anchor cycles were ALL drift-rejected, the priorities doc is
    // semantically stale even if the file hasn't been touched — the planner
    // keeps generating titles that drift-match recent merges. Refresh inline
    // to break the loop; if refresh fails, fall through to no-work (caller
    // continues anchor selection or records a noWork outcome).
    const { isDocAnchorSaturated } = await import("../anchor-actionability.ts");
    const saturation = await isDocAnchorSaturated("doc", DOC_REF);
    if (saturation.saturated) {
      console.log(`[ControlLoop] Doc-anchor saturated: ${saturation.reason} — forcing inline priorities refresh (planner skipped, est ~$60+ saved)`);
      try {
        const { refreshPriorities } = await import("../priorities-refresh.ts");
        const refreshResult = await refreshPriorities({ grounding, trigger: "saturation" });
        if (refreshResult.ok) {
          console.log(`[ControlLoop] Priorities refreshed inline (saturation trigger, ${refreshResult.priorities?.split("\n").length || 0} lines)`);
          const updated = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
          return {
            type: "doc",
            reference: DOC_REF,
            whyNow: `Freshly refreshed priorities (doc-anchor saturated: ${saturation.consecutiveDriftCount} drift-rejected cycles)`,
            context: updated,
          };
        }
        console.error(`[ControlLoop] Saturation-triggered refresh failed: ${refreshResult.error} — returning no-work to break loop`);
      } catch (err: any) {
        console.error(`[ControlLoop] Saturation-triggered refresh threw: ${err?.message ?? err} — returning no-work to break loop`);
      }
      // Refresh failed: skip this cycle's doc anchor entirely. Returning null
      // lets the scheduler record a noWork outcome WITHOUT a frontier-tier
      // planner call. The next cycle will retry the saturation check (and
      // can refresh again, since refresh failures are transient).
      return null;
    }

    // Check how many recent cycles used this same anchor (any outcome)
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
      // Priorities doc is stale — too many cycles using the same doc.
      // Trigger a lightweight refresh using accomplishments + vision.
      console.log(`[ControlLoop] Priorities doc used ${recentDocCycles}x in last 10 — triggering inline refresh`);
      try {
        const { refreshPriorities } = await import("../priorities-refresh.ts");
        const refreshResult = await refreshPriorities({ grounding, trigger: "stale" });
        if (refreshResult.ok) {
          console.log(`[ControlLoop] Priorities refreshed inline (${refreshResult.priorities?.split("\n").length || 0} lines)`);
          // Re-read the updated file
          const updated = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
          return {
            type: "doc",
            reference: DOC_REF,
            whyNow: "Freshly refreshed priorities (stale doc detected)",
            context: updated,
          };
        }
      } catch (err: any) {
        console.error(`[ControlLoop] Inline priorities refresh failed: ${err.message}`);
      }
    }

    const candidate: DocAnchor = {
      type: "doc",
      reference: DOC_REF,
      whyNow: recentDocCycles >= 5
        ? `Priorities doc (used ${recentDocCycles}x recently)`
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
