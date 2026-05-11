/**
 * Regression tests for the capacity-floor module (issue #245).
 *
 * Asserts the ADR-0003 25% orchestrator-self-improvement floor:
 *   - 5/20 orchestrator cycles → share = 25%, floor met, no preference fired
 *   - 4/20 orchestrator cycles → share = 20%, preference fires
 *   - idle cycles excluded from the denominator
 *   - mixed-repo merges classify by majority of strong votes
 *
 * The classifier and `computeShare` are pure — these tests need no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifySide,
  computeShare,
  ORCHESTRATOR_FLOOR,
  type CycleSideEntry,
} from "../src/capacity-floor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(side: "orchestrator" | "target" | "idle", id: string = side + "-" + Math.random()): CycleSideEntry {
  return {
    cycleId: id,
    side,
    recordedAt: "2026-05-11T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// classifySide — pure
// ---------------------------------------------------------------------------

describe("capacity-floor.classifySide", () => {
  test("empty / missing filesChanged → idle", () => {
    assert.equal(classifySide([]), "idle");
    assert.equal(classifySide(null), "idle");
    assert.equal(classifySide(undefined), "idle");
  });

  test("config/agents/* file → orchestrator (Tier 1)", () => {
    assert.equal(classifySide(["config/agents/planner.md"]), "orchestrator");
  });

  test("config/feedback/* file → orchestrator (Tier 1)", () => {
    assert.equal(classifySide(["config/feedback/to-planner.md"]), "orchestrator");
  });

  test(".claude/skills/* file → orchestrator (Tier 2)", () => {
    assert.equal(classifySide([".claude/skills/hydra-autopilot/SKILL.md"]), "orchestrator");
  });

  test("dashboard/* file → orchestrator (Tier 2)", () => {
    assert.equal(classifySide(["dashboard/src/App.jsx"]), "orchestrator");
  });

  test("src/anchor-selection.ts → orchestrator (Tier 2 exact match)", () => {
    assert.equal(classifySide(["src/anchor-selection.ts"]), "orchestrator");
  });

  test("generic src/ file with no hint → target (Tier 3 default; ambiguous)", () => {
    // A target cycle's filesChanged commonly looks like this. The classifier
    // must NOT mistake unannotated src/ files for orchestrator work.
    assert.equal(classifySide(["src/some-feature.ts"]), "target");
  });

  test("workspaceHint=target overrides ambiguous classification", () => {
    assert.equal(classifySide(["src/some-feature.ts"], { workspaceHint: "target" }), "target");
  });

  test("workspaceHint=orchestrator forces orchestrator", () => {
    assert.equal(classifySide(["src/some-feature.ts"], { workspaceHint: "orchestrator" }), "orchestrator");
  });

  test("mixed-repo: majority orchestrator votes → orchestrator", () => {
    // 2 strong orchestrator signals vs 1 ambiguous target signal.
    const files = [
      "config/agents/planner.md",
      "config/feedback/to-planner.md",
      "src/some-target-feature.ts",
    ];
    assert.equal(classifySide(files), "orchestrator");
  });

  test("mixed-repo: majority ambiguous votes → target (tiebreak)", () => {
    // 1 strong orchestrator vote vs 3 ambiguous target votes.
    const files = [
      "config/agents/planner.md",
      "src/feature-a.ts",
      "src/feature-b.ts",
      "src/feature-c.ts",
    ];
    assert.equal(classifySide(files), "target");
  });
});

// ---------------------------------------------------------------------------
// computeShare — pure aggregation
// ---------------------------------------------------------------------------

describe("capacity-floor.computeShare", () => {
  test("5/20 orchestrator (rest target) → share = 25%, floor met, no preference fire", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 5; i++) history.push(entry("orchestrator", "o" + i));
    for (let i = 0; i < 15; i++) history.push(entry("target", "t" + i));

    const r = computeShare(history);
    assert.equal(r.orchestratorCount, 5);
    assert.equal(r.targetCount, 15);
    assert.equal(r.windowCount, 20);
    assert.equal(r.share, 0.25);
    assert.equal(r.floor, ORCHESTRATOR_FLOOR);
    assert.equal(r.floorMet, true, "share == floor must count as met");
  });

  test("4/20 orchestrator → share = 20%, floor NOT met (preference would fire)", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 4; i++) history.push(entry("orchestrator", "o" + i));
    for (let i = 0; i < 16; i++) history.push(entry("target", "t" + i));

    const r = computeShare(history);
    assert.equal(r.orchestratorCount, 4);
    assert.equal(r.targetCount, 16);
    assert.equal(r.windowCount, 20);
    assert.equal(r.share, 0.2);
    assert.equal(r.floorMet, false);
  });

  test("idle cycles excluded from the denominator", () => {
    // 5 orchestrator, 15 target, 30 idle. Idle must NOT dilute the share.
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 5; i++) history.push(entry("orchestrator", "o" + i));
    for (let i = 0; i < 15; i++) history.push(entry("target", "t" + i));
    for (let i = 0; i < 30; i++) history.push(entry("idle", "i" + i));

    const r = computeShare(history);
    assert.equal(r.windowCount, 20, "idle cycles excluded from denominator");
    assert.equal(r.idleCount, 30);
    assert.equal(r.share, 0.25);
    assert.equal(r.floorMet, true);
  });

  test("empty history → share = 0, floorMet = true (no opinion)", () => {
    const r = computeShare([]);
    assert.equal(r.windowCount, 0);
    assert.equal(r.share, 0);
    assert.equal(r.floorMet, true, "no history → don't fire preference change");
  });

  test("all idle → no signal", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 10; i++) history.push(entry("idle", "i" + i));
    const r = computeShare(history);
    assert.equal(r.windowCount, 0);
    assert.equal(r.floorMet, true);
  });

  test("0/20 orchestrator (all target) → share = 0, floor NOT met", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 20; i++) history.push(entry("target", "t" + i));
    const r = computeShare(history);
    assert.equal(r.share, 0);
    assert.equal(r.floorMet, false);
  });

  test("custom floor parameter is honored", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 5; i++) history.push(entry("orchestrator", "o" + i));
    for (let i = 0; i < 15; i++) history.push(entry("target", "t" + i));
    // 25% share — meets 0.25 default but not a stricter 0.50 floor.
    const r = computeShare(history, 0.5);
    assert.equal(r.share, 0.25);
    assert.equal(r.floor, 0.5);
    assert.equal(r.floorMet, false);
  });
});
