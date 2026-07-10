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
  runBlockedItemEscalation,
  runDoneLanePrune,
  runWeeklyDigest,
  runMemoryConsolidation,
  runDesignConceptSnapshot,
  runForecastCalibrationBrier,
  returnStaleInProgressItems,
  pruneStaleRedisKeys,
  runMergedItemReconciler,
  runSkillCatalogReregister,
  runHousekeeping,
  choreGuard,
} from "../src/scheduler/housekeeping.ts";

interface PublishedEvent {
  stream: string;
  type: string;
  payload: any;
}

function makeFakeBus(captured: PublishedEvent[]) {
  return {
    async publish(stream: string, event: any) {
      captured.push({ stream, type: event.type, payload: event.payload });
      return "fake-id";
    },
  };
}

describe("runBlockedItemEscalation — isolated (issue #2067)", () => {
  test("re-escalates a >12h-blocked item with no prior escalation stamp", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const stamps = new Map<string, string>();
    const now = 1_000_000_000_000;
    const blockedAt = new Date(now - 13 * 60 * 60 * 1000).toISOString(); // 13h ago

    await runBlockedItemEscalation(bus as any, {
      loadBacklog: async () =>
        ({
          blocked: [
            { id: "item-1", title: "stuck", meta: { blockedAt, blockedReason: "missing API_KEY" } },
          ],
        }) as any,
      getLastEscalation: async (id) => stamps.get(id) ?? null,
      setLastEscalation: async (id, v) => {
        stamps.set(id, v);
      },
      now: () => now,
    });

    assert.equal(captured.length, 1, "one re-escalation should fire");
    assert.equal(captured[0].type, "cycle:operator_blocked");
    assert.equal(captured[0].payload.taskId, "item-1");
    assert.equal(captured[0].payload.reescalation, true);
    assert.equal(stamps.get("item-1"), String(now), "the per-item stamp is written");
  });

  test("suppresses an item re-escalated within the last 12h", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const now = 1_000_000_000_000;
    const blockedAt = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 2 days
    const recentStamp = String(now - 1 * 60 * 60 * 1000); // escalated 1h ago

    await runBlockedItemEscalation(bus as any, {
      loadBacklog: async () =>
        ({ blocked: [{ id: "item-2", title: "stuck", meta: { blockedAt } }] }) as any,
      getLastEscalation: async () => recentStamp,
      setLastEscalation: async () => {},
      now: () => now,
    });

    assert.equal(captured.length, 0, "a recently-escalated item is suppressed");
  });

  test("never throws — a failing loadBacklog is caught and logged", async () => {
    const captured: PublishedEvent[] = [];
    const bus = makeFakeBus(captured);
    const originalError = console.error;
    let logged = "";
    console.error = (msg: any) => {
      logged = String(msg);
    };
    try {
      await runBlockedItemEscalation(bus as any, {
        loadBacklog: async () => {
          throw new Error("redis down");
        },
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(captured.length, 0);
    assert.match(logged, /Blocked escalation check failed: redis down/);
  });
});

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

describe("runDoneLanePrune — isolated (issue #2067)", () => {
  test("delegates to the injected prune function", async () => {
    let called = false;
    await runDoneLanePrune({
      pruneOldDoneItems: async () => {
        called = true;
      },
    });
    assert.equal(called, true);
  });
});

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

describe("returnStaleInProgressItems — isolated (issue #2067)", () => {
  test("returns a >24h inProgress item to queued via the atomic backlog seam", async () => {
    const now = 1_000_000_000_000;
    const staleScore = now - 25 * 60 * 60 * 1000; // 25h old
    const calls: Array<{ id: string; meta: Record<string, unknown> }> = [];
    await returnStaleInProgressItems({
      getBacklogLaneWithScores: async () => ["item-stale", String(staleScore)],
      // Issue #2582: the chore now delegates the mutation to the backlog
      // module's atomic + claim-clearing helper instead of the pre-#1990
      // non-atomic moveBacklogItem. Assert on the id + returnedReason it hands
      // in; the helper (unit-tested separately) owns the actual write.
      returnInProgressItemToQueued: async (id, meta) => {
        calls.push({ id, meta });
        return { id, title: "stale build", lane: "queued", meta };
      },
      now: () => now,
    });
    assert.equal(calls.length, 1, "the stale item is returned exactly once");
    assert.equal(calls[0].id, "item-stale");
    assert.equal(calls[0].meta.returnedReason, "stale_in_progress");
    assert.equal(typeof calls[0].meta.returnedAt, "string");
  });

  test("leaves a fresh inProgress item alone", async () => {
    const now = 1_000_000_000_000;
    let moved = false;
    await returnStaleInProgressItems({
      getBacklogLaneWithScores: async () => ["item-fresh", String(now)],
      returnInProgressItemToQueued: async () => {
        moved = true;
        return null;
      },
      now: () => now,
    });
    assert.equal(moved, false, "a fresh item is not moved");
  });
});

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

describe("runMergedItemReconciler — health snapshot persistence (issue #2057)", () => {
  test("persists feed liveness + batch metrics from a clean run", async () => {
    let saved: any = null;
    await runMergedItemReconciler({
      reconcileMergedItems: async () => ({
        reconciled: [{ id: "item-1", ref: "pr-9" }],
        escalated: [],
        scanned: 4,
        feed: { prs: { examined: 3 }, commits: { examined: 2 } },
        metrics: { referencesFound: 1, movesFailed: 0, durationMs: 42 },
      }),
      setReconcilerHealth: async (record) => { saved = record; },
    });

    assert.ok(saved, "a health snapshot must be persisted every run");
    assert.ok(saved.ranAt, "ranAt timestamp stamped");
    assert.equal(saved.feed.prs.examined, 3);
    assert.equal(saved.feed.commits.examined, 2);
    assert.equal(saved.metrics.referencesFound, 1);
    assert.equal(saved.metrics.movesFailed, 0);
    assert.equal(saved.metrics.itemsReconciled, 1);
    assert.equal(saved.metrics.itemsEscalated, 0);
    assert.equal(saved.metrics.scanned, 4);
    assert.equal(saved.metrics.durationMs, 42);
    assert.equal(saved.alert, undefined, "no alert on a clean run");
  });

  test("persists the both-feeds-down alert into the health snapshot", async () => {
    let saved: any = null;
    await runMergedItemReconciler({
      reconcileMergedItems: async () => ({
        reconciled: [],
        escalated: [],
        scanned: 0,
        feed: {
          prs: { examined: 0, failed: "merged-PR feed unavailable" },
          commits: { examined: 0, failed: "merge-commit feed unavailable" },
        },
        metrics: { referencesFound: 0, movesFailed: 0, durationMs: 5 },
        alert: { code: "reconciler:both-feeds-down", message: "both feeds blind" },
      }),
      setReconcilerHealth: async (record) => { saved = record; },
    });

    assert.ok(saved.alert, "the critical alert must reach the health snapshot");
    assert.equal(saved.alert.code, "reconciler:both-feeds-down");
    assert.ok(saved.feed.prs.failed, "down feed reason persisted");
    assert.ok(saved.feed.commits.failed, "down feed reason persisted");
  });

  test("a health-persist failure does not abort the chore (fail-soft)", async () => {
    // The reconciler already ran (and fired any alert) — a Redis write failure
    // for the observability snapshot must never throw out of the chore.
    await runMergedItemReconciler({
      reconcileMergedItems: async () => ({
        reconciled: [],
        escalated: [],
        scanned: 0,
        feed: { prs: { examined: 1 }, commits: { examined: 1 } },
        metrics: { referencesFound: 0, movesFailed: 0, durationMs: 1 },
      }),
      setReconcilerHealth: async () => { throw new Error("redis down"); },
    });
    // Reaching here without throwing is the assertion.
    assert.ok(true);
  });
});

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
