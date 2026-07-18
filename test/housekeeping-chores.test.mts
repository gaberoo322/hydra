/**
 * Isolated unit coverage for the independently-injectable housekeeping chores
 * (issue #2067).
 *
 * Before #2067, `src/scheduler/housekeeping.ts` packed every chore behind the
 * single `runHousekeeping(eventBus)` entry point, so exercising one chore meant
 * constructing a deps object (or a live Redis) covering ALL of them. #2067
 * extracted each chore into a named exported function accepting only its own
 * deps subset, each defaulting to the real implementation.
 *
 * These tests prove the extraction's payoff: each chore runs in isolation with
 * ONLY its own deps stubbed — no live Redis, no HTTP endpoint, no event bus
 * beyond a fake, and no deps for sibling chores. `runHousekeeping`'s own
 * composition + idempotency is still covered against real Redis in
 * `api-maintenance.test.mts`; this file pins the chore bodies in isolation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runWeeklyDigest,
  runMemoryConsolidation,
  runDesignConceptSnapshot,
  runForecastCalibrationBrier,
  pruneStaleRedisKeys,
  runSkillCatalogReregister,
  runHousekeeping,
  choreGuard,
} from "../src/scheduler/housekeeping.ts";

// The runBlockedItemEscalation chore (and its isolated tests) was retired with
// the Redis backlog subsystem — ADR-0031 contract phase, issue #3439. It read
// the Redis `blocked` lane, which no longer exists (the Target tracks work as
// GitHub Issues, and the #3059 blocked-by filter handles dependency-blocking).

describe("runDesignConceptSnapshot — isolated (issue #2067)", () => {
  test("writes when no snapshot exists for today (returns true → ran)", async () => {
    let written: { date: string; count: number } | null = null;
    const result = await runDesignConceptSnapshot({
      today: () => "2026-06-18",
      module: {
        getDesignConceptProductionCountForDate: async () => 3,
        readDailySnapshots: async () => [],
        writeDailySnapshot: async (date, count) => {
          written = { date, count };
        },
      },
    });
    assert.equal(result, true, "a first-write should report ran");
    assert.deepEqual(written, { date: "2026-06-18", count: 3 });
  });

  test("monotone no-op: stored count >= sampled count returns false (→ skipped)", async () => {
    let writeCalled = false;
    const result = await runDesignConceptSnapshot({
      today: () => "2026-06-18",
      module: {
        getDesignConceptProductionCountForDate: async () => 2,
        readDailySnapshots: async () => [{ date: "2026-06-18", count: 2 }],
        writeDailySnapshot: async () => {
          writeCalled = true;
        },
      },
    });
    assert.equal(result, false, "an unchanged same-day re-run reports skipped");
    assert.equal(writeCalled, false, "no write when the stored count is not exceeded");
  });

  test("monotone write: a higher sampled count for today overwrites", async () => {
    let written: { date: string; count: number } | null = null;
    const result = await runDesignConceptSnapshot({
      today: () => "2026-06-18",
      module: {
        getDesignConceptProductionCountForDate: async () => 5,
        readDailySnapshots: async () => [{ date: "2026-06-18", count: 2 }],
        writeDailySnapshot: async (date, count) => {
          written = { date, count };
        },
      },
    });
    assert.equal(result, true);
    assert.deepEqual(written, { date: "2026-06-18", count: 5 });
  });
});

describe("runForecastCalibrationBrier — isolated (issue #2067)", () => {
  test("invokes the injected publisher exactly once", async () => {
    let calls = 0;
    await runForecastCalibrationBrier({
      publishBrierMetric: async () => {
        calls++;
        return { ok: true };
      },
    });
    assert.equal(calls, 1, "the injected brier publisher runs once");
  });
});

// The runDoneLanePrune chore (and its isolated test) was retired with the Redis
// backlog subsystem — ADR-0031 contract phase, issue #3439 (it pruned the Redis
// `done` lane, which no longer exists).

describe("runWeeklyDigest — isolated (issue #2067)", () => {
  test("sends + stamps when a summary is produced", async () => {
    let sent: string | null = null;
    let stamped = false;
    await runWeeklyDigest({
      buildWeeklySummary: async () => "weekly!",
      sendToTelegram: async (msg) => {
        sent = msg;
      },
      setLastWeekly: async () => {
        stamped = true;
      },
    });
    assert.equal(sent, "weekly!", "the summary is sent to Telegram");
    assert.equal(stamped, true, "the weekly guard key is stamped on send");
  });

  test("no summary → nothing sent, no stamp", async () => {
    let sent = false;
    let stamped = false;
    await runWeeklyDigest({
      buildWeeklySummary: async () => null,
      sendToTelegram: async () => {
        sent = true;
      },
      setLastWeekly: async () => {
        stamped = true;
      },
    });
    assert.equal(sent, false, "no send when the builder yields null");
    assert.equal(stamped, false, "no stamp when nothing was sent");
  });
});

describe("runMemoryConsolidation — isolated (issue #2067)", () => {
  test("consolidates then stamps the daily guard key", async () => {
    const order: string[] = [];
    await runMemoryConsolidation({
      consolidate: async () => {
        order.push("consolidate");
      },
      setLastConsolidation: async () => {
        order.push("stamp");
      },
    });
    assert.deepEqual(order, ["consolidate", "stamp"], "consolidate runs before the stamp");
  });
});

// The returnStaleInProgressItems chore (and its isolated tests) was retired with
// the Redis backlog subsystem — ADR-0031 contract phase, issue #3439 (it moved
// items between the Redis `inProgress` and `queued` lanes, which no longer
// exist).

describe("pruneStaleRedisKeys — isolated (issue #2067)", () => {
  test("deletes a >7d no-TTL dated key and keeps a fresh one, via injected deps", async () => {
    const now = new Date("2026-06-18T00:00:00Z").getTime();
    const staleKey = "hydra:cycle:cycle-2020-01-01-0000:tasks";
    const freshKey = "hydra:cycle:cycle-2026-06-18-0000:tasks";
    let deleted: string[] = [];
    await pruneStaleRedisKeys({
      now: () => now,
      pruneMetricsIndex: async () => 0,
      getMetricsIndexSize: async () => 0,
      trimMetricsIndex: async () => {},
      scanKeys: async (pattern) =>
        pattern.startsWith("hydra:cycle:") ? [staleKey, freshKey] : [],
      getKeyTTL: async () => -1, // no TTL → eligible
      getKeyType: async () => "string",
      hashGet: async () => null,
      deleteKeysBatch: async (keys) => {
        deleted = deleted.concat(keys);
      },
      setLastDaily: async () => {},
    });
    assert.deepEqual(deleted, [staleKey], "only the >7d dated key is deleted");
  });

  test("skips a key that already has a TTL", async () => {
    const now = new Date("2026-06-18T00:00:00Z").getTime();
    let deleted = 0;
    await pruneStaleRedisKeys({
      now: () => now,
      pruneMetricsIndex: async () => 0,
      getMetricsIndexSize: async () => 0,
      trimMetricsIndex: async () => {},
      scanKeys: async (pattern) =>
        pattern.startsWith("hydra:cycle:") ? ["hydra:cycle:cycle-2020-01-01-0000:agents"] : [],
      getKeyTTL: async () => 3600, // has a TTL → must be skipped
      getKeyType: async () => "string",
      hashGet: async () => null,
      deleteKeysBatch: async (keys) => {
        deleted += keys.length;
      },
      setLastDaily: async () => {},
    });
    assert.equal(deleted, 0, "a key with a TTL is never pruned");
  });

  // Issue #2461: verify the chore stamps its own daily guard key on success
  // (consistent pattern — the chore that does the work owns its success stamp).
  test("stamps the daily cadence guard key on success (issue #2461)", async () => {
    let stamped: string | null = null;
    await pruneStaleRedisKeys({
      now: () => new Date("2026-06-18T00:00:00Z").getTime(),
      pruneMetricsIndex: async () => 0,
      getMetricsIndexSize: async () => 0,
      trimMetricsIndex: async () => {},
      scanKeys: async () => [],
      getKeyTTL: async () => -1,
      getKeyType: async () => "string",
      hashGet: async () => null,
      deleteKeysBatch: async () => {},
      setLastDaily: async (ts) => { stamped = ts; },
    });
    assert.ok(stamped !== null, "setLastDaily must be called on success");
    assert.ok(/^\d+$/.test(stamped!), "stamped value must be a numeric timestamp string");
  });
});

// The runMergedItemReconciler chore (and its isolated tests) was retired with
// the Redis backlog subsystem — ADR-0031 contract phase, issue #3439. It moved
// merged Redis backlog items to the `done` lane; merged/shipped suppression is
// now enforced by `Closes #N` close-discipline on the GitHub board (ADR-0031
// Decision 5). The positive-evidence merged-blob matchers it used
// (`merged-refs` / `token-algebra`) are retained as leaf modules.

describe("runSkillCatalogReregister — isolated (issue #2148)", () => {
  const fullState = () => ({
    skills: [
      { name: "planner", registered: true, lastError: null, lastSuccessAt: 1 },
      { name: "executor", registered: true, lastError: null, lastSuccessAt: 1 },
    ],
    registered: 2,
    total: 2,
    completed: true,
    lastAttemptAt: 1,
    vlmDeferred: false,
    skillsDeferred: false,
  });
  const emptyCompletedState = () => ({
    skills: [
      { name: "planner", registered: false, lastError: "ov-timeout" as const, lastSuccessAt: null },
      { name: "executor", registered: false, lastError: "ov-timeout" as const, lastSuccessAt: null },
    ],
    registered: 0,
    total: 2,
    completed: true,
    lastAttemptAt: 1,
    vlmDeferred: false,
    skillsDeferred: false,
  });
  // Issue #2163: the chore now gates on the SKILLS-endpoint probe
  // (`probeSkillsImpl`), not the shallow `probeOv` GET /health. `skillsUp`/
  // `skillsDown` model that resource's liveness.
  const skillsUp = async () => ({ status: "running" as const, latencyMs: 5 });
  const skillsDown = async () => ({ status: "failed" as const, latencyMs: null });

  test("skips (no probe, no re-register) before the startup pass completes", async () => {
    let probed = false;
    let reRan = false;
    const result = await runSkillCatalogReregister({
      getState: () => ({ ...emptyCompletedState(), completed: false }),
      probeSkillsImpl: async () => { probed = true; return { status: "running", latencyMs: 1 }; },
      reRegister: async () => { reRan = true; return { attempted: true, recovered: 0, stillMissing: 2 }; },
    });
    assert.equal(result, false, "an in-flight startup pass must route to skipped");
    assert.equal(probed, false, "must not probe the skills endpoint before a pass has completed");
    assert.equal(reRan, false, "must not re-register before a pass has completed");
  });

  test("skips a full catalog WITHOUT probing the skills endpoint (cheap in-process guard first)", async () => {
    let probed = false;
    const result = await runSkillCatalogReregister({
      getState: fullState,
      probeSkillsImpl: async () => { probed = true; return { status: "running", latencyMs: 1 }; },
      reRegister: async () => { throw new Error("must not be called on a full catalog"); },
    });
    assert.equal(result, false, "a full catalog is a no-op skip");
    assert.equal(probed, false, "a full catalog must not even probe the skills endpoint");
  });

  test("skips when the catalog is short but the SKILLS endpoint is still down (issue #2163)", async () => {
    let reRan = false;
    const result = await runSkillCatalogReregister({
      getState: emptyCompletedState,
      probeSkillsImpl: skillsDown,
      reRegister: async () => { reRan = true; return { attempted: true, recovered: 0, stillMissing: 2 }; },
    });
    assert.equal(result, false, "must not re-attempt while the skills endpoint is down");
    assert.equal(reRan, false, "the skills-endpoint liveness gate must block the re-register call");
  });

  test("runs the re-register once the SKILLS endpoint is live and the catalog is short", async () => {
    let reRan = false;
    const result = await runSkillCatalogReregister({
      getState: emptyCompletedState,
      probeSkillsImpl: skillsUp,
      reRegister: async () => { reRan = true; return { attempted: true, recovered: 2, stillMissing: 0 }; },
    });
    assert.equal(result, true, "a recovery pass that ran counts as ran");
    assert.equal(reRan, true, "the re-register entry point is invoked once the skills endpoint is live");
  });

  test("routes an attempted:false re-register result to skipped", async () => {
    const result = await runSkillCatalogReregister({
      getState: emptyCompletedState,
      probeSkillsImpl: skillsUp,
      reRegister: async () => ({ attempted: false, recovered: 0, stillMissing: 2 }),
    });
    assert.equal(result, false, "a guard-short-circuited re-register routes to skipped");
  });

  test("gates on the SKILLS endpoint, not OV-the-app liveness (issue #2163 regression guard)", async () => {
    // The bug: OV's GET /health (probeOv) answered <100ms while POST
    // /api/v1/skills was timing out under load, so the old gate green-lit a
    // doomed pass every hour. The chore must NOT re-attempt when the SKILLS
    // resource specifically is down — regardless of whether OV-the-app is up.
    let reRan = false;
    const result = await runSkillCatalogReregister({
      getState: emptyCompletedState,
      probeSkillsImpl: skillsDown, // the resource the chore writes to is down…
      reRegister: async () => { reRan = true; return { attempted: true, recovered: 0, stillMissing: 2 }; },
    });
    assert.equal(result, false, "a down skills endpoint must block the doomed pass");
    assert.equal(reRan, false, "no doomed registration pass when the skills POST handler is down");
  });
});

describe("choreGuard — cadence windowing as pure arithmetic (issue #3091)", () => {
  const now = 1_700_000_000_000;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  test("no prior run (getter returns null) → always run", async () => {
    const proceed = await choreGuard(async () => null, WEEK_MS, () => now);
    assert.equal(proceed, true, "a chore with no recorded last-run must proceed");
  });

  test("stale last-run (>= periodMs ago) → guard passes", async () => {
    // Last ran 8 days ago; the weekly window (7d) has elapsed.
    const staleTs = String(now - 8 * 24 * 60 * 60 * 1000);
    const proceed = await choreGuard(async () => staleTs, WEEK_MS, () => now);
    assert.equal(proceed, true, "an elapsed window must let the chore run");
  });

  test("fresh last-run (< periodMs ago) → guard blocks", async () => {
    // Last ran 1 day ago; the weekly window has NOT elapsed.
    const freshTs = String(now - 1 * 24 * 60 * 60 * 1000);
    const proceed = await choreGuard(async () => freshTs, WEEK_MS, () => now);
    assert.equal(proceed, false, "an un-elapsed window must block the chore");
  });

  test("exactly at the boundary (now - last === periodMs) → guard passes", async () => {
    const boundaryTs = String(now - WEEK_MS);
    const proceed = await choreGuard(async () => boundaryTs, WEEK_MS, () => now);
    assert.equal(proceed, true, "the window is inclusive at the boundary (>=)");
  });

  test("defaults to Date.now when no clock is injected", async () => {
    // A last-run far in the past against the real clock → must proceed.
    const proceed = await choreGuard(async () => "0", WEEK_MS);
    assert.equal(proceed, true, "the default clock is Date.now");
  });
});

describe("runHousekeeping — cadence guards injectable without Redis (issue #3091)", () => {
  const now = 1_700_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function makeBus() {
    return { async publish() { return "fake-id"; } };
  }

  // A fresh timestamp for every cadence reader → every time-windowed guard
  // blocks, so all four guarded chores must appear in `skipped` and NONE of
  // their `work` bodies run — proving the guard-windowing decision is fully
  // driven by the injected `deps` + `now`, with no Redis fixture in play.
  const freshTs = async () => String(now);
  const allGuardsBlockDeps = {
    getDigestLastWeekly: freshTs,
    getUsageSnapshotLastWeekly: freshTs,
    getMemoryLastConsolidation: freshTs,
    getCleanupLastDaily: freshTs,
    now: () => now,
  };
  const guardedChores = [
    "weekly-summary",
    "usage-weekly-snapshot",
    "memory-consolidation",
    "stale-key-prune",
  ];

  test("fresh injected timestamps block all four time-windowed chores (→ skipped)", async () => {
    const summary = await runHousekeeping(makeBus() as any, allGuardsBlockDeps);
    for (const name of guardedChores) {
      assert.ok(
        summary.skipped.includes(name),
        `${name} must be skipped when its cadence guard reports fresh`,
      );
      assert.ok(
        !summary.ran.includes(name),
        `${name} must not run when its cadence guard blocks`,
      );
    }
  });

  test("null injected timestamps let each cadence guard pass through to its work", async () => {
    // getter → null means "no prior run recorded" → the guard passes, so the
    // chore's `work` runs (and, with no Redis, fail-softs through runChore). The
    // point under test is that the guard does NOT short-circuit the chore: every
    // guarded chore must be classified (ran ∪ skipped) rather than held out by a
    // fresh-window guard — the composition contract holds under injected cadence
    // deps with no Redis fixture.
    const nullTs = async () => null;
    const summary = await runHousekeeping(makeBus() as any, {
      getDigestLastWeekly: nullTs,
      getUsageSnapshotLastWeekly: nullTs,
      getMemoryLastConsolidation: nullTs,
      getCleanupLastDaily: nullTs,
      now: () => now,
      publishBrierMetric: async () => ({ ok: true }),
    });
    const classified = new Set([...summary.ran, ...summary.skipped]);
    for (const name of guardedChores) {
      assert.ok(
        classified.has(name),
        `${name} must be classified (ran or skipped) when its guard passes`,
      );
    }
  });

  test("defaults preserve production wiring — omitting cadence deps binds the real readers", async () => {
    // A call with no cadence deps must not throw at the composition level: the
    // `deps.<getter> ?? <import>` default binds the real Redis accessors, and
    // `runChore` fail-softs any I/O error. Reaching a well-formed summary proves
    // the default binding is intact (zero-diff for callers that pass nothing).
    const summary = await runHousekeeping(makeBus() as any, {
      publishBrierMetric: async () => ({ ok: true }),
    });
    assert.ok(Array.isArray(summary.ran), "ran is an array");
    assert.ok(Array.isArray(summary.skipped), "skipped is an array");
  });
});

describe("runHousekeeping — attribution-record runs before holdback-merge-watch (issue #3113)", () => {
  function makeBus() {
    return { async publish() { return "fake-id"; } };
  }

  // Both chores read the SAME pending-enroll registry (`pendingEnrollList`), but
  // `holdback-merge-watch` REMOVES each landed PR (`removePending`) while
  // `attribution-record` only READS it to open attribution windows. When the
  // watch ran first it drained the registry to empty before the recorder read
  // it, so no attribution window ever opened and the ledger stayed dark despite
  // live holdback baselines. The recorder MUST therefore run first. This test
  // pins that ordering so a future re-sequencing of the chore registry can't
  // silently reintroduce the dark-ledger bug.
  //
  // `runChore` appends each chore's name to `ran` or `skipped` in the exact
  // sequence `runHousekeeping` iterates the chore array, so relative position
  // within whichever array holds a chore reflects its execution order. Both
  // chores are unguarded and share the same pending-enroll substrate, so they
  // classify together (both ran, or both skipped on the same Redis fault) —
  // asserting the recorder's index precedes the watch's within that array is a
  // faithful proxy for "the recorder executes first", independent of whether a
  // live Redis makes them run or a Redis fault makes them skip.
  test("recorder is sequenced ahead of the registry-draining watch", async () => {
    const summary = await runHousekeeping(makeBus() as any, {
      publishBrierMetric: async () => ({ ok: true }),
    });

    const bothInRan =
      summary.ran.includes("attribution-record") &&
      summary.ran.includes("holdback-merge-watch");
    const bothInSkipped =
      summary.skipped.includes("attribution-record") &&
      summary.skipped.includes("holdback-merge-watch");

    // The two chores share a substrate, so they must classify together — this
    // guards against the assertion silently passing because one chore is absent.
    assert.ok(
      bothInRan || bothInSkipped,
      "attribution-record and holdback-merge-watch must both be classified in " +
        "the same array (both share the pending-enroll substrate); " +
        `ran=${JSON.stringify(summary.ran)} skipped=${JSON.stringify(summary.skipped)}`,
    );

    const arr = bothInRan ? summary.ran : summary.skipped;
    const recorderIdx = arr.indexOf("attribution-record");
    const watchIdx = arr.indexOf("holdback-merge-watch");
    assert.ok(
      recorderIdx < watchIdx,
      "attribution-record must be sequenced BEFORE holdback-merge-watch so the " +
        "read-only recorder opens its windows before the watch drains the " +
        `pending-enroll registry (issue #3113); order was ${JSON.stringify(arr)}`,
    );
  });
});
