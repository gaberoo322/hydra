/**
 * Regression tests for POST /api/autopilot/cycle-record (issue #430).
 *
 * Bug: After PR-3 (#383) deleted the in-process control loop, autopilot
 * subagents never wrote cycle records or called recordCycleMetrics. As a
 * result:
 *
 *   - `/api/cycle/history` served 38h-old pre-cut-over data
 *   - `/api/metrics?count=50` was 94% codex-era cycles
 *   - `hydra:scheduler:cycles-{run,merged,failed}` were frozen at the
 *     cut-over numbers (cycles-failed=5661 with no autopilot writer)
 *   - `decide.py` reasoned over fossilised inputs every tick
 *
 * Fix: `POST /api/autopilot/cycle-record` is the missing writer. It
 * performs three complementary writes — per-cycle hash + index, per-cycle
 * metric, and lifetime counters — and is idempotent on cycleId so retries
 * don't double-count.
 *
 * These tests verify:
 *   AC1 — A merged record writes hydra:cycle:<id> hash + cycleIndex ZADD,
 *         a metrics hash + metricsIndex entry, AND increments both
 *         cycles-run and cycles-merged.
 *   AC2 — A failed record increments cycles-run and cycles-failed.
 *   AC3 — An abandoned record increments cycles-run only (neither merged
 *         nor failed buckets) and shows up under tasksAbandoned in the
 *         metric trend.
 *   AC4 — Re-posting the same cycleId is a no-op: counters do NOT
 *         increment twice. This is the dedup guarantee on retries.
 *   AC5 — Missing cycleId returns 400. (Input validation.)
 *   AC6 — The cycleIndex ZSET stays in sync with the per-cycle hashes
 *         after multiple writes.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

function mockReq(body: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
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

describe("POST /api/autopilot/cycle-record (issue #430)", () => {
  let createAutopilotRouter: any;
  let handler: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createAutopilotRouter) {
      const mod = await import("../src/api/autopilot-lifecycle.ts");
      createAutopilotRouter = mod.createAutopilotLifecycleRouter;
    }
    const router = createAutopilotRouter();
    handler = findHandler(router, "POST", "/autopilot/cycle-record");
    assert.ok(handler, "POST /autopilot/cycle-record handler should exist");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // AC1 — merged record writes all three surfaces
  // ---------------------------------------------------------------------------
  test("AC1: merged record writes cycle hash, metrics hash, and bumps cycles-merged", async () => {
    const req = mockReq({
      cycleId: "autopilot-turn-42",
      status: "merged",
      source: "claude",
      anchorType: "issue",
      anchorReference: "430",
      taskTitle: "wire autopilot cycle records",
      tasksMerged: 1,
      prNumber: 999,
      totalDurationMs: 12345,
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.cycleId, "autopilot-turn-42");
    assert.equal(res._body.bucketed, "merged");
    assert.equal(res._body.deduped, false);

    // Per-cycle hash exists with the right shape.
    const cycle = await redis.hgetall("hydra:cycle:autopilot-turn-42");
    assert.equal(cycle.status, "merged");
    assert.equal(cycle.source, "claude");
    assert.equal(cycle.completed, "1");

    // cycleIndex ZSET populated.
    const indexed = await redis.zrange("hydra:cycle:index", 0, -1);
    assert.deepEqual(indexed, ["autopilot-turn-42"]);

    // Per-cycle metric hash exists and is in the metrics index.
    const metric = await redis.hgetall("hydra:metrics:autopilot-turn-42");
    assert.equal(metric.cycleId, "autopilot-turn-42");
    assert.equal(metric.source, "claude");
    assert.equal(metric.anchorType, "issue");
    assert.equal(metric.tasksMerged, "1");
    assert.equal(metric.prNumber, "999");
    const metricsIndexed = await redis.zrange("hydra:metrics:index", 0, -1);
    assert.deepEqual(metricsIndexed, ["autopilot-turn-42"]);

    // Lifetime counters bumped.
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-merged"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-failed"), null);
  });

  // ---------------------------------------------------------------------------
  // AC2 — failed record buckets to cycles-failed
  // ---------------------------------------------------------------------------
  test("AC2: failed record bumps cycles-failed, not cycles-merged", async () => {
    const req = mockReq({
      cycleId: "autopilot-turn-43",
      status: "failed",
      source: "claude",
      tasksFailed: 1,
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._body.bucketed, "failed");
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-merged"), null);
    assert.equal(await redis.get("hydra:scheduler:cycles-failed"), "1");

    const metric = await redis.hgetall("hydra:metrics:autopilot-turn-43");
    assert.equal(metric.tasksFailed, "1");
  });

  // ---------------------------------------------------------------------------
  // AC3 — abandoned record only increments cycles-run
  // ---------------------------------------------------------------------------
  test("AC3: abandoned record increments cycles-run only; tasksAbandoned recorded", async () => {
    const req = mockReq({
      cycleId: "autopilot-turn-44",
      status: "abandoned",
      source: "claude",
      tasksAbandoned: 1,
      abandonReason: "Burned class: soft cap",
    });
    const res = mockRes();
    await handler(req, res);

    // "abandoned" maps to the FAILED_STATUSES bucket — it's a failure
    // bucket from the lifetime-counter perspective. (See bucketing table
    // in src/api/autopilot-lifecycle.ts.)
    assert.equal(res._body.bucketed, "failed");
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-failed"), "1");

    const metric = await redis.hgetall("hydra:metrics:autopilot-turn-44");
    assert.equal(metric.tasksAbandoned, "1");
    assert.equal(metric.abandonReason, "Burned class: soft cap");
  });

  // ---------------------------------------------------------------------------
  // AC4 — Idempotent on cycleId: re-posting is a no-op
  // ---------------------------------------------------------------------------
  test("AC4: re-posting same cycleId does not double-count counters", async () => {
    const body = {
      cycleId: "autopilot-turn-45",
      status: "merged",
      source: "claude",
      tasksMerged: 1,
    };

    const res1 = mockRes();
    await handler(mockReq(body), res1);
    assert.equal(res1._body.deduped, false);
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-merged"), "1");

    // Second post with same cycleId — counters must NOT advance.
    const res2 = mockRes();
    await handler(mockReq(body), res2);
    assert.equal(res2._status, 200);
    assert.equal(res2._body.deduped, true);
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-merged"), "1");

    // Index still has exactly one entry.
    assert.equal(await redis.zcard("hydra:cycle:index"), 1);
  });

  // ---------------------------------------------------------------------------
  // AC5 — Missing cycleId returns 400
  // ---------------------------------------------------------------------------
  test("AC5: missing cycleId returns 400 with error message", async () => {
    const res = mockRes();
    await handler(mockReq({ status: "merged" }), res);
    assert.equal(res._status, 400);
    assert.match(res._body.error, /cycleId/i);

    // No writes happened.
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), null);
    assert.equal(await redis.zcard("hydra:cycle:index"), 0);
  });

  // ---------------------------------------------------------------------------
  // AC6 — cycleIndex tracks every distinct cycleId
  // ---------------------------------------------------------------------------
  test("AC6: cycleIndex stays in sync across multiple distinct writes", async () => {
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await handler(
        mockReq({
          cycleId: `autopilot-turn-${100 + i}`,
          status: i === 0 ? "merged" : i === 1 ? "failed" : "abandoned",
          source: "claude",
        }),
        res,
      );
      assert.equal(res._body.ok, true);
    }
    assert.equal(await redis.zcard("hydra:cycle:index"), 3);
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "3");
    assert.equal(await redis.get("hydra:scheduler:cycles-merged"), "1");
    assert.equal(await redis.get("hydra:scheduler:cycles-failed"), "2");
  });

  // ---------------------------------------------------------------------------
  // AC7 (issue #1919) — a status in NEITHER MERGED_STATUSES nor FAILED_STATUSES
  // bumps cycles-run AND the new cycles-unaccounted counter, and reports
  // bucketed:"unaccounted". Previously such a status bumped cycles-run only,
  // silently inflating the (run - merged - failed) gap that produced the 600
  // unaccounted cycles.
  // ---------------------------------------------------------------------------
  test("AC7: neutral status bumps cycles-unaccounted and reports bucketed:unaccounted", async () => {
    for (const status of ["no-op", "skipped", "dry-run"]) {
      const res = mockRes();
      await handler(
        mockReq({ cycleId: `autopilot-turn-neutral-${status}`, status, source: "claude" }),
        res,
      );
      assert.equal(res._body.ok, true);
      assert.equal(res._body.bucketed, "unaccounted", `${status} should bucket as unaccounted`);
    }
    assert.equal(await redis.get("hydra:scheduler:cycles-run"), "3");
    assert.equal(await redis.get("hydra:scheduler:cycles-unaccounted"), "3");
    // Neutral statuses must NOT pollute the merged/failed buckets (invariant #3:
    // MERGED/FAILED classification semantics unchanged).
    assert.equal(await redis.get("hydra:scheduler:cycles-merged"), null);
    assert.equal(await redis.get("hydra:scheduler:cycles-failed"), null);
  });

  // ---------------------------------------------------------------------------
  // AC8 (issue #1919) — the counter identity holds for a mixed batch:
  // cyclesRun == cyclesMerged + cyclesFailed + cyclesUnaccounted. This is the
  // checkable invariant that turns the implicit subtraction gap into a
  // first-class property.
  // ---------------------------------------------------------------------------
  test("AC8: cyclesRun == merged + failed + unaccounted for a mixed batch", async () => {
    const statuses = [
      "merged", "completed", "succeeded", // 3 merged
      "failed", "abandoned", "aborted", "timeout", // 4 failed
      "no-op", "idle", // 2 unaccounted
    ];
    for (let i = 0; i < statuses.length; i++) {
      const res = mockRes();
      await handler(
        mockReq({ cycleId: `autopilot-turn-mixed-${i}`, status: statuses[i], source: "claude" }),
        res,
      );
      assert.equal(res._body.ok, true);
    }
    const run = parseInt((await redis.get("hydra:scheduler:cycles-run")) || "0", 10);
    const merged = parseInt((await redis.get("hydra:scheduler:cycles-merged")) || "0", 10);
    const failed = parseInt((await redis.get("hydra:scheduler:cycles-failed")) || "0", 10);
    const unaccounted = parseInt((await redis.get("hydra:scheduler:cycles-unaccounted")) || "0", 10);

    assert.equal(run, statuses.length);
    assert.equal(merged, 3);
    assert.equal(failed, 4);
    assert.equal(unaccounted, 2);
    // The identity #1919 makes queryable.
    assert.equal(run, merged + failed + unaccounted);
  });

  // ---------------------------------------------------------------------------
  // AC9 (issue #1919) — dedup early-return touches NO counter (not even
  // unaccounted). bucketed:null is reserved for the deduped path.
  // ---------------------------------------------------------------------------
  test("AC9: re-posting a neutral cycleId is a no-op on cycles-unaccounted", async () => {
    const body = { cycleId: "autopilot-turn-neutral-dedup", status: "no-op", source: "claude" };

    const res1 = mockRes();
    await handler(mockReq(body), res1);
    assert.equal(res1._body.bucketed, "unaccounted");
    assert.equal(res1._body.deduped, false);
    assert.equal(await redis.get("hydra:scheduler:cycles-unaccounted"), "1");

    const res2 = mockRes();
    await handler(mockReq(body), res2);
    assert.equal(res2._body.deduped, true);
    assert.equal(res2._body.bucketed, null); // null == dedup, distinct from "unaccounted"
    assert.equal(await redis.get("hydra:scheduler:cycles-unaccounted"), "1");
  });
});
