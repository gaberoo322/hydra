/**
 * Anchor-type taxonomy-derived SLOT_ANCHOR_TYPE — completeness pin (#3253).
 *
 * Before #3253, `SLOT_ANCHOR_TYPE` was a hand-maintained seven-entry literal
 * covering only the pipeline slots (`dev_*`, `qa_*`, `research_*`,
 * `design_concept_orch`). The dispatch-class alphabet
 * (`scripts/autopilot/classes.json`) meanwhile grew ~13 signal classes
 * (`discover_*`, `architecture_orch`, `retro_orch`, `cleanup_*`, `sweep_*`,
 * `scout_orch`, `wire_or_retire_target`, `design_qa_target`, `skill_prune`,
 * `health`) with NO entry — so a cycle whose cycleId embedded one of those
 * slots decoded to `undefined` and fell through to the `unclassified` sentinel
 * (the 34% unknown/unclassified rate the architecture review flagged).
 *
 * This suite pins the fix: `SLOT_ANCHOR_TYPE` is DERIVED from
 * `DISPATCH_CLASSES`, so EVERY dispatch class carries an anchorType lane, and
 * the signal-class slots that used to fall through now decode through
 * `inferAnchorTypeFromCycleId` / `classifyAnchorType` into their own buckets.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SLOT_ANCHOR_TYPE,
  ANCHOR_TYPE_BY_CLASS,
  UNCLASSIFIED_ANCHOR_TYPE,
  inferAnchorTypeFromCycleId,
  classifyAnchorType,
} from "../src/autopilot/anchor-type.ts";
import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";

describe("SLOT_ANCHOR_TYPE is derived from the taxonomy — no drift (#3253)", () => {
  test("EVERY dispatch class in the taxonomy has a non-empty anchorType lane", () => {
    for (const row of DISPATCH_CLASSES) {
      const lane = SLOT_ANCHOR_TYPE[row.name];
      assert.equal(
        typeof lane,
        "string",
        `class "${row.name}" has no SLOT_ANCHOR_TYPE lane`,
      );
      assert.ok(
        (lane as string).length > 0,
        `class "${row.name}" maps to an empty anchorType lane`,
      );
      // A derived lane must never itself be the honest data-quality sentinel.
      assert.notEqual(
        lane,
        UNCLASSIFIED_ANCHOR_TYPE,
        `class "${row.name}" maps to the unclassified sentinel`,
      );
    }
  });

  test("SLOT_ANCHOR_TYPE keys exactly mirror the taxonomy class names", () => {
    const taxonomyNames = new Set(DISPATCH_CLASSES.map((r) => r.name));
    const slotNames = new Set(Object.keys(SLOT_ANCHOR_TYPE));
    assert.deepEqual(
      [...slotNames].sort(),
      [...taxonomyNames].sort(),
      "SLOT_ANCHOR_TYPE keys must equal the taxonomy class names",
    );
  });

  test("historical pipeline-slot lanes are preserved verbatim", () => {
    assert.equal(SLOT_ANCHOR_TYPE.dev_orch, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.dev_target, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.qa_orch, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.qa_target, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.design_concept_orch, "grill");
    assert.equal(SLOT_ANCHOR_TYPE.research_orch, "research");
    assert.equal(SLOT_ANCHOR_TYPE.research_target, "research");
  });

  test("the signal-class slots that used to fall through now have lanes", () => {
    // These were the missing entries pre-#3253 — the drift the fix closes.
    assert.equal(SLOT_ANCHOR_TYPE.cleanup_orch, "cleanup");
    assert.equal(SLOT_ANCHOR_TYPE.cleanup_target, "cleanup");
    assert.equal(SLOT_ANCHOR_TYPE.retro_orch, "retro");
    assert.equal(SLOT_ANCHOR_TYPE.discover_orch, "discover");
    assert.equal(SLOT_ANCHOR_TYPE.discover_target, "discover");
    assert.equal(SLOT_ANCHOR_TYPE.architecture_orch, "architecture");
    assert.equal(SLOT_ANCHOR_TYPE.sweep_orch, "sweep");
    assert.equal(SLOT_ANCHOR_TYPE.sweep_target, "sweep");
    assert.equal(SLOT_ANCHOR_TYPE.scout_orch, "scout");
  });

  test("ANCHOR_TYPE_BY_CLASS is the superset ANCHOR_TYPE_BY_CLASS[name] source", () => {
    // The exported per-class map backs the derived slot map; every taxonomy
    // class resolves through it identically.
    for (const row of DISPATCH_CLASSES) {
      assert.equal(SLOT_ANCHOR_TYPE[row.name], ANCHOR_TYPE_BY_CLASS[row.name]);
    }
  });
});

describe("cycleId inference decodes signal-class slots post-#3253", () => {
  test("a cleanup_orch worktree-branch cycleId no longer falls to unclassified", () => {
    // Pre-#3253 this decoded to undefined → classifyAnchorType returned
    // 'unclassified'. Now it decodes to the 'cleanup' lane.
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t3-cleanup_orch"),
      "cleanup",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-568fde2a-t3-cleanup_orch", undefined),
      "cleanup",
    );
  });

  test("discover / architecture / retro signal slots decode to their lanes", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-deadbeef-t1-discover_orch"),
      "discover",
    );
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-local-t2-architecture_orch"),
      "architecture",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-abcd1234-t7-retro_orch", undefined),
      "retro",
    );
  });

  test("the prefix-less relay form also decodes a signal slot (#3138 shape)", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("6fd1300b-t4-cleanup_target"),
      "cleanup",
    );
  });

  test("a genuinely non-dispatch cycleId still yields the honest sentinel", () => {
    assert.equal(
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", undefined),
      UNCLASSIFIED_ANCHOR_TYPE,
    );
  });
});
