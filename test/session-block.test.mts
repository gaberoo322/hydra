/**
 * Regression tests for the exhaustion hard-block flag (issue #1089, widened
 * by #4583).
 *
 * When the Claude Code rolling SESSION window is exhausted the autopilot exits
 * code=1 with `You've hit your session limit · resets <t>`. The pace-gate then
 * relaunches into the still-exhausted quota — dying instantly, repeatedly —
 * because the OAuth 5h emergencyStop undershoots the true session limit. This
 * flag records the reset instant (self-expiring TTL) so admission skips until
 * the quota resets, then resumes automatically.
 *
 * Issue #4583 widened this from one recognised exhaustion phrasing to three
 * arming paths, after a SEPARATE `You're out of usage credits...` exit notice
 * (no reset time; code=1 too) stormed the pace-gate relaunch loop for ~14h
 * (240 relaunches, run 6a9539de) because the pre-#4583 guard only recognised
 * `hit your session limit`:
 *   1. session-limit  — unchanged, exact reset time parsed server-side.
 *   2. out-of-credits — new; no reset time, so a fixed 30-min TTL block.
 *   3. crash-streak    — new message-agnostic backstop: N crash exits within a
 *      window with NO recognised exhaustion line still arms a 60-min block, so
 *      the NEXT unrecognised exhaustion string can't storm unbounded either.
 * This suite pins:
 *
 *   - the Redis accessor: set/get/clear round-trip, TTL, fail-safe-to-no-block
 *     on a corrupt / absent / past value (storage/read path unchanged, #4583
 *     INV-7);
 *   - `parseExhaustionBlock` (src/cost/token-math.ts): classifies a line as
 *     session-limit / out-of-credits / neither, computing the right instant;
 *   - POST /api/usage/session-block: parses/classifies the exit line OR
 *     accepts a pre-parsed blockedUntilMs+reason, records the block, returns
 *     recorded:false for an unrecognised line; 400 on a bad body;
 *   - GET /api/usage/eligibility: overlays reasons.sessionBlockedUntil +
 *     allow=false while the block is in the future;
 *   - pace-gate.sh: skips launch on a future block; launches once it passes;
 *   - pace-gate.sh --exec-autopilot (the unit's ExecStart wrapper — the
 *     systemd Restart=on-failure path that bypassed the timer gate): exits 0
 *     WITHOUT exec'ing on a future block / unreachable eligibility, and
 *     exec's the session when eligible;
 *   - bootstrap.sh --reap-session-decision / --reap-crash-streak: the
 *     cause-gated arming decisions for all three paths (dry-run, no journal
 *     scan, no POST — see test/autopilot-scripts.test.mts for the sibling
 *     --reap-derive-cause / --reap-crash-detail dry-runs).
 *
 * Uses Redis DB 1 — never touches production (DB 0). A file-level after() hook
 * closes the Redis client so the runner emits `# pass N` lines (PR #518 lesson).
 */

import { test, describe, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { spawn, spawnSync } from "node:child_process";
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
import { parseExhaustionBlock, CREDITS_EXHAUSTED_BLOCK_MS } from "../src/cost/token-math.ts";

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

const BOOTSTRAP = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "autopilot",
  "bootstrap.sh",
);

const CREDITS_LINE =
  "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

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
    assert.equal(res._body.kind, "session-limit", "a session-limit line records kind:session-limit (#4583)");
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
    assert.equal(res._body.kind, null, "an unrecognised line records kind:null (#4583)");
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

/**
 * Pure unit tests for `parseExhaustionBlock` (src/cost/token-math.ts, issue
 * #4583) — the single classification seam both the reap's POST body and this
 * route share. No Redis, no HTTP: exercises the composed session-limit +
 * out-of-credits matching directly.
 */
describe("parseExhaustionBlock (issue #4583)", () => {
  const NOW = Date.UTC(2026, 8, 22, 12, 0, 0); // 2026-09-22T12:00:00Z

  test("a session-limit line classifies as session-limit with the exact reset instant", () => {
    const r = parseExhaustionBlock("You've hit your session limit · resets 11:59pm (UTC)", NOW);
    assert.ok(r !== null);
    assert.equal(r!.kind, "session-limit");
    assert.ok(r!.blockedUntilMs > NOW, "the reset instant must be in the future");
  });

  test("an out-of-credits line classifies as out-of-credits with a fixed +30min block", () => {
    const r = parseExhaustionBlock(CREDITS_LINE, NOW);
    assert.ok(r !== null);
    assert.equal(r!.kind, "out-of-credits");
    assert.equal(r!.blockedUntilMs, NOW + CREDITS_EXHAUSTED_BLOCK_MS);
  });

  test("out-of-credits matches case-insensitively and mid-line (loose phrase match)", () => {
    const r = parseExhaustionBlock("2026-09-22 some-prefix: Out Of Usage Credits, sorry", NOW);
    assert.ok(r !== null);
    assert.equal(r!.kind, "out-of-credits");
  });

  test("an unrelated line classifies as null", () => {
    assert.equal(parseExhaustionBlock("ordinary crash log line", NOW), null);
  });

  test("an empty line classifies as null", () => {
    assert.equal(parseExhaustionBlock("", NOW), null);
  });
});

