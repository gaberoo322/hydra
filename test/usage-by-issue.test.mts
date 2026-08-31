/**
 * Regression tests for the dispatch -> issue cost-join ledger (issue #4126,
 * ADR-0032 epic #4123 slice gamma — the prerequisite for the A/B primary
 * endpoint).
 *
 * Locked behaviors:
 *   1. `recordDispatchCostJoin` — a positive-int `issue` appends to that
 *      issue's bounded ledger AND indexes the issue number so it is
 *      enumerable without a KEYS scan; `issue: null` appends to the
 *      UNATTRIBUTED residual ledger instead, never dropped.
 *   2. `listDispatchCostJoinIssues` / `getDispatchCostJoinForIssue` /
 *      `getUnattributedDispatchCostJoin` read back exactly what was written,
 *      newest-first (the `boundedJsonList` contract).
 *   3. `projectUsageByIssue` (pure): per-issue totals + per-class subtotals,
 *      sorted by total desc, `attributedPercent` computed over
 *      attributed+residual, 0 when both are 0, non-finite/non-positive
 *      token values guarded to 0 rather than corrupting a sum.
 *   4. `getUsageByIssue` (Redis-backed): composes the ledger reads with the
 *      pure fold; the residual/`attributedPercent` stay computed over the
 *      WHOLE ledger even when `issueFilter` narrows `byIssue` to one issue —
 *      so a GLM-arm issue's residual visibility never depends on which issue
 *      a caller happens to query.
 *   5. `isDispatchCostJoinWriteFailure` narrows the discriminated union under
 *      this repo's `strict: false` tsconfig (CLAUDE.md convention).
 *
 * Authored as a NEW top-level `describe` per file with its own
 * before/beforeEach/after lifecycle (CLAUDE.md authoring rule: never nest
 * new Redis-backed tests inside a sibling suite's shared teardown). Uses real
 * Redis db 1 — the same convention `test/cost-by-class.test.mts` already
 * established for the Cost domain.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  recordDispatchCostJoin,
  isDispatchCostJoinWriteFailure,
  listDispatchCostJoinIssues,
  getDispatchCostJoinForIssue,
  getUnattributedDispatchCostJoin,
} = await import("../src/redis/cost.ts");
const { projectUsageByIssue, getUsageByIssue, projectWeightedQuotaTokensEstimate } = await import(
  "../src/cost/index.ts"
);

function record(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    issue: 4126,
    class: "dev_orch",
    dispatchKind: "autopilot-dispatched",
    dispatchTokensEstimate: 1000,
    reapedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as any;
}

/** A fully-empty per-family TokenBreakdown, for {@link familyTotals} fixtures. */
function emptyBreakdown() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

/** A `Record<ModelFamily, TokenBreakdown>` fixture — every family present, only
 *  `total` populated (the only field {@link projectWeightedQuotaTokensEstimate}
 *  reads). */
function familyTotals(totals: Partial<Record<"opus" | "sonnet" | "haiku" | "unknown", number>>) {
  return {
    opus: { ...emptyBreakdown(), total: totals.opus ?? 0 },
    sonnet: { ...emptyBreakdown(), total: totals.sonnet ?? 0 },
    haiku: { ...emptyBreakdown(), total: totals.haiku ?? 0 },
    unknown: { ...emptyBreakdown(), total: totals.unknown ?? 0 },
  } as any;
}

const CALIBRATED_WEIGHTS = { opus: 5, sonnet: 1, haiku: 0.2 };

// ---------------------------------------------------------------------------
// Pure: projectWeightedQuotaTokensEstimate (issue #4126 INV-2)
// ---------------------------------------------------------------------------

