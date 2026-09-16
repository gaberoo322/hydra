/**
 * Regression tests for the autopilot slot-events HTTP read (issue #4510).
 *
 * `scripts/autopilot/collect-state.sh`'s `collect_slot_events` used to shell
 * out to `docker exec hydra-redis-1 redis-cli XREAD` and hand-parse the reply
 * through a ~30-line Python regex heuristic. This endpoint projects the same
 * read through the typed `EventBus.readRaw()` (`src/event-bus.ts`) instead,
 * mirroring the `GET /autopilot/board-state` pattern.
 *
 * Follows the `test/autopilot-board.test.mts` / `test/autopilot-idle.test.mts`
 * pattern — wires the router with a stubbed `EventBus` and calls the route
 * handler directly. No live Express server, no real Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createAutopilotSlotEventsRouter } from "../src/api/autopilot-slot-events.ts";
import { AutopilotSlotEventsResponseSchema } from "../src/schemas/autopilot-slot-events.ts";
import type { EventBus } from "../src/event-bus.ts";

// ---------------------------------------------------------------------------
// Harness — mirrors test/autopilot-board.test.mts's mockReq/mockRes/findHandler
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
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

const ROUTE = "/autopilot/slot-events";

/** A fake EventBus exposing only what the route calls: `readRaw`. */
function fakeBus(readRaw: EventBus["readRaw"]): EventBus {
  return { readRaw } as unknown as EventBus;
}

async function callRoute(readRaw: EventBus["readRaw"], query: Record<string, unknown> = {}) {
  const router = createAutopilotSlotEventsRouter(fakeBus(readRaw));
  const handler = findHandler(router, "GET", ROUTE);
  assert.ok(handler, "route handler must exist");
  const res = mockRes();
  await handler!(mockReq(query), res);
  return res;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

describe("GET /autopilot/slot-events (issue #4510)", () => {
  test("happy path: forwards last_id/count to readRaw and returns its {events, last_id} verbatim", async () => {
    let captured: [string, string | undefined, number | undefined] | null = null;
    const res = await callRoute(
      async (stream, lastId, count) => {
        captured = [stream, lastId, count];
        return {
          events: [{ id: "1700000000000-0", fields: { event: "subagent_stop", slot: "dev_orch" } }],
          last_id: "1700000000000-0",
        };
      },
      { last_id: "42-0", count: "5" },
    );

    assert.equal(res._status, 200);
    assert.deepEqual(captured, ["hydra:autopilot:slot-events", "42-0", 5]);
    const parsed = AutopilotSlotEventsResponseSchema.safeParse(res._body);
    assert.ok(parsed.success, `response failed schema: ${JSON.stringify((parsed as any).error?.issues)}`);
    assert.deepEqual(res._body, {
      events: [{ id: "1700000000000-0", fields: { event: "subagent_stop", slot: "dev_orch" } }],
      last_id: "1700000000000-0",
    });
  });

  test("defaults: last_id=\"0\" and count=100 when the query supplies neither", async () => {
    let captured: [string, string | undefined, number | undefined] | null = null;
    await callRoute(async (stream, lastId, count) => {
      captured = [stream, lastId, count];
      return { events: [], last_id: null };
    });

    assert.deepEqual(captured, ["hydra:autopilot:slot-events", "0", 100]);
  });

  test("never-throw-200: a readRaw throw degrades to the empty shape with HTTP 200, never a 5xx", async () => {
    const res = await callRoute(async () => {
      throw new Error("ECONNREFUSED");
    });

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { events: [], last_id: null });
  });

  test("empty stream: readRaw's own empty shape passes straight through", async () => {
    const res = await callRoute(async () => ({ events: [], last_id: null }));

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { events: [], last_id: null });
  });

  test("400 schema-validation-failed on a malformed count", async () => {
    const res = await callRoute(async () => ({ events: [], last_id: null }), { count: "not-a-number" });

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("400 schema-validation-failed on an unknown query key (.strict())", async () => {
    const res = await callRoute(async () => ({ events: [], last_id: null }), { bogus: "1" });

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("count is bounded to [1, 1000]", async () => {
    const overRes = await callRoute(async () => ({ events: [], last_id: null }), { count: "5000" });
    assert.equal(overRes._status, 400);

    const zeroRes = await callRoute(async () => ({ events: [], last_id: null }), { count: "0" });
    assert.equal(zeroRes._status, 400);
  });

  test("hard-codes the production stream — a caller cannot supply a stream name in the query", async () => {
    let capturedStream: string | null = null;
    await callRoute(async (stream) => {
      capturedStream = stream;
      return { events: [], last_id: null };
    }, { stream: "some-other-stream" } as any);

    // `.strict()` rejects the unknown `stream` key with a 400 before readRaw
    // is even called — but if it somehow were forwarded, it must never
    // reach readRaw as anything but the one hard-coded production stream.
    assert.equal(capturedStream, null, "readRaw must not be called with an operator-supplied stream override");
  });
});
