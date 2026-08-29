/**
 * Unit tests for `src/holdback-policy.ts` — the pure Outcome-Holdback
 * tier-enrollment policy (issue #3095, anchoring the module extracted in
 * #2671).
 *
 * The module owns two deterministic predicates over env-read constants:
 *   - `isEnrolledTier`     — which tiers enroll in an Outcome Holdback watch.
 *   - `windowCyclesForTier` — how long the watch window runs for a tier.
 * plus (issue #4247) the `HOLDBACK_UNWATCHABLE_OUTCOMES` denylist naming the
 * leading outcomes that may never key a holdback auto-revert.
 *
 * Both predicates are pure tier arithmetic — no Redis, no filesystem, no event
 * bus — so those are pure unit tests with no fixture. They pin the
 * tier-membership + monotonic-window contract the module's docstring commits
 * to (#741, ADR-0015 monotonic ladder) so a future edit can't silently break
 * which merges get an Outcome Holdback watch, or invert the window ordering.
 *
 * The describes at the bottom pin the SHIPPED `config/direction/outcomes.yaml`
 * contract behind the #4247 exclusion (aggregate stays declared + leading;
 * per-league replacements share its baseline/target/noise_epsilon). They load
 * the repo's real outcomes.yaml — no Redis, no network — REPO_ROOT-relative
 * (never HYDRA_ROOT, which may point at the main checkout rather than this
 * worktree). They live HERE rather than a new file per the test-file sprawl
 * ratchet (#4134): this file already owns the src/holdback-policy.ts subject,
 * and the exclusion is a holdback-policy concern.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  isEnrolledTier,
  windowCyclesForTier,
  HOLDBACK_WINDOW_CYCLES,
  HOLDBACK_WINDOW_CYCLES_T3,
  HOLDBACK_UNWATCHABLE_OUTCOMES,
  isOutcomeWatchable,
} from "../src/holdback-policy.ts";
import { loadOutcomes } from "../src/outcomes.ts";
import { snapshotLeadingOutcomes } from "../src/outcome-regression.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAL_OUTCOMES_FILE = resolve(REPO_ROOT, "config", "direction", "outcomes.yaml");

/** The leagues ADR-0007 D3/D8 cover: MLB live today; NFL/NBA/NCAAF admitted by the sibling ticket. */
const EXPECTED_LEAGUES = ["mlb", "nfl", "nba", "ncaaf"] as const;

describe("holdback-policy — isEnrolledTier (tier-membership contract)", () => {
  test("T1 (prompt-shaped) does not enroll", () => {
    assert.equal(isEnrolledTier(1), false);
  });

  test("T2, T3, T4 enroll (the carry-up tiers)", () => {
    assert.equal(isEnrolledTier(2), true);
    assert.equal(isEnrolledTier(3), true);
    assert.equal(isEnrolledTier(4), true);
  });

  test("null / undefined never enroll (unresolvable tier is 'no signal')", () => {
    assert.equal(isEnrolledTier(null), false);
    assert.equal(isEnrolledTier(undefined), false);
  });

  test("tiers outside the {2,3,4} set (0, 5, negatives) do not enroll", () => {
    assert.equal(isEnrolledTier(0), false);
    assert.equal(isEnrolledTier(5), false);
    assert.equal(isEnrolledTier(-1), false);
  });
});

describe("holdback-policy — windowCyclesForTier (monotonic + floor contract)", () => {
  test("T2 returns the floor window (HOLDBACK_WINDOW_CYCLES)", () => {
    assert.equal(windowCyclesForTier(2), HOLDBACK_WINDOW_CYCLES);
  });

  test("T3 is at least the T2 floor and matches the configured T3 window", () => {
    const t3 = windowCyclesForTier(3);
    assert.equal(t3, Math.max(HOLDBACK_WINDOW_CYCLES_T3, HOLDBACK_WINDOW_CYCLES));
    assert.ok(t3 >= windowCyclesForTier(2), "T3 window must be >= T2 window");
  });

  test("window is monotonic non-decreasing across T2 <= T3 <= T4", () => {
    const t2 = windowCyclesForTier(2);
    const t3 = windowCyclesForTier(3);
    const t4 = windowCyclesForTier(4);
    assert.ok(t2 <= t3, `T2 (${t2}) must be <= T3 (${t3})`);
    assert.ok(t3 <= t4, `T3 (${t3}) must be <= T4 (${t4})`);
  });

  test("T1 / null / undefined fall back to the T2 floor", () => {
    assert.equal(windowCyclesForTier(1), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(null), HOLDBACK_WINDOW_CYCLES);
    assert.equal(windowCyclesForTier(undefined), HOLDBACK_WINDOW_CYCLES);
  });

  test("all windows are finite non-negative integers (floor-clamped)", () => {
    for (const tier of [1, 2, 3, 4, null, undefined] as const) {
      const w = windowCyclesForTier(tier);
      assert.ok(Number.isFinite(w), `window for tier ${tier} must be finite`);
      assert.ok(w >= 0, `window for tier ${tier} must be non-negative`);
    }
  });
});

