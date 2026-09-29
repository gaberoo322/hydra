/**
 * Issue #4700 (QA round 2) — slot-events pr_lifecycle reader + merged_count
 * digest guards.
 *
 *  - listPrLifecycleEventsSince: the XRANGE lower bound is epoch SECONDS *
 *    1000. A seconds-vs-ms bug (passing seconds as the id) would return
 *    every event; the boundary cases below would then fail.
 *  - projectRunDigest: an unstamped run whose window is older than the
 *    stream's ~1-day retention reports an explicit
 *    `merged_count_source: "unavailable-outside-retention"` (and does NOT
 *    touch the stream); a stamped value is never clobbered.
 *  - listRuns reads the stream ONCE for a page of unstamped runs (no N+1).
 *
 * Own top-level describes with own Redis lifecycle (never nested under a
 * sibling's teardown).
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { getRedisConnection, closeRedisConnections } = await import("../src/redis/connection.ts");
const { listPrLifecycleEventsSince, SLOT_EVENTS_STREAM } = await import("../src/redis/autopilot-runs.ts");
const { projectRunDigest, defaultProjectionDeps } = await import("../src/autopilot/run-projections.ts");
const { listRuns } = await import("../src/autopilot/run-reads.ts");

const T = 1_800_000_000; // epoch seconds (fixture)

async function addEvent(idMs: string, pr: string): Promise<void> {
  await getRedisConnection().xadd(
    SLOT_EVENTS_STREAM,
    idMs,
    "event", "pr_lifecycle",
    "repo", "gaberoo322/hydra",
    "pr_number", pr,
    "transition", "merged",
    "merged_at", String(T),
    "ts_epoch", String(T),
  );
}

describe("listPrLifecycleEventsSince lower bound is seconds*1000 (issue #4700)", () => {
  before(async () => {
    await getRedisConnection().del(SLOT_EVENTS_STREAM);
  });
  beforeEach(async () => {
    await getRedisConnection().del(SLOT_EVENTS_STREAM);
  });
  after(async () => {
    await getRedisConnection().del(SLOT_EVENTS_STREAM);
  });

  test("includes events at/after fromEpochS*1000, excludes earlier ones, skips non-pr_lifecycle", async () => {
    await addEvent(`${T * 1000 - 1}-0`, "1"); // 1ms before the bound
    await addEvent(`${T * 1000}-0`, "2"); // exactly at the bound
    await addEvent(`${T * 1000 + 5000}-0`, "3");
    await getRedisConnection().xadd(SLOT_EVENTS_STREAM, `${T * 1000 + 6000}-0`, "event", "subagent_tool_call");

    const got = await listPrLifecycleEventsSince(T);
    assert.deepEqual(got.map((e) => e.pr_number), ["2", "3"]);
  });

  test("a seconds-as-ms bound would return everything; the real bound returns none for a future epoch", async () => {
    await addEvent(`${T * 1000}-0`, "9");
    // Bug shape: id `${T}` (seconds used as ms) would include the event above
    // even when asking for a LATER second. The correct scaling excludes it.
    const got = await listPrLifecycleEventsSince(T + 10);
    assert.deepEqual(got, []);
  });

  test("cap bounds the payload, oldest first", async () => {
    await addEvent(`${T * 1000}-0`, "1");
    await addEvent(`${T * 1000 + 1}-0`, "2");
    const got = await listPrLifecycleEventsSince(T, 1);
    assert.deepEqual(got.map((e) => e.pr_number), ["1"]);
  });
});

describe("merged_count digest: retention marker + single stream read (issue #4700)", () => {
  after(async () => {
    await closeRedisConnections();
  });

  test("unstamped run ended >1d ago: marker set, stream not read, value 0", async () => {
    let reads = 0;
    const deps = {
      ...defaultProjectionDeps,
      listTurnsDesc: async () => [],
      listPrLifecycleEvents: async () => {
        reads += 1;
        return [];
      },
    };
    const old = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const d = await projectRunDigest(
      "r-old",
      { run_id: "r-old", started: "x", started_epoch: String(old), ended_epoch: String(old + 60), status: "completed" },
      deps,
    );
    assert.equal(d.merged_count, 0);
    assert.equal(d.merged_count_source, "unavailable-outside-retention");
    assert.equal(reads, 0);
  });

  test("stamped value is never clobbered, even for an old run", async () => {
    const old = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const d = await projectRunDigest(
      "r-stamped",
      { run_id: "r-stamped", started: "x", started_epoch: String(old), ended_epoch: String(old + 60), status: "completed", merged_count: "4" },
      { ...defaultProjectionDeps, listTurnsDesc: async () => [], listPrLifecycleEvents: async () => [] },
    );
    assert.equal(d.merged_count, 4);
    assert.equal(d.merged_count_source, "stamped");
  });

  test("listRuns issues ONE xrange for a page of unstamped recent runs", async () => {
    const r = getRedisConnection();
    await r.del(SLOT_EVENTS_STREAM);
    const now = Math.floor(Date.now() / 1000);
    const ids = ["nplus1-a", "nplus1-b", "nplus1-c"];
    for (let i = 0; i < ids.length; i++) {
      const start = now - 3600 - i * 600;
      await r.hset(`hydra:autopilot:run:${ids[i]}`, {
        run_id: ids[i],
        started: new Date(start * 1000).toISOString(),
        started_epoch: String(start),
        ended_epoch: String(start + 300),
        status: "completed",
        trigger: "manual",
      });
      await r.zadd("hydra:autopilot:runs:index", start, ids[i]);
    }
    const orig = r.xrange.bind(r);
    let calls = 0;
    (r as any).xrange = (...args: any[]) => {
      if (args[0] === SLOT_EVENTS_STREAM) calls += 1;
      return (orig as any)(...args);
    };
    try {
      const res = await listRuns(50);
      assert.equal(res.ok, true);
      assert.equal(calls, 1, "one shared stream read, not one per unstamped run");
    } finally {
      (r as any).xrange = orig;
      for (const id of ids) {
        await r.del(`hydra:autopilot:run:${id}`);
        await r.zrem("hydra:autopilot:runs:index", id);
      }
    }
  });
});
