/**
 * Regression tests for the composed-verdict (.allow) admission check in
 * pace-gate.sh (issue #1790).
 *
 * Observed live on 2026-06-12 (run d4a6af2a): /api/usage/eligibility returned
 * allow:false with reasons.weeklyEmergencyStop:true, but pace-gate.sh only
 * read paused / sessionBlockedUntil / emergencyStop / paceState — so every
 * ~15-min tick launched a full autopilot session that immediately hard-stopped
 * in decide.py, a relaunch churn loop lasting until the weekly reset.
 *
 * This suite pins:
 *   - weeklyEmergencyStop:true => skip with a reason-specific log line;
 *   - allow:false with NO specific reason set => the catch-all arm skips and
 *     logs the raw .reasons JSON (future-reason drift protection);
 *   - allow:true + paceState:"behind" => the eligible path is unchanged;
 *   - a missing .allow => fail safe (no launch) — and in particular the fix
 *     must NOT use jq's `.allow // true`, which treats false as falsy and
 *     would silently invert the check;
 *   - exec mode (--exec-autopilot, the unit's ExecStart wrapper) honors
 *     allow:false with a CLEAN exit 0 so Restart=on-failure disarms.
 *
 * The composed-verdict suite above is a pure shell test: eligibilityServer
 * fixture + spawn, no Redis needed. A second, Redis-gated suite below (issue
 * #4210) additionally pins that record_tick()'s HSET honors HYDRA_REDIS_DB.
 * Two more suites pin the exec-mode launch-model fallback (issue #4585): the
 * would-exec --model spelling under a live/past/absent fableExhaustedUntil
 * flag (INV-1/INV-2/INV-8), and — Redis-gated — the last-tick model record +
 * the opus->fable reason=flag-expired return transition (INV-7).
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getRedisConnection } from "../src/redis/connection.ts";
import { WATCHDOG_REDIS_TIMEOUT_MS } from "./_helpers/watchdog-timeouts.mts";

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

function runPaceGate(
  eligibilityUrl: string,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [PACE_GATE, ...args], {
      env: {
        ...process.env,
        HYDRA_PACE_GATE_FORCE_SERVICE_INACTIVE: "1",
        HYDRA_PACE_GATE_DRY_RUN: "1",
        HYDRA_PACE_GATE_ELIGIBILITY_URL: eligibilityUrl,
        HYDRA_AUTOPILOT_STATE: "/tmp/hydra-pace-gate-allow-nonexistent.json",
        ...extraEnv,
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
  });
}

const baseReasons = {
  emergencyStop: false,
  weeklyEmergencyStop: false,
  pacingShed: false,
  calibrated: true,
  paused: false,
  sessionBlockedUntil: null as string | null,
  worklessUntil: null as string | null,
  // Issue #4585: the model-scoped exhaustion redirect (advisory — never flips
  // .allow; consumed by the exec branch's launch-model selection).
  fableExhaustedUntil: null as string | null,
};

/**
 * Issue #4560: the paid-overage arm keys off `reasons.extraUsageBlocking`, not
 * the raw `extraUsageArmed` fact, so a route running under
 * `HYDRA_EXTRA_USAGE_POLICY=allow` (armed:true, blocking:false, allow:true)
 * launches, while the default policy (blocking:true, allow:false) still skips
 * with the operator-action message. A legacy route that folds armed into
 * `.allow` without the new field is caught by the #1790 catch-all.
 */
describe("pace-gate.sh paid-overage arm keys off extraUsageBlocking (issue #4560)", () => {
  test("armed + blocking (policy=block) => reason-specific skip naming the policy, no launch", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, extraUsageArmed: true, extraUsageBlocking: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /HYDRA_EXTRA_USAGE_POLICY=block/);
      assert.match(r.stdout, /will NOT clear by itself/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("armed + NOT blocking (policy=allow, allow:true) => informational line, then launch", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons, extraUsageArmed: true, extraUsageBlocking: false },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /HYDRA_EXTRA_USAGE_POLICY=allow — proceeding/);
      assert.match(r.stdout, /would-start/, "the armed fact alone must not veto the launch");
      assert.doesNotMatch(r.stdout, /skip/);
    } finally {
      srv.close();
    }
  });

  test("legacy route: armed folded into allow:false with NO extraUsageBlocking field => catch-all skip, never a launch", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, extraUsageArmed: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /allow=false — skip/);
      assert.doesNotMatch(r.stdout, /would-start/);
      assert.doesNotMatch(r.stdout, /proceeding/, "the informational line sits after the catch-all on purpose");
    } finally {
      srv.close();
    }
  });
});

