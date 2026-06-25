/**
 * test/event-bus.test.mts — pins the typed Event Bus Seam (#884).
 *
 * The Event Bus is the single Seam every `hydra:*` reader/writer crosses
 * (CONTEXT.md: "the Event Bus alphabet"). Before #884 its Interface was
 * `any`-typed, so "what is a valid event / a valid stream" was untestable
 * through the Seam. Now that `publish()` constructs a typed `EventEnvelope`,
 * `consume()` hands handlers a typed `ConsumedEvent`, and `STREAMS` is the
 * closed live set, the Interface IS the test surface.
 *
 * These tests exercise the real prototype methods against fake Redis /
 * WS seams — no live Redis connection. We build instances via
 * `Object.create(EventBus.prototype)` so the constructor's lazy
 * `getRedisConnection()` never fires.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EventBus,
  STREAMS,
  RETAINED_STREAMS,
  CONSUMER_GROUPS,
  streamKey,
  parseStreamFields,
  shouldPromoteToDlq,
  getDeliveryCount,
  promoteToDlqIfExhausted,
  runAutoclaimRecovery,
  runLongPollLoop,
  type ConsumedEvent,
} from "../src/event-bus.ts";
import { makeWsBroadcastRegistry } from "../src/ws-broadcast-registry.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface XaddCall {
  stream: string;
  args: string[];
}
interface BroadcastCall {
  stream: string;
  event: Record<string, unknown>;
}

function makeFakePublisher() {
  const xaddCalls: XaddCall[] = [];
  return {
    publisher: {
      async xadd(stream: string, ...args: string[]) {
        xaddCalls.push({ stream, args });
        return "1-0";
      },
    },
    xaddCalls,
  };
}

/**
 * Build a real EventBus whose Redis + WS seams are fakes, without running
 * the constructor (which would lazily open a real ioredis connection).
 */
function makeBus(publisher: unknown) {
  const bus = Object.create(EventBus.prototype) as EventBus;
  // @ts-expect-error — assigning a fake into the typed publisher seam for the test.
  bus.publisher = publisher;
  // The WS broadcast registry (issue #1965) is composed in the real ctor,
  // which we skip via Object.create — install a real one here. Individual
  // tests override `bus.wsRegistry` to capture broadcasts.
  // @ts-expect-error — assigning into the readonly wsRegistry seam for the test.
  bus.wsRegistry = makeWsBroadcastRegistry();
  bus._consuming = false;
  return bus;
}

// ---------------------------------------------------------------------------
// streamKey — the one sanctioned `string`-widening escape hatch
// ---------------------------------------------------------------------------

test("streamKey: prefixes a dynamic name with hydra:", () => {
  assert.equal(streamKey("notifications"), "hydra:notifications");
  assert.equal(streamKey("custom"), "hydra:custom");
});

// ---------------------------------------------------------------------------
// STREAMS / RETAINED_STREAMS — the live set advertises only live streams
// ---------------------------------------------------------------------------

test("STREAMS advertises only the live streams a consumer reads", () => {
  // NOTIFICATIONS + DLQ are the live set; META/TASKS/CYCLE were pruned out.
  assert.deepEqual(Object.keys(STREAMS).sort(), ["DLQ", "NOTIFICATIONS"]);
  assert.equal(STREAMS.NOTIFICATIONS, "hydra:notifications");
  assert.equal(STREAMS.DLQ, "hydra:dlq");
});

test("RETAINED_STREAMS holds the back-compat-only names, separate from the live set", () => {
  // TASKS/META deleted in #1655 — zero producers/consumers; only CYCLE remains.
  assert.deepEqual(Object.keys(RETAINED_STREAMS).sort(), ["CYCLE"]);
  // The dead names must NOT leak back into the live STREAMS map.
  for (const k of Object.keys(RETAINED_STREAMS)) {
    assert.ok(!(k in STREAMS), `${k} must not be in the live STREAMS set`);
  }
});

test("CONSUMER_GROUPS only declares groups on live streams", () => {
  for (const stream of Object.keys(CONSUMER_GROUPS)) {
    const liveValues = Object.values(STREAMS) as string[];
    assert.ok(liveValues.includes(stream), `${stream} has a group but is not a live stream`);
  }
});

