/**
 * Regression tests for the autopilot lifecycle-truth slice (issue #888).
 *
 * Two layers:
 *   1. `deriveLifecycleState` — the pure discriminated-state derivation in
 *      src/autopilot/run-lifecycle-state.ts (no Redis, no clock).
 *   2. The /now/autopilot-tick route handler — that `running` is now
 *      derived from `lifecycle.state === "running"`, NOT the scheduler
 *      housekeeping heartbeat, and that the `lifecycle` field rides the
 *      response and validates against the schema.
 *
 * Follows the test/api-now-endpoints.test.mts pattern — wires the router
 * with stubbed readers and calls the handler directly. No live Express
 * server, no real Redis, no subprocesses.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { deriveLifecycleState } from "../src/autopilot/run-lifecycle-state.ts";
import { createNowPageRouter } from "../src/api/now-page.ts";
import { AutopilotTickResponseSchema } from "../src/schemas/now-page.ts";

// ---------------------------------------------------------------------------
// deriveLifecycleState — pure derivation
// ---------------------------------------------------------------------------

describe("deriveLifecycleState — pure derivation (issue #888)", () => {
  test("no row → idle with null run_id", () => {
    const lc = deriveLifecycleState(null);
    assert.equal(lc.state, "idle");
    assert.equal(lc.run_id, null);
    assert.equal(lc.term_reason, null);
    assert.equal(lc.ended_epoch, null);
  });

  test("running status + live pid → running", () => {
    // process.pid is alive by definition for this test process.
    const lc = deriveLifecycleState({
      run_id: "ap-1",
      status: "running",
      pid: String(process.pid),
    });
    assert.equal(lc.state, "running");
    assert.equal(lc.run_id, "ap-1");
    assert.equal(lc.term_reason, null);
    assert.equal(lc.ended_epoch, null);
  });

  test("running status + dead pid → crashed (belt-and-braces re-check)", () => {
    // pid 999999999 is not a live process in CI/dev sandboxes.
    const lc = deriveLifecycleState({
      run_id: "ap-2",
      status: "running",
      pid: "999999999",
      ended_epoch: "1700",
    });
    assert.equal(lc.state, "crashed");
    assert.equal(lc.term_reason, "crash");
    assert.equal(lc.ended_epoch, 1700);
  });

  test("killed status → crashed", () => {
    const lc = deriveLifecycleState({
      run_id: "ap-3",
      status: "killed",
      term_reason: "crash",
      ended_epoch: "1800",
    });
    assert.equal(lc.state, "crashed");
    assert.equal(lc.term_reason, "crash");
    assert.equal(lc.ended_epoch, 1800);
  });

  test("ended status → ended, carries term_reason + ended_epoch", () => {
    const lc = deriveLifecycleState({
      run_id: "ap-4",
      status: "ended",
      term_reason: "budget",
      ended_epoch: "1900",
    });
    assert.equal(lc.state, "ended");
    assert.equal(lc.term_reason, "budget");
    assert.equal(lc.ended_epoch, 1900);
  });

  test("a terminal most-recent run is NEVER running", () => {
    for (const status of ["ended", "killed"]) {
      const lc = deriveLifecycleState({ run_id: "x", status, pid: String(process.pid) });
      assert.notEqual(lc.state, "running");
    }
  });

  test("unknown terminal status → idle fallback", () => {
    const lc = deriveLifecycleState({
      run_id: "ap-5",
      status: "stopped",
      term_reason: "idle",
      ended_epoch: "2000",
    });
    assert.equal(lc.state, "idle");
    assert.equal(lc.term_reason, "idle");
    assert.equal(lc.ended_epoch, 2000);
  });

  test("missing ended_epoch on a terminal row → null (not NaN)", () => {
    const lc = deriveLifecycleState({ run_id: "ap-6", status: "ended", term_reason: "wall_clock" });
    assert.equal(lc.ended_epoch, null);
  });
});

// ---------------------------------------------------------------------------
// GET /now/autopilot-tick — lifecycle wiring
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

describe("GET /now/autopilot-tick — lifecycle truth (issue #888)", () => {
  test("running derives from lifecycle, NOT the scheduler heartbeat", async () => {
    // Scheduler heartbeat says running=true, but the autopilot lifecycle
    // is idle → the response must report running=false.
    const router = createNowPageRouter({
      readSchedulerStatus: async () => ({ running: true, lastTickAt: "2026-06-02T11:59:00Z" }),
      readCurrentAutopilotRun: async () => null,
      readAutopilotLifecycle: async () => ({
        state: "idle",
        runId: "ap-1",
        termReason: "budget",
        endedEpoch: 1700,
      }),
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-tick");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.running, false, "running must follow lifecycle, not heartbeat");
    assert.equal(res._body.lastTickAt, "2026-06-02T11:59:00Z");
    assert.equal(res._body.lifecycle.state, "idle");
    assert.equal(res._body.lifecycle.termReason, "budget");
    assert.equal(res._body.lifecycle.endedEpoch, 1700);
    assert.equal(AutopilotTickResponseSchema.safeParse(res._body).success, true);
  });

  test("lifecycle running → running=true", async () => {
    const router = createNowPageRouter({
      readSchedulerStatus: async () => ({ running: false, lastTickAt: null }),
      readCurrentAutopilotRun: async () => ({
        id: "ap-2",
        startedAt: "2026-06-02T11:30:00Z",
        trigger: "scheduled",
        turns: 3,
        dispatches: 1,
        elapsedSeconds: 1800,
        ageSeconds: 5,
      }),
      readAutopilotLifecycle: async () => ({
        state: "running",
        runId: "ap-2",
        termReason: null,
        endedEpoch: null,
      }),
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-tick");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.running, true);
    assert.equal(res._body.lifecycle.state, "running");
    assert.equal(res._body.currentRun.id, "ap-2");
    assert.equal(AutopilotTickResponseSchema.safeParse(res._body).success, true);
  });

  test("lifecycle reader throws → response still ships with idle lifecycle + running=false", async () => {
    const router = createNowPageRouter({
      readSchedulerStatus: async () => ({ running: true, lastTickAt: "2026-06-02T11:59:00Z" }),
      readCurrentAutopilotRun: async () => null,
      readAutopilotLifecycle: async () => {
        throw new Error("redis down");
      },
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-tick");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.running, false);
    assert.equal(res._body.lifecycle.state, "idle");
    assert.equal(AutopilotTickResponseSchema.safeParse(res._body).success, true);
  });

  test("crashed lifecycle surfaces term_reason + ended_epoch", async () => {
    const router = createNowPageRouter({
      readSchedulerStatus: async () => ({ running: false, lastTickAt: null }),
      readCurrentAutopilotRun: async () => null,
      readAutopilotLifecycle: async () => ({
        state: "crashed",
        runId: "ap-3",
        termReason: "crash",
        endedEpoch: 1800,
      }),
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-tick");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.running, false);
    assert.equal(res._body.lifecycle.state, "crashed");
    assert.equal(res._body.lifecycle.termReason, "crash");
    assert.equal(res._body.lifecycle.endedEpoch, 1800);
    assert.equal(AutopilotTickResponseSchema.safeParse(res._body).success, true);
  });
});
