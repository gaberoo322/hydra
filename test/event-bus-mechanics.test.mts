/**
 * Unit tests for `src/event-bus-mechanics.ts` — the injectable stream-consume
 * free functions (issue #3095, anchoring the leaf extracted in #2455 / #2759).
 *
 * Each mechanic takes a raw Redis client + explicit deps, so the protocol is
 * directly assertable with a STUB client and synthetic `RawStreamEntry[]` — no
 * full `EventBus` instance and no live Redis. These are top-level suites with
 * their own lifecycle; none opens a real Redis connection.
 *
 * Coverage:
 *   - `parseStreamFields`  — flat-field fold + JSON-parse of `payload`
 *     (non-JSON payload kept raw).
 *   - `shouldPromoteToDlq` — the 3-attempt DLQ threshold.
 *   - `runAutoclaimRecovery` — the deleted-message (empty-fields) short-circuit
 *     the issue calls out as previously untested: the handler must NOT run.
 *   - `processConsumedEvent` — the shared per-entry settlement fold (issue
 *     #4333) both stream-consume loops route through: handler then ACK on
 *     success, onFailure on a handler throw or a rejected ACK, and a
 *     rejected onFailure propagating to the calling loop.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseStreamFields,
  shouldPromoteToDlq,
  runAutoclaimRecovery,
  processConsumedEvent,
  type RawStreamEntry,
  type ConsumedEvent,
  type ConsumeDeps,
} from "../src/event-bus-mechanics.ts";

describe("event-bus-mechanics — parseStreamFields", () => {
  test("folds a flat [k, v, k, v] field list into an object", () => {
    const ev = parseStreamFields(["type", "cycle.start", "source", "autopilot"]);
    assert.equal(ev.type, "cycle.start");
    assert.equal(ev.source, "autopilot");
  });

  test("JSON-parses the payload field into a structured value", () => {
    const ev = parseStreamFields([
      "type",
      "merge",
      "payload",
      JSON.stringify({ pr: 42, tier: 3 }),
    ]);
    assert.deepEqual(ev.payload, { pr: 42, tier: 3 });
  });

  test("keeps a non-JSON payload as the raw string (never throws)", () => {
    const ev = parseStreamFields(["type", "note", "payload", "not-json{"]);
    assert.equal(ev.payload, "not-json{");
  });

  test("an empty field list folds to an empty object", () => {
    assert.deepEqual(parseStreamFields([]), {});
  });
});

describe("event-bus-mechanics — shouldPromoteToDlq (3-attempt threshold)", () => {
  test("below 3 attempts is NOT promoted", () => {
    assert.equal(shouldPromoteToDlq(0), false);
    assert.equal(shouldPromoteToDlq(1), false);
    assert.equal(shouldPromoteToDlq(2), false);
  });

  test("at exactly 3 attempts flips to promoted (>= threshold)", () => {
    assert.equal(shouldPromoteToDlq(3), true);
  });

  test("above 3 attempts stays promoted", () => {
    assert.equal(shouldPromoteToDlq(4), true);
    assert.equal(shouldPromoteToDlq(99), true);
  });
});

/**
 * A minimal stub Redis whose `xautoclaim` returns one canned reply then an
 * empty batch (so the recovery loop terminates). Only the methods
 * `runAutoclaimRecovery` touches are implemented.
 */
function stubRedisWithClaim(claimed: RawStreamEntry[]) {
  let served = false;
  return {
    async xautoclaim() {
      if (served) return ["0-0", [], []];
      served = true;
      // [nextStartId, entries, deletedIds]; nextStartId "0-0" ends the loop.
      return ["0-0", claimed, []];
    },
  } as any;
}

