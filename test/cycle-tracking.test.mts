/**
 * cycle-tracking.test.mts — Redis accessors in src/redis/cycle-tracking.ts.
 *
 * Regression coverage for issue #3997: listCycleIds() previously scanned
 * `MATCH hydra:cycle:cycle-*`, but real cycle keys are `hydra:cycle:<hex>`
 * (e.g. `hydra:cycle:aeef970d909cccd8a`), so the pattern matched nothing and
 * /cycle/history silently returned []. listCycleIds() now reads the
 * `hydra:cycle:index` ZSET (written by addCycleToIndex in the cycle-close
 * path), so it returns the recorded ids ordered newest-first by completion
 * epoch — and can never match a non-cycle sibling key.
 *
 * These cases seed the REAL <hex> key shape plus the index entry, so they
 * FAIL against the old cycle-* scan pattern (acceptance criterion 2) and PASS
 * against the index-based implementation.
 *
 * Two NEW top-level describes, each with its own before/after Redis lifecycle
 * and a per-case beforeEach wipe (CLAUDE.md authoring rules: no shared-Redis
 * teardown across siblings, fresh state per case).
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import express from "express";
import type { AddressInfo } from "node:net";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const cycleKey = (id: string) => `hydra:cycle:${id}`;

let redis: any;
let listCycleIds: () => Promise<string[]>;
let addCycleToIndex: (id: string, score: number) => Promise<void>;
let getCycleHistory: (limit?: number) => Promise<any[]>;

/** Delete every hydra:cycle:* key (hashes, sub-keys, the index, the active pointer). */
async function cleanupCycleKeys(r: any): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", "hydra:cycle:*", "COUNT", 200);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  if (keys.length > 0) await r.del(...keys);
}

describe("cycle-tracking.listCycleIds (#3997)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ listCycleIds, addCycleToIndex } = await import("../src/redis/cycle-tracking.ts"));
  });
  after(async () => {
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });
  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("returns [] when the index holds no cycles — a hash without an index entry is not enumerated", async () => {
    // The index is the sole source of truth (INV-5): a <hex> hash seeded
    // WITHOUT addCycleToIndex is invisible to listCycleIds().
    await redis.hset(cycleKey("aeef970d909cccd8a"), { status: "completed", total: "1" });
    assert.deepEqual(await listCycleIds(), []);
  });

  test("enumerates a <hex> cycle id recorded via addCycleToIndex (regression for #3997)", async () => {
    // The production key shape from the issue: hydra:cycle:<hex>. The old
    // MATCH hydra:cycle:cycle-* pattern could not match this key, so
    // listCycleIds() returned []; against the index-based read it is returned.
    const id = "aeef970d909cccd8a";
    await redis.hset(cycleKey(id), { status: "completed", total: "1", completed: "1" });
    await addCycleToIndex(id, 1000);
    assert.deepEqual(await listCycleIds(), [id]);
  });

  test("returns ids newest-first by index score, not by lexical id order", async () => {
    // Hex ids have no lexical-to-chronological correspondence; order must come
    // from the ZSET score (completion epoch), highest first.
    await addCycleToIndex("bbbb1111", 1000); // oldest
    await addCycleToIndex("cccc2222", 3000); // newest
    await addCycleToIndex("aaaa0000", 2000);
    assert.deepEqual(await listCycleIds(), ["cccc2222", "aaaa0000", "bbbb1111"]);
  });

  test("never enumerates non-cycle siblings that share the hydra:cycle: prefix", async () => {
    // Reserved siblings under the same prefix must not appear even though a
    // keyspace scan would have surfaced them. Only the indexed real cycle is
    // returned.
    await addCycleToIndex("deadbeef00110000", 5000);
    await redis.set("hydra:cycle:active", "deadbeef00110000"); // active pointer (string)
    await redis.set("hydra:cycle:active:claude", "deadbeef00110000"); // per-source reg
    await redis.hset(cycleKey("deadbeef00110000:tasks"), { t: "x" }); // sub-key
    assert.deepEqual(await listCycleIds(), ["deadbeef00110000"]);
  });
});

