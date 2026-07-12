/**
 * capacity-floor-classifier.test.mts — NON-overlapping branch coverage for
 * src/capacity-floor-classifier.ts (issue #3238).
 *
 * The bulk of `classifySide` / `computeShare` is ALREADY covered by
 * test/capacity-floor.test.mts (which imports the same symbols via the
 * capacity-floor.ts re-export). Per the design-concept invariant for #3238,
 * this file MUST NOT duplicate that suite — it exercises ONLY the branches the
 * existing suite leaves uncovered:
 *
 *   - the Tier-4 (Verifier Core) file is NOT counted as an orchestrator vote
 *     (source lines 104-108: only Tier 1/2 are strong orchestrator signals);
 *   - the exact-tie boundary `orchestratorVotes === ambiguousVotes` (the `>=`
 *     comparison, source line 111) still resolves to "orchestrator";
 *   - non-string / empty-string entries in the file list are filtered out
 *     before classification (source line 98), so a list of only-junk entries
 *     falls back to "idle";
 *   - the exported policy constants carry their documented values.
 *
 * Pure module (imports only the Redis-free tier-classifier) — no Redis, no
 * clock, no lifecycle.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifySide,
  computeShare,
  DEFAULT_WINDOW_CYCLES,
  ORCHESTRATOR_FLOOR,
} from "../src/capacity-floor-classifier.ts";

// ---------------------------------------------------------------------------
// classifySide — the branches capacity-floor.test.mts does not reach
// ---------------------------------------------------------------------------

describe("capacity-floor-classifier.classifySide — uncovered branches (#3238)", () => {
  test("a Tier-4 (Verifier Core) file is NOT counted as an orchestrator vote", () => {
    // ci.yml classifies as Tier 4. The classifier only treats Tier 1/2 as a
    // strong orchestrator signal, so a lone T4 file yields zero orchestrator
    // votes and zero ambiguous votes → falls through to the hint/default.
    assert.equal(classifySide([".github/workflows/ci.yml"]), "target");
  });

  test("a Tier-4 file with workspaceHint=orchestrator still returns orchestrator (hint short-circuits)", () => {
    // The explicit orchestrator hint is checked BEFORE the vote tally, so it
    // wins regardless of the T4-not-a-vote rule.
    assert.equal(
      classifySide([".github/workflows/ci.yml"], { workspaceHint: "orchestrator" }),
      "orchestrator",
    );
  });

  test("a Tier-4 file does not out-vote a genuine Tier-1/2 orchestrator signal", () => {
    // 1 strong orchestrator vote (a T1 config file) + 1 T4 file (no vote either
    // way) → orchestratorVotes(1) >= ambiguousVotes(0) → orchestrator.
    assert.equal(
      classifySide(["config/agents/planner.md", ".github/workflows/ci.yml"]),
      "orchestrator",
    );
  });

  test("exact tie orchestratorVotes === ambiguousVotes resolves to orchestrator (the >= boundary)", () => {
    // 1 strong orchestrator vote (anchor-selection.ts → Tier 2) vs 1 ambiguous
    // vote (a generic src/ file → Tier 3). The comparison is `>=`, so an equal
    // count still classifies as orchestrator.
    assert.equal(
      classifySide(["src/anchor-selection.ts", "src/some-generic-feature.ts"]),
      "orchestrator",
    );
  });

  test("non-string and empty-string entries are filtered before classification", () => {
    // Only junk entries → the filtered list is empty → "idle" (the same path an
    // empty list takes), proving the guard on source line 98 runs.
    const junk = [null, undefined, "", 42, {} as any] as any[];
    assert.equal(classifySide(junk), "idle");
  });

  test("junk entries are dropped but a real orchestrator file still classifies", () => {
    const mixed = ["", null, "config/agents/planner.md", undefined] as any[];
    assert.equal(classifySide(mixed), "orchestrator");
  });
});

// ---------------------------------------------------------------------------
// Exported policy constants
// ---------------------------------------------------------------------------

describe("capacity-floor-classifier constants (#3238)", () => {
  test("DEFAULT_WINDOW_CYCLES is 20", () => {
    assert.equal(DEFAULT_WINDOW_CYCLES, 20);
  });

  test("ORCHESTRATOR_FLOOR is the Vision-vector-2 25% floor", () => {
    assert.equal(ORCHESTRATOR_FLOOR, 0.25);
  });

  test("computeShare defaults its floor to ORCHESTRATOR_FLOOR", () => {
    // An empty window reports floorMet=true and echoes the default floor — a
    // lightweight check that the default parameter binds to the constant
    // (distinct from capacity-floor.test.mts, which asserts share math).
    const r = computeShare([]);
    assert.equal(r.floor, ORCHESTRATOR_FLOOR);
    assert.equal(r.floorMet, true);
    assert.equal(r.windowCount, 0);
  });
});
