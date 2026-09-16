/**
 * Regression tests for the autopilot slot-events HTTP read surface (issue
 * #4510).
 *
 * `collect-state.sh`'s `collect_slot_events` used to `docker exec
 * hydra-redis-1 redis-cli XREAD ...` and hand-parse the plain-text reply via a
 * ~30-line Python regex heuristic with zero test coverage. This route
 * (`GET /autopilot/slot-events?last_id=&count=`) is the thin HTTP adapter onto
 * the already-typed `EventBus.readRaw()` seam (`src/event-bus.ts`, covered
 * directly by `test/event-bus.test.mts`) — these tests pin the route layer:
 * request→seam wiring, default resolution, the response shape
 * `collect_slot_events` pipes straight through as `slot_events_json=`, and the
 * 400 `schema-validation-failed` envelope on a malformed query.
 *
 * Follows the `test/api-maintenance.test.mts` pattern — a minimal `any`-typed
 * eventBus stub (only `readRaw` is exercised here) and hand-rolled
 * req/res mocks, no live Express server, no real Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createAutopilotSlotEventsRouter } from "../src/api/autopilot-slot-events.ts";
import type { EventBus } from "../src/event-bus.ts";

// ---------------------------------------------------------------------------
// Route harness (mirrors test/autopilot-board.test.mts)
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
    send(body: any) {
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

type ReadRawArgs = { stream: string; lastId: string; count: number };

/** Minimal eventBus stub — only `readRaw` is exercised by this route. */
function mockEventBus(
  impl: (stream: string, lastId: string, count: number) => Promise<{
    events: Array<{ id: string; fields: Record<string, string> }>;
    lastId: string | null;
  }>,
  seenArgs?: ReadRawArgs[],
): EventBus {
  return {
    readRaw: async (stream: string, lastId: string, count: number) => {
      seenArgs?.push({ stream, lastId, count });
      return impl(stream, lastId, count);
    },
  } as unknown as EventBus;
}

async function callRoute(eventBus: EventBus, query: Record<string, unknown> = {}) {
  const router = createAutopilotSlotEventsRouter(eventBus);
  const handler = findHandler(router, "GET", ROUTE);
  assert.ok(handler, "route handler must exist");
  const res = mockRes();
  await handler!(mockReq(query), res);
  return res;
}

// ---------------------------------------------------------------------------
// GET /autopilot/slot-events — route (issue #4510)
// ---------------------------------------------------------------------------

describe("GET /autopilot/slot-events — route (issue #4510)", () => {
  test("serves {events, last_id} straight from the seam on the happy path", async () => {
    const events = [
      { id: "1779143539950-0", fields: { event: "subagent_stop", slot: "dev_orch" } },
      { id: "1779143539951-0", fields: { event: "slot_waiting_permission", slot: "qa_orch" } },
    ];
    const res = await callRoute(
      mockEventBus(async () => ({ events, lastId: "1779143539951-0" })),
    );
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.events, events);
    assert.equal(res._body.last_id, "1779143539951-0");
    // Response is snake_case (last_id, not lastId) — collect_slot_events pipes
    // this straight through as `slot_events_json=`, and decide.py's
    // `_unwrap_events_container` parses exactly this key name.
    assert.equal("lastId" in res._body, false);
  });

  test("an empty stream degrades to {events: [], last_id: null}, still 200", async () => {
    const res = await callRoute(mockEventBus(async () => ({ events: [], lastId: null })));
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { events: [], last_id: null });
  });

  test("no query params → defaults last_id='0', count=100 reach the seam", async () => {
    const seen: ReadRawArgs[] = [];
    await callRoute(mockEventBus(async () => ({ events: [], lastId: null }), seen));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stream, "hydra:autopilot:slot-events");
    assert.equal(seen[0].lastId, "0");
    assert.equal(seen[0].count, 100);
  });

  test("last_id and count query params pass through verbatim to the seam", async () => {
    const seen: ReadRawArgs[] = [];
    await callRoute(
      mockEventBus(async () => ({ events: [], lastId: null }), seen),
      { last_id: "1779143530000-0", count: "25" },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].lastId, "1779143530000-0");
    // count is coerced from the query string to a number before it reaches readRaw.
    assert.equal(seen[0].count, 25);
  });

  test("the stream name is always the hard-coded production stream, never caller-supplied", async () => {
    const seen: ReadRawArgs[] = [];
    // Attempting to smuggle a `stream` override is rejected by .strict() below,
    // but even a same-shaped legitimate request only ever reaches the one
    // hard-coded stream name.
    await callRoute(mockEventBus(async () => ({ events: [], lastId: null }), seen));
    assert.equal(seen[0].stream, "hydra:autopilot:slot-events");
  });

  test("malformed count (non-numeric) → 400 schema-validation-failed", async () => {
    const res = await callRoute(mockEventBus(async () => ({ events: [], lastId: null })), {
      count: "not-a-number",
    });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("count below the 1-event floor → 400 schema-validation-failed", async () => {
    const res = await callRoute(mockEventBus(async () => ({ events: [], lastId: null })), {
      count: "0",
    });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("count above the 1000-event stream MAXLEN cap → 400 schema-validation-failed", async () => {
    const res = await callRoute(mockEventBus(async () => ({ events: [], lastId: null })), {
      count: "1001",
    });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("an explicit empty last_id → 400 schema-validation-failed (min(1))", async () => {
    const res = await callRoute(mockEventBus(async () => ({ events: [], lastId: null })), {
      last_id: "",
    });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("an unexpected query key (e.g. a caller-supplied stream override) → 400 (strict schema)", async () => {
    const res = await callRoute(mockEventBus(async () => ({ events: [], lastId: null })), {
      stream: "some:other:stream",
    });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});
