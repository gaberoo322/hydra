/**
 * Issue #2926 — `updateCycleHash` TTL-preservation backstop.
 *
 * The 270-key "stale cycle keys" symptom traced to a real leak vector, not a
 * missing sweep: cycle hashes already carry a 7-day TTL (set by `initCycleHash`
 * on `/cycle/register`) and the daily stale-key sweep already backstops
 * date-named no-TTL keys. The gap was `/cycle/complete` → `updateCycleHash`,
 * which did a bare `HSET`. A bare `HSET` neither sets nor resets a key's TTL,
 * so a `complete`-without-`register` (or a post-expiry re-touch) recreated a
 * hash with **no expiry** — a permanent, dateless orphan the date-fallback
 * sweep can never age out.
 *
 * `updateCycleHash` now re-applies the standard cycle TTL only when the key has
 * none. These cases drive that logic through the injectable Redis client — no
 * live Redis, no clock — asserting all three TTL states.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  updateCycleHash,
  CYCLE_HASH_TTL_SECONDS,
} from "../src/redis/cycle-tracking.ts";

/** Minimal fake Redis client recording hset/ttl/expire interactions. */
function makeFakeRedis(ttlValue: number) {
  const calls = {
    hset: [] as any[][],
    ttl: [] as string[],
    expire: [] as Array<[string, number]>,
  };
  const client = {
    async hset(key: string, ...args: any[]) {
      calls.hset.push([key, ...args]);
      return args.length / 2;
    },
    async ttl(key: string) {
      calls.ttl.push(key);
      return ttlValue;
    },
    async expire(key: string, seconds: number) {
      calls.expire.push([key, seconds]);
      return 1;
    },
  };
  return { client, calls };
}

describe("updateCycleHash TTL backstop (issue #2926)", () => {
  test("re-applies the 7-day cycle TTL when the hash has no expiry (ttl === -1)", async () => {
    const { client, calls } = makeFakeRedis(-1);

    await updateCycleHash(
      "orphan-cycle",
      { status: "completed", completedAt: "2026-07-06T00:00:00Z" },
      client,
    );

    // The write happened against the prefixed cycle key.
    assert.equal(calls.hset.length, 1);
    assert.equal(calls.hset[0][0], "hydra:cycle:orphan-cycle");

    // TTL was checked, found missing, and the standard window re-applied.
    assert.deepEqual(calls.ttl, ["hydra:cycle:orphan-cycle"]);
    assert.equal(calls.expire.length, 1);
    assert.deepEqual(calls.expire[0], [
      "hydra:cycle:orphan-cycle",
      CYCLE_HASH_TTL_SECONDS,
    ]);
    assert.equal(CYCLE_HASH_TTL_SECONDS, 604800);
  });

  test("leaves a live TTL untouched (ttl >= 0) — routine updates never extend the window", async () => {
    const { client, calls } = makeFakeRedis(400000);

    await updateCycleHash(
      "live-cycle",
      { status: "running" },
      client,
    );

    assert.equal(calls.hset.length, 1);
    assert.deepEqual(calls.ttl, ["hydra:cycle:live-cycle"]);
    // A live TTL must NOT be reset — no expire call.
    assert.equal(calls.expire.length, 0);
  });

  test("treats ttl === 0 as a live (about-to-expire) window and does not touch it", async () => {
    // Redis reports 0 for a key expiring within the current second; that is a
    // live TTL, not the "no expiry" sentinel (-1). Only -1 triggers re-apply.
    const { client, calls } = makeFakeRedis(0);

    await updateCycleHash("edge-cycle", { status: "completed" }, client);

    assert.equal(calls.expire.length, 0);
  });

  test("writes the flattened field pairs to the hash in order", async () => {
    const { client, calls } = makeFakeRedis(-1);

    await updateCycleHash(
      "pairs-cycle",
      { status: "completed", completedAt: "2026-07-06T12:00:00Z" },
      client,
    );

    assert.deepEqual(calls.hset[0], [
      "hydra:cycle:pairs-cycle",
      "status",
      "completed",
      "completedAt",
      "2026-07-06T12:00:00Z",
    ]);
  });
});
