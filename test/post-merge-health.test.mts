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
 * The script's I/O (fetch, spawn) is injected so the tests run hermetically with
 * no network and no real `claude` process. Baseline files use a per-test
 * tmpdir — plain node:fs, mirroring the script's stdlib-only constraint.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("--baseline pointing at a missing file => absolute-threshold fallback (mode: absolute)", async () => {
    let spawned = false;
    const spawnSpy = (() => {
      spawned = true;
      return { unref() {}, on() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const result = await runWatch(
      baseConfig(), // dispatch defaults false (dry-run)
      { baselinePath: join(tmpdir(), "pmh-missing-baseline", "nope.json") },
      {
        fetchImpl: fakeFetchOk({ status: "degraded", services: { scanner: { status: "error" } } }),
        spawnImpl: spawnSpy,
      },
    );
    // Absolute semantics: one execution-class error breaches the zero floor.
    assert.equal(result.kind, "alarm");
    if (result.kind === "alarm") assert.equal(result.mode, "absolute");
    assert.equal(spawned, false);
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
