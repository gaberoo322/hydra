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
 *
 * Issue #4585 NARROWS the out-of-credits arm: Fable exhausting its weekly
 * allowance kills only Fable (Opus/Sonnet/Haiku keep working), so a generic
 * launch block idles the autopilot instead of redirecting it. The POST now
 * arms the MODEL-SCOPED exhaustion flag (`src/redis/model-exhaustion.ts`,
 * TTL = min(now+60min, next Weekly Reset Anchor boundary)) surfaced as the
 * ADVISORY `reasons.fableExhaustedUntil` — never `.allow`, never
 * `sessionBlockedUntil` (INV-3) — and the pace-gate's exec branch launches
 * the parent on the fallback model (default opus) while it is live. This
 * suite pins the accessor, the narrowing, the bus event, and the pace-gate
 * model selection.
 *
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
import {
  getModelExhaustedUntil,
  setModelExhaustedUntil,
  clearModelExhaustedUntil,
  computeModelExhaustionUntilMs,
  MODEL_EXHAUSTION_TTL_MS,
  MODEL_EXHAUSTION_TTL_BUFFER_SEC,
} from "../src/redis/model-exhaustion.ts";
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

async function cleanModelKey() {
  await redis.del(redisKeys.autopilotModelExhaustedUntil());
}

// #4585: the POST route caps the flag TTL at the Weekly Reset Anchor boundary
// read live from the env. These helpers make each narrowing test deterministic
// regardless of the ambient environment.
function withResetAnchor<T>(anchorIso: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
  if (anchorIso === undefined) delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
  else process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = anchorIso;
  return fn().finally(() => {
    if (had !== undefined) process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = had;
    else delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
  });
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

  // FLIPPED by #4585 (INV-3): this case previously pinned #4583's interim
  // behaviour — the credits line arming a generic ~30-min session block. The
  // new invariant: the credits line arms the MODEL-SCOPED exhaustion flag and
  // arms NO session block (Fable dying must not stop Opus/Sonnet/Haiku).
  test("the verbatim out-of-credits line arms the MODEL flag, NOT a session block (#4585 INV-3)", async () => {
    await cleanModelKey();
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");
      const before = Date.now();
      const res = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), res);
      assert.equal(res._status, 200);
      assert.equal(res._body.recorded, true);
      assert.equal(res._body.kind, "out-of-credits");
      // No launch block anywhere: the response carries no block instant…
      assert.equal(res._body.blockedUntilMs, null, "the 30-min block instant is discarded for this kind");
      assert.equal(res._body.blockedUntil, null);
      // …and the session-block key is NOT armed (MUST-NOT arm discharge).
      assert.equal(await getSessionBlockedUntil(), null);
      // The model-scoped flag IS armed: ~60min out (the flag TTL, not #4583's
      // 30-min block instant).
      const flag = await getModelExhaustedUntil();
      assert.ok(flag !== null, "model-exhaustion flag must be armed");
      const floor = before + MODEL_EXHAUSTION_TTL_MS - 1000;
      const ceil = Date.now() + MODEL_EXHAUSTION_TTL_MS + 1000;
      assert.ok(
        flag! >= floor && flag! <= ceil,
        `flag=${flag} expected within [${floor}, ${ceil}]`,
      );
      // The response exposes the redirect instant for the reap's echo.
      assert.equal(res._body.modelExhaustedUntilMs, flag);
      assert.equal(res._body.modelExhaustedUntil, new Date(flag!).toISOString());
    });
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

/**
 * Model-exhaustion Redis accessor (issue #4585) — the model-scoped sibling of
 * the session-block accessor above. NEW top-level describe with its own
 * beforeEach lifecycle (CLAUDE.md shared-teardown-timing pitfall): round-trip,
 * TTL, the min(now+60min, Weekly-Reset-boundary) cap (INV-4), and the
 * fail-safe-to-not-exhausted reads.
 */
