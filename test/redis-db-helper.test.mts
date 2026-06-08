/**
 * Tests for the Redis test-isolation backstop helper (issue #1231).
 *
 * Pins three contract points of test/_helpers/redis-db.mts:
 *   1. It refuses to run against production DB-0 (the "DB-0 is never touched"
 *      invariant) — a non-zero DB is mandatory.
 *   2. `useCleanRedisDb()` gives each test a clean `hydra:*` keyspace: a key
 *      written in one test is gone at the start of the next.
 *   3. It degrades to skip-friendly (`up === false`) when Redis is unreachable
 *      rather than hard-failing — same contract the rest of the suite relies on.
 *
 * Pin DB-1 before importing the helper so its TEST_REDIS_URL resolves to a
 * non-zero DB (matches every other Redis-touching test file).
 */

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { useCleanRedisDb, TEST_REDIS_URL } from "./_helpers/redis-db.mts";

// The strict ioredis `Redis` static type in this tsconfig omits the full
// dynamic command surface (`exists`, etc.); the suite convention is to type the
// client loosely (see test/holdback.test.mts, test/agent-stream-correlation).
type RedisClient = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("test/_helpers/redis-db — DB-0 guard", () => {
  test("TEST_REDIS_URL pins a non-zero DB (production DB-0 untouched)", () => {
    const dbSegment = TEST_REDIS_URL.split("/").pop() ?? "";
    assert.notEqual(dbSegment, "0", "tests must never run against DB-0");
    assert.notEqual(dbSegment, "", "a DB index must be present in the URL");
  });
});

describe("test/_helpers/redis-db — clean keyspace backstop", () => {
  const db = useCleanRedisDb();
  const probeKey = "hydra:test:redis-db-helper:probe";

  test("first test writes a key into the clean keyspace", async (t) => {
    if (!db.up || !db.client) {
      t.skip("Redis unavailable on REDIS_URL — skipping live-DB assertion");
      return;
    }
    // beforeEach already wiped hydra:* — the keyspace starts clean.
    assert.equal(
      await db.client.exists(probeKey),
      0,
      "probe key must be absent at the start of the test (clean keyspace)",
    );
    await db.client.set(probeKey, "leak-me");
    assert.equal(await db.client.exists(probeKey), 1);
  });

  test("second test sees a clean keyspace (prior key was wiped in beforeEach)", async (t) => {
    if (!db.up || !db.client) {
      t.skip("Redis unavailable on REDIS_URL — skipping live-DB assertion");
      return;
    }
    // The key the previous test wrote must NOT leak into this one — the
    // beforeEach hook wiped it. This is the backstop the helper guarantees.
    assert.equal(
      await db.client.exists(probeKey),
      0,
      "key written by the previous test must be wiped before this one runs",
    );
  });

  test("Redis-down degrades to a skip, never a hard failure", (t) => {
    // We can't force Redis down here, but we CAN assert the handle exposes a
    // boolean `up` flag that callers branch on — the skip-friendly contract.
    assert.equal(typeof db.up, "boolean", "handle must expose a boolean `up`");
    if (!db.up) {
      t.skip("Redis genuinely unavailable — handle correctly reports up=false");
    }
  });
});

// Sanity check that TEST_REDIS_URL stays constructable (guards against a
// regression where it drifts to an unconstructable value). lazyConnect so we
// don't open a live socket the test would have to tear down.
describe("test/_helpers/redis-db — URL is constructable", () => {
  test("a client can be constructed from TEST_REDIS_URL", () => {
    const client: RedisClient = new (Redis as any)(TEST_REDIS_URL, {
      lazyConnect: true,
    });
    try {
      assert.ok(client, "ioredis client constructs from TEST_REDIS_URL");
    } finally {
      client.disconnect();
    }
  });
});
