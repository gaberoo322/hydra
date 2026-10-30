/**
 * Transport tests for pace-gate.sh (issues #1790, #5102).
 *
 * Since #5102 the script holds NO admission policy: it forwards the launcher
 * facts (mode / serviceActive / pidAlive) to GET /api/usage/eligibility, reads
 * the typed `.admission` verdict (decideAdmission, src/cost/admission.ts), and
 * either records the reason verbatim and exits 0 or launches. The policy cases
 * (every ladder arm and its ordering) live in test/admission.test.mts. This
 * suite pins unreachable/unparseable/malformed fail-safes, the ctx echo, admit
 * -> launch, and skip pass-through, against a fixture server that computes the
 * real verdict with the real EligibilityQuerySchema + decideAdmission.
 *
 * The transport suites above are pure shell tests: eligibilityServer
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
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { getRedisConnection } from "../src/redis/connection.ts";
import { decideAdmission } from "../src/cost/index.ts";
import { EligibilityQuerySchema } from "../src/schemas/usage.ts";
import { WATCHDOG_REDIS_TIMEOUT_MS } from "./_helpers/watchdog-timeouts.mts";

// Issue #4966: the spawn helpers below pass `...process.env` through to
// pace-gate.sh, and the model-fallback suites pin the script's DEFAULT launch
// pair (fable -> opus). A dispatch running under the #4839 Sonnet-parent
// trial inherits HYDRA_AUTOPILOT_PRIMARY_MODEL=sonnet from the host's systemd
// drop-in, flipping every default-pair assertion (6 not-ok worktree-local
// while CI's fresh runner env stays green). Pin the default pair explicitly in
// each model-sensitive helper's env — spread AFTER `...process.env` and
// BEFORE the per-call extraEnv, so the explicit-override case
// (pri-test/fbk-test via runExecDry's extraEnv) still wins.
const DEFAULT_MODEL_PAIR_ENV = {
  HYDRA_AUTOPILOT_PRIMARY_MODEL: "fable",
  HYDRA_AUTOPILOT_FALLBACK_MODEL: "opus",
};

const PACE_GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "autopilot",
  "pace-gate.sh",
);

/**
 * Serve the eligibility route on an ephemeral port (#5102 INV-10). Mirrors the
 * real route: every request's query is parsed through the real
 * EligibilityQuerySchema and the body is `{ ...payload, admission:
 * decideAdmission(payload, ctx) }`, so pace-gate.sh is tested against the
 * production verdict, not a hand-written one. `opts.admission` overrides the
 * field (an explicit object, or `null` to omit it). `lastUrl()` exposes the
 * last request URL for assertions.
 */
