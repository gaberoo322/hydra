/**
 * Issue #3579 — the merge-watch FIRST-WRITE branch-fallback decode leg.
 *
 * ## The gap this pins
 *
 * When the merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`)
 * fires the merged-status enrichment for a PR that reap NEVER wrote a cycle-record
 * for (the qa_orch relay / dropped-arm case), that enrichment is the FIRST write.
 * Its cycleId is the raw dispatch id — frequently a bare UUID
 * (`afa22ef1-7e11-…`) that carries no decodable class token. Live telemetry
 * (2026-07-23) showed such first-writes bucketing to the `unclassified` sentinel
 * even when the merged PR's HEAD BRANCH did carry a decodable
 * `worktree-agent-<tok>-t{N}-<slot>` fence (e.g. `worktree-agent-afa22ef1-t2-dev_orch-3564`).
 *
 * The #2822 invariant (pinned in `classify-anchor-type-unclassified-2822.test.mts`)
 * stands: a cycleId with NO decodable token and NO explicit anchorType must land
 * the honest `unclassified` sentinel — never a fabricated class. This suite pins
 * the ORTHOGONAL improvement: when the caller ALSO supplies a decodable branch
 * ref (the merged PR's headRefName), `classifyAnchorType` decodes the class from
 * THAT ref using the EXACT SAME fence parser. It is not a guess — only a real
 * `-t{N}-<slot>` fence in the branch decodes; a bare-hash / descriptive branch
 * still returns the sentinel. So the #2822 "never guess" contract is preserved:
 * the branch is a second SOURCE of the same honest decode, not a fallback guess.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAnchorType,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../src/autopilot/anchor-type.ts";

describe("classifyAnchorType — merge-watch branch-fallback decode (#3579)", () => {
  test("undecodable bare-UUID cycleId + decodable fenced branch → decodes from branch", () => {
    // The live #3579 case: cycleId is the bare UUID, but the merged PR's head
    // branch carries the full `-t2-dev_orch` fence. `dev_orch` → `work-queue`.
    const result = classifyAnchorType(
      "afa22ef1-7e11-41e6-a78f-c725b46c7870", // bare UUID — no class token
      undefined, // no explicit anchorType (arm dropped it)
      "worktree-agent-afa22ef1-t2-dev_orch-3564", // head branch — decodable fence
    );
    assert.equal(
      result,
      "work-queue",
      "a decodable head branch must classify the first-write when the cycleId can't",
    );
  });

  test("branch fence carrying a signal class (qa_orch) decodes to its lane", () => {
    const result = classifyAnchorType(
      "b8a3071f-a783-4e1a-9c2d-0011deadbeef",
      undefined,
      "worktree-agent-b8a3071f-t1-qa_orch",
    );
    assert.equal(result, "qa-review");
  });

  test("prefix-less fenced branch (no worktree-agent- prefix) still decodes", () => {
    // The relay-shaped branch `<runtoken>-t{N}-<slot>` the reconcile path can see.
    const result = classifyAnchorType(
      "6fd1300b-0000-0000-0000-000000000000",
      undefined,
      "6fd1300b-t1-research_orch",
    );
    assert.equal(result, "research");
  });

  test("#2822 PRESERVED: undecodable cycleId + UNDECODABLE branch → sentinel", () => {
    // Both the cycleId AND the head branch are bare hashes / descriptive names
    // with no class token — the 18/19 live majority. Fabricating a class here
    // would violate #2822; the honest sentinel is correct.
    for (const branch of [
      "worktree-agent-a101470ed2d2384fa", // bare harness hash — no fence
      "issue-3527-pino-pattern-memory", // descriptive branch — no class token
      "docs/graduate-memory-gotchas-to-claude-md",
      "", // empty branch ref
    ]) {
      const result = classifyAnchorType(
        "145669af-ab4f-4d4b-aa18-cc1525e8db93",
        undefined,
        branch,
      );
      assert.equal(
        result,
        UNCLASSIFIED_ANCHOR_TYPE,
        `undecodable cycleId + undecodable branch '${branch}' must stay unclassified`,
      );
    }
  });

  test("explicit anchorType wins over branch decode (no clobber)", () => {
    // When the arm DID forward an explicit anchorType, that is authoritative —
    // the branch fallback must never override a caller-supplied classification.
    const result = classifyAnchorType(
      "afa22ef1-7e11-41e6-a78f-c725b46c7870",
      "grill", // explicit — e.g. a design_concept_orch arm
      "worktree-agent-afa22ef1-t2-dev_orch-3564", // branch says work-queue
    );
    assert.equal(result, "grill", "an explicit anchorType is authoritative");
  });

  test("cycleId decode wins over branch (cycleId is the primary source)", () => {
    // When the cycleId ITSELF decodes, the branch is never consulted — the
    // cycleId is the primary, more-specific source.
    const result = classifyAnchorType(
      "worktree-agent-afa22ef1-t2-qa_orch", // decodable → qa-review
      undefined,
      "worktree-agent-afa22ef1-t2-dev_orch-3564", // branch → work-queue (ignored)
    );
    assert.equal(result, "qa-review", "a decodable cycleId is the primary source");
  });

  test("omitting the branch arg preserves the exact prior two-arg behaviour", () => {
    // Back-compat: every existing caller passes two args. A decodable cycleId
    // still decodes; an undecodable one still lands the sentinel.
    assert.equal(
      classifyAnchorType("worktree-agent-x-t2-dev_orch", undefined),
      "work-queue",
    );
    assert.equal(
      classifyAnchorType("145669af-ab4f-4d4b-aa18-cc1525e8db93", undefined),
      UNCLASSIFIED_ANCHOR_TYPE,
    );
  });

  test("never throws on a malformed / non-string branch ref", () => {
    assert.doesNotThrow(() =>
      classifyAnchorType("145669af-ab4f", undefined, undefined),
    );
    assert.doesNotThrow(() =>
      classifyAnchorType("145669af-ab4f", undefined, "   "),
    );
  });
});
