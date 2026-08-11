/**
 * Regression tests for the advisory Stryker scan's pure comparison core
 * (tool-scout #3835).
 *
 * `scripts/ci/stryker-scan.ts` runs Stryker on a PR's diff and emits the
 * keep/replace/drop comparison: which surviving mutants Stryker surfaces that
 * the homegrown gate (`src/mutation.ts`, mutator list: negate-boolean-return,
 * swap-comparison, negate-condition, remove-early-return) does not attempt at
 * all, grouped by Stryker mutator category. These tests pin that grouping
 * logic against synthetic Stryker reports — they do NOT run Stryker, git, or
 * any IO. The IO path (`main()`) is exercised in CI by the advisory workflow.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildComparison,
  classifyStrykerStatus,
  HOMEGROWN_MUTATOR_CATALOG,
  STRYKER_CATEGORY_HOMEGROWN,
  type StrykerReport,
} from "../scripts/ci/stryker-scan.ts";

/** Build a Stryker mutation.json-shaped report from per-file mutant lists. */
function report(files: Record<string, { mutatorName: string; status: string }[]>): StrykerReport {
  return {
    schemaVersion: "1.0",
    files: Object.fromEntries(
      Object.entries(files).map(([path, mutants]) => [
        path,
        { mutants: mutants.map((m, i) => ({ id: `${path}:${i}`, ...m })) },
      ]),
    ),
  };
}

describe("classifyStrykerStatus — status mapping", () => {
  test("Survived and NoCoverage are survivors (undetected)", () => {
    assert.equal(classifyStrykerStatus("Survived"), "survived");
    assert.equal(classifyStrykerStatus("NoCoverage"), "survived");
  });
  test("Killed, Timeout, RuntimeError are detection signals (killed)", () => {
    assert.equal(classifyStrykerStatus("Killed"), "killed");
    assert.equal(classifyStrykerStatus("Timeout"), "killed");
    assert.equal(classifyStrykerStatus("RuntimeError"), "killed");
  });
  test("Ignored is ignored; unknown statuses are other", () => {
    assert.equal(classifyStrykerStatus("Ignored"), "ignored");
    assert.equal(classifyStrykerStatus("???"), "other");
  });
});

describe("buildComparison — homegrown catalog invariants", () => {
  test("only EqualityOperator and BooleanLiteral have a homegrown counterpart", () => {
    assert.deepEqual(
      Object.keys(STRYKER_CATEGORY_HOMEGROWN).sort(),
      ["BooleanLiteral", "EqualityOperator"],
    );
    for (const v of Object.values(STRYKER_CATEGORY_HOMEGROWN)) {
      assert.equal(v.attempted, true);
      assert.ok("homegrownEquivalent" in v && v.homegrownEquivalent.length > 0);
    }
  });
  test("the catalog mirrors src/mutation.ts MUTATORS", () => {
    assert.deepEqual([...HOMEGROWN_MUTATOR_CATALOG], [
      "negate-boolean-return",
      "swap-comparison",
      "negate-condition",
      "remove-early-return",
    ]);
  });
});

describe("buildComparison — empty / no-signal reports", () => {
  test("no files -> no-mutants", () => {
    const r = buildComparison({ schemaVersion: "1.0" });
    assert.equal(r.status, "no-mutants");
    assert.equal(r.stryker.totalMutants, 0);
    assert.equal(r.stryker.mutationScore, null);
    assert.equal(r.comparison.survivorsNotAttemptedByHomegrown.totalSurvivors, 0);
    assert.match(r.recommendationSignal, /0 mutants/);
  });
  test("all mutants killed -> no-survivors", () => {
    const r = buildComparison(
      report({
        "src/a.ts": [
          { mutatorName: "ArithmeticOperator", status: "Killed" },
          { mutatorName: "EqualityOperator", status: "Killed" },
        ],
      }),
    );
    assert.equal(r.status, "no-survivors");
    assert.equal(r.stryker.survived, 0);
    assert.equal(r.stryker.killed, 2);
    assert.equal(r.stryker.mutationScore, 100);
    assert.equal(r.comparison.survivorsNotAttemptedByHomegrown.totalSurvivors, 0);
  });
});

