/**
 * test/health-skill-rule.test.mts — the skill-catalog Health-Assessment rules.
 *
 * The standalone GET /api/health/skills endpoint surfaces the empty/partial OV
 * skill catalog, but the FAILURE must ALSO fold into the deep-health Health
 * Assessment so an operator watching /api/health/deep (or hydra-doctor, which
 * reads that fold) sees a non-clean `status` when startup skill registration lost
 * skills to OpenViking timeouts. Two rules in src/health/rules.ts cover this:
 * the #1968 population gate (assessSkillCatalog) and the #2277 registration-
 * failure-rate alert (assessRegistrationFailureRate).
 *
 * Issue #2386: the skill-catalog STATE now rides on `HealthSnapshot.skillCatalog`
 * (assembled at fan-out time in collectProbeInputs), so the two rules are pure
 * functions over the snapshot — they no longer read the in-process singleton via
 * getSkillCatalogState(). That makes these rules testable EXACTLY like every
 * other health rule: construct a HealthSnapshot with a controlled `skillCatalog`
 * field and assert the folded diagnostic. No more registerSkills lifecycle
 * dependency, no stubbed globalThis.fetch, and no module-singleton-ordering
 * caveat — the whole reason this file used to live apart from
 * test/health-diagnostics.test.mts. (The end-to-end live read in collectProbeInputs
 * is covered by test/health-fan-out.test.mts; the pure assessors themselves by
 * test/health-skill-catalog.test.mts.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessHealth, type HealthSnapshot } from "../src/health/diagnostics.ts";
import type { SkillCatalogState } from "../src/knowledge-base/skill-registration.ts";

// A fully-healthy snapshot (mirrors test/health-diagnostics.test.mts' baseline).
// Every other rule is satisfied so any fired diagnostic is attributable to a
// skill-catalog rule alone. The default skillCatalog is fully-registered, so
// both skill-catalog rules no-op until a case overrides it.
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
    // Issue #3270: a non-zero count keeps the attribution-ledger-dark rule silent.
    attributionLedgerCount: 1,
    // Issue #2492: a `healthy` reflection-deposit verdict — the reflection rule
    // fires only on `served-but-bucketed-none`, so this baseline stays clean.
    reflectionHealth: {
      sampleSize: 20,
      distribution: { both: 5, none: 15 },
      reflectionSourcesPresent: 5,
      verdict: "healthy",
      note: "Reflection context reached 5/20 recent cycles; deposit plumbing is live.",
    },
    // Issue #2386: fully-registered catalog by default → both skill-catalog rules
    // no-op. Cases override `skillCatalog` to drive the empty/partial/failure-rate
    // verdicts directly off the snapshot, no module-singleton mutation.
    skillCatalog: {
      skills: [],
      registered: 4,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: false,
    },
    // Issue #2805: no dark leading outcomes by default — the dark-outcome rule
    // no-ops, keeping this baseline clean for skill-catalog-rule assertions.
    darkOutcomes: [],
    // Issue #3251: retired-empty reflection-outcomes ledger — the
    // reflection-outcomes rule no-ops, keeping this baseline clean for the
    // skill-catalog-rule assertions.
    reflectionOutcomesLiveness: {
      verdict: "retired-empty",
      count: 0,
      latestEntryMs: null,
      ageMs: null,
      note: "Retired reflection-outcomes ledger is empty/absent — expected.",
    },
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

/** Clone the healthy snapshot, mutating `skillCatalog` to drive a case. */
function withCatalog(catalog: SkillCatalogState): HealthSnapshot {
  const s = healthySnapshot();
  s.skillCatalog = catalog;
  return s;
}

function skillDiag(s: HealthSnapshot) {
  return assessHealth(s).diagnostics.find((d) => d.what.startsWith("OV skill catalog"));
}

function failRateDiag(s: HealthSnapshot) {
  return assessHealth(s).diagnostics.find((d) =>
    d.what.startsWith("OV skill registration failure rate"),
  );
}

function attributionLedgerDiag(s: HealthSnapshot) {
  return assessHealth(s).diagnostics.find((d) => d.what.startsWith("Attribution ledger is empty"));
}