// ---------------------------------------------------------------------------
// publish — the fixed EventEnvelope wire shape (ADR-0017 Category A)
// ---------------------------------------------------------------------------

test("publish: XADDs the fixed envelope shape and JSON-stringifies the payload", async () => {
  const { publisher, xaddCalls } = makeFakePublisher();
  const bus = makeBus(publisher);

  const msgId = await bus.publish(STREAMS.NOTIFICATIONS, {
    type: "test:event",
    source: "unit",
    payload: { hello: "world" },
  });

  assert.equal(msgId, "1-0");
  assert.equal(xaddCalls.length, 1);
  assert.equal(xaddCalls[0].stream, "hydra:notifications");

  // args are [ "*", k0, v0, k1, v1, ... ] — fold back into an object. The
  // values are the raw JS envelope values (real Redis string-coerces them on
  // the wire; this fake captures them pre-coercion).
  const [star, ...flat] = xaddCalls[0].args;
  assert.equal(star, "*");
  const env: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) env[flat[i]] = flat[i + 1];

  // The envelope names exactly these six fields.
  assert.deepEqual(Object.keys(env).sort(), [
    "correlationId",
    "id",
    "payload",
    "source",
    "timestamp",
    "type",
  ]);
  assert.equal(env.type, "test:event");
  assert.equal(env.source, "unit");
  assert.equal(env.payload, JSON.stringify({ hello: "world" }));
  assert.equal(env.correlationId, null); // defaulted to null when caller omits it
  assert.ok((env.id as string).length > 0);
  assert.ok(!Number.isNaN(Date.parse(env.timestamp as string)));
});

test("publish: defaults correlationId to null and payload to {}", async () => {
  const { publisher, xaddCalls } = makeFakePublisher();
  const bus = makeBus(publisher);

  await bus.publish(STREAMS.DLQ, { type: "t", source: "s" });

  const flat = xaddCalls[0].args.slice(1);
  const env: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) env[flat[i]] = flat[i + 1];
  assert.equal(env.payload, JSON.stringify({}));
});

test("publish: broadcasts the parsed (not stringified) payload to WS clients", async () => {
  const { publisher } = makeFakePublisher();
  const bus = makeBus(publisher);

  const broadcasts: BroadcastCall[] = [];
  bus.wsRegistry.broadcast = (stream: string, event: object) => {
    broadcasts.push({ stream, event: event as Record<string, unknown> });
  };

  await bus.publish(STREAMS.NOTIFICATIONS, {
    type: "t",
    source: "s",
    payload: { a: 1 },
  });

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].stream, "hydra:notifications");
  // WS frame carries the structured payload object, not the JSON string.
  assert.deepEqual(broadcasts[0].event.payload, { a: 1 });
});

// ---------------------------------------------------------------------------
// publishRaw — the flat field-list wire shape (ADR-0017 Category B)
// ---------------------------------------------------------------------------

test("publishRaw: XADDs the flat fields verbatim with a MAXLEN cap", async () => {
  const { publisher, xaddCalls } = makeFakePublisher();
  const bus = makeBus(publisher);

  const msgId = await bus.publishRaw("hydra:autopilot:slot-events", ["event", "x", "slot", "dev"], {
    maxlen: 5000,
  });

  assert.equal(msgId, "1-0");
  assert.deepEqual(xaddCalls[0].args, [
    "MAXLEN",
    "~",
    "5000",
    "*",
    "event",
    "x",
    "slot",
    "dev",
  ]);
});

test("publishRaw: omits MAXLEN when no cap is given and broadcasts the flat object", async () => {
  const { publisher, xaddCalls } = makeFakePublisher();
  const bus = makeBus(publisher);

  const broadcasts: BroadcastCall[] = [];
  bus.wsRegistry.broadcast = (stream: string, event: object) => {
    broadcasts.push({ stream, event: event as Record<string, unknown> });
  };

  await bus.publishRaw("hydra:custom", ["k", "v"]);

  assert.deepEqual(xaddCalls[0].args, ["*", "k", "v"]);
  assert.deepEqual(broadcasts[0].event, { k: "v" });
});

// ---------------------------------------------------------------------------
// _parseFields — the inbound ConsumedEvent shape
// ---------------------------------------------------------------------------

