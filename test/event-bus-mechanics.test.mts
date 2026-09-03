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
 *   - The shared per-entry consume fold (#4333) — DIRECT pins on
 *     `processStreamEntry` (exactly-one settlement, ack ordering, ack-reject
 *     routing, onFailure-rejection propagation), a structural guard that the
 *     contract is declared exactly ONCE in the module (both loops route
 *     through it), and parity tests feeding the SAME synthetic entry through
 *     `runAutoclaimRecovery` and `runLongPollLoop` asserting the two drive
 *     the identical observable deps sequence. Plus: the long-poll path has
 *     NO empty-fields skip (that short-circuit is autoclaim-only).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseStreamFields,
  shouldPromoteToDlq,
  runAutoclaimRecovery,
  runLongPollLoop,
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
// The shared per-entry consume fold (issue #4333)
// ---------------------------------------------------------------------------

/**
 * A minimal stub Redis whose `xreadgroup` delivers one canned batch on the
 * first poll (flipping the loop off via `onFirstPoll` so it exits after that
 * pass — the same idiom as the runLongPollLoop tests in event-bus.test.mts),
 * then null. Only the method `runLongPollLoop` touches is implemented.
 */
function stubRedisWithRead(entries: RawStreamEntry[], onFirstPoll?: () => void) {
  let served = false;
  return {
    async xreadgroup() {
      if (served) return null;
      served = true;
      onFirstPoll?.();
      // XREADGROUP reply: [[streamName, [[msgId, fields], ...]], ...]
      return [["stream", entries]];
    },
  } as any;
}

/**
 * Recording deps — captures the exact observable call sequence a loop drives
 * (handler → ack on success; handler → onFailure on throw), so the two loops
 * can be compared sequence-for-sequence on the same synthetic entry.
 */
function recordingDeps(handlerImpl?: (event: ConsumedEvent) => void) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      handler: (event: ConsumedEvent) => {
        calls.push("handler");
        handlerImpl?.(event);
      },
      ack: async (msgId: string) => {
        calls.push(`ack:${msgId}`);
      },
      onFailure: async (msgId: string) => {
        calls.push(`onFailure:${msgId}`);
      },
    },
  };
}