// Issue #2386: every case reads `skillCatalog` off the snapshot, so cases are now
// fully order-independent — no shared singleton to mutate, unlike the pre-#2386
// registerSkills-driven version where the empty-catalog case had to run last.

describe("skill-catalog Health-Assessment population rule (#1968, snapshot-sourced #2386)", () => {
  test("before any registration pass → no diagnostic, status stays healthy", () => {
    // completed:false → the gate returns null and the deep-health fold reports
    // healthy. A slow startup must not be a false alarm.
    const s = withCatalog({
      skills: [],
      registered: 0,
      total: 4,
      completed: false,
      lastAttemptAt: null,
      vlmDeferred: false,
      skillsDeferred: false,
    });
    assert.equal(assessHealth(s).status, "healthy");
    assert.equal(skillDiag(s), undefined);
  });

  test("an all-success pass → no diagnostic (catalog populated)", () => {
    // Default healthy catalog is fully registered.
    const s = healthySnapshot();
    assert.equal(skillDiag(s), undefined);
    assert.equal(assessHealth(s).status, "healthy", "a full catalog must not degrade deep-health");
  });

  test("a partial-failure pass → warning folded into status:degraded", () => {
    const s = withCatalog({
      skills: [
        { name: "planner", registered: false, lastError: "ov-timeout", lastSuccessAt: null },
        { name: "executor", registered: true, lastError: null, lastSuccessAt: Date.now() },
        { name: "skeptic", registered: true, lastError: null, lastSuccessAt: Date.now() },
        { name: "director", registered: true, lastError: null, lastSuccessAt: Date.now() },
      ],
      registered: 3,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: false,
    });
    const d = skillDiag(s);
    assert.ok(d, "a partial catalog must fire a diagnostic");
    assert.equal(d!.severity, "warning");
    assert.equal(d!.component, "intelligence");
    assert.match(d!.what, /partial \(3\/4\)/);
    // A warning is the worst severity on an otherwise-healthy snapshot → degraded.
    assert.equal(assessHealth(s).status, "degraded");
  });

  test("an all-failure pass → error folded into status:unhealthy", () => {
    const s = withCatalog({
      skills: [],
      registered: 0,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: false,
    });
    const d = skillDiag(s);
    assert.ok(d, "an empty catalog must fire a diagnostic");
    assert.equal(d!.severity, "error");
    assert.equal(d!.component, "intelligence");
    assert.equal(d!.what, "OV skill catalog empty");
    // An error is the worst severity on an otherwise-healthy snapshot → unhealthy.
    assert.equal(assessHealth(s).status, "unhealthy");
  });
});

// Issue #2277/#2386: the registration-FAILURE-RATE alert, now driven entirely off
// the snapshot's `skillCatalog` + `ollamaVlm` fields — no singleton, no fetch
// stub. The VLM-down vs VLM-ok branch is exercised by setting `ollamaVlm.status`.