describe("projectWeightedQuotaTokensEstimate", () => {
  test("uncalibrated env weights: returns the raw identity, never a fabricated split", () => {
    const n = projectWeightedQuotaTokensEstimate(
      1000,
      familyTotals({ opus: 500, sonnet: 500 }),
      CALIBRATED_WEIGHTS,
      /* quotaWeightCalibrated */ false,
    );
    assert.equal(n, 1000);
  });

  test("no family mix for the skill (undefined): returns the raw identity", () => {
    const n = projectWeightedQuotaTokensEstimate(1000, undefined, CALIBRATED_WEIGHTS, true);
    assert.equal(n, 1000);
  });

  test("cold skill (all-zero family mix): returns the raw identity, no div-by-zero", () => {
    const n = projectWeightedQuotaTokensEstimate(1000, familyTotals({}), CALIBRATED_WEIGHTS, true);
    assert.equal(n, 1000);
  });

  test("100% one family: raw tokens scaled by exactly that family's Quota-Weight", () => {
    const n = projectWeightedQuotaTokensEstimate(
      1000,
      familyTotals({ opus: 100 }),
      CALIBRATED_WEIGHTS,
      true,
    );
    assert.equal(n, 5000); // 1000 * 1.0 (100% opus fraction) * 5 (opus weight)
  });

  test("mixed family split: proportional blend of each family's Quota-Weight", () => {
    // 80% sonnet (weight 1), 20% haiku (weight 0.2):
    // 1000 * (0.8*1 + 0.2*0.2) = 1000 * 0.84 = 840
    const n = projectWeightedQuotaTokensEstimate(
      1000,
      familyTotals({ sonnet: 800, haiku: 200 }),
      CALIBRATED_WEIGHTS,
      true,
    );
    assert.equal(n, 840);
  });

  test("dispatchTokensEstimate <= 0 short-circuits to 0, never a negative or NaN figure", () => {
    assert.equal(
      projectWeightedQuotaTokensEstimate(0, familyTotals({ opus: 100 }), CALIBRATED_WEIGHTS, true),
      0,
    );
    assert.equal(
      projectWeightedQuotaTokensEstimate(-5, familyTotals({ opus: 100 }), CALIBRATED_WEIGHTS, true),
      0,
    );
    assert.equal(
      projectWeightedQuotaTokensEstimate(
        Number.NaN,
        familyTotals({ opus: 100 }),
        CALIBRATED_WEIGHTS,
        true,
      ),
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure: projectUsageByIssue
// ---------------------------------------------------------------------------

describe("projectUsageByIssue", () => {
  test("no issues, no residual => all-zero result, attributedPercent 0", () => {
    const r = projectUsageByIssue([], [], () => "2026-08-29T00:00:00.000Z");
    assert.deepEqual(r.byIssue, []);
    assert.equal(r.totalAttributedTokensEstimate, 0);
    assert.equal(r.residualTokensEstimate, 0);
    assert.equal(r.residualDispatchCount, 0);
    assert.equal(r.attributedPercent, 0);
    assert.equal(r.generatedAt, "2026-08-29T00:00:00.000Z");
  });

  test("folds per-issue records into per-class subtotals and a total", () => {
    const r = projectUsageByIssue(
      [
        {
          issue: 4126,
          records: [
            record({ class: "dev_orch", dispatchTokensEstimate: 4000 }),
            record({ class: "qa_orch", dispatchTokensEstimate: 1000 }),
          ],
        },
      ],
      [],
    );
    assert.equal(r.byIssue.length, 1);
    const e = r.byIssue[0];
    assert.equal(e.issue, 4126);
    assert.equal(e.totalDispatchTokensEstimate, 5000);
    assert.equal(e.dispatchCount, 2);
    assert.equal(e.byClass.dev_orch, 4000);
    assert.equal(e.byClass.qa_orch, 1000);
    assert.equal(r.totalAttributedTokensEstimate, 5000);
  });

  test("sorts byIssue by totalDispatchTokensEstimate descending", () => {
    const r = projectUsageByIssue(
      [
        { issue: 1, records: [record({ dispatchTokensEstimate: 100 })] },
        { issue: 2, records: [record({ dispatchTokensEstimate: 900 })] },
        { issue: 3, records: [record({ dispatchTokensEstimate: 500 })] },
      ],
      [],
    );
    assert.deepEqual(
      r.byIssue.map((e) => e.issue),
      [2, 3, 1],
    );
  });

  test("residual + attributedPercent: mixed attributed and unattributed", () => {
    const r = projectUsageByIssue(
      [{ issue: 4126, records: [record({ dispatchTokensEstimate: 900 })] }],
      [record({ issue: null, dispatchTokensEstimate: 100 })],
    );
    assert.equal(r.totalAttributedTokensEstimate, 900);
    assert.equal(r.residualTokensEstimate, 100);
    assert.equal(r.residualDispatchCount, 1);
    assert.equal(r.attributedPercent, 90); // 900 / 1000 * 100
  });

  test("100% residual (nothing attributed yet) never divides by zero", () => {
    const r = projectUsageByIssue(
      [],
      [record({ issue: null, dispatchTokensEstimate: 250 })],
    );
    assert.equal(r.totalAttributedTokensEstimate, 0);
    assert.equal(r.residualTokensEstimate, 250);
    assert.equal(r.attributedPercent, 0);
  });

  test("non-finite / non-positive token values are guarded to 0, never corrupt the sum", () => {
    const r = projectUsageByIssue(
      [
        {
          issue: 4126,
          records: [
            record({ dispatchTokensEstimate: Number.NaN }),
            record({ dispatchTokensEstimate: -5 }),
            record({ dispatchTokensEstimate: 300 }),
          ],
        },
      ],
      [],
    );
    assert.equal(r.byIssue[0].totalDispatchTokensEstimate, 300);
    assert.equal(r.byIssue[0].dispatchCount, 3); // count is NOT guarded, only the token sum
  });
});

// ---------------------------------------------------------------------------
// Redis-backed: recordDispatchCostJoin / read accessors / getUsageByIssue
// ---------------------------------------------------------------------------

describe("dispatch cost-join ledger (Redis-backed)", () => {
  let testRedis: any;

  async function cleanKeys() {
    const keys = await testRedis.keys("hydra:cost:dispatch-join:*");
    if (keys.length > 0) await testRedis.del(...keys);
  }

  before(async () => {
    testRedis = new Redis(process.env.REDIS_URL);
  });
  beforeEach(async () => {
    await cleanKeys();
  });
  after(async () => {
    await cleanKeys();
    await testRedis.quit();
  });

  test("attributed record: appended to the issue ledger AND indexed", async () => {
    const result = await recordDispatchCostJoin(record({ issue: 4126 }));
    assert.equal(isDispatchCostJoinWriteFailure(result), false);
    if (!isDispatchCostJoinWriteFailure(result)) {
      assert.equal(result.attributed, true);
    }

    const issues = await listDispatchCostJoinIssues();
    assert.deepEqual(issues, [4126]);

    const rows = await getDispatchCostJoinForIssue(4126);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].issue, 4126);
    assert.equal(rows[0].dispatchTokensEstimate, 1000);
  });

  test("unattributed record (issue: null): appended to the residual ledger, never indexed", async () => {
    const result = await recordDispatchCostJoin(
      record({ issue: null, class: "sweep_orch" }),
    );
    assert.equal(isDispatchCostJoinWriteFailure(result), false);
    if (!isDispatchCostJoinWriteFailure(result)) {
      assert.equal(result.attributed, false);
    }

    const issues = await listDispatchCostJoinIssues();
    assert.deepEqual(issues, []);

    const residual = await getUnattributedDispatchCostJoin();
    assert.equal(residual.length, 1);
    assert.equal(residual[0].issue, null);
    assert.equal(residual[0].class, "sweep_orch");
  });

  test("reads are newest-first (bounded-list contract)", async () => {
    await recordDispatchCostJoin(record({ issue: 4126, dispatchTokensEstimate: 1 }));
    await recordDispatchCostJoin(record({ issue: 4126, dispatchTokensEstimate: 2 }));
    await recordDispatchCostJoin(record({ issue: 4126, dispatchTokensEstimate: 3 }));

    const rows = await getDispatchCostJoinForIssue(4126);
    assert.deepEqual(
      rows.map((r) => r.dispatchTokensEstimate),
      [3, 2, 1],
    );
  });

  test("getUsageByIssue: a GLM-arm issue's Anthropic-side QA cost is NOT zero", async () => {
    // Simulates the scenario #4126's acceptance criterion targets: the
    // issue's own coding dispatch ran on the GLM drainer (never posts here),
    // but its qa_orch completion IS a real Claude Code dispatch that reaps
    // through run_completion like any other class.
    await recordDispatchCostJoin(
      record({ issue: 4126, class: "qa_orch", dispatchTokensEstimate: 7000 }),
    );

    const view = await getUsageByIssue();
    assert.equal(view.byIssue.length, 1);
    assert.equal(view.byIssue[0].issue, 4126);
    assert.equal(view.byIssue[0].totalDispatchTokensEstimate, 7000);
    assert.equal(view.byIssue[0].byClass.qa_orch, 7000);
  });

  test("getUsageByIssue(issueFilter): narrows byIssue but keeps the residual global", async () => {
    await recordDispatchCostJoin(record({ issue: 1, dispatchTokensEstimate: 100 }));
    await recordDispatchCostJoin(record({ issue: 2, dispatchTokensEstimate: 200 }));
    await recordDispatchCostJoin(record({ issue: null, dispatchTokensEstimate: 50 }));

    const filtered = await getUsageByIssue(1);
    assert.equal(filtered.byIssue.length, 1);
    assert.equal(filtered.byIssue[0].issue, 1);
    assert.equal(filtered.byIssue[0].totalDispatchTokensEstimate, 100);
    // Residual/attributedPercent are computed over the WHOLE ledger, not just
    // issue 1 — proves the global-residual invariant the docstring promises.
    assert.equal(filtered.residualTokensEstimate, 50);

    const unfiltered = await getUsageByIssue();
    assert.equal(unfiltered.byIssue.length, 2);
    assert.equal(unfiltered.totalAttributedTokensEstimate, 300);
    assert.equal(unfiltered.residualTokensEstimate, 50);
  });
});
