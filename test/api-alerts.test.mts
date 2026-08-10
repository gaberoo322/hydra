/**
 * Regression tests for the `GET /alerts` reader guard (`src/api/alerts.ts`,
 * issue #3744).
 *
 * # The defect
 *
 * The handler did `raw.map((s) => JSON.parse(s))`. One unparseable element in
 * the `hydra:alerts` Redis list (an empty string, whitespace, or truncated
 * JSON) threw out of the `.map`; the `aggregatorRouteNoQuery` never-throw seam
 * caught it and returned HTTP 500 for the *entire* list. During the incident
 * that surfaced this, 51 active alerts were invisible to the operator until the
 * element was removed by hand. The scout consumer of the same list got exactly
 * this guard in #3619; the API route was missed.
 *
 * # The fix under test
 *
 * The route now skips non-string / empty / whitespace-only elements and
 * try/catch-logs (never silently drops) anything `JSON.parse` rejects — the
 * reader-side defence-in-depth (the write-side root cause is #3743). These
 * cases exercise the real `createAlertsRouter()` over HTTP so the regression
 * asserts on the actual HTTP 200 + the parseable remainder, not an
 * implementation detail.
 *
 * # Why this is its own top-level suite
 *
 * It owns its own Express server + Redis seeding lifecycle (`before`/`after`
 * + a `beforeEach` keyspace clean), per the CLAUDE.md authoring rule — never
 * nest Redis-touching cases under a sibling suite's shared-Redis `after()`
 * teardown, and seed/clean per-case in `beforeEach` since each case mutates the
 * `hydra:alerts` list the next case reads. The seeding connection points at the
 * same Redis the router reads (both honor `REDIS_URL`), so under the test
 * runner's per-run DB isolation (`scripts/test/redis-db-launch.mjs`) the seeded
 * entries are exactly what the route observes.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Redis from "ioredis";
import type { AddressInfo } from "node:net";

import { createAlertsRouter } from "../src/api/alerts.ts";
import { logger } from "../src/logger.ts";

const ALERTS_KEY = "hydra:alerts";

// Same Redis the router reads (getRedisConnection honors REDIS_URL). Seeding
// here is observed by the route's readRecentAlerts over the same DB.
let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) testRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  return testRedis;
}

let server: any;
let baseUrl: string;

async function startServer(): Promise<void> {
  const app = express();
  // Mount the alerts router directly — the route is registered as GET /alerts.
  // (In the assembled app it lives under /api; root-mount is enough to exercise
  // the handler + the aggregatorRouteNoQuery seam over real HTTP.)
  app.use(createAlertsRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

async function cleanAlertsKey(): Promise<void> {
  await getTestRedis().del(ALERTS_KEY);
}

describe("GET /alerts — unparseable-entry guard (issue #3744)", () => {
  before(async () => {
    await startServer();
  });

  after(() => {
    if (server) server.close();
    if (testRedis) testRedis.disconnect();
  });

  beforeEach(async () => {
    // Each case mutates the alerts list the next case reads — fresh slate.
    await cleanAlertsKey();
  });

  test("a single empty-string element no longer 500s the route — valid alerts return with 200", async () => {
    const r = getTestRedis();
    // Reproduce the incident: a legacy empty entry alongside a valid alert.
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "good-1", type: "cycle:operator_blocked" }));
    await r.lpush(ALERTS_KEY, "");

    const res = await fetch(`${baseUrl}/alerts`);
    // Against the old `raw.map((s) => JSON.parse(s))` this was a 500
    // (`Unexpected end of JSON input`); the guard must make it 200.
    assert.equal(res.status, 200, "GET /alerts must return 200, not 500, on a corrupt entry");
    const body = await res.json();
    assert.ok(Array.isArray(body), "response body is an array of alerts");
    assert.equal(body.length, 1, "the valid alert survives; the empty entry is skipped");
    assert.equal(body[0].id, "good-1");
  });

  test("skips whitespace-only and garbage entries; multiple valid alerts survive (200)", async () => {
    const r = getTestRedis();
    // Seed a mix: two valid objects interleaved with a whitespace-only entry
    // and a truncated-JSON entry. LPUSH puts the last push at index 0 (newest).
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "old", type: "a" }));
    await r.lpush(ALERTS_KEY, "   ");
    await r.lpush(ALERTS_KEY, "{not json");
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "new", type: "b" }));

    const res = await fetch(`${baseUrl}/alerts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 2, "exactly the two valid entries survive");
    assert.deepEqual(
      body.map((a: any) => a.id).sort(),
      ["new", "old"],
    );
    // Newest-first (LPUSH) order is preserved for the surviving entries.
    assert.deepEqual(
      body.map((a: any) => a.id),
      ["new", "old"],
    );
  });

  test("each skipped element is logged with context — fail-loud, not a silent drop", async () => {
    // Intercept the shared pino logger's error method (alerts.ts calls
    // logger.error on each skip). Restore it unconditionally afterwards.
    const realError = logger.error;
    const captured: Array<{ ctx: any; msg: string }> = [];
    let monkeypatchOk = true;
    try {
      // pino defines level methods as own writable instance properties, so this
      // assignment shadows .error for the duration of the case.
      (logger as any).error = function (ctx: any, msg: string) {
        captured.push({ ctx, msg });
      };
    } catch {
      // If the level method is non-writable in this pino build, fall back to the
      // behavioral assertion only (the skip still happened — proven by the 200).
      monkeypatchOk = false;
    }

    try {
      const r = getTestRedis();
      await r.lpush(ALERTS_KEY, "{truncated");
      await r.lpush(ALERTS_KEY, "");
      await r.lpush(ALERTS_KEY, JSON.stringify({ id: "survivor" }));

      const res = await fetch(`${baseUrl}/alerts`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.length, 1, "only the valid alert is returned");
      assert.equal(body[0].id, "survivor");
    } finally {
      // Restore before any other case / suite runs.
      if (monkeypatchOk) (logger as any).error = realError;
    }

    if (!monkeypatchOk) return; // behavioral assertion above already proves the guard
    // The garbage entry ("{truncated") must be logged with context. The empty
    // entry is skipped silently before JSON.parse (it can't throw), so it does
    // not produce a log line — matching the #3619 scout guard shape.
    const parseFailures = captured.filter((c) =>
      typeof c.msg === "string" && c.msg.includes("skipping unparseable"),
    );
    assert.ok(
      parseFailures.length >= 1,
      "at least one skip must be logged with context (fail-loud)",
    );
    const logged = parseFailures[0].ctx ?? {};
    assert.ok(logged.routeLabel === "api/alerts", "log carries the routeLabel for context");
    assert.ok(typeof logged.rawLen === "number", "log carries the raw element length");
    assert.ok(logged.err, "log carries the thrown err field");
  });

  test("an all-valid list is unaffected — returns every entry with 200", async () => {
    const r = getTestRedis();
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "x1" }));
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "x2" }));

    const res = await fetch(`${baseUrl}/alerts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.map((a: any) => a.id),
      ["x2", "x1"],
    );
  });
});

/**
 * Regression tests for the `POST /alerts/:id/dismiss` reader guard
 * (`src/api/alerts.ts`, issue #3793).
 *
 * # The defect
 *
 * The dismiss route did a bare `JSON.parse(all[i])` while scanning the full
 * list for the target id. One unparseable neighbour anywhere in the list
 * threw out of the loop, was caught by the route's outer try/catch, and
 * turned into a 500 for the entire dismiss attempt — even when the target
 * alert itself was perfectly valid. This mirrors the `GET /alerts` defect
 * fixed in #3744/#3773; that fix only covered the read route, not this one.
 *
 * # The fix under test
 *
 * The scan now skips non-string / empty / whitespace-only elements silently
 * and log+skips (never silently drops) anything `JSON.parse` rejects, then
 * continues the scan at the same original index — so `setAlertAt(i, ...)`
 * for a later valid match still targets the correct list position.
 *
 * # Why this is its own top-level suite
 *
 * Same authoring rule as the GET suite above: a new top-level `describe`
 * with its own `before`/`after` (server lifecycle) and `beforeEach` (Redis
 * keyspace clean) — never nested inside a sibling suite's shared teardown.
 * This suite deliberately does NOT reuse the module-level `server`/
 * `testRedis`/`startServer`/`getTestRedis`/`cleanAlertsKey` from the GET
 * suite above — those are torn down by that suite's own `after()`, and
 * `node:test` runs sibling top-level suites in sequence, so reusing them here
 * would hand this suite a disconnected Redis client (the exact shared-Redis
 * flake class the CLAUDE.md authoring rule warns against). Independent
 * server + Redis connection, scoped to this suite only.
 */
