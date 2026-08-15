/**
 * Regression tests for the /health dashboard page's HTTP contract (issue
 * #4008 — dashboard v3 slice gamma, ADR-0034 §5).
 *
 * The page is the only phone-grade surface ("is it on fire, or burning
 * money?") and every value on it obeys the trust seam from slice alpha
 * (#4006). The dashboard ships no JSX test runner and the worktree resolves
 * no `react`, so — exactly like test/today-page.test.mts — the client half is
 * pinned at the HTTP boundary: the fields these tests assert are the ones the
 * page's status derivation keys off mechanically.
 *
 * What is pinned here (design-concept 2880e735, invariants 1/2/4/5/8/10):
 *   - INV-1  GET /health and GET /health/deep both carry a machine-readable
 *            generatedAt ISO timestamp; /health/deep KEEPS checkedAt (aliased,
 *            not removed) — the additive, non-breaking shape.
 *   - INV-2/4 the drift axis's two raw inputs ride GET /health verbatim:
 *            deployedSha (existing) + originMasterSha (new sibling probe),
 *            which degrades to null — never throws, never blocks /health.
 *   - INV-5  a Redis read failure on emergencyBrake / autopilotPause surfaces
 *            as an explicit not-verified sibling `ok:false` flag, so the
 *            unverified `{engaged:false}` / `{paused:false}` fallback is
 *            distinguishable from the verified one.
 *   - INV-8  the two CostPanel cost endpoints (/metrics/cost-by-class,
 *            /metrics/cost-per-merged-pr) each carry their own generatedAt.
 *
 * Lifecycle: top-level describes with their OWN before/after (per the
 * CLAUDE.md shared-Redis-teardown authoring rule — nothing nests under a
 * sibling suite's after()).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import { createHealthRouter } from "../src/api/health.ts";
import { createMetricsCostRouter } from "../src/api/metrics-cost.ts";

// ---------------------------------------------------------------------------
// Mock Express req/res + router-stack helpers (same shape as
// test/api-health.test.mts / test/today-page.test.mts)
// ---------------------------------------------------------------------------

function mockReq(overrides: any = {}): any {
  return { method: "GET", url: "/health", headers: {}, query: {}, params: {}, body: {}, ...overrides };
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
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

/** A deterministic clock so generatedAt is assertable, not just present. */
const NOW = new Date("2026-08-14T12:00:00.000Z");
const now = () => NOW;

// ---------------------------------------------------------------------------
// GET /health — additive trust fields (INV-1, INV-2, INV-4, INV-5)
// ---------------------------------------------------------------------------