describe("model-exhaustion Redis accessor (issue #4585)", () => {
  beforeEach(cleanModelKey);

  test("absent key reads as not exhausted (null)", async () => {
    assert.equal(await getModelExhaustedUntil(), null);
  });

  test("set writes the instant and a self-expiring TTL; get reads it back", async () => {
    const now = Date.now();
    const stored = await setModelExhaustedUntil(now, null);
    assert.equal(stored, now + MODEL_EXHAUSTION_TTL_MS, "no anchor => plain 60-min TTL");

    assert.equal(await getModelExhaustedUntil(now + 1000), stored);

    const ttl = await redis.ttl(redisKeys.autopilotModelExhaustedUntil());
    // TTL ~= 60min + buffer; allow small slack for the round-trip.
    const expected = MODEL_EXHAUSTION_TTL_MS / 1000 + MODEL_EXHAUSTION_TTL_BUFFER_SEC;
    assert.ok(ttl > expected - 10 && ttl <= expected + 1, `ttl=${ttl} expected≈${expected}`);
  });

  test("set caps the instant at the passed next-reset boundary (INV-4)", async () => {
    const now = Date.now();
    const nextBoundary = now + 20 * 60 * 1000; // 20min out — closer than the TTL
    const stored = await setModelExhaustedUntil(now, nextBoundary);
    assert.equal(stored, nextBoundary, "the Anchor boundary only ever SHORTENS the flag");
  });

  test("set ignores a past or invalid boundary (fail-safe to the plain TTL)", async () => {
    const now = Date.now();
    assert.equal(await setModelExhaustedUntil(now, now - 1000), now + MODEL_EXHAUSTION_TTL_MS);
    assert.equal(await setModelExhaustedUntil(now, Number.NaN), now + MODEL_EXHAUSTION_TTL_MS);
  });

  test("a past instant reads as not exhausted (self-clear guard)", async () => {
    const now = Date.now();
    // Write a raw past value directly.
    await redis.set(redisKeys.autopilotModelExhaustedUntil(), String(now - 5000));
    assert.equal(await getModelExhaustedUntil(now), null);
  });

  test("a corrupt value fails SAFE to not exhausted", async () => {
    await redis.set(redisKeys.autopilotModelExhaustedUntil(), "not-a-number");
    assert.equal(await getModelExhaustedUntil(), null);
  });

  test("clear removes the key", async () => {
    const now = Date.now();
    await setModelExhaustedUntil(now, null);
    await clearModelExhaustedUntil();
    assert.equal(await getModelExhaustedUntil(now), null);
  });

  test("computeModelExhaustionUntilMs picks min(now+TTL, boundary) — pure, no IO", () => {
    const now = 1_700_000_000_000;
    // No boundary => plain TTL.
    assert.equal(computeModelExhaustionUntilMs(now, null), now + MODEL_EXHAUSTION_TTL_MS);
    // Boundary 20min out => capped at the boundary.
    assert.equal(computeModelExhaustionUntilMs(now, now + 20 * 60 * 1000), now + 20 * 60 * 1000);
    // Boundary 3h out => the 60-min TTL wins.
    assert.equal(computeModelExhaustionUntilMs(now, now + 3 * 60 * 60 * 1000), now + MODEL_EXHAUSTION_TTL_MS);
    // Past / invalid boundaries fail safe to the plain TTL.
    assert.equal(computeModelExhaustionUntilMs(now, now - 1), now + MODEL_EXHAUSTION_TTL_MS);
    assert.equal(computeModelExhaustionUntilMs(now, Number.NaN), now + MODEL_EXHAUSTION_TTL_MS);
  });
});

/**
 * POST /api/usage/session-block — out-of-credits narrowing + bus event
 * (issue #4585). NEW top-level describe with its own lifecycle (both keys).
 */
