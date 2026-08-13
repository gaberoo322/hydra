/**
 * Regression tests for the ranked-report PURE helpers (issue #3825).
 *
 * `scripts/cost/weighted-quota-report.ts` splits into pure ranking/validation/
 * formatting helpers (exported here) and a filesystem + OAuth I/O `main()`.
 * This file pins the pure half — the part that decides the report's
 * correctness — without a transcript tree or network:
 *
 *   - `rankConsumers`: rows sorted by weighted burn; shares + the explicit
 *     `interactive` residual sum to 100% of the REAL burn (AC2 / ask #5); the
 *     cache-write term is carried in the per-row category aggregate (AC1)
 *   - `sampleTimestamps` + `computeWeightedCurve`: the ≥3-sample weighted
 *     curve spanning the window (AC3)
 *   - `decideTracking`: the meter-comparison verdict, null when undecided
 *   - `buildReport` + `renderTextReport`: the structured report + text emitter
 *     surface the cache-write column and the residual
 *
 * The report's weighting inversion is exercised directly: a consumer that
 * dominates RAW volume (cache reads) ranks LAST under weighted burn, while a
 * small-output consumer ranks FIRST — the exact ordering flip the issue is about.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Import the pure helpers + the structured-report builders FROM the script. The
// script's `if (import.meta.url === …)` guard means importing it does NOT run
// `main()`, so this pulls in only the pure ranking/validation/formatting code.
import {
  rankConsumers,
  sampleTimestamps,
  computeWeightedCurve,
  decideTracking,
  buildReport,
  renderTextReport,
} from "../scripts/cost/weighted-quota-report.ts";
import type { TokenBreakdown, ModelFamily, CategoryWeights } from "../src/cost/token-math.ts";
import { emptyByModel, emptyByDispatchKind } from "../src/cost/token-breakdown.ts";

// List-price-ish weights for deterministic assertions: input 1, output 5,
// cacheRead 0.1, cacheCreation 1.25; family opus 5 / sonnet 3 / haiku 1.
const CAT: CategoryWeights = { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 };
const FW = { opus: 5, sonnet: 3, haiku: 1 };

function breakdown(input = 0, output = 0, cacheRead = 0, cacheCreation = 0): TokenBreakdown {
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

// A cross-tab keyed by consumer → family → breakdown. `emptyByModel()` seeds all
// four families (incl. unknown) at zero so a partial override is well-formed.
function row(family: ModelFamily, b: TokenBreakdown): Record<ModelFamily, TokenBreakdown> {
  return { ...emptyByModel(), [family]: b };
}

describe("rankConsumers (issue #3825)", () => {
  // Three consumers chosen to surface the weighting inversion:
  //   - dev_orch: opus, 100 input + 400 cache-write → real burn
  //   - interactive (residual): sonnet, 100 output → small raw, big weighted
  //   - qa_orch: haiku, 1000 cache-read → DOMINANT raw volume, cheapest category
  const byConsumer = {
    dev_orch: row("opus", breakdown(100, 0, 0, 400)),
    interactive: row("sonnet", breakdown(0, 100, 0, 0)),
    qa_orch: row("haiku", breakdown(0, 0, 1000, 0)),
  };

  test("ranks by WEIGHTED burn: the cache-read volume leader sinks to last", () => {
    // dev_orch:    familyWeight(opus,5) * (1*100 + 1.25*400)        = 5 * 600   = 3000
    // interactive: familyWeight(sonnet,3) * (5*100)                = 3 * 500   = 1500
    // qa_orch:     familyWeight(haiku,1) * (0.1*1000)              = 1 * 100   = 100
    const result = rankConsumers(byConsumer, CAT, FW, "interactive");
    assert.deepEqual(
      result.rows.map((r) => r.consumer),
      ["dev_orch", "interactive", "qa_orch"],
    );
    assert.equal(result.rows[2].consumer, "qa_orch"); // raw-volume leader ranks LAST
    assert.equal(result.totalWeighted, 4600);
    assert.equal(result.totalRaw, 1600); // 500 + 100 + 1000
  });

  test("shares + the interactive residual sum to 100% of the real burn (AC2 / ask #5)", () => {
    const result = rankConsumers(byConsumer, CAT, FW, "interactive");
    const shareSum = result.rows.reduce((s, r) => s + r.sharePct, 0);
    assert.ok(Math.abs(shareSum - 100) < 1e-6, "shares sum to 100 including the residual");
    // The residual is IN the denominator (not appended after), so its share is
    // honest against the full total.
    const residual = result.rows.find((r) => r.isResidual);
    assert.ok(residual, "the interactive residual is flagged");
    assert.equal(residual!.consumer, "interactive");
    assert.ok(Math.abs(residual!.sharePct - (1500 / 4600) * 100) < 1e-6);
  });

  test("the residual is NOT pinned last — it ranks by its earned weighted burn", () => {
    const result = rankConsumers(byConsumer, CAT, FW, "interactive");
    // interactive (1500) outscores qa_orch (100), so it ranks ABOVE it despite
    // being the residual bucket.
    const interactiveIdx = result.rows.findIndex((r) => r.consumer === "interactive");
    const qaIdx = result.rows.findIndex((r) => r.consumer === "qa_orch");
    assert.ok(interactiveIdx < qaIdx);
    assert.equal(result.rows[interactiveIdx].isResidual, true);
  });

  test("each row's category aggregate carries cache-write (AC1) and the raw share", () => {
    const result = rankConsumers(byConsumer, CAT, FW, "interactive");
    const devOrch = result.rows.find((r) => r.consumer === "dev_orch")!;
    // cache-write (cacheCreation) is broken out in the aggregate, not folded away.
    assert.equal(devOrch.categories.cacheCreation, 400);
    assert.equal(devOrch.categories.input, 100);
    // raw share uses the FULL raw total as denominator.
    assert.ok(Math.abs(devOrch.rawSharePct - (500 / 1600) * 100) < 1e-6);
    // The raw-volume leader's RAW share is large even though its WEIGHTED share is tiny:
    const qa = result.rows.find((r) => r.consumer === "qa_orch")!;
    assert.ok(qa.rawSharePct > qa.sharePct, "qa_orch raw share >> weighted share (the inversion)");
  });
});

describe("sampleTimestamps + computeWeightedCurve (issue #3825 AC3)", () => {
  test("sampleTimestamps spans [boundary, now] in `count` even fractions; last === now", () => {
    const ts = sampleTimestamps(0, 100, 4);
    assert.deepEqual(ts, [25, 50, 75, 100]);
    assert.equal(ts[ts.length - 1], 100); // last sample === now
  });

  test("sampleTimestamps degrades to [now] when the span is non-positive", () => {
    assert.deepEqual(sampleTimestamps(100, 100, 4), [100]);
  });

  test("computeWeightedCurve accumulates entries up to each sample and folds per-axis", () => {
    const entries = [
      { tsMs: 10, tokens: breakdown(100), family: "opus" as ModelFamily },
      { tsMs: 20, tokens: breakdown(0, 100), family: "sonnet" as ModelFamily },
    ];
    const curve = computeWeightedCurve(entries, [15, 25], CAT, FW, 10_000);
    // at 15: opus only → 5 * (1*100) = 500 → 5% of quota
    // at 25: opus + sonnet → 500 + 3*(5*100) = 500 + 1500 = 2000 → 20%
    assert.equal(curve.length, 2);
    assert.equal(curve[0].atMs, 15);
    assert.equal(curve[0].weightedBurn, 500);
    assert.equal(curve[0].percentOfQuota, 5);
    assert.equal(curve[1].atMs, 25);
    assert.equal(curve[1].weightedBurn, 2000);
    assert.equal(curve[1].percentOfQuota, 20);
  });

  test("computeWeightedCurve yields null percentOfQuota when the weekly quota is unset", () => {
    const curve = computeWeightedCurve(
      [{ tsMs: 10, tokens: breakdown(100), family: "opus" }],
      [20],
      CAT,
      FW,
      0,
    );
    assert.equal(curve[0].percentOfQuota, null);
    assert.equal(curve[0].weightedBurn, 500);
  });
});

describe("decideTracking (issue #3825 AC3)", () => {
  test("tracks within tolerance in BOTH directions", () => {
    assert.deepEqual(decideTracking(20, 10, 2), { ratio: 2, tracks: true }); // upper boundary
    assert.deepEqual(decideTracking(10, 20, 2), { ratio: 0.5, tracks: true }); // lower boundary
  });

  test("does NOT track outside tolerance", () => {
    assert.deepEqual(decideTracking(30, 10, 2), { ratio: 3, tracks: false });
    assert.deepEqual(decideTracking(5, 20, 2), { ratio: 0.25, tracks: false });
  });

  test("returns null verdicts when either input is missing", () => {
    assert.deepEqual(decideTracking(null, 10, 2), { ratio: null, tracks: null });
    assert.deepEqual(decideTracking(20, null, 2), { ratio: null, tracks: null });
    assert.deepEqual(decideTracking(20, 0, 2), { ratio: null, tracks: null }); // zero meter
  });
});

describe("buildReport + renderTextReport (issue #3825 AC1/AC4)", () => {
  test("the rendered report surfaces the cache-write column + the residual", () => {
    const bySkill = {
      dev_orch: row("opus", breakdown(100, 0, 0, 400)),
      interactive: row("sonnet", breakdown(0, 100, 0, 0)),
      qa_orch: row("haiku", breakdown(0, 0, 1000, 0)),
    };
    // The same token mass partitioned across dispatch kinds (the headline total
    // rides on this axis): dev_orch→autopilot, interactive→interactive, qa→operator.
    const byDispatchKind = {
      ...emptyByDispatchKind(),
      "autopilot-dispatched": row("opus", breakdown(100, 0, 0, 400)),
      interactive: row("sonnet", breakdown(0, 100, 0, 0)),
      "operator-invoked": row("haiku", breakdown(0, 0, 1000, 0)),
    };
    const report = buildReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      nowMs: 100_000,
      boundaryMs: 0,
      windowMode: "since-reset",
      category: CAT,
      familyWeights: FW,
      weeklyQuota: 10_000,
      byDispatchKind,
      bySkill,
      curveEntries: [],
      meterPercent: null,
      sampleCount: 4,
      tolerance: 2,
      excluded: { foreignTokens: 0, unknownFamilyTokens: 0 },
    });
    const text = renderTextReport(report);
    // AC1: cache-write is visible as its own column.
    assert.match(text, /cacheWrite/);
    // The interactive residual is labelled in the rendered table.
    assert.match(text, /interactive \(residual\)/);
    // AC4: the list-price-proxy caveat is stated.
    assert.match(text, /LIST-PRICE PROXY/i);
    // The headline total rides on the dispatch-kind partition (3000 + 1500 + 100).
    assert.equal(report.totals.weightedBurn, 4600);
    assert.equal(report.bySkill.totalWeighted, 4600); // both partitions sum to the same mass
    // meterPercent null → the meter comparison is withheld, validation undecided.
    assert.equal(report.validation.tracks, null);
  });
});