describe("pace-gate.sh composed-verdict admission (issue #1790)", () => {
  test("weeklyEmergencyStop:true (allow:false, paceState:behind) => skip with reason-specific log, no launch", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, weeklyEmergencyStop: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /weekly emergencyStop/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("allow:false with NO specific reason set => catch-all skip logging the raw reasons JSON", async () => {
    // Simulates a FUTURE reason added to projectEligibility() that this
    // script has never heard of — the drift mode that caused #1790.
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, someFutureReason: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /eligibility allow=false/);
      assert.match(r.stdout, /someFutureReason/); // raw .reasons JSON in the log
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("allow:true + paceState:behind => eligible path unchanged (would-start)", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("missing .allow => fail safe (no launch) — guards against the jq `// true` inversion", async () => {
    // jq's `//` operator treats false as falsy: `.allow // true` would read
    // allow:false as eligible. The script must use bare `.allow` with strict
    // string matching, so a MISSING field ("null") fails safe, not eligible.
    const srv = await eligibilityServer({
      shed: [],
      reasons: { ...baseReasons },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /\.allow missing or non-boolean/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("exec mode (--exec-autopilot) + allow:false => clean exit 0, does NOT exec", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, weeklyEmergencyStop: true },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        HYDRA_PACE_GATE_EXEC_CMD: "echo exec-marker-should-not-appear",
      });
      assert.equal(r.status, 0); // CLEAN exit — Restart=on-failure must disarm
      assert.match(r.stdout, /weekly emergencyStop/);
      assert.doesNotMatch(r.stdout, /would-exec/);
      assert.doesNotMatch(r.stdout, /exec-marker-should-not-appear/);
    } finally {
      srv.close();
    }
  });

  test("exec mode eligible branch exports HYDRA_AUTOPILOT_TRIGGER=pace-gate to the exec'd command (issue #2955)", async () => {
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        // The runPaceGate fixture defaults DRY_RUN=1, whose early-exit
        // precedes the EXEC_CMD hook — override to 0 so the hook execs.
        HYDRA_PACE_GATE_DRY_RUN: "0",
        // EXEC_CMD is intentionally word-split with NO quote re-parsing, so
        // keep it to plain words (`sh -c '...'` would shatter). printenv
        // observes exactly what the exec'd claude CLI would inherit.
        HYDRA_PACE_GATE_EXEC_CMD: "printenv HYDRA_AUTOPILOT_TRIGGER",
        // Prove the SCRIPT stamps the value (not env inheritance): seed a
        // decoy that the eligible branch's export must overwrite.
        HYDRA_AUTOPILOT_TRIGGER: "decoy-not-from-gate",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^pace-gate$/m);
      assert.doesNotMatch(r.stdout, /decoy-not-from-gate/);
    } finally {
      srv.close();
    }
  });

  test("workless-board hint in the FUTURE => skip (no launch), NOT flipping allow (#2956)", async () => {
    // allow stays TRUE (the workless hint is launcher-only advisory, never a
    // hard stop) but the future worklessUntil must still skip the launch.
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons, worklessUntil: future },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /workless-board backoff/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("workless-board hint in the PAST => launch normally (self-heals) (#2956)", async () => {
    // A stale hint (past instant) must fall through to launch — the belt-and-
    // braces read-side guard that pairs with the Redis TTL self-clear.
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const srv = await eligibilityServer({
      allow: true,
      shed: [],
      reasons: { ...baseReasons, worklessUntil: past },
      paceState: "behind",
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
      assert.doesNotMatch(r.stdout, /workless-board backoff/);
    } finally {
      srv.close();
    }
  });

  test("exec mode ineligible exit does NOT reach the trigger export (issue #2955)", async () => {
    const srv = await eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, weeklyEmergencyStop: true },
      paceState: "behind",
    });
    try {
      // DRY_RUN=0 + a printenv EXEC_CMD: if the ineligible path ever fell
      // through to the export+exec, "pace-gate" would appear on stdout.
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        HYDRA_PACE_GATE_DRY_RUN: "0",
        HYDRA_PACE_GATE_EXEC_CMD: "printenv HYDRA_AUTOPILOT_TRIGGER",
      });
      assert.equal(r.status, 0); // still the clean skip exit
      assert.doesNotMatch(r.stdout, /^pace-gate$/m);
    } finally {
      srv.close();
    }
  });
});