describe("GET /health — trust fields (issue #4008)", () => {
  let redis: any;

  before(async () => {
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
  });

  beforeEach(async () => {
    const keys = await redis.keys("hydra:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  after(async () => {
    if (redis) redis.disconnect();
  });

  test("carries a machine-readable generatedAt ISO timestamp (INV-1)", async () => {
    const router = createHealthRouter({ publisher: redis }, {
      now,
      getRemoteMasterSha: async () => null,
    });
    const handler = findHandler(router, "GET", "/health");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(typeof res._body.generatedAt, "string");
    assert.equal(res._body.generatedAt, NOW.toISOString());
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
  });

  test("is additive: every pre-existing /health field survives (non-breaking shape)", async () => {
    // INV-10 regression lock — the page must not break the watchdog or any
    // existing consumer: status/redis/cycle/uptime/deployedSha keep their
    // names and types; generatedAt/originMasterSha/ok arrive ALONGSIDE.
    const router = createHealthRouter({ publisher: redis }, {
      getDeployedSha: async () => "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      getRemoteMasterSha: async () => null,
    });
    const handler = findHandler(router, "GET", "/health");
    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._body.status, "ok");
    assert.equal(res._body.redis, true);
    assert.equal(res._body.cycle, "idle");
    assert.equal(typeof res._body.uptime, "number");
    assert.equal(res._body.deployedSha, "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
  });

  test("forwards originMasterSha verbatim — the drift axis's second raw input (INV-2/INV-4)", async () => {
    const router = createHealthRouter({ publisher: redis }, {
      getRemoteMasterSha: async () => "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    });
    const handler = findHandler(router, "GET", "/health");
    const res = mockRes();
    await handler(mockReq(), res);
    // The raw SHA, never a derived drift boolean (ADR-0034 §5 rule 3 — the
    // client decomposes drift from its two inputs itself).
    assert.equal(res._body.originMasterSha, "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222");
  });

  test("originMasterSha probe failure degrades to null — never throws, never blocks (INV-4)", async () => {
    const router = createHealthRouter({ publisher: redis }, {
      getRemoteMasterSha: async () => {
        throw new Error("network down");
      },
    });
    const handler = findHandler(router, "GET", "/health");
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.originMasterSha, null);
    // The rest of the surface is unaffected.
    assert.equal(res._body.status, "ok");
  });

  test("verified reads carry ok:true (INV-5)", async () => {
    const router = createHealthRouter({ publisher: redis }, {
      getEmergencyBrake: async () => ({ engaged: false }),
      getAutopilotPaused: async () => ({ paused: false }),
    });
    const handler = findHandler(router, "GET", "/health");
    const res = mockRes();
    await handler(mockReq(), res);
    assert.deepEqual(res._body.emergencyBrake, { engaged: false, ok: true });
    assert.deepEqual(res._body.autopilotPause, { paused: false, ok: true });
  });
});

// ---------------------------------------------------------------------------
// GET /health — unverified vs verified reads (INV-5 regression lock)
// ---------------------------------------------------------------------------

describe("GET /health — Redis read failure is not-verified, never confident (INV-5)", () => {
  let redis: any;

  before(async () => {
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
  });

  after(async () => {
    if (redis) redis.disconnect();
  });

  test("emergencyBrake read failure → {engaged:false, ok:false}, distinguishable from verified", async () => {
    const router = createHealthRouter({ publisher: redis }, {
      getEmergencyBrake: async () => {
        throw new Error("redis read failed");
      },
    });
    const handler = findHandler(router, "GET", "/health");
    const res = mockRes();
    await handler(mockReq(), res);
    // The read must still never block /health (fail-safe contract) ...
    assert.equal(res._status, 200);
    // ... but the fallback must NOT look identical to a verified disengaged
    // brake: the additive sibling ok flag is the distinction the page renders
    // UNKNOWN on.
    assert.equal(res._body.emergencyBrake.engaged, false);
    assert.equal(res._body.emergencyBrake.ok, false);
  });

  test("autopilotPause read failure → {paused:false, ok:false}, distinguishable from verified", async () => {
    const router = createHealthRouter({ publisher: redis }, {
      getAutopilotPaused: async () => {
        throw new Error("redis read failed");
      },
    });
    const handler = findHandler(router, "GET", "/health");
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.autopilotPause.paused, false);
    assert.equal(res._body.autopilotPause.ok, false);
  });

  test("regression: verified and unverified fallbacks are NOT bit-for-bit identical", async () => {
    // The exact #3997-shaped failure mode INV-5 closes: before the ok flag,
    // a dead Redis read rendered exactly like a confirmed "not engaged / not
    // paused" — a confident-looking claim with no verification behind it.
    const mk = (deps: any) => {
      const router = createHealthRouter({ publisher: redis }, deps);
      const handler = findHandler(router, "GET", "/health");
      assert.ok(handler);
      return handler;
    };
    const throwing = { getEmergencyBrake: async () => { throw new Error("x"); }, getAutopilotPaused: async () => { throw new Error("x"); } };
    const clean = { getEmergencyBrake: async () => ({ engaged: false }), getAutopilotPaused: async () => ({ paused: false }) };

    const failedRes = mockRes();
    await mk(throwing)(mockReq(), failedRes);
    const okRes = mockRes();
    await mk(clean)(mockReq(), okRes);

    assert.notEqual(failedRes._body.emergencyBrake.ok, okRes._body.emergencyBrake.ok);
    assert.notEqual(failedRes._body.autopilotPause.ok, okRes._body.autopilotPause.ok);
    assert.equal(okRes._body.emergencyBrake.ok, true);
    assert.equal(failedRes._body.emergencyBrake.ok, false);
  });
});

// ---------------------------------------------------------------------------
// GET /health/deep — generatedAt alias, checkedAt kept (INV-1)
// ---------------------------------------------------------------------------

describe("GET /health/deep — generatedAt alongside kept checkedAt (INV-1)", () => {
  let redis: any;

  before(async () => {
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
  });

  after(async () => {
    if (redis) redis.disconnect();
  });

  test("carries generatedAt AND keeps checkedAt — same instant, both parseable", async () => {
    // collectProbeInputs is injected with an all-coalescable minimal record
    // (parseProbes null-coalesces every field) so this stays hermetic — no
    // 19-probe systemctl/df fan-out in a unit test.
    const router = createHealthRouter({ publisher: redis }, {
      now,
      collectProbeInputs: async () => ({
        basicHealth: { status: "ok", redis: true, cycle: "idle", uptime: 42 },
        scheduler: null,
        metrics: null,
        disk: null,
        mem: null,
        sysdOrchestrator: null,
        sysdWatchdog: null,
        sysdTargetWeb: null,
        patterns: null,
        reflections: null,
        attributionLedgerCount: null,
        darkOutcomes: null,
        redisInfo: null,
        emergencyBrake: null,
      }),
    });
    const handler = findHandler(router, "GET", "/health/deep");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq({ url: "/health/deep" }), res);

    assert.equal(res._status, 200);
    assert.equal(typeof res._body.generatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
    // checkedAt is aliased, NOT removed — existing consumers keep working.
    assert.equal(typeof res._body.checkedAt, "string");
    assert.ok(Number.isFinite(Date.parse(res._body.checkedAt)));
    assert.equal(res._body.generatedAt, res._body.checkedAt);
  });
});

// ---------------------------------------------------------------------------
// Cost endpoints — each figure carries its own generatedAt (INV-8)
// ---------------------------------------------------------------------------

describe("metrics-cost — CostPanel endpoints carry generatedAt (INV-8)", () => {
  test("/metrics/cost-by-class stamps generatedAt additively", async () => {
    const router = createMetricsCostRouter({
      now,
      // Cast loose: only generatedAt/totalTokens/source are asserted; building a
      // full Record<CostClass, CostByClassEntry> fixture would couple this test
      // to the class list.
      getRollingCostByClass: (async () => ({
        date: "2026-08-14",
        totalTokens: 12345,
        byClass: {},
        window: "last 24h (transcript) · test",
        source: "transcript-24h",
      })) as any,
    });
    const handler = findHandler(router, "GET", "/metrics/cost-by-class");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq({ url: "/metrics/cost-by-class" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.generatedAt, NOW.toISOString());
    // Additive: the cost fields survive.
    assert.equal(res._body.totalTokens, 12345);
    assert.equal(res._body.source, "transcript-24h");
  });

  test("/metrics/cost-per-merged-pr stamps generatedAt additively", async () => {
    const router = createMetricsCostRouter({
      now,
      getMetricsTrend: async () => [{ tasksMerged: 1 }],
      getCostPerMergedPr: async (mergedPrCount: number) => ({
        totalTokens: 300,
        mergedPrCount,
        tokensPerMergedPr: 300,
        windowDays: 30,
        window: "last 30d (UTC) · test",
      }),
    });
    const handler = findHandler(router, "GET", "/metrics/cost-per-merged-pr");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq({ url: "/metrics/cost-per-merged-pr" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.generatedAt, NOW.toISOString());
    // The merged count derived from the trend feeds the ratio unchanged.
    assert.equal(res._body.mergedPrCount, 1);
    assert.equal(res._body.tokensPerMergedPr, 300);
  });

  test("the two figures are independently timestamped, never blended (INV-8)", async () => {
    // Drive the two endpoints at DIFFERENT clock instants and assert each
    // keeps its own timestamp — the panel renders one as-of per figure, not
    // one combined cost number.
    const t0 = new Date("2026-08-14T10:00:00.000Z");
    const t1 = new Date("2026-08-14T11:30:00.000Z");
    // Two routers stamped at different instants — generatedAt is per-response,
    // read from the route's own clock each time.
    const r0 = createMetricsCostRouter({
      now: () => t0,
      getRollingCostByClass: (async () => ({ date: "d", totalTokens: 0, byClass: {}, window: "w", source: "transcript-24h" })) as any,
    });
    const r1 = createMetricsCostRouter({
      now: () => t1,
      getMetricsTrend: async () => [],
      getCostPerMergedPr: async () => ({ totalTokens: 0, mergedPrCount: 0, tokensPerMergedPr: null, windowDays: 30, window: "w" }),
    });

    const h0 = findHandler(r0, "GET", "/metrics/cost-by-class");
    const h1 = findHandler(r1, "GET", "/metrics/cost-per-merged-pr");
    const res0 = mockRes();
    await h0(mockReq(), res0);
    const res1 = mockRes();
    await h1(mockReq({ url: "/metrics/cost-per-merged-pr" }), res1);

    assert.equal(res0._body.generatedAt, t0.toISOString());
    assert.equal(res1._body.generatedAt, t1.toISOString());
    assert.notEqual(res0._body.generatedAt, res1._body.generatedAt);
  });
});
