/**
 * Redis dispatches accessor — round-trip tests (issue #618).
 *
 * Verifies `src/redis/dispatches.ts` against a real Redis on DB 1 — the
 * same convention as `redis-adapter-roundtrip.test.mts` (issue #30).
 * Production code uses DB 0; tests never touch it.
 *
 * The tests cover:
 *   - register → list → end round-trip
 *   - index ordering (newest first)
 *   - partial-row tolerance on read (hash expired but index entry lingering)
 *   - epochFromIsoOrNow pure helper
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const {
  registerOperatorDispatch,
  listActiveOperatorDispatches,
  setOperatorDispatchStep,
  endOperatorDispatch,
  epochFromIsoOrNow,
  operatorDispatchKey,
  operatorDispatchIndexKey,
} = await import("../src/redis/dispatches.ts");

let testRedis: any;

async function cleanDispatchKeys() {
  if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
  const keys = await testRedis.keys("hydra:dispatches:operator:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

describe("epochFromIsoOrNow — pure helper", () => {
  test("parses a valid ISO string into seconds since epoch", () => {
    const epoch = epochFromIsoOrNow("2026-05-26T12:00:00.000Z");
    // 2026-05-26T12:00:00Z is 1779796800.
    assert.equal(epoch, 1779796800);
  });

  test("returns ~now on an undefined input", () => {
    const before = Math.floor(Date.now() / 1000);
    const got = epochFromIsoOrNow(undefined);
    const after = Math.floor(Date.now() / 1000);
    assert.ok(got >= before, `expected ${got} >= ${before}`);
    assert.ok(got <= after, `expected ${got} <= ${after}`);
  });

  test("returns ~now on an unparseable input", () => {
    const before = Math.floor(Date.now() / 1000);
    const got = epochFromIsoOrNow("not-a-date");
    const after = Math.floor(Date.now() / 1000);
    assert.ok(got >= before && got <= after);
  });
});

describe("operatorDispatchKey + operatorDispatchIndexKey", () => {
  test("uses the hydra:dispatches:operator namespace", () => {
    assert.equal(operatorDispatchKey("abc"), "hydra:dispatches:operator:abc");
    assert.equal(operatorDispatchIndexKey(), "hydra:dispatches:operator:index");
  });
});

describe("registerOperatorDispatch + listActiveOperatorDispatches round-trip", () => {
  beforeEach(async () => {
    await cleanDispatchKeys();
  });

  after(async () => {
    await cleanDispatchKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("persists every field, returns matching shape on read", async () => {
    await registerOperatorDispatch({
      id: "test-disp-1",
      classLabel: "hydra-grill",
      startedAt: "2026-05-26T10:00:00.000Z",
      currentStep: "asking question 3",
      issueRef: "#618",
    });

    const list = await listActiveOperatorDispatches();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "test-disp-1");
    assert.equal(list[0].classLabel, "hydra-grill");
    assert.equal(list[0].startedAt, "2026-05-26T10:00:00.000Z");
    assert.equal(list[0].currentStep, "asking question 3");
    assert.equal(list[0].issueRef, "#618");
    assert.equal(list[0].prRef, undefined);
  });

  test("listActiveOperatorDispatches returns newest-first", async () => {
    await registerOperatorDispatch({
      id: "test-disp-old",
      classLabel: "hydra-review",
      startedAt: "2026-05-26T01:00:00.000Z",
    });
    await registerOperatorDispatch({
      id: "test-disp-new",
      classLabel: "hydra-grill",
      startedAt: "2026-05-26T10:00:00.000Z",
    });

    const list = await listActiveOperatorDispatches();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "test-disp-new");
    assert.equal(list[1].id, "test-disp-old");
  });

  test("setOperatorDispatchStep patches currentStep without disturbing other fields", async () => {
    await registerOperatorDispatch({
      id: "test-disp-step",
      classLabel: "hydra-dev",
      startedAt: "2026-05-26T10:00:00.000Z",
      currentStep: "initial",
    });
    await setOperatorDispatchStep("test-disp-step", "patched");
    const list = await listActiveOperatorDispatches();
    assert.equal(list.length, 1);
    assert.equal(list[0].currentStep, "patched");
    assert.equal(list[0].classLabel, "hydra-dev");
  });

  test("endOperatorDispatch removes both hash and index entry", async () => {
    await registerOperatorDispatch({
      id: "test-disp-end",
      classLabel: "hydra-review",
      startedAt: "2026-05-26T10:00:00.000Z",
    });
    let list = await listActiveOperatorDispatches();
    assert.equal(list.length, 1);

    await endOperatorDispatch("test-disp-end");
    list = await listActiveOperatorDispatches();
    assert.equal(list.length, 0);

    // The hash and the index entry are both gone.
    const hashExists = await testRedis.exists(operatorDispatchKey("test-disp-end"));
    assert.equal(hashExists, 0);
    const zscore = await testRedis.zscore(operatorDispatchIndexKey(), "test-disp-end");
    assert.equal(zscore, null);
  });

  test("listActiveOperatorDispatches skips index entries whose hash expired", async () => {
    // Manually insert an orphan index entry pointing at a hash that doesn't
    // exist. This simulates the partial-expiry case the JSDoc covers.
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    await testRedis.zadd(operatorDispatchIndexKey(), 1779796800, "orphan-dispatch");

    // Also register a real one so we can confirm the orphan is filtered, not
    // the entire list.
    await registerOperatorDispatch({
      id: "real-dispatch",
      classLabel: "hydra-grill",
      startedAt: "2026-05-26T11:00:00.000Z",
    });

    const list = await listActiveOperatorDispatches();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "real-dispatch");
  });

  test("endOperatorDispatch is idempotent on an unknown id", async () => {
    await endOperatorDispatch("never-existed");
    const list = await listActiveOperatorDispatches();
    assert.deepEqual(list, []);
  });
});
