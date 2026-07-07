/**
 * Redis adapter unit tests — operator-safety + health-snapshot accessors
 * (issue #2972, scoped slice).
 *
 * Issue #2972 flags the `src/redis/*` seam as under-tested: 27 adapter modules
 * carry all orchestrator state but most are only exercised indirectly through
 * backlog/lifecycle integration tests, never at the module level in isolation.
 * A coverage audit (import-reference sweep over `test/`) found a subset with
 * ZERO direct test coverage. This file takes a coherent slice of that gap — the
 * four operator-safety / health-observability accessors whose correctness is a
 * genuine risk if a future mutation silently changes round-trip or fail-safe
 * behaviour:
 *
 *   - src/redis/emergency-brake.ts — operator-only auto-merge kill switch
 *     (JSON blob; MUST fail SAFE to disengaged on a corrupt/absent blob so a
 *     bad write can never wedge auto-merge off).
 *   - src/redis/review.ts         — edge-trigger armed flag for the
 *     /hydra-review pickup notify hook (present "1" vs absent).
 *   - src/redis/alerts.ts         — capped alert list (LPUSH newest-first +
 *     LTRIM cap; LSET overwrite; DEL clear).
 *   - src/redis/reconciler.ts     — merge→done reconciler health snapshot
 *     (JSON blob + TTL; null on absent/unparseable).
 *
 * Each module gets its own top-level `describe` with a `beforeEach` per-case
 * cleanup (fresh keyspace per case, per CLAUDE.md's per-case-isolation rule),
 * and a single file-level `after()` closes the shared connection so the runner
 * emits its `# pass N` footer (PR #518 lesson).
 *
 * DB selection defers to REDIS_URL (set per-run by scripts/test/redis-db-launch.mjs)
 * with a DB-1 fallback for a standalone single-file run — never DB 0 (prod).
 * Redis-down: every case skips cleanly rather than failing, matching the
 * launcher's "tests skip when Redis is down" contract.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { redisKeys } = await import("../src/redis/keys.ts");
const {
  getEmergencyBrake,
  setEmergencyBrake,
  clearEmergencyBrake,
} = await import("../src/redis/emergency-brake.ts");
const {
  getReviewPickupNotified,
  setReviewPickupNotified,
  clearReviewPickupNotified,
} = await import("../src/redis/review.ts");
const {
  pushAlert,
  readRecentAlerts,
  readAllAlerts,
  setAlertAt,
  clearAlerts,
} = await import("../src/redis/alerts.ts");
const {
  setReconcilerHealth,
  getReconcilerHealth,
} = await import("../src/redis/reconciler.ts");

// ---------------------------------------------------------------------------
// Shared test Redis client + reachability gate.
// ---------------------------------------------------------------------------

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) {
    // lazyConnect + no auto-retry so an unreachable Redis fails fast in the
    // reachability probe below instead of hanging the suite.
    testRedis = new Redis(process.env.REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    // Swallow post-probe connection errors: once we've decided Redis is down we
    // skip every case, and a late 'error' with no listener would crash the run.
    testRedis.on("error", () => {});
  }
  return testRedis;
}

/** True once we've confirmed Redis answers PING; false if it's unreachable. */
let redisUp: boolean | null = null;
async function redisReachable(): Promise<boolean> {
  if (redisUp !== null) return redisUp;
  try {
    const r = getTestRedis();
    await r.connect();
    await r.ping();
    redisUp = true;
  } catch (err) {
    console.error(
      `[redis-operator-safety-accessors] Redis unreachable, skipping round-trip cases: ${
        (err as any)?.message ?? err
      }`,
    );
    redisUp = false;
  }
  return redisUp;
}

after(async () => {
  if (testRedis && testRedis.status !== "end") {
    testRedis.disconnect();
    testRedis = null;
  }
  try {
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  } catch (err) {
    console.error(
      "redis-operator-safety-accessors teardown: closeRedisConnections failed",
      err,
    );
  }
});

// ===========================================================================
// emergency-brake.ts — operator-only auto-merge kill switch (#744)
// ===========================================================================