describe("skill-registration failure-rate alert (#2277, snapshot-sourced #2386)", () => {
  test("fully-registered catalog (0% failed) → no alert", () => {
    // The default healthy catalog is 4/4 registered.
    assert.equal(failRateDiag(healthySnapshot()), undefined, "0% failure rate must not alert");
  });

  test("failure rate above threshold + VLM down → warning naming the VLM root cause", () => {
    const s = withCatalog({
      skills: [],
      registered: 0,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: false,
    });
    s.ollamaVlm = { status: "down", latencyMs: 5000, error: "timeout" };
    const d = failRateDiag(s);
    assert.ok(d, "100% failed must alert");
    // `warning` so it annotates the population verdict without escalating the fold.
    assert.equal(d!.severity, "warning");
    assert.equal(d!.component, "intelligence");
    assert.match(d!.what, /failure rate 100% \(4\/4 failed\)/);
    assert.match(d!.why, /Ollama VLM backend/);
    assert.match(d!.action, /ollama-recovery\.md/);
    assert.equal(d!.autoRecovery, true, "VLM-down path recovers via the hourly chore");
    // The population rule fires `error` (empty catalog) on this same snapshot →
    // the fold stays unhealthy from THAT error; the failure-rate `warning`
    // annotates it without escalating further.
    assert.equal(assessHealth(s).status, "unhealthy");
  });

  test("failure rate above threshold + VLM ok → warning pointing at OpenViking load, NOT the VLM", () => {
    const s = withCatalog({
      skills: [],
      registered: 3,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: false,
    });
    // ollamaVlm defaults to status:ok in healthySnapshot().
    const d = failRateDiag(s);
    assert.ok(d, "25% failed must alert");
    assert.match(d!.what, /failure rate 25% \(1\/4 failed\)/);
    assert.match(d!.why, /NOT the usual VLM-offline cascade/);
    assert.match(d!.action, /OpenViking load/);
    assert.equal(d!.autoRecovery, false);
  });

  test("vlm-deferred pass → no failure-rate alert (deliberate degradation, not failed registration)", () => {
    // vlmDeferred:true means registration was SKIPPED, not failed — the failure-
    // rate framing would be misleading, so the alert suppresses (assessRegistration-
    // FailureRate's #2277 short-circuit).
    const s = withCatalog({
      skills: [],
      registered: 0,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: true,
      skillsDeferred: false,
    });
    s.ollamaVlm = { status: "down", latencyMs: 5000, error: "timeout" };
    assert.equal(failRateDiag(s), undefined, "a deferred pass must not fire the failure-rate alert");
  });

  test("skills-deferred pass → no failure-rate alert (deliberate degradation, not failed registration)", () => {
    // Issue #3402: skillsDeferred:true means the OpenViking /api/v1/skills handler
    // was load-gated at startup and registration was SKIPPED, not failed — nothing
    // was POSTed, so a "100% failure rate" framing would be misleading. The alert
    // must suppress (assessRegistrationFailureRate's #3402 short-circuit), exactly
    // like the vlmDeferred path above. Note vlmDeferred:false here so this asserts
    // the NEW skillsDeferred guard, not the pre-existing vlmDeferred one.
    const s = withCatalog({
      skills: [],
      registered: 0,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: true,
    });
    // VLM reachable — so absent the skillsDeferred guard the 100%-failed catalog
    // would fire the OpenViking-load failure-rate alert; the guard suppresses it.
    assert.equal(
      failRateDiag(s),
      undefined,
      "a skills-deferred pass must not fire the failure-rate alert",
    );
  });
});

// Issue #3270: the attribution-ledger-dark rule (src/health/rules.ts). It is a
// PURE function of `HealthSnapshot.attributionLedgerCount` — fires a `warning`
// when the count is 0 (the merger→ledger producer flow never fired, the exact
// symptom #3270 diagnoses) and stays silent for any count > 0. The end-to-end
// live LLEN read is covered by test/health-fan-out.test.mts; THIS suite pins the
// rule in isolation off a controlled snapshot, exactly like the skill-catalog
// rules above (no Redis seam, so no shared-connection teardown to piggyback on).
describe("attribution-ledger-dark rule (#3270, snapshot-sourced)", () => {
  test("attributionLedgerCount:0 → warning folded into status:degraded", () => {
    const s = healthySnapshot();
    s.attributionLedgerCount = 0;
    const d = attributionLedgerDiag(s);
    assert.ok(d, "an empty attribution ledger must fire a diagnostic");
    assert.equal(d!.severity, "warning");
    assert.equal(d!.component, "intelligence");
    assert.equal(d!.what, "Attribution ledger is empty — merger→ledger flow never fired");
    assert.equal(d!.autoRecovery, false);
    // A warning is the worst severity on an otherwise-healthy snapshot → degraded.
    assert.equal(assessHealth(s).status, "degraded");
  });

  test("attributionLedgerCount>0 → no diagnostic, status stays healthy", () => {
    // healthySnapshot() baselines attributionLedgerCount:1 — a populated ledger.
    const s = healthySnapshot();
    assert.equal(s.attributionLedgerCount, 1, "baseline sanity: a populated ledger");
    assert.equal(attributionLedgerDiag(s), undefined, "a populated ledger must not fire");
    assert.equal(assessHealth(s).status, "healthy", "a populated ledger must not degrade deep-health");
  });

  test("a larger populated count (>1) also stays silent", () => {
    const s = healthySnapshot();
    s.attributionLedgerCount = 42;
    assert.equal(attributionLedgerDiag(s), undefined, "count 42 must not fire");
    assert.equal(assessHealth(s).status, "healthy");
  });
});
