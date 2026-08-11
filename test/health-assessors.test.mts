/**
 * Unit tests for the named health assessors (issue #3634).
 *
 * The four complex multi-policy rule bodies were extracted out of the RULES array
 * in src/health/rules.ts into named assessor functions in src/health/assessors.ts,
 * mirroring the src/health/skill-catalog.ts precedent (assessSkillCatalog /
 * assessRegistrationFailureRate). Each assessor is a PURE function of a NARROW
 * HealthSnapshot slice returning HealthDiagnostic | null, so a test stubs only the
 * fields the assessor reads — no full 30-field snapshot, no Redis / OV / HTTP.
 *
 * These are pure functions (no Redis, no teardown coupling), so each lives in its
 * own top-level describe with no before/after lifecycle — the leverage the issue
 * names: today these rules are only reachable through the full assessHealth pipeline.
 *
 * The end-to-end fold (that each RULES pass-through emits the SAME diagnostic in the
 * SAME slot) is covered by test/health-diagnostics.test.mts; these tests pin the
 * per-assessor policy (the dark case AND the honest-none no-op case) in isolation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assessReflectionHealth,
  assessDarkLeadingOutcomes,
  assessAttributionLedger,
} from "../src/health/assessors.ts";
import type { ServiceProbeMap } from "../src/health/types.ts";
import type { ReflectionHealthReport } from "../src/metrics/reflection-health.ts";
import type { OutcomeVerdict } from "../src/scheduler/chores/wiring-liveness-outcomes.ts";

describe("assessReflectionHealth (#2492)", () => {
  const report = (verdict: ReflectionHealthReport["verdict"], note = "n"): ReflectionHealthReport => ({
    sampleSize: 10,
    distribution: {},
    reflectionSourcesPresent: 0,
    verdict,
    note,
  });

  test("fires a single INFO on served-but-bucketed-none, carrying the note", () => {
    const d = assessReflectionHealth(report("served-but-bucketed-none", "a deposit landed but bucketed none"));
    assert.ok(d, "expected a diagnostic on served-but-bucketed-none");
    assert.equal(d.severity, "info");
    assert.equal(d.component, "intelligence");
    assert.equal(d.what, "Reflection deposit served but bucketed 'none'");
    assert.equal(d.why, "a deposit landed but bucketed none");
    assert.equal(d.autoRecovery, true);
  });

  test("no-op on the honest all-none-empty-store verdict (never a phantom alarm)", () => {
    assert.equal(assessReflectionHealth(report("all-none-empty-store")), null);
  });

  test("no-op on healthy and no-data verdicts", () => {
    assert.equal(assessReflectionHealth(report("healthy")), null);
    assert.equal(assessReflectionHealth(report("no-data")), null);
  });
});

describe("assessDarkLeadingOutcomes (#2805)", () => {
  const dark = (name: string, producerHint: string, query: string): OutcomeVerdict => ({
    name,
    kind: "leading",
    status: "dark",
    query,
    producerHint,
  });
  const live = (name: string): OutcomeVerdict => ({
    name,
    kind: "leading",
    status: "live",
    value: 1,
    ts: new Date().toISOString(),
    ageMs: 0,
  });

  test("fires a warning naming the dark outcome + producerHint + query", () => {
    const d = assessDarkLeadingOutcomes([dark("brier", "forecast-scorer", "metrics/forecast.json")]);
    assert.ok(d, "expected a diagnostic when a leading outcome is dark");
    assert.equal(d.severity, "warning");
    assert.equal(d.component, "intelligence");
    assert.equal(d.what, "Dark leading outcome: brier");
    assert.ok(d.why.includes("brier (forecast-scorer) → should write metrics/forecast.json"));
    assert.equal(d.autoRecovery, false);
  });

  test("pluralizes the summary when multiple outcomes are dark", () => {
    const d = assessDarkLeadingOutcomes([
      dark("brier", "scorer-a", "a.json"),
      dark("logloss", "scorer-b", "b.json"),
    ]);
    assert.ok(d);
    assert.equal(d.what, "Dark leading outcomes: brier, logloss");
  });

  test("no-op on an all-live slice (honest-none)", () => {
    assert.equal(assessDarkLeadingOutcomes([live("brier")]), null);
  });

  test("no-op on an empty slice (honest-none, never a phantom alarm)", () => {
    assert.equal(assessDarkLeadingOutcomes([]), null);
  });
});

describe("assessAttributionLedger (#3270)", () => {
  test("fires a warning when the ledger is empty (count 0)", () => {
    const d = assessAttributionLedger(0);
    assert.ok(d, "expected a diagnostic when the attribution ledger is empty");
    assert.equal(d.severity, "warning");
    assert.equal(d.component, "intelligence");
    assert.equal(d.what, "Attribution ledger is empty — merger→ledger flow never fired");
    assert.equal(d.autoRecovery, false);
  });

  test("no-op when the ledger has rows (never on partial population)", () => {
    assert.equal(assessAttributionLedger(1), null);
    assert.equal(assessAttributionLedger(42), null);
  });
});