/**
 * POST /api/usage/session-block — exhaustion widening (issue #4583). NEW
 * top-level describe (own beforeEach lifecycle, per the CLAUDE.md shared-
 * teardown-timing pitfall) so these additions cannot flake against the
 * `POST /api/usage/session-block (issue #1089)` suite's ordering.
 */
describe("POST /api/usage/session-block — exhaustion widening (issue #4583)", () => {
  beforeEach(cleanKey);

  test("the verbatim out-of-credits line records a block ~30min out, kind out-of-credits", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const before = Date.now();
    const res = mockRes();
    await post!(mockReq({ line: CREDITS_LINE }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.kind, "out-of-credits");
    const expectedFloor = before + CREDITS_EXHAUSTED_BLOCK_MS;
    const expectedCeil = Date.now() + CREDITS_EXHAUSTED_BLOCK_MS;
    assert.ok(
      res._body.blockedUntilMs >= expectedFloor && res._body.blockedUntilMs <= expectedCeil,
      `blockedUntilMs=${res._body.blockedUntilMs} expected within [${expectedFloor}, ${expectedCeil}]`,
    );
    assert.ok((await getSessionBlockedUntil()) !== null);
  });

  test("blockedUntilMs + reason:crash-streak records kind:crash-streak", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const future = Date.now() + 60 * 60 * 1000;
    const res = mockRes();
    await post!(mockReq({ blockedUntilMs: future, reason: "crash-streak" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.kind, "crash-streak");
    assert.equal(res._body.blockedUntilMs, future);
  });

  test("a plain pre-parsed blockedUntilMs with no reason records kind:null", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const future = Date.now() + 60 * 60 * 1000;
    const res = mockRes();
    await post!(mockReq({ blockedUntilMs: future }), res);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.kind, null);
  });

  test("`reason` without `blockedUntilMs` is a 400 schema-validation-failed", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const res = mockRes();
    await post!(mockReq({ line: CREDITS_LINE, reason: "crash-streak" }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

/**
 * bootstrap.sh --reap-session-decision / --reap-crash-streak (issue #4583).
 * Dry-run invocations — no journal scan, no POST — pinning the cause-gated
 * arming decisions the live `--reap` path shares. Sibling to the
 * --reap-derive-cause / --reap-crash-detail dry-run tests in
 * test/autopilot-scripts.test.mts; kept HERE (not there) because the design
 * concept for #4583 groups every new pinning test under this file
 * (scope-justification: bootstrap.sh is already touched by this issue and
 * this file already spawns a sibling script, pace-gate.sh, via the exact same
 * pattern).
 */
describe("bootstrap.sh --reap-session-decision / --reap-crash-streak (issue #4583)", () => {
  function reapSessionDecision(
    exitCode: string,
    exitStatus: string,
    sessionLine: string,
  ): { cause: string; post: string } {
    const result = spawnSync(BOOTSTRAP, ["--reap-session-decision"], {
      env: {
        ...process.env,
        EXIT_CODE: exitCode,
        EXIT_STATUS: exitStatus,
        HYDRA_AUTOPILOT_REAP_SESSION_LINE: sessionLine,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const stdout = result.stdout ?? "";
    const m = stdout.match(/cause=(\S+)\s+post=(\S+)/);
    return { cause: m?.[1] ?? "", post: m?.[2] ?? "" };
  }

  function reapCrashStreak(
    exitCode: string,
    exitStatus: string,
    sessionLine: string,
    recentCrashes: string,
  ): { cause: string; post: string } {
    const result = spawnSync(BOOTSTRAP, ["--reap-crash-streak"], {
      env: {
        ...process.env,
        EXIT_CODE: exitCode,
        EXIT_STATUS: exitStatus,
        HYDRA_AUTOPILOT_REAP_SESSION_LINE: sessionLine,
        HYDRA_AUTOPILOT_REAP_RECENT_CRASHES: recentCrashes,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf-8",
    });
    const stdout = result.stdout ?? "";
    const m = stdout.match(/cause=(\S+)\s+post=(\S+)/);
    return { cause: m?.[1] ?? "", post: m?.[2] ?? "" };
  }

  test("an out-of-credits line on a crash exit arms the block (post=yes)", () => {
    const r = reapSessionDecision("exited", "1", CREDITS_LINE);
    assert.equal(r.cause, "crash");
    assert.equal(r.post, "yes", "a genuine credits-exhaustion crash must arm the block");
  });

  test("a clean exit (code 0) with a stale credits line → NO block (post=no)", () => {
    const r = reapSessionDecision("exited", "0", CREDITS_LINE);
    assert.equal(r.cause, "interrupted");
    assert.equal(r.post, "no", "a clean exit must not arm a phantom block from a stale credits line");
  });

  test("crash-streak: below threshold (recent=1, default N=3) does NOT arm", () => {
    const r = reapCrashStreak("exited", "1", "", "1");
    assert.equal(r.cause, "crash");
    assert.equal(r.post, "no", "1 prior + this crash = 2 < N=3");
  });

  test("crash-streak: at threshold (recent=2, default N=3) DOES arm", () => {
    const r = reapCrashStreak("exited", "1", "", "2");
    assert.equal(r.cause, "crash");
    assert.equal(r.post, "yes", "2 prior + this crash = 3 >= N=3");
  });

  test("crash-streak: an exhaustion line already arming the exact path suppresses the streak (INV-6)", () => {
    const r = reapCrashStreak("exited", "1", CREDITS_LINE, "10");
    assert.equal(r.cause, "crash");
    assert.equal(
      r.post,
      "no",
      "the exact exhaustion-line classification must win — at most one block per reap",
    );
  });

  test("crash-streak: a clean exit (cause=interrupted) never arms, however high the count", () => {
    const r = reapCrashStreak("exited", "0", "", "10");
    assert.equal(r.cause, "interrupted");
    assert.equal(r.post, "no", "clean exits never arm any block (#1130)");
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

describe("pace-gate.sh --exec-autopilot — systemd Restart= path (issue #1089 recurrence)", () => {
  // The unit's ExecStart wrapper. Restart=on-failure relaunches the unit
  // without consulting the timer gate, so the wrapper must re-run the same
  // admission check on EVERY start: blocked => clean exit 0 (disarms the
  // restart storm), eligible => exec the session.
  function runExecMode(
    eligibilityUrl: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [PACE_GATE, "--exec-autopilot"], {
        env: {
          ...process.env,
          // NOTE: no FORCE_SERVICE_INACTIVE — exec mode must skip the
          // is-active self-check on its own (the unit IS active: it's us).
          HYDRA_PACE_GATE_ELIGIBILITY_URL: eligibilityUrl,
          HYDRA_AUTOPILOT_STATE: "/tmp/hydra-pace-gate-sessionblock-nonexistent.json",
          ...extraEnv,
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
    });
  }

  const eligible = {
    allow: true,
    shed: [],
    reasons: {
      emergencyStop: false,
      pacingShed: false,
      calibrated: true,
      paused: false,
      sessionBlockedUntil: null as string | null,
    },
    paceState: "on",
  };

  test("a future sessionBlockedUntil => clean exit 0, does NOT exec", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      ...eligible,
      allow: false,
      reasons: { ...eligible.reasons, sessionBlockedUntil: future },
    });
    try {
      const r = await runExecMode(srv.url, {
        HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-should-not-appear",
      });
      assert.equal(r.status, 0); // CLEAN exit — Restart=on-failure must disarm
      assert.match(r.stdout, /session-limit block until/);
      assert.doesNotMatch(r.stdout, /exec-marker-should-not-appear/);
    } finally {
      srv.close();
    }
  });

  test("eligible => execs the session (test hook command runs)", async () => {
    const srv = await eligibilityServer(eligible);
    try {
      const r = await runExecMode(srv.url, {
        HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-ran",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /exec-marker-ran/);
    } finally {
      srv.close();
    }
  });

  test("eligible + DRY_RUN=1 => would-exec, exits 0 without exec'ing", async () => {
    const srv = await eligibilityServer(eligible);
    try {
      const r = await runExecMode(srv.url, {
        HYDRA_PACE_GATE_DRY_RUN: "1",
        HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-should-not-appear",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-exec autopilot session/);
      assert.doesNotMatch(r.stdout, /exec-marker-should-not-appear/);
    } finally {
      srv.close();
    }
  });

  test("eligibility unreachable => fail-safe clean exit 0, does NOT exec", async () => {
    // Closed port — curl fails; the wrapper must NOT burn quota while blind.
    const r = await runExecMode("http://127.0.0.1:1/api/usage/eligibility", {
      HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-should-not-appear",
    });
    assert.equal(r.status, 0); // clean — no Restart=on-failure re-arm
    assert.match(r.stdout, /eligibility endpoint unreachable/);
    assert.doesNotMatch(r.stdout, /exec-marker-should-not-appear/);
  });

  test("operator pause => clean exit 0, does NOT exec", async () => {
    const srv = await eligibilityServer({
      ...eligible,
      allow: false,
      reasons: { ...eligible.reasons, paused: true },
    });
    try {
      const r = await runExecMode(srv.url, {
        HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-should-not-appear",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /autopilot paused \(operator\)/);
      assert.doesNotMatch(r.stdout, /exec-marker-should-not-appear/);
    } finally {
      srv.close();
    }
  });
});
