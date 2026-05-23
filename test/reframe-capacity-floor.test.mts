/**
 * Regression tests for the reframe capacity floor (issue #377).
 *
 * Bug: the reframe lane was served 2/50 cycles despite 17 abandonments;
 * the lane sat below kanban / specs / work-queue in selectAnchor() and
 * nothing forced the priority ever, even when REFRAME_INTERLEAVE_INTERVAL=5
 * was declared.
 *
 * Fix: a third floor in the unified capacity-floor dispatcher
 * (capacity-floors.ts). When `cyclesSinceReframeServed >= floorN` AND the
 * reframe queue has a candidate, the floor pre-empts kanban with the next
 * reframe item.
 *
 * These tests pin:
 *   - The floor's prepare() readiness predicate against live Redis state.
 *   - The dispatcher's tiebreak when only the reframe floor is ready.
 *   - The buildAnchor() consume + serve-recording path.
 *   - The "queue drained between prepare and build" fall-through.
 *   - defaultCapacityFloors() now contains three floors with priorities in
 *     the expected order.
 *
 * Requires Redis running on localhost:6379. Uses DB 1.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = redisUrl;
redis = new Redis(redisUrl);

after(async () => {
  if (redis) {
    await cleanKeys();
    redis.disconnect();
  }
});

const REFRAME_QUEUE_KEY = "hydra:anchors:reframe-queue";

async function pushReframeItem(title: string, ageMs = 60_000) {
  await redis.rpush(
    REFRAME_QUEUE_KEY,
    JSON.stringify({
      originalTaskId: title,
      originalTitle: title,
      originalDescription: "",
      anchorType: "test",
      anchorReference: title,
      scopeBoundary: null,
      totalAttempts: 3,
      lastReason: "test",
      failedSteps: [],
      failureHistory: [],
      verificationStderr: "",
      escalatedAt: new Date(Date.now() - ageMs).toISOString(),
      escalationSource: "test",
    }),
  );
}

describe("reframeFloorDecl.prepare — readiness (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("returns null when no reframe candidate exists", async () => {
    const { reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const floor = reframeFloorDecl();
    const ready = await floor.prepare();
    assert.equal(ready, null, "no candidate → not ready");
  });

  test("returns ready with negative deficit before cadence elapses", async () => {
    const { reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    await pushReframeItem("fresh-reframe");

    // cyclesSinceServed = 0 → deficit = 0 - 5 = -5 (not ready)
    const floor = reframeFloorDecl();
    const ready = await floor.prepare();
    assert.ok(ready, "candidate present → floor returns a readiness obj");
    assert.equal(ready!.deficit, -5);
    assert.equal(ready!.payload.marker, "reframe");
  });

  test("deficit becomes positive after floorN passed-over cycles", async () => {
    const { reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const { recordReframePassedReason } = await import(
      "../src/anchor-selection/reframe-starvation.ts"
    );
    await pushReframeItem("starved-reframe");

    // Record 6 pass-overs → gauge = 6, deficit = 6 - 5 = 1 (ready)
    for (let i = 0; i < 6; i++) await recordReframePassedReason("kanban_won");

    const floor = reframeFloorDecl();
    const ready = await floor.prepare();
    assert.ok(ready);
    assert.equal(ready!.deficit, 1);
  });
});

describe("reframeFloorDecl.buildAnchor — consume path (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("returns a reframe anchor and resets the starvation gauge", async () => {
    const { reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const {
      recordReframePassedReason,
      getCyclesSinceReframeServed,
    } = await import("../src/anchor-selection/reframe-starvation.ts");

    await pushReframeItem("hot-reframe");
    for (let i = 0; i < 6; i++) await recordReframePassedReason("kanban_won");
    assert.equal(await getCyclesSinceReframeServed(), 6);

    const floor = reframeFloorDecl();
    const anchor = await floor.buildAnchor({ marker: "reframe" }, null);

    assert.ok(anchor, "buildAnchor should produce an anchor");
    assert.equal(anchor.type, "reframe");
    assert.equal(anchor.reference, "hot-reframe");

    // Serving should reset the gauge.
    assert.equal(await getCyclesSinceReframeServed(), 0);
    // And record force_floor for telemetry parity.
    const reasons = await redis.hgetall(
      "hydra:anchors:reframe-passed-reasons",
    );
    assert.equal(parseInt(reasons.force_floor), 1);
  });

  test("returns null and records drift_duplicate when queue drained", async () => {
    const { reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    // No reframe items pushed → selectReframeAnchor returns null.
    const floor = reframeFloorDecl();
    const anchor = await floor.buildAnchor({ marker: "reframe" }, null);

    assert.equal(anchor, null);
    const reasons = await redis.hgetall(
      "hydra:anchors:reframe-passed-reasons",
    );
    assert.equal(parseInt(reasons.drift_duplicate || "0"), 1);
  });
});

describe("dispatchCapacityFloor — reframe floor wiring (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("fires reframe floor when only it is ready", async () => {
    const { dispatchCapacityFloor, reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const { recordReframePassedReason } = await import(
      "../src/anchor-selection/reframe-starvation.ts"
    );

    await pushReframeItem("solo-reframe");
    for (let i = 0; i < 6; i++) await recordReframePassedReason("kanban_won");

    const result = await dispatchCapacityFloor([reframeFloorDecl()]);
    assert.equal(result.firedFloor, "reframe");
    assert.ok(result.anchor);
    assert.equal(result.anchor.type, "reframe");
  });

  test("defaultCapacityFloors contains reframe (post-ADR-0010)", async () => {
    const { defaultCapacityFloors } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const floors = defaultCapacityFloors({});
    const names = floors.map((f: any) => f.name).sort();
    // Specs floor retired in #513; self-improvement/stuckness floor retired
    // in ADR-0010. The reframe floor (#377) is the only remaining declaration.
    assert.deepEqual(names, ["reframe"]);
  });

  test("loadCapacityFloorsConfig honours HYDRA_REFRAME_FLOOR_N env override", async () => {
    const { loadCapacityFloorsConfig } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const cfg = loadCapacityFloorsConfig({ HYDRA_REFRAME_FLOOR_N: "8" });
    assert.equal(cfg.reframe.cadenceN, 8);

    // Garbage falls back to default.
    const cfgBad = loadCapacityFloorsConfig({ HYDRA_REFRAME_FLOOR_N: "abc" });
    assert.equal(cfgBad.reframe.cadenceN, 5);

    // Alternate alias is also accepted.
    const cfgAlt = loadCapacityFloorsConfig({ HYDRA_CAPACITY_FLOOR_REFRAME_N: "9" });
    assert.equal(cfgAlt.reframe.cadenceN, 9);
  });
});

describe("Capacity-floors snapshot exposes the reframe floor (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("getCapacityFloorsSnapshot returns the reframe floor with current gauges", async () => {
    const { getCapacityFloorsSnapshot } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const { recordReframePassedReason } = await import(
      "../src/anchor-selection/reframe-starvation.ts"
    );
    await recordReframePassedReason("kanban_won");
    await recordReframePassedReason("spec_won");

    const snap = await getCapacityFloorsSnapshot({});
    const reframe = snap.floors.find((f: any) => f.name === "reframe");
    assert.ok(reframe, "snapshot must include the reframe floor");
    assert.equal((reframe.details as any).cadenceN, 5);
    assert.equal((reframe.details as any).cyclesSinceServed, 2);
    assert.deepEqual((reframe.details as any).reasons, {
      kanban_won: 1,
      spec_won: 1,
    });
  });
});
