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
 * Issue #1699 adds two more pinned behaviors:
 *   4. a non-2xx response carrying a parseable health JSON body is a VALID
 *      sample (the endpoint answers 503 with a full body when degraded) — only
 *      network errors / non-JSON / shape-invalid bodies are "unreachable";
 *   5. baseline-delta mode (--snapshot-out pre-merge, --baseline post-merge):
 *      ambient degradation alone never alarms, only deltas do; a missing
 *      baseline falls back to the absolute thresholds.
 *
 * Issue #1817 adds freshness-flap suppression in delta mode:
 *   6. an ok->soft (degraded/stale) transition on a freshness-class service
 *      (keyword allowlist) is suppressed as a sampling artifact, BUT any move
 *      into error, any worsening from an already-not-ok baseline, and ok->soft
 *      on a hard-check (non-freshness) service all still count — suppression is
 *      scoped, never global.
 *
 * The #1817 recurrence adds the absolute-mode non-blocking fallback:
 *   7. with NO pre-merge baseline the absolute-threshold evaluator still runs,
 *      but a breach is reported `inconclusive` (logged, hydra-incident NEVER
 *      dispatched) rather than alarming — post-merge health is a regression
 *      signal, meaningless without a baseline, and the Target's chronic-degraded
 *      floor breaches the absolute floors on every merge. Opt back into legacy
 *      absolute-mode alarming with HYDRA_PMH_ALARM_WITHOUT_BASELINE=1.
 *
 * The script's I/O (fetch, spawn) is injected so the tests run hermetically with
 * no network and no real `claude` process. Baseline files use a per-test
 * tmpdir — plain node:fs, mirroring the script's stdlib-only constraint.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __resetForTests } = await import("../src/target-config.ts");

const {
  loadConfig,
  parseHealthSnapshot,
  evaluateRegression,
  severityRank,
  evaluateDelta,
  isFreshnessClass,
  deltaCounts,
  writeBaseline,
  readBaseline,
  buildIncidentContext,
  fetchTargetHealth,
  runWatch,
  parseArgs,
} = await import("../scripts/target/post-merge-health.ts");

// A baseline config with the documented defaults (env-empty). NOTE (issue
// #4524): apiUrl now flows through the target-config seam (getTargetWebUrl()),
// which reads process.env directly — NOT the `env` argument, which governs
// only the HYDRA_PMH_* knobs. Config tests therefore manipulate
// process.env.HYDRA_TARGET_WEB_URL / HYDRA_BETTING_URL directly, mirroring
// test/target-config.test.mts.
function baseConfig() {
  return loadConfig({} as NodeJS.ProcessEnv);
}

// Hermetic process.env for the seam-resolved fields: save/delete/restore the
// two URL env vars around each config test so an ambient operator shell (the
// services export HYDRA_TARGET_WEB_URL) cannot leak into assertions.
type UrlEnvSnapshot = {
  HYDRA_TARGET_WEB_URL: string | undefined;
  HYDRA_BETTING_URL: string | undefined;
  HYDRA_TARGET_API_URL: string | undefined;
};
let urlEnvSnapshot: UrlEnvSnapshot;

function saveUrlEnv(): UrlEnvSnapshot {
  return {
    HYDRA_TARGET_WEB_URL: process.env.HYDRA_TARGET_WEB_URL,
    HYDRA_BETTING_URL: process.env.HYDRA_BETTING_URL,
    HYDRA_TARGET_API_URL: process.env.HYDRA_TARGET_API_URL,
  };
}