describe("redis/emergency-brake", () => {
  beforeEach(async () => {
    if (!(await redisReachable())) return;
    await getTestRedis().del(redisKeys.emergencyBrake());
  });

  test("absent flag reads as disengaged (default-off)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    const state = await getEmergencyBrake();
    assert.equal(state.engaged, false);
    assert.equal(state.since, undefined);
    assert.equal(state.engagedBy, undefined);
  });

  test("set then get round-trips engaged=true with attribution + since", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    const before = Date.now();
    const returned = await setEmergencyBrake("operator-cli");
    const after = Date.now();

    // setEmergencyBrake returns the state it wrote.
    assert.equal(returned.engaged, true);
    assert.equal(returned.engagedBy, "operator-cli");
    assert.ok(returned.since! >= before && returned.since! <= after);

    // And a fresh read reflects the same blob.
    const state = await getEmergencyBrake();
    assert.equal(state.engaged, true);
    assert.equal(state.engagedBy, "operator-cli");
    assert.equal(state.since, returned.since);
  });

  test("clear removes the flag (idempotent) → back to disengaged", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await setEmergencyBrake("op");
    await clearEmergencyBrake();
    assert.equal((await getEmergencyBrake()).engaged, false);
    // Idempotent: a second clear on an already-absent flag is a safe no-op.
    await clearEmergencyBrake();
    assert.equal((await getEmergencyBrake()).engaged, false);
  });

  test("re-engaging refreshes since/engagedBy (idempotent overwrite)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    const first = await setEmergencyBrake("op-a");
    // A tiny delay so the second `since` is strictly newer (Date.now() ms tick).
    await new Promise((res) => setTimeout(res, 2));
    const second = await setEmergencyBrake("op-b");
    assert.equal(second.engagedBy, "op-b");
    assert.ok(second.since! >= first.since!);
    const state = await getEmergencyBrake();
    assert.equal(state.engagedBy, "op-b");
  });

  test("corrupt blob fails SAFE to disengaged (a bad write can't wedge merge off)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    // Write a non-JSON payload directly under the key.
    await getTestRedis().set(redisKeys.emergencyBrake(), "{not valid json");
    const state = await getEmergencyBrake();
    assert.equal(state.engaged, false);
  });

  test("blob with engaged:false is treated as disengaged", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await getTestRedis().set(
      redisKeys.emergencyBrake(),
      JSON.stringify({ engaged: false, since: 123 }),
    );
    const state = await getEmergencyBrake();
    assert.equal(state.engaged, false);
  });

  test("non-string engagedBy / non-number since are dropped, not propagated", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await getTestRedis().set(
      redisKeys.emergencyBrake(),
      JSON.stringify({ engaged: true, since: "not-a-number", engagedBy: 42 }),
    );
    const state = await getEmergencyBrake();
    assert.equal(state.engaged, true);
    // Malformed field types are coerced to undefined rather than trusted.
    assert.equal(state.since, undefined);
    assert.equal(state.engagedBy, undefined);
  });
});

// ===========================================================================
// review.ts — edge-trigger armed flag for the pickup notify hook (#745)
// ===========================================================================

describe("redis/review pickup-notify flag", () => {
  beforeEach(async () => {
    if (!(await redisReachable())) return;
    await getTestRedis().del(redisKeys.reviewPickupArmed());
  });

  test("absent flag reads as not-notified (re-armed)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    assert.equal(await getReviewPickupNotified(), false);
  });

  test("set marks notified; clear re-arms", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await setReviewPickupNotified();
    assert.equal(await getReviewPickupNotified(), true);
    // Stored as the literal "1" flag.
    assert.equal(await getTestRedis().get(redisKeys.reviewPickupArmed()), "1");

    await clearReviewPickupNotified();
    assert.equal(await getReviewPickupNotified(), false);
  });

  test("set is idempotent (stays armed-spent across repeats)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await setReviewPickupNotified();
    await setReviewPickupNotified();
    assert.equal(await getReviewPickupNotified(), true);
  });

  test("any non-\"1\" stored value reads as not-notified", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    // The read contract is a strict === "1"; a stray value must not read true.
    await getTestRedis().set(redisKeys.reviewPickupArmed(), "true");
    assert.equal(await getReviewPickupNotified(), false);
  });
});

