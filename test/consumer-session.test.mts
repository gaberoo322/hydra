/**
 * test/consumer-session.test.mts — pins the extracted ConsumerSession Seam
 * (issue #2592).
 *
 * ConsumerSession owns the consumer open/stop/recover lifecycle that used to
 * live inside EventBus.consume() / _consuming / stopConsuming() / _handleFailure.
 * Before the extraction the only way to observe "start a consumer and watch its
 * recovery / stop" was Object.create(EventBus.prototype) class-surgery against a
 * bus. These tests construct the session DIRECTLY with a STUB transport (a fake
 * { subscriber, publisher, publishDlq }) — no live Redis, no full bus instance,
 * no class-surgery — which is the core testability benefit the issue asked for.
 *
 * The stream-consume MECHANICS (runAutoclaimRecovery, runLongPollLoop,
 * promoteToDlqIfExhausted) are already covered as free functions in
 * test/event-bus.test.mts (#2455); this suite targets the COORDINATOR wiring
 * that had no coverage: the reapStale→autoclaim→_consuming→longpoll ordering,
 * the _consuming↔isActive↔stop() coupling, and the DLQ delegation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type Redis from "ioredis";
import {
  ConsumerSession,
  type ConsumerTransport,
} from "../src/consumer-session.ts";

// ---------------------------------------------------------------------------
// Stub transport — a fake { subscriber, publisher, publishDlq } that records
// the raw-stream verbs the session drives, with no live Redis.
// ---------------------------------------------------------------------------

interface Recorder {
  calls: string[];
  xautoclaimReplies: unknown[];
  xreadgroupReplies: (unknown | (() => unknown))[];
  xpendingReply: [string, string, number, number][];
  dlqEntries: unknown[];
  /**
   * Bound in start() below to the session's stop() so the stub can HARD-STOP
   * the long-poll loop once all queued replies drain — a test-only safety net
   * so a mis-shaped reply can never spin the loop forever (the loop's own
   * catch-and-retry keeps going while isActive() is true).
   */
  onDrained: () => void;
}

/** One raw stream entry: [msgId, [k0, v0, k1, v1, ...]]. */
function entry(msgId: string, fields: string[]): [string, string[]] {
  return [msgId, fields];
}

/**
 * Build a stub transport plus a recorder. `xautoclaimReplies` /
 * `xreadgroupReplies` are consumed FIFO; a function reply is called each poll
 * (so a test can flip `session.stop()` mid-loop). `xpendingReply` drives the
 * delivery-count read in the DLQ path.
 */
function makeStubTransport(init: Partial<Recorder> = {}): {
  transport: ConsumerTransport;
  rec: Recorder;
} {
  const rec: Recorder = {
    calls: [],
    xautoclaimReplies: init.xautoclaimReplies ?? [["0-0", [], []]],
    xreadgroupReplies: init.xreadgroupReplies ?? [],
    xpendingReply: init.xpendingReply ?? [],
    dlqEntries: [],
    onDrained: () => {},
  };

  const subscriber = {
    async xautoclaim() {
      rec.calls.push("xautoclaim");
      return rec.xautoclaimReplies.length ? rec.xautoclaimReplies.shift() : ["0-0", [], []];
    },
    async xreadgroup() {
      rec.calls.push("xreadgroup");
      const next = rec.xreadgroupReplies.shift();
      if (next === undefined) {
        // Queue drained — hard-stop so the loop exits deterministically.
        rec.onDrained();
        return null;
      }
      return typeof next === "function" ? (next as () => unknown)() : next;
    },
    async xack(_s: string, _g: string, msgId: string) {
      rec.calls.push(`xack:${msgId}`);
      return 1;
    },
  } as unknown as Redis;

  const publisher = {
    async xpending() {
      rec.calls.push("xpending");
      return rec.xpendingReply;
    },
    async xinfo() {
      rec.calls.push("xinfo");
      return [];
    },
    async xgroup(verb: string, _s: string, _g: string, name: string) {
      rec.calls.push(`xgroup:${verb}:${name}`);
      return 0;
    },
    async xack() {
      return 1;
    },
  } as unknown as Redis;

  const transport: ConsumerTransport = {
    subscriber,
    publisher,
    publishDlq: async (e) => {
      rec.calls.push("publishDlq");
      rec.dlqEntries.push(e);
      return "dlq-1";
    },
  };

  return { transport, rec };
}

// ---------------------------------------------------------------------------
// Lifecycle: open/stop/recover ordering + _consuming↔isActive↔stop() coupling
// ---------------------------------------------------------------------------

test("ConsumerSession: start runs autoclaim BEFORE the long-poll loop, then stop() exits", async () => {
  const { transport, rec } = makeStubTransport();
  const session = new ConsumerSession(transport);
  rec.onDrained = () => session.stop();

  assert.equal(session.isConsuming(), false);

  await session.start("s", "g", "c", async () => {}, { blockMs: 1 });

  // Autoclaim ran before any xreadgroup (orphan recovery precedes the loop).
  assert.equal(rec.calls[0], "xautoclaim");
  assert.ok(rec.calls.includes("xreadgroup"));
  assert.ok(
    rec.calls.indexOf("xautoclaim") < rec.calls.indexOf("xreadgroup"),
    "autoclaim must precede the long-poll",
  );
  // stop() flipped the flag; the loop exited.
  assert.equal(session.isConsuming(), false);
});

