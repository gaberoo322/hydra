/**
 * test/health-skill-rule.test.mts — the #1968 skill-catalog Health-Assessment rule.
 *
 * The standalone GET /api/health/skills endpoint surfaces the empty/partial OV
 * skill catalog, but QA flagged that the FAILURE never folded into the deep-health
 * Health Assessment: an operator watching /api/health/deep (or hydra-doctor, which
 * reads that fold) saw a clean `status` even when startup skill registration lost
 * every skill to OpenViking timeouts. The fix added a rule to src/health/rules.ts
 * that reads the in-process skill-catalog state via getSkillCatalogState() and
 * folds assessSkillCatalog()'s verdict into assessHealth's diagnostics + status.
 *
 * This file lives apart from test/health-diagnostics.test.mts on purpose: the rule
 * reads a MODULE SINGLETON (the catalog state populated by registerSkills), which
 * has no public reset. Driving it here — in its own test process — keeps the
 * mutation from polluting that file's "fully-healthy snapshot fires zero
 * diagnostics" baseline. We drive the singleton through registerSkills with a
 * stubbed globalThis.fetch (same lever test/skill-registration.test.mts uses).
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { assessHealth, type HealthSnapshot } from "../src/health/diagnostics.ts";
import { assessRegistrationFailureRate } from "../src/health/skill-catalog.ts";
import { registerSkills } from "../src/knowledge-base/skill-registration.ts";

const realFetch = globalThis.fetch;
const realErr = console.error;
const realLog = console.log;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
  console.log = realLog;
});

function muteConsole() {
  console.error = () => {};
  console.log = () => {};
}

// Issue #2277: registerSkills now pre-flights the Ollama VLM liveness probe and
// DEFERS (POSTs nothing) when it is down. These tests drive the OV-reachable
// failure/success paths through the stubbed fetch, so they inject a VLM-up probe
// to bypass the deferral short-circuit; the deferral path has its own coverage in
// test/skill-registration.test.mts.
const vlmUp = async () => ({ status: "ok" as const, latencyMs: 5 });

function okResponse(): any {
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}

/** A fetch throw the OV adapter classifies as `ov-timeout`. */
function timeoutThrow(): never {
  const err: any = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  throw err;
}

// A fully-healthy snapshot (mirrors test/health-diagnostics.test.mts' baseline).
// Every other rule is satisfied so any fired diagnostic is attributable to the
// skill-catalog rule alone.
function healthySnapshot(): HealthSnapshot {
  return {
    health: { status: "ok", redis: true, cycle: "idle", uptime: 3600 },
    sched: {
      running: true,
      cyclesRun: 10,
      cyclesMerged: 8,
      cyclesFailed: 2,
      mergeRate: 80,
      consecutiveErrors: 0,
      lastError: null,
      lastCycleAt: new Date().toISOString(),
    },
    svcProbes: {
      vikingdb: { status: "running" },
      openviking: { status: "running" },
    },
    queueDepth: 3,
    blCounts: { triage: 0, backlog: 2, inProgress: 1, blocked: 0, done: 5, total: 3 },
    patterns: { planner: 4, executor: 6, skeptic: 2 },
    reflCount: 12,
    ovSearch: { status: "running", latencyMs: 40, resultCount: 3 },
    ollamaVlm: { status: "ok", latencyMs: 12 },
    redisInfo: { memoryHuman: "12M", connectedClients: 4, uptimeSeconds: 9999 },
    emergencyBrake: { engaged: false },
    disk: { availableGb: 120, totalGb: 500, usedPercent: 60 },
    mem: { totalGb: 32, availableGb: 20, usedPercent: 40 },
    sysd: { orchestrator: "active", watchdog: "active", targetWeb: "active" },
    recent: {
      cycleCount: 10,
      mergeRate: 80,
      failedRate: 10,
      noTaskRate: 10,
      revertRate: 0,
      mergedN: 8,
      noTaskN: 1,
      revertN: 0,
      avgDurationMs: 45000,
      avgDurationHuman: "45s",
    },
  };
}

function skillDiag(s: HealthSnapshot) {
  return assessHealth(s).diagnostics.find((d) => d.what.startsWith("OV skill catalog"));
}

// NOTE: ordering is load-bearing. The singleton starts `completed:false`, so the
// no-pass case must be asserted BEFORE any registerSkills() call mutates it. The
// empty-catalog case mutates the singleton into a completed-empty state, so it
// runs LAST (a later test reading the snapshot would otherwise inherit it).

