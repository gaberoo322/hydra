/**
 * Issue #2189 — `readAndSweepAutopilotRun` composed reader.
 *
 * This is the thin reader the active-dispatches aggregator now injects as
 * its default `getAutopilotRunRow`, so the aggregator can stay a PURE read
 * (no Redis writes in the aggregation layer) while still applying the
 * canonical dead-pid sweep (#888) behind the read.
 *
 * `readAndSweepAutopilotRun(id)` composes the leaf Redis accessor
 * (`getAutopilotRun`) with the read-time sweeper (`sweepRunIfDead`) using
 * their PRODUCTION defaults — both touch real Redis — so this suite stands
 * up its own `ioredis` client (its own top-level `before`/`after`
 * lifecycle, per the CLAUDE.md shared-Redis-teardown authoring rule) and
 * seeds run hashes directly to assert the two observable behaviours:
 *
 *   - a `running` row whose pid is DEAD comes back swept to `killed`/`crash`
 *     (the write side-effect happens, and the returned row reflects it);
 *   - a `running` row whose pid is ALIVE (this test's own pid) comes back
 *     unchanged (`swept:false`).
 *
 * The dead-pid policy itself is exhaustively tested at its own seam
 * (`sweepRunIfDead` in autopilot-runs-deps.test.mts with injected
 * `isPidAlive`); this suite only pins the COMPOSITION (read → sweep → return
 * swept row).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import { readAndSweepAutopilotRun } from "../src/autopilot/runs.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const RUN_KEY = (id: string) => `hydra:autopilot:run:${id}`;

describe("readAndSweepAutopilotRun — read + sweep composition (#2189)", () => {
  let redis: any;

  before(async () => {
    redis = new Redis(REDIS_URL);
  });

  after(async () => {
    if (redis) {
      const keys = await redis.keys("hydra:autopilot:run:rs-*");
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    }
  });

  test("dead-pid running row comes back swept to killed/crash", async () => {
    const id = "rs-dead";
    // 424242 is a pid that is overwhelmingly unlikely to be alive on the
    // test host — the same sentinel the aggregator suite uses for a zombie.
    await redis.hset(RUN_KEY(id), {
      run_id: id,
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      status: "running",
      pid: "424242",
    });

    const { row, swept } = await readAndSweepAutopilotRun(id);

    assert.equal(swept, true, "a dead-pid running row must be swept");
    assert.equal(row.status, "killed");
    assert.equal(row.term_reason, "crash");
    // The write side-effect landed in Redis too (this is what makes the
    // aggregator's filter drop the row without the aggregator writing).
    const persisted = await redis.hgetall(RUN_KEY(id));
    assert.equal(persisted.status, "killed");
    assert.equal(persisted.term_reason, "crash");
  });

  test("live-pid running row comes back unchanged (swept:false)", async () => {
    const id = "rs-live";
    await redis.hset(RUN_KEY(id), {
      run_id: id,
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      status: "running",
      // This test process's own pid is, by definition, alive.
      pid: String(process.pid),
    });

    const { row, swept } = await readAndSweepAutopilotRun(id);

    assert.equal(swept, false, "a live-pid running row must NOT be swept");
    assert.equal(row.status, "running");
    const persisted = await redis.hgetall(RUN_KEY(id));
    assert.equal(persisted.status, "running", "Redis row must be left untouched");
  });
});
