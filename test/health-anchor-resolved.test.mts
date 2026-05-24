/**
 * Regression test for codebase-health anchor recycling (issue #25).
 *
 * Bug: the same codebase-health anchor was re-selected 5 times after a
 * successful merge because selectAnchor() had no memory of resolved health
 * anchors. Each re-selection produced a "Planner produced no task" abandonment.
 *
 * Fix: after merging a codebase-health anchor, record it in a resolved set
 * (Redis key with 24h TTL). selectAnchor() skips health anchors that match.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:anchors:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("codebase-health anchor resolved skip (issue #25)", () => {
  let markHealthAnchorResolved: (ref: string) => Promise<void>;
  let isHealthAnchorResolved: (ref: string) => Promise<boolean>;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      const adapter = await import("../src/redis/health-anchor.ts");
      markHealthAnchorResolved = adapter.markHealthAnchorResolved;
      isHealthAnchorResolved = adapter.isHealthAnchorResolved;
    }
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // Core behavior: mark + check
  // ---------------------------------------------------------------------------

  test("isHealthAnchorResolved returns false for unknown anchor", async () => {
    const resolved = await isHealthAnchorResolved("codebase-health: missing-docs in some/dir");
    assert.equal(resolved, false);
  });

  test("markHealthAnchorResolved makes isHealthAnchorResolved return true", async () => {
    const ref = "codebase-health: missing-docs in web/src/lib/providers/polymarket-clob";
    await markHealthAnchorResolved(ref);
    const resolved = await isHealthAnchorResolved(ref);
    assert.equal(resolved, true, "anchor should be resolved after marking");
  });

  test("resolved key has a TTL (auto-expires)", async () => {
    const ref = "codebase-health: large-file in src/api.ts";
    await markHealthAnchorResolved(ref);

    // The key should exist with a positive TTL
    const normalizedRef = ref.replace(/\s+/g, "-").slice(0, 120);
    const key = `hydra:anchors:resolved-health:${normalizedRef}`;
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 0, `expected positive TTL, got ${ttl}`);
    assert.ok(ttl <= 86400, `TTL should not exceed 24h, got ${ttl}`);
  });

  test("different anchors are independent", async () => {
    const ref1 = "codebase-health: missing-docs in dir-a";
    const ref2 = "codebase-health: missing-docs in dir-b";

    await markHealthAnchorResolved(ref1);
    assert.equal(await isHealthAnchorResolved(ref1), true);
    assert.equal(await isHealthAnchorResolved(ref2), false);
  });
});
