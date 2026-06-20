/**
 * test/dep-boundary-check.test.mts — pin the dep-boundary-check decision contract
 * at the pure-function level (no npx spawn, no process.exit), issue #2205.
 *
 * scripts/ci/dep-boundary-check.ts is a thin Adapter over dependency-cruiser: it
 * shells out, parses the JSON summary, and maps it to an exit code. The mapping
 * lives in the pure, side-effect-free `decideDepBoundary(summary, failOnError)` so
 * the advisory-vs-blocking contract can be pinned WITHOUT touching the network —
 * the same "export the pure predicate, test it without shelling out" pattern the
 * seam-check tests use. Importing the module must NOT trigger the npx spawn (guarded
 * by isCliEntrypoint), which this very test relies on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { decideDepBoundary } = await import("../scripts/ci/dep-boundary-check.ts");

type Violation = {
  type: string;
  from: string;
  to: string;
  rule: { name: string; severity: string };
};

function summary(opts: {
  violations?: Violation[];
  error?: number;
  warn?: number;
  info?: number;
  totalCruised?: number;
}) {
  return {
    violations: opts.violations ?? [],
    error: opts.error ?? 0,
    warn: opts.warn ?? 0,
    info: opts.info ?? 0,
    totalCruised: opts.totalCruised ?? 271,
  };
}

const warnViolation: Violation = {
  type: "dependency",
  from: "src/health/rules.ts",
  to: "src/health/skill-catalog.ts",
  rule: { name: "no-circular", severity: "warn" },
};

const errorViolation: Violation = {
  type: "dependency",
  from: "src/api/foo.ts",
  to: "src/redis/keys.ts",
  rule: { name: "no-direct-redis-keys-import", severity: "error" },
};

describe("dep-boundary-check: decision contract", () => {
  test("clean cruise (no violations) exits 0", () => {
    const d = decideDepBoundary(summary({ totalCruised: 271 }), false);
    assert.equal(d.exitCode, 0);
    assert.equal(d.byRule.size, 0);
    assert.match(d.headline, /clean/);
  });

  test("warn-severity findings are ADVISORY — exit 0 even with --error", () => {
    const d = decideDepBoundary(summary({ violations: [warnViolation], warn: 1 }), true);
    assert.equal(d.exitCode, 0, "a warn-only violation must never block, even under --error");
    assert.equal(d.byRule.get("no-circular")?.length, 1);
  });

  test("warn findings without --error are advisory exit 0", () => {
    const d = decideDepBoundary(summary({ violations: [warnViolation], warn: 1 }), false);
    assert.equal(d.exitCode, 0);
    assert.match(d.headline, /advisory/);
  });

  test("error-severity finding UNDER --error blocks (exit 1)", () => {
    const d = decideDepBoundary(summary({ violations: [errorViolation], error: 1 }), true);
    assert.equal(d.exitCode, 1);
    assert.match(d.headline, /failing/);
  });

  test("error-severity finding WITHOUT --error stays advisory (exit 0)", () => {
    const d = decideDepBoundary(summary({ violations: [errorViolation], error: 1 }), false);
    assert.equal(
      d.exitCode,
      0,
      "default (advisory) mode never blocks — promoting to a gate requires --error",
    );
  });

  test("zero modules cruised is a TOOL error (exit 2), never a clean pass", () => {
    const d = decideDepBoundary(summary({ totalCruised: 0 }), false);
    assert.equal(d.exitCode, 2, "0 modules means the resolver saw nothing — config/glob regression");
    assert.match(d.headline, /0 modules/);
  });

  test("groups violations by rule name", () => {
    const d = decideDepBoundary(
      summary({
        violations: [
          warnViolation,
          { ...warnViolation, from: "src/cost/eligibility.ts", to: "src/cost/usage-tracker.ts" },
          errorViolation,
        ],
        warn: 2,
        error: 1,
      }),
      false,
    );
    assert.equal(d.byRule.get("no-circular")?.length, 2);
    assert.equal(d.byRule.get("no-direct-redis-keys-import")?.length, 1);
  });
});