test("_parseFields: folds flat fields into an object and JSON-parses payload", () => {
  const bus = makeBus(makeFakePublisher().publisher);
  const event = bus._parseFields([
    "type",
    "x:y",
    "source",
    "svc",
    "payload",
    JSON.stringify({ n: 7 }),
  ]);
  assert.equal(event.type, "x:y");
  assert.equal(event.source, "svc");
  assert.deepEqual(event.payload, { n: 7 });
});

test("_parseFields: keeps payload as a raw string when it is not valid JSON", () => {
  const bus = makeBus(makeFakePublisher().publisher);
  const event = bus._parseFields(["payload", "not-json"]);
  assert.equal(event.payload, "not-json");
});

test("_parseFields: round-trips a publish() envelope back to a typed event", async () => {
  const { publisher, xaddCalls } = makeFakePublisher();
  const bus = makeBus(publisher);
  await bus.publish(STREAMS.NOTIFICATIONS, {
    type: "round:trip",
    source: "unit",
    payload: { ok: true },
  });
  // The XADD flat field list is exactly what a consumer reads back.
  const flat = xaddCalls[0].args.slice(1);
  const parsed = bus._parseFields(flat);
  assert.equal(parsed.type, "round:trip");
  assert.equal(parsed.source, "unit");
  assert.deepEqual(parsed.payload, { ok: true });
});

// ---------------------------------------------------------------------------
// reapStaleConsumers — zombie sweep on the $-anchored slot-events groups (#1221)
// ---------------------------------------------------------------------------

/**
 * Fake publisher for the reaper: `xinfo("CONSUMERS", ...)` returns the supplied
 * consumer rows (each a flat field/value list, exactly as Redis replies), and
 * `xgroup("DELCONSUMER", stream, group, name)` records the reaped names.
 */
function makeFakeReaperPublisher(consumers: string[][]) {
  const delconsumerCalls: { stream: string; group: string; name: string }[] = [];
  return {
    publisher: {
      async xinfo(sub: string, _stream: string, _group: string) {
        assert.equal(sub, "CONSUMERS");
        return consumers;
      },
      async xgroup(verb: string, stream: string, group: string, name: string) {
        assert.equal(verb, "DELCONSUMER");
        delconsumerCalls.push({ stream, group, name });
        return 0;
      },
    },
    delconsumerCalls,
  };
}

/** A Redis XINFO-CONSUMERS row as a flat field/value list. */
function consumerRow(name: string, idle: number): string[] {
  return ["name", name, "pending", "0", "idle", String(idle), "inactive", String(idle)];
}

test("reapStaleConsumers: reaps a consumer idle past the floor, leaves live and self", async () => {
  const { publisher, delconsumerCalls } = makeFakeReaperPublisher([
    consumerRow("bridge-OLD", 600_000),   // 10min idle — STALE, reap
    consumerRow("bridge-LIVE", 1_000),    // 1s idle — live, keep
    consumerRow("bridge-SELF", 999_999),  // high idle but it's us — keep
  ]);
  const bus = makeBus(publisher);

  const reaped = await bus.reapStaleConsumers(
    "hydra:autopilot:slot-events",
    "now-pixel-bridge",
    "bridge-SELF",
  );

  // Only the stale, non-self consumer is reaped.
  assert.deepEqual(reaped, ["bridge-OLD"]);
  assert.equal(delconsumerCalls.length, 1);
  assert.deepEqual(delconsumerCalls[0], {
    stream: "hydra:autopilot:slot-events",
    group: "now-pixel-bridge",
    name: "bridge-OLD",
  });
});

test("reapStaleConsumers: never reaps our own name even when its idle is high", async () => {
  const { publisher, delconsumerCalls } = makeFakeReaperPublisher([
    consumerRow("recs-SELF", 10_000_000), // freshly created, idle clock briefly high
  ]);
  const bus = makeBus(publisher);

  const reaped = await bus.reapStaleConsumers(
    "hydra:autopilot:slot-events",
    "recs-engine",
    "recs-SELF",
  );

  assert.deepEqual(reaped, []);
  assert.equal(delconsumerCalls.length, 0);
});

