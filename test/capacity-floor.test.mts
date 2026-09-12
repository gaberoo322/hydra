/**
 * Regression tests for the capacity-floor module (issue #245).
 *
 * Asserts the ADR-0003 25% orchestrator-self-improvement floor:
 *   - 5/20 orchestrator cycles → share = 25%, floor met, no preference fired
 *   - 4/20 orchestrator cycles → share = 20%, preference fires
 *   - idle cycles excluded from the denominator
 *   - mixed-repo merges classify by majority of strong votes
 *
 * The classifier and `computeShare` are pure — those suites need no Redis. The
 * `recordCycleSide` idempotency suite (issue #4299) exercises the real Redis
 * writer through the shared per-run test DB (same seam the reactor default-deps
 * smoke test uses), as its own top-level describe with unique cycleIds per
 * case, so it shares no teardown with any sibling suite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifySide,
  computeShare,
  ORCHESTRATOR_FLOOR,
  type CycleSideEntry,
} from "../src/capacity-floor-classifier.ts";
import { recordCycleSide, getCapacitySnapshot } from "../src/capacity-floor.ts";

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
    assert.equal(r.floorStatus, "met", "share == floor must count as met");
    assert.equal(r.floorMet, true);
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
    assert.equal(r.floorStatus, "breached");
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
    assert.equal(r.floorStatus, "met");
    assert.equal(r.floorMet, true);
  });

  test("empty history → floorStatus unmeasured, floorMet null (#4298)", () => {
    const r = computeShare([]);
    assert.equal(r.windowCount, 0);
    assert.equal(r.share, 0);
    assert.equal(r.floorStatus, "unmeasured");
    assert.equal(r.floorMet, null, "no history → never a vacuous green");
  });

  test("all idle → no signal: floorStatus unmeasured, floorMet null (#4298)", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 10; i++) history.push(entry("idle", "i" + i));
    const r = computeShare(history);
    assert.equal(r.windowCount, 0);
    assert.equal(r.floorStatus, "unmeasured", "trigger is windowCount === 0, independent of idleCount");
    assert.equal(r.floorMet, null);
  });

  test("floorStatus is canonical across all three states; floorMet is its boolean projection (#4298)", () => {
    const unmeasured = computeShare([]);
    assert.equal(unmeasured.floorStatus, "unmeasured");
    assert.equal(unmeasured.floorMet, null);

    // 1/4 orchestrator = 25% = the floor → met.
    const met = computeShare([
      entry("orchestrator", "o0"),
      entry("target", "t0"),
      entry("target", "t1"),
      entry("target", "t2"),
    ]);
    assert.equal(met.share, 0.25);
    assert.equal(met.floorStatus, "met");
    assert.equal(met.floorMet, true);

    // 1/10 orchestrator = 10% < 25% floor → breached.
    const breached = computeShare([
      entry("orchestrator", "o0"),
      ...Array.from({ length: 9 }, (_, i) => entry("target", "tt" + i)),
    ]);
    assert.equal(breached.share, 0.1);
    assert.equal(breached.floorStatus, "breached");
    assert.equal(breached.floorMet, false);
  });

  test("0/20 orchestrator (all target) → share = 0, floor NOT met", () => {
    const history: CycleSideEntry[] = [];
    for (let i = 0; i < 20; i++) history.push(entry("target", "t" + i));
    const r = computeShare(history);
    assert.equal(r.share, 0);
    assert.equal(r.floorStatus, "breached");
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
    assert.equal(r.floorStatus, "breached");
    assert.equal(r.floorMet, false);
  });
});

// ---------------------------------------------------------------------------
// recordCycleSide — Redis writer, idempotent on cycleId (issue #4299 INV-2)
// ---------------------------------------------------------------------------
//
// Both Housekeeping merge observers (holdback-merge-watch on the pending-enroll
// registry, cycle-merge-reconcile on the cycle-record scan) confirm merges
// against the orchestrator repo and stamp the SAME `pr-<n>` cycleId. A PR can
// legitimately be observed by BOTH (merge-watch first, then a reconcile pass on
// a slow upgrade) and re-observed on a retry after a mark-write failure — the
// writer itself must collapse those into exactly one entry. Unique cycleIds per
// case keep this suite independent of whatever else shares the per-run DB.

describe("capacity-floor.recordCycleSide — idempotent on cycleId (issue #4299)", () => {
  test("re-recording the same cycleId is a no-op — exactly one entry per cycleId (issue #4299 INV-2)", async () => {
    const id = `idem-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await recordCycleSide(id, "orchestrator", { source: "merge-watch", commitSha: "aaabbb" });
    // Re-observation: the other chore, an event redelivery, or a manual re-POST
    // of the same PR. None may append a second entry.
    await recordCycleSide(id, "orchestrator", { source: "cycle-merge-reconcile" });
    await recordCycleSide(id, "orchestrator", { source: "orchestrator-merge" });

    const snap = await getCapacitySnapshot(200);
    const mine = snap.recent.filter((e) => e.cycleId === id);
    assert.equal(mine.length, 1, "one landed PR = one capacity entry");
    assert.equal(mine[0].source, "merge-watch", "first write wins — re-writes never overwrite");
  });

  test("distinct cycleIds each record — the dedupe check never over-matches", async () => {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const a = `idem-a-${suffix}`;
    const b = `idem-b-${suffix}`;
    await recordCycleSide(a, "orchestrator", { source: "test" });
    await recordCycleSide(b, "target", { source: "test" });
    const snap = await getCapacitySnapshot(200);
    assert.equal(snap.recent.filter((e) => e.cycleId === a).length, 1);
    assert.equal(snap.recent.filter((e) => e.cycleId === b).length, 1);
  });
});
