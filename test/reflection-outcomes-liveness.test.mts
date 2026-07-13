/**
 * reflection-outcomes-liveness.test.mts — the retired reflection-outcomes
 * ledger liveness probe + rule (issue #3251).
 *
 * Two pure surfaces, no Redis (the ledger PROBE that reads Redis is stubbed at
 * the fan-out seam in health-fan-out.test.mts; here we test the pure projection
 * and the pure deep-health rule):
 *   1. projectReflectionOutcomesLiveness — raw ledger state → liveness report.
 *   2. the deep-health reflection-outcomes rule — report → diagnostic|null.
 *
 * A top-level suite with no shared-Redis lifecycle (CLAUDE.md authoring rule):
 * both surfaces are pure functions, so there is nothing to set up or tear down.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  projectReflectionOutcomesLiveness,
  REFLECTION_OUTCOMES_FRESH_MS,
} from "../src/health/reflection-outcomes-liveness.ts";
import { assessHealth, type HealthSnapshot } from "../src/health/diagnostics.ts";

// A minimal healthy snapshot (every rule no-ops) so we can drive ONLY the
// reflection-outcomes rule by mutating `reflectionOutcomesLiveness`. Kept local
// to this file so it stays independent of the diagnostics test's builder.
function baseSnapshot(): HealthSnapshot {
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
    svcProbes: { vikingdb: { status: "running" }, openviking: { status: "running" } },
    queueDepth: 3,
    blCounts: { triage: 0, backlog: 2, inProgress: 1, blocked: 0, done: 5, total: 3 },
    patterns: { planner: 4, executor: 6, skeptic: 2 },
    reflCount: 12,
    // Issue #3270: a non-zero count keeps the attribution-ledger-dark rule silent
    // in this file (the test only drives the reflection-outcomes rule).
    attributionLedgerCount: 1,
    reflectionHealth: {
      sampleSize: 20,
      distribution: { both: 5, none: 15 },
      reflectionSourcesPresent: 5,
      verdict: "healthy",
      note: "deposit plumbing live",
    },
    skillCatalog: {
      skills: [],
      registered: 4,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
    },
    darkOutcomes: [],
    reflectionOutcomesLiveness: {
      verdict: "retired-empty",
      count: 0,
      latestEntryMs: null,
      ageMs: null,
      note: "retired-empty",
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

const NOW = 2_000_000_000_000; // fixed clock

describe("projectReflectionOutcomesLiveness (issue #3251)", () => {
  test("absent ledger → retired-empty", () => {
    const r = projectReflectionOutcomesLiveness(
      { present: false, count: 0, latestEntryMs: null },
      { now: () => NOW },
    );
    assert.equal(r.verdict, "retired-empty");
    assert.equal(r.count, 0);
    assert.equal(r.latestEntryMs, null);
    assert.equal(r.ageMs, null);
  });

  test("present but count 0 → retired-empty (honest-none)", () => {
    const r = projectReflectionOutcomesLiveness(
      { present: true, count: 0, latestEntryMs: NOW },
      { now: () => NOW },
    );
    assert.equal(r.verdict, "retired-empty");
  });

  test("present, stale tail (older than fresh window) → retired-frozen-tail", () => {
    const latest = NOW - (REFLECTION_OUTCOMES_FRESH_MS + 60_000);
    const r = projectReflectionOutcomesLiveness(
      { present: true, count: 5, latestEntryMs: latest },
      { now: () => NOW },
    );
    assert.equal(r.verdict, "retired-frozen-tail");
    assert.equal(r.count, 5);
    assert.equal(r.latestEntryMs, latest);
    assert.ok((r.ageMs ?? 0) >= REFLECTION_OUTCOMES_FRESH_MS);
  });

  test("present with an unparseable/null score → retired-frozen-tail (not fresh)", () => {
    const r = projectReflectionOutcomesLiveness(
      { present: true, count: 2, latestEntryMs: null },
      { now: () => NOW },
    );
    assert.equal(r.verdict, "retired-frozen-tail");
    assert.equal(r.ageMs, null);
  });

  test("present, fresh tail (within fresh window) → unexpected-live-tail", () => {
    const latest = NOW - 60_000; // 1 minute ago, well within 24h
    const r = projectReflectionOutcomesLiveness(
      { present: true, count: 1, latestEntryMs: latest },
      { now: () => NOW },
    );
    assert.equal(r.verdict, "unexpected-live-tail");
    assert.ok((r.ageMs ?? Infinity) < REFLECTION_OUTCOMES_FRESH_MS);
  });

  test("the fresh window boundary is exclusive (exactly freshMs old → frozen)", () => {
    const latest = NOW - REFLECTION_OUTCOMES_FRESH_MS; // exactly at the boundary
    const r = projectReflectionOutcomesLiveness(
      { present: true, count: 1, latestEntryMs: latest },
      { now: () => NOW },
    );
    assert.equal(r.verdict, "retired-frozen-tail");
  });
});

describe("deep-health reflection-outcomes rule (issue #3251)", () => {
  function diag(mut: (s: HealthSnapshot) => void) {
    const s = baseSnapshot();
    mut(s);
    return assessHealth(s).diagnostics.find(
      (d) => d.component === "intelligence" && /reflection-outcomes ledger/i.test(d.what),
    );
  }

  test("retired-empty fires NOTHING (fully swept, nothing to explain)", () => {
    const s = baseSnapshot(); // default is retired-empty
    const a = assessHealth(s);
    assert.equal(a.status, "healthy");
    assert.equal(a.diagnostics.length, 0);
  });

  test("retired-frozen-tail fires a single INFO explaining the retirement", () => {
    const d = diag((s) => {
      s.reflectionOutcomesLiveness = {
        verdict: "retired-frozen-tail",
        count: 4,
        latestEntryMs: NOW - REFLECTION_OUTCOMES_FRESH_MS * 2,
        ageMs: REFLECTION_OUTCOMES_FRESH_MS * 2,
        note: "frozen tail",
      };
    });
    assert.ok(d, "expected a reflection-outcomes diagnostic");
    assert.equal(d!.severity, "info");
    assert.equal(d!.autoRecovery, true);
    // The action must tell the operator this is NOT a bug to re-file.
    assert.match(d!.action, /No action needed|#3251/);
  });

  test("a retired-frozen-tail INFO keeps overall status healthy (info never escalates)", () => {
    const s = baseSnapshot();
    s.reflectionOutcomesLiveness = {
      verdict: "retired-frozen-tail",
      count: 4,
      latestEntryMs: NOW,
      ageMs: REFLECTION_OUTCOMES_FRESH_MS * 2,
      note: "frozen tail",
    };
    const a = assessHealth(s);
    // A lone info diagnostic folds to `degraded`, never unhealthy/critical.
    assert.equal(a.status, "degraded");
    assert.ok(a.diagnostics.every((d) => d.severity === "info"));
  });

  test("unexpected-live-tail fires a WARNING naming the surprising writer", () => {
    const d = diag((s) => {
      s.reflectionOutcomesLiveness = {
        verdict: "unexpected-live-tail",
        count: 2,
        latestEntryMs: NOW - 60_000,
        ageMs: 60_000,
        note: "fresh write, no writer",
      };
    });
    assert.ok(d, "expected a reflection-outcomes diagnostic");
    assert.equal(d!.severity, "warning");
    assert.equal(d!.autoRecovery, false);
    assert.match(d!.why, /no writer|unexpectedly/i);
  });
});
