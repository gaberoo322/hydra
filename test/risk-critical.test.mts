/**
 * Regression tests for the risk-critical Target file-path classifier
 * (epic #3014, ADR-0026 — generalizes the betting-specific "money-critical"
 * classifier to a target-agnostic `classifyRisk(paths, surface, appSubdir)`).
 *
 * The classifier is the keystone the downstream Target gates route on. These
 * tests pin the two-level (risk-critical vs. safe) contract AND the ADR-0026
 * migration: the risk surface and the app subdir are ARGUMENTS (sourced from the
 * target's `.hydra/manifest.json`), NOT a hardcoded `MONEY_CRITICAL_TARGET_PATHS`
 * const in `src/`.
 *
 * `BETTING_SURFACE` / `BETTING_APP_SUBDIR` below are the six-glob betting surface
 * + `web` app subdir exactly as hydra-betting declares them in its manifest
 * (`riskCritical.surface` + `verify.appSubdir`, authored in #3016). Passing them
 * as arguments proves betting's gate still fires on the same six globs after the
 * const deletion.
 *
 * Pure tests — no Redis, no network, no spawn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRisk,
  isRiskCriticalPath,
  type RiskSurface,
} from "../src/target/risk-critical.ts";

/**
 * hydra-betting's declared risk surface — the six globs from its
 * `.hydra/manifest.json` `riskCritical.surface` plus the bin runner entrypoints.
 * The whole point of ADR-0026: this is TEST-LOCAL DATA passed as an argument, not
 * a const imported from `src/`.
 */
const BETTING_SURFACE: RiskSurface = [
  "src/lib/providers/",
  "src/lib/execution/",
  "src/lib/staking/",
  "src/lib/bet-math/",
  "src/lib/arbitrage/",
  "src/lib/markets/",
  "src/bin/",
];

/** hydra-betting's app subdir (manifest `verify.appSubdir`). */
const BETTING_APP_SUBDIR = "web";