test("reapStaleConsumers: a consumer exactly at the floor is NOT reaped (strict >)", async () => {
  const { publisher, delconsumerCalls } = makeFakeReaperPublisher([
    consumerRow("bridge-AT", 300_000), // exactly 5min — not strictly greater
  ]);
  const bus = makeBus(publisher);

  const reaped = await bus.reapStaleConsumers(
    "hydra:autopilot:slot-events",
    "now-pixel-bridge",
    "bridge-NEW",
    300_000,
  );

  assert.deepEqual(reaped, []);
  assert.equal(delconsumerCalls.length, 0);
});

test("reapStaleConsumers: a recently-active consumer (idle < floor) is left untouched", async () => {
  const { publisher, delconsumerCalls } = makeFakeReaperPublisher([
    consumerRow("bridge-RECENT", 4_000), // active 4s ago — well under 5min
  ]);
  const bus = makeBus(publisher);

  const reaped = await bus.reapStaleConsumers(
    "hydra:autopilot:slot-events",
    "now-pixel-bridge",
    "bridge-NEW",
  );

  assert.deepEqual(reaped, []);
  assert.equal(delconsumerCalls.length, 0);
});

test("reapStaleConsumers: never throws — an XINFO failure returns [] and is swallowed", async () => {
  const bus = makeBus({
    publisher: {
      async xinfo() { throw new Error("CONNREFUSED"); },
      async xgroup() { throw new Error("should not be called"); },
    },
  }.publisher);

  const reaped = await bus.reapStaleConsumers("s", "g", "self");
  assert.deepEqual(reaped, []);
});

test("delConsumer: best-effort DELCONSUMER of our own name on graceful shutdown", async () => {
  const calls: string[][] = [];
  const bus = makeBus({
    publisher: {
      async xgroup(...args: string[]) { calls.push(args); return 0; },
    },
  }.publisher);

  await bus.delConsumer("hydra:autopilot:slot-events", "recs-engine", "recs-123");
  assert.deepEqual(calls, [["DELCONSUMER", "hydra:autopilot:slot-events", "recs-engine", "recs-123"]]);
});

test("delConsumer: swallows a DELCONSUMER failure (never throws on shutdown)", async () => {
  const bus = makeBus({
    publisher: { async xgroup() { throw new Error("NOGROUP"); } },
  }.publisher);
  // Must resolve, not reject.
  await bus.delConsumer("s", "g", "c");
});

// ---------------------------------------------------------------------------
// Extracted stream-consume protocol (#2455) — the XAUTOCLAIM recovery pass,
// the XREADGROUP long-poll loop, the DLQ-promotion policy, and the field
// parser as module-level free functions, tested with a stub Redis client and
// synthetic RawStreamEntry inputs (no full bus instance).
// ---------------------------------------------------------------------------

// --- parseStreamFields: the pure inbound parser the class _parseFields wraps ---

test("parseStreamFields: folds flat fields and JSON-parses payload", () => {
  const event = parseStreamFields([
    "type", "x:y", "source", "svc", "payload", JSON.stringify({ n: 7 }),
  ]);
  assert.equal(event.type, "x:y");
  assert.equal(event.source, "svc");
  assert.deepEqual(event.payload, { n: 7 });
});

test("parseStreamFields: keeps a non-JSON payload as the raw string", () => {
  const event = parseStreamFields(["payload", "not-json"]);
  assert.equal(event.payload, "not-json");
});

test("EventBus._parseFields delegates to the module-level parseStreamFields", () => {
  const bus = makeBus(makeFakePublisher().publisher);
  assert.deepEqual(
    bus._parseFields(["type", "t", "payload", JSON.stringify({ a: 1 })]),
    parseStreamFields(["type", "t", "payload", JSON.stringify({ a: 1 })]),
  );
});

// --- shouldPromoteToDlq: the pure 3-attempt threshold predicate ---

test("shouldPromoteToDlq: the 3-attempt threshold is directly assertable", () => {
  assert.equal(shouldPromoteToDlq(0), false);
  assert.equal(shouldPromoteToDlq(2), false); // 2 attempts — below the floor
  assert.equal(shouldPromoteToDlq(3), true);  // exactly 3 — promote
  assert.equal(shouldPromoteToDlq(7), true);
});

// --- getDeliveryCount: reads the 4th element of the XPENDING summary row ---

