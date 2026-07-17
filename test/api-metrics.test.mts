/**
 * Regression tests for **GET /metrics/unclassified** (issue #3443).
 *
 * Issue #3403 (PR #3406) shipped the instrumentation that captures each
 * still-`unclassified` cycle's attribution metadata (cycleId, prNumber,
 * anchorReference, taskTitle) via `getUnclassifiedAnchors()` in
 * `src/metrics/aggregate.ts`, but the function was exported without a consumer —
 * no API route, so the discovery playbook's >10%-unclassified investigation
 * could not reach it. This route exposes it: a thin delegate that returns the
 * aggregator's body RAW (`{ windowCycles, unclassified[], rate }`, no envelope).
 *
 * The route is exercised by invoking the mounted handler with a mock req/res
 * (the same harness as the sibling `test/metrics-session-tokens-api.test.mts`),
 * seeding the Redis metrics trend the same way `test/abandonment-metrics.test.mts`
 * does. The aggregator's own filter/rate math is covered by
 * `test/unclassified-anchors-instrumentation-3403.test.mts`; this file's job is
 * the HTTP exposure — mount, payload passthrough, rate, and the `count` clamp.
 *
 * Fixture note: to persist as a genuine `unclassified` trend row, a fixture must
 * (a) record an explicit `anchorType: "unclassified"` AND (b) use a
 * STRUCTURALLY UNDECODABLE cycleId (a bare UUID). `getMetricsTrend` re-infers a
 * decodable cycleId's lane at read time (#3390), so a decodable id would be
 * lifted OUT of the sentinel bucket; a bare UUID carries no class signal and
 * correctly stays unclassified (the #2822 never-guess invariant).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports (mirrors abandonment-metrics.test.mts).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { createMetricsRouter } = await import("../src/api/metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  await testRedis.del("hydra:metrics:index");
}

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

// Structurally-undecodable cycleIds (bare UUIDs / harness branch names) — these
// stay the `unclassified` sentinel at read time even after #3390 re-inference.
const UNDECODABLE = [
  "b8a3071f-a783-4812-bec5-8fa0f5079a08",
  "ec3928e1-e125-4342-8d4c-51bcd834fa19",
  "worktree-agent-a9c177cfbcf1de7bf",
];

describe("GET /metrics/unclassified (issue #3443)", () => {
  before(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
  });

  beforeEach(async () => {
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("handler is mounted on the metrics router", () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    assert.ok(get, "GET /metrics/unclassified handler should exist");
  });

  test("happy path: returns unclassified records with cycleId + prNumber and a rate", async () => {
    // 2 unclassified (bare UUIDs, explicit sentinel) + 3 classified (decodable
    // cycleId, real lane) → 5 window cycles, 2/5 = 40.0% unclassified.
    await recordCycleMetrics(UNDECODABLE[0], {
      tasksAttempted: 1,
      anchorType: "unclassified",
      prNumber: "3406",
      taskTitle: "instrument unclassified residue",
    });
    await recordCycleMetrics(UNDECODABLE[1], {
      tasksAttempted: 1,
      anchorType: "unclassified",
      prNumber: "3401",
      anchorReference: "issue-3400",
    });
    for (let i = 0; i < 3; i++) {
      await recordCycleMetrics(`dev-${9000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({}), res);

    assert.equal(res._status, 200);
    // Body is the aggregator's RAW shape — no {ok}/envelope wrapping.
    assert.equal(res._body.windowCycles, 5);
    assert.equal(res._body.rate, 40.0, "2 of 5 cycles unclassified → 40.0%");
    assert.equal(res._body.unclassified.length, 2);

    const byId = Object.fromEntries(
      res._body.unclassified.map((u: any) => [u.cycleId, u]),
    );
    // Operator can trace each unclassified cycle back to its PR (success criterion).
    assert.equal(byId[UNDECODABLE[0]].prNumber, "3406");
    assert.equal(byId[UNDECODABLE[0]].taskTitle, "instrument unclassified residue");
    assert.equal(byId[UNDECODABLE[1]].prNumber, "3401");
    assert.equal(byId[UNDECODABLE[1]].anchorReference, "issue-3400");
  });

  test("empty state: no unclassified cycles → empty array and 0 rate", async () => {
    // Only classified cycles seeded → nothing in the unclassified bucket.
    for (let i = 0; i < 4; i++) {
      await recordCycleMetrics(`dev-${8000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({}), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.windowCycles, 4);
    assert.deepEqual(res._body.unclassified, []);
    assert.equal(res._body.rate, 0);
  });

  test("rate calculation: 1 unclassified in 4 cycles → 25.0%", async () => {
    await recordCycleMetrics(UNDECODABLE[2], {
      tasksAttempted: 1,
      anchorType: "unclassified",
      prNumber: "3299",
    });
    for (let i = 0; i < 3; i++) {
      await recordCycleMetrics(`dev-${7000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({}), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.windowCycles, 4);
    assert.equal(res._body.unclassified.length, 1);
    assert.equal(res._body.rate, 25.0);
    assert.equal(res._body.unclassified[0].prNumber, "3299");
  });

  test("the count query param bounds the read window (clamped-coercion idiom)", async () => {
    // Seed 5 cycles; a count=2 read must only see the 2 most-recent, so the
    // window shrinks — proving `count` is honoured (a hostile value can't fan
    // out unbounded Redis reads).
    for (let i = 0; i < 5; i++) {
      await recordCycleMetrics(`dev-${6000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({ count: "2" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.windowCycles, 2, "count=2 bounds the trend window to 2");
  });
});
