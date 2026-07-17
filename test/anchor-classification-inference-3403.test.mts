/**
 * Issue #3403 — anchor classification 26% unclassified rate.
 *
 * The live 50-cycle sample carried 13 records stuck in the `unclassified`
 * bucket. Diagnosing the exact cycleIds against production /metrics showed three
 * families:
 *
 *   (A) DECODABLE — the cycleId unambiguously names a dispatch class, but the
 *       pre-#3403 parser rejected the shape:
 *         - the bare SKILL name as the whole cycleId (`hydra-dev`), and
 *         - a fence-less `<class-prefix>-<suffix>` id (`dev-3291`).
 *       `inferAnchorTypeFromCycleId` now decodes both via taxonomy-derived
 *       lookups (`SKILL_ANCHOR_TYPE` / `PREFIX_ANCHOR_TYPE`), so they land their
 *       real lane instead of the sentinel — and because `getMetricsTrend`
 *       re-infers stored sentinel rows from the cycleId (#3390), the fix drops
 *       the LIVE rate at read time with no Redis backfill.
 *
 *   (B) AMBIGUOUS-PREFIX SAFETY — `PREFIX_ANCHOR_TYPE` holds only prefixes that
 *       resolve to ONE lane, so an ambiguous prefix (`design` → grill vs
 *       design-qa) never guesses; it stays the honest sentinel.
 *
 *   (C) STRUCTURALLY UNDECODABLE — bare UUIDs, the harness's own
 *       `worktree-agent-<longhash>` branch names, and PR-number/turn-only tails
 *       carry NO class signal in the cycleId. These correctly STAY the
 *       `unclassified` sentinel (the #2822 "never guess" invariant); their
 *       upstream anchorType forward is the known #2800 gap, and they are
 *       surfaced as documented exceptions by `getUnclassifiedAnchors`.
 *
 * Pure classifier suite — no Redis, no clock. A change to the sentinel or the
 * inference legs fails HERE first, with no I/O in the way. cycleIds are taken
 * from the #3403 evidence block so the regression is anchored to real telemetry.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  inferAnchorTypeFromCycleId,
  classifyAnchorType,
  SKILL_ANCHOR_TYPE,
  PREFIX_ANCHOR_TYPE,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../src/autopilot/anchor-type.ts";

describe("inferAnchorTypeFromCycleId — skill-name + class-prefix legs (#3403)", () => {
  test("bare skill-name cycleId decodes to its class lane (`hydra-dev` → work-queue)", () => {
    assert.equal(inferAnchorTypeFromCycleId("hydra-dev"), "work-queue");
    assert.equal(classifyAnchorType("hydra-dev", undefined), "work-queue");
  });

  test("every taxonomy skill decodes via the skill-name leg", () => {
    // Every key in the derived skill→lane map must round-trip through the
    // inference function — the map and the parser can never drift.
    for (const [skill, lane] of Object.entries(SKILL_ANCHOR_TYPE)) {
      assert.equal(
        inferAnchorTypeFromCycleId(skill),
        lane,
        `skill '${skill}' must decode to '${lane}'`,
      );
    }
  });

  test("fence-less `<class-prefix>-<issue>` cycleId decodes (`dev-3291` → work-queue)", () => {
    assert.equal(inferAnchorTypeFromCycleId("dev-3291"), "work-queue");
    assert.equal(classifyAnchorType("dev-3291", undefined), "work-queue");
  });

  test("prefix leg agrees with the full-slot lane for every unambiguous prefix", () => {
    for (const [prefix, lane] of Object.entries(PREFIX_ANCHOR_TYPE)) {
      assert.equal(
        inferAnchorTypeFromCycleId(`${prefix}-9999`),
        lane,
        `prefix '${prefix}' must decode to '${lane}'`,
      );
    }
  });

  test("a fenced bare prefix tail decodes (`…-t3-dev` → work-queue)", () => {
    assert.equal(inferAnchorTypeFromCycleId("abc12345-t3-dev"), "work-queue");
  });
});

describe("PREFIX_ANCHOR_TYPE — ambiguous prefixes never guess (#3403)", () => {
  test("`design` is EXCLUDED (grill vs design-qa disagree) so it stays the sentinel", () => {
    // design_concept_orch → grill, design_qa_target → design-qa: the prefix is
    // ambiguous, so it must NOT be a key in the map...
    assert.equal(PREFIX_ANCHOR_TYPE.design, undefined);
    // ...and a bare `design-…` cycleId must stay unclassified rather than pick
    // one of the two lanes arbitrarily.
    assert.equal(inferAnchorTypeFromCycleId("design-4200"), undefined);
    assert.equal(classifyAnchorType("design-4200", undefined), UNCLASSIFIED_ANCHOR_TYPE);
  });

  test("every prefix in the map resolves to exactly one lane (unambiguous by construction)", () => {
    for (const lane of Object.values(PREFIX_ANCHOR_TYPE)) {
      assert.equal(typeof lane, "string");
      assert.ok(lane.length > 0);
    }
  });
});

describe("inferAnchorTypeFromCycleId — structurally undecodable ids stay the sentinel (#3403)", () => {
  // The exact still-unclassified cycleIds from the live #3403 sample that carry
  // NO class signal — bare UUIDs, harness branch names, PR-number/turn-only
  // tails. These MUST stay undefined (the #2822 never-guess invariant): the new
  // skill/prefix legs must not swallow a random hex/UUID segment.
  const UNDECODABLE_IDS = [
    "b8a3071f-a783-4812-bec5-8fa0f5079a08", // bare UUID
    "ec3928e1-e125-4342-8d4c-51bcd834fa19",
    "b9e6356d-7b33-4eda-b533-3b5e160aba53",
    "98fd3a0a-dd92-4977-a16d-ce536ca656ff",
    "b17ee362-3c54-4b5c-8707-8565b0cc9498-t3", // turn but no slot tail
    "worktree-agent-a9c177cfbcf1de7bf", // harness branch, no -t{N}- middle
    "worktree-agent-a4f8a3811688505c3",
    "worktree-agent-ad56fc40d1f365c08",
    "c6db11dc-t3-pr3326", // fenced, but `pr3326` is not a class/prefix
  ];

  for (const cycleId of UNDECODABLE_IDS) {
    test(`'${cycleId}' stays undefined → unclassified sentinel`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }

  test("an explicit anchorType still wins over the sentinel on an undecodable id", () => {
    assert.equal(
      classifyAnchorType("b8a3071f-a783-4812-bec5-8fa0f5079a08", "work-queue"),
      "work-queue",
    );
  });
});
