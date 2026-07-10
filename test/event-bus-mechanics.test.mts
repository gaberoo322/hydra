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
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseStreamFields,
  shouldPromoteToDlq,
  runAutoclaimRecovery,
  type RawStreamEntry,
  type ConsumedEvent,
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
