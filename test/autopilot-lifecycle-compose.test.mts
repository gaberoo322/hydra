/**
 * Issue #2549 — composed sweep→derive readers `readLifecycleState` and
 * `sweepLoadedRow`.
 *
 * Before #2549 every high-level run reader replicated the two-step contract
 * `sweepRunIfDead(runId, row)` THEN derive/project, enforced only by
 * convention at four call sites. `readLifecycleState` names the
 * sweep→`deriveLifecycleState` sequence; `sweepLoadedRow` names the
 * sweep→swept-row half its `projectRunView`/`projectRunDigest` siblings need.
 * This suite pins the COMPOSITION (the sweep fires before the derivation, so a
 * dead-pid `running` row never derives a stale `running` lifecycle) against
 * the production defaults — both helpers touch real Redis via
 * `sweepRunIfDead` — so it stands up its own `ioredis` client with its own
 * top-level `before`/`after` lifecycle (per the CLAUDE.md
 * shared-Redis-teardown authoring rule).
 *
 * The dead-pid sweep policy itself is exhaustively covered at its own seam
 * (`sweepRunIfDead` in autopilot-runs-deps.test.mts with injected
 * `isPidAlive`); this suite only asserts that the new readers compose it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import { readLifecycleState, sweepLoadedRow } from "../src/autopilot/sweep-reader.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const RUN_KEY = (id: string) => `hydra:autopilot:run:${id}`;

describe("readLifecycleState / sweepLoadedRow — sweep→derive composition (#2549)", () => {
  let redis: any;

  before(async () => {
    redis = new Redis(REDIS_URL);
  });

  after(async () => {
    if (redis) {
      const keys = await redis.keys("hydra:autopilot:run:lc-*");
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    }
  });

  test("readLifecycleState sweeps a dead-pid running row before deriving — never reports stale running", async () => {
    const id = "lc-dead";
    // 424242 is a pid overwhelmingly unlikely to be alive on the test host.
    await redis.hset(RUN_KEY(id), {
      run_id: id,
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      status: "running",
      pid: "424242",
    });
    const row = await redis.hgetall(RUN_KEY(id));

    const lifecycle = await readLifecycleState(id, row);

    // The sweep ran FIRST, so the derived lifecycle is crashed (not running)
    // and the dead-pid promotion persisted to Redis.
    assert.equal(lifecycle.state, "crashed");
    assert.equal(lifecycle.run_id, id);
    const persisted = await redis.hgetall(RUN_KEY(id));
    assert.equal(persisted.status, "killed");
    assert.equal(persisted.term_reason, "crash");
  });

  test("readLifecycleState leaves a live-pid running row reported as running", async () => {
    const id = "lc-live";
    await redis.hset(RUN_KEY(id), {
      run_id: id,
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      status: "running",
      pid: String(process.pid), // this process is, by definition, alive
    });
    const row = await redis.hgetall(RUN_KEY(id));

    const lifecycle = await readLifecycleState(id, row);

    assert.equal(lifecycle.state, "running");
    assert.equal(lifecycle.run_id, id);
    const persisted = await redis.hgetall(RUN_KEY(id));
    assert.equal(persisted.status, "running", "live-pid row must be left untouched");
  });

  test("sweepLoadedRow returns the swept row for a dead-pid running row", async () => {
    const id = "lc-swept";
    await redis.hset(RUN_KEY(id), {
      run_id: id,
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      status: "running",
      pid: "424242",
    });
    const row = await redis.hgetall(RUN_KEY(id));

    const swept = await sweepLoadedRow(id, row);

    assert.equal(swept.status, "killed");
    assert.equal(swept.term_reason, "crash");
  });

  test("sweepLoadedRow is idempotent — a terminal row is returned unchanged, not re-swept", async () => {
    const id = "lc-terminal";
    await redis.hset(RUN_KEY(id), {
      run_id: id,
      started: "2026-05-26T11:00:00Z",
      started_epoch: "1779836400",
      status: "ended",
      term_reason: "budget",
      ended_epoch: "1779840000",
    });
    const row = await redis.hgetall(RUN_KEY(id));

    const swept = await sweepLoadedRow(id, row);

    assert.equal(swept.status, "ended", "a terminal row must not be re-swept");
    assert.equal(swept.term_reason, "budget");
  });
});