test("ConsumerSession: reapStale sweeps consumers BEFORE autoclaim when opted in", async () => {
  const { transport, rec } = makeStubTransport();
  const session = new ConsumerSession(transport);
  // start() sets _consuming=true after autoclaim, so stop the loop when the
  // (empty) reply queue drains rather than pre-arming.
  rec.onDrained = () => session.stop();

  await session.start("s", "g", "c", async () => {}, { reapStale: true, blockMs: 1 });

  // xinfo (the reapStale sweep) ran before xautoclaim.
  assert.ok(rec.calls.includes("xinfo"), "reapStale must query XINFO CONSUMERS");
  assert.ok(
    rec.calls.indexOf("xinfo") < rec.calls.indexOf("xautoclaim"),
    "reapStale sweep must precede autoclaim recovery",
  );
});

test("ConsumerSession: reapStale defaults OFF — no XINFO sweep without the opt-in", async () => {
  const { transport, rec } = makeStubTransport();
  const session = new ConsumerSession(transport);
  rec.onDrained = () => session.stop();

  await session.start("s", "g", "c", async () => {}, { blockMs: 1 });

  assert.ok(!rec.calls.includes("xinfo"), "no reapStale sweep unless opted in");
});

test("ConsumerSession: isConsuming reflects the loop being active then stopped", async () => {
  const { transport, rec } = makeStubTransport();
  const session = new ConsumerSession(transport);

  let sawActive = false;
  rec.xreadgroupReplies = [
    () => {
      // Inside the first poll the loop is active.
      sawActive = session.isConsuming();
      session.stop();
      return null;
    },
  ];

  await session.start("s", "g", "c", async () => {}, { blockMs: 1 });

  assert.equal(sawActive, true, "_consuming was true while the loop ran");
  assert.equal(session.isConsuming(), false, "stop() flipped it false");
});

// ---------------------------------------------------------------------------
// Delivery: a fresh message is handled + ACKed through the injected transport
// ---------------------------------------------------------------------------

test("ConsumerSession: a delivered message is handled then ACKed", async () => {
  const { transport, rec } = makeStubTransport();
  const session = new ConsumerSession(transport);

  const seen: unknown[] = [];
  rec.xreadgroupReplies = [
    () => {
      session.stop();
      // XREADGROUP reply: [[streamName, [[msgId, fields], ...]], ...]
      return [["s", [entry("5-0", ["type", "hello", "payload", JSON.stringify({ a: 1 })])]]];
    },
  ];

  await session.start("s", "g", "c", async (e) => { seen.push(e); }, { blockMs: 1 });

  assert.equal(seen.length, 1);
  assert.deepEqual((seen[0] as any).payload, { a: 1 }); // parseFields JSON-parsed payload
  assert.ok(rec.calls.includes("xack:5-0"), "the delivered message was ACKed");
});

// ---------------------------------------------------------------------------
// DLQ delegation: a handler throw routes to _handleFailure → promoteToDlq
// ---------------------------------------------------------------------------

test("ConsumerSession: a handler failure past the threshold forwards to the injected publishDlq", async () => {
  // xpending reports deliveryCount 3 → at the promotion threshold.
  const { transport, rec } = makeStubTransport({
    xpendingReply: [["9-0", "c", 1000, 3]],
  });
  const session = new ConsumerSession(transport);

  rec.xreadgroupReplies = [
    () => {
      session.stop();
      return [["s", [entry("9-0", ["type", "boom"])]]];
    },
  ];

  await session.start("s", "g", "c", async () => { throw new Error("handler blew up"); }, { blockMs: 1 });

  // The failure routed through _handleFailure → promoteToDlqIfExhausted →
  // the injected publishDlq (NOT any bus-owned publish), then ACKed off.
  assert.equal(rec.dlqEntries.length, 1);
  const dlq = rec.dlqEntries[0] as any;
  assert.equal(dlq.originalStream, "s");
  assert.equal(dlq.originalGroup, "g");
  assert.equal(dlq.deliveryCount, 3);
  assert.equal(dlq.error, "handler blew up");
  assert.equal(dlq.originalEvent.type, "boom");
});

test("ConsumerSession: a handler failure BELOW the threshold is left in the PEL (no DLQ, no ack)", async () => {
  // deliveryCount 1 → below the 3-attempt threshold; leave for redelivery.
  const { transport, rec } = makeStubTransport({
    xpendingReply: [["9-0", "c", 1000, 1]],
  });
  const session = new ConsumerSession(transport);

  rec.xreadgroupReplies = [
    () => {
      session.stop();
      return [["s", [entry("9-0", ["type", "boom"])]]];
    },
  ];

  await session.start("s", "g", "c", async () => { throw new Error("transient"); }, { blockMs: 1 });

  assert.equal(rec.dlqEntries.length, 0, "below threshold → not promoted");
  assert.ok(!rec.calls.includes("publishDlq"));
  assert.ok(!rec.calls.includes("xack:9-0"), "not ACKed — left in the PEL for redelivery");
});

// ---------------------------------------------------------------------------
// stop() before start(): a no-op that never touches the transport
// ---------------------------------------------------------------------------

test("ConsumerSession: stop() before start() is safe and leaves isConsuming false", () => {
  const { transport } = makeStubTransport();
  const session = new ConsumerSession(transport);
  session.stop();
  assert.equal(session.isConsuming(), false);
});
