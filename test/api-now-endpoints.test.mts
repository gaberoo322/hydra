/**
 * Regression tests for the /api/now/* route handlers (issue #618).
 *
 * Follows the test/api-v2-today-summary.test.mts pattern — wires the
 * router with stubbed aggregators and calls the handler directly. No
 * live Express server, no real Redis, no subprocesses.
 *
 * Schema-only tests live alongside the route tests so the boundary
 * contract is pinned in one file.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AlertsNowQuerySchema,
  ServiceStripResponseSchema,
  AutopilotTickResponseSchema,
  ActiveDispatchesResponseSchema,
  CostBurnResponseSchema,
  AlertsNowResponseSchema,
} from "../src/schemas/now-page.ts";
import { createNowPageRouter, parseAlertsWindow } from "../src/api/now-page.ts";

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("AlertsNowQuerySchema — happy path", () => {
  test("defaults limit=25 and sinceMinutes=60", () => {
    const result = AlertsNowQuerySchema.safeParse({});
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.limit, 25);
      assert.equal(result.data.sinceMinutes, 60);
    }
  });

  test("coerces stringified numbers (Express query shape)", () => {
    const result = AlertsNowQuerySchema.safeParse({ limit: "50", sinceMinutes: "120" });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.limit, 50);
      assert.equal(result.data.sinceMinutes, 120);
    }
  });
});

describe("AlertsNowQuerySchema — rejection cases", () => {
  test("rejects limit out of band", () => {
    assert.equal(AlertsNowQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(AlertsNowQuerySchema.safeParse({ limit: 200 }).success, false);
  });

  test("rejects sinceMinutes out of band", () => {
    assert.equal(AlertsNowQuerySchema.safeParse({ sinceMinutes: 0 }).success, false);
    assert.equal(AlertsNowQuerySchema.safeParse({ sinceMinutes: 1441 }).success, false);
  });

  test("rejects unknown keys (strict mode)", () => {
    const result = AlertsNowQuerySchema.safeParse({ limit: 10, foo: 1 });
    assert.equal(result.success, false);
  });
});

describe("Response schemas — aggregator shape pins", () => {
  test("ServiceStripResponseSchema accepts a typical payload", () => {
    const result = ServiceStripResponseSchema.safeParse({
      rows: [{ service: "redis", status: "ok", lastChecked: "ts" }],
      generatedAt: "ts",
    });
    assert.equal(result.success, true);
  });

  test("ServiceStripResponseSchema rejects an unknown status", () => {
    const result = ServiceStripResponseSchema.safeParse({
      rows: [{ service: "x", status: "purple", lastChecked: "ts" }],
      generatedAt: "ts",
    });
    assert.equal(result.success, false);
  });

  test("AutopilotTickResponseSchema accepts a null currentRun", () => {
    const result = AutopilotTickResponseSchema.safeParse({
      running: false,
      lastTickAt: null,
      currentRun: null,
      lifecycle: { state: "idle", runId: null, termReason: null, endedEpoch: null },
      generatedAt: "ts",
    });
    assert.equal(result.success, true);
  });

  test("ActiveDispatchesResponseSchema rejects an unknown source", () => {
    const result = ActiveDispatchesResponseSchema.safeParse({
      items: [
        {
          id: "x",
          classLabel: "y",
          source: "robot",
          startedAt: "ts",
        },
      ],
      generatedAt: "ts",
    });
    assert.equal(result.success, false);
  });

  test("CostBurnResponseSchema rejects out-of-band headroomPct", () => {
    const result = CostBurnResponseSchema.safeParse({
      lastHourSpark: [],
      daySpent: 0,
      dailyBudget: 0,
      headroomPct: 150,
      generatedAt: "ts",
    });
    assert.equal(result.success, false);
  });

  test("AlertsNowResponseSchema tolerates extra alert fields (passthrough)", () => {
    const result = AlertsNowResponseSchema.safeParse({
      items: [
        {
          id: "a1",
          timestamp: "ts",
          message: "boom",
          severity: "error",
          extraField: "yes",
        },
      ],
      windowMinutes: 60,
      generatedAt: "ts",
    });
    assert.equal(result.success, true);
  });
});

// ---------------------------------------------------------------------------
// parseAlertsWindow — pure helper
// ---------------------------------------------------------------------------

describe("parseAlertsWindow — pure helper", () => {
  const now = new Date("2026-05-26T12:00:00.000Z");

  test("includes alerts inside the window, drops older ones", () => {
    const raw = [
      JSON.stringify({ id: "fresh", timestamp: "2026-05-26T11:30:00.000Z", message: "fresh", severity: "error" }),
      JSON.stringify({ id: "stale", timestamp: "2026-05-26T10:00:00.000Z", message: "stale", severity: "error" }),
    ];
    const out = parseAlertsWindow({ raw, sinceMinutes: 60, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "fresh");
  });

  test("skips malformed JSON without throwing", () => {
    const raw = [
      "not-json",
      JSON.stringify({ id: "ok", timestamp: "2026-05-26T11:30:00.000Z", message: "ok", severity: "info" }),
    ];
    const out = parseAlertsWindow({ raw, sinceMinutes: 60, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "ok");
  });

  test("requires id, timestamp, message, severity — drops rows missing any", () => {
    const raw = [
      JSON.stringify({ timestamp: "2026-05-26T11:30:00.000Z", message: "missing id", severity: "error" }),
      JSON.stringify({ id: "ok", timestamp: "2026-05-26T11:30:00.000Z", message: "ok", severity: "info" }),
    ];
    const out = parseAlertsWindow({ raw, sinceMinutes: 60, now });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "ok");
  });
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
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

describe("GET /now/service-strip", () => {
  test("happy path — projects aggregator output into ServiceStripResponse", async () => {
    const router = createNowPageRouter({
      getServiceStrip: async () => [
        { service: "orchestrator", status: "ok", lastChecked: "ts" },
      ],
      now: () => new Date("2026-05-26T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/service-strip");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.rows.length, 1);
    assert.equal(res._body.generatedAt, "2026-05-26T12:00:00.000Z");
  });
});

describe("GET /now/autopilot-tick", () => {
  test("happy path — both sub-sources fulfilled", async () => {
    const router = createNowPageRouter({
      readSchedulerStatus: async () => ({ running: true, lastTickAt: "2026-05-26T11:59:00Z" }),
      readCurrentAutopilotRun: async () => ({
        id: "ap-1",
        startedAt: "2026-05-26T11:30:00Z",
        trigger: "scheduled",
        turns: 4,
        dispatches: 2,
        elapsedSeconds: 1800,
        ageSeconds: 10,
      }),
      // Stubbed so the test is hermetic — `running` now derives from the
      // lifecycle reader, not the scheduler heartbeat (issue #888).
      readAutopilotLifecycle: async () => ({
        state: "running",
        runId: "ap-1",
        termReason: null,
        endedEpoch: null,
      }),
      now: () => new Date("2026-05-26T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-tick");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.running, true);
    assert.equal(res._body.lastTickAt, "2026-05-26T11:59:00Z");
    assert.equal(res._body.currentRun.id, "ap-1");
    assert.equal(res._body.lifecycle.state, "running");
  });

  test("scheduler reader throws → response still ships with null run + running=false", async () => {
    const router = createNowPageRouter({
      readSchedulerStatus: async () => {
        throw new Error("scheduler down");
      },
      readCurrentAutopilotRun: async () => null,
      // Stubbed idle so the test is hermetic and `running` is false
      // independent of the live service's most-recent run (issue #888).
      readAutopilotLifecycle: async () => ({
        state: "idle",
        runId: null,
        termReason: null,
        endedEpoch: null,
      }),
      now: () => new Date("2026-05-26T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-tick");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.running, false);
    assert.equal(res._body.lastTickAt, null);
    assert.equal(res._body.currentRun, null);
    assert.equal(res._body.lifecycle.state, "idle");
  });
});

describe("GET /now/active-dispatches", () => {
  test("happy path — aggregator stub plumbs through", async () => {
    const router = createNowPageRouter({
      getActiveDispatches: async () => [
        {
          id: "ap-1",
          classLabel: "autopilot (manual)",
          source: "autopilot",
          startedAt: "2026-05-26T10:00:00Z",
        },
      ],
      now: () => new Date("2026-05-26T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/active-dispatches");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.items.length, 1);
    assert.equal(res._body.items[0].id, "ap-1");
  });
});

describe("GET /now/cost-burn", () => {
  test("happy path — stamps generatedAt and passes through aggregator fields", async () => {
    const router = createNowPageRouter({
      getCostBurn: async () => ({
        lastHourSpark: [10, 8],
        daySpent: 12.5,
        dailyBudget: 100,
        headroomPct: 87.5,
      }),
      now: () => new Date("2026-05-26T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/cost-burn");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.daySpent, 12.5);
    assert.equal(res._body.headroomPct, 87.5);
    assert.equal(res._body.generatedAt, "2026-05-26T12:00:00.000Z");
  });
});

describe("GET /now/alerts", () => {
  test("happy path — filters by sinceMinutes window", async () => {
    const router = createNowPageRouter({
      readRecentAlertsJson: async () => [
        JSON.stringify({
          id: "in-window",
          timestamp: "2026-05-26T11:30:00.000Z",
          message: "fresh",
          severity: "error",
        }),
        JSON.stringify({
          id: "stale",
          timestamp: "2026-05-26T10:00:00.000Z",
          message: "stale",
          severity: "error",
        }),
      ],
      now: () => new Date("2026-05-26T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/alerts");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({ sinceMinutes: "60" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.windowMinutes, 60);
    assert.equal(res._body.items.length, 1);
    assert.equal(res._body.items[0].id, "in-window");
  });

  test("bad sinceMinutes → 400 schema-validation-failed envelope", async () => {
    const router = createNowPageRouter({});
    const handler = findHandler(router, "GET", "/now/alerts");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq({ sinceMinutes: "abc" }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues));
  });
});
