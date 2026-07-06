/**
 * Regression coverage for the legacy bare `hydra:metrics` list-key removal
 * branch added to `pruneStaleRedisKeys` (issue #2927).
 *
 * The bare `hydra:metrics` key is a fossil of an earlier metrics implementation
 * (no active writer/reader). It has no trailing colon, so the chore's
 * `hydra:metrics:*` age-scan never matches it and it accumulates with no TTL,
 * tripping false-positive discover alerts. The new branch removes it — but ONLY
 * when it is genuinely the legacy `list` type, so the live metrics plane
 * (`hydra:metrics:index` zset + `hydra:metrics:<cycleId>` hashes) is never
 * touched.
 *
 * These tests exercise the branch purely through the already-injected
 * `getKeyType` / `deleteKeysBatch` seams — no real Redis. Top-level suite with
 * no shared teardown (per CLAUDE.md authoring rule: never nest under a
 * sibling's Redis `after()` teardown).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pruneStaleRedisKeys } from "../src/scheduler/chores/stale-key-prune.ts";

const LEGACY_METRICS_LIST_KEY = "hydra:metrics";

/**
 * Baseline injected deps that make every OTHER branch of the chore a no-op, so
 * a test can isolate the legacy-key branch by overriding only `getKeyType` /
 * `deleteKeysBatch`. `scanKeys` returns [] for all prefixes so the age-scan
 * never selects anything.
 */
function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    now: () => new Date("2026-07-06T00:00:00Z").getTime(),
    pruneMetricsIndex: async () => 0,
    getMetricsIndexSize: async () => 0,
    trimMetricsIndex: async () => {},
    scanKeys: async () => [],
    getKeyTTL: async () => -1,
    getKeyType: async () => "none",
    hashGet: async () => null,
    deleteKeysBatch: async () => {},
    setLastDaily: async () => {},
    ...overrides,
  };
}

describe("pruneStaleRedisKeys — legacy bare metrics list removal (issue #2927)", () => {
  test("deletes the bare hydra:metrics key when it is a legacy list", async () => {
    const typeQueried: string[] = [];
    let deleted: string[] = [];
    await pruneStaleRedisKeys(
      baseDeps({
        getKeyType: async (key: string) => {
          typeQueried.push(key);
          return key === LEGACY_METRICS_LIST_KEY ? "list" : "none";
        },
        deleteKeysBatch: async (keys: string[]) => {
          deleted = deleted.concat(keys);
        },
      }) as any,
    );
    assert.ok(
      typeQueried.includes(LEGACY_METRICS_LIST_KEY),
      "the chore must probe the bare hydra:metrics key type",
    );
    assert.deepEqual(
      deleted,
      [LEGACY_METRICS_LIST_KEY],
      "only the legacy list key is deleted",
    );
  });

  test("is a no-op when the fossil is already absent (getKeyType none → idempotent)", async () => {
    let deleteCalls = 0;
    await pruneStaleRedisKeys(
      baseDeps({
        getKeyType: async () => "none",
        deleteKeysBatch: async () => {
          deleteCalls += 1;
        },
      }) as any,
    );
    assert.equal(deleteCalls, 0, "an already-absent fossil triggers no delete");
  });

  test("NEVER deletes the live hydra:metrics:index zset (guarded on list type)", async () => {
    let deleted: string[] = [];
    await pruneStaleRedisKeys(
      baseDeps({
        // Simulate the live plane: the bare key resolves to a zset, not a list.
        // (In production this never happens — the fossil is a list — but the
        // guard must reject any non-list type so the live index/hashes are safe.)
        getKeyType: async () => "zset",
        deleteKeysBatch: async (keys: string[]) => {
          deleted = deleted.concat(keys);
        },
      }) as any,
    );
    assert.deepEqual(deleted, [], "a non-list bare key is never deleted");
  });

  test("NEVER deletes the bare key when it is a hash (live cycle metrics shape)", async () => {
    let deleted: string[] = [];
    await pruneStaleRedisKeys(
      baseDeps({
        getKeyType: async () => "hash",
        deleteKeysBatch: async (keys: string[]) => {
          deleted = deleted.concat(keys);
        },
      }) as any,
    );
    assert.deepEqual(deleted, [], "a hash-typed bare key is never deleted");
  });

  test("still stamps the daily-guard key on success (invariant 4)", async () => {
    let stamped: string | null = null;
    await pruneStaleRedisKeys(
      baseDeps({
        getKeyType: async (key: string) =>
          key === LEGACY_METRICS_LIST_KEY ? "list" : "none",
        setLastDaily: async (ts: string) => {
          stamped = ts;
        },
      }) as any,
    );
    assert.ok(stamped !== null, "setLastDaily must be called on success");
    assert.ok(/^\d+$/.test(stamped!), "the stamped value is a numeric timestamp string");
  });

  test("a getKeyType failure on the legacy branch does not throw (fail-soft)", async () => {
    // The branch is wrapped in try/catch — a Redis error probing the fossil key
    // must never abort the chore or block the daily stamp.
    let stamped = false;
    await pruneStaleRedisKeys(
      baseDeps({
        getKeyType: async () => {
          throw new Error("redis down");
        },
        setLastDaily: async () => {
          stamped = true;
        },
      }) as any,
    );
    assert.equal(stamped, true, "the daily stamp still runs after a fail-soft legacy-branch error");
  });
});