describe("cycle-tracking.getCycleHistory via the index (#3997)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ addCycleToIndex } = await import("../src/redis/cycle-tracking.ts"));
    ({ getCycleHistory } = await import("../src/cycle.ts"));
  });
  after(async () => {
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });
  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("getCycleHistory returns a real <hex> cycle record (acceptance criterion 1)", async () => {
    const id = "aeef970d909cccd8a";
    await redis.hset(cycleKey(id), { status: "completed", total: "4", completed: "4" });
    await addCycleToIndex(id, 1000);
    const history = await getCycleHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].id, id);
    assert.equal(history[0].status, "completed");
    assert.equal(history[0].completed, 4);
  });

  test("getCycleHistory skips an indexed id whose hash is missing (an expired record)", async () => {
    // Mirrors production: the index outlives the 7-day hash TTL, so an indexed
    // id whose hash has expired is skipped rather than surfacing a gap.
    await addCycleToIndex("expiredhash000001", 2000); // indexed but no hash
    const live = "ff00ff00ff00ff00";
    await redis.hset(cycleKey(live), { status: "merged", total: "1", completed: "1" });
    await addCycleToIndex(live, 1000);
    const history = await getCycleHistory();
    assert.deepEqual(history.map((c) => c.id), [live]);
  });
});

/**
 * QA on PR #4058 (issue #3997 follow-up) found a second, live cycle-hash
 * writer that the first fix missed: `POST /cycle/register` /
 * `POST /cycle/complete` (`src/api/cycles.ts`) never called
 * `addCycleToIndex`, so a cycle registered through that path — Step 0 of
 * every `hydra-target-build` dispatch, per `docs/operator-playbooks/
 * hydra-target-build.md` — stayed permanently invisible to `/cycle/history`.
 *
 * The fix moves indexing into the WRITE SEAM (`initCycleHash`/
 * `updateCycleHash` in `src/redis/cycle-tracking.ts`) rather than bolting an
 * `addCycleToIndex` call onto these two handlers, so this suite exercises the
 * real HTTP routes end-to-end (Express + real Redis — the repo's established
 * pattern for route-level regressions, e.g. `test/api-alerts.test.mts`) to
 * pin the actual observable behaviour, not the implementation detail of which
 * function calls ZADD.
 *
 * These cases FAIL against the PR-#4058-at-QA-time code (register never
 * indexed) and PASS against the fix.
 */
describe("cycles API — /cycle/register and /cycle/complete index the cycle (#3997 follow-up)", () => {
  let server: any;
  let baseUrl: string;

  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ listCycleIds } = await import("../src/redis/cycle-tracking.ts"));
    ({ getCycleHistory } = await import("../src/cycle.ts"));
    const { createCyclesRouter } = await import("../src/api/cycles.ts");
    const app = express();
    app.use(express.json());
    app.use(createCyclesRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });
  after(async () => {
    server.close();
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });
  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("a cycle registered via POST /cycle/register appears in listCycleIds() and /cycle/history (the QA-found gap)", async () => {
    const cycleId = "regcycle0001aaaa";
    const res = await fetch(`${baseUrl}/cycle/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId, source: "claude" }),
    });
    assert.equal(res.status, 200);

    assert.deepEqual(await listCycleIds(), [cycleId]);

    const history = await getCycleHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].id, cycleId);
    assert.equal(history[0].status, "running");
  });

  test("register then complete on the same cycleId does not produce a duplicate index entry (idempotency)", async () => {
    const cycleId = "regcycle0002bbbb";
    await fetch(`${baseUrl}/cycle/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId, source: "claude" }),
    });
    const res = await fetch(`${baseUrl}/cycle/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId, source: "claude", status: "completed" }),
    });
    assert.equal(res.status, 200);

    // Exactly one index entry, not two — ZADD upserts by member.
    assert.deepEqual(await listCycleIds(), [cycleId]);

    const history = await getCycleHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "completed");
  });

  test("a complete-without-register cycle is still indexed (mirrors the issue #2926 TTL-backstop scenario)", async () => {
    // registerCycleSource/initCycleHash never ran for this cycleId — /cycle/complete
    // is the FIRST write, going straight through updateCycleHash.
    const cycleId = "regcycle0003cccc";
    const res = await fetch(`${baseUrl}/cycle/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cycleId, source: "claude", status: "completed" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await listCycleIds(), [cycleId]);
  });
});
