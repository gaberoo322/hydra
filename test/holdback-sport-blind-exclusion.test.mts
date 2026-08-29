/**
 * Config-level pin for the sport-blind Brier exclusion (issue #4247 /
 * hydra-betting ADR-0007 D5).
 *
 * The producer-side exclusion (enrollHoldback/checkHoldback filtering
 * HOLDBACK_UNWATCHABLE_OUTCOMES) is pinned in test/holdback.test.mts. THIS
 * file pins the shipped `config/direction/outcomes.yaml` contract the rest of
 * the system reads:
 *
 *   - the sport-blind `forecast-calibration-brier` aggregate STAYS declared
 *     and `kind: leading` — it remains a display number for the dashboard and
 *     a watched metric for the outcome-attribution ledger; the exclusion is a
 *     holdback-policy denylist, NOT a kind flip (a flip would silently blind
 *     attribution too);
 *   - the shared `snapshotLeadingOutcomes()` leaf still INCLUDES the
 *     aggregate (the attribution read path is untouched — only
 *     `src/holdback.ts` filters);
 *   - each per-league replacement outcome is declared with the SAME baseline
 *     (0.25), target (0.18) and noise_epsilon (0.005) as the aggregate — no
 *     per-sport skill score, no redefinition of what 0.18 means — and its
 *     `query` points at the per-league sibling-file layout the publisher
 *     writes (`metrics/forecast-calibration-brier-league/<league>.txt`).
 *
 * No Redis, no network: it loads the repo's real outcomes.yaml through the
 * real loader (REPO_ROOT-relative — never HYDRA_ROOT, which may point at the
 * main checkout rather than this worktree).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { loadOutcomes } from "../src/outcomes.ts";
import { snapshotLeadingOutcomes } from "../src/outcome-regression.ts";
import { HOLDBACK_UNWATCHABLE_OUTCOMES } from "../src/holdback-policy.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const REAL_OUTCOMES_FILE = resolve(REPO_ROOT, "config", "direction", "outcomes.yaml");

/** The leagues ADR-0007 D3/D8 cover: MLB live today; NFL/NBA/NCAAF admitted by the sibling ticket. */
const EXPECTED_LEAGUES = ["mlb", "nfl", "nba", "ncaaf"] as const;

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
