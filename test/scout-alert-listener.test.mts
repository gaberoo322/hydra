/**
 * Regression tests for `src/scout/alert-listener.ts` (issue #486 — Phase C
 * of the /hydra-tool-scout epic).
 *
 * Coverage:
 *
 *   1. stripPatternPrefix + categoriesForPattern — pure lookups, no I/O.
 *   2. isCooledDownHours — pure cooldown predicate.
 *   3. classifyAlert — pure disposition function (every branch).
 *      - unmapped pattern, dismissed, before-cursor, malformed
 *      - per-pattern cooldown, per-category cooldown
 *      - coalescing inside the batch
 *      - happy path
 *   4. planAlertDispatches — end-to-end against fixture alerts in Redis.
 *      - cursor honored, anti-burst across 10 alerts → ≤ 2 dispatches.
 *   5. recordDispatch — stamps dedup + cooldown + XADDs audit entry.
 *   6. listDispatchAudits — newest-first read of the audit stream.
 *   7. advanceAlertCursor — round-trip.
 *
 * The Redis-touching tests use DB 1 + a file-level `after` hook to close
 * sockets — same pattern as `scout-seen-list.test.mts`.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  PATTERN_CATEGORY_MAP,
  ALERT_PER_PATTERN_COOLDOWN_HOURS,
  ALERT_PER_CATEGORY_COOLDOWN_HOURS,
  SCOUT_DISPATCHES_MAXLEN,
  stripPatternPrefix,
  categoriesForPattern,
  isCooledDownHours,
  classifyAlert,
  planAlertDispatches,
  recordDispatch,
  recordCalendarDispatch,
  listDispatchAudits,
  advanceAlertCursor,
  getAlertCursor,
} = await import("../src/scout/alert-listener.ts");

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
  return testRedis;
}

async function cleanAlertListenerKeys(): Promise<void> {
  const r = getTestRedis();
  const patterns = [
    "hydra:alerts",
    "hydra:scout:dispatches",
    "hydra:scout:alert-cursor",
    "hydra:scout:pattern-last-fired:*",
    "hydra:scout:category-last-walked:*",
  ];
  for (const p of patterns) {
    if (p.includes("*")) {
      const keys = await r.keys(p);
      if (keys.length > 0) await r.del(...keys);
    } else {
      await r.del(p);
    }
  }
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
    console.error("scout-alert-listener teardown: closeRedisConnections failed", err);
  }
});

const MS_PER_HOUR = 60 * 60 * 1000;

// ===========================================================================
// 1. Pure lookups
// ===========================================================================

describe("stripPatternPrefix", () => {
  test("strips the pattern: prefix", () => {
    assert.equal(stripPatternPrefix("pattern:test_decline"), "test_decline");
  });
  test("leaves bare names alone", () => {
    assert.equal(stripPatternPrefix("test_decline"), "test_decline");
  });
  test("non-string inputs return empty", () => {
    assert.equal(stripPatternPrefix(undefined as any), "");
    assert.equal(stripPatternPrefix(null as any), "");
  });
});

describe("categoriesForPattern", () => {
  test("starter map entries from the issue body are present", () => {
    // Every pattern named in the issue body must have at least one category.
    for (const p of [
      "consecutive_failures",
      "test_decline",
      "file_rework",
      "rollback_cluster",
    ]) {
      const cats = categoriesForPattern(p);
      assert.ok(cats.length > 0, `expected mapping for ${p}`);
    }
  });
  test("unmapped patterns return empty array (not null)", () => {
    const cats = categoriesForPattern("totally-made-up-pattern");
    assert.deepEqual([...cats], []);
  });
  test("reflex-loop chokepoint: scout-induced patterns are NOT in the map", () => {
    // Research question #4: cost-cap and consumer:dead must NEVER re-trigger
    // the scout. Verifying they're absent from the map is the lowest-cost
    // way to enforce that invariant.
    assert.deepEqual([...categoriesForPattern("cost-cap")], []);
    assert.deepEqual([...categoriesForPattern("consumer_dead")], []);
    assert.deepEqual([...categoriesForPattern("dlq_alert")], []);
  });
  test("PATTERN_CATEGORY_MAP is frozen (mutation-safe)", () => {
    assert.throws(() => {
      (PATTERN_CATEGORY_MAP as any).new_pattern = ["x"];
    });
  });
});

// ===========================================================================
// 2. isCooledDownHours
// ===========================================================================

describe("isCooledDownHours", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  test("null/empty → cooled", () => {
    assert.equal(isCooledDownHours(null, 24, now), true);
    assert.equal(isCooledDownHours("", 24, now), true);
  });
  test("unparseable → cooled (corrupt-record fallback)", () => {
    assert.equal(isCooledDownHours("not-a-date", 24, now), true);
  });
  test("inside cooldown → not cooled", () => {
    const past = new Date(now.getTime() - 6 * MS_PER_HOUR).toISOString();
    assert.equal(isCooledDownHours(past, 24, now), false);
  });
  test("boundary → cooled (>=)", () => {
    const past = new Date(now.getTime() - 24 * MS_PER_HOUR).toISOString();
    assert.equal(isCooledDownHours(past, 24, now), true);
  });
  test("default cooldown values are 24h", () => {
    assert.equal(ALERT_PER_PATTERN_COOLDOWN_HOURS, 24);
    assert.equal(ALERT_PER_CATEGORY_COOLDOWN_HOURS, 24);
  });
});

// ===========================================================================
// 3. classifyAlert — pure disposition
// ===========================================================================

describe("classifyAlert", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  const fresh = () => ({
    patternLastFired: {} as Record<string, string | null>,
    categoryLastWalked: {} as Record<string, string | null>,
    alreadyScheduled: new Set<string>(),
    cursorIso: null as string | null,
    now,
  });

  test("happy path: mapped pattern, no cooldown → target", () => {
    const result = classifyAlert(
      {
        id: "alert-1",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
        message: "Tests declining",
      },
      fresh(),
    );
    assert.ok("target" in result, "expected target");
    assert.equal(result.target.pattern, "test_decline");
    assert.equal(result.target.category, "testing-tooling");
    assert.equal(result.target.alertId, "alert-1");
  });

  test("malformed alert (no id) → skip:malformed", () => {
    const result = classifyAlert(
      { type: "pattern:test_decline", timestamp: "2026-05-19T11:00:00Z" },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "malformed");
  });

  test("dismissed alert → skip:dismissed", () => {
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
        dismissed: true,
      },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "dismissed");
  });

  test("alert older than cursor → skip:before-cursor", () => {
    const state = fresh();
    state.cursorIso = "2026-05-19T11:30:00Z";
    const result = classifyAlert(
      {
        id: "old",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "before-cursor");
  });

  test("unmapped pattern → skip:unmapped-pattern", () => {
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:totally_unknown",
        timestamp: "2026-05-19T11:00:00Z",
      },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "unmapped-pattern");
  });

  test("cycle:failed (non-pattern type) → skip:unmapped-pattern", () => {
    // Issue body says we map FAILURE PATTERNS, not raw cycle events. Verify
    // the listener doesn't mistakenly dispatch on every failed cycle.
    const result = classifyAlert(
      {
        id: "a",
        type: "cycle:failed",
        timestamp: "2026-05-19T11:00:00Z",
      },
      fresh(),
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "unmapped-pattern");
  });

  test("per-pattern cooldown → skip:pattern-cooldown", () => {
    const state = fresh();
    state.patternLastFired = {
      test_decline: new Date(now.getTime() - 6 * MS_PER_HOUR).toISOString(),
    };
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "pattern-cooldown");
  });

  test("per-category cooldown → skip:category-cooldown", () => {
    const state = fresh();
    state.categoryLastWalked = {
      "testing-tooling": new Date(now.getTime() - 6 * MS_PER_HOUR).toISOString(),
    };
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "category-cooldown");
  });

  test("category already scheduled in batch → skip:coalesced", () => {
    const state = fresh();
    state.alreadyScheduled = new Set(["testing-tooling"]);
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("skip" in result);
    assert.equal(result.skip.reason, "coalesced");
  });

  test("cooldowns elapsed past 24h → eligible", () => {
    const state = fresh();
    state.patternLastFired = {
      test_decline: new Date(now.getTime() - 25 * MS_PER_HOUR).toISOString(),
    };
    state.categoryLastWalked = {
      "testing-tooling": new Date(now.getTime() - 25 * MS_PER_HOUR).toISOString(),
    };
    const result = classifyAlert(
      {
        id: "a",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      },
      state,
    );
    assert.ok("target" in result);
  });
});

// ===========================================================================
// 4. planAlertDispatches — Redis-backed end-to-end
// ===========================================================================

describe("planAlertDispatches (Redis-backed)", () => {
  beforeEach(async () => {
    await cleanAlertListenerKeys();
  });

  async function seedAlerts(alerts: any[]): Promise<void> {
    const r = getTestRedis();
    // The production code LPUSHes alerts (newest at index 0). Replicate that
    // ordering so listRange returns oldest-last like the live data plane.
    for (const a of alerts) {
      await r.lpush("hydra:alerts", JSON.stringify(a));
    }
  }

  test("empty alerts list → empty plan", async () => {
    const plan = await planAlertDispatches(new Date("2026-05-19T12:00:00Z"));
    assert.deepEqual(plan.eligible, []);
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.newestTimestamp, null);
  });

  test("single mapped alert → 1 eligible dispatch", async () => {
    await seedAlerts([
      {
        id: "a1",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
        message: "tests down",
      },
    ]);
    const plan = await planAlertDispatches(new Date("2026-05-19T12:00:00Z"));
    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.eligible[0].pattern, "test_decline");
    assert.equal(plan.eligible[0].category, "testing-tooling");
    assert.equal(plan.newestTimestamp, "2026-05-19T11:00:00Z");
  });

  test("anti-burst stress test: 10 alerts in 5 minutes → ≤ 2 dispatches", async () => {
    // Issue body acceptance criterion: "inject 10 alerts in 5 minutes; verify
    // ≤ 2 scout dispatches". Use a mix of mapped patterns that collapse to
    // a small number of distinct categories.
    const now = new Date("2026-05-19T12:00:00Z");
    const alerts: any[] = [];
    for (let i = 0; i < 10; i++) {
      alerts.push({
        id: `burst-${i}`,
        type: i % 2 === 0 ? "pattern:test_decline" : "pattern:recurring_regressions",
        timestamp: new Date(now.getTime() - (i + 1) * 30_000).toISOString(),
        message: `burst ${i}`,
      });
    }
    await seedAlerts(alerts);

    const plan = await planAlertDispatches(now);
    // Both patterns map to "testing-tooling" — so coalescing collapses
    // ten alerts into ONE dispatch.
    assert.ok(plan.eligible.length <= 2, `expected ≤ 2 dispatches, got ${plan.eligible.length}`);
    assert.ok(plan.eligible.length >= 1, "expected at least 1 dispatch on a 10-alert burst");

    // The remaining 9 should be in `skipped` — coalesced or pattern-cooldown.
    const skipReasons = new Set(plan.skipped.map((s: any) => s.reason));
    // We expect at least one of these reasons to appear:
    assert.ok(skipReasons.has("coalesced") || skipReasons.has("pattern-cooldown"));
  });

  test("cursor blocks already-processed alerts", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await seedAlerts([
      {
        id: "old",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T10:00:00Z",
        message: "should be skipped",
      },
      {
        id: "new",
        type: "pattern:anchor_stuck",
        timestamp: "2026-05-19T11:30:00Z",
        message: "should be eligible",
      },
    ]);
    await advanceAlertCursor("2026-05-19T11:00:00Z");

    const plan = await planAlertDispatches(now);
    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.eligible[0].alertId, "new");
    const beforeCursor = plan.skipped.find((s: any) => s.reason === "before-cursor");
    assert.ok(beforeCursor, "expected before-cursor skip for the older alert");
  });

  test("dismissed alerts are skipped", async () => {
    await seedAlerts([
      {
        id: "dis",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
        dismissed: true,
      },
    ]);
    const plan = await planAlertDispatches(new Date("2026-05-19T12:00:00Z"));
    assert.equal(plan.eligible.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, "dismissed");
  });

  test("malformed JSON in list is logged + skipped, doesn't poison the tick", async () => {
    const r = getTestRedis();
    await r.lpush("hydra:alerts", "{not json");
    await r.lpush(
      "hydra:alerts",
      JSON.stringify({
        id: "good",
        type: "pattern:test_decline",
        timestamp: "2026-05-19T11:00:00Z",
      }),
    );
    const plan = await planAlertDispatches(new Date("2026-05-19T12:00:00Z"));
    assert.equal(plan.eligible.length, 1);
    assert.equal(plan.eligible[0].alertId, "good");
  });
});

// ===========================================================================
// 5. recordDispatch — stamps + audit XADD
// ===========================================================================

describe("recordDispatch (Redis-backed)", () => {
  beforeEach(async () => {
    await cleanAlertListenerKeys();
  });

  test("filed outcome → audit + pattern + category stamps", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await recordDispatch(
      {
        pattern: "test_decline",
        category: "testing-tooling",
        alertId: "alert-1",
        alertTimestamp: "2026-05-19T11:00:00Z",
        reason: "tests down",
      },
      "filed",
      "issue #999",
      now,
      0.42,
    );

    // Pattern dedup stamped.
    const r = getTestRedis();
    const patternStamp = await r.get("hydra:scout:pattern-last-fired:test_decline");
    assert.equal(patternStamp, now.toISOString());

    // Category cooldown stamped (shares the calendar walk key).
    const categoryStamp = await r.get("hydra:scout:category-last-walked:testing-tooling");
    assert.equal(categoryStamp, now.toISOString());

    // Audit stream has one entry.
    const audits = await listDispatchAudits(10);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].triggeredBy, "alert:test_decline");
    assert.equal(audits[0].category, "testing-tooling");
    assert.equal(audits[0].outcome, "filed");
    assert.equal(audits[0].detail, "issue #999");
    assert.equal(audits[0].cost, 0.42);
  });

  test("error outcome → audit XADD only, no stamping", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await recordDispatch(
      {
        pattern: "anchor_stuck",
        category: "refactoring-tooling",
        alertId: "alert-2",
        alertTimestamp: "2026-05-19T11:00:00Z",
        reason: "stuck",
      },
      "error",
      "infra blew up",
      now,
    );

    const r = getTestRedis();
    const patternStamp = await r.get("hydra:scout:pattern-last-fired:anchor_stuck");
    assert.equal(patternStamp, null, "error outcomes must NOT stamp dedup");
    const audits = await listDispatchAudits(10);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, "error");
  });

  test("recordCalendarDispatch writes audit with triggeredBy=calendar", async () => {
    await recordCalendarDispatch("typed-schemas", "filed", "issue #777", new Date("2026-05-19T12:00:00Z"));
    const audits = await listDispatchAudits(10);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].triggeredBy, "calendar");
    assert.equal(audits[0].category, "typed-schemas");
  });

  test("audit stream survives many writes (MAXLEN trim)", async () => {
    // Spot-check: MAXLEN ~ 1000 — write a few and verify newest-first order.
    const now = new Date("2026-05-19T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await recordCalendarDispatch(
        `cat-${i}`,
        "filed",
        `entry-${i}`,
        new Date(now.getTime() + i),
      );
    }
    const audits = await listDispatchAudits(10);
    assert.equal(audits.length, 5);
    // Newest-first: cat-4 should be index 0.
    assert.equal(audits[0].category, "cat-4");
    assert.equal(audits[4].category, "cat-0");
    // MAXLEN constant matches the schema.
    assert.equal(SCOUT_DISPATCHES_MAXLEN, 1000);
  });
});

// ===========================================================================
// 6. advanceAlertCursor round-trip
// ===========================================================================

describe("advanceAlertCursor", () => {
  beforeEach(async () => {
    await cleanAlertListenerKeys();
  });

  test("set + read round-trip", async () => {
    await advanceAlertCursor("2026-05-19T12:00:00Z");
    const got = await getAlertCursor();
    assert.equal(got, "2026-05-19T12:00:00Z");
  });

  test("rejects empty arg", async () => {
    await assert.rejects(() => advanceAlertCursor(""), TypeError);
    await assert.rejects(() => advanceAlertCursor(undefined as any), TypeError);
  });
});