/**
 * record_tick()'s HYDRA_REDIS_DB threading (issue #4210, mirroring #4183's
 * fix for scripts/hydra-watchdog.sh). Every other pace-gate.sh dependency
 * fails SAFE by skipping the launch; the redis-cli write is uniquely
 * best-effort (`|| true`), so a failed write must never fail this suite —
 * these cases read state back through the SAME docker `hydra-redis-1`
 * container the write targets, using the isolated per-run DB
 * `scripts/test/redis-db-launch.mjs` already assigns this test run via
 * REDIS_URL (never db 0/production; see that launcher's module doc).
 *
 * New TOP-LEVEL describe (not nested in the suite above) with its own
 * before/after — the composed-verdict suite above owns no Redis lifecycle to
 * piggyback on, and this one needs its own clean-slate/teardown around the
 * shared `hydra:autopilot:pace-gate:last-tick` key.
 */
function dockerRedisAvailable(): boolean {
  const r = spawnSync("docker", ["exec", "hydra-redis-1", "redis-cli", "PING"], {
    encoding: "utf-8",
    timeout: WATCHDOG_REDIS_TIMEOUT_MS,
  });
  return (r.stdout ?? "").trim() === "PONG";
}

const DOCKER = dockerRedisAvailable();
const LAST_TICK_KEY = "hydra:autopilot:pace-gate:last-tick";

/**
 * The DB index this test run's OWN isolated Redis connection uses (derived by
 * scripts/test/redis-db-launch.mjs into REDIS_URL's child env — always inside
 * 8..15 in a real `npm test`/`npm run test:file` run, never 0/production).
 * `null` when REDIS_URL is absent or resolves to db 0 (e.g. a raw
 * `node --test` invocation outside the launcher) — the cases below skip
 * rather than risk probing production db 0.
 */
