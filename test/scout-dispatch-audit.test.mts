/**
 * Regression tests for `src/scout/dispatch-audit.ts` (ScoutDispatchAudit seam,
 * issue #1972 — extracted from `alert-listener.ts`).
 *
 * Coverage:
 *
 *   1. recordDispatch — stamps dedup + cooldown + XADDs audit entry.
 *      - filed outcome stamps per-pattern + per-category, audit reflects fields.
 *      - error outcome XADDs audit ONLY (no dedup/cooldown stamp).
 *   2. listDispatchAudits — newest-first read of the audit stream.
 *   3. SCOUT_DISPATCHES_MAXLEN — the audit-stream bound constant.
 *   4. recordCalendarDispatch (issue #4556) — the calendar-walk twin: XADDs a
 *      `triggeredBy: "calendar"` entry, stamps the per-category cooldown, and
 *      increments the per-day stats counters so calendar-driven walks are
 *      visible on /api/scout/stats (previously NO path incremented them).
 *   5. recordDispatch also increments the stats counters (issue #4556) —
 *      both trigger paths feed the same rollup.
 *
 * The stats-wiring tests use UNIQUE `calvis-*` / `alertvis-*` category slugs
 * and fixed `now` dates, so they never read state another test wrote and
 * never need to wipe `hydra:scout:stats:*` (which would race
 * `scout-stats.test.mts` under parallel multi-file `test:file` runs — the
 * full `npm test` suite serialises files).
 *
 * The Redis-touching tests use DB 1 + a file-level `after` hook to close
 * sockets — same pattern as `scout-alert-listener.test.mts`.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  SCOUT_DISPATCHES_MAXLEN,
  recordDispatch,
  recordCalendarDispatch,
  listDispatchAudits,
} = await import("../src/scout/dispatch-audit.ts");
const { getStatsRollup } = await import("../src/scout/stats.ts");

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
  return testRedis;
}

async function cleanDispatchAuditKeys(): Promise<void> {
  const r = getTestRedis();
  const patterns = [
    "hydra:scout:dispatches",
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
    console.error("scout-dispatch-audit teardown: closeRedisConnections failed", err);
  }
});

// ===========================================================================
// recordDispatch — stamps + audit XADD
// ===========================================================================

describe("recordDispatch (Redis-backed)", () => {
  beforeEach(async () => {
    await cleanDispatchAuditKeys();
  });

  test("filed outcome → audit + pattern + category stamps", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await recordDispatch(
      {
        pattern: "test_decline",
        category: "testing-tooling",
        alertId: "alert-1",
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

  test("audit stream survives many writes (MAXLEN trim)", async () => {
    // Spot-check: MAXLEN ~ 1000 — write a few and verify newest-first order.
    const now = new Date("2026-05-19T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await recordDispatch(
        {
          pattern: `pat-${i}`,
          category: `cat-${i}`,
          alertId: `alert-${i}`,
        },
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
// 4/5. Issue #4556 — recordCalendarDispatch + the shared stats wiring.
// Calendar-walk dispatch outcomes were previously invisible on
// /api/scout/stats (the per-day counters were written by NO path); both
// record* helpers now increment them. Unique category slugs + fixed dates
// + filtered audit reads keep these tests stateless — no beforeEach clean,
// so they neither read another test's state nor widen the pre-existing
// parallel-file hazard on the shared stream (scout-alert-listener vs this
// file's first describe; npm test serialises files, so CI is unaffected).
// ===========================================================================

describe("recordCalendarDispatch + stats wiring (issue #4556)", () => {
  test("filed outcome → stats counter + calendar audit entry + cooldown stamp", async () => {
    const now = new Date("2026-09-18T12:00:00Z");
    await recordCalendarDispatch("calvis-filed", "filed", "2 issues filed", now);

    // Stats: the rollup /api/scout/stats totals derive from sees it.
    const rollup = await getStatsRollup(1, now);
    assert.equal(rollup["calvis-filed"].filed, 1);
    assert.equal(rollup["calvis-filed"].dropped, 0);

    // Audit: calendar entry lands on the dispatch stream. Filtered read —
    // `scout-alert-listener.test.mts` writes/cleans the same stream and can
    // interleave under parallel multi-file `test:file` runs (pre-existing
    // hazard; `npm test` serialises files).
    const mine = (await listDispatchAudits(50)).filter(
      (a) => a.category === "calvis-filed",
    );
    assert.equal(mine.length, 1);
    assert.equal(mine[0].triggeredBy, "calendar");
    assert.equal(mine[0].outcome, "filed");
    assert.equal(mine[0].detail, "2 issues filed");

    // Cooldown: the per-category key (same one stampCategoryWalk writes).
    const r = getTestRedis();
    assert.equal(
      await r.get("hydra:scout:category-last-walked:calvis-filed"),
      now.toISOString(),
    );
  });

  test("dropped outcome → dropped counter; empty detail falls back to a calendar label", async () => {
    const now = new Date("2026-09-18T12:00:00Z");
    await recordCalendarDispatch("calvis-dropped", "dropped", "", now);
    const rollup = await getStatsRollup(1, now);
    assert.equal(rollup["calvis-dropped"].dropped, 1);
    const mine = (await listDispatchAudits(50)).filter(
      (a) => a.category === "calvis-dropped",
    );
    assert.equal(mine.length, 1);
    assert.equal(mine[0].detail, "calendar walk of calvis-dropped");
  });

  test("error outcome → audit XADD only, no stats, no cooldown stamp", async () => {
    const now = new Date("2026-09-18T12:00:00Z");
    await recordCalendarDispatch("calvis-error", "error", "infra blew up", now);

    const rollup = await getStatsRollup(1, now);
    assert.equal(rollup["calvis-error"], undefined);

    const mine = (await listDispatchAudits(50)).filter(
      (a) => a.category === "calvis-error",
    );
    assert.equal(mine.length, 1);
    assert.equal(mine[0].triggeredBy, "calendar");
    assert.equal(mine[0].outcome, "error");

    const r = getTestRedis();
    assert.equal(
      await r.get("hydra:scout:category-last-walked:calvis-error"),
      null,
      "error outcomes must NOT stamp the category cooldown",
    );
  });

  test("recordDispatch (alert path, filed) also increments the stats counters", async () => {
    const now = new Date("2026-09-18T12:00:00Z");
    await recordDispatch(
      { pattern: "test_decline", category: "alertvis-filed", alertId: "alert-1" },
      "filed",
      "issue #999",
      now,
      0.42,
    );
    const rollup = await getStatsRollup(1, now);
    assert.equal(rollup["alertvis-filed"].filed, 1);
  });

  test("recordDispatch (alert path, error) → no stats increment", async () => {
    const now = new Date("2026-09-18T12:00:00Z");
    await recordDispatch(
      { pattern: "anchor_stuck", category: "alertvis-error", alertId: "alert-2" },
      "error",
      "infra blew up",
      now,
    );
    const rollup = await getStatsRollup(1, now);
    assert.equal(rollup["alertvis-error"], undefined);
  });

  test("recordCalendarDispatch rejects empty category", async () => {
    await assert.rejects(
      () => recordCalendarDispatch("", "filed", "x", new Date()),
      TypeError,
    );
  });
});
