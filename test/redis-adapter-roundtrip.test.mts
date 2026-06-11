/**
 * Redis adapter round-trip integration tests.
 *
 * Regression: modules used raw `new Redis()` connections to access Redis.
 * Issue #30 migrated all access through redis-adapter.ts.
 * These tests verify write → read round-trips work correctly through the adapter.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const adapter = {
  ...(await import("../src/redis/kv.ts")),
  ...(await import("../src/redis/utility.ts")),
};

let testRedis: any;

describe("redis-adapter write → read round-trip", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis(process.env.REDIS_URL);
    }
    // Clean test keys
    const keys = await testRedis.keys("hydra:test:*");
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    const keys = await testRedis.keys("hydra:test:*");
    if (keys.length > 0) await testRedis.del(...keys);
    if (testRedis) testRedis.disconnect();
  });

  // ---------------------------------------------------------------------------
  // String operations
  // ---------------------------------------------------------------------------

  test("getString / setString round-trip", async () => {
    await adapter.setString("hydra:test:str1", "hello-world");
    const val = await adapter.getString("hydra:test:str1");
    assert.equal(val, "hello-world");
    await adapter.delKey("hydra:test:str1");
  });

  test("setString with TTL stores and expires", async () => {
    await adapter.setString("hydra:test:str-ttl", "temp", 60);
    const val = await adapter.getString("hydra:test:str-ttl");
    assert.equal(val, "temp");
    const ttl = await testRedis.ttl("hydra:test:str-ttl");
    assert.ok(ttl > 0 && ttl <= 60, `TTL should be 1-60, got ${ttl}`);
    await adapter.delKey("hydra:test:str-ttl");
  });

  test("setNX only sets when key does not exist", async () => {
    const first = await adapter.setNX("hydra:test:nx", "first", 60);
    assert.equal(first, true);
    const second = await adapter.setNX("hydra:test:nx", "second", 60);
    assert.equal(second, false);
    const val = await adapter.getString("hydra:test:nx");
    assert.equal(val, "first");
    await adapter.delKey("hydra:test:nx");
  });

  // ---------------------------------------------------------------------------
  // Hash operations
  // ---------------------------------------------------------------------------

  test("hashSet / hashGetAll round-trip", async () => {
    await adapter.hashSet("hydra:test:hash1", "field1", "val1", "field2", "val2");
    const all = await adapter.hashGetAll("hydra:test:hash1");
    assert.equal(all.field1, "val1");
    assert.equal(all.field2, "val2");
    await adapter.delKey("hydra:test:hash1");
  });

  test("hashSetField / hashGet round-trip", async () => {
    await adapter.hashSetField("hydra:test:hash2", "myfield", "myval");
    const val = await adapter.hashGet("hydra:test:hash2", "myfield");
    assert.equal(val, "myval");
    await adapter.delKey("hydra:test:hash2");
  });

  test("hashIncrBy increments correctly", async () => {
    await adapter.hashSet("hydra:test:hash-incr", "count", "5");
    const result = await adapter.hashIncrBy("hydra:test:hash-incr", "count", 3);
    assert.equal(result, 8);
    await adapter.delKey("hydra:test:hash-incr");
  });

  // ---------------------------------------------------------------------------
  // List operations
  // ---------------------------------------------------------------------------

  test("listRPush / listRange round-trip", async () => {
    await adapter.listRPush("hydra:test:list1", "a", "b", "c");
    const items = await adapter.listRange("hydra:test:list1", 0, -1);
    assert.deepEqual(items, ["a", "b", "c"]);
    const len = await adapter.listLen("hydra:test:list1");
    assert.equal(len, 3);
    await adapter.delKey("hydra:test:list1");
  });

  test("listLPop removes from left", async () => {
    await adapter.listRPush("hydra:test:list2", "x", "y");
    const popped = await adapter.listLPop("hydra:test:list2");
    assert.equal(popped, "x");
    const remaining = await adapter.listRange("hydra:test:list2", 0, -1);
    assert.deepEqual(remaining, ["y"]);
    await adapter.delKey("hydra:test:list2");
  });

  // ---------------------------------------------------------------------------
  // Sorted set operations
  // ---------------------------------------------------------------------------

  test("zAdd / zRange round-trip", async () => {
    await adapter.zAdd("hydra:test:zset1", 100, "member-a");
    await adapter.zAdd("hydra:test:zset1", 200, "member-b");
    const members = await adapter.zRange("hydra:test:zset1", 0, -1);
    assert.deepEqual(members, ["member-a", "member-b"]);
    const card = await adapter.zCard("hydra:test:zset1");
    assert.equal(card, 2);
    await adapter.delKey("hydra:test:zset1");
  });

  test("zRevRange returns newest first", async () => {
    await adapter.zAdd("hydra:test:zset2", 1, "old");
    await adapter.zAdd("hydra:test:zset2", 2, "new");
    const rev = await adapter.zRevRange("hydra:test:zset2", 0, -1);
    assert.deepEqual(rev, ["new", "old"]);
    await adapter.delKey("hydra:test:zset2");
  });

  // ---------------------------------------------------------------------------
  // Set operations
  // ---------------------------------------------------------------------------

  test("setAdd / setMembers round-trip", async () => {
    await adapter.setAdd("hydra:test:set1", "alpha", "beta");
    const members = await adapter.setMembers("hydra:test:set1");
    assert.ok(members.includes("alpha"));
    assert.ok(members.includes("beta"));
    assert.equal(members.length, 2);
    await adapter.delKey("hydra:test:set1");
  });

  test("setRem removes members", async () => {
    await adapter.setAdd("hydra:test:set2", "a", "b", "c");
    await adapter.setRem("hydra:test:set2", "b");
    const members = await adapter.setMembers("hydra:test:set2");
    assert.ok(!members.includes("b"));
    assert.equal(members.length, 2);
    await adapter.delKey("hydra:test:set2");
  });

  // ---------------------------------------------------------------------------
  // Pipeline operations
  // ---------------------------------------------------------------------------

  test("createPipeline batches commands", async () => {
    const pipe = adapter.createPipeline();
    pipe.set("hydra:test:pipe1", "val1");
    pipe.set("hydra:test:pipe2", "val2");
    await pipe.exec();

    const v1 = await adapter.getString("hydra:test:pipe1");
    const v2 = await adapter.getString("hydra:test:pipe2");
    assert.equal(v1, "val1");
    assert.equal(v2, "val2");
    await adapter.delKey("hydra:test:pipe1", "hydra:test:pipe2");
  });

  // ---------------------------------------------------------------------------
  // Key utility operations
  // ---------------------------------------------------------------------------

  test("keyExists returns correct boolean", async () => {
    const before = await adapter.keyExists("hydra:test:exists");
    assert.equal(before, false);
    await adapter.setString("hydra:test:exists", "yes");
    const after = await adapter.keyExists("hydra:test:exists");
    assert.equal(after, true);
    await adapter.delKey("hydra:test:exists");
  });

  test("findKeys returns matching keys", async () => {
    await adapter.setString("hydra:test:find-a", "1");
    await adapter.setString("hydra:test:find-b", "2");
    const keys = await adapter.findKeys("hydra:test:find-*");
    assert.ok(keys.length >= 2);
    assert.ok(keys.includes("hydra:test:find-a"));
    assert.ok(keys.includes("hydra:test:find-b"));
    await adapter.delKey("hydra:test:find-a", "hydra:test:find-b");
  });

  test("scanKeys returns matching keys via cursor iteration", async () => {
    await adapter.setString("hydra:test:scan-x", "1");
    await adapter.setString("hydra:test:scan-y", "2");
    const keys = await adapter.scanKeys("hydra:test:scan-*");
    assert.ok(keys.length >= 2);
    assert.ok(keys.includes("hydra:test:scan-x"));
    assert.ok(keys.includes("hydra:test:scan-y"));
    await adapter.delKey("hydra:test:scan-x", "hydra:test:scan-y");
  });
});
