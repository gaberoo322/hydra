/**
 * Regression tests for `src/scout/dispatch-audit.ts` (ScoutDispatchAudit seam,
 * issue #1972).
 *
 * Coverage:
 *
 *   1. recordCalendarDispatch — XADDs the audit entry (newest-first read) and
 *      stamps no cooldown on an error outcome.
 *   2. listDispatchAudits — newest-first read of the audit stream.
 *   3. SCOUT_DISPATCHES_MAXLEN — the audit-stream bound constant.
 *
 * The Redis-touching tests use DB 1 + a file-level `after` hook to close
 * sockets — same teardown pattern as the other scout tests.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  SCOUT_DISPATCHES_MAXLEN,
  recordCalendarDispatch,
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
// recordCalendarDispatch — audit XADD ordering
// ===========================================================================

describe("recordCalendarDispatch (Redis-backed)", () => {
  beforeEach(async () => {
    await cleanDispatchAuditKeys();
  });

  test("audit stream is newest-first and the MAXLEN constant matches the schema", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await recordCalendarDispatch(`cat-${i}`, "filed", {}, `entry-${i}`, new Date(now.getTime() + i));
    }
    const audits = await listDispatchAudits(10);
    assert.equal(audits.length, 5);
    assert.equal(audits[0].category, "cat-4");
    assert.equal(audits[4].category, "cat-0");
    assert.equal(audits[0].triggeredBy, "calendar");
    assert.equal(SCOUT_DISPATCHES_MAXLEN, 1000);
  });

  test("error outcome → audit XADD only, no cooldown stamp", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await recordCalendarDispatch("refactoring-tooling", "error", {}, "infra blew up", now);
    const stamp = await getTestRedis().get("hydra:scout:category-last-walked:refactoring-tooling");
    assert.equal(stamp, null, "error outcomes must NOT stamp the category cooldown");
    const audits = await listDispatchAudits(10);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].outcome, "error");
  });
});