describe("POST /api/usage/session-block — model-fallback narrowing (issue #4585)", () => {
  beforeEach(async () => {
    await cleanKey();
    await cleanModelKey();
  });

  test("the anchor caps the armed TTL: a boundary 20min out beats the 60min TTL (INV-4)", async () => {
    // Seed HYDRA_USAGE_WEEKLY_RESET_ANCHOR so the next fixed 7-day boundary
    // lands 20min from now: anchor = boundary - 7d projects forward to exactly
    // that boundary.
    const boundary = Date.now() + 20 * 60 * 1000;
    const anchorIso = new Date(boundary - 7 * 24 * 60 * 60 * 1000).toISOString();
    await withResetAnchor(anchorIso, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");
      const res = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), res);
      assert.equal(res._status, 200);
      assert.equal(res._body.recorded, true);
      const stored = res._body.modelExhaustedUntilMs as number;
      assert.ok(
        stored > Date.now() && stored <= boundary + 1000,
        `stored=${stored} must be capped at the ~20min-out boundary ${boundary}`,
      );
      assert.ok(
        stored < Date.now() + MODEL_EXHAUSTION_TTL_MS,
        "the boundary must SHORTEN the flag below the plain TTL",
      );
    });
  });

  test("an unparseable anchor fails safe to the plain 60-min TTL", async () => {
    await withResetAnchor("not-a-date", async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");
      const before = Date.now();
      const res = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), res);
      assert.equal(res._status, 200);
      assert.equal(res._body.recorded, true);
      const stored = res._body.modelExhaustedUntilMs as number;
      assert.ok(
        stored >= before + MODEL_EXHAUSTION_TTL_MS - 1000 &&
          stored <= Date.now() + MODEL_EXHAUSTION_TTL_MS + 1000,
        `stored=${stored} expected ≈ now+60min`,
      );
    });
  });

  test("a session-limit line still arms the session block (narrowing touches ONLY out-of-credits)", async () => {
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");
      const res = mockRes();
      await post!(mockReq({ line: "You've hit your session limit · resets 11:59pm (UTC)" }), res);
      assert.equal(res._status, 200);
      assert.equal(res._body.recorded, true);
      assert.equal(res._body.kind, "session-limit");
      assert.ok((await getSessionBlockedUntil()) !== null);
      assert.equal(await getModelExhaustedUntil(), null, "no model flag on a session-limit line");
    });
  });

  test("a crash-streak pre-parsed block still arms the session block (#4583 backstop unchanged)", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/session-block");
    const res = mockRes();
    await post!(mockReq({ blockedUntilMs: future, reason: "crash-streak" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.kind, "crash-streak");
    assert.ok((await getSessionBlockedUntil()) !== null);
    assert.equal(await getModelExhaustedUntil(), null);
  });
});

/**
 * Hard-blocker fix (QA review on PR #4644, issue #4585): a REPEAT
 * out-of-credits exit while the model-exhaustion flag is ALREADY live means
 * the fallback model this flag redirected onto has ALSO just run out of
 * credits — re-arming the same flag again would just resend the parent onto
 * the model that just failed, reproducing the #4583 unbounded-relaunch storm
 * one level up (bootstrap.sh's crash-streak backstop can never reach this:
 * it is gated off whenever a recognised exhaustion line matches). This suite
 * pins the fall-through to the session block instead. NEW top-level describe
 * with its own lifecycle (both keys) per the CLAUDE.md shared-teardown rule.
 *
 * QA RE-REVIEW hard-blocker fix (PR #4644, issue #4585): a repeat is now
 * additionally gated on `model` naming a model OTHER than the primary
 * (`fable`) — see the false-positive suite below. The three tests here that
 * assert the genuine-repeat path now POST `model: "opus"` on the second
 * request to supply that confirmation.
 */
