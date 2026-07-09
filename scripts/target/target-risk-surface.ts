/**
 * Target risk-surface resolver for the gate/script call sites (epic #3014,
 * ADR-0026, issue #3018).
 *
 * # What this is (and what it replaced)
 *
 * ADR-0026 makes `classifyRisk(paths, surface, appSubdir)`
 * (`src/target/risk-critical.ts`) take the risk surface as an ARGUMENT sourced
 * from the target's `.hydra/manifest.json` (`riskCritical.surface` +
 * `verify.appSubdir`). Slice #3017 flipped the classifier signature and stood up
 * a TRANSITIONAL const (`betting-risk-surface.ts`) so the gate scripts stayed
 * green without threading the manifest. THIS slice (#3018) deletes that const and
 * threads the real `loadManifest` read through the gate/script sites — each site
 * sources its surface here, at runtime, from the manifest that ships in the
 * target repo.
 *
 * # Read-fresh, fail-closed (ADR-0026 decisions 6 + 7)
 *
 * `loadRiskSurface(rootDir?)` calls the leaf `loadManifest` (which reads
 * `<rootDir>/.hydra/manifest.json` fresh on every call, never throws, and fails
 * CLOSED on a missing/malformed manifest). This resolver preserves that
 * contract: it NEVER throws and returns a discriminated result object, so a gate
 * that cannot resolve its surface fails loudly with an operator-facing error
 * rather than silently classifying every path as "safe" (which would disable the
 * keystone risk gate — exactly the silent-bypass ADR-0026 decision 7 forbids).
 *
 * # Root resolution (ADR-0026 decision 1)
 *
 * The manifest lives in the target repo at `<workspace>/.hydra/manifest.json`.
 * The `rootDir` the gate reads from depends on the call context:
 *   - A synced-gate invocation inside a Target worktree passes `TARGET_MANIFEST_ROOT`
 *     (the worktree root — the PARENT of the `web/` appDir the runner uses).
 *   - An in-process caller omits `rootDir`, so it falls back to the resolved
 *     target workspace via `getTargetWorkspace()` (read-only import; ADR-0002 seam).
 *
 * `src/target-config.ts` is imported READ-ONLY for the workspace fallback — this
 * slice does not modify it (it is the out-of-scope identity seam). The env var
 * override keeps the gate scripts decoupled from the long-running service's
 * process env when they run from a Target worktree.
 */
import { loadManifest } from "../../src/target/manifest.ts";
import type { RiskSurface } from "../../src/target/risk-critical.ts";
import { getTargetWorkspace } from "../../src/target-config.ts";

/**
 * The resolved risk surface + app subdir for a target, sourced from its manifest.
 * A discriminated result object — never a thrown exception. Callers pass
 * `.surface` + `.appSubdir` straight into `classifyRisk`.
 */
export type ResolveRiskSurfaceResult =
  | { ok: true; surface: RiskSurface; appSubdir: string }
  | { ok: false; errors: string[] };

/**
 * Resolve the manifest root directory for a gate/script invocation.
 *
 * Precedence:
 *   1. `TARGET_MANIFEST_ROOT` env var (the Target worktree root, set by the
 *      synced-gate invocation — the parent of the `web/` appDir).
 *   2. `getTargetWorkspace()` (the ADR-0002 identity seam) for an in-process
 *      caller that omits an explicit root.
 *
 * An empty-string env value is treated as unset.
 */
export function resolveManifestRoot(): string {
  const fromEnv = process.env.TARGET_MANIFEST_ROOT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return getTargetWorkspace();
}

/**
 * Load the target's risk surface + app subdir from `<rootDir>/.hydra/manifest.json`.
 *
 * Never throws. On success returns `{ ok:true, surface, appSubdir }`; on any
 * manifest failure (missing / malformed / schema-invalid) returns
 * `{ ok:false, errors }` (the `loadManifest` errors verbatim) so the caller can
 * fail the gate loudly instead of silently degrading to an all-safe
 * classification.
 *
 * @param rootDir the target workspace/worktree root; defaults to
 *   {@link resolveManifestRoot} (env override → target workspace).
 */
export function loadRiskSurface(rootDir: string = resolveManifestRoot()): ResolveRiskSurfaceResult {
  const result = loadManifest(rootDir);
  if (!result.ok) {
    // `loadManifest` already logged each `[target-manifest]`-prefixed error.
    return { ok: false, errors: (result as { ok: false; errors: string[] }).errors };
  }
  return {
    ok: true,
    surface: result.manifest.riskCritical.surface,
    appSubdir: result.manifest.verify.appSubdir,
  };
}