function restoreUrlEnv(snap: UrlEnvSnapshot) {
  for (const key of ["HYDRA_TARGET_WEB_URL", "HYDRA_BETTING_URL", "HYDRA_TARGET_API_URL"] as const) {
    const v = snap[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
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
  beforeEach(() => {
    urlEnvSnapshot = saveUrlEnv();
    delete process.env.HYDRA_TARGET_WEB_URL;
    delete process.env.HYDRA_BETTING_URL;
    delete process.env.HYDRA_TARGET_API_URL;
    __resetForTests();
  });
  afterEach(() => {
    restoreUrlEnv(urlEnvSnapshot);
    __resetForTests();
  });

  test("defaults are applied when env is empty — apiUrl comes from the target-config seam (issue #4524)", () => {
    const c = baseConfig();
    // getTargetWebUrl()'s soft default (DEFAULT_TARGET_WEB_URL in
    // src/target-config.ts) — the script itself carries NO port literal.
    assert.equal(c.apiUrl, "http://localhost:3334");
    assert.deepEqual(c.alarmOnOverall, ["error"]);
    assert.equal(c.maxExecutionErrors, 0);
    assert.equal(c.maxProviderErrors, 1);
    assert.equal(c.maxDegradedServices, 2);
    assert.equal(c.dispatch, false, "dispatch must default OFF (dry-run) so importing/CI never spawns claude");
    assert.equal(
      c.alarmWithoutBaseline,
      false,
      "absolute-mode alarming must default OFF (issue #1817 recurrence): no baseline => inconclusive, never alarm",
    );
  });

  test("HYDRA_PMH_ALARM_WITHOUT_BASELINE=1 enables legacy absolute-mode alarming (issue #1817 recurrence opt-in)", () => {
    const c = loadConfig({ HYDRA_PMH_ALARM_WITHOUT_BASELINE: "1" } as unknown as NodeJS.ProcessEnv);
    assert.equal(c.alarmWithoutBaseline, true);
  });

  test("HYDRA_TARGET_WEB_URL (the target-config seam) drives apiUrl, trailing slash stripped (issue #4524)", () => {
    process.env.HYDRA_TARGET_WEB_URL = "http://target.local:9999/";
    const c = loadConfig({
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

  test("the retired HYDRA_TARGET_API_URL is no longer consulted (issue #4524)", () => {
    process.env.HYDRA_TARGET_API_URL = "http://stale-override:1111";
    const c = baseConfig();
    assert.equal(c.apiUrl, "http://localhost:3334", "the script-local override is gone; only the seam resolves the URL");
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
  test("context names the alarm-only contract, the SHA, the target name, the sampled route, and the failing services", () => {
    const snap = parseHealthSnapshot({ status: "error", services: { scanner: { status: "error" } } });
    const v = evaluateRegression(snap, baseConfig());
    const ctx = buildIncidentContext(v, {
      mergeSha: "abc1234",
      apiUrl: "http://localhost:3334",
      targetName: "claw-street-bets",
      route: "basic",
    });
    assert.ok(ctx.includes("ALARM-ONLY"));
    assert.ok(ctx.includes("do NOT assume an auto-revert"));
    assert.ok(ctx.includes("abc1234"));
    assert.ok(ctx.includes("scanner=error"));
    assert.ok(ctx.includes("claw-street-bets"), "the Target name comes from getTargetName(), never a literal");
    assert.ok(
      ctx.includes("http://localhost:3334/api/health (route: basic)"),
      "the Target API line names the route actually sampled",
    );
    assert.ok(!ctx.includes("3333"));
  });
});

describe("post-merge-health: fetch fail-soft (unreachable Target)", () => {
  test("a thrown fetch returns ok:false, never throws", async () => {
    const res = await fetchTargetHealth(baseConfig(), fakeFetchThrows("ECONNREFUSED"));
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.reason.includes("unreachable"));
  });

  // Issue #1699: /api/health/full answers 503 WITH a full health body when the
  // overall status is degraded/error. That is a valid sample, NOT an outage —
  // the pre-#1699 "non-2xx => ok:false" pin was the zero-signal root cause.
  test("a non-2xx response with a parseable health JSON body is a VALID sample (issue #1699)", async () => {
    const degradedBody = {
      status: "degraded",
      services: { ingestion: { status: "degraded" }, opticOdds: { status: "error" } },
    };
    const fetch503 = (async () => ({
      ok: false,
      status: 503,
      json: async () => degradedBody,
    })) as unknown as typeof fetch;
    const res = await fetchTargetHealth(baseConfig(), fetch503);
    assert.equal(res.ok, true, "503 with a health body must be sampled, not discarded");
    if (res.ok) {
      assert.equal(res.httpStatus, 503, "the HTTP status rides along for logging");
      assert.deepEqual(res.body, degradedBody);
    }
  });

  test("a non-2xx response with a non-JSON body (proxy HTML error page) returns ok:false", async () => {
    const fetchHtml = (async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    })) as unknown as typeof fetch;
    const res = await fetchTargetHealth(baseConfig(), fetchHtml);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.reason.includes("502"));
  });

  test("a JSON body without a string status field is not a health sample (any status code)", async () => {
    const fetchShapeless = (async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) })) as unknown as typeof fetch;
    const res = await fetchTargetHealth(baseConfig(), fetchShapeless);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.reason.includes("status"));
  });
});

describe("post-merge-health: baseline-delta mode (issue #1699)", () => {
  test("severityRank: ok=0 < degraded=unknown=stale=1 < error=2", () => {
    assert.equal(severityRank("ok"), 0);
    assert.equal(severityRank("degraded"), 1);
    assert.equal(severityRank("unknown"), 1);
    assert.equal(severityRank("stale"), 1, "any unrecognized not-ok status ranks with degraded");
    assert.equal(severityRank("not_configured"), 1);
    assert.equal(severityRank("error"), 2);
  });

  // The exact zero-signal scenario from the issue: ambient degradation
  // (stale feeds, missing creds) present BEFORE the merge must not alarm
  // when the post-merge state is identical.
  test("ambient-degraded baseline + identical post-merge state => no alarm", () => {
    const ambient = parseHealthSnapshot({
      status: "degraded",
      services: {
        database: { status: "ok" },
        ingestion: { status: "degraded" },
        scanner: { status: "stale" },
        opticOdds: { status: "not_configured" },
        pinnacleFairLine: { status: "stale" },
      },
    });
    const v = evaluateDelta(ambient, ambient, baseConfig());
    assert.equal(v.regressed, false, "pre-existing degradation alone must never alarm in delta mode");
    assert.deepEqual(v.reasons, []);
  });

  test("a NEW execution-class failure vs a degraded baseline alarms", () => {
    const baseline = parseHealthSnapshot({
      status: "degraded",
      services: { ingestion: { status: "degraded" }, execution: { status: "ok" } },
    });
    const current = parseHealthSnapshot({
      status: "degraded",
      services: { ingestion: { status: "degraded" }, execution: { status: "error" } },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("execution-class")));
  });

  test("per-service severity worsening (degraded -> error) alarms", () => {
    const baseline = parseHealthSnapshot({
      status: "degraded",
      services: { scanner: { status: "degraded" } },
    });
    const current = parseHealthSnapshot({
      status: "degraded",
      services: { scanner: { status: "error" } },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true, "degraded -> error is a worsening delta even though the service was already not-ok");
    assert.ok(v.reasons.some((r: string) => r.includes("scanner: degraded -> error")));
  });

  test("a service ABSENT from the baseline that appears not-ok counts as a delta", () => {
    const baseline = parseHealthSnapshot({ status: "ok", services: { database: { status: "ok" } } });
    const current = parseHealthSnapshot({
      status: "degraded",
      services: { database: { status: "ok" }, orderRouter: { status: "error" } },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("orderRouter: (absent) -> error")));
  });

  test("recovered/improved services are ignored (never alarm)", () => {
    const baseline = parseHealthSnapshot({
      status: "degraded",
      services: { scanner: { status: "error" }, ingestion: { status: "degraded" } },
    });
    const current = parseHealthSnapshot({
      status: "ok",
      services: { scanner: { status: "ok" }, ingestion: { status: "ok" } },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, false);
  });

  test("overall severity-rank worsening alarms even with no per-service delta", () => {
    const baseline = parseHealthSnapshot({ status: "degraded", services: {} });
    const current = parseHealthSnapshot({ status: "error", services: {} });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("overall health worsened")));
  });

  test("overall same-rank drift does not alarm (degraded -> unknown)", () => {
    const baseline = parseHealthSnapshot({ status: "degraded", services: {} });
    const current = parseHealthSnapshot({ status: "unknown", services: {} });
    assert.equal(evaluateDelta(baseline, current, baseConfig()).regressed, false);
  });

  test("HYDRA_PMH_* floors apply to DELTA counts: one new provider failure tolerated (floor 1), two alarm", () => {
    const baseline = parseHealthSnapshot({
      status: "degraded",
      services: { opticOdds: { status: "degraded" } }, // ambient provider degradation
    });
    const oneNew = parseHealthSnapshot({
      status: "degraded",
      services: { opticOdds: { status: "degraded" }, kalshiApi: { status: "error" } },
    });
    assert.equal(
      evaluateDelta(baseline, oneNew, baseConfig()).regressed,
      false,
      "one newly-failing provider is within the floor (maxProviderErrors=1)",
    );

    const twoNew = parseHealthSnapshot({
      status: "degraded",
      services: {
        opticOdds: { status: "degraded" },
        kalshiApi: { status: "error" },
        polymarketFeed: { status: "error" },
      },
    });
    const v = evaluateDelta(baseline, twoNew, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("provider-class")));
  });
});

