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
  test("moves a >24h inProgress item to queued via injected deps", async () => {
    const now = 1_000_000_000_000;
    const staleScore = now - 25 * 60 * 60 * 1000; // 25h old
    const moves: Array<{ id: string; from: string; to: string }> = [];
    await returnStaleInProgressItems({
      getBacklogLaneWithScores: async () => ["item-stale", String(staleScore)],
      getBacklogItem: async (id) =>
        JSON.stringify({ id, title: "stale build", lane: "inProgress", meta: {} }),
      moveBacklogItem: async (id, _raw, from, to) => {
        moves.push({ id, from, to });
      },
      now: () => now,
    });
    assert.deepEqual(moves, [{ id: "item-stale", from: "inProgress", to: "queued" }]);
  });

  test("leaves a fresh inProgress item alone", async () => {
    const now = 1_000_000_000_000;
    let moved = false;
    await returnStaleInProgressItems({
      getBacklogLaneWithScores: async () => ["item-fresh", String(now)],
      getBacklogItem: async () => {
        throw new Error("should not be read for a fresh item");
      },
      moveBacklogItem: async () => {
        moved = true;
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
    });
    assert.equal(deleted, 0, "a key with a TTL is never pruned");
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
