/**
 * Regression tests for the lightweight Target design-concept artifact
 * (issue #1056, parent epic #1052).
 *
 * Pins the four contract properties the issue's acceptance criteria name:
 *   - money-critical anchors get an artifact (built, serializable, persistable);
 *   - safe-path anchors skip artifact creation entirely;
 *   - a retry on the same anchor reuses the persisted artifact (round-trip);
 *   - the artifact stays *lightweight* — flat 4-field shape, no Q&A/tier/gate.
 *
 * Pure tests — no Redis, no network, no spawn.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCaptureDesignConcept,
  buildDesignConcept,
  serializeDesignConcept,
  parseDesignConcept,
  type TargetDesignConceptInput,
} from "../scripts/target/target-design-concept.ts";

const NOW = new Date("2026-06-06T12:00:00.000Z");

function sampleInput(overrides: Partial<TargetDesignConceptInput> = {}): TargetDesignConceptInput {
  return {
    anchorRef: "issue-9001",
    scope: "Add a max-stake guard to the Kelly sizer.",
    modulesTouched: ["src/lib/staking/kelly.ts", "src/lib/execution/place-bet.ts"],
    invariants: ["never stake above the configured bankroll cap"],
    rejectedAlternatives: [{ alt: "clamp at the provider layer", why: "too late — order already built" }],
    ...overrides,
  };
}

describe("shouldCaptureDesignConcept — money-critical gate", () => {
  test("captures for money-critical paths (providers / execution / staking / bet-math)", () => {
    assert.equal(shouldCaptureDesignConcept(["src/lib/providers/betfair.ts"]), true);
    assert.equal(shouldCaptureDesignConcept(["src/lib/execution/place-bet.ts"]), true);
    assert.equal(shouldCaptureDesignConcept(["src/lib/staking/kelly.ts"]), true);
    assert.equal(shouldCaptureDesignConcept(["src/lib/bet-math/edge.ts"]), true);
  });

  test("safe-path anchors skip artifact creation entirely", () => {
    assert.equal(shouldCaptureDesignConcept(["web/src/components/Button.tsx", "README.md"]), false);
    assert.equal(shouldCaptureDesignConcept([]), false);
  });

  test("a mixed change with any money-critical path still captures", () => {
    assert.equal(
      shouldCaptureDesignConcept(["README.md", "src/lib/staking/kelly.ts"]),
      true,
    );
  });
});

describe("buildDesignConcept — lightweight 4-field artifact", () => {
  test("builds the flat artifact with all four planner fields", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    assert.equal(dc.kind, "target-design-concept");
    assert.equal(dc.anchorRef, "issue-9001");
    assert.equal(dc.scope, "Add a max-stake guard to the Kelly sizer.");
    assert.deepEqual(dc.modulesTouched, [
      "src/lib/staking/kelly.ts",
      "src/lib/execution/place-bet.ts",
    ]);
    assert.deepEqual(dc.invariants, ["never stake above the configured bankroll cap"]);
    assert.deepEqual(dc.rejectedAlternatives, [
      { alt: "clamp at the provider layer", why: "too late — order already built" },
    ]);
    assert.equal(dc.capturedAt, NOW.toISOString());
  });

  test("derives matchedPaths from modulesTouched via the keystone classifier", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    // Both sample paths are money-critical, in input order, de-duplicated.
    assert.deepEqual(dc.matchedPaths, [
      "src/lib/staking/kelly.ts",
      "src/lib/execution/place-bet.ts",
    ]);
  });

  test("stays lightweight — no Q&A trace / tier / lifecycle / prototype fields", () => {
    const dc = buildDesignConcept(sampleInput(), NOW);
    const keys = Object.keys(dc).sort();
    assert.deepEqual(keys, [
      "anchorRef",
      "capturedAt",
      "invariants",
      "kind",
      "matchedPaths",
      "modulesTouched",
      "rejectedAlternatives",
      "scope",
    ]);
    // Explicitly NOT mirroring the Orchestrator artifact's heavy shape.
    const record = dc as unknown as Record<string, unknown>;
    assert.equal(record.qaTrace, undefined);
    assert.equal(record.prototypes, undefined);
    assert.equal(record.status, undefined);
    assert.equal(record.approvedBy, undefined);
    assert.equal(record.depthClassification, undefined);
  });

  test("trims and drops empty / whitespace-only / non-string list entries", () => {
    const dc = buildDesignConcept(
      sampleInput({
        scope: "   trimmed scope   ",
        modulesTouched: ["  src/lib/staking/kelly.ts  ", "", "   "],
        invariants: ["keep it exact", "   ", ""],
        rejectedAlternatives: [
          { alt: "  a  ", why: "  b  " },
          { alt: "", why: "" },
        ],
      }),
      NOW,
    );
    assert.equal(dc.scope, "trimmed scope");
    assert.deepEqual(dc.modulesTouched, ["src/lib/staking/kelly.ts"]);
    assert.deepEqual(dc.invariants, ["keep it exact"]);
    assert.deepEqual(dc.rejectedAlternatives, [{ alt: "a", why: "b" }]);
  });

  test("total — tolerates a malformed planner submission without throwing", () => {
    const dc = buildDesignConcept(
      {
        anchorRef: undefined as unknown as string,
        scope: undefined as unknown as string,
        modulesTouched: undefined as unknown as string[],
        invariants: undefined as unknown as string[],
        rejectedAlternatives: undefined as unknown as never[],
      },
      NOW,
    );
    assert.equal(dc.anchorRef, "");
    assert.equal(dc.scope, "");
    assert.deepEqual(dc.modulesTouched, []);
    assert.deepEqual(dc.invariants, []);
    assert.deepEqual(dc.rejectedAlternatives, []);
    assert.deepEqual(dc.matchedPaths, []);
  });
});

describe("serialize / parse — retry reuse round-trip", () => {
  test("a retry on the same anchor reuses the persisted artifact (round-trip)", () => {
    const original = buildDesignConcept(sampleInput(), NOW);
    const persisted = serializeDesignConcept(original);
    const reused = parseDesignConcept(persisted);
    assert.deepEqual(reused, original);
  });

  test("parse returns null for absent / empty persisted value (recapture)", () => {
    assert.equal(parseDesignConcept(null), null);
    assert.equal(parseDesignConcept(undefined), null);
    assert.equal(parseDesignConcept(""), null);
  });

  test("parse returns null (not throw) on corrupt JSON — degrades to recapture", () => {
    assert.equal(parseDesignConcept("{not json"), null);
    assert.equal(parseDesignConcept("42"), null);
    assert.equal(parseDesignConcept("[]"), null);
  });

  test("parse rejects a wrong-discriminator / mistyped object", () => {
    assert.equal(parseDesignConcept(JSON.stringify({ kind: "orch-design-concept" })), null);
    assert.equal(
      parseDesignConcept(
        JSON.stringify({
          kind: "target-design-concept",
          anchorRef: "issue-1",
          scope: "x",
          modulesTouched: "not-an-array",
          invariants: [],
          rejectedAlternatives: [],
          matchedPaths: [],
          capturedAt: NOW.toISOString(),
        }),
      ),
      null,
    );
  });
});
