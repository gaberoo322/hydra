/**
 * Regression tests for the autopilot slot-events HTTP read surface
 * (issue #4510).
 *
 * `collect-state.sh`'s `collect_slot_events` used to `docker exec
 * hydra-redis-1 redis-cli XREAD ...` and re-derive `{id, fields}` from the
 * plain-text reply via a ~30-line hand-rolled Python regex parser. This
 * route (`GET /autopilot/slot-events`) is the thin HTTP adapter onto
 * `EventBus.readRaw()` (src/event-bus.ts, tested directly in
 * test/event-bus.test.mts) that replaces it — `collect_slot_events` now
 * does `hydra raw GET /autopilot/slot-events?...` and pipes the response
 * straight through with zero reshaping.
 *
 * These tests exercise the route handler directly (no live Express server,
 * no real Redis), mirroring the test/autopilot-board.test.mts harness —
 * an injected fake `EventBus` stands in for the real one.
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

type FakeEventBusOpts = {
  readRaw?: EventBus["readRaw"];
};

function fakeEventBus(opts: FakeEventBusOpts = {}): EventBus {
  return {
    readRaw:
      opts.readRaw ??
      (async () => ({
        events: [{ id: "1779143539950-0", fields: { event: "subagent_stop" } }],
        lastId: "1779143539950-0",
      })),
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

describe("GET /autopilot/slot-events — route (issue #4510)", () => {
  test("happy path: returns 200 with snake_case {events, last_id} — byte-identical to the old bash+regex shape (design-concept invariant #5)", async () => {
    let seenArgs: unknown[] = [];
    const bus = fakeEventBus({
      readRaw: async (stream, lastId, count) => {
        seenArgs = [stream, lastId, count];
        return {
          events: [{ id: "1779143539950-0", fields: { event: "subagent_stop", slot: "dev_orch" } }],
          lastId: "1779143539950-0",
        };
      },
    });

    const res = await callRoute(bus, { last_id: "100-0", count: "50" });

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, {
      events: [{ id: "1779143539950-0", fields: { event: "subagent_stop", slot: "dev_orch" } }],
      last_id: "1779143539950-0",
    });
    // No `lastId` (camelCase) leak into the wire shape — decide.py's
    // consumer parses `last_id` exactly as the old bash pipeline emitted it.
    assert.equal((res._body as any).lastId, undefined);
    assert.deepEqual(seenArgs, ["hydra:autopilot:slot-events", "100-0", 50]);
  });

  test("defaults last_id to '0' and count to 100 when the query is empty — matches collect_slot_events's existing bash defaults", async () => {
    let seenArgs: unknown[] = [];
    const bus = fakeEventBus({
      readRaw: async (stream, lastId, count) => {
        seenArgs = [stream, lastId, count];
        return { events: [], lastId: null };
      },
    });

    await callRoute(bus, {});

    assert.deepEqual(seenArgs, ["hydra:autopilot:slot-events", "0", 100]);
  });

  test("an empty/never-throwing readRaw() result still answers 200 with the empty shape — a Redis outage must never abort the autopilot turn (invariant #3)", async () => {
    const bus = fakeEventBus({
      readRaw: async () => ({ events: [], lastId: null }),
    });

    const res = await callRoute(bus);

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { events: [], last_id: null });
  });

  test("plain read, never a consumer-group read: the route forwards only (stream, last_id, count) to readRaw() — no group name argument exists to pass (invariant #2 / #6)", async () => {
    let argCount = -1;
    const bus = fakeEventBus({
      readRaw: async (...args: unknown[]) => {
        argCount = args.length;
        return { events: [], lastId: null };
      },
    });

    await callRoute(bus, { last_id: "5-0", count: "10" });

    // readRaw's signature is (stream, lastId, count) — 3 positional args,
    // nothing shaped like a consumer-group name.
    assert.equal(argCount, 3);
  });

  test("rejects a non-numeric count with 400 schema-validation-failed", async () => {
    const bus = fakeEventBus();
    const res = await callRoute(bus, { count: "not-a-number" });

    assert.equal(res._status, 400);
    assert.equal((res._body as any).code, "schema-validation-failed");
  });

  test("rejects an unknown query param (strict schema)", async () => {
    const bus = fakeEventBus();
    const res = await callRoute(bus, { stream: "some-other-stream" });

    assert.equal(res._status, 400);
    assert.equal((res._body as any).code, "schema-validation-failed");
  });

  test("rejects count above the 1000 cap (mirrors the stream's own MAXLEN ~ 1000)", async () => {
    const bus = fakeEventBus();
    const res = await callRoute(bus, { count: "1001" });

    assert.equal(res._status, 400);
    assert.equal((res._body as any).code, "schema-validation-failed");
  });
});