describe("POST /api/usage/session-block — out-of-credits repeat while flag is live (#4585 hard-blocker fix)", () => {
  beforeEach(async () => {
    await cleanKey();
    await cleanModelKey();
  });

  test("a repeat out-of-credits line naming the fallback model while the flag is live arms the session block, not the model flag again", async () => {
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");

      // First out-of-credits exit: arms the model flag as before (the
      // pre-existing redirect behaviour, unchanged).
      const first = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), first);
      assert.equal(first._body.kind, "out-of-credits");
      assert.equal(first._body.blockedUntil, null, "first arm redirects — no launch block");
      assert.ok((await getModelExhaustedUntil()) !== null, "model flag armed on first exit");

      // Second out-of-credits exit while the flag is STILL live, reported as
      // having come from the FALLBACK model (opus): the fallback model also
      // failed — must arm a session block instead of re-arming the model
      // flag.
      const second = mockRes();
      await post!(mockReq({ line: CREDITS_LINE, model: "opus" }), second);
      assert.equal(second._status, 200);
      assert.equal(second._body.recorded, true);
      assert.equal(second._body.kind, "out-of-credits");
      assert.ok(second._body.blockedUntil !== null, "repeat must arm a session block");
      assert.equal(second._body.modelExhaustedUntil, null, "repeat response carries no model-flag instant");

      const sessionBlock = await getSessionBlockedUntil();
      assert.ok(sessionBlock !== null, "session block is armed");
      assert.ok(
        sessionBlock! >= Date.now() + CREDITS_EXHAUSTED_BLOCK_MS - 2000 &&
          sessionBlock! <= Date.now() + CREDITS_EXHAUSTED_BLOCK_MS + 2000,
        `repeat should use the classifier's fixed 30-min duration, got ${sessionBlock}`,
      );
    });
  });

  test("an out-of-credits line after the model flag has already expired is NOT treated as a repeat", async () => {
    await withResetAnchor(undefined, async () => {
      // Simulate a naturally-expired flag (past instant) rather than a
      // never-armed one, so this exercises the read-side past-instant guard
      // too, not just the absent-key case the "first exit" test already
      // covers.
      await redis.set(redisKeys.autopilotModelExhaustedUntil(), String(Date.now() - 5000));
      assert.equal(await getModelExhaustedUntil(), null, "precondition: flag reads as expired");

      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");
      const res = mockRes();
      // Even naming the fallback model here must not matter — the flag is
      // already expired, so there is nothing to be "a repeat" of.
      await post!(mockReq({ line: CREDITS_LINE, model: "opus" }), res);
      assert.equal(res._body.kind, "out-of-credits");
      assert.ok(res._body.modelExhaustedUntil !== null, "re-arms the model flag, not a session block");
      assert.equal(res._body.blockedUntil, null, "no session block armed on a non-repeat arm");
      assert.equal(await getSessionBlockedUntil(), null);
    });
  });

  test("the repeat publishes a bus event distinguishable from the redirect event", async () => {
    await withResetAnchor(undefined, async () => {
      const publishes: Array<{ stream: string; evt: any }> = [];
      const bus = {
        publish: async (stream: string, evt: any) => {
          publishes.push({ stream, evt });
        },
      };
      const router = createUsageRouter(bus);
      const post = findHandler(router, "POST", "/usage/session-block");
      await post!(mockReq({ line: CREDITS_LINE }), mockRes());
      await post!(mockReq({ line: CREDITS_LINE, model: "opus" }), mockRes());

      assert.equal(publishes.length, 2);
      assert.equal(publishes[0].evt.payload.reason, "out-of-credits");
      assert.equal(publishes[1].evt.payload.reason, "out-of-credits-repeat");
      assert.equal(publishes[1].evt.payload.to, "session-block");
    });
  });
});

/**
 * QA RE-REVIEW hard-blocker fix (PR #4644, issue #4585): the prior
 * forward-fix (suite above) detected "repeat" PURELY TEMPORALLY —
 * `getModelExhaustedUntil()` being live at POST time — with no way to tell
 * apart a genuine fallback-model death from an ORDINARY BURST of
 * independent, still-Fable-routed dispatch failures arriving while the
 * redirect flag is already live (the normal concurrent-dispatch case; the
 * approved design-concept artifact's own qaTrace is a live reproduction).
 * That false positive armed a session block and halted Opus launches too,
 * violating INV-3 one level up. This suite pins the fix: a repeat POST is
 * only eligible for the session-block branch when `model` explicitly names a
 * model OTHER than the primary (`fable`) — an absent `model` or one naming
 * the primary itself must be a no-op (falls through to re-arming the
 * redirect flag, which is already doing its job). NEW top-level describe
 * with its own lifecycle per the CLAUDE.md shared-teardown rule.
 */
