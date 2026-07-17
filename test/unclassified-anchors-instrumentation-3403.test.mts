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
  });
});