// ===========================================================================
// alerts.ts — capped alert list (#269 / ADR-0009 slice 5)
// ===========================================================================

describe("redis/alerts capped list", () => {
  beforeEach(async () => {
    if (!(await redisReachable())) return;
    await getTestRedis().del(redisKeys.alerts());
  });

  test("push is newest-first (LPUSH); readRecentAlerts respects limit", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await pushAlert("a1", 10);
    await pushAlert("a2", 10);
    await pushAlert("a3", 10);
    // LPUSH => index 0 is the most recent push.
    assert.deepEqual(await readRecentAlerts(2), ["a3", "a2"]);
    assert.deepEqual(await readAllAlerts(), ["a3", "a2", "a1"]);
  });

  test("push caps the list to maxLen (LTRIM), dropping the oldest", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    for (let i = 1; i <= 5; i++) await pushAlert(`a${i}`, 3);
    const all = await readAllAlerts();
    // Only the 3 newest survive; the two oldest (a1, a2) are trimmed away.
    assert.equal(all.length, 3);
    assert.deepEqual(all, ["a5", "a4", "a3"]);
  });

  test("readRecentAlerts with limit <= 0 short-circuits to [] without a Redis read", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await pushAlert("a1", 10);
    assert.deepEqual(await readRecentAlerts(0), []);
    assert.deepEqual(await readRecentAlerts(-3), []);
  });

  test("setAlertAt overwrites a position in place", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await pushAlert("a1", 10);
    await pushAlert("a2", 10); // list is now ["a2", "a1"]
    await setAlertAt(0, "a2-dismissed");
    assert.deepEqual(await readAllAlerts(), ["a2-dismissed", "a1"]);
  });

  test("clearAlerts empties the list", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await pushAlert("a1", 10);
    await clearAlerts();
    assert.deepEqual(await readAllAlerts(), []);
  });
});

// ===========================================================================
// reconciler.ts — merge→done reconciler health snapshot (#2057)
// ===========================================================================

describe("redis/reconciler health snapshot", () => {
  beforeEach(async () => {
    if (!(await redisReachable())) return;
    await getTestRedis().del(redisKeys.reconcilerHealth());
  });

  const sampleRecord = () => ({
    ranAt: "2026-07-07T00:00:00.000Z",
    feed: {
      prs: { examined: 12 },
      commits: { examined: 3, failed: "feed down" },
    },
    metrics: {
      referencesFound: 4,
      movesFailed: 0,
      itemsReconciled: 4,
      itemsEscalated: 1,
      scanned: 20,
      durationMs: 812,
    },
    alert: { code: "both-feeds-down", message: "prs + commits both failed" },
  });

  test("absent record reads as null", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    assert.equal(await getReconcilerHealth(), null);
  });

  test("set then get round-trips the full nested record", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    const rec = sampleRecord();
    await setReconcilerHealth(rec as any);
    const got = await getReconcilerHealth();
    assert.deepEqual(got, rec);
  });

  test("set applies a positive TTL (record ages out; never permanently fresh)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await setReconcilerHealth(sampleRecord() as any);
    const ttl = await getTestRedis().ttl(redisKeys.reconcilerHealth());
    // 2-day TTL: strictly positive and within the documented ceiling.
    assert.ok(ttl > 0, `expected positive TTL, got ${ttl}`);
    assert.ok(ttl <= 2 * 24 * 60 * 60, `TTL ${ttl} exceeds the 2-day ceiling`);
  });

  test("unparseable stored value reads as null (fail-safe)", async (t) => {
    if (!(await redisReachable())) return t.skip("Redis unreachable");
    await getTestRedis().set(redisKeys.reconcilerHealth(), "{corrupt");
    assert.equal(await getReconcilerHealth(), null);
  });
});
