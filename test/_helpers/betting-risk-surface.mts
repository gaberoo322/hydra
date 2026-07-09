/**
 * Hermetic betting risk-surface fixture for the Target gate-script tests
 * (epic #3014, ADR-0026, issue #3018).
 *
 * The Target gate pure functions (`evaluate`, `filterMoneyCriticalCandidates`,
 * `shouldCaptureDesignConcept`, `buildDesignConcept`, `classifyTargetQaPath`,
 * `classifyTargetQaVerdict`) now take the risk `surface`/`appSubdir` as
 * arguments sourced from the target's `.hydra/manifest.json` at runtime (via
 * `loadRiskSurface`). The tests must stay hermetic — no real betting checkout,
 * no `.hydra/manifest.json` on disk — so they pass THIS fixture explicitly.
 *
 * These six globs + `web` app subdir mirror hydra-betting's actual
 * `.hydra/manifest.json` (`riskCritical.surface` + `verify.appSubdir`), so the
 * tests exercise the same classification the production gate does. Betting data
 * living in a TEST fixture is fine — the ADR-0013/ADR-0026 invariant forbids
 * target vocabulary in `src/`, not in `test/`.
 */
import type { RiskSurface } from "../../src/target/risk-critical.ts";

/** hydra-betting's six risk globs + bin runners (mirrors the manifest surface). */
export const BETTING_RISK_SURFACE: RiskSurface = [
  "src/lib/providers/",
  "src/lib/execution/",
  "src/lib/staking/",
  "src/lib/bet-math/",
  "src/lib/arbitrage/",
  "src/lib/markets/",
  "src/bin/",
];

/** hydra-betting's app subdir (mirrors the manifest `verify.appSubdir`). */
export const BETTING_APP_SUBDIR = "web";