describe("POST /api/usage/session-block — out-of-credits burst false-positive (#4585 QA re-review fix)", () => {
  beforeEach(async () => {
    await cleanKey();
    await cleanModelKey();
  });

  test("a second out-of-credits POST with NO `model` field while the flag is live must NOT arm a session block", async () => {
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");

      await post!(mockReq({ line: CREDITS_LINE }), mockRes());
      assert.ok((await getModelExhaustedUntil()) !== null, "model flag armed on first exit");

      // A second, independent still-Fable dispatch dies while the flag is
      // already live. It carries no `model` field (an un-upgraded caller, or
      // a caller that genuinely cannot attribute the line) — this must be
      // treated as "the redirect is already doing its job", NOT a confirmed
      // fallback death.
      const second = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), second);
      assert.equal(second._body.blockedUntil, null,
        "an unconfirmed repeat must NEVER arm a session block (INV-3)");
      assert.ok(second._body.modelExhaustedUntil !== null,
        "an unconfirmed repeat re-arms the redirect flag instead");
      assert.equal(await getSessionBlockedUntil(), null,
        "Opus launches must stay eligible — a still-Fable burst must never halt them");
    });
  });

  test("a second out-of-credits POST naming the PRIMARY model (fable) while the flag is live must NOT arm a session block", async () => {
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");

      await post!(mockReq({ line: CREDITS_LINE, model: "fable" }), mockRes());
      assert.ok((await getModelExhaustedUntil()) !== null, "model flag armed on first exit");

      // A second Fable-routed dispatch reports its own death explicitly as
      // `model: "fable"` — the SAME model the flag already redirects off of.
      // This is exactly the false-positive burst QA found: it must be a
      // no-op on the launch-block front, not an escalation.
      const second = mockRes();
      await post!(mockReq({ line: CREDITS_LINE, model: "fable" }), second);
      assert.equal(second._body.blockedUntil, null,
        "a still-Fable report must NEVER arm a session block (INV-3)");
      assert.equal(await getSessionBlockedUntil(), null,
        "Opus launches must stay eligible — a still-Fable report must never halt them");
    });
  });

  test("a second out-of-credits POST naming a NON-primary model while the flag is live IS treated as a confirmed repeat", async () => {
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");

      await post!(mockReq({ line: CREDITS_LINE }), mockRes());
      assert.ok((await getModelExhaustedUntil()) !== null, "model flag armed on first exit");

      const second = mockRes();
      await post!(mockReq({ line: CREDITS_LINE, model: "opus" }), second);
      assert.ok(second._body.blockedUntil !== null,
        "a report explicitly naming the fallback model IS a confirmed repeat — must arm the session block");
    });
  });
});

/**
 * The INV-7 event half: the arming switch is visible on the bus
 * (hydra:notifications, type model-fallback) for the out-of-credits kind ONLY.
 */
describe("POST /api/usage/session-block — model-fallback bus event (issue #4585 INV-7)", () => {
  beforeEach(async () => {
    await cleanKey();
    await cleanModelKey();
  });

  function capturingBus() {
    const publishes: Array<{ stream: string; evt: any }> = [];
    const bus = {
      publish: async (stream: string, evt: any) => {
        publishes.push({ stream, evt });
      },
    };
    return { bus, publishes };
  }

  test("the credits line publishes ONE model-fallback event on the notifications stream", async () => {
    await withResetAnchor(undefined, async () => {
      const { bus, publishes } = capturingBus();
      const router = createUsageRouter(bus);
      const post = findHandler(router, "POST", "/usage/session-block");
      const res = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), res);
      assert.equal(res._status, 200);
      assert.equal(publishes.length, 1);
      assert.equal(publishes[0].stream, "hydra:notifications");
      assert.equal(publishes[0].evt.type, "model-fallback");
      assert.equal(publishes[0].evt.source, "api/usage/session-block");
      assert.equal(publishes[0].evt.payload.from, "fable");
      assert.equal(publishes[0].evt.payload.to, "opus");
      assert.equal(publishes[0].evt.payload.reason, "out-of-credits");
      assert.equal(publishes[0].evt.payload.until, res._body.modelExhaustedUntil);
    });
  });

  test("a session-limit line publishes NO model-fallback event", async () => {
    const { bus, publishes } = capturingBus();
    const router = createUsageRouter(bus);
    const post = findHandler(router, "POST", "/usage/session-block");
    const res = mockRes();
    await post!(mockReq({ line: "You've hit your session limit · resets 11:59pm (UTC)" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.kind, "session-limit");
    assert.equal(publishes.length, 0);
  });

  test("a bus whose publish rejects does NOT fail the POST (best-effort; the flag is the source of truth)", async () => {
    await withResetAnchor(undefined, async () => {
      const bus = {
        publish: async () => {
          throw new Error("bus-down");
        },
      };
      const router = createUsageRouter(bus);
      const post = findHandler(router, "POST", "/usage/session-block");
      const res = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), res);
      assert.equal(res._status, 200);
      assert.equal(res._body.recorded, true);
      assert.ok((await getModelExhaustedUntil()) !== null);
    });
  });

  test("no bus at all (router constructed bare) still arms the flag", async () => {
    await withResetAnchor(undefined, async () => {
      const router = createUsageRouter();
      const post = findHandler(router, "POST", "/usage/session-block");
      const res = mockRes();
      await post!(mockReq({ line: CREDITS_LINE }), res);
      assert.equal(res._status, 200);
      assert.equal(res._body.recorded, true);
      assert.ok((await getModelExhaustedUntil()) !== null);
    });
  });
});
