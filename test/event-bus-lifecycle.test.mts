import { test } from "node:test";
import assert from "node:assert/strict";

import type Redis from "ioredis";
import {
  ensureConsumerGroup,
  reapStaleConsumers,
  delConsumer,
  initConsumerGroups,
} from "../src/event-bus-lifecycle.ts";

// ---------------------------------------------------------------------------
// event-bus-lifecycle — consumer-group setup/teardown + zombie reaping,
// extracted out of EventBus (mirrors the #1965 WS-registry split). These tests
// exercise the lifecycle functions DIRECTLY against a fake Redis client — the
// leverage the extraction unlocks: no full bus instance, no stream-transport
// state, no _parseFields stubbing beyond what each function takes as a param.
// ---------------------------------------------------------------------------

/** Real EventBus `_parseFields` shape — folds a flat field list into an object. */
function parseFields(fields: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

/** A Redis XINFO-CONSUMERS row as a flat field/value list. */
function consumerRow(name: string, idle: number): string[] {
  return ["name", name, "pending", "0", "idle", String(idle), "inactive", String(idle)];
}

// --- ensureConsumerGroup ----------------------------------------------------

test("ensureConsumerGroup: CREATE with MKSTREAM at the given startId", async () => {
  const calls: string[][] = [];
  const redis = {
    async xgroup(...args: string[]) { calls.push(args); return "OK"; },
  } as unknown as Redis;

  await ensureConsumerGroup(redis, "hydra:autopilot:slot-events", "now-pixel-bridge", "$");

  assert.deepEqual(calls, [
    ["CREATE", "hydra:autopilot:slot-events", "now-pixel-bridge", "$", "MKSTREAM"],
  ]);
});

test("ensureConsumerGroup: defaults startId to '0' (replay backlog)", async () => {
  const calls: string[][] = [];
  const redis = {
    async xgroup(...args: string[]) { calls.push(args); return "OK"; },
  } as unknown as Redis;

  await ensureConsumerGroup(redis, "hydra:notifications", "telegram");

  assert.equal(calls[0][3], "0");
});

test("ensureConsumerGroup: swallows BUSYGROUP (group already exists)", async () => {
  const redis = {
    async xgroup() { throw new Error("BUSYGROUP Consumer Group name already exists"); },
  } as unknown as Redis;

  // Must resolve, not reject.
  await ensureConsumerGroup(redis, "s", "g");
});

test("ensureConsumerGroup: rethrows any non-BUSYGROUP error", async () => {
  const redis = {
    async xgroup() { throw new Error("CONNREFUSED"); },
  } as unknown as Redis;

  await assert.rejects(() => ensureConsumerGroup(redis, "s", "g"), /CONNREFUSED/);
});

// --- reapStaleConsumers -----------------------------------------------------

test("reapStaleConsumers: reaps only the stale, non-self consumer", async () => {
  const del: string[][] = [];
  const redis = {
    async xinfo(sub: string) {
      assert.equal(sub, "CONSUMERS");
      return [
        consumerRow("bridge-OLD", 600_000),  // 10min — STALE
        consumerRow("bridge-LIVE", 1_000),   // 1s — live
        consumerRow("bridge-SELF", 999_999), // high but it's us
      ];
    },
    async xgroup(verb: string, stream: string, group: string, name: string) {
      assert.equal(verb, "DELCONSUMER");
      del.push([stream, group, name]);
      return 0;
    },
  } as unknown as Redis;

  const reaped = await reapStaleConsumers(
    redis, parseFields, "hydra:autopilot:slot-events", "now-pixel-bridge", "bridge-SELF",
  );

  assert.deepEqual(reaped, ["bridge-OLD"]);
  assert.deepEqual(del, [["hydra:autopilot:slot-events", "now-pixel-bridge", "bridge-OLD"]]);
});

test("reapStaleConsumers: strict > floor — a consumer exactly at idleMs is kept", async () => {
  const redis = {
    async xinfo() { return [consumerRow("bridge-AT", 300_000)]; },
    async xgroup() { throw new Error("should not be called"); },
  } as unknown as Redis;

  const reaped = await reapStaleConsumers(
    redis, parseFields, "s", "g", "self", 300_000,
  );
  assert.deepEqual(reaped, []);
});

test("reapStaleConsumers: never throws — an XINFO failure returns []", async () => {
  const redis = {
    async xinfo() { throw new Error("CONNREFUSED"); },
    async xgroup() { throw new Error("should not be called"); },
  } as unknown as Redis;

  const reaped = await reapStaleConsumers(redis, parseFields, "s", "g", "self");
  assert.deepEqual(reaped, []);
});

// --- delConsumer ------------------------------------------------------------

test("delConsumer: best-effort DELCONSUMER of a named consumer", async () => {
  const calls: string[][] = [];
  const redis = {
    async xgroup(...args: string[]) { calls.push(args); return 0; },
  } as unknown as Redis;

  await delConsumer(redis, "hydra:autopilot:slot-events", "recs-engine", "recs-123");
  assert.deepEqual(calls, [
    ["DELCONSUMER", "hydra:autopilot:slot-events", "recs-engine", "recs-123"],
  ]);
});

test("delConsumer: swallows a failure (never throws on shutdown)", async () => {
  const redis = {
    async xgroup() { throw new Error("NOGROUP"); },
  } as unknown as Redis;

  // Must resolve, not reject.
  await delConsumer(redis, "s", "g", "c");
});

// --- initConsumerGroups -----------------------------------------------------

test("initConsumerGroups: CREATEs every group on every stream from '0'", async () => {
  const calls: string[][] = [];
  const redis = {
    async xgroup(...args: string[]) { calls.push(args); return "OK"; },
  } as unknown as Redis;

  await initConsumerGroups(redis, {
    "hydra:notifications": ["telegram"],
    "hydra:dlq": ["dlq-processor"],
  });

  assert.deepEqual(calls, [
    ["CREATE", "hydra:notifications", "telegram", "0", "MKSTREAM"],
    ["CREATE", "hydra:dlq", "dlq-processor", "0", "MKSTREAM"],
  ]);
});