describe("POST /alerts/:id/dismiss — unparseable-entry guard (issue #3793)", () => {
  let dismissServer: any;
  let dismissBaseUrl: string;
  let dismissRedis: any = null;

  function getDismissRedis(): any {
    if (!dismissRedis) dismissRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    return dismissRedis;
  }

  before(async () => {
    const app = express();
    app.use(createAlertsRouter());
    await new Promise<void>((resolve) => {
      dismissServer = app.listen(0, () => {
        const addr = dismissServer.address() as AddressInfo;
        dismissBaseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(() => {
    if (dismissServer) dismissServer.close();
    if (dismissRedis) dismissRedis.disconnect();
  });

  beforeEach(async () => {
    await getDismissRedis().del(ALERTS_KEY);
  });

  test("a malformed neighbour entry no longer 500s the dismiss scan — the target alert is still found and dismissed", async () => {
    const r = getDismissRedis();
    // LPUSH order: last push is index 0. Put the corrupt entry ahead of the
    // target so the scan must skip over it to reach the valid alert.
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "target", dismissed: false }));
    await r.lpush(ALERTS_KEY, "{truncated");

    const res = await fetch(`${dismissBaseUrl}/alerts/target/dismiss`, { method: "POST" });
    // Against the old bare `JSON.parse(all[i])` this was a 500; the guard
    // must let the scan continue past the corrupt entry to the real match.
    assert.equal(res.status, 200, "dismiss must return 200, not 500, despite a corrupt neighbour");
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    const all = await r.lrange(ALERTS_KEY, 0, -1);
    const stored = all.map((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    const dismissed = stored.find((a: any) => a && a.id === "target");
    assert.ok(dismissed, "the target alert is still present in the list");
    assert.equal(dismissed.dismissed, true, "the target alert was actually dismissed");
  });

  test("skips empty and whitespace-only entries too, without a 500", async () => {
    const r = getDismissRedis();
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "target2", dismissed: false }));
    await r.lpush(ALERTS_KEY, "   ");
    await r.lpush(ALERTS_KEY, "");

    const res = await fetch(`${dismissBaseUrl}/alerts/target2/dismiss`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  test("a malformed entry that does not match the target id still allows a correct 404", async () => {
    const r = getDismissRedis();
    await r.lpush(ALERTS_KEY, JSON.stringify({ id: "other", dismissed: false }));
    await r.lpush(ALERTS_KEY, "{not json");

    const res = await fetch(`${dismissBaseUrl}/alerts/does-not-exist/dismiss`, { method: "POST" });
    // Against the old code this was a 500 (thrown by the corrupt entry) before
    // the scan ever reached the "not found" fallthrough. The guard must let
    // the scan finish and report 404 for a genuinely absent id.
    assert.equal(res.status, 404, "dismiss must return 404, not 500, when the id is genuinely absent");
    const body = await res.json();
    assert.equal(body.error, "Alert not found");
  });

  test("each skipped malformed entry is logged with context — fail-loud, not a silent drop", async () => {
    const realError = logger.error;
    const captured: Array<{ ctx: any; msg: string }> = [];
    let monkeypatchOk = true;
    try {
      (logger as any).error = function (ctx: any, msg: string) {
        captured.push({ ctx, msg });
      };
    } catch {
      monkeypatchOk = false;
    }

    try {
      const r = getDismissRedis();
      await r.lpush(ALERTS_KEY, JSON.stringify({ id: "target3", dismissed: false }));
      await r.lpush(ALERTS_KEY, "{truncated");

      const res = await fetch(`${dismissBaseUrl}/alerts/target3/dismiss`, { method: "POST" });
      assert.equal(res.status, 200);
    } finally {
      if (monkeypatchOk) (logger as any).error = realError;
    }

    if (!monkeypatchOk) return;
    const parseFailures = captured.filter((c) =>
      typeof c.msg === "string" && c.msg.includes("skipping unparseable"),
    );
    assert.ok(parseFailures.length >= 1, "at least one skip must be logged with context (fail-loud)");
    const logged = parseFailures[0].ctx ?? {};
    assert.ok(logged.routeLabel === "api/alerts/dismiss", "log carries the dismiss routeLabel for context");
    assert.ok(typeof logged.index === "number", "log carries the list index of the skipped entry");
    assert.ok(typeof logged.rawLen === "number", "log carries the raw element length");
    assert.ok(logged.err, "log carries the thrown err field");
    assert.equal(logged.alertId, "target3", "log carries the dismiss attempt's target alertId for context");
  });
});