function eligibilityServer(
  payload: unknown,
  opts: { admission?: unknown } = {},
): Promise<{ url: string; close: () => void; lastUrl: () => string }> {
  return new Promise((resolve) => {
    let last = "";
    const server = http.createServer((req, res) => {
      last = req.url ?? "";
      const q = EligibilityQuerySchema.parse(
        Object.fromEntries(new URL(last, "http://x").searchParams),
      );
      const body: Record<string, unknown> = { ...(payload as object) };
      if (opts.admission === undefined) {
        body.admission = decideAdmission(payload as any, { nowMs: Date.now(), ...q });
      } else if (opts.admission !== null) {
        body.admission = opts.admission;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}/api/usage/eligibility`,
        close: () => server.close(),
        lastUrl: () => last,
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
        ...DEFAULT_MODEL_PAIR_ENV,
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
  // Issue #4836: launcher-only admission signals (never flip .allow).
  fiveHourThrottleShed: false,
  postQuotaUntil: null as string | null,
  // Issue #4585: the model-scoped exhaustion redirect (advisory — never flips
  // .allow; consumed by the exec branch's launch-model selection).
  fableExhaustedUntil: null as string | null,
};

const eligiblePayload = (reasons: Record<string, unknown> = {}) => ({
  allow: true,
  shed: [],
  reasons: { ...baseReasons, ...reasons },
  paceState: "behind",
});

/**
 * pace-gate.sh is transport + exec only (#5102): admission policy lives in
 * decideAdmission (test/admission.test.mts). These cases pin the transport —
 * fail-safes, the ctx echo, pass-through of the typed reason, and launch.
 */
describe("pace-gate.sh transport: fail-safes (issue #5102)", () => {
  test("unreachable endpoint => eligibility-unreachable, no launch", async () => {
    const r = await runPaceGate("http://127.0.0.1:9/api/usage/eligibility");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /eligibility endpoint unreachable/);
    assert.doesNotMatch(r.stdout, /would-start/);
  });

  test("non-JSON body => eligibility-unparseable, no launch", async () => {
    const server = http.createServer((_req, res) => res.end("<html>not json"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}/x`;
      const r = await runPaceGate(url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /unparseable/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      server.close();
    }
  });

  test(".admission omitted => allow-invalid, no launch", async () => {
    const srv = await eligibilityServer(eligiblePayload(), { admission: null });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /\.admission missing or malformed/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("non-boolean admit => allow-invalid, no launch (guards a truthy-string launch)", async () => {
    const srv = await eligibilityServer(eligiblePayload(), {
      admission: { admit: "true", reason: "eligible-launch", class: "launch", note: null },
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /malformed/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });
});

describe("pace-gate.sh transport: ctx echo (issue #5102)", () => {
  test("--exec-autopilot sends mode=exec and serviceActive=0", async () => {
    const srv = await eligibilityServer(eligiblePayload());
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"]);
      assert.equal(r.status, 0);
      assert.match(srv.lastUrl(), /mode=exec&serviceActive=0&pidAlive=0/);
    } finally {
      srv.close();
    }
  });

  test("timer mode sends mode=timer", async () => {
    const srv = await eligibilityServer(eligiblePayload());
    try {
      await runPaceGate(srv.url);
      assert.match(srv.lastUrl(), /mode=timer&serviceActive=0&pidAlive=0/);
    } finally {
      srv.close();
    }
  });

  test("a state.json carrying a live PID sends pidAlive=1 and records already-running-pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pace-pid-"));
    const state = join(dir, "state.json");
    writeFileSync(state, JSON.stringify({ pid: process.pid }));
    const srv = await eligibilityServer(eligiblePayload());
    try {
      const r = await runPaceGate(srv.url, [], { HYDRA_AUTOPILOT_STATE: state });
      assert.equal(r.status, 0);
      assert.match(srv.lastUrl(), /pidAlive=1/);
      assert.match(r.stdout, /skip reason=already-running-pid class=already-running/);
      assert.doesNotMatch(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });

  test("an ELIGIBILITY_URL that already carries a query string is extended with &", async () => {
    const srv = await eligibilityServer(eligiblePayload());
    try {
      await runPaceGate(`${srv.url}?force=1`);
      assert.match(srv.lastUrl(), /\?force=1&mode=timer&serviceActive=0&pidAlive=0/);
    } finally {
      srv.close();
    }
  });
});

describe("pace-gate.sh transport: admit => launch (issue #5102)", () => {
  test("timer mode admit => would-start", async () => {
    const srv = await eligibilityServer(eligiblePayload());
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-start/);
      assert.match(r.stdout, /reason=eligible-launch/);
    } finally {
      srv.close();
    }
  });

  test("exec mode admit => would-exec", async () => {
    const srv = await eligibilityServer(eligiblePayload());
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /would-exec/);
    } finally {
      srv.close();
    }
  });

  test("exec mode eligible branch exports HYDRA_AUTOPILOT_TRIGGER=pace-gate to the exec'd command (issue #2955)", async () => {
    const srv = await eligibilityServer(eligiblePayload());
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        // DRY_RUN=1's early exit precedes the EXEC_CMD hook - override to 0.
        HYDRA_PACE_GATE_DRY_RUN: "0",
        // EXEC_CMD is word-split with NO quote re-parsing; printenv observes
        // what the exec'd claude CLI would inherit.
        HYDRA_PACE_GATE_EXEC_CMD: "printenv HYDRA_AUTOPILOT_TRIGGER",
        // Seed a decoy the eligible branch's export must overwrite.
        HYDRA_AUTOPILOT_TRIGGER: "decoy-not-from-gate",
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^pace-gate$/m);
      assert.doesNotMatch(r.stdout, /decoy-not-from-gate/);
    } finally {
      srv.close();
    }
  });

  test("exec mode ineligible exit does NOT reach the trigger export (issue #2955)", async () => {
    const srv = await eligibilityServer(eligiblePayload({ weeklyEmergencyStop: true }));
    try {
      const r = await runPaceGate(srv.url, ["--exec-autopilot"], {
        HYDRA_PACE_GATE_DRY_RUN: "0",
        HYDRA_PACE_GATE_EXEC_CMD: "printenv HYDRA_AUTOPILOT_TRIGGER",
      });
      assert.equal(r.status, 0); // clean skip exit - Restart=on-failure disarms
      assert.doesNotMatch(r.stdout, /^pace-gate$/m);
    } finally {
      srv.close();
    }
  });

  test("armed + policy=allow => informational line driven by .admission.note, then launch", async () => {
    const srv = await eligibilityServer(eligiblePayload({ extraUsageArmed: true }));
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /ARMED on the logged-in account but HYDRA_EXTRA_USAGE_POLICY=allow/);
      assert.match(r.stdout, /would-start/);
    } finally {
      srv.close();
    }
  });
});

