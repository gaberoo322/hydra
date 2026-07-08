/**
 * Transitional betting risk surface for the synced gate scripts (epic #3014,
 * ADR-0026).
 *
 * # Why this file exists (and is temporary)
 *
 * ADR-0026 deletes `MONEY_CRITICAL_TARGET_PATHS` from orchestrator `src/` and
 * makes `classifyRisk(paths, surface, appSubdir)` (`src/target/risk-critical.ts`)
 * take the risk surface as an ARGUMENT sourced from the target's
 * `.hydra/manifest.json`. That migration is delivered as two vertical slices:
 *
 *   - #3017 (this slice) — flips the classifier signature, renames
 *     money-critical → risk-critical, and deletes the const. It does NOT thread
 *     the manifest through the gate/script call sites.
 *   - #3018 (sibling slice) — threads the manifest read (`loadManifest`) through
 *     the ~8 gate/script sites so each site sources `surface` + `appSubdir` from
 *     `.hydra/manifest.json` at runtime, and DELETES this file.
 *
 * To keep #3017 self-contained and CI green, the gate scripts that route on the
 * classifier (`mutation-check.ts`, `target-qa-verdict.ts`,
 * `target-design-concept.ts`, `scripts/ci/target-risk-core-check.ts`) import the
 * betting surface from here instead of from `src/`. The DATA (betting globs) is
 * out of orchestrator `src/` — satisfying the ADR-0013 invariant — pending the
 * manifest wiring in #3018.
 *
 * The six risk globs match hydra-betting's `.hydra/manifest.json`
 * `riskCritical.surface` (authored in #3016). `BETTING_APP_SUBDIR` matches its
 * `verify.appSubdir` (`web`), the value `normalize()` strips.
 */
import type { RiskSurface } from "../../src/target/risk-critical.ts";

/**
 * hydra-betting's risk surface — the six globs whose edits handle real money
 * (providers / execution / staking / bet-math / arbitrage / markets) plus the
 * bin runner entrypoints that drive them. Mirrors the target's
 * `.hydra/manifest.json` `riskCritical.surface`. #3018 sources this from the
 * manifest at runtime and deletes this const.
 */
export const BETTING_RISK_SURFACE: RiskSurface = Object.freeze([
  "src/lib/providers/",
  "src/lib/execution/",
  "src/lib/staking/",
  "src/lib/bet-math/",
  "src/lib/arbitrage/",
  "src/lib/markets/",
  "src/bin/",
]);

/**
 * hydra-betting's app subdir — the prefix `normalize()` strips so a real
 * `web/src/lib/...` diff path matches the bare `src/lib/...` surface entries.
 * Mirrors the target's `.hydra/manifest.json` `verify.appSubdir`.
 */
export const BETTING_APP_SUBDIR = "web";
