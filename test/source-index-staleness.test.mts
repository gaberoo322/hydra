/**
 * source-index-staleness.test.mts — lifecycle staleness detector (issue #2267).
 *
 * Drives detectAndClearStaleSourceIndex() against real Redis (test DB) with an
 * injected OV probe so the decision table is deterministic:
 *   - cold/empty cache            -> no-op (never probes, never clears)
 *   - populated cache + OV present -> no-op (the healthy-restart invariant)
 *   - populated cache + OV absent  -> clears the cache (the OV-reset repair)
 *
 * Uses a dedicated top-level describe with its own Redis lifecycle (per the
 * CLAUDE.md authoring rule) and beforeEach cleanup so per-case state never
 * leaks into a sibling case.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const SOURCE_HASHES_KEY = "hydra:knowledge:source-hashes";

let redis: any;
let detectAndClearStaleSourceIndex: (probe?: () => Promise<boolean>) => Promise<void>;
let countSourceHashes: () => Promise<number>;

describe("detectAndClearStaleSourceIndex (issue #2267)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ detectAndClearStaleSourceIndex } = await import("../src/learning-lifecycle.ts"));
    ({ countSourceHashes } = await import("../src/redis/source-index.ts"));
  });

  after(async () => {
    await redis.del(SOURCE_HASHES_KEY);
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.del(SOURCE_HASHES_KEY);
  });

  test("cold/empty cache: no-op, probe is never consulted", async () => {
    let probed = false;
    await detectAndClearStaleSourceIndex(async () => {
      probed = true;
      return false;
    });
    assert.equal(probed, false, "must short-circuit before probing on an empty cache");
    assert.equal(await countSourceHashes(), 0);
  });

  test("populated cache + OV present: cache preserved (healthy-restart invariant)", async () => {
    await redis.hset(SOURCE_HASHES_KEY, "/a.ts", "h1", "/b.ts", "h2");
    await detectAndClearStaleSourceIndex(async () => true);
    assert.equal(await countSourceHashes(), 2, "a healthy OV must NOT trigger a re-index clear");
  });

  test("populated cache + OV absent: cache cleared (OV-reset repair)", async () => {
    await redis.hset(SOURCE_HASHES_KEY, "/a.ts", "h1", "/b.ts", "h2", "/c.ts", "h3");
    assert.equal(await countSourceHashes(), 3);
    await detectAndClearStaleSourceIndex(async () => false);
    assert.equal(await countSourceHashes(), 0, "an OV with no indexed source resources must clear the stale cache");
  });

  test("populated cache + probe throws: cache preserved (best-effort, no clear)", async () => {
    await redis.hset(SOURCE_HASHES_KEY, "/a.ts", "h1");
    await detectAndClearStaleSourceIndex(async () => {
      throw new Error("probe boom");
    });
    assert.equal(await countSourceHashes(), 1, "a throwing probe must degrade to a no-op, never wipe the cache");
  });
});

describe("countSourceHashes / clearSourceHashes accessors (issue #2267)", () => {
  let countFn: () => Promise<number>;
  let clearFn: () => Promise<boolean>;
  let r: any;

  before(async () => {
    r = new Redis(REDIS_URL);
    const mod = await import("../src/redis/source-index.ts");
    countFn = mod.countSourceHashes;
    clearFn = mod.clearSourceHashes;
  });

  after(async () => {
    await r.del(SOURCE_HASHES_KEY);
    r.disconnect();
  });

  beforeEach(async () => {
    await r.del(SOURCE_HASHES_KEY);
  });

  test("countSourceHashes returns 0 on an empty cache and the hlen otherwise", async () => {
    assert.equal(await countFn(), 0);
    await r.hset(SOURCE_HASHES_KEY, "/a.ts", "h1", "/b.ts", "h2");
    assert.equal(await countFn(), 2);
  });

  test("clearSourceHashes deletes the whole map and reports success", async () => {
    await r.hset(SOURCE_HASHES_KEY, "/a.ts", "h1");
    assert.equal(await clearFn(), true);
    assert.equal(await countFn(), 0);
  });
});