describe("post-merge-health: baseline file round-trip (issue #1699)", () => {
  test("writeBaseline + readBaseline round-trips the snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-baseline-"));
    const path = join(dir, "nested", "pmh-baseline.json"); // nested: exercises mkdir -p
    const snapshot = parseHealthSnapshot({
      status: "degraded",
      services: { ingestion: { status: "degraded" }, database: { status: "ok" } },
    });

    const wrote = writeBaseline(path, snapshot);
    assert.equal(wrote.ok, true);
    assert.ok(existsSync(path));

    const read = readBaseline(path);
    assert.equal(read.ok, true);
    if (read.ok) assert.deepEqual(read.snapshot, snapshot);
  });

  test("a missing baseline file returns ok:false, never throws", () => {
    const res = readBaseline(join(tmpdir(), "pmh-baseline-does-not-exist", "nope.json"));
    assert.equal(res.ok, false);
  });

  test("a corrupt/shape-invalid baseline file returns ok:false", () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-baseline-corrupt-"));
    const garbagePath = join(dir, "garbage.json");
    writeFileSync(garbagePath, "not json at all", "utf8");
    assert.equal(readBaseline(garbagePath).ok, false);

    const shapelessPath = join(dir, "shapeless.json");
    writeFileSync(shapelessPath, JSON.stringify({ version: 1 }), "utf8");
    assert.equal(readBaseline(shapelessPath).ok, false);
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

  // alarmWithoutBaseline: true keeps these two tests exercising the absolute-mode
  // alarm/dispatch MECHANICS (argv, dry-run gating) post-#1817-recurrence; the
  // default no-baseline behavior (inconclusive, no dispatch) is pinned separately.
  test("regression + dispatch=true => spawns hydra-incident exactly once (alarm-only)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSpy = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true, alarmWithoutBaseline: true },
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
    assert.ok(
      joined.includes("/hydra-target-incident"),
      "dispatches the Target-scoped hydra-target-incident skill (ADR-0025, issue #2553)",
    );
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
      { ...baseConfig(), alarmWithoutBaseline: true }, // dispatch defaults false
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

  // Issue #1699 end-to-end: the exact scenario from the issue — ambient
  // degradation served as a 503 — must yield SIGNAL (a delta-mode sample),
  // not an "unreachable" no-op, and must not alarm when nothing changed.
  test("--snapshot-out then --baseline round-trip: 503-degraded ambient state => baseline written, then healthy delta verdict, no spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-e2e-"));
    const baselinePath = join(dir, "pmh-baseline.json");
    const ambientBody = {
      status: "degraded",
      services: {
        database: { status: "ok" },
        ingestion: { status: "degraded" },
        scanner: { status: "stale" },
        opticOdds: { status: "not_configured" },
        pinnacleFairLine: { status: "stale" },
      },
    };
    const fetch503 = (async () => ({ ok: false, status: 503, json: async () => ambientBody })) as unknown as typeof fetch;
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    // Pre-merge: snapshot mode writes the baseline and never evaluates.
    const pre = await runWatch(
      { ...baseConfig(), dispatch: true },
      { snapshotOut: baselinePath },
      { fetchImpl: fetch503, spawnImpl: spawnSpy },
    );
    assert.equal(pre.kind, "baseline-written");
    assert.ok(existsSync(baselinePath));
    assert.ok(
      JSON.parse(readFileSync(baselinePath, "utf8")).snapshot.services.ingestion,
      "baseline file carries the per-service map",
    );

    // Post-merge: identical ambient state => healthy in delta mode. Under the
    // pre-#1699 behavior this entire scenario was an 'unreachable' no-op; under
    // absolute thresholds it would false-alarm (2 execution-class > floor 0).
    const post = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "cafe123", baselinePath },
      { fetchImpl: fetch503, spawnImpl: spawnSpy },
    );
    assert.equal(post.kind, "healthy");
    if (post.kind === "healthy") assert.equal(post.mode, "delta");
    assert.equal(spawned, false, "ambient degradation alone must never dispatch hydra-incident");
  });

  test("--baseline + a NEW post-merge failure => alarm in delta mode with dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-e2e-regress-"));
    const baselinePath = join(dir, "pmh-baseline.json");
    const baseline = parseHealthSnapshot({
      status: "degraded",
      services: { ingestion: { status: "degraded" }, execution: { status: "ok" } },
    });
    assert.equal(writeBaseline(baselinePath, baseline).ok, true);

    const regressedBody = {
      status: "degraded",
      services: { ingestion: { status: "degraded" }, execution: { status: "error" } },
    };
    const fetch503 = (async () => ({ ok: false, status: 503, json: async () => regressedBody })) as unknown as typeof fetch;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSpy = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "deadbeef", baselinePath },
      { fetchImpl: fetch503, spawnImpl: spawnSpy },
    );
    assert.equal(result.kind, "alarm");
    if (result.kind === "alarm") {
      assert.equal(result.mode, "delta");
      assert.equal(result.dispatched, true);
    }
    assert.equal(calls.length, 1, "exactly one hydra-incident dispatch");
    const joined = calls[0]!.args.join(" ");
    assert.ok(joined.includes("baseline-delta"), "incident context names the comparison mode");
    assert.ok(joined.includes("deadbeef"));
  });

  // Issue #1817 recurrence: a baseline-miss falls back to the absolute evaluator,
  // but an absolute breach is now reported INCONCLUSIVE (never alarmed/dispatched)
  // because post-merge health is meaningless without a baseline to diff against.
  test("--baseline pointing at a missing file => inconclusive, never dispatches (issue #1817 recurrence)", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true }, // even with dispatch on, absolute breach must NOT fire
      { baselinePath: join(tmpdir(), "pmh-missing-baseline", "nope.json") },
      {
        fetchImpl: fakeFetchOk({ status: "degraded", services: { scanner: { status: "error" } } }),
        spawnImpl: spawnSpy,
      },
    );
    // The absolute evaluator still detects the breach (one execution-class error
    // > floor 0), but the watcher reports it inconclusive instead of alarming.
    assert.equal(result.kind, "inconclusive");
    if (result.kind === "inconclusive") {
      assert.equal(result.verdict.regressed, true, "the underlying absolute breach is still computed (for diagnostics)");
      assert.ok(result.reason.includes("no pre-merge baseline"));
    }
    assert.equal(spawned, false, "absolute-mode breach must NEVER dispatch hydra-incident without a baseline");
  });

  test("HYDRA_PMH_ALARM_WITHOUT_BASELINE=1 restores legacy absolute-mode alarming", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSpy = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const config = loadConfig({
      HYDRA_PMH_ALARM_WITHOUT_BASELINE: "1",
      HYDRA_PMH_DISPATCH: "1",
    } as unknown as NodeJS.ProcessEnv);
    const result = await runWatch(
      config,
      { mergeSha: "optin1817", baselinePath: join(tmpdir(), "pmh-missing-baseline", "nope.json") },
      {
        fetchImpl: fakeFetchOk({ status: "degraded", services: { scanner: { status: "error" } } }),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(result.kind, "alarm", "the opt-in env restores absolute-mode alarming");
    if (result.kind === "alarm") {
      assert.equal(result.mode, "absolute");
      assert.equal(result.dispatched, true);
    }
    assert.equal(calls.length, 1, "exactly one hydra-incident dispatch when opted in");
  });

  // The exact #1817 recurrence: NO baseline (Step-7 snapshot skipped / Target was
  // down pre-merge), so the watcher falls back to absolute mode and the Target's
  // chronic-degraded floor (opticOdds not_configured + pinnacle 0-rows +
  // freshness-stale ingestion/scanner) breaches every absolute floor — yet this
  // is NOT a merge regression. Must be inconclusive, never dispatch.
  test("chronic-degraded Target with no baseline => inconclusive, no dispatch (the #1817 absolute-mode recurrence)", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "d6f906b0" }, // no baselinePath at all => absolute mode
      {
        fetchImpl: fakeFetchOk({
          status: "degraded",
          services: {
            database: { status: "ok" },
            ingestion: { status: "degraded" },
            scanner: { status: "stale" },
            pinnacleFairLine: { status: "failed" },
            opticOdds: { status: "not_configured" },
          },
        }),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(result.kind, "inconclusive", "the chronic-degraded floor is not a merge regression without a baseline");
    assert.equal(spawned, false, "must never dispatch hydra-incident on the absolute-mode chronic floor");
  });

  test("--snapshot-out with an unreachable Target => clean no-op, no baseline file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-snap-unreachable-"));
    const baselinePath = join(dir, "pmh-baseline.json");
    const result = await runWatch(
      baseConfig(),
      { snapshotOut: baselinePath },
      { fetchImpl: fakeFetchThrows("ECONNREFUSED") },
    );
    assert.equal(result.kind, "unreachable");
    assert.equal(existsSync(baselinePath), false, "no baseline written when unreachable — post-merge falls back to absolute mode");
  });
});

