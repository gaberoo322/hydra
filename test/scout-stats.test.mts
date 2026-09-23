/**
 * Regression tests for `src/scout/stats.ts` and the
 * `GET /api/scout/stats` rollup (issue #485 — Phase B), plus the
 * dispatch-audit → stats counts wiring (issue #4556).
 *
 * Coverage:
 *
 *  1. incrStat — basic increment + idempotent re-write.
 *  2. incrStat — TTL set on first write (key expires after 14d).
 *  3. getStatsRollup — aggregates last N days across categories.
 *  4. getStatsRollup — clamps window to [1, MAX_ROLLUP_WINDOW_DAYS].
 *  5. Unknown metric throws RangeError.
 *  6. toIsoDay is UTC.
 *  7. recordCalendarDispatch / recordDispatch per-candidate counts land in
 *     the rollup, stamp the right cooldown keys, and never auto-translate
 *     an outcome into a count (issue #4556).
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  incrStat,
  getStatsRollup,
  toIsoDay,
  MAX_ROLLUP_WINDOW_DAYS,
} = await import("../src/scout/stats.ts");
const {
  recordCalendarDispatch,
  recordDispatch,
  listDispatchAudits,
} = await import("../src/scout/dispatch-audit.ts");
const {
  getScoutCategoryLastWalked,
  getScoutLastCalendarWalk,
  getScoutPatternLastFired,
} = await import("../src/redis/scout.ts");

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
  return testRedis;
}

async function cleanScoutStats(): Promise<void> {
  const r = getTestRedis();
  const keys = await r.keys("hydra:scout:stats:*");
  if (keys.length > 0) await r.del(...keys);
}

/**
 * Lifecycle cleanup for the dispatch-audit wiring describe (issue #4556):
 * the audit stream + the per-day stat hashes + the per-category cooldown
 * keys. Deliberately does NOT touch `hydra:scout:last-calendar-walk` or the
 * per-pattern dedup keys — those assertions compare before/after state of
 * the shared keys instead (see the class-walk / pattern-stamp tests).
 */
async function cleanDispatchAuditKeys(): Promise<void> {
  const r = getTestRedis();
  await r.del("hydra:scout:dispatches");
  for (const pattern of ["hydra:scout:stats:*", "hydra:scout:category-last-walked:*"]) {
    const keys = await r.keys(pattern);
    if (keys.length > 0) await r.del(...keys);
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
    console.error("scout-stats teardown: closeRedisConnections failed", err);
  }
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("scout-stats", () => {
  beforeEach(async () => {
    await cleanScoutStats();
  });

  test("toIsoDay returns UTC YYYY-MM-DD", () => {
    assert.equal(toIsoDay(new Date("2026-05-19T03:00:00Z")), "2026-05-19");
    // Late-night UTC stays on the same day even from a non-UTC locale clock.
    assert.equal(toIsoDay(new Date("2026-05-19T23:30:00Z")), "2026-05-19");
    // Wraps into next day at midnight UTC.
    assert.equal(toIsoDay(new Date("2026-05-20T00:00:01Z")), "2026-05-20");
  });

  test("incrStat increments a single (category, metric) on the right day", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const n1 = await incrStat("typed-schemas", "candidates", 3, now);
    const n2 = await incrStat("typed-schemas", "candidates", 2, now);
    assert.equal(n1, 3);
    assert.equal(n2, 5);

    const r = getTestRedis();
    const stored = await r.hget("hydra:scout:stats:2026-05-19", "typed-schemas:candidates");
    assert.equal(stored, "5");
  });

  test("incrStat sets a 14-day TTL on the day-hash", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await incrStat("typed-schemas", "filed", 1, now);
    const r = getTestRedis();
    const ttl = await r.ttl("hydra:scout:stats:2026-05-19");
    // Between 13d and 14d (clock drift tolerant — TTL is at most 14d * 86400s).
    assert.ok(ttl > 13 * 86400, `expected TTL > 13d, got ${ttl}s`);
    assert.ok(ttl <= 14 * 86400, `expected TTL <= 14d, got ${ttl}s`);
  });

  test("incrStat rejects unknown metric", async () => {
    await assert.rejects(
      () => incrStat("typed-schemas", "junk" as any, 1, new Date()),
      RangeError,
    );
  });

  test("incrStat rejects empty category", async () => {
    await assert.rejects(
      () => incrStat("", "candidates", 1, new Date()),
      TypeError,
    );
  });

  test("getStatsRollup aggregates last 7 days across days + categories", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    // Today: 5 candidates / 2 filed for typed-schemas, 1 rejected for structured-errors.
    await incrStat("typed-schemas", "candidates", 5, now);
    await incrStat("typed-schemas", "filed", 2, now);
    await incrStat("structured-errors", "rejected", 1, now);
    // 3 days ago: 2 candidates for typed-schemas.
    await incrStat("typed-schemas", "candidates", 2, new Date(now.getTime() - 3 * MS_PER_DAY));
    // 10 days ago: outside the 7d window.
    await incrStat("typed-schemas", "candidates", 99, new Date(now.getTime() - 10 * MS_PER_DAY));

    const rollup = await getStatsRollup(7, now);
    assert.equal(rollup["typed-schemas"].candidates, 7); // 5 + 2, NOT 7+99
    assert.equal(rollup["typed-schemas"].filed, 2);
    assert.equal(rollup["structured-errors"].rejected, 1);
    // Buckets exist with zero-defaults for untouched metrics.
    assert.equal(rollup["typed-schemas"].rejected, 0);
    assert.equal(rollup["structured-errors"].candidates, 0);
  });

  test("getStatsRollup clamps window to MAX_ROLLUP_WINDOW_DAYS", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    // 1000 should not crash — clamped to MAX_ROLLUP_WINDOW_DAYS (14).
    const rollup = await getStatsRollup(1000, now);
    assert.equal(typeof rollup, "object");
    // No data → empty map.
    assert.equal(Object.keys(rollup).length, 0);
  });

  test("getStatsRollup clamps window to >= 1", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await incrStat("typed-schemas", "candidates", 4, now);
    const rollup = await getStatsRollup(0, now);
    // Clamped to 1 → today only.
    assert.equal(rollup["typed-schemas"].candidates, 4);
  });

  test("MAX_ROLLUP_WINDOW_DAYS exported and matches the TTL", () => {
    assert.equal(MAX_ROLLUP_WINDOW_DAYS, 14);
  });
});