function ownedTestDb(): number | null {
  const raw = process.env.REDIS_URL;
  if (!raw) return null;
  let db: number;
  try {
    db = Number(new URL(raw).pathname.replace(/^\//, "") || "0");
  } catch {
    return null;
  }
  return Number.isInteger(db) && db > 0 ? db : null;
}

const TEST_DB = ownedTestDb();
const REDIS_GATED = DOCKER && TEST_DB !== null;

describe("pace-gate.sh record_tick() honors HYDRA_REDIS_DB (issue #4210)", () => {
  after(async () => {
    if (!REDIS_GATED) return;
    // Leave nothing behind on the isolated test DB — production-shaped key
    // name, so a leftover value is indistinguishable from real state to
    // whatever runs next on this DB.
    await getRedisConnection().del(LAST_TICK_KEY);
  });

  test(
    "a write with HYDRA_REDIS_DB set lands on that DB, readable back via the same key",
    { skip: !REDIS_GATED },
    async () => {
      const conn = getRedisConnection();
      await conn.del(LAST_TICK_KEY);

      const srv = await eligibilityServer({
        allow: true,
        shed: [],
        reasons: { ...baseReasons, paused: true },
        paceState: "behind",
      });
      try {
        const r = await runPaceGate(srv.url, [], { HYDRA_REDIS_DB: String(TEST_DB) });
        assert.equal(r.status, 0);
      } finally {
        srv.close();
      }

      const fields = await conn.hgetall(LAST_TICK_KEY);
      assert.equal(
        fields.reason,
        "paused",
        "record_tick's HSET must land on the DB named by HYDRA_REDIS_DB, readable back through the same connection",
      );
    },
  );

  test(
    "a non-numeric HYDRA_REDIS_DB does NOT get passed through to redis-cli verbatim (falls back to db 0)",
    { skip: !REDIS_GATED },
    async () => {
      const conn = getRedisConnection();
      await conn.del(LAST_TICK_KEY);

      const srv = await eligibilityServer({
        allow: true,
        shed: [],
        reasons: { ...baseReasons, paused: true },
        paceState: "behind",
      });
      try {
        // A garbage value must not reach `-n` verbatim (redis-cli would then
        // error out on a non-integer index, and `|| true` would swallow
        // that as silently as any other write failure — this proves the
        // validation actually reroutes to db 0 rather than merely "not
        // crashing").
        const r = await runPaceGate(srv.url, [], { HYDRA_REDIS_DB: "not-a-number" });
        assert.equal(r.status, 0);
      } finally {
        srv.close();
      }

      const fields = await conn.hgetall(LAST_TICK_KEY);
      assert.deepEqual(
        fields,
        {},
        "a non-numeric HYDRA_REDIS_DB must default to db 0 (production), never land on this test's isolated DB",
      );
    },
  );
});

/**
 * Exec-mode launch-model selection (issue #4585) — INV-2/INV-1/INV-8.
 *
 * While `.reasons.fableExhaustedUntil` is FUTURE the exec branch launches on
 * the FALLBACK model with an EXPLICIT `--model` (INV-2); the CLI's own
 * `--fallback-model` is NOT the mechanism for the credits 429 (INV-1 —
 * empirically falsified on CLI 2.1.280), so the flag-live exec line carries NO
 * `--fallback-model` at all (identical launch/fallback values have no defined
 * CLI behaviour). Absent/past/unparseable flag → fail-safe to the PRIMARY,
 * with `--fallback-model` riding along belt-and-braces for overload /
 * model-access errors only. The would-exec DRY_RUN line is the pin surface
 * (INV-8 explicitly blesses it; the EXEC_CMD hook's contract is unchanged).
 *
 * HYDRA_REDIS_HOST points at an unreachable direct host so read_last_tick_model
 * deterministically reads "" (no previous model) regardless of what the shared
 * docker Redis happens to hold — the transition-line assertions below then
 * depend only on the eligibility fixture.
 */
describe("pace-gate.sh exec-mode launch-model selection (issue #4585)", () => {
  const NO_REDIS_ENV = {
    HYDRA_REDIS_HOST: "127.0.0.1",
    HYDRA_REDIS_PORT: "9", // closed port — connection refused instantly
  };

  function runExecDry(
    eligibilityUrl: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [PACE_GATE, "--exec-autopilot"], {
        env: {
          ...process.env,
          HYDRA_PACE_GATE_ELIGIBILITY_URL: eligibilityUrl,
          HYDRA_AUTOPILOT_STATE: "/tmp/hydra-pace-gate-allow-nonexistent.json",
          HYDRA_PACE_GATE_DRY_RUN: "1",
          ...NO_REDIS_ENV,
          ...extraEnv,
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ status: code ?? -1, stdout }));
    });
  }

  const eligible = (fableExhaustedUntil: string | null) => ({
    allow: true,
    shed: [],
    reasons: { ...baseReasons, fableExhaustedUntil },
    paceState: "behind",
  });

  test("flag LIVE => would-exec names --model opus and NO --fallback-model (INV-1/INV-2)", async () => {
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const srv = await eligibilityServer(eligible(future));
    try {
      const r = await runExecDry(srv.url);
      assert.equal(r.status, 0);
      // The redirect rides the EXPLICIT --model (INV-2)…
      assert.match(
        r.stdout,
        /would-exec autopilot session: claude --dangerously-skip-permissions --model opus -p \/hydra-autopilot/,
      );
      // …NOT the CLI's own --fallback-model (INV-1: that flag does not catch
      // the credits 429; identical values also have no defined CLI behaviour).
      assert.doesNotMatch(r.stdout, /--fallback-model/);
      assert.match(r.stdout, /model-fallback: fable->opus reason=out-of-credits/);
    } finally {
      srv.close();
    }
  });

  test("flag ABSENT => would-exec names --model fable --fallback-model opus (belt-and-braces)", async () => {
    const srv = await eligibilityServer(eligible(null));
    try {
      const r = await runExecDry(srv.url);
      assert.equal(r.status, 0);
      assert.match(
        r.stdout,
        /would-exec autopilot session: claude --dangerously-skip-permissions --model fable --fallback-model opus -p \/hydra-autopilot/,
      );
      // No switch happened — no transition line.
      assert.doesNotMatch(r.stdout, /model-fallback:/);
    } finally {
      srv.close();
    }
  });

  test("flag PAST => fail-safe to the primary model", async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const srv = await eligibilityServer(eligible(past));
    try {
      const r = await runExecDry(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /--model fable --fallback-model opus/);
      assert.doesNotMatch(r.stdout, /reason=out-of-credits/);
    } finally {
      srv.close();
    }
  });

  test("flag UNPARSEABLE => fail-safe to the primary model", async () => {
    const srv = await eligibilityServer(eligible("not-a-date"));
    try {
      const r = await runExecDry(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /--model fable --fallback-model opus/);
      assert.doesNotMatch(r.stdout, /reason=out-of-credits/);
    } finally {
      srv.close();
    }
  });

  test("HYDRA_AUTOPILOT_PRIMARY_MODEL / HYDRA_AUTOPILOT_FALLBACK_MODEL env overrides are honoured", async () => {
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const live = await eligibilityServer(eligible(future));
    const clear = await eligibilityServer(eligible(null));
    try {
      const env = {
        HYDRA_AUTOPILOT_PRIMARY_MODEL: "pri-test",
        HYDRA_AUTOPILOT_FALLBACK_MODEL: "fbk-test",
      };
      const liveRun = await runExecDry(live.url, env);
      assert.equal(liveRun.status, 0);
      assert.match(liveRun.stdout, /--model fbk-test -p/);
      assert.doesNotMatch(liveRun.stdout, /--fallback-model/, "identical values must not double-pass the flag");

      const clearRun = await runExecDry(clear.url, env);
      assert.equal(clearRun.status, 0);
      assert.match(clearRun.stdout, /--model pri-test --fallback-model fbk-test -p/);
    } finally {
      live.close();
      clear.close();
    }
  });
});

