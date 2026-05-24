// ---------------------------------------------------------------------------
// Codebase-health tier — reductive improvements (split, consolidate, document)
// ---------------------------------------------------------------------------
//
// Extracted from selectAnchor() so the priority chain reads as a list of tier
// dispatches rather than 100+ lines of inline analysis. Skip rules:
//   - already-resolved-within-24h (issue #25)
//   - circuit-breaker counter > 0 OR permanent-skip >= 2 (issue #147)
//   - confidence gate: no failing tests AND no type errors (issue #147)

import { readAbandonment, readPermSkip } from "../redis/anchors.ts";
import { isHealthAnchorResolved } from "../redis/health-anchor.ts";
import { markLowConfidenceSkip } from "./low-confidence.ts";

export interface CodebaseHealthAnchor {
  type: "codebase-health";
  reference: string;
  whyNow: string;
  context: string;
  description: string;
}

/**
 * Run codebase-health analysis and return the first eligible anchor, or null
 * if none survive the skip/confidence filters.
 *
 * Pure orchestration: reads from Redis + invokes analyzeCodebaseHealth.
 * Mutates only via markLowConfidenceSkip when the confidence gate fires.
 */
export async function selectCodebaseHealthAnchor(
  grounding: any,
): Promise<CodebaseHealthAnchor | null> {
  try {
    const { analyzeCodebaseHealth } = await import("../codebase-health.ts");
    const healthReport = await analyzeCodebaseHealth(grounding.fileTree || "", undefined);
    for (const issue of healthReport.issues) {
      const ref = `codebase-health: ${issue.category} in ${issue.file}`;
      // Check if this health anchor was recently resolved (issue #25)
      const resolved = await isHealthAnchorResolved(ref);
      if (resolved) {
        console.log(`[ControlLoop] Skipping resolved codebase-health issue "${ref}" — already merged within 24h`);
        continue;
      }
      // Check both the circuit-breaker counter AND a permanent skip counter
      const abandonCount = await readAbandonment(ref);
      const permSkipCount = await readPermSkip(ref);
      if (abandonCount > 0 || permSkipCount >= 2) {
        console.log(`[ControlLoop] Skipping codebase-health issue "${ref}" (abandoned=${abandonCount}, permSkip=${permSkipCount}) — falling through`);
        continue;
      }
      // Confidence gate (issue #147): skip health anchors when grounding has
      // no failing tests and no type errors — these are low-confidence and tend
      // to produce "Planner produced no task" abandonments.
      const hasGroundingSignal =
        (grounding.testReport?.failed ?? 0) > 0 ||
        (grounding.typecheckReport?.errors ?? 0) > 0;
      if (!hasGroundingSignal) {
        console.log(`[AnchorSelection] low-confidence-skip: codebase-health anchor skipped (no failing tests or type errors) — "${ref}"`);
        await markLowConfidenceSkip({ type: "codebase-health", reference: ref });
        continue;
      }

      console.log(`[ControlLoop] Codebase health anchor: ${issue.category} — ${issue.file} (${issue.metric})`);
      return {
        type: "codebase-health",
        reference: ref,
        whyNow: healthReport.summary,
        context: issue.suggestion,
        description: issue.suggestion,
      };
    }
    if (healthReport.issues.length > 0) {
      console.log(`[ControlLoop] All ${healthReport.issues.length} codebase-health issues previously abandoned — skipping to priorities doc`);
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Codebase health analysis failed: ${err.message}`);
  }
  return null;
}