describe("pace-gate.sh transport: skip is a verbatim pass-through (issue #5102)", () => {
  const future = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const payloads: Array<[string, Record<string, unknown>]> = [
    ["paused", { paused: true }],
    ["weeklyEmergencyStop", { weeklyEmergencyStop: true }],
    ["fiveHourThrottleShed", { fiveHourThrottleShed: true }],
    ["future postQuotaUntil", { postQuotaUntil: future() }],
  ];
  for (const [name, reasons] of payloads) {
    test(`${name} => logged reason equals decideAdmission's, exit 0, no launch`, async () => {
      const payload = eligiblePayload(reasons);
      const expected = decideAdmission(payload as any, {
        nowMs: Date.now(),
        mode: "timer",
        serviceActive: false,
        pidAlive: false,
      });
      const srv = await eligibilityServer(payload);
      try {
        const r = await runPaceGate(srv.url);
        assert.equal(r.status, 0);
        assert.match(r.stdout, new RegExp(`skip reason=${expected.reason} class=${expected.class} `));
        assert.doesNotMatch(r.stdout, /would-start/);
      } finally {
        srv.close();
      }
    });
  }

  test("a reason bash has never seen is recorded verbatim", async () => {
    const srv = await eligibilityServer(eligiblePayload(), {
      admission: { admit: false, reason: "future-reason", class: "deliberate-skip", note: null },
    });
    try {
      const r = await runPaceGate(srv.url);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /skip reason=future-reason class=deliberate-skip/);
      assert.doesNotMatch(r.stdout, /would-start/);
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
      // #5102 AC2: the tick hash shape is unchanged on a skip.
      assert.deepEqual(Object.keys(fields).sort(), ["at", "class", "latency_ms", "reason"]);
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
          ...DEFAULT_MODEL_PAIR_ENV,
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

/**
 * Issue #4843: the meter-unavailable arm nudges the Claude CLI to rotate an
 * expired / expiring OAuth token (rate-limited by a stamp file), never
 * exposing the token itself.
 */
describe("pace-gate.sh token-refresh nudge in the meter-unavailable arm (issue #4843)", () => {
  const ACCESS = "SENTINEL-ACCESS-TOKEN-4843";
  const REFRESH = "SENTINEL-REFRESH-TOKEN-4843";

  function fixture(expiresAt: number) {
    const dir = mkdtempSync(join(tmpdir(), "pace-nudge-"));
    const creds = join(dir, "creds.json");
    writeFileSync(
      creds,
      JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt } }),
    );
    const marker = join(dir, "marker");
    // The nudge command is word-split (no shell quoting), so use a script file.
    const script = join(dir, "nudge.sh");
    writeFileSync(script, `#!/bin/bash\necho x >> "${marker}"\n`, { mode: 0o755 });
    return {
      marker,
      env: {
        HYDRA_CLAUDE_CREDENTIALS_PATH: creds,
        HYDRA_PACE_GATE_NUDGE_STAMP: join(dir, "stamp"),
        HYDRA_PACE_GATE_NUDGE_CMD: script,
      },
    };
  }

  const blind = () =>
    eligibilityServer({
      allow: false,
      shed: [],
      reasons: { ...baseReasons, meterUnavailable: true },
      paceState: "behind",
    });

  const runs = (marker: string) =>
    existsSync(marker) ? readFileSync(marker, "utf-8").trim().split("\n").length : 0;

  test("past expiresAt + meterUnavailable: nudge runs once, then is rate-limited by the stamp", async () => {
    const f = fixture(Date.now() - 60_000);
    const srv = await blind();
    try {
      const r1 = await runPaceGate(srv.url, [], f.env);
      assert.equal(r1.status, 0);
      assert.match(r1.stdout, /token-refresh nudge ran/);
      assert.equal(runs(f.marker), 1);
      const r2 = await runPaceGate(srv.url, [], f.env);
      assert.equal(r2.status, 0);
      assert.equal(runs(f.marker), 1, "a second tick inside 30 min must not nudge again");
      assert.doesNotMatch(r2.stdout, /token-refresh nudge ran/);
    } finally {
      srv.close();
    }
  });

  test(
    "tick reason is token-refresh-nudge on a nudge tick and meter-unavailable on a non-nudge blind tick",
    { skip: !REDIS_GATED },
    async () => {
      const conn = getRedisConnection();
      await conn.del(LAST_TICK_KEY);
      const srv = await blind();
      try {
        const f = fixture(Date.now() - 60_000);
        const r1 = await runPaceGate(srv.url, [], { ...f.env, HYDRA_REDIS_DB: String(TEST_DB) });
        assert.equal(r1.status, 0);
        assert.equal((await conn.hgetall(LAST_TICK_KEY)).reason, "token-refresh-nudge");
        await conn.del(LAST_TICK_KEY);
        const g = fixture(Date.now() + 3_600_000);
        const r2 = await runPaceGate(srv.url, [], { ...g.env, HYDRA_REDIS_DB: String(TEST_DB) });
        assert.equal(r2.status, 0);
        assert.equal((await conn.hgetall(LAST_TICK_KEY)).reason, "meter-unavailable");
      } finally {
        srv.close();
        await conn.del(LAST_TICK_KEY);
      }
    },
  );

  test("an unwritable stamp path skips the nudge (rate limit unenforceable)", async () => {
    const f = fixture(Date.now() - 60_000);
    const srv = await blind();
    try {
      const r = await runPaceGate(srv.url, [], {
        ...f.env,
        HYDRA_PACE_GATE_NUDGE_STAMP: "/proc/nonexistent/stamp",
      });
      assert.equal(r.status, 0);
      assert.equal(runs(f.marker), 0);
      assert.match(r.stdout, /skipping nudge/);
    } finally {
      srv.close();
    }
  });

  test("expiresAt more than 10 minutes out never nudges", async () => {
    const f = fixture(Date.now() + 3_600_000);
    const srv = await blind();
    try {
      const r = await runPaceGate(srv.url, [], f.env);
      assert.equal(r.status, 0);
      assert.equal(runs(f.marker), 0);
      assert.match(r.stdout, /usage meter unavailable/);
    } finally {
      srv.close();
    }
  });

  test("a failing nudge command never aborts the tick under set -e", async () => {
    const f = fixture(Date.now() - 60_000);
    const srv = await blind();
    try {
      const r = await runPaceGate(srv.url, [], { ...f.env, HYDRA_PACE_GATE_NUDGE_CMD: "false" });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /token-refresh nudge ran .*rc=1/);
    } finally {
      srv.close();
    }
  });

  test("no token value ever reaches stdout", async () => {
    const f = fixture(Date.now() - 60_000);
    const srv = await blind();
    try {
      const r = await runPaceGate(srv.url, [], f.env);
      assert.doesNotMatch(r.stdout, new RegExp(ACCESS));
      assert.doesNotMatch(r.stdout, new RegExp(REFRESH));
    } finally {
      srv.close();
    }
  });
});