describe("post-merge-health: arg parsing", () => {
  test("--merge-sha, --dispatch, --dry-run", () => {
    assert.deepEqual(parseArgs(["--merge-sha", "abc", "--dispatch"]), { mergeSha: "abc", dispatch: true });
    assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
    assert.deepEqual(parseArgs([]), {});
  });

  test("--snapshot-out and --baseline (issue #1699)", () => {
    assert.deepEqual(parseArgs(["--snapshot-out", "/tmp/b.json"]), { snapshotOut: "/tmp/b.json" });
    assert.deepEqual(parseArgs(["--merge-sha", "abc", "--baseline", "/tmp/b.json"]), {
      mergeSha: "abc",
      baseline: "/tmp/b.json",
    });
  });
});

describe("post-merge-health: freshness-class config (issue #1817)", () => {
  test("default freshness allowlist covers the #1817 data/freshness services", () => {
    const c = baseConfig();
    assert.deepEqual(c.freshnessServices, ["scanner", "ingest", "pinnacle", "fairline", "freshness"]);
  });

  test("env overrides the freshness allowlist (csv, lowercased)", () => {
    const c = loadConfig({
      HYDRA_PMH_FRESHNESS_SERVICES: "Scanner, FairLine , feed",
    } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(c.freshnessServices, ["scanner", "fairline", "feed"]);
  });

  test("an empty env value falls back to the default allowlist", () => {
    const c = loadConfig({ HYDRA_PMH_FRESHNESS_SERVICES: "" } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(c.freshnessServices, ["scanner", "ingest", "pinnacle", "fairline", "freshness"]);
  });
});

describe("post-merge-health: isFreshnessClass (issue #1817)", () => {
  const fresh = baseConfig().freshnessServices;
  test("matches a freshness-class service name by keyword substring", () => {
    assert.equal(isFreshnessClass("scanner", fresh), true);
    assert.equal(isFreshnessClass("sportsbookIngestion", fresh), true, "substring 'ingest' matches");
    assert.equal(isFreshnessClass("pinnacleFairLine", fresh), true);
  });
  test("a hard-check service is NOT freshness-class", () => {
    assert.equal(isFreshnessClass("database", fresh), false);
    assert.equal(isFreshnessClass("migrationDrift", fresh), false);
    assert.equal(isFreshnessClass("opticOdds", fresh), false);
  });
});

describe("post-merge-health: deltaCounts — scoped freshness-flap suppression (issue #1817)", () => {
  const fresh = baseConfig().freshnessServices;
  // The 6 prototype cases from the approved design concept (hydra:design-concept:issue-1817).
  test("scanner ok->stale is SUPPRESSED (freshness flap)", () => {
    assert.equal(deltaCounts("scanner", "ok", "stale", fresh), false);
  });
  test("ingestion ok->degraded is SUPPRESSED (freshness flap)", () => {
    assert.equal(deltaCounts("sportsbookIngestion", "ok", "degraded", fresh), false);
  });
  test("scanner ok->error still COUNTS (any move into error always alarms — invariant 4)", () => {
    assert.equal(deltaCounts("scanner", "ok", "error", fresh), true);
  });
  test("scanner stale->error still COUNTS (worsening from already-not-ok)", () => {
    assert.equal(deltaCounts("scanner", "stale", "error", fresh), true);
  });
  test("database ok->degraded still COUNTS (hard-check service — invariant 5, never global)", () => {
    assert.equal(deltaCounts("database", "ok", "degraded", fresh), true);
  });
  test("opticOdds ok->error still COUNTS (non-freshness service into error)", () => {
    assert.equal(deltaCounts("opticOdds", "ok", "error", fresh), true);
  });

  // Edge cases beyond the prototype set.
  test("a freshness service ABSENT-in-baseline (=ok) -> stale is suppressed; -> error counts", () => {
    assert.equal(deltaCounts("scanner", undefined, "stale", fresh), false, "absent ranks ok=0; ok->soft suppressed");
    assert.equal(deltaCounts("scanner", undefined, "error", fresh), true, "absent->error always counts");
  });
  test("same-rank drift and improvements never count", () => {
    assert.equal(deltaCounts("scanner", "stale", "degraded", fresh), false, "same rank (1->1)");
    assert.equal(deltaCounts("scanner", "error", "ok", fresh), false, "improvement");
    assert.equal(deltaCounts("database", "degraded", "ok", fresh), false, "improvement, hard-check");
  });
});

describe("post-merge-health: evaluateDelta freshness-flap suppression (issue #1817)", () => {
  // The exact #1817 false-positive: scanner ok in baseline, stale post-merge.
  // The one-shot delta comparator USED to alarm (execution-class delta > floor 0);
  // it must now be suppressed because scanner is freshness-class and the move is
  // ok->soft.
  test("scanner ok->stale alone does NOT alarm (the #1817 false positive)", () => {
    const baseline = parseHealthSnapshot({ status: "ok", services: { scanner: { status: "ok" } } });
    const current = parseHealthSnapshot({ status: "degraded", services: { scanner: { status: "stale" } } });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, false, "scanner ok->stale is a freshness flap, not a regression");
    assert.deepEqual(v.reasons, []);
  });

  test("scanner ok->ERROR still alarms (invariant 4 — error always counts)", () => {
    const baseline = parseHealthSnapshot({ status: "ok", services: { scanner: { status: "ok" } } });
    const current = parseHealthSnapshot({ status: "error", services: { scanner: { status: "error" } } });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true);
    assert.ok(v.reasons.some((r: string) => r.includes("scanner: ok -> error")));
  });

  test("database ok->degraded (hard-check) still alarms — suppression is NOT global (invariant 5)", () => {
    // database is not execution/provider-class, so it lands on the generic
    // servicesNotOk floor (2); pad with two more non-freshness degradations to
    // breach it and prove the database delta was COUNTED, not suppressed.
    const baseline = parseHealthSnapshot({
      status: "ok",
      services: { database: { status: "ok" }, cacheLayer: { status: "ok" }, authService: { status: "ok" } },
    });
    const current = parseHealthSnapshot({
      status: "degraded",
      services: {
        database: { status: "degraded" },
        cacheLayer: { status: "degraded" },
        authService: { status: "degraded" },
      },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true, "hard-check ok->degraded must still count toward the floor");
    assert.ok(
      v.reasons.some((r: string) => r.includes("database: ok -> degraded")),
      "the database hard-check delta is named in the breach reason",
    );
  });

  test("scanner ok->stale suppressed but a concurrent execution ok->error STILL alarms", () => {
    // Mixed sample: the freshness flap on scanner is dropped, but a real
    // execution-class error survives and breaches the zero-tolerance floor —
    // the suppression must NOT swallow the genuine regression (invariant 5).
    const baseline = parseHealthSnapshot({
      status: "degraded", // ambient-degraded baseline, as in the real #1817 incident
      services: { scanner: { status: "ok" }, orderRouter: { status: "ok" } },
    });
    const current = parseHealthSnapshot({
      status: "degraded",
      services: { scanner: { status: "stale" }, orderRouter: { status: "error" } },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true, "the execution error must alarm even though the scanner flap is suppressed");
    assert.ok(
      v.reasons.some((r: string) => r.includes("orderRouter: ok -> error")),
      "the surviving execution-class delta is named in the breach reason",
    );
    assert.ok(
      !v.reasons.some((r: string) => r.includes("scanner")),
      "the suppressed scanner flap must not appear in any breach reason",
    );
  });

  test("scanner ok->stale alone with an already-degraded overall does NOT alarm (real #1817 shape)", () => {
    // The actual incident: overall was degraded on BOTH sides (ambient stale
    // feeds), the ONLY post-merge delta was scanner ok->stale. No alarm.
    const baseline = parseHealthSnapshot({
      status: "degraded",
      services: { scanner: { status: "ok" }, ingestion: { status: "degraded" }, opticOdds: { status: "not_configured" } },
    });
    const current = parseHealthSnapshot({
      status: "degraded",
      services: { scanner: { status: "stale" }, ingestion: { status: "degraded" }, opticOdds: { status: "not_configured" } },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, false, "the lone scanner freshness flap must not alarm");
    assert.deepEqual(v.reasons, []);
  });

  test("ingestion ok->degraded freshness flap is suppressed in delta mode", () => {
    const baseline = parseHealthSnapshot({ status: "ok", services: { ingestion: { status: "ok" } } });
    const current = parseHealthSnapshot({ status: "degraded", services: { ingestion: { status: "degraded" } } });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, false, "ingestion is freshness-class; ok->degraded is a flap");
  });

  // The overall status is DERIVED from the per-service set, so a lone freshness
  // flap can drag overall ok->degraded. That derived worsening must ALSO be
  // suppressed (else the suppression is defeated by the overall field), but ONLY
  // when no per-service delta survived and the overall stays in soft rank.
  test("overall ok->degraded driven solely by a suppressed flap does NOT alarm", () => {
    const baseline = parseHealthSnapshot({ status: "ok", services: { scanner: { status: "ok" } } });
    const current = parseHealthSnapshot({ status: "degraded", services: { scanner: { status: "stale" } } });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, false, "the overall worsening is itself a freshness-flap artifact");
    assert.ok(
      !v.reasons.some((r: string) => r.includes("overall health worsened")),
      "the derived overall worsening must not surface as a breach reason",
    );
  });

  test("overall ok->ERROR always alarms even if the only service delta is a suppressed flap (invariant 4)", () => {
    // overall reported error (e.g. a non-service-level failure) while the only
    // per-service change is a freshness flap. A worsening INTO error always
    // counts — the overall-flap suppression is scoped to soft rank only.
    const baseline = parseHealthSnapshot({ status: "ok", services: { scanner: { status: "ok" } } });
    const current = parseHealthSnapshot({ status: "error", services: { scanner: { status: "stale" } } });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true, "overall -> error must always alarm");
    assert.ok(v.reasons.some((r: string) => r.includes('overall health worsened vs pre-merge baseline: "ok" -> "error"')));
  });
});

