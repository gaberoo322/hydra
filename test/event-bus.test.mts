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
} from "../src/event-bus.ts";

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
  bus._wsClients = new Set();
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
  bus._broadcastToClients = (stream: string, event: object) => {
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
  bus._broadcastToClients = (stream: string, event: object) => {
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