describe("holdback-policy — HOLDBACK_UNWATCHABLE_OUTCOMES (issue #4247 / ADR-0007 D5)", () => {
  test("the sport-blind forecast-calibration-brier aggregate is NOT watchable", () => {
    assert.equal(
      isOutcomeWatchable("forecast-calibration-brier"),
      false,
      "the sport-blind aggregate must never key an Outcome Holdback auto-revert",
    );
  });

  test("the exclusion set contains exactly the sport-blind aggregate", () => {
    assert.deepEqual([...HOLDBACK_UNWATCHABLE_OUTCOMES].sort(), ["forecast-calibration-brier"]);
  });

  test("every other outcome name defaults to watchable (denylist, not allowlist)", () => {
    assert.equal(isOutcomeWatchable("orchestrator-self-improvement-share"), true);
    assert.equal(isOutcomeWatchable("some-future-outcome"), true);
    assert.equal(isOutcomeWatchable(""), true);
  });

  test("per-league Brier outcomes stay watchable — only the sport-blind blend is banned", () => {
    // The per-league replacements (issue #4247) are the honest per-sport signal;
    // they MUST remain eligible for holdback watch.
    for (const league of EXPECTED_LEAGUES) {
      assert.equal(
        isOutcomeWatchable(`forecast-calibration-brier-${league}`),
        true,
        `per-league outcome for ${league} must stay watchable`,
      );
    }
  });
});

describe("outcomes.yaml — sport-blind aggregate declaration (issue #4247)", () => {
  test("sport-blind aggregate stays declared and leading (display number retained) (#4247)", async () => {
    const loaded = await loadOutcomes(REAL_OUTCOMES_FILE);
    assert.equal(loaded.ok, true, `real outcomes.yaml must parse: ${JSON.stringify((loaded as any).errors ?? [])}`);
    const outcomes = (loaded as any).outcomes as Array<{ name: string; kind: string }>;
    const aggregate = outcomes.find((o) => o.name === "forecast-calibration-brier");
    assert.ok(aggregate, "the sport-blind aggregate must remain declared (display number)");
    assert.equal(aggregate.kind, "leading", "kind stays leading — the exclusion is a holdback-policy denylist, not a kind flip");
  });

  test("snapshotLeadingOutcomes still includes the sport-blind aggregate (attribution read path untouched) (#4247)", async () => {
    const snapshot = await snapshotLeadingOutcomes(REAL_OUTCOMES_FILE);
    const names = snapshot.map((s) => s.name);
    assert.ok(
      names.includes("forecast-calibration-brier"),
      "the shared snapshot leaf must keep serving the aggregate to the attribution ledger",
    );
    // Cross-check the denylist and the declaration agree on the exact name —
    // a renamed outcome would silently escape the exclusion.
    assert.ok(HOLDBACK_UNWATCHABLE_OUTCOMES.has("forecast-calibration-brier"));
  });
});

describe("outcomes.yaml — per-league replacement outcomes (issue #4247)", () => {
  test("per-league outcomes share the aggregate's baseline, target and noise_epsilon (#4247)", async () => {
    const loaded = await loadOutcomes(REAL_OUTCOMES_FILE);
    assert.equal(loaded.ok, true);
    const outcomes = (loaded as any).outcomes as Array<{
      name: string;
      kind: string;
      direction: string;
      source: string;
      query: string;
      baseline: number;
      target: number;
      noise_epsilon: number;
    }>;
    for (const league of EXPECTED_LEAGUES) {
      const outcome = outcomes.find((o) => o.name === `forecast-calibration-brier-${league}`);
      assert.ok(outcome, `per-league outcome forecast-calibration-brier-${league} must be declared`);
      assert.equal(outcome.kind, "leading");
      assert.equal(outcome.direction, "down", "lower Brier is better, same as the aggregate");
      assert.equal(outcome.source, "file");
      assert.equal(
        outcome.query,
        `metrics/forecast-calibration-brier-league/${league}.txt`,
        "query must point at the publisher's per-league sibling-file layout",
      );
      assert.equal(outcome.baseline, 0.25, "same coin-flip baseline as the aggregate (no skill score)");
      assert.equal(outcome.target, 0.18, "same target as the aggregate — 0.18 keeps its meaning");
      assert.equal(outcome.noise_epsilon, 0.005, "same noise floor as the aggregate");
    }
  });
});