describe("post-merge-health: runWatch end-to-end freshness-flap (issue #1817)", () => {
  // The full #1817 incident scenario, end-to-end through runWatch in delta mode:
  // scanner ok in the baseline, stale post-merge => NO alarm, NO dispatch.
  test("scanner ok->stale via baseline-delta => healthy, no dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-1817-flap-"));
    const baselinePath = join(dir, "baseline.json");
    const baseline = parseHealthSnapshot({ status: "ok", services: { scanner: { status: "ok" } } });
    assert.equal(writeBaseline(baselinePath, baseline).ok, true);

    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "flap1817", baselinePath },
      {
        fetchImpl: fakeFetchOk({ status: "degraded", services: { scanner: { status: "stale" } } }),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(result.kind, "healthy", "the scanner freshness flap must not alarm");
    if (result.kind === "healthy") assert.equal(result.mode, "delta");
    assert.equal(spawned, false, "no hydra-incident dispatch on a freshness flap");
  });

  // A REAL regression (scanner into error) still alarms + dispatches.
  test("scanner ok->error via baseline-delta => alarm + dispatch (real regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-1817-real-"));
    const baselinePath = join(dir, "baseline.json");
    const baseline = parseHealthSnapshot({ status: "ok", services: { scanner: { status: "ok" } } });
    assert.equal(writeBaseline(baselinePath, baseline).ok, true);

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSpy = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "real1817", baselinePath },
      {
        fetchImpl: fakeFetchOk({ status: "error", services: { scanner: { status: "error" } } }),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(result.kind, "alarm", "scanner into error is a real regression");
    if (result.kind === "alarm") assert.equal(result.dispatched, true);
    assert.equal(calls.length, 1, "exactly one hydra-incident dispatch");
  });
});