// ---------------------------------------------------------------------------
// Dispatch-audit → stats counts wiring (issue #4556)
//
// Root cause of the invisible calendar walks: the per-day stat hashes were
// written by NOBODY (incrStat had zero production callers), so
// GET /api/scout/stats read 0 for both trigger paths. recordCalendarDispatch
// / recordDispatch now forward an explicit per-candidate counts map. These
// tests pin: the audit XADD + cooldown-stamp semantics of both writers, that
// ONLY explicit counts move the rollup, and the junk-count validation
// posture (skip, never throw — the audit write has already landed).
//
// Categories use `calstat-*` slugs (unique to this file) and audit reads are
// filtered by category, so sibling scout test files sharing the Redis DB
// under a parallel file run never contaminate these assertions.
// ---------------------------------------------------------------------------

describe("scout-stats: recordCalendarDispatch / recordDispatch counts wiring (issue #4556)", () => {
  beforeEach(async () => {
    await cleanDispatchAuditKeys();
  });

  // Pinned "now" — every write and rollup read below uses it, so the per-day
  // hash key is deterministic and window math is exact.
  const NOW = new Date("2026-05-19T12:00:00Z");

  test("recordCalendarDispatch (filed): one triggeredBy=calendar audit entry, category cooldown stamped, no class-walk or pattern stamp", async () => {
    const cat = "calstat-a";
    const classWalkBefore = await getScoutLastCalendarWalk();
    const r = getTestRedis();
    const patternKeysBefore = new Set(await r.keys("hydra:scout:pattern-last-fired:*"));

    await recordCalendarDispatch(cat, "filed", { candidates: 5 }, "walk done", NOW, 0.01);

    const audits = (await listDispatchAudits(1000)).filter((e) => e.category === cat);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].triggeredBy, "calendar");
    assert.equal(audits[0].outcome, "filed");
    assert.equal(audits[0].detail, "walk done");

    // Per-category cooldown stamped with the SAME key stampCategoryWalk
    // writes — one cooldown surface for both triggers.
    assert.equal(await getScoutCategoryLastWalked(cat), NOW.toISOString());

    // Class walk NOT stamped (stays once-per-sweep via stampClassWalk) and no
    // per-pattern dedup key stamped (calendar walks have no pattern). Both
    // keys are shared with sibling test files, so assert unchanged state,
    // never a bare null/empty.
    assert.equal(await getScoutLastCalendarWalk(), classWalkBefore);
    const patternKeysAfter = await r.keys("hydra:scout:pattern-last-fired:*");
    assert.deepEqual(patternKeysAfter.filter((k: string) => !patternKeysBefore.has(k)), []);
  });

  test("recordCalendarDispatch counts move getStatsRollup: 5 evaluated candidates are visible as totals.candidates >= 5", async () => {
    const cat = "calstat-b";
    await recordCalendarDispatch(cat, "dropped", { candidates: 5, filtered: 2, rejected: 3 }, "", NOW);

    // The exact #4556 acceptance shape: after a calendar dispatch that
    // evaluated 5 candidates, the rollup shows candidates >= 5.
    const rollup = await getStatsRollup(7, NOW);
    assert.ok((rollup[cat]?.candidates ?? 0) >= 5, `expected candidates >= 5, got ${rollup[cat]?.candidates}`);
    assert.equal(rollup[cat].filtered, 2);
    assert.equal(rollup[cat].rejected, 3);
  });

  test("recordCalendarDispatch outcome is never auto-translated: empty counts leave the rollup untouched (filed does not imply filed:1)", async () => {
    const cat = "calstat-c";
    await recordCalendarDispatch(cat, "filed", {}, "", NOW);

    // A 'filed' outcome does not imply filed:1 — with no explicit counts the
    // category never even appears in the rollup.
    const rollup = await getStatsRollup(7, NOW);
    assert.equal(rollup[cat], undefined);
  });

  test("recordDispatch trailing counts populate the rollup identically; audit + pattern/category stamps unchanged", async () => {
    const cat = "calstat-d";
    await recordDispatch(
      { pattern: "calstat-pat", category: cat, alertId: "alert-calstat-1" },
      "filed",
      "1 issue filed",
      NOW,
      0.02,
      { candidates: 3, filed: 1 },
    );

    const rollup = await getStatsRollup(7, NOW);
    assert.equal(rollup[cat].candidates, 3);
    assert.equal(rollup[cat].filed, 1);

    // Audit entry carries the alert: prefix (existing behaviour).
    const audits = (await listDispatchAudits(1000)).filter((e) => e.category === cat);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].triggeredBy, "alert:calstat-pat");
    assert.equal(audits[0].detail, "1 issue filed");

    // Both existing stamps still land (per-pattern dedup + shared category
    // cooldown) — interfaceImpact=extend, not change.
    assert.equal(await getScoutPatternLastFired("calstat-pat"), NOW.toISOString());
    assert.equal(await getScoutCategoryLastWalked(cat), NOW.toISOString());
  });

  test("recordCalendarDispatch validation: empty category throws TypeError; junk counts entries are skipped not thrown", async () => {
    await assert.rejects(
      () => recordCalendarDispatch("", "filed", {}, "", NOW),
      TypeError,
    );

    const cat = "calstat-e";
    // Unknown metric key, negative count, zero count, non-number count — all
    // skipped. A malformed count must never fail the audit write.
    await recordCalendarDispatch(
      cat,
      "filed",
      { bogus: 1, candidates: -2, filtered: 0, rejected: "x" } as any,
      "",
      NOW,
    );

    const audits = (await listDispatchAudits(1000)).filter((e) => e.category === cat);
    assert.equal(audits.length, 1, "audit entry lands despite junk counts");
    const rollup = await getStatsRollup(7, NOW);
    assert.equal(rollup[cat], undefined, "no junk entry moved any counter");
  });

  test("recordCalendarDispatch (error): audit entry recorded, category cooldown NOT stamped", async () => {
    const cat = "calstat-f";
    await recordCalendarDispatch(cat, "error", { candidates: 2 }, "infra blew up", NOW);

    const audits = (await listDispatchAudits(1000)).filter((e) => e.category === cat);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, "error");
    assert.equal(audits[0].detail, "infra blew up");
    assert.equal(await getScoutCategoryLastWalked(cat), null);

    // Counts still applied — the candidates were evaluated before the infra
    // error, so the rollup should not pretend nothing happened.
    const rollup = await getStatsRollup(7, NOW);
    assert.equal(rollup[cat].candidates, 2);
  });
});
