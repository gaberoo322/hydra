/**
 * Regression tests for the epic-vs-flat decision rule used by
 * `hydra-research` and `hydra-discover` to decide whether to route a
 * finding through `hydra-prd` (issue #515).
 *
 * The rule itself is documented verbatim in
 * `docs/operator-playbooks/hydra-research.md` (Epic vs. flat decision rule)
 * and `scripts/ci/epic-shape-classifier.ts`. These tests guard the matrix
 * of inputs the playbook will see in production:
 *
 *   1. ≥3 slices with shared rationale AND inter-dependencies → epic
 *   2. Exactly 1 slice → flat (no decomposition yet)
 *   3. Exactly 2 slices → flat (still "go file the issues")
 *   4. ≥3 slices but mutually independent (no deps, no rationale) → flat
 *   5. ≥3 slices with shared rationale but no deps → epic (rationale alone
 *      is enough to justify a parent narrative)
 *   6. ≥3 slices with deps but no rationale → epic (deps alone are enough
 *      to want a parent to track sequencing)
 *   7. Explicit `epic: false` override → flat regardless of slice shape
 *   8. Explicit `epic: true` override with ≥3 slices → epic
 *   9. Explicit `epic: true` override with <3 slices → flat +
 *      forcedEpicTooSmall (hydra-prd would reject anyway; we surface the
 *      mismatch instead of silently filing flat)
 *
 * The helper is pure — no fs/network/process — so these tests run in
 * milliseconds with zero setup. There are no singleton clients or external
 * resources here, so no file-level `after()` hook is needed (cf. the
 * lesson from PR #518 about leaked Redis handles tripping the
 * `--test-force-exit` PASS_COUNT check).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEpicShape,
  shouldRouteToPrd,
  type EpicShapeFinding,
  type EpicShapeSlice,
} from "../scripts/ci/epic-shape-classifier.ts";

function slice(title: string, dependsOn?: number[]): EpicShapeSlice {
  return dependsOn ? { title, dependsOn } : { title };
}

function finding(overrides: Partial<EpicShapeFinding> = {}): EpicShapeFinding {
  return {
    title: "Add foo to the Orchestrator",
    rationale:
      "Closing the gap removes an Operator-Required Intervention category " +
      "and unblocks the Modification Tier 2 holdback path for follow-on " +
      "changes.",
    slices: [slice("alpha"), slice("beta", [1]), slice("gamma", [1, 2])],
    ...overrides,
  };
}

describe("classifyEpicShape — happy path (rule-driven)", () => {
  test("≥3 slices with shared rationale AND inter-deps → epic", () => {
    const v = classifyEpicShape(finding());
    assert.equal(v.shape, "epic");
    assert.match(v.reason, /3 slices/);
    assert.match(v.reason, /inter-slice dependsOn present/);
    assert.match(v.reason, /shared rationale present/);
  });

  test("shouldRouteToPrd matches the verdict", () => {
    const v = classifyEpicShape(finding());
    assert.equal(shouldRouteToPrd(v), true);
  });
});

describe("classifyEpicShape — flat-shaped findings", () => {
  test("1 slice → flat (no decomposition yet)", () => {
    const v = classifyEpicShape(finding({ slices: [slice("only")] }));
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /fewer than 3 slices/);
    assert.match(v.reason, /\(1\)/);
  });

  test("2 slices → flat (still 'go file the issues')", () => {
    const v = classifyEpicShape(
      finding({ slices: [slice("a"), slice("b", [1])] }),
    );
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /fewer than 3 slices/);
    assert.match(v.reason, /\(2\)/);
  });

  test("≥3 slices but mutually independent (no deps, no rationale) → flat", () => {
    const v = classifyEpicShape({
      slices: [slice("a"), slice("b"), slice("c")],
      // no rationale, no dependsOn anywhere
    });
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /mutually independent/);
  });

  test("shouldRouteToPrd is false on a flat finding", () => {
    const v = classifyEpicShape({
      slices: [slice("a"), slice("b"), slice("c")],
    });
    assert.equal(shouldRouteToPrd(v), false);
  });

  test("empty rationale string is treated as no rationale", () => {
    const v = classifyEpicShape({
      rationale: "   ",
      slices: [slice("a"), slice("b"), slice("c")],
    });
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /mutually independent/);
  });
});

describe("classifyEpicShape — partial-signal cases (rationale OR deps)", () => {
  test("≥3 slices with shared rationale but no deps → epic", () => {
    // Rationale alone is enough: the parent narrative justifies a single
    // epic even if the children happen to be implementable in parallel.
    const v = classifyEpicShape({
      rationale:
        "Three related changes share one Target Outcome and should be tracked together.",
      slices: [slice("a"), slice("b"), slice("c")],
    });
    assert.equal(v.shape, "epic");
    assert.match(v.reason, /shared rationale present/);
    // No deps means we don't cite the deps signal.
    assert.doesNotMatch(v.reason, /inter-slice dependsOn present/);
  });

  test("≥3 slices with deps but no rationale → epic", () => {
    // Deps alone are enough: the slices need sequencing, which is what a
    // parent epic tracks.
    const v = classifyEpicShape({
      slices: [slice("a"), slice("b", [1]), slice("c", [2])],
      // no rationale
    });
    assert.equal(v.shape, "epic");
    assert.match(v.reason, /inter-slice dependsOn present/);
    assert.doesNotMatch(v.reason, /shared rationale present/);
  });
});

describe("classifyEpicShape — operator escape hatches", () => {
  test("epic: false forces flat even on an epic-shaped finding", () => {
    const v = classifyEpicShape(finding({ epic: false }));
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /operator override.*epic: false/);
  });

  test("epic: true with ≥3 slices forces epic on an otherwise-flat finding", () => {
    const v = classifyEpicShape({
      epic: true,
      slices: [slice("a"), slice("b"), slice("c")],
      // no rationale, no deps — would be flat without the override
    });
    assert.equal(v.shape, "epic");
    assert.match(v.reason, /operator override.*epic: true/);
  });

  test("epic: true with <3 slices stays flat + forcedEpicTooSmall=true", () => {
    // hydra-prd would reject this anyway (3-slice minimum). The classifier
    // surfaces the mismatch so the playbook can warn the operator instead
    // of producing a malformed PRD.
    const v = classifyEpicShape({
      epic: true,
      slices: [slice("a"), slice("b")],
    });
    assert.equal(v.shape, "flat");
    assert.equal(v.forcedEpicTooSmall, true);
    assert.match(v.reason, /forced epic: true but only 2 slices/);
  });

  test("epic: false wins even if epic: true would have applied", () => {
    // Explicit `false` is the strongest signal — the operator may want a
    // flat list of parallel issues even when the finding looks epic-shaped.
    const v = classifyEpicShape(finding({ epic: false }));
    assert.equal(v.shape, "flat");
    assert.doesNotMatch(v.reason, /inter-slice/);
  });
});

describe("classifyEpicShape — robustness", () => {
  test("missing slices array is treated as 0 slices → flat", () => {
    // The classifier never throws on a well-formed EpicShapeFinding, but
    // we still want a sensible default if a caller forgets to pass slices.
    const v = classifyEpicShape({ slices: undefined as unknown as EpicShapeSlice[] });
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /fewer than 3 slices/);
    assert.match(v.reason, /\(0\)/);
  });

  test("empty slices array → flat", () => {
    const v = classifyEpicShape({ slices: [] });
    assert.equal(v.shape, "flat");
    assert.match(v.reason, /fewer than 3 slices/);
  });
});