// ---------------------------------------------------------------------------
// Issue #4524 — the Target may serve only the basic /api/health shape; the
// base URL comes from the target-config seam; an unreachable Target is a loud
// explicit failure. These cases pin the smoke-build no-op fix.
// ---------------------------------------------------------------------------

// The live CSB basic-shape body: overall status + per-dependency objects.
// `service` names the web process itself (a string, NOT a dependency), `time`
// is a timestamp — neither must become a service entry.
const CSB_BASIC_BODY = {
  status: "ok",
  service: "claw-street-bets-web",
  time: "2026-09-16T00:00:00.000Z",
  db: { status: "reachable", latencyMs: 18 },
};

// A fake fetch that dispatches by URL, recording every probe. `full` and
// `basic` describe the respective routes' responses as
// { status, body? , html? } — an `html` marker makes res.json() throw (a
// Next.js 404/500 page is HTML, not JSON).
function fakeFetchByRoute(
  probes: string[],
  full: { status: number; body?: unknown; html?: boolean },
  basic: { status: number; body?: unknown; html?: boolean },
): typeof fetch {
  const respond = (spec: { status: number; body?: unknown; html?: boolean }) => ({
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    json: async () => {
      if (spec.html) throw new SyntaxError("Unexpected token < in JSON");
      return spec.body;
    },
  });
  return (async (url: string | URL | Request) => {
    const u = String(url);
    probes.push(u);
    if (u.endsWith("/api/health/full")) return respond(full);
    if (u.endsWith("/api/health")) return respond(basic);
    throw new Error(`unexpected probe URL: ${u}`);
  }) as unknown as typeof fetch;
}

