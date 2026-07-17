/**
 * Regression tests for the operator-only durable **Autopilot pause** flag
 * (issue #988).
 *
 * Pause stops `hydra-autopilot` from both *launching* and *dispatching* (with
 * a drain — in-flight subagents are untouched), while the emergency-brake only
 * blocks auto-merge. The two are independent flags that compose. This suite
 * pins the backend slice:
 *
 *   AC1 — POST /api/autopilot/paused {paused:true|false} sets/clears the flag;
 *         GET returns current state + `since`. Operator-only (route is the SOLE
 *         write path — there is no action-type entry in decide.py).
 *   AC3 — /api/usage/eligibility overlays paused => allow=false (drain) +
 *         reasons.paused=true; not-paused leaves the projection unchanged.
 *   AC4 — /health and /api/scheduler/status report paused as a healthy field.
 *   AC5 — pause/resume emit a hydra:notifications bus event.
 *   AC7 — Redis access is through the new accessor; the corrupt/absent blob
 *         fails SAFE to not-paused; the request body is zod-validated.
 *
 * Uses Redis DB 1 — never touches production (DB 0). PR #518 lesson: a
 * file-level `after()` hook closes the Redis client so the runner emits
 * `# pass N` lines and CI's PASS_COUNT check doesn't blow up.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  getAutopilotPaused,
  setAutopilotPaused,
  clearAutopilotPaused,
} from "../src/redis/autopilot-pause.ts";
import { redisKeys } from "../src/redis/keys.ts";
import { overlayPauseEligibility, projectEligibility } from "../src/cost/eligibility.ts";
import { type UsageSnapshot } from "../src/cost/index.ts";
import { AutopilotPauseBodySchema } from "../src/autopilot/control-schemas.ts";
import { createAutopilotControlRouter as createAutopilotRouter } from "../src/api/autopilot-control.ts";

const PACE_GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "autopilot",
  "pace-gate.sh",
);

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

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKey() {
  await redis.del(redisKeys.autopilotPaused());
}

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
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

// A minimal calibrated-not-emergency snapshot — projectEligibility(allow=true).
function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    generatedAt: new Date("2026-06-05T00:00:00Z").toISOString(),
    calibrated: true,
    emergencyStop: false,
    pacingState: "under",
    percentLast5h: 10,
    percentSinceReset: 10,
    weeklyResetAnchor: null,
    ...(over as any),
  } as UsageSnapshot;
}

describe("autopilot pause flag (issue #988)", () => {
  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKey();
  });

  after(async () => {
    if (redis) {
      await cleanKey();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // AC7 — accessor: absent => not paused (default-off / fail-safe to running)
  // ---------------------------------------------------------------------------
  test("AC7: absent flag reads as not paused", async () => {
    const state = await getAutopilotPaused();
    assert.equal(state.paused, false);
    assert.equal(state.since, undefined);
  });

  test("AC7: corrupt blob fails SAFE to not paused", async () => {
    await redis.set(redisKeys.autopilotPaused(), "{not json");
    const state = await getAutopilotPaused();
    assert.equal(state.paused, false);
  });

  test("AC7: blob with paused!==true reads as not paused", async () => {
    await redis.set(redisKeys.autopilotPaused(), JSON.stringify({ paused: false, since: 1 }));
    const state = await getAutopilotPaused();
    assert.equal(state.paused, false);
  });

  // ---------------------------------------------------------------------------
  // AC1 — set / clear round-trip via the accessor
  // ---------------------------------------------------------------------------
  test("AC1: set writes {paused:true, since}; clear removes it", async () => {
    const before = Date.now();
    const set = await setAutopilotPaused();
    assert.equal(set.paused, true);
    assert.ok(typeof set.since === "number" && set.since >= before);

    const read = await getAutopilotPaused();
    assert.equal(read.paused, true);
    assert.equal(read.since, set.since);

    await clearAutopilotPaused();
    const cleared = await getAutopilotPaused();
    assert.equal(cleared.paused, false);
  });

  test("AC1: clear is idempotent on an already-absent flag", async () => {
    await clearAutopilotPaused();
    await clearAutopilotPaused();
    const state = await getAutopilotPaused();
    assert.equal(state.paused, false);
  });

  // ---------------------------------------------------------------------------
  // AC1 — POST/GET routes are the sole write path; operator-only
  // ---------------------------------------------------------------------------
  test("AC1: POST {paused:true} sets, GET returns it, POST {paused:false} clears", async () => {
    const router = createAutopilotRouter();
    const post = findHandler(router, "POST", "/autopilot/paused");
    const get = findHandler(router, "GET", "/autopilot/paused");
    assert.ok(post, "POST /autopilot/paused handler should exist");
    assert.ok(get, "GET /autopilot/paused handler should exist");

    let res = mockRes();
    await post!(mockReq({ paused: true }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.paused, true);
    assert.ok(typeof res._body.since === "number");

    res = mockRes();
    await get!(mockReq(), res);
    assert.equal(res._body.paused, true);

    res = mockRes();
    await post!(mockReq({ paused: false }), res);
    assert.equal(res._body.paused, false);

    res = mockRes();
    await get!(mockReq(), res);
    assert.equal(res._body.paused, false);
  });

  test("AC1/AC7: POST with a bad body is a 400 schema-validation-failed", async () => {
    const router = createAutopilotRouter();
    const post = findHandler(router, "POST", "/autopilot/paused");
    const res = mockRes();
    await post!(mockReq({ paused: "yes" }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("AC7: POST rejects unknown fields (strict schema)", async () => {
    const router = createAutopilotRouter();
    const post = findHandler(router, "POST", "/autopilot/paused");
    const res = mockRes();
    await post!(mockReq({ paused: true, pausedBy: "nope" }), res);
    assert.equal(res._status, 400);
    // Ensure no flag was written by a rejected request.
    assert.equal((await getAutopilotPaused()).paused, false);
  });

  // ---------------------------------------------------------------------------
  // AC5 — pause/resume emit a bus event
  // ---------------------------------------------------------------------------
  test("AC5: pause and resume publish a hydra:notifications event", async () => {
    const events: Array<{ stream: string; event: any }> = [];
    const fakeBus = {
      publish: async (stream: string, event: any) => { events.push({ stream, event }); },
    };
    const router = createAutopilotRouter(fakeBus);
    const post = findHandler(router, "POST", "/autopilot/paused");

    await post!(mockReq({ paused: true }), mockRes());
    await post!(mockReq({ paused: false }), mockRes());

    assert.equal(events.length, 2);
    assert.equal(events[0].event.type, "autopilot-paused");
    assert.equal(events[0].event.payload.paused, true);
    assert.equal(events[1].event.type, "autopilot-resumed");
    assert.equal(events[1].event.payload.paused, false);
  });

  test("AC5: a missing bus degrades to a no-op (no throw)", async () => {
    const router = createAutopilotRouter(); // no eventBus
    const post = findHandler(router, "POST", "/autopilot/paused");
    const res = mockRes();
    await post!(mockReq({ paused: true }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.paused, true);
  });
});

describe("overlayPauseEligibility (issue #988)", () => {
  // ---------------------------------------------------------------------------
  // AC3 — paused overlays allow=false + reasons.paused=true (drain)
  // ---------------------------------------------------------------------------
  test("AC3: not paused returns the projection unchanged", () => {
    const base = projectEligibility(snapshot());
    assert.equal(base.allow, true);
    assert.equal(base.reasons.paused, false);
    const out = overlayPauseEligibility(base, false);
    assert.equal(out, base, "input object returned unchanged when not paused");
  });

  test("AC3: paused forces allow=false and reasons.paused=true", () => {
    const base = projectEligibility(snapshot());
    assert.equal(base.allow, true);
    const out = overlayPauseEligibility(base, true);
    assert.equal(out.allow, false);
    assert.equal(out.reasons.paused, true);
    // Pure: the input is not mutated.
    assert.equal(base.allow, true);
    assert.equal(base.reasons.paused, false);
  });

  test("AC3: projectEligibility itself is pure — defaults reasons.paused=false, no IO", () => {
    // Calling it never reads Redis; the field defaults false.
    const base = projectEligibility(snapshot());
    assert.equal(base.reasons.paused, false);
  });
});

describe("AutopilotPauseBodySchema (issue #988)", () => {
  test("accepts {paused:boolean}", () => {
    assert.equal(AutopilotPauseBodySchema.safeParse({ paused: true }).success, true);
    assert.equal(AutopilotPauseBodySchema.safeParse({ paused: false }).success, true);
  });
  test("rejects non-boolean / missing / extra fields", () => {
    assert.equal(AutopilotPauseBodySchema.safeParse({}).success, false);
    assert.equal(AutopilotPauseBodySchema.safeParse({ paused: "x" }).success, false);
    assert.equal(AutopilotPauseBodySchema.safeParse({ paused: true, extra: 1 }).success, false);
  });
});

describe("pace-gate.sh launch-skip on pause (issue #988, AC2)", () => {
  // Common env: force the service "inactive" and dry-run so the launch branch
  // logs "would-start" instead of poking systemd. STATE points at a missing
  // file so the PID-alive skip doesn't fire.
  //
  // ASYNC spawn (not spawnSync): the eligibility fixture is an in-process HTTP
  // server, so the test's event loop MUST stay free to accept curl's
  // connection while pace-gate.sh runs. spawnSync would block the loop and the
  // server would never answer (curl times out -> "unreachable").
  function runPaceGate(eligibilityUrl: string): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [PACE_GATE], {
        env: {
          ...process.env,
          HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE: "1",
          HYDRA_PACE_GATE_DRY_RUN: "1",
          HYDRA_PACE_GATE_ELIGIBILITY_URL: eligibilityUrl,
          HYDRA_AUTOPILOT_STATE: "/tmp/hydra-pace-gate-test-nonexistent.json",
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
    });
  }

  test("AC2: paused eligibility => pause-skip, does NOT launch", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { emergencyStop: false, pacingShed: false, calibrated: true, paused: true },
      paceState: "on",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /autopilot paused \(operator\) — skip/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("AC2: not-paused eligible eligibility => launches (would-start)", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { emergencyStop: false, pacingShed: false, calibrated: true, paused: false },
      paceState: "on",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
      assert.doesNotMatch(r.stdout, /autopilot paused/);
    } finally {
      srv.close();
    }
  });
});