describe("classifyRisk — betting's six globs classify as risk-critical (ADR-0026)", () => {
  test("flags a path under providers/", () => {
    const r = classifyRisk(["src/lib/providers/betfair.ts"], BETTING_SURFACE);
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/providers/betfair.ts"]);
  });

  test("flags a path under execution/", () => {
    const r = classifyRisk(["src/lib/execution/place-bet.ts"], BETTING_SURFACE);
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("flags a path under staking/", () => {
    const r = classifyRisk(["src/lib/staking/kelly.ts"], BETTING_SURFACE);
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/staking/kelly.ts"]);
  });

  test("flags a path under bet-math/", () => {
    const r = classifyRisk(["src/lib/bet-math/edge.ts"], BETTING_SURFACE);
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/bet-math/edge.ts"]);
  });

  test("flags a path under arbitrage/ (issue #1841)", () => {
    // Regression pin for the gap that auto-skipped the mutation gate on
    // arbitrage EV/ranking money math (e.g. the polymarket reward-adjusted
    // ranking). src/lib/arbitrage/ must classify as risk-critical and surface
    // in matchedPaths, both bare and web/-rooted.
    const r = classifyRisk(
      ["web/src/lib/arbitrage/polymarket-reward-adjusted-ranking.ts"],
      BETTING_SURFACE,
      BETTING_APP_SUBDIR,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, [
      "web/src/lib/arbitrage/polymarket-reward-adjusted-ranking.ts",
    ]);
    assert.equal(
      isRiskCriticalPath("src/lib/arbitrage/ev.ts", BETTING_SURFACE),
      true,
    );
  });

  test("flags a path under markets/ (issue #1850)", () => {
    // Regression pin for the gap that auto-skipped the mutation gate on
    // markets/ dislocation + fee-adjusted edge / candidate-ranking money math
    // (e.g. sports-candidate-ranking). src/lib/markets/ must classify as
    // risk-critical and surface in matchedPaths, both bare and web/-rooted.
    const r = classifyRisk(
      ["web/src/lib/markets/sports-candidate-ranking.ts"],
      BETTING_SURFACE,
      BETTING_APP_SUBDIR,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, [
      "web/src/lib/markets/sports-candidate-ranking.ts",
    ]);
    assert.equal(
      isRiskCriticalPath("src/lib/markets/x.ts", BETTING_SURFACE),
      true,
    );
  });

  test("all six betting globs (bare) classify as risk-critical", () => {
    // The acceptance criterion: betting's six globs still classify as
    // risk-critical when the surface is passed from the manifest.
    for (const dir of [
      "src/lib/providers/x.ts",
      "src/lib/execution/x.ts",
      "src/lib/staking/x.ts",
      "src/lib/bet-math/x.ts",
      "src/lib/arbitrage/x.ts",
      "src/lib/markets/x.ts",
      "src/bin/x.ts",
    ]) {
      assert.equal(
        isRiskCriticalPath(dir, BETTING_SURFACE),
        true,
        `${dir} must be risk-critical`,
      );
    }
  });

  test("flags the directory itself (no trailing slash)", () => {
    // The directory entry must match the bare directory path too, not only
    // children — mirrors the Verifier-Core matcher contract.
    const r = classifyRisk(["src/lib/providers"], BETTING_SURFACE);
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/providers"]);
  });

  test("normalizes a leading ./ before matching", () => {
    const r = classifyRisk(["./src/lib/execution/router.ts"], BETTING_SURFACE);
    assert.equal(r.riskCritical, true);
  });

  test("flags the web/-rooted trade-submitting bin runner (issue #1694)", () => {
    // Regression pin for the exact gap that shipped hydra-betting PR #117's
    // scan-to-submit loop without the gate: normalize strips web/ (the declared
    // appSubdir), leaving src/bin/..., which matches the bin/ surface entry.
    const r = classifyRisk(
      ["web/src/bin/arbitrage-auto-approval-runner.ts"],
      BETTING_SURFACE,
      BETTING_APP_SUBDIR,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, [
      "web/src/bin/arbitrage-auto-approval-runner.ts",
    ]);
  });

  test("flags a bare src/bin/ runner path (issue #1694)", () => {
    assert.equal(isRiskCriticalPath("src/bin/some-runner.ts", BETTING_SURFACE), true);
    // Directory itself (no trailing slash) matches too, mirroring the
    // Verifier-Core matcher contract pinned above for src/lib/providers.
    assert.equal(isRiskCriticalPath("src/bin", BETTING_SURFACE), true);
  });

  test("a mixed set is risk-critical if ANY path matches", () => {
    const r = classifyRisk(
      ["src/components/Button.tsx", "src/lib/execution/place-bet.ts", "README.md"],
      BETTING_SURFACE,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("collects every matched path across multiple risk surfaces", () => {
    const r = classifyRisk(
      [
        "src/lib/providers/betfair.ts",
        "src/lib/staking/kelly.ts",
        "src/lib/bet-math/edge.ts",
      ],
      BETTING_SURFACE,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, [
      "src/lib/providers/betfair.ts",
      "src/lib/staking/kelly.ts",
      "src/lib/bet-math/edge.ts",
    ]);
  });
});

describe("classifyRisk — appSubdir-driven normalization (ADR-0026, replaces hardcoded web/ strip)", () => {
  test("appSubdir strips the declared prefix so web/-rooted paths match", () => {
    // Every real hydra-betting source path is under web/ (its manifest
    // appSubdir), so the diff paths the classifier sees are web/-rooted. The
    // appSubdir argument — NOT a hardcoded 'web/' in normalize() — strips it.
    const r = classifyRisk(
      ["web/src/lib/providers/kalshi/margin-fee-tier-map-loader.ts"],
      BETTING_SURFACE,
      BETTING_APP_SUBDIR,
    );
    assert.equal(r.riskCritical, true);
    // matchedPaths reports the original (web/-rooted) input verbatim.
    assert.deepEqual(r.matchedPaths, [
      "web/src/lib/providers/kalshi/margin-fee-tier-map-loader.ts",
    ]);
  });

  test("web/-rooted bet-math + providers paths match via isRiskCriticalPath", () => {
    assert.equal(
      isRiskCriticalPath("web/src/lib/bet-math/edge.ts", BETTING_SURFACE, BETTING_APP_SUBDIR),
      true,
    );
    assert.equal(
      isRiskCriticalPath("web/src/lib/providers/kalshi/x.ts", BETTING_SURFACE, BETTING_APP_SUBDIR),
      true,
    );
  });

  test("a DIFFERENT appSubdir strips that prefix (not a hardcoded web/)", () => {
    // Proof the strip is genuinely the appSubdir argument: a target whose app
    // lives under app/ has its app/src/lib/providers/... path matched only when
    // appSubdir is "app". With the wrong subdir it does NOT match.
    assert.equal(
      isRiskCriticalPath("app/src/lib/providers/x.ts", BETTING_SURFACE, "app"),
      true,
    );
    assert.equal(
      isRiskCriticalPath("app/src/lib/providers/x.ts", BETTING_SURFACE, "web"),
      false,
    );
  });

  test("appSubdir='' (repo-root target) strips nothing; bare src/ paths still match", () => {
    // A repo-root target declares appSubdir '' (manifest allows the empty
    // string). Bare src/lib/... paths match; a web/-rooted path does NOT, since
    // nothing is stripped.
    assert.equal(isRiskCriticalPath("src/lib/staking/kelly.ts", BETTING_SURFACE, ""), true);
    assert.equal(isRiskCriticalPath("web/src/lib/staking/kelly.ts", BETTING_SURFACE, ""), false);
  });

  test("appSubdir defaults to '' when omitted (strip nothing)", () => {
    // Default arg parity with the explicit '' case.
    assert.equal(isRiskCriticalPath("src/lib/staking/kelly.ts", BETTING_SURFACE), true);
    assert.equal(isRiskCriticalPath("web/src/lib/staking/kelly.ts", BETTING_SURFACE), false);
  });
});

describe("classifyRisk — safe surfaces", () => {
  test("UI-only changes are safe", () => {
    const r = classifyRisk(
      ["src/components/Scoreboard.tsx", "src/pages/dashboard.tsx", "src/styles/theme.css"],
      BETTING_SURFACE,
    );
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("docs-only changes are safe", () => {
    const r = classifyRisk(["README.md", "docs/architecture.md"], BETTING_SURFACE);
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("config-only changes are safe", () => {
    const r = classifyRisk(
      ["tsconfig.json", "package.json", ".github/workflows/ci.yml"],
      BETTING_SURFACE,
    );
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("a web/-rooted UI path is safe (appSubdir strip must not over-match)", () => {
    // Stripping the appSubdir prefix must not accidentally flag a safe
    // web/-rooted path: web/src/components/... normalizes to src/components/...
    // which matches none of the risk surface entries.
    const r = classifyRisk(
      ["web/src/components/Scoreboard.tsx", "web/src/app/page.tsx"],
      BETTING_SURFACE,
      BETTING_APP_SUBDIR,
    );
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
    assert.equal(
      isRiskCriticalPath("web/src/lib/ui/button.ts", BETTING_SURFACE, BETTING_APP_SUBDIR),
      false,
    );
  });

  test("a sibling path that merely shares a prefix substring is NOT matched", () => {
    // "src/lib/providers-readme.md" shares the "src/lib/providers" prefix as a
    // raw substring but is not under the providers/ directory — the trailing
    // slash on the directory entry must prevent a false positive.
    const r = classifyRisk(["src/lib/providers-readme.md"], BETTING_SURFACE);
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
    // Same guard for the #1694 bin entry: bin-adjacent names are not bin/.
    assert.equal(isRiskCriticalPath("src/bin-utils/helper.ts", BETTING_SURFACE), false);
    assert.equal(
      isRiskCriticalPath("web/src/binding/x.ts", BETTING_SURFACE, BETTING_APP_SUBDIR),
      false,
    );
    // Same guard for the #1850 markets entry: markets-adjacent names are not
    // markets/ (the trailing-slash directory entry prevents the false positive).
    assert.equal(isRiskCriticalPath("src/lib/markets-readme.md", BETTING_SURFACE), false);
  });
});

describe("classifyRisk — edge cases (pure & total)", () => {
  test("empty input is safe", () => {
    const r = classifyRisk([], BETTING_SURFACE);
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("an empty surface flags nothing (fail-closed is the caller's job)", () => {
    // The classifier is pure: an empty surface simply matches nothing. The
    // manifest schema (superRefine) is what forbids an unacknowledged empty
    // surface — the classifier itself never fabricates risk.
    assert.equal(classifyRisk(["src/lib/staking/kelly.ts"], []).riskCritical, false);
    assert.equal(isRiskCriticalPath("src/lib/staking/kelly.ts", []), false);
  });

  test("non-array paths input degrades to safe rather than throwing", () => {
    // Intentionally passing a non-array to pin the runtime guard; cast keeps
    // the call well-typed without an (unused) @ts-expect-error directive.
    const r = classifyRisk(null as unknown as readonly string[], BETTING_SURFACE);
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("non-array surface degrades to safe rather than throwing", () => {
    assert.equal(
      isRiskCriticalPath("src/lib/staking/kelly.ts", null as unknown as RiskSurface),
      false,
    );
    const r = classifyRisk(
      ["src/lib/staking/kelly.ts"],
      null as unknown as RiskSurface,
    );
    assert.equal(r.riskCritical, false);
    assert.deepEqual(r.matchedPaths, []);
  });

  test("non-string and empty-string entries are ignored", () => {
    const r = classifyRisk(
      [
        "",
        // @ts-expect-error — intentionally mixing in a non-string entry.
        42,
        "src/lib/execution/place-bet.ts",
      ],
      BETTING_SURFACE,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("duplicate matched paths are de-duplicated in matchedPaths", () => {
    const r = classifyRisk(
      ["src/lib/execution/place-bet.ts", "src/lib/execution/place-bet.ts"],
      BETTING_SURFACE,
    );
    assert.equal(r.riskCritical, true);
    assert.deepEqual(r.matchedPaths, ["src/lib/execution/place-bet.ts"]);
  });

  test("empty-string entries in the surface are ignored (no accidental match-all)", () => {
    // A "" surface entry would prefix-match every path via startsWith; the
    // classifier skips empty entries so a sloppy surface never matches all.
    assert.equal(
      isRiskCriticalPath("src/components/Button.tsx", ["", "src/lib/staking/"]),
      false,
    );
  });
});

describe("classifier module — no hardcoded const, no 'money' vocabulary (ADR-0026)", () => {
  test("MONEY_CRITICAL_TARGET_PATHS is not exported (deleted per ADR-0026)", async () => {
    const mod = await import("../src/target/risk-critical.ts");
    assert.equal(
      "MONEY_CRITICAL_TARGET_PATHS" in mod,
      false,
      "the hardcoded betting const must be deleted; the surface is an argument",
    );
    assert.equal(
      "classifyTargetRisk" in mod,
      false,
      "the money-critical classifier name is renamed to classifyRisk",
    );
    assert.equal(
      "isMoneyCriticalPath" in mod,
      false,
      "the money-critical predicate name is renamed to isRiskCriticalPath",
    );
  });

  test("the module source contains no 'money' literal (ADR-0026 acceptance)", () => {
    // Read the classifier module source and assert 'money' is entirely gone —
    // "Money leaves src/ entirely" (ADR-0026 decision 4).
    // (Kept in-suite so the invariant travels with the classifier.)
    const src = readFileSyncForTest();
    assert.equal(
      /money/i.test(src),
      false,
      "no 'money' literal may remain in the classifier module",
    );
  });
});

// Helper hoisted below the suites for readability; reads the classifier module
// source relative to this test file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";
function readFileSyncForTest(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(pathJoin(here, "..", "src", "target", "risk-critical.ts"), "utf-8");
}
