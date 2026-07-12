/**
 * cycle.test.mts — read-only cycle state surface (src/cycle.ts, issue #3238).
 *
 * `src/cycle.ts` is the genuinely-untested primary gap: no other test imports
 * from it. It is a thin read-only adapter over the redis/cycle-tracking.ts
 * accessors (getActiveCycleId / getCycleHash / listCycleIds) exposing:
 *   - getCycleStatus()  → the active cycle projected to a CycleRecord, or
 *                         {status:"idle"} when there is no active cycle id, or
 *                         the hash is missing / has no status.
 *   - getCycleHistory(limit=10) → the newest-first list of cycle records,
 *                         tolerating a listCycleIds failure, honouring the limit,
 *                         and parseInt-defaulting absent numeric fields to 0.
 *
 * Neither function takes an injected Redis client, so — per the #3238 design
 * concept — this drives them against the Redis test-DB, seeding the exact keys
 * the redis/cycle-tracking.ts accessors read:
 *   - active pointer: hydra:cycle:active
 *   - per-cycle hash: hydra:cycle:{id}
 * listCycleIds only enumerates ids under the `hydra:cycle:cycle-*` pattern, so
 * history fixtures use `cycle-`-prefixed ids.
 *
 * NEW top-level describe with its own before/after Redis lifecycle (CLAUDE.md
 * authoring rule); per-case reset lives in beforeEach so no case leaks state
 * into a sibling. getCycleStatus/getCycleHistory are dynamically imported after
 * REDIS_URL is pinned so they bind to the test DB.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const ACTIVE_KEY = "hydra:cycle:active";
const cycleKey = (id: string) => `hydra:cycle:${id}`;

let redis: any;
let getCycleStatus: () => Promise<any>;
let getCycleHistory: (limit?: number) => Promise<any[]>;

/** Delete the active pointer plus every hydra:cycle:* key we might have seeded. */
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

describe("cycle.getCycleStatus (#3238)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ getCycleStatus } = await import("../src/cycle.ts"));
  });

  after(async () => {
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });

  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("returns {status:'idle'} when there is no active cycle id", async () => {
    const status = await getCycleStatus();
    assert.deepEqual(status, { status: "idle" });
  });

  test("returns {status:'idle'} when the active id points at a missing hash", async () => {
    await redis.set(ACTIVE_KEY, "cycle-ghost");
    // No hydra:cycle:cycle-ghost hash exists → hgetall is empty → idle.
    const status = await getCycleStatus();
    assert.deepEqual(status, { status: "idle" });
  });

  test("returns {status:'idle'} when the active hash exists but has no status field", async () => {
    await redis.set(ACTIVE_KEY, "cycle-nostatus");
    await redis.hset(cycleKey("cycle-nostatus"), "total", "3");
    const status = await getCycleStatus();
    assert.deepEqual(status, { status: "idle" });
  });

  test("projects the active cycle hash to a CycleRecord with parsed numeric fields", async () => {
    await redis.set(ACTIVE_KEY, "cycle-active-1");
    await redis.hset(cycleKey("cycle-active-1"), {
      status: "running",
      startedAt: "2026-07-12T00:00:00Z",
      completedAt: "2026-07-12T01:00:00Z",
      total: "5",
      completed: "3",
      failed: "1",
      abandoned: "0",
      timedOut: "1",
    });

    const status = await getCycleStatus();
    assert.deepEqual(status, {
      id: "cycle-active-1",
      status: "running",
      startedAt: "2026-07-12T00:00:00Z",
      completedAt: "2026-07-12T01:00:00Z",
      total: 5,
      completed: 3,
      failed: 1,
      abandoned: 0,
      timedOut: 1,
    });
  });

  test("defaults absent numeric fields to 0 and absent timestamps to null", async () => {
    await redis.set(ACTIVE_KEY, "cycle-sparse");
    // Only status set — every numeric field must parseInt-default to 0, not NaN.
    await redis.hset(cycleKey("cycle-sparse"), "status", "completed");

    const status = await getCycleStatus();
    assert.equal(status.status, "completed");
    assert.equal(status.startedAt, null);
    assert.equal(status.completedAt, null);
    assert.equal(status.total, 0);
    assert.equal(status.completed, 0);
    assert.equal(status.failed, 0);
    assert.equal(status.abandoned, 0);
    assert.equal(status.timedOut, 0);
    // Guard against NaN leaking through parseInt of undefined.
    for (const k of ["total", "completed", "failed", "abandoned", "timedOut"]) {
      assert.ok(Number.isInteger(status[k]), `${k} must be an integer, not NaN`);
    }
  });
});

describe("cycle.getCycleHistory (#3238)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ getCycleHistory } = await import("../src/cycle.ts"));
  });

  after(async () => {
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });

  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("returns [] when there are no cycle hashes", async () => {
    const history = await getCycleHistory();
    assert.deepEqual(history, []);
  });

  test("skips a cycle hash that has no status field", async () => {
    await redis.hset(cycleKey("cycle-0001"), "total", "2"); // no status → skipped
    const history = await getCycleHistory();
    assert.deepEqual(history, []);
  });

  test("returns cycle records newest-first with parsed numeric fields", async () => {
    // listCycleIds sorts ids lexically-reverse (ISO-shaped ids ⇒ chronological
    // reverse). cycle-0003 > cycle-0002 > cycle-0001, so newest-first is 0003.
    await redis.hset(cycleKey("cycle-0001"), { status: "completed", total: "4", completed: "4" });
    await redis.hset(cycleKey("cycle-0002"), { status: "failed", total: "2", failed: "2" });
    await redis.hset(cycleKey("cycle-0003"), { status: "merged", total: "1", completed: "1" });

    const history = await getCycleHistory();
    assert.equal(history.length, 3);
    assert.deepEqual(history.map((c) => c.id), ["cycle-0003", "cycle-0002", "cycle-0001"]);
    // Numeric fields parse; absent ones default to 0.
    const byId = Object.fromEntries(history.map((c) => [c.id, c]));
    assert.equal(byId["cycle-0002"].failed, 2);
    assert.equal(byId["cycle-0002"].completed, 0);
    assert.equal(byId["cycle-0001"].completed, 4);
  });

  test("honours the limit — never returns more than `limit` records", async () => {
    for (let i = 1; i <= 5; i++) {
      const id = `cycle-${String(i).padStart(4, "0")}`;
      await redis.hset(cycleKey(id), { status: "completed", total: String(i) });
    }
    const history = await getCycleHistory(2);
    assert.equal(history.length, 2, "must break after `limit` records");
    // The two newest (lexical-reverse) ids.
    assert.deepEqual(history.map((c) => c.id), ["cycle-0005", "cycle-0004"]);
  });

  test("excludes per-cycle sub-keys (:agents/:costs/:tasks) from the id enumeration", async () => {
    await redis.hset(cycleKey("cycle-0007"), { status: "completed", total: "1" });
    // Sub-keys under the same id must not be enumerated as separate cycles.
    await redis.hset(cycleKey("cycle-0007:agents"), { some: "agent" });
    await redis.hset(cycleKey("cycle-0007:costs"), { usd: "0" });
    await redis.hset(cycleKey("cycle-0007:tasks"), { t: "x" });

    const history = await getCycleHistory();
    assert.deepEqual(history.map((c) => c.id), ["cycle-0007"]);
  });
});
