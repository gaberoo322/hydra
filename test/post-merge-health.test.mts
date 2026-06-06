/**
 * Regression tests for scripts/target/post-merge-health.ts (issue #1054).
 *
 * The post-merge operational-health smoke check is the Target's alarm-only
 * replacement for per-merge Outcome Holdback (epic #1052). These tests pin the
 * three acceptance criteria:
 *   1. samples /api/health/full and derives execution-success + error-rate
 *      signals from the per-service status map;
 *   2. on regression past the configurable noise floor, dispatches hydra-incident
 *      (and ONLY dispatches — never reverts, never blocks);
 *   3. no-ops cleanly when the Target API is unreachable (logs, does NOT throw).
 *
 * The script's I/O (fetch, spawn) is injected so the tests run hermetically with
 * no network and no real `claude` process.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  loadConfig,
  parseHealthSnapshot,
  evaluateRegression,
  buildIncidentContext,
  fetchTargetHealth,
  runWatch,
  parseArgs,
} = await import("../scripts/target/post-merge-health.ts");

// A baseline config with the documented defaults (env-empty).
function baseConfig() {
  return loadConfig({} as NodeJS.ProcessEnv);
}

// A fake fetch returning a given JSON body with HTTP 200.
function fakeFetchOk(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

// A fake fetch that rejects (connection refused / DNS / abort).
function fakeFetchThrows(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("post-merge-health: config (issue #1054 — configurable noise floor)", () => {
  test("defaults are applied when env is empty", () => {
    const c = baseConfig();
    assert.equal(c.apiUrl, "http://localhost:3333");
    assert.deepEqual(c.alarmOnOverall, ["error"]);
    assert.equal(c.maxExecutionErrors, 0);
    assert.equal(c.maxProviderErrors, 1);
    assert.equal(c.maxDegradedServices, 2);
    assert.equal(c.dispatch, false, "dispatch must default OFF (dry-run) so importing/CI never spawns claude");
  });

  test("env overrides the noise floor and strips a trailing slash from the URL", () => {
    const c = loadConfig({
      HYDRA_TARGET_API_URL: "http://target.local:9999/",
      HYDRA_PMH_ALARM_ON_OVERALL: "error, degraded",
      HYDRA_PMH_MAX_EXECUTION_ERRORS: "3",
      HYDRA_PMH_MAX_PROVIDER_ERRORS: "4",
      HYDRA_PMH_MAX_DEGRADED_SERVICES: "5",
      HYDRA_PMH_DISPATCH: "1",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(c.apiUrl, "http://target.local:9999");
    assert.deepEqual(c.alarmOnOverall, ["error", "degraded"]);
    assert.equal(c.maxExecutionErrors, 3);
    assert.equal(c.maxProviderErrors, 4);
    assert.equal(c.maxDegradedServices, 5);
    assert.equal(c.dispatch, true);
  });

  test("malformed integer env falls back to the default", () => {
    const c = loadConfig({ HYDRA_PMH_MAX_EXECUTION_ERRORS: "notanumber" } as unknown as NodeJS.ProcessEnv);
    assert.equal(c.maxExecutionErrors, 0);
  });
});

describe("post-merge-health: snapshot parsing (samples /api/health/full)", () => {
  test("derives execution + provider error counts from the per-service status map", () => {
    const snap = parseHealthSnapshot({
      status: "degraded",
      services: {
        database: { status: "ok" },
        scanner: { status: "error" }, // execution-class
        ingestion: { status: "error" }, // execution-class
        opticOdds: { status: "degraded" }, // provider-class
        pinnacleFairLine: { status: "ok" },
      },
    });
    assert.equal(snap.overall, "degraded");
    assert.equal(snap.servicesNotOk, 3);
    assert.equal(snap.executionErrors, 2, "scanner + ingestion are execution-class");
    assert.equal(snap.providerErrors, 1, "opticOdds is provider-class");
  });

  test("accepts a string-valued service status (shape tolerance)", () => {
    const snap = parseHealthSnapshot({ status: "OK", services: { database: "error" } });
    assert.equal(snap.overall, "ok", "overall status is lowercased");
    assert.equal(snap.servicesNotOk, 1);
  });

  test("missing/garbage body yields an empty, non-throwing snapshot", () => {
    const snap = parseHealthSnapshot(null);
    assert.equal(snap.overall, "unknown");
    assert.equal(snap.servicesNotOk, 0);
    assert.deepEqual(snap.services, {});
  });
});

describe("post-merge-health: regression evaluation (noise floor)", () => {
  test("all-ok health does NOT regress", () => {
    const snap = parseHealthSnapshot({ status: "ok", services: { database: { status: "ok" } } });
    const v = evaluateRegression(snap, baseConfig());
    assert.equal(v.regressed, false);
    assert.deepEqual(v.reasons, []);
  });

  test("a single execution-class error breaches the zero-tolerance execution floor", () => {
    const snap = parseHealthSnapshot({ status: "degraded", services: { scanner: { status: "error" } } });
    const v = evaluateRegression(snap, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("execution-class")));
  });

  test("a single provider error is tolerated (floor is 1), two breaches", () => {
    const oneProvider = parseHealthSnapshot({ status: "degraded", services: { opticOdds: { status: "degraded" } } });
    assert.equal(evaluateRegression(oneProvider, baseConfig()).regressed, false);

    const twoProviders = parseHealthSnapshot({
      status: "degraded",
      services: { opticOdds: { status: "degraded" }, kalshiApi: { status: "error" } },
    });
    const v = evaluateRegression(twoProviders, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("provider-class")));
  });

  test("overall status \"error\" alarms even with no individual service breach", () => {
    const snap = parseHealthSnapshot({ status: "error", services: {} });
    const v = evaluateRegression(snap, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("overall health status")));
  });
});

describe("post-merge-health: incident context", () => {
  test("context names the alarm-only contract, the SHA, and the failing services", () => {
    const snap = parseHealthSnapshot({ status: "error", services: { scanner: { status: "error" } } });
    const v = evaluateRegression(snap, baseConfig());
    const ctx = buildIncidentContext(v, { mergeSha: "abc1234", apiUrl: "http://localhost:3333" });
    assert.ok(ctx.includes("ALARM-ONLY"));
    assert.ok(ctx.includes("do NOT assume an auto-revert"));
    assert.ok(ctx.includes("abc1234"));
    assert.ok(ctx.includes("scanner=error"));
  });
});

describe("post-merge-health: fetch fail-soft (unreachable Target)", () => {
  test("a thrown fetch returns ok:false, never throws", async () => {
    const res = await fetchTargetHealth(baseConfig(), fakeFetchThrows("ECONNREFUSED"));
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.reason.includes("unreachable"));
  });

  test("a non-2xx response returns ok:false", async () => {
    const fetch500 = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await fetchTargetHealth(baseConfig(), fetch500);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.reason.includes("503"));
  });
});

describe("post-merge-health: runWatch end-to-end (injected I/O)", () => {
  test("unreachable Target => clean no-op, no dispatch, no throw", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      {},
      { fetchImpl: fakeFetchThrows("ECONNREFUSED"), spawnImpl: spawnSpy },
    );
    assert.equal(result.kind, "unreachable");
    assert.equal(spawned, false, "must not dispatch hydra-incident when the Target is unreachable");
  });

  test("healthy Target => no dispatch", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      {},
      { fetchImpl: fakeFetchOk({ status: "ok", services: { database: { status: "ok" } } }), spawnImpl: spawnSpy },
    );
    assert.equal(result.kind, "healthy");
    assert.equal(spawned, false);
  });

  test("regression + dispatch=true => spawns hydra-incident exactly once (alarm-only)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSpy = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "deadbeef" },
      {
        fetchImpl: fakeFetchOk({ status: "error", services: { scanner: { status: "error" } } }),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(result.kind, "alarm");
    if (result.kind === "alarm") assert.equal(result.dispatched, true);
    assert.equal(calls.length, 1, "exactly one hydra-incident dispatch");
    assert.equal(calls[0]!.cmd, "claude");
    const joined = calls[0]!.args.join(" ");
    assert.ok(joined.includes("/hydra-incident"), "dispatches the hydra-incident skill");
    assert.ok(joined.includes("deadbeef"), "passes the merge SHA into the incident context");
    // Alarm-only: nothing in the argv asks for a revert.
    assert.ok(!/revert/i.test(joined) || /not assume an auto-revert/i.test(joined));
  });

  test("regression + dispatch=false (default) => alarm but NO spawn (dry-run)", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      baseConfig(), // dispatch defaults false
      {},
      {
        fetchImpl: fakeFetchOk({ status: "error", services: { scanner: { status: "error" } } }),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(result.kind, "alarm");
    if (result.kind === "alarm") assert.equal(result.dispatched, false);
    assert.equal(spawned, false, "dry-run must not spawn");
  });
});

describe("post-merge-health: arg parsing", () => {
  test("--merge-sha, --dispatch, --dry-run", () => {
    assert.deepEqual(parseArgs(["--merge-sha", "abc", "--dispatch"]), { mergeSha: "abc", dispatch: true });
    assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
    assert.deepEqual(parseArgs([]), {});
  });
});