describe("skill-catalog Health-Assessment rule (#1968)", () => {
  test("before any registration pass → no diagnostic, status stays healthy", () => {
    // Fresh process: getSkillCatalogState().completed === false, so the gate
    // returns null and the deep-health fold reports healthy. A slow startup must
    // not be a false alarm.
    const a = assessHealth(healthySnapshot());
    assert.equal(a.status, "healthy");
    assert.equal(skillDiag(healthySnapshot()), undefined);
  });

  test("an all-success pass → no diagnostic (catalog populated)", async () => {
    muteConsole();
    globalThis.fetch = (async () => okResponse()) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    const a = assessHealth(healthySnapshot());
    assert.equal(skillDiag(healthySnapshot()), undefined);
    assert.equal(a.status, "healthy", "a full catalog must not degrade deep-health");
  });

  test("a partial-failure pass → warning folded into status:degraded", async () => {
    muteConsole();
    // First skill burns its 3 attempts (ov-timeout); the rest succeed first try.
    let firstSkillCalls = 0;
    globalThis.fetch = (async () => {
      if (firstSkillCalls < 3) {
        firstSkillCalls++;
        timeoutThrow();
      }
      return okResponse();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    const d = skillDiag(healthySnapshot());
    assert.ok(d, "a partial catalog must fire a diagnostic");
    assert.equal(d!.severity, "warning");
    assert.equal(d!.component, "intelligence");
    assert.match(d!.what, /partial \(3\/4\)/);
    // A warning is the worst severity on an otherwise-healthy snapshot → degraded.
    assert.equal(assessHealth(healthySnapshot()).status, "degraded");
  });

  test("an all-failure pass → error folded into status:unhealthy", async () => {
    muteConsole();
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    const d = skillDiag(healthySnapshot());
    assert.ok(d, "an empty catalog must fire a diagnostic");
    assert.equal(d!.severity, "error");
    assert.equal(d!.component, "intelligence");
    assert.equal(d!.what, "OV skill catalog empty");
    // An error is the worst severity on an otherwise-healthy snapshot → unhealthy.
    assert.equal(assessHealth(healthySnapshot()).status, "unhealthy");
  });
});

// Issue #2277: the registration-FAILURE-RATE alert. Driven through the SAME
// module-singleton lever (registerSkills with a stubbed fetch) as the population
// rule above, but asserted via the pure assessRegistrationFailureRate() function
// so the VLM-down vs VLM-ok branch is exercised deterministically without
// depending on a particular probe field on the deep-health snapshot.
//
// This is a NEW top-level describe with its own afterEach restore (it does not
// piggyback the population suite's lifecycle). Ordering note: it mutates the
// SAME singleton as the suite above, so it asserts only via getSkillCatalogState
// reads it performs itself — it never relies on the singleton's pre-state.

function failRateDiag(s: HealthSnapshot) {
  return assessHealth(s).diagnostics.find((d) =>
    d.what.startsWith("OV skill registration failure rate"),
  );
}

describe("skill-registration failure-rate alert (#2277)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realErr;
    console.log = realLog;
  });

  test("pure: fully-registered catalog (0% failed) → no alert", () => {
    const ok = assessRegistrationFailureRate(
      { registered: 4, total: 4, completed: true, skills: [] },
      { status: "ok" },
    );
    assert.equal(ok, null, "0% failure rate must not alert");
  });

  test("pure: no completed pass → no alert (registration still in flight)", () => {
    assert.equal(
      assessRegistrationFailureRate(
        { registered: 0, total: 4, completed: false, skills: [] },
        { status: "down" },
      ),
      null,
    );
  });

  test("pure: total 0 → no alert (no meaningful rate)", () => {
    assert.equal(
      assessRegistrationFailureRate(
        { registered: 0, total: 0, completed: true, skills: [] },
        { status: "down" },
      ),
      null,
    );
  });

  test("pure: failure rate above threshold + VLM down → warning naming the VLM root cause", () => {
    const d = assessRegistrationFailureRate(
      { registered: 0, total: 4, completed: true, skills: [] },
      { status: "down" },
    );
    assert.ok(d, "100% failed must alert");
    // `warning` so it annotates the population verdict without escalating the fold.
    assert.equal(d!.severity, "warning");
    assert.equal(d!.component, "intelligence");
    assert.match(d!.what, /failure rate 100% \(4\/4 failed\)/);
    assert.match(d!.why, /Ollama VLM backend/);
    assert.match(d!.action, /ollama-recovery\.md/);
    assert.equal(d!.autoRecovery, true, "VLM-down path recovers via the hourly chore");
  });

  test("pure: failure rate above threshold + VLM ok → error pointing at OpenViking load, NOT the VLM", () => {
    const d = assessRegistrationFailureRate(
      { registered: 3, total: 4, completed: true, skills: [] },
      { status: "ok" },
    );
    assert.ok(d, "25% failed must alert");
    assert.match(d!.what, /failure rate 25% \(1\/4 failed\)/);
    assert.match(d!.why, /NOT the usual VLM-offline cascade/);
    assert.match(d!.action, /OpenViking load/);
    assert.equal(d!.autoRecovery, false);
  });

  test("wired: an all-failure pass + VLM-down snapshot → failure-rate alert folds into status", async () => {
    muteConsole();
    globalThis.fetch = (async () => {
      timeoutThrow();
    }) as any;
    await registerSkills({ backoffBaseMs: 0, probeVlm: vlmUp });

    const snap = healthySnapshot();
    snap.ollamaVlm = { status: "down", latencyMs: 5000, error: "timeout" };
    const d = failRateDiag(snap);
    assert.ok(d, "a wired all-failure pass with VLM down must fire the failure-rate alert");
    assert.equal(d!.severity, "warning");
    assert.match(d!.why, /Ollama VLM backend/);
    // The population rule fires `error` (empty catalog) on this same pass → the
    // fold stays unhealthy from THAT error; the failure-rate `warning` annotates
    // it without escalating further.
    assert.equal(assessHealth(snap).status, "unhealthy");
  });
});
