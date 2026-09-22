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
  listDispatchAudits,
} = await import("../src/scout/dispatch-audit.ts");

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
