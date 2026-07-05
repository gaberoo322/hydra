/**
 * Anchor-type classification-policy LEAF — pure-module extraction pin (#2858).
 *
 * The five anchor-type classification symbols (`UNCLASSIFIED_ANCHOR_TYPE`,
 * `isMalformedAnchorType`, `classifyAnchorType`, `SLOT_ANCHOR_TYPE`,
 * `inferAnchorTypeFromCycleId`) were extracted out of the cycle-record WRITE
 * coordinator (`src/autopilot/cycle-close.ts`) into a pure, zero-I/O leaf
 * `src/autopilot/anchor-type.ts`.
 *
 * This suite:
 *   1. Imports the policy DIRECTLY from the new leaf and pins its behaviour with
 *      pure string inputs — no Redis fixture, no cycle-record schema, no `deps`
 *      bag. That the import resolves + the assertions pass IS the leaf's
 *      zero-I/O contract (the module cannot be loaded if it pulled in the Redis
 *      accessors the write coordinator carries).
 *   2. Pins the #2858 back-compat guarantee: the SAME symbols re-exported from
 *      `cycle-close.ts` are referentially identical to the leaf's exports, so
 *      any legacy importer that still targets the write coordinator keeps
 *      resolving to the one canonical implementation (no duplicated policy).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  UNCLASSIFIED_ANCHOR_TYPE,
  isMalformedAnchorType,
  classifyAnchorType,
  SLOT_ANCHOR_TYPE,
  inferAnchorTypeFromCycleId,
} from "../src/autopilot/anchor-type.ts";

import * as cycleClose from "../src/autopilot/cycle-close.ts";

describe("anchor-type policy leaf — pure classification (#2858)", () => {
  test("UNCLASSIFIED_ANCHOR_TYPE is the honest sentinel, distinct from 'unknown'", () => {
    assert.equal(UNCLASSIFIED_ANCHOR_TYPE, "unclassified");
    assert.notEqual(UNCLASSIFIED_ANCHOR_TYPE, "unknown");
  });

  test("SLOT_ANCHOR_TYPE maps each dispatch-class slot to its anchorType", () => {
    assert.equal(SLOT_ANCHOR_TYPE.dev_orch, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.dev_target, "work-queue");
    assert.equal(SLOT_ANCHOR_TYPE.qa_orch, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.qa_target, "qa-review");
    assert.equal(SLOT_ANCHOR_TYPE.design_concept_orch, "grill");
    assert.equal(SLOT_ANCHOR_TYPE.research_orch, "research");
    assert.equal(SLOT_ANCHOR_TYPE.research_target, "research");
  });

  test("isMalformedAnchorType rejects flag-shaped + unmapped sentinel forms", () => {
    // Flag-shaped: a leaked CLI token.
    assert.equal(isMalformedAnchorType("--status"), true);
    assert.equal(isMalformedAnchorType("-x"), true);
    // dispatch.sh's unmapped-skill sentinel.
    assert.equal(isMalformedAnchorType("unmapped"), true);
    assert.equal(isMalformedAnchorType("unmapped:completed"), true);
    // Genuine anchor types pass through.
    assert.equal(isMalformedAnchorType("work-queue"), false);
    assert.equal(isMalformedAnchorType("qa-review"), false);
    assert.equal(isMalformedAnchorType("grill"), false);
  });

  test("inferAnchorTypeFromCycleId decodes the worktree-branch slot suffix", () => {
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t9-dev_orch"),
      "work-queue",
    );
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-local-t1-qa_orch"),
      "qa-review",
    );
    // Non-matching shapes / unknown slots → undefined.
    assert.equal(inferAnchorTypeFromCycleId("worktree-agent-abc-nolongsuffix"), undefined);
    assert.equal(
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t9-not_a_slot"),
      undefined,
    );
    assert.equal(
      inferAnchorTypeFromCycleId("77d5c14c-0a6d-43ff-9fd4-d7c527964008"),
      undefined,
    );
  });

  test("classifyAnchorType: explicit value > slot inference > sentinel", () => {
    // Explicit non-empty, non-malformed value wins (trimmed).
    assert.equal(classifyAnchorType("any-id", "  work-queue  "), "work-queue");
    // Malformed explicit value falls through to slot inference.
    assert.equal(
      classifyAnchorType("worktree-agent-deadbeef-t2-dev_orch", "--status"),
      "work-queue",
    );
    // No explicit value + slot-decodable cycleId → inferred.
    assert.equal(
      classifyAnchorType("worktree-agent-11223344-t2-design_concept_orch", undefined),
      "grill",
    );
    // No explicit value + no slot → honest sentinel, never undefined.
    assert.equal(
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", undefined),
      UNCLASSIFIED_ANCHOR_TYPE,
    );
  });
});

describe("anchor-type policy leaf — cycle-close.ts back-compat re-export (#2858)", () => {
  test("the write coordinator re-exports the SAME implementations", () => {
    // Referential identity: the re-export is a pass-through of the leaf's
    // symbols, not a duplicated copy — so there is exactly one classification
    // policy, importable from either home during the migration window.
    assert.equal(cycleClose.UNCLASSIFIED_ANCHOR_TYPE, UNCLASSIFIED_ANCHOR_TYPE);
    assert.equal(cycleClose.isMalformedAnchorType, isMalformedAnchorType);
    assert.equal(cycleClose.classifyAnchorType, classifyAnchorType);
    assert.equal(cycleClose.SLOT_ANCHOR_TYPE, SLOT_ANCHOR_TYPE);
    assert.equal(cycleClose.inferAnchorTypeFromCycleId, inferAnchorTypeFromCycleId);
  });
});
