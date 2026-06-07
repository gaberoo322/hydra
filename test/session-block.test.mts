/**
 * Regression tests for the session-limit hard-block flag (issue #1089).
 *
 * When the Claude Code rolling SESSION window is exhausted the autopilot exits
 * code=1 with `You've hit your session limit · resets <t>`. The pace-gate then
 * relaunches into the still-exhausted quota — dying instantly, repeatedly —
 * because the OAuth 5h emergencyStop undershoots the true session limit. This
 * flag records the reset instant (self-expiring TTL) so admission skips until
 * the quota resets, then resumes automatically. This suite pins:
 *
 *   - the Redis accessor: set/get/clear round-trip, TTL, fail-safe-to-no-block
 *     on a corrupt / absent / past value;
 *   - POST /api/usage/session-block: parses the exit line, records the block,
 *     returns recorded:false for a non-session-limit line; 400 on a bad body;
 *   - GET /api/usage/eligibility: overlays reasons.sessionBlockedUntil +
 *     allow=false while the block is in the future;
 *   - pace-gate.sh: skips launch on a future block; launches once it passes.
 *
 * Uses Redis DB 1 — never touches production (DB 0). A file-level after() hook
 * closes the Redis client so the runner emits `# pass N` lines (PR #518 lesson).
 */

import { test, describe, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getSessionBlockedUntil,
  setSessionBlockedUntil,
  clearSessionBlockedUntil,
  SESSION_BLOCK_TTL_BUFFER_SEC,
} from "../src/redis/session-block.ts";
import { redisKeys } from "../src/redis/keys.ts";
import { createUsageRouter } from "../src/api/usage.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

const PACE_GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "autopilot",
  "pace-gate.sh",
);

async function cleanKey() {
  await redis.del(redisKeys.autopilotSessionBlock());
}

// Single module-level lifecycle: open the shared client ONCE and close it ONCE
// at the very end. A per-describe after() that disconnects the shared client
// would tear it out from under later suites (PR #518 / shared-client lesson).
before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  if (redis) {
    await cleanKey();
    redis.disconnect();
  }
});

function mockReq(body: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body };
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

/** Serve a fixed eligibility JSON on an ephemeral port; resolve with url+close. */
function eligibilityServer(payload: unknown): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/usage/eligibility`,
        close: () => server.close(),
      });
    });
  });
}

describe("session-block Redis accessor (issue #1089)", () => {
  beforeEach(cleanKey);

  test("absent key reads as no block (null)", async () => {
    assert.equal(await getSessionBlockedUntil(), null);
  });

  test("set writes the instant and a self-expiring TTL; get reads it back", async () => {
    const now = Date.now();
    const blockedUntil = now + 60 * 60 * 1000; // +1h
    const stored = await setSessionBlockedUntil(blockedUntil, now);
    assert.equal(stored, blockedUntil);

    assert.equal(await getSessionBlockedUntil(now), blockedUntil);

    const ttl = await redis.ttl(redisKeys.autopilotSessionBlock());
    // TTL ~= 1h + buffer; allow a small slack for the round-trip.
    const expected = 60 * 60 + SESSION_BLOCK_TTL_BUFFER_SEC;
    assert.ok(ttl > expected - 10 && ttl <= expected + 1, `ttl=${ttl} expected≈${expected}`);
  });

  test("clear removes the key", async () => {
    const now = Date.now();
    await setSessionBlockedUntil(now + 1000, now);
    await clearSessionBlockedUntil();
    assert.equal(await getSessionBlockedUntil(now), null);
  });

  test("a past instant reads as no block (self-clear guard)", async () => {
    const now = Date.now();
    // Write a raw past value directly (set() would refuse it).
    await redis.set(redisKeys.autopilotSessionBlock(), String(now - 5000));
    assert.equal(await getSessionBlockedUntil(now), null);
  });

  test("a corrupt value fails SAFE to no block", async () => {
    await redis.set(redisKeys.autopilotSessionBlock(), "not-a-number");
    assert.equal(await getSessionBlockedUntil(), null);
  });

  test("set refuses a non-future instant (no-op, returns null)", async () => {
    const now = Date.now();
    assert.equal(await setSessionBlockedUntil(now - 1000, now), null);
    assert.equal(await redis.get(redisKeys.autopilotSessionBlock()), null);
  });
});

describe("POST /api/usage/session-block (issue #1089)", () => {
  beforeEach(cleanKey);

  test("parses an exit line and records the block", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    assert.ok(post, "POST /usage/session-block handler should exist");
    const res = mockRes();
    await post!(
      mockReq({
        line: "You've hit your session limit · resets 11:59pm (UTC)",
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, true);
    assert.ok(typeof res._body.blockedUntil === "string");
    // The flag is now readable.
    assert.ok((await getSessionBlockedUntil()) !== null);
  });

  test("a non-session-limit line records nothing (recorded:false)", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const res = mockRes();
    await post!(mockReq({ line: "ordinary crash log line" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, false);
    assert.equal(await getSessionBlockedUntil(), null);
  });

  test("accepts a pre-parsed blockedUntilMs", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const future = Date.now() + 30 * 60 * 1000;
    const res = mockRes();
    await post!(mockReq({ blockedUntilMs: future }), res);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.blockedUntilMs, future);
  });

  test("an empty body is a 400 schema-validation-failed", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const res = mockRes();
    await post!(mockReq({}), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

describe("pace-gate.sh launch-skip on session block (issue #1089)", () => {
  function runPaceGate(eligibilityUrl: string): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [PACE_GATE], {
        env: {
          ...process.env,
          HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE: "1",
          HYDRA_PACE_GATE_DRY_RUN: "1",
          HYDRA_PACE_GATE_ELIGIBILITY_URL: eligibilityUrl,
          HYDRA_AUTOPILOT_STATE: "/tmp/hydra-pace-gate-sessionblock-nonexistent.json",
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
    });
  }

  test("a future sessionBlockedUntil => skip, does NOT launch", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: {
        emergencyStop: false,
        pacingShed: false,
        calibrated: true,
        paused: false,
        sessionBlockedUntil: future,
      },
      paceState: "on",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /session-limit block until/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("a past sessionBlockedUntil => falls through and launches", async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: {
        emergencyStop: false,
        pacingShed: false,
        calibrated: true,
        paused: false,
        sessionBlockedUntil: past,
      },
      paceState: "on",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
      assert.doesNotMatch(r.stdout, /session-limit block/);
    } finally {
      srv.close();
    }
  });

  test("no sessionBlockedUntil (null) => launches normally", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: {
        emergencyStop: false,
        pacingShed: false,
        calibrated: true,
        paused: false,
        sessionBlockedUntil: null,
      },
      paceState: "on",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });
});
