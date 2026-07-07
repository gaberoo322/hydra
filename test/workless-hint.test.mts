/**
 * Regression tests for the workless-board backoff hint (issue #2956).
 *
 * The Pace Gate's admission check is purely usage-based; it never asks whether
 * any work is eligible. When every autopilot class is on cooldown and no signals
 * fire, a launched session's first decide.py turn is wait-only with zero
 * occupied slots and it terminates cause=idle after ~2 minutes, having
 * dispatched nothing — ~14% of runs were these zero-dispatch idle exits, each
 * burning a full claude session bootstrap for nothing. Shape 1 (idle-exit
 * backoff): endRun stamps a short temporal hint on a zero-dispatch idle exit,
 * and while it is future the pace-gate skips relaunch. This suite pins:
 *
 *   - the Redis accessor: set/get/clear round-trip, TTL, fail-safe-to-not-
 *     workless on a corrupt / absent / past value, set refuses a non-future
 *     instant;
 *   - worklessBackoffSec: env override + fail-safe-to-default on garbage;
 *   - overlayWorklessEligibility (pure): surfaces reasons.worklessUntil while
 *     future WITHOUT flipping allow; no-op on null/past;
 *   - GET /api/usage/eligibility: folds the Redis hint into reasons.worklessUntil.
 *
 * The endRun zero-dispatch stamping is pinned in test/autopilot-runs-deps.test.mts
 * (the deps-injection suite that already owns the endRun idempotency cases).
 *
 * Uses Redis DB 1 — never touches production (DB 0). A file-level after() hook
 * closes the Redis client so the runner emits `# pass N` lines (PR #518 lesson).
 */

import { test, describe, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import {
  getWorklessUntil,
  setWorklessUntil,
  clearWorklessUntil,
  worklessBackoffSec,
  WORKLESS_BACKOFF_DEFAULT_SEC,
  WORKLESS_TTL_BUFFER_SEC,
} from "../src/redis/workless-hint.ts";
import { overlayWorklessEligibility, projectEligibility } from "../src/cost/eligibility.ts";
import type { UsageSnapshot } from "../src/cost/index.ts";
import { redisKeys } from "../src/redis/keys.ts";
import { createUsageRouter } from "../src/api/usage.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKey() {
  await redis.del(redisKeys.autopilotWorklessUntil());
}

// Single module-level lifecycle: open the shared client ONCE and close it ONCE
// at the very end (PR #518 / shared-client lesson).
before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  if (redis) {
    await cleanKey();
    redis.disconnect();
  }
});

function mockReq(): any {
  return { method: "GET", url: "/", headers: {}, query: {}, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("workless-hint Redis accessor (issue #2956)", () => {
  beforeEach(cleanKey);

  test("absent key reads as not workless (null)", async () => {
    assert.equal(await getWorklessUntil(), null);
  });

  test("set writes the instant and a self-expiring TTL; get reads it back", async () => {
    const now = Date.now();
    const worklessUntil = now + 45 * 60 * 1000; // +45m
    const stored = await setWorklessUntil(worklessUntil, now);
    assert.equal(stored, worklessUntil);

    assert.equal(await getWorklessUntil(now), worklessUntil);

    const ttl = await redis.ttl(redisKeys.autopilotWorklessUntil());
    const expected = 45 * 60 + WORKLESS_TTL_BUFFER_SEC;
    assert.ok(ttl > expected - 10 && ttl <= expected + 1, `ttl=${ttl} expected≈${expected}`);
  });

  test("clear removes the key", async () => {
    const now = Date.now();
    await setWorklessUntil(now + 60_000, now);
    await clearWorklessUntil();
    assert.equal(await getWorklessUntil(now), null);
  });

  test("a past instant reads as not workless (self-clear guard)", async () => {
    const now = Date.now();
    // Write a raw past value directly (set() would refuse it).
    await redis.set(redisKeys.autopilotWorklessUntil(), String(now - 5000));
    assert.equal(await getWorklessUntil(now), null);
  });

  test("a corrupt value fails SAFE to not workless", async () => {
    await redis.set(redisKeys.autopilotWorklessUntil(), "not-a-number");
    assert.equal(await getWorklessUntil(), null);
  });

  test("set refuses a non-future instant (no-op, returns null)", async () => {
    const now = Date.now();
    assert.equal(await setWorklessUntil(now - 1000, now), null);
    assert.equal(await redis.get(redisKeys.autopilotWorklessUntil()), null);
  });
});

describe("worklessBackoffSec (issue #2956)", () => {
  test("missing env => the 45-min default", () => {
    assert.equal(worklessBackoffSec({}), WORKLESS_BACKOFF_DEFAULT_SEC);
  });

  test("a valid positive value is honored", () => {
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "600" }), 600);
  });

  test("a non-positive / garbage value fails SAFE to the default", () => {
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "0" }), WORKLESS_BACKOFF_DEFAULT_SEC);
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "-5" }), WORKLESS_BACKOFF_DEFAULT_SEC);
    assert.equal(worklessBackoffSec({ HYDRA_WORKLESS_BACKOFF_SEC: "nope" }), WORKLESS_BACKOFF_DEFAULT_SEC);
  });
});