/**
 * The durable half of INV-7/INV-8 (Redis-gated, same DOCKER + TEST_DB rails as
 * the #4210 suite above): the launch tick RECORDS the model it launched on,
 * and the return-to-primary tick logs `reason=flag-expired` off the previous
 * tick's recorded model. Own before/after lifecycle around the shared
 * last-tick key (never piggybacks on a sibling suite's teardown).
 */
describe("pace-gate.sh model fallback — last-tick model record + return-to-primary (issue #4585)", () => {
  after(async () => {
    if (!REDIS_GATED) return;
    await getRedisConnection().del(LAST_TICK_KEY);
  });

  test(
    "a flag-LIVE exec tick records model=opus in the last-tick hash (INV-7)",
    { skip: !REDIS_GATED },
    async () => {
      const conn = getRedisConnection();
      await conn.del(LAST_TICK_KEY);

      const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const srv = await eligibilityServer({
        allow: true,
        shed: [],
        reasons: { ...baseReasons, fableExhaustedUntil: future },
        paceState: "behind",
      });
      try {
        const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
          HYDRA_REDIS_DB: String(TEST_DB),
        });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /would-exec autopilot session/);
      } finally {
        srv.close();
      }

      assert.equal(
        await conn.hget(LAST_TICK_KEY, "model"),
        "opus",
        "the tick must record the model the session actually launched on",
      );
      assert.equal(await conn.hget(LAST_TICK_KEY, "reason"), "eligible-exec");
    },
  );

  test(
    "previous tick on opus + expired flag => opus->fable reason=flag-expired line, model=fable recorded",
    { skip: !REDIS_GATED },
    async () => {
      const conn = getRedisConnection();
      await conn.del(LAST_TICK_KEY);
      await conn.hset(LAST_TICK_KEY, "model", "opus");

      const past = new Date(Date.now() - 60 * 1000).toISOString();
      const srv = await eligibilityServer({
        allow: true,
        shed: [],
        reasons: { ...baseReasons, fableExhaustedUntil: past },
        paceState: "behind",
      });
      try {
        const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
          HYDRA_REDIS_DB: String(TEST_DB),
        });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /model-fallback: opus->fable reason=flag-expired/);
        assert.match(r.stdout, /--model fable --fallback-model opus/);
      } finally {
        srv.close();
      }

      assert.equal(await conn.hget(LAST_TICK_KEY, "model"), "fable");
    },
  );
});
