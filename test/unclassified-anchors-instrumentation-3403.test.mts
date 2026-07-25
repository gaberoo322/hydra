/**
 * Issue #3403 — `getUnclassifiedAnchors` instrumentation (proposed solution #3).
 *
 * The 26%-unclassified alarm could only be root-caused by knowing WHICH cycles
 * were stuck, not just how many. `getUnclassifiedAnchors` surfaces each residual
 * sentinel cycle's attribution metadata (cycleId + prNumber + reference) so the
 * remaining unclassified rows are documented exceptions the operator can map
 * back to a merged PR, satisfying the issue's success criterion that every
 * unclassified cycle map to a named type OR a documented exception.
 *
 * Redis-backed (the projection reads `getMetricsTrend`). Uses DB 1 — never
 * touches production (DB 0). Authored as a NEW top-level `describe` with its own
 * `beforeEach`/`after` lifecycle so it cannot piggyback on a sibling suite's
 * teardown (CLAUDE.md authoring rule).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getUnclassifiedAnchors } = await import("../src/metrics/aggregate.ts");
const { UNCLASSIFIED_ANCHOR_TYPE } = await import("../src/autopilot/anchor-type.ts");

describe("getUnclassifiedAnchors — surfaces residual sentinel metadata (#3403)", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("an unclassified merge-enrichment cycle is surfaced with its cycleId + prNumber", async () => {
    // The dominant residual shape: a bare-UUID cycleId whose merged-status
    // enrichment write carried a prNumber but no decodable anchorType.
    const cycleId = "b8a3071f-a783-4812-bec5-8fa0f5079a08";
    await recordCycleMetrics(cycleId, {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      prNumber: "3379",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    const row = result.unclassified.find((r) => r.cycleId === cycleId);
    assert.ok(row, "the unclassified cycle is surfaced by the instrumentation");
    assert.equal(row!.prNumber, "3379", "the merged-PR number is attributed");
  });

  test("a classified cycle is NOT surfaced (only sentinel rows appear)", async () => {
    const classifiedId = "worktree-agent-15dc1488-t3-dev_orch";
    await recordCycleMetrics(classifiedId, {
      anchorType: "work-queue",
      prNumber: "3400",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    assert.equal(
      result.unclassified.find((r) => r.cycleId === classifiedId),
      undefined,
      "a decoded cycle must not appear in the unclassified list",
    );
  });

  test("the reported rate is the unclassified fraction of the window as a percent", async () => {
    // 1 unclassified + 1 classified → 50% of a 2-cycle window.
    await recordCycleMetrics("b9e6356d-7b33-4eda-b533-3b5e160aba53", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      prNumber: "3333",
      tasksMerged: 1,
    });
    await recordCycleMetrics("worktree-agent-deadbeef-t2-qa_orch", {
      anchorType: "qa-review",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    assert.equal(result.windowCycles, 2);
    assert.equal(result.unclassified.length, 1);
    assert.equal(result.rate, 50);
  });

  test("an empty window reports a 0 rate and no rows (no divide-by-zero)", async () => {
    const result = await getUnclassifiedAnchors(10);
    assert.equal(result.windowCycles, 0);
    assert.equal(result.unclassified.length, 0);
    assert.equal(result.rate, 0);
    // #3602: the sub-bucket surface is 0/0 on an empty window too.
    assert.equal(result.fixable, 0);
    assert.equal(result.noAttribution, 0);
    assert.equal(result.fixableRate, 0);
  });
});

describe("getUnclassifiedAnchors — #3602 fixable vs no-attribution sub-bucket split", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("a sentinel cycle whose worktreeBranch decodes is classified `fixable`", async () => {
    // Shape B: bare-UUID cycleId (undecodable, so the read path can't recover it)
    // but the stored head branch carries a decodable `-t{N}-<slot>` fence. The
    // #3604 write-path heal closes this; it is a genuine attribution gap.
    const cycleId = "afa22ef1-1234-4abc-9def-0123456789ab";
    await recordCycleMetrics(cycleId, {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "worktree-agent-afa22ef1-t2-dev_orch-3564",
      prNumber: "3581",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    const row = result.unclassified.find((r) => r.cycleId === cycleId);
    assert.ok(row, "the sentinel cycle is surfaced");
    assert.equal(row!.classification, "fixable");
    assert.equal(result.fixable, 1);
    assert.equal(result.noAttribution, 0);
    assert.equal(result.fixableRate, 100);
  });

  test("a sentinel cycle with no decodable branch is classified `no-attribution`", async () => {
    // Shape A/C: bare UUID + a descriptive/longhash branch that carries NO class
    // token anywhere. Structurally undecodable under the #2822 never-guess
    // invariant — inherent harness noise, not a fixable classifier gap.
    const cycleId = "2b5a625c-9999-4000-8000-abcdefabcdef";
    await recordCycleMetrics(cycleId, {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "worktree-agent-2b5a625cdeadbeefcafef00dba5eba11",
      prNumber: "3553",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    const row = result.unclassified.find((r) => r.cycleId === cycleId);
    assert.ok(row, "the sentinel cycle is surfaced");
    assert.equal(row!.classification, "no-attribution");
    assert.equal(result.fixable, 0);
    assert.equal(result.noAttribution, 1);
    assert.equal(result.fixableRate, 0);
  });

  test("a sentinel cycle with NO worktreeBranch at all is `no-attribution`", async () => {
    // The dominant residual shape: a merge-status enrichment write with a
    // prNumber but no branch to decode. Nothing to attribute → no-attribution.
    const cycleId = "b8a3071f-a783-4812-bec5-8fa0f5079a08";
    await recordCycleMetrics(cycleId, {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      prNumber: "3379",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    const row = result.unclassified.find((r) => r.cycleId === cycleId);
    assert.ok(row);
    assert.equal(row!.classification, "no-attribution");
    assert.equal(result.noAttribution, 1);
  });

  test("fixableRate keys the architectural trigger on genuine gaps only", async () => {
    // 1 fixable + 3 no-attribution in a 4-cycle window: total sentinel rate 100%,
    // but only 25% is fixable — so the >10% trigger keyed on fixableRate still
    // fires here, yet a window of ONLY no-attribution noise would report
    // fixableRate 0 and NOT trip it.
    await recordCycleMetrics("afa22ef1-aaaa-4abc-9def-000000000001", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "worktree-agent-afa22ef1-t2-qa_orch",
      tasksMerged: 1,
    });
    await recordCycleMetrics("autopilot-2b5a625c-t1", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      tasksMerged: 1,
    });
    await recordCycleMetrics("11111111-2222-3333-4444-555555555555", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "issue-3527-some-descriptive-branch",
      tasksMerged: 1,
    });
    await recordCycleMetrics("66666666-7777-8888-9999-aaaaaaaaaaaa", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    assert.equal(result.windowCycles, 4);
    assert.equal(result.unclassified.length, 4);
    assert.equal(result.rate, 100);
    assert.equal(result.fixable, 1);
    assert.equal(result.noAttribution, 3);
    assert.equal(result.fixableRate, 25);
  });
});

describe("getUnclassifiedAnchors — #3623 no-attribution shape diagnostic", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:*");
    if (keys.length > 0) await redis.del(...keys);
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("each no-attribution row carries its structural `shape`; fixable rows do not", async () => {
    // A bare-UUID merge-watch first-write (no branch) → bare-uuid.
    await recordCycleMetrics("72d9770f-40b9-41b9-bea4-59c93f1e2ebe", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      prNumber: "3606",
      tasksMerged: 1,
    });
    // A bare harness branch (Agent-tool dispatch) → harness-branch.
    await recordCycleMetrics("worktree-agent-a0f1d230dcdda8f78", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "worktree-agent-a0f1d230dcdda8f78",
      prNumber: "3621",
      tasksMerged: 1,
    });
    // A fixable cycle (decodable branch) carries NO shape — "why undecodable"
    // does not apply to a cycle that HAS a recoverable lane.
    await recordCycleMetrics("afa22ef1-1234-4abc-9def-0123456789ab", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "worktree-agent-afa22ef1-t2-dev_orch-3564",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    const bareUuid = result.unclassified.find(
      (r) => r.cycleId === "72d9770f-40b9-41b9-bea4-59c93f1e2ebe",
    );
    const harness = result.unclassified.find(
      (r) => r.cycleId === "worktree-agent-a0f1d230dcdda8f78",
    );
    const fixableRow = result.unclassified.find(
      (r) => r.cycleId === "afa22ef1-1234-4abc-9def-0123456789ab",
    );
    assert.equal(bareUuid!.classification, "no-attribution");
    assert.equal(bareUuid!.shape, "bare-uuid");
    assert.equal(harness!.classification, "no-attribution");
    assert.equal(harness!.shape, "harness-branch");
    assert.equal(fixableRow!.classification, "fixable");
    assert.equal(fixableRow!.shape, undefined, "a fixable row has no shape");
  });

  test("`noAttributionShapes` breaks the no-attribution count down by shape and sums to noAttribution", async () => {
    // Two bare-uuid + one autopilot-turn + one harness-branch = 4 no-attribution.
    await recordCycleMetrics("72d9770f-40b9-41b9-bea4-59c93f1e2ebe", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      tasksMerged: 1,
    });
    await recordCycleMetrics("4a2fc33e-9478-49dc-88cd-69dd393787dd", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      tasksMerged: 1,
    });
    await recordCycleMetrics("autopilot-2b5a625c-t2", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      tasksMerged: 1,
    });
    await recordCycleMetrics("worktree-agent-a25d39d935737145d", {
      anchorType: UNCLASSIFIED_ANCHOR_TYPE,
      worktreeBranch: "worktree-agent-a25d39d935737145d",
      tasksMerged: 1,
    });

    const result = await getUnclassifiedAnchors(10);
    assert.equal(result.noAttribution, 4);
    assert.deepEqual(result.noAttributionShapes, {
      "bare-uuid": 2,
      "autopilot-turn": 1,
      "harness-branch": 1,
    });
    const shapeSum = Object.values(result.noAttributionShapes).reduce(
      (a, b) => a + b,
      0,
    );
    assert.equal(shapeSum, result.noAttribution, "shape counts sum to noAttribution");
  });

  test("an empty window reports an empty shape breakdown (no divide-by-zero)", async () => {
    const result = await getUnclassifiedAnchors(10);
    assert.equal(result.noAttribution, 0);
    assert.deepEqual(result.noAttributionShapes, {});
  });
});