describe("event-bus-mechanics — the shared per-entry consume fold", () => {
  test("direct: exactly-one settlement — a resolved handler settles ack-only; a throwing handler settles onFailure-only", async () => {
    // Success path: handler resolves → ack fires, and ONLY ack.
    const okCalls: string[] = [];
    await processStreamEntry(
      {
        handler: () => { okCalls.push("handler"); },
        ack: async (msgId) => { okCalls.push(`ack:${msgId}`); },
        onFailure: async () => { okCalls.push("onFailure"); },
      },
      "9-1",
      { type: "merge" },
    );
    assert.deepEqual(okCalls, ["handler", "ack:9-1"], "settlement is ack-only");

    // Failure path: handler throws → onFailure fires, and ONLY onFailure.
    const failCalls: string[] = [];
    await processStreamEntry(
      {
        handler: () => { failCalls.push("handler"); throw new Error("boom"); },
        ack: async () => { failCalls.push("ack"); },
        onFailure: async (msgId) => { failCalls.push(`onFailure:${msgId}`); },
      },
      "9-2",
      { type: "boom" },
    );
    assert.deepEqual(failCalls, ["handler", "onFailure:9-2"], "settlement is onFailure-only");
  });

  test("direct: ack ordering — deps.ack is awaited strictly after deps.handler resolves; a throwing handler is never ACKed", async () => {
    const order: string[] = [];
    await processStreamEntry(
      {
        // An async handler: the fold must AWAIT its resolution before acking.
        handler: async () => {
          order.push("handler-start");
          await Promise.resolve();
          order.push("handler-end");
        },
        ack: async () => { order.push("ack"); },
        onFailure: async () => { order.push("onFailure"); },
      },
      "9-3",
      { type: "t" },
    );
    assert.deepEqual(order, ["handler-start", "handler-end", "ack"]);

    // Synchronous throw AND async rejection both land pre-ack.
    for (const handler of [
      () => { throw new Error("sync throw"); },
      async () => { throw new Error("async reject"); },
    ] as const) {
      let ackCalled = false;
      let failureMsgId = "";
      await processStreamEntry(
        { handler, ack: async () => { ackCalled = true; }, onFailure: async (msgId) => { failureMsgId = msgId; } },
        "9-4",
        { type: "t" },
      );
      assert.equal(ackCalled, false, "a handler that throws/rejects is never ACKed");
      assert.equal(failureMsgId, "9-4");
    }
  });

  test("direct: the try wraps handler AND ack — a rejected deps.ack routes to onFailure exactly like a handler throw", async () => {
    const calls: string[] = [];
    let routedMessage = "";
    await processStreamEntry(
      {
        handler: () => { calls.push("handler"); },
        ack: async () => { calls.push("ack"); throw new Error("XACK down"); },
        onFailure: async (_msgId, _event, err) => { calls.push("onFailure"); routedMessage = err.message; },
      },
      "9-5",
      { type: "t" },
    );
    // ack was attempted (handler succeeded), its rejection was caught and
    // routed to onFailure with the ack error itself — the helper RESOLVES.
    assert.deepEqual(calls, ["handler", "ack", "onFailure"]);
    assert.equal(routedMessage, "XACK down");
  });

  test("direct: a rejected deps.onFailure propagates — the helper's promise rejects (no inner catch)", async () => {
    await assert.rejects(
      processStreamEntry(
        {
          handler: () => { throw new Error("boom"); },
          ack: async () => {},
          onFailure: async () => { throw new Error("dlq policy down"); },
        },
        "9-6",
        { type: "t" },
      ),
      /dlq policy down/,
    );
  });

  test("the per-entry contract is declared exactly ONCE and both loops route through it", async () => {
    // Issue #4333: the parse → handler → ACK-on-success / defer-to-DLQ-on-throw
    // body was copy-pasted into both runAutoclaimRecovery and runLongPollLoop,
    // with nothing enforcing the two copies stayed in sync. Both loops now
    // route every entry through ONE fold (processStreamEntry); this structural
    // guard fails if the contract is ever re-forked into a second copy.
    const src = readFileSync(
      new URL("../src/event-bus-mechanics.ts", import.meta.url),
      "utf8",
    );
    const count = (literal: string) => src.split(literal).length - 1;
    assert.equal(
      count("await deps.handler(event);"),
      1,
      "the handler call site must exist exactly once (in the shared fold)",
    );
    assert.equal(
      count("await deps.ack(msgId);"),
      1,
      "the success-ACK call site must exist exactly once (in the shared fold)",
    );
    assert.equal(
      count("await deps.onFailure(msgId, event, err);"),
      1,
      "the failure-deferral call site must exist exactly once (in the shared fold)",
    );
    assert.equal(
      count("await processStreamEntry("),
      2,
      "both runAutoclaimRecovery and runLongPollLoop must route through the fold",
    );
  });

  test("parity: the SAME entry drives the identical success sequence through BOTH loops", async () => {
    const entry: RawStreamEntry = ["7-1", ["type", "merge", "source", "ci"]];

    const claim = recordingDeps();
    await runAutoclaimRecovery(stubRedisWithClaim([entry]), "s", "g", "c", claim.deps);

    let active = true;
    const poll = recordingDeps();
    await runLongPollLoop(
      stubRedisWithRead([entry], () => { active = false; }),
      "s", "g", "c", { count: 1, blockMs: 1 },
      () => active,
      poll.deps,
    );

    assert.deepEqual(
      claim.calls,
      ["handler", "ack:7-1"],
      "a reclaimed orphan is handled then ACKed",
    );
    assert.deepEqual(
      poll.calls,
      claim.calls,
      "a fresh delivery must follow the IDENTICAL contract as a reclaimed orphan",
    );
  });

  test("parity: the SAME throwing entry drives the identical failure sequence through BOTH loops", async () => {
    const entry: RawStreamEntry = ["7-1", ["type", "boom"]];
    const boom = () => { throw new Error("handler blew up"); };

    const claim = recordingDeps(boom);
    await runAutoclaimRecovery(stubRedisWithClaim([entry]), "s", "g", "c", claim.deps);

    let active = true;
    const poll = recordingDeps(boom);
    await runLongPollLoop(
      stubRedisWithRead([entry], () => { active = false; }),
      "s", "g", "c", { count: 1, blockMs: 1 },
      () => active,
      poll.deps,
    );

    assert.deepEqual(
      claim.calls,
      ["handler", "onFailure:7-1"],
      "a throwing handler defers to onFailure and is never ACKed",
    );
    assert.deepEqual(
      poll.calls,
      claim.calls,
      "the failure path must be IDENTICAL through both loops",
    );
  });

  test("loop: the long-poll path has NO empty-fields skip — an empty delivery still reaches the handler", async () => {
    // The deleted-message short-circuit is autoclaim-only (only XAUTOCLAIM
    // surfaces PEL entries whose fields were trimmed). The long-poll path
    // must keep NO such check: an empty field list parses to {} and is
    // handled + ACKed like any other delivery (#4333 INV-6).
    let active = true;
    const handled: ConsumedEvent[] = [];
    const acked: string[] = [];
    await runLongPollLoop(
      stubRedisWithRead([["8-0", []]], () => { active = false; }),
      "s", "g", "c", { count: 1, blockMs: 1 },
      () => active,
      {
        handler: (e) => { handled.push(e); },
        ack: async (msgId) => { acked.push(msgId); },
        onFailure: async () => {},
      },
    );
    assert.equal(handled.length, 1, "an empty-fields delivery is parsed to {} and handled — no skip on this path");
    assert.deepEqual(handled[0], {});
    assert.deepEqual(acked, ["8-0"]);
  });
});