describe("event-bus-mechanics — runAutoclaimRecovery deleted-message short-circuit", () => {
  test("an entry with an empty field list (deleted message) is skipped — handler NOT called", async () => {
    const handlerCalls: ConsumedEvent[] = [];
    const acked: string[] = [];
    const redis = stubRedisWithClaim([
      ["1-0", []], // deleted message: fields.length === 0
    ]);

    await runAutoclaimRecovery(redis, "stream", "group", "consumer", {
      handler: (ev) => {
        handlerCalls.push(ev);
      },
      ack: async (id) => {
        acked.push(id);
      },
      onFailure: async () => {
        /* intentional: no failure expected in this case */
      },
    });

    assert.equal(handlerCalls.length, 0, "handler must not run for a deleted (empty-fields) message");
    assert.equal(acked.length, 0, "a skipped message is not ACKed");
  });

  test("a real (non-empty) reclaimed entry DOES run the handler and is ACKed", async () => {
    const handlerCalls: ConsumedEvent[] = [];
    const acked: string[] = [];
    const redis = stubRedisWithClaim([
      ["2-0", ["type", "merge", "source", "ci"]],
    ]);

    await runAutoclaimRecovery(redis, "stream", "group", "consumer", {
      handler: (ev) => {
        handlerCalls.push(ev);
      },
      ack: async (id) => {
        acked.push(id);
      },
      onFailure: async () => {
        /* intentional: handler succeeds, no failure path */
      },
    });

    assert.equal(handlerCalls.length, 1, "handler runs for a real reclaimed message");
    assert.equal(handlerCalls[0].type, "merge");
    assert.deepEqual(acked, ["2-0"], "a successfully-handled message is ACKed");
  });

  test("a handler that throws routes to onFailure (not ack), never surfacing the throw", async () => {
    const failures: string[] = [];
    const acked: string[] = [];
    const redis = stubRedisWithClaim([
      ["3-0", ["type", "boom"]],
    ]);

    // Best-effort contract: runAutoclaimRecovery must not throw even when the
    // handler does — the failure is deferred to onFailure.
    await runAutoclaimRecovery(redis, "stream", "group", "consumer", {
      handler: () => {
        throw new Error("handler blew up");
      },
      ack: async (id) => {
        acked.push(id);
      },
      onFailure: async (msgId) => {
        failures.push(msgId);
      },
    });

    assert.deepEqual(failures, ["3-0"], "a throwing handler routes to onFailure");
    assert.equal(acked.length, 0, "a failed message is not ACKed by the recovery pass");
  });
});

// ---------------------------------------------------------------------------
// processConsumedEvent — the shared per-entry settlement fold (issue #4333).
// Both stream-consume loops route every claimed/delivered entry through this
// one function, so the "ack on success / defer to the DLQ policy on failure"
// contract is asserted here once instead of being pinned separately (and
// driftably) per loop. The helper takes the ALREADY-PARSED event (parsing and
// the recovery pass's deleted-message short-circuit stay caller-side), so
// these cases stub the deps directly — no Redis, no loop scaffolding.
// ---------------------------------------------------------------------------

describe("event-bus-mechanics — processConsumedEvent (the shared per-entry settlement fold)", () => {
  test("success: the handler resolves, then the entry is ACKed — no onFailure", async () => {
    const order: string[] = [];

    const deps: ConsumeDeps = {
      handler: async (ev: ConsumedEvent) => { order.push(`handler:${ev.type}`); },
      ack: async (msgId: string) => { order.push(`ack:${msgId}`); },
      onFailure: async () => { order.push("onFailure"); },
    };

    await processConsumedEvent("7-1", { type: "merge" }, deps);

    // Ordering matters: the handler must resolve BEFORE the ACK is awaited.
    assert.deepEqual(order, ["handler:merge", "ack:7-1"]);
  });

  test("a handler throw routes to onFailure with (msgId, event, err) and never ACKs", async () => {
    const failures: { msgId: string; event: ConsumedEvent; err: Error }[] = [];
    let ackCalled = false;
    const boom = new Error("handler blew up");

    await processConsumedEvent("7-2", { type: "boom" }, {
      handler: () => { throw boom; },
      ack: async () => { ackCalled = true; },
      onFailure: async (msgId, event, err) => { failures.push({ msgId, event, err }); },
    });

    assert.equal(ackCalled, false, "a failed entry is not ACKed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].msgId, "7-2");
    assert.equal(failures[0].event.type, "boom");
    assert.equal(failures[0].err, boom, "the ORIGINAL error object is handed to onFailure");
  });

  test("a rejected ack routes to onFailure exactly like a handler throw (the try wraps both)", async () => {
    const failures: { msgId: string; err: Error }[] = [];
    let handlerRan = false;
    const ackBoom = new Error("XACK connection lost");

    await processConsumedEvent("7-3", { type: "merge" }, {
      handler: async () => { handlerRan = true; },
      ack: async () => { throw ackBoom; },
      onFailure: async (msgId, _event, err) => { failures.push({ msgId, err }); },
    });

    assert.equal(handlerRan, true, "the handler resolved first");
    assert.equal(failures.length, 1, "a rejected ACK defers to the DLQ policy, not the caller");
    assert.equal(failures[0].msgId, "7-3");
    assert.equal(failures[0].err, ackBoom, "the ACK's error is handed to onFailure verbatim");
  });

  test("a rejected onFailure propagates — the helper's promise rejects to the calling loop", async () => {
    const dlqBoom = new Error("DLQ policy itself failed");

    await assert.rejects(
      processConsumedEvent("7-4", { type: "boom" }, {
        handler: () => { throw new Error("handler blew up"); },
        ack: async () => 1,
        onFailure: async () => { throw dlqBoom; },
      }),
      (err: unknown) => err === dlqBoom,
      "the helper must NOT swallow a rejection from the DLQ policy",
    );
  });
});
