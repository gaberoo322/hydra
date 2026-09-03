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
 *   - `processStreamEntry` — the shared per-entry fold (issue #4333) both
 *     stream-consume loops route through: parse → handler → ack on success,
 *     onFailure on a handler throw, deleted messages a no-op — plus the
 *     structural pin that the fold exists exactly ONCE in the module.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseStreamFields,
  shouldPromoteToDlq,
  runAutoclaimRecovery,
  processStreamEntry,
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

// ---------------------------------------------------------------------------
// processStreamEntry — the shared per-entry fold (issue #4333). Both
// stream-consume loops route every claimed/delivered entry through this one
// function, so the "ack on success / defer to the DLQ policy on failure"
// contract is asserted here once instead of being pinned separately (and
// driftably) per loop.
// ---------------------------------------------------------------------------

/** Minimal stub ConsumeDeps that records the calls in execution order. */
function recordingDeps() {
  const order: string[] = [];
  return {
    order,
    deps: {
      handler: async (ev: ConsumedEvent) => { order.push(`handler:${ev.type}`); },
      ack: async (msgId: string) => { order.push(`ack:${msgId}`); },
      onFailure: async (msgId: string) => { order.push(`onFailure:${msgId}`); },
    },
  };
}

describe("event-bus-mechanics — processStreamEntry (the shared per-entry fold)", () => {
  test("success: beforeHandler → handler → ack, in that order, with the parsed event", async () => {
    const { order, deps } = recordingDeps();

    await processStreamEntry(
      "7-1",
      ["type", "merge", "payload", JSON.stringify({ pr: 42 })],
      deps,
      (ev) => { order.push(`before:${ev.type}`); },
    );

    assert.deepEqual(order, ["before:merge", "handler:merge", "ack:7-1"]);
  });

  test("beforeHandler is optional — the long-poll loop folds entries without one", async () => {
    const { order, deps } = recordingDeps();

    await processStreamEntry("7-2", ["type", "live"], deps);

    assert.deepEqual(order, ["handler:live", "ack:7-2"]);
  });

  test("a throwing handler routes to onFailure with (msgId, event, err) and never ACKs", async () => {
    const failures: { msgId: string; event: ConsumedEvent; err: Error }[] = [];
    let ackCalled = false;
    const boom = new Error("handler blew up");

    await processStreamEntry("7-3", ["type", "boom"], {
      handler: () => { throw boom; },
      ack: async () => { ackCalled = true; },
      onFailure: async (msgId, event, err) => { failures.push({ msgId, event, err }); },
    });

    assert.equal(ackCalled, false, "a failed entry is not ACKed by the fold");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].msgId, "7-3");
    assert.equal(failures[0].event.type, "boom");
    assert.equal(failures[0].err, boom, "the ORIGINAL error object is handed to onFailure");
  });

  test("a deleted message (empty OR absent field list) is a no-op — no beforeHandler, handler, ack, or onFailure", async () => {
    const { order, deps } = recordingDeps();
    const before: string[] = [];

    await processStreamEntry("8-1", [], deps, (ev) => { before.push(ev.type ?? "?"); });
    await processStreamEntry("8-2", undefined as unknown as string[], deps, (ev) => { before.push(ev.type ?? "?"); });

    assert.deepEqual(order, [], "nothing in the consume contract runs for a deleted message");
    assert.deepEqual(before, [], "the beforeHandler hook is skipped too");
  });
});

describe("event-bus-mechanics — the fold exists exactly once (issue #4333 structural pin)", () => {
  test("the handler/ack/onFailure fold body appears exactly once — both loops share it, neither re-copies it", async () => {
    const src = readFileSync(
      new URL("../src/event-bus-mechanics.ts", import.meta.url),
      "utf8",
    );
    const count = (needle: string) =>
      src.split(needle).length - 1;

    // Before #4333 each loop carried its own copy (2 occurrences each); the
    // dedup contract is that the fold now lives in exactly one function.
    // This is the mechanical enforcement the issue asks for — "nothing keeps
    // the two loops in sync beyond reading them side by side" — now something
    // does: re-duplicating the fold into either loop reddens this test.
    assert.equal(
      count("await deps.handler("), 1,
      "the handler invocation must live in exactly one place (the shared fold)",
    );
    assert.equal(
      count("await deps.ack("), 1,
      "the success-ACK must live in exactly one place (the shared fold)",
    );
    assert.equal(
      count("await deps.onFailure("), 1,
      "the failure→DLQ-policy deferral must live in exactly one place (the shared fold)",
    );
  });
});
