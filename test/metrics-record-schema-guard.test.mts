/**
 * Regression tests for the zod schema guard on **POST /metrics/record**
 * (issue #2636).
 *
 * The endpoint previously accepted an arbitrary body with only an ad-hoc
 * `cycleId` presence check and passed the raw remainder to
 * `recordCycleMetrics`, returning `{error:"Missing cycleId"}` (no `code`
 * field) on a miss — a violation of the CLAUDE.md § HTTP validation
 * convention: _"HTTP request bodies validate through a zod `safeParse`; on
 * failure return 400 `{code:"schema-validation-failed", issues}`."_
 *
 * The sibling endpoint POST /autopilot/cycle-record was refactored to
 * `CycleRecordBodySchema.safeParse()` in #2034; this suite pins the same
 * contract onto /metrics/record:
 *
 *   - happy path: a valid `{cycleId, ...metrics}` body returns 200 {ok:true}
 *     and the metrics land in Redis;
 *   - validation failure: a missing/empty/non-string `cycleId` returns 400
 *     with the machine-readable `{code:"schema-validation-failed", issues}`
 *     shape (NOT the old `{error:"Missing cycleId"}`).
 *
 * Uses Redis DB 1 — never touches production (DB 0). A file-level `after()`
 * hook closes the Redis client so the runner emits `# pass N` lines and CI's
 * PASS_COUNT check doesn't blow up (PR #518 lesson).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const { createMetricsRouter } = await import("../src/api/metrics.ts");

let redis: any;

async function cleanTestKeys() {
  const keys = await redis.keys("hydra:metrics:*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.del("hydra:metrics:index");
}

function mockReq(body: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body };
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

describe("POST /metrics/record zod schema guard (issue #2636)", () => {
  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanTestKeys();
  });

  after(async () => {
    if (redis) {
      await cleanTestKeys();
      redis.disconnect();
    }
  });

  test("handler is mounted on the metrics router", () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    assert.ok(post, "POST /metrics/record handler should exist");
  });

  test("happy path: valid {cycleId, ...metrics} returns 200 {ok:true} and persists", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-2636-${Date.now()}`;
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed", tasksMerged: 3 }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);

    // The metrics landed in the per-cycle Redis hash.
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(hash.status, "completed");
    assert.equal(hash.tasksMerged, "3");
    // recordCycleMetrics stamps the cycleId back onto the hash (record.ts:194).
    assert.equal(hash.cycleId, cycleId);
  });

  test("classifies explicit anchorType through verbatim (issue #2803)", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-2803-explicit-${Date.now()}`;
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed", anchorType: "work-queue" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(hash.anchorType, "work-queue");
  });

  test("classifies absent anchorType to the 'unclassified' sentinel, never 'unknown' (issue #2803)", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-2803-absent-${Date.now()}`;
    const res = mockRes();
    // No anchorType, and a cycleId that does NOT match the worktree-agent slot
    // pattern → classifyAnchorType falls back to the "unclassified" sentinel.
    await post!(mockReq({ cycleId, status: "completed" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    // The endpoint now ALWAYS writes an explicit, non-empty anchorType — the
    // aggregator (src/metrics/aggregate.ts) can never bucket this as "unknown".
    assert.equal(hash.anchorType, "unclassified");
  });

  test("infers anchorType from a worktree-agent-slot cycleId when absent (issue #2803)", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    // The synthesised worktree-branch cycleId format decodes to a slot → anchorType.
    const cycleId = `worktree-agent-abc12345-t3-dev_orch`;
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(hash.anchorType, "work-queue");
    // cleanTestKeys globs hydra:metrics:* so this key is swept too, but be explicit.
    await redis.del(`hydra:metrics:${cycleId}`);
  });

  test("validation failure: missing cycleId returns 400 schema-validation-failed", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const res = mockRes();
    await post!(mockReq({ status: "completed" }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues), "issues array is present");
    // The old ad-hoc {error:"Missing cycleId"} shape is gone.
    assert.equal(res._body.error, undefined);
  });

  test("validation failure: empty-string cycleId returns 400 schema-validation-failed", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const res = mockRes();
    await post!(mockReq({ cycleId: "   " }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("validation failure: non-string cycleId returns 400 schema-validation-failed", async () => {
    const router = createMetricsRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const res = mockRes();
    await post!(mockReq({ cycleId: 42 }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});