describe("buildComparison — survivors only in homegrown-attempted categories", () => {
  test("EqualityOperator survivor is classified as attempted, not unattempted", () => {
    const r = buildComparison(
      report({
        "src/a.ts": [
          { mutatorName: "EqualityOperator", status: "Survived" },
          { mutatorName: "BooleanLiteral", status: "NoCoverage" },
          { mutatorName: "EqualityOperator", status: "Killed" },
        ],
      }),
    );
    assert.equal(r.status, "no-unattempted-survivors");
    assert.equal(r.stryker.survived, 2); // Survived + NoCoverage
    assert.equal(r.stryker.killed, 1);
    const att = r.comparison.survivorsInAttemptedCategories;
    assert.equal(att.totalSurvivors, 2);
    assert.equal(att.byCategory["EqualityOperator"].count, 1);
    assert.equal(att.byCategory["EqualityOperator"].attemptedByHomegrownGate, true);
    assert.equal(att.byCategory["BooleanLiteral"].count, 1);
    assert.equal(
      r.comparison.survivorsNotAttemptedByHomegrown.totalSurvivors,
      0,
    );
    assert.match(r.recommendationSignal, /supports a "drop" recommendation/);
  });
});

describe("buildComparison — survivors in UN-attempted categories (the signal)", () => {
  test("ArithmeticOperator + StringLiteral survivors are the comparison signal", () => {
    const r = buildComparison(
      report({
        "src/a.ts": [
          { mutatorName: "ArithmeticOperator", status: "Survived" },
          { mutatorName: "ArithmeticOperator", status: "Survived" },
          { mutatorName: "StringLiteral", status: "NoCoverage" },
          { mutatorName: "EqualityOperator", status: "Survived" }, // attempted
          { mutatorName: "LogicalOperator", status: "Killed" },
        ],
      }),
    );
    assert.equal(r.status, "survivors-in-unattempted-categories");

    const un = r.comparison.survivorsNotAttemptedByHomegrown;
    assert.equal(un.totalSurvivors, 3);
    assert.equal(un.distinctCategories, 2);
    // ordered by descending count, then name
    assert.deepEqual(Object.keys(un.byCategory), ["ArithmeticOperator", "StringLiteral"]);
    assert.equal(un.byCategory["ArithmeticOperator"].count, 2);
    assert.equal(un.byCategory["ArithmeticOperator"].attemptedByHomegrownGate, false);
    assert.equal(un.byCategory["StringLiteral"].count, 1);
    assert.ok(!("homegrownEquivalent" in un.byCategory["ArithmeticOperator"]));

    // EqualityOperator survivor stays in the attempted bucket.
    assert.equal(r.comparison.survivorsInAttemptedCategories.totalSurvivors, 1);

    assert.equal(r.stryker.killed, 1);
    assert.equal(r.stryker.survived, 4);
    assert.equal(r.stryker.mutationScore, 20); // 1 killed / 5 testable
    assert.match(r.recommendationSignal, /3 surviving mutant\(s\) across 2 categor/);
    assert.match(r.recommendationSignal, /ArithmeticOperator, StringLiteral/);
  });

  test("NoCoverage survivors count toward the signal (homegrown gate would miss them too)", () => {
    const r = buildComparison(
      report({
        "src/a.ts": [{ mutatorName: "UpdateOperator", status: "NoCoverage" }],
      }),
    );
    assert.equal(r.status, "survivors-in-unattempted-categories");
    assert.equal(r.comparison.survivorsNotAttemptedByHomegrown.totalSurvivors, 1);
  });
});

describe("buildComparison — ignored mutants are excluded from the score", () => {
  test("Ignored mutants do not count as testable", () => {
    const r = buildComparison(
      report({
        "src/a.ts": [
          { mutatorName: "ArithmeticOperator", status: "Killed" },
          { mutatorName: "ArithmeticOperator", status: "Ignored" },
        ],
      }),
    );
    assert.equal(r.stryker.totalMutants, 2);
    assert.equal(r.stryker.ignored, 1);
    assert.equal(r.stryker.testable, 1);
    assert.equal(r.stryker.mutationScore, 100); // 1 killed / 1 testable
    assert.equal(r.status, "no-survivors");
  });
});