test("getDeliveryCount: returns the deliveryCount from the XPENDING summary row", async () => {
  const redis = {
    async xpending() { return [["1-0", "consumer-A", 1234, 5]]; },
  } as any;
  assert.equal(await getDeliveryCount(redis, "s", "g", "1-0"), 5);
});

test("getDeliveryCount: returns 0 when the message has no PEL entry", async () => {
  const redis = { async xpending() { return []; } } as any;
  assert.equal(await getDeliveryCount(redis, "s", "g", "1-0"), 0);
});

// --- promoteToDlqIfExhausted: the DLQ-promotion policy as a unit ---

test("promoteToDlqIfExhausted: publishes to DLQ + ACKs once the count crosses 3", async () => {
  const acked: string[] = [];
  const redis = {
    async xpending() { return [["1-0", "c", 0, 3]]; }, // 3 attempts
    async xack(_s: string, _g: string, msgId: string) { acked.push(msgId); return 1; },
  } as any;
  const dlqEntries: unknown[] = [];
  const event: ConsumedEvent = { type: "boom", source: "svc" };

  const promoted = await promoteToDlqIfExhausted(
    redis, "hydra:notifications", "telegram", "1-0", event,
    new Error("handler blew up"),
    async (entry) => { dlqEntries.push(entry); return "dlq-1"; },
  );

  assert.equal(promoted, true);
  assert.deepEqual(acked, ["1-0"]);
  assert.equal(dlqEntries.length, 1);
  assert.deepEqual(dlqEntries[0], {
    originalStream: "hydra:notifications",
    originalGroup: "telegram",
    originalEvent: event,
    error: "handler blew up",
    deliveryCount: 3,
  });
});

test("promoteToDlqIfExhausted: leaves the message in the PEL below the threshold", async () => {
  let xackCalled = false;
  const redis = {
    async xpending() { return [["1-0", "c", 0, 1]]; }, // only 1 attempt
    async xack() { xackCalled = true; return 1; },
  } as any;
  const dlqEntries: unknown[] = [];

  const promoted = await promoteToDlqIfExhausted(
    redis, "s", "g", "1-0", { type: "t" }, new Error("fail"),
    async (entry) => { dlqEntries.push(entry); return null; },
  );

  assert.equal(promoted, false);
  assert.equal(xackCalled, false, "must NOT ack a message left for redelivery");
  assert.equal(dlqEntries.length, 0, "must NOT publish to DLQ below the threshold");
});

// --- runAutoclaimRecovery: the orphan-reclaim pass ---

test("runAutoclaimRecovery: reclaims, parses, handles, and ACKs an orphaned message", async () => {
  // One page of claimed entries, then a terminal "0-0" cursor to end the loop.
  const pages: [string, [string, string[]][]][] = [
    ["0-0", [["1-0", ["type", "orphan", "payload", JSON.stringify({ v: 1 })]]]],
  ];
  let call = 0;
  const acked: string[] = [];
  const redis = {
    async xautoclaim() { return pages[call++] ?? ["0-0", []]; },
  } as any;

  const handled: ConsumedEvent[] = [];
  await runAutoclaimRecovery(redis, "s", "g", "consumer-1", {
    handler: (e) => { handled.push(e); },
    ack: async (msgId) => { acked.push(msgId); return 1; },
    onFailure: async () => { throw new Error("should not be called"); },
  });

  assert.equal(handled.length, 1);
  assert.equal(handled[0].type, "orphan");
  assert.deepEqual(handled[0].payload, { v: 1 });
  assert.deepEqual(acked, ["1-0"]);
});

test("runAutoclaimRecovery: short-circuits a deleted message (empty field list)", async () => {
  let call = 0;
  const redis = {
    async xautoclaim() {
      return call++ === 0
        ? ["0-0", [["1-0", []], ["2-0", ["type", "kept"]]]] // first is deleted
        : ["0-0", []];
    },
  } as any;

  const handled: ConsumedEvent[] = [];
  const acked: string[] = [];
  await runAutoclaimRecovery(redis, "s", "g", "c", {
    handler: (e) => { handled.push(e); },
    ack: async (msgId) => { acked.push(msgId); return 1; },
    onFailure: async () => {},
  });

  // The deleted message (empty fields) is skipped; only "kept" is handled.
  assert.equal(handled.length, 1);
  assert.equal(handled[0].type, "kept");
  assert.deepEqual(acked, ["2-0"]);
});