describe("overlayWorklessEligibility (pure) (issue #2956)", () => {
  // A minimal snapshot that projects allow=true, paceState "on".
  const snapshot = {
    emergencyStop: false,
    weeklyEmergencyStop: false,
    calibrated: true,
    weeklyResetAnchor: null,
    percentSinceReset: 0,
  } as unknown as UsageSnapshot;

  test("a FUTURE hint surfaces reasons.worklessUntil WITHOUT flipping allow", () => {
    const now = Date.now();
    const base = projectEligibility(snapshot);
    assert.equal(base.allow, true, "precondition: base projection allows");

    const overlaid = overlayWorklessEligibility(base, now + 30 * 60 * 1000, now);
    // Launcher-only: allow is untouched so decide.py never drains on it.
    assert.equal(overlaid.allow, true);
    assert.equal(typeof overlaid.reasons.worklessUntil, "string");
    assert.equal(new Date(overlaid.reasons.worklessUntil as string).getTime(), now + 30 * 60 * 1000);
  });

  test("a null hint returns the input UNCHANGED", () => {
    const now = Date.now();
    const base = projectEligibility(snapshot);
    const overlaid = overlayWorklessEligibility(base, null, now);
    assert.equal(overlaid.reasons.worklessUntil, null);
    assert.equal(overlaid.allow, base.allow);
  });

  test("a PAST hint returns the input UNCHANGED (self-heals)", () => {
    const now = Date.now();
    const base = projectEligibility(snapshot);
    const overlaid = overlayWorklessEligibility(base, now - 1000, now);
    assert.equal(overlaid.reasons.worklessUntil, null);
  });
});

describe("GET /api/usage/eligibility folds the workless hint (issue #2956)", () => {
  beforeEach(cleanKey);

  test("a future workless hint appears under reasons.worklessUntil; allow stays true", async () => {
    const now = Date.now();
    await setWorklessUntil(now + 30 * 60 * 1000, now);

    const router = createUsageRouter();
    const get = findHandler(router, "GET", "/usage/eligibility");
    assert.ok(get, "GET /usage/eligibility handler should exist");
    const res = mockRes();
    await get!(mockReq(), res);

    assert.equal(res._status, 200);
    assert.equal(typeof res._body.reasons.worklessUntil, "string");
    // Advisory only — must not force allow=false.
    assert.equal(res._body.allow, true);
  });

  test("no hint => reasons.worklessUntil is null", async () => {
    const router = createUsageRouter();
    const get = findHandler(router, "GET", "/usage/eligibility");
    const res = mockRes();
    await get!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.reasons.worklessUntil, null);
  });
});
