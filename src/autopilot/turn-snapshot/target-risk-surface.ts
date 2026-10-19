/**
 * turn-snapshot/target-risk-surface.ts — the Target risk-surface resolver
 * (ADR-0043 slice 4, issue #4932), moved out of `collect-state.sh`'s
 * `collect_target_risk_surface` (issue #4411).
 *
 * Emits the Target Manifest sub-object of the Target facts
 * (scripts/target/print-target-facts.ts `collectTargetFacts`, ADR-0026) as
 * `target_risk_surface_json=`; decide.py's `_normalize_target_risk_surface`
 * reads `.ok` / `.surfaceRepoRelative` and performs no manifest read of its
 * own. The facts are an injected dep — the CLI imports the facts module
 * directly instead of shelling out to `npx tsx print-target-facts.ts`.
 *
 * Fail CLOSED (ADR-0026 decision 7): facts without a manifest object, or a
 * facts read that throws, render as `{"ok": false, "errors": [...]}` —
 * decide.py withholds `wire_or_retire_target` on `ok:false`.
 */

import type { Classified, CollectorOutcome } from "./collector.ts";

export const TARGET_RISK_SURFACE_COLLECTOR = "target-risk-surface";

export interface TargetRiskSurfaceDeps {
  /** The Target facts (print-target-facts.ts's JSON shape). May throw. */
  readonly facts: () => unknown;
}

export interface TargetRiskSurfaceSnapshot {
  /** The manifest object verbatim, or the reason it could not be resolved. */
  readonly manifest: Classified<Record<string, unknown>>;
}

/** Resolve the manifest sub-object. Never throws. */
export async function collectTargetRiskSurface(deps: TargetRiskSurfaceDeps): Promise<CollectorOutcome<TargetRiskSurfaceSnapshot>> {
  let manifest: Classified<Record<string, unknown>>;
  try {
    const facts = deps.facts();
    const m = facts !== null && typeof facts === "object" && !Array.isArray(facts) ? (facts as Record<string, unknown>).manifest : undefined;
    manifest =
      m !== null && typeof m === "object" && !Array.isArray(m)
        ? { ok: true, value: m as Record<string, unknown> }
        : { ok: false, reason: "no manifest field" };
  } catch (err) {
    /* intentional: fail closed — the reason renders into the emitted {"ok": false, "errors": [...]} line */
    manifest = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return {
    collector: TARGET_RISK_SURFACE_COLLECTOR,
    value: { manifest },
    degraded: "reason" in manifest ? [{ field: "manifest", reason: manifest.reason }] : [],
    notes: [],
  };
}