test("runAutoclaimRecovery: a handler throw routes to onFailure, not ack", async () => {
  let call = 0;
  const redis = {
    async xautoclaim() {
      return call++ === 0 ? ["0-0", [["1-0", ["type", "boom"]]]] : ["0-0", []];
    },
  } as any;

  const failures: { msgId: string; event: ConsumedEvent }[] = [];
  let ackCalled = false;
  await runAutoclaimRecovery(redis, "s", "g", "c", {
    handler: () => { throw new Error("handler failed"); },
    ack: async () => { ackCalled = true; return 1; },
    onFailure: async (msgId, event) => { failures.push({ msgId, event }); },
  });

  assert.equal(ackCalled, false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].msgId, "1-0");
  assert.equal(failures[0].event.type, "boom");
});

test("runAutoclaimRecovery: never throws — an XAUTOCLAIM error is swallowed", async () => {
  const redis = { async xautoclaim() { throw new Error("CONNREFUSED"); } } as any;
  // Must resolve, not reject.
  await runAutoclaimRecovery(redis, "s", "g", "c", {
    handler: () => {},
    ack: async () => 1,
    onFailure: async () => {},
  });
});

// --- runLongPollLoop: the XREADGROUP long-poll, gated by isActive() ---

test("runLongPollLoop: processes one delivery then exits when isActive flips false", async () => {
  let active = true;
  const redis = {
    async xreadgroup() {
      // Deliver one batch, then flip the loop off so it exits after this pass.
      active = false;
      return [["s", [["1-0", ["type", "live", "payload", JSON.stringify({ k: 9 })]]]]];
    },
  } as any;

  const handled: ConsumedEvent[] = [];
  const acked: string[] = [];
  await runLongPollLoop(
    redis, "s", "g", "c", { count: 1, blockMs: 5 },
    () => active,
    {
      handler: (e) => { handled.push(e); },
      ack: async (msgId) => { acked.push(msgId); return 1; },
      onFailure: async () => {},
    },
  );

  assert.equal(handled.length, 1);
  assert.equal(handled[0].type, "live");
  assert.deepEqual(handled[0].payload, { k: 9 });
  assert.deepEqual(acked, ["1-0"]);
});

test("runLongPollLoop: a null XREADGROUP reply continues without handling", async () => {
  let active = true;
  let calls = 0;
  const redis = {
    async xreadgroup() {
      calls++;
      if (calls >= 2) active = false; // exit on the second pass
      return null; // BLOCK timed out, no messages
    },
  } as any;

  let handlerCalled = false;
  await runLongPollLoop(
    redis, "s", "g", "c", { count: 1, blockMs: 1 },
    () => active,
    { handler: () => { handlerCalled = true; }, ack: async () => 1, onFailure: async () => {} },
  );

  assert.equal(handlerCalled, false);
  assert.ok(calls >= 2);
});

test("runLongPollLoop: a handler throw routes to onFailure, not ack", async () => {
  let active = true;
  const redis = {
    async xreadgroup() {
      active = false;
      return [["s", [["1-0", ["type", "boom"]]]]];
    },
  } as any;

  const failures: string[] = [];
  let ackCalled = false;
  await runLongPollLoop(
    redis, "s", "g", "c", { count: 1, blockMs: 1 },
    () => active,
    {
      handler: () => { throw new Error("nope"); },
      ack: async () => { ackCalled = true; return 1; },
      onFailure: async (msgId) => { failures.push(msgId); },
    },
  );

  assert.equal(ackCalled, false);
  assert.deepEqual(failures, ["1-0"]);
});

test("runLongPollLoop: exits immediately when isActive() is already false", async () => {
  let xreadCalled = false;
  const redis = { async xreadgroup() { xreadCalled = true; return null; } } as any;
  await runLongPollLoop(
    redis, "s", "g", "c", { count: 1, blockMs: 1 },
    () => false,
    { handler: () => {}, ack: async () => 1, onFailure: async () => {} },
  );
  assert.equal(xreadCalled, false, "loop must not poll when already inactive");
});