describe("post-merge-health: health-route resolution — full first, basic fallback (issue #4524)", () => {
  test("full route 200 answers route:'full' (existing behaviour unchanged)", async () => {
    const res = await fetchTargetHealth(baseConfig(), fakeFetchOk({ status: "ok", services: {} }));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.route, "full");
      assert.equal(res.httpStatus, 200);
    }
  });

  test("full 404 (HTML) falls back to basic /api/health and samples the CSB shape", async () => {
    const probes: string[] = [];
    const f = fakeFetchByRoute(probes, { status: 404, html: true }, { status: 200, body: CSB_BASIC_BODY });
    const res = await fetchTargetHealth(baseConfig(), f);
    assert.equal(res.ok, true, "a Target serving only /api/health must still produce a sample, not a no-op");
    if (res.ok) {
      assert.equal(res.route, "basic");
      assert.equal(res.httpStatus, 200);
      assert.deepEqual(res.body, CSB_BASIC_BODY);
    }
    assert.equal(probes.length, 2, "exactly two probes: full first, then basic");
    assert.ok(probes[0]!.endsWith("/api/health/full"));
    assert.ok(probes[1]!.endsWith("/api/health"));
  });

  test("a full-route failure OTHER than 404 does NOT trigger the fallback (broken full route ≠ route absent)", async () => {
    const probes: string[] = [];
    const f = fakeFetchByRoute(probes, { status: 502, html: true }, { status: 200, body: CSB_BASIC_BODY });
    const res = await fetchTargetHealth(baseConfig(), f);
    assert.equal(res.ok, false, "a 502 error page on the full route is unreachable, not a basic-route signal");
    if (!res.ok) assert.ok(res.reason.includes("502"));
    assert.equal(probes.length, 1, "the basic route must NOT be probed — the fallback never masks a broken full route");
    assert.ok(probes[0]!.endsWith("/api/health/full"));
  });

  test("both routes absent (404 + 404) => unreachable, reason names both URLs", async () => {
    const probes: string[] = [];
    const f = fakeFetchByRoute(probes, { status: 404, html: true }, { status: 404, html: true });
    const res = await fetchTargetHealth(baseConfig(), f);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.reason.includes("/api/health/full"), "the full URL is named");
      assert.ok(res.reason.includes("/api/health"), "the basic URL is named");
      assert.ok(res.reason.includes("404"));
    }
    assert.equal(probes.length, 2);
  });

  test("full 404 + basic network error => unreachable, reason names both routes", async () => {
    const probes: string[] = [];
    const f = ((url: string | URL | Request) => {
      const u = String(url);
      probes.push(u);
      if (u.endsWith("/api/health/full")) {
        return { ok: false, status: 404, json: async () => Promise.reject(new SyntaxError("HTML")) };
      }
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await fetchTargetHealth(baseConfig(), f);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.reason.includes("unreachable"), "the basic-route network failure is the headline");
      assert.ok(res.reason.includes("/api/health/full"), "the fallback origin is named");
    }
    assert.equal(probes.length, 2);
  });

  test("the #1699 any-status-with-health-body rule applies on the BASIC route too (503 + health JSON is a sample)", async () => {
    const probes: string[] = [];
    const degraded = { ...CSB_BASIC_BODY, status: "degraded", db: { status: "unreachable", latencyMs: -1 } };
    const f = fakeFetchByRoute(probes, { status: 404, html: true }, { status: 503, body: degraded });
    const res = await fetchTargetHealth(baseConfig(), f);
    assert.equal(res.ok, true, "503 with a health body must be sampled, not discarded");
    if (res.ok) {
      assert.equal(res.route, "basic");
      assert.equal(res.httpStatus, 503);
    }
  });
});

describe("post-merge-health: basic-shape parsing + status-word normalisation (issue #4524)", () => {
  test("the CSB basic shape maps db as a service; a healthy db yields servicesNotOk=0", () => {
    const snap = parseHealthSnapshot(CSB_BASIC_BODY);
    assert.equal(snap.overall, "ok");
    assert.deepEqual(snap.services, { db: "ok" }, "reachable normalises to ok; service/time are not services");
    assert.equal(snap.servicesNotOk, 0);
    assert.equal(snap.executionErrors, 0);
    assert.equal(snap.providerErrors, 0);
  });

  test("status-word aliases normalise: healthy/up -> ok, down/unreachable -> error, unknown words preserved", () => {
    const snap = parseHealthSnapshot({
      status: "degraded",
      services: {
        cache: { status: "healthy" },
        queue: "up",
        primaryDb: { status: "down" },
        replica: { status: "unreachable" },
        featureX: { status: "unconfigured" },
      },
    });
    assert.equal(snap.services.cache, "ok");
    assert.equal(snap.services.queue, "ok");
    assert.equal(snap.services.primaryDb, "error");
    assert.equal(snap.services.replica, "error");
    assert.equal(snap.services.featureX, "unconfigured", "unknown words preserved (lowercased) and still rank not-ok");
    assert.equal(snap.servicesNotOk, 3);
    assert.equal(snap.executionErrors, 1, "primaryDb matches the db execution keyword");
    assert.equal(snap.providerErrors, 0);
  });

  test("a dead db on the basic shape parses to services.db='error' and counts execution-class", () => {
    const snap = parseHealthSnapshot({
      status: "ok",
      service: "claw-street-bets-web",
      time: "2026-09-16T00:00:00.000Z",
      db: { status: "unreachable", latencyMs: -1 },
    });
    assert.equal(snap.services.db, "error");
    assert.equal(snap.servicesNotOk, 1);
    assert.equal(snap.executionErrors, 1, "db is execution-class (issue #4524)");
  });

  test("full-shape bodies with extra dependency objects map them via the same generic rule", () => {
    const snap = parseHealthSnapshot({
      status: "ok",
      services: { scanner: { status: "ok" } },
      db: { status: "reachable" },
    });
    assert.deepEqual(snap.services, { scanner: "ok", db: "ok" });
  });
});

