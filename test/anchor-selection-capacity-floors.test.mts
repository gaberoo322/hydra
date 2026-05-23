/**
 * Regression tests for the unified capacity-floor dispatcher (issue #321).
 *
 * Background
 *   Three pre-emption branches in `selectAnchor()` historically existed —
 *   the stuckness-driven self-improvement floor (#245, retired in ADR-0010),
 *   the spec capacity-floor (#301/#308, retired in #513), and the
 *   reframe-queue floor (#377). The first two could stack within a couple
 *   of cycles because they didn't see each other's state. #321 unified them
 *   behind a single dispatcher that fires AT MOST one floor per cycle.
 *   Today only the reframe floor remains; the dispatcher scaffolding stays
 *   so future floors plug in cleanly without reintroducing the stacking bug.
 *
 * These tests pin:
 *   - The pure dispatcher's tiebreak rules (highest deficit, then priority).
 *   - The default floor declarations' readiness predicates.
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

// ---------------------------------------------------------------------------
// Pure dispatcher
// ---------------------------------------------------------------------------

describe("dispatchCapacityFloor — pure dispatcher (issue #321)", () => {
  test("returns null anchor when no floor is ready", async () => {
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const result = await dispatchCapacityFloor([
      {
        name: "a",
        priority: 1,
        async prepare() { return null; },
        async buildAnchor() { throw new Error("should not run"); },
      },
      {
        name: "b",
        priority: 2,
        async prepare() { return { deficit: 0, share: 0, targetShare: 0.25, payload: {} }; },
        async buildAnchor() { throw new Error("should not run"); },
      },
    ]);
    assert.equal(result.anchor, null);
    assert.equal(result.firedFloor, null);
    assert.equal(result.evaluations.length, 2);
    assert.equal(result.evaluations[0].ready, false);
    assert.equal(result.evaluations[1].ready, false);
  });

  test("fires the only ready floor", async () => {
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    let built = false;
    const result = await dispatchCapacityFloor([
      {
        name: "a",
        priority: 1,
        async prepare() { return null; },
        async buildAnchor() { throw new Error("should not run"); },
      },
      {
        name: "b",
        priority: 2,
        async prepare() { return { deficit: 5, share: 0, targetShare: 0.25, payload: {} }; },
        async buildAnchor() { built = true; return { type: "research", reference: "b" }; },
      },
    ]);
    assert.equal(built, true);
    assert.equal(result.firedFloor, "b");
    assert.equal(result.anchor.reference, "b");
  });

  test("picks the floor with the largest deficit when multiple are ready", async () => {
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const passed: string[] = [];
    const result = await dispatchCapacityFloor([
      {
        name: "small",
        priority: 1,
        async prepare() { return { deficit: 1, share: 0, targetShare: 0.25, payload: {} }; },
        async buildAnchor() { throw new Error("loser should not build"); },
        async onPassedOver(reason) { passed.push(`small:${reason}`); },
      },
      {
        name: "big",
        priority: 2,
        async prepare() { return { deficit: 10, share: 0, targetShare: 0.25, payload: {} }; },
        async buildAnchor() { return { type: "research", reference: "big" }; },
      },
    ]);
    assert.equal(result.firedFloor, "big");
    // The smaller-deficit floor was notified that it lost.
    assert.deepEqual(passed, ["small:big_won"]);
  });

  test("tiebreak: lower `priority` value wins when deficits match", async () => {
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const result = await dispatchCapacityFloor([
      {
        name: "senior",
        priority: 1, // wins ties
        async prepare() { return { deficit: 3, share: 0, targetShare: 0.25, payload: {} }; },
        async buildAnchor() { return { type: "user-request", reference: "senior" }; },
      },
      {
        name: "junior",
        priority: 2,
        async prepare() { return { deficit: 3, share: 0, targetShare: 1 / 5, payload: {} }; },
        async buildAnchor() { throw new Error("loser should not build"); },
      },
    ]);
    assert.equal(result.firedFloor, "senior");
  });

  test("a failing prepare() is logged and skipped, doesn't poison the dispatcher", async () => {
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const result = await dispatchCapacityFloor([
      {
        name: "broken",
        priority: 1,
        async prepare() { throw new Error("prepare failed"); },
        async buildAnchor() { throw new Error("should not run"); },
      },
      {
        name: "ok",
        priority: 2,
        async prepare() { return { deficit: 2, share: 0, targetShare: 0.25, payload: {} }; },
        async buildAnchor() { return { type: "research", reference: "ok" }; },
      },
    ]);
    assert.equal(result.firedFloor, "ok");
    // Broken floor still appears in evaluations, marked not-ready.
    const broken = result.evaluations.find((e) => e.name === "broken");
    assert.ok(broken);
    assert.equal(broken!.ready, false);
  });
});

// ---------------------------------------------------------------------------
// Config loader / env-var bridge
// ---------------------------------------------------------------------------

describe("loadCapacityFloorsConfig — env vars (issue #321)", () => {
  test("default config is stable across releases", async () => {
    const { loadCapacityFloorsConfig } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const cfg = loadCapacityFloorsConfig({});
    assert.equal(cfg.reframe.cadenceN, 5);
    assert.equal(cfg.windowCycles, 20);
  });

  test("HYDRA_CAPACITY_FLOORS_WINDOW overrides the rolling window", async () => {
    const { loadCapacityFloorsConfig } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const cfg = loadCapacityFloorsConfig({ HYDRA_CAPACITY_FLOORS_WINDOW: "50" });
    assert.equal(cfg.windowCycles, 50);
  });
});

// ---------------------------------------------------------------------------
// Default floor composition
// ---------------------------------------------------------------------------

describe("default floors composition (issue #321)", () => {
  test("defaultCapacityFloors returns [reframe] post-ADR-0010", async () => {
    const { defaultCapacityFloors } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const floors = defaultCapacityFloors({});
    // Specs floor retired in #513; self-improvement/stuckness floor retired
    // in ADR-0010. The dispatcher scaffolding stays so future floors plug
    // in cleanly without reintroducing the stacking bug.
    assert.equal(floors.length, 1);
    assert.equal(floors[0].name, "reframe");
  });
});

// ---------------------------------------------------------------------------
// Floors don't fire back-to-back beyond their declared share
// ---------------------------------------------------------------------------

describe("floors compete for the same non-kanban budget (issue #321)", () => {
  // The "stacking" regression: with the pre-refactor code, on a cycle where
  // BOTH a stuckness outcome was fired AND the spec cadence had elapsed,
  // both floors would fire — two floors back-to-back. The dispatcher should
  // fire at most one per cycle. We prove this with synthetic floor decls
  // that just count their own fires.

  test("at most one floor fires per cycle even when multiple are ready", async () => {
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    let aFires = 0;
    let bFires = 0;
    const decls = [
      {
        name: "a",
        priority: 1,
        async prepare() { return { deficit: 5, share: 0, targetShare: 0.5, payload: {} }; },
        async buildAnchor() { aFires++; return { type: "test", reference: "a" }; },
      },
      {
        name: "b",
        priority: 2,
        async prepare() { return { deficit: 5, share: 0, targetShare: 0.5, payload: {} }; },
        async buildAnchor() { bFires++; return { type: "test", reference: "b" }; },
      },
    ];
    const result = await dispatchCapacityFloor(decls);
    assert.equal(aFires + bFires, 1, "exactly one floor fires per dispatch call");
    assert.equal(result.firedFloor !== null, true);
  });

  test("over a 12-cycle simulation, each floor fires once per cadence (no stacking)", async () => {
    // Both floors accumulate deficit at the same rate (1/cycle). Each
    // resets to 0 when it fires. Tiebreak goes to lower-priority `a`,
    // so a fires whenever both are ready — but the moment a fires, b
    // is still ready (deficit > 0) so b fires the NEXT cycle. The
    // alternation is the proof: floors do NOT stack within a single
    // dispatch call.
    const { dispatchCapacityFloor } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    let aFires = 0;
    let bFires = 0;
    let aDeficit = 0;
    let bDeficit = 0;

    const fires: string[] = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      aDeficit += 1;
      bDeficit += 1;
      const decls = [
        {
          name: "a",
          priority: 1,
          async prepare() {
            return aDeficit > 0
              ? { deficit: aDeficit, share: 0, targetShare: 0.5, payload: {} }
              : null;
          },
          async buildAnchor() { aFires++; aDeficit = 0; return { type: "t", reference: "a" }; },
        },
        {
          name: "b",
          priority: 2,
          async prepare() {
            return bDeficit > 0
              ? { deficit: bDeficit, share: 0, targetShare: 0.5, payload: {} }
              : null;
          },
          async buildAnchor() { bFires++; bDeficit = 0; return { type: "t", reference: "b" }; },
        },
      ];
      const r = await dispatchCapacityFloor(decls);
      fires.push(r.firedFloor || "none");
    }
    // No cycle had two fires — the dispatcher always picks exactly one.
    assert.equal(aFires + bFires, 12, "exactly one floor fires per cycle");
    // Both floors get cycles — the loser is never permanently starved.
    assert.ok(aFires > 0 && bFires > 0, `both fire (a=${aFires}, b=${bFires}, fires=${fires.join(",")})`);
  });
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe("getCapacityFloorsSnapshot — API surface (issue #321)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("returns the declared floors with config and zeroed gauges on empty state", async () => {
    const { getCapacityFloorsSnapshot } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const snap = await getCapacityFloorsSnapshot({});
    // Issue #377 left the reframe floor with cadence default 5.
    assert.equal(snap.config.reframe.cadenceN, 5);
    const names = snap.floors.map((f) => f.name);
    assert.deepEqual(names, ["reframe"]);
  });
});