describe("post-merge-health: basic-shape delta regression (issue #4524)", () => {
  test("db reachable -> unreachable across a merge alarms in delta mode (execution-class, floor 0)", () => {
    const baseline = parseHealthSnapshot(CSB_BASIC_BODY);
    const current = parseHealthSnapshot({
      ...CSB_BASIC_BODY,
      db: { status: "unreachable", latencyMs: -1 },
    });
    const v = evaluateDelta(baseline, current, baseConfig());
    assert.equal(v.regressed, true, "a database going down post-merge must alarm even though the overall status stays 'ok'");
    assert.ok(v.reasons.some((r: string) => r.includes("db: ok -> error")), `delta named: ${v.reasons.join(" | ")}`);
    assert.ok(v.reasons.some((r: string) => r.includes("execution-class")));
  });

  test("an identical basic-shape state pre/post-merge does not alarm (ambient parity)", () => {
    const snap = parseHealthSnapshot(CSB_BASIC_BODY);
    assert.equal(evaluateDelta(snap, snap, baseConfig()).regressed, false);
  });
});

describe("post-merge-health: runWatch end-to-end on a basic-route-only Target (issue #4524)", () => {
  test("--snapshot-out then --baseline round-trip works when only /api/health exists (the smoke-build no-op fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-csb-"));
    const baselinePath = join(dir, "baseline.json");

    const pre = await runWatch(
      { ...baseConfig(), dispatch: true },
      { snapshotOut: baselinePath },
      {
        fetchImpl: fakeFetchByRoute([], { status: 404, html: true }, { status: 200, body: CSB_BASIC_BODY }),
      },
    );
    assert.equal(pre.kind, "baseline-written", "the pre-merge baseline captures the basic-route sample");
    if (pre.kind === "baseline-written") {
      assert.equal(pre.snapshot.services.db, "ok");
    }
    assert.ok(existsSync(baselinePath));

    // Post-merge: the database goes down => alarm + dispatch in delta mode.
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawnSpy = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;
    const post = await runWatch(
      { ...baseConfig(), dispatch: true },
      { mergeSha: "csbfail", baselinePath },
      {
        fetchImpl: fakeFetchByRoute(
          [],
          { status: 404, html: true },
          { status: 200, body: { ...CSB_BASIC_BODY, db: { status: "unreachable", latencyMs: -1 } } },
        ),
        spawnImpl: spawnSpy,
      },
    );
    assert.equal(post.kind, "alarm");
    if (post.kind === "alarm") {
      assert.equal(post.mode, "delta");
      assert.equal(post.dispatched, true);
    }
    assert.equal(calls.length, 1);
    const joined = calls[0]!.args.join(" ");
    assert.ok(joined.includes("db=error"), "the incident context names the failing dependency");
  });
});

describe("post-merge-health: unreachable is a loud, explicit failure (issue #4524)", () => {
  // Capture console.error lines so the loud wording is pinned, restoring the
  // original in a finally so failures cannot swallow the stream.
  function captureError(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return Promise.resolve(fn()).finally(() => {
      console.error = orig;
    }).then(() => lines);
  }

  test("post-merge unreachable logs PROBE FAILURE naming both URLs and HYDRA_TARGET_WEB_URL; no dispatch, no throw", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const lines = await captureError(() =>
      runWatch(
        { ...baseConfig(), dispatch: true },
        { mergeSha: "down4524" },
        { fetchImpl: fakeFetchThrows("ECONNREFUSED"), spawnImpl: spawnSpy },
      ),
    );
    const line = lines.find((l) => l.includes("PROBE FAILURE"));
    assert.ok(line, `a PROBE FAILURE line is logged among: ${lines.join(" || ")}`);
    assert.ok(line.includes("/api/health/full (and "), "both probed URLs are named");
    assert.ok(line.includes("/api/health)"), "the basic URL is named");
    assert.ok(line.includes("HYDRA_TARGET_WEB_URL"), "the knob that resolves the base URL is named");
    assert.ok(!lines.some((l) => l.includes("no-op:")), "the quiet no-op wording is gone");
    assert.equal(spawned, false, "unreachable must still never dispatch hydra-target-incident");
  });

  test("snapshot-mode unreachable logs BASELINE FAILURE and warns Step 8.6 will run without a baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pmh-unreach-snap-"));
    const baselinePath = join(dir, "baseline.json");
    const lines = await captureError(() =>
      runWatch(
        baseConfig(),
        { snapshotOut: baselinePath },
        { fetchImpl: fakeFetchThrows("ECONNREFUSED") },
      ),
    );
    const line = lines.find((l) => l.includes("BASELINE FAILURE"));
    assert.ok(line, `a BASELINE FAILURE line is logged among: ${lines.join(" || ")}`);
    assert.ok(line.includes("Step 8.6 will run without a baseline"));
    assert.ok(line.includes("HYDRA_TARGET_WEB_URL"));
    assert.equal(existsSync(baselinePath), false, "no baseline written when unreachable");
  });

  test("both routes 404 => explicit unreachable result naming both URLs, no dispatch, no throw", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      { ...baseConfig(), dispatch: true },
      {},
      { fetchImpl: fakeFetchByRoute([], { status: 404, html: true }, { status: 404, html: true }), spawnImpl: spawnSpy },
    );
    assert.equal(result.kind, "unreachable");
    if (result.kind === "unreachable") {
      assert.ok(result.reason.includes("/api/health/full"));
      assert.ok(result.reason.includes("/api/health"));
    }
    assert.equal(spawned, false);
  });
});
