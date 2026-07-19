/**
 * Issue #3486 — 22% of recent scheduler cycles carry an unknown anchor-type.
 *
 * Over the live 50-cycle window, 11 cycles (22%) carried a `cycleId` matching
 * `claude-cycle-YYYY-MM-DD-HHMM` that decoded to no dispatch class, so they
 * landed with no `anchorType` and fell into the `unclassified` sentinel — opaque
 * to the tier classifier, anchor-selection, and outcome-impact ranking.
 *
 * Root cause: `claude-cycle-*` (and its inline-mode twin `inline-*`) is the
 * cycleId `hydra-target-build` registers in Step 0 of
 * `docs/operator-playbooks/hydra-target-build.md` (`CYCLE_ID="claude-cycle-$(date
 * -u +%Y-%m-%d-%H%M)"`, `source: "claude"`). Its tail is a `date` timestamp, not a
 * class token, so every pre-#3486 inference leg (skill-name, fenced `-t{N}-`,
 * class-prefix) missed it. But the LITERAL prefix is unambiguous: every such cycle
 * is a Target build — the `dev_target` class → `work-queue` lane.
 *
 * `inferAnchorTypeFromCycleId` now decodes both prefixes via a literal-prefix +
 * timestamp-anchor match, and because `getMetricsTrend` re-infers stored sentinel
 * rows from the cycleId (#3390), this drops the LIVE unclassified rate at read
 * time with no Redis backfill.
 *
 * This suite also pins the #2822 "never guess" invariant: the new leg's timestamp
 * anchor must NOT swallow a bare UUID / short-hex / harness-branch cycleId.
 *
 * Pure classifier suite — no Redis, no clock. A change to the leg fails HERE
 * first. cycleIds are taken from the #3486 evidence block so the regression is
 * anchored to real telemetry.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  inferAnchorTypeFromCycleId,
  classifyAnchorType,
  ANCHOR_TYPE_BY_CLASS,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../src/autopilot/anchor-type.ts";

describe("inferAnchorTypeFromCycleId — hydra-target-build cycleId leg (#3486)", () => {
  // The exact cycleIds from the #3486 evidence block.
  const TARGET_BUILD_IDS = [
    "claude-cycle-2026-07-18-2101",
    "claude-cycle-2026-07-18-2030",
    "claude-cycle-2026-07-18-1955",
  ];

  for (const cycleId of TARGET_BUILD_IDS) {
    test(`'${cycleId}' decodes to the dev_target lane (work-queue)`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), "work-queue");
      assert.equal(classifyAnchorType(cycleId, undefined), "work-queue");
    });
  }

  test("the decoded lane IS the taxonomy dev_target lane (derived, not hard-coded)", () => {
    // The leg must track the taxonomy alphabet: if dev_target ever re-lanes, the
    // decode follows. Guards against a hard-coded string drifting from the map.
    assert.equal(
      inferAnchorTypeFromCycleId("claude-cycle-2026-07-18-2101"),
      ANCHOR_TYPE_BY_CLASS.dev_target,
    );
  });

  test("the inline-mode twin `inline-YYYY-MM-DD-HHMM` decodes to the same lane", () => {
    // The inline-mode fragment emits `cycleId:"inline-$(date -u +%Y-%m-%d-%H%M)"`.
    assert.equal(inferAnchorTypeFromCycleId("inline-2026-07-18-2101"), "work-queue");
    assert.equal(classifyAnchorType("inline-2026-07-18-2101", undefined), "work-queue");
  });

  test("a trailing `-<suffix>` (manual item-tagged runs) still decodes", () => {
    // `~/hydra-betting/reports` shows `claude-cycle-2026-05-16-0727-item284`.
    assert.equal(
      inferAnchorTypeFromCycleId("claude-cycle-2026-05-16-0727-item284"),
      "work-queue",
    );
  });

  test("an explicit anchorType still wins over the cycleId decode", () => {
    // The write-path precedence is unchanged: a caller-supplied good anchorType
    // is never overwritten by the inference leg.
    assert.equal(
      classifyAnchorType("claude-cycle-2026-07-18-2101", "research"),
      "research",
    );
  });
});

describe("inferAnchorTypeFromCycleId — target-build leg never guesses (#3486 / #2822)", () => {
  // The new literal-prefix + timestamp leg must NOT swallow any id that carries
  // no class signal. These MUST stay undefined → unclassified sentinel.
  const UNDECODABLE_IDS = [
    "b8a3071f-a783-4812-bec5-8fa0f5079a08", // bare UUID — no claude-cycle/inline prefix
    "worktree-agent-a9c177cfbcf1de7bf", // harness branch
    "claude-cycle-2026-07-18", // prefix but no HHMM segment (not a full timestamp)
    "claude-cycle-not-a-timestamp", // prefix but non-numeric tail
    "inline", // bare prefix, no timestamp
    "claude-cycle", // bare prefix, no timestamp
    "some-claude-cycle-2026-07-18-2101", // timestamp shape but not prefix-anchored
  ];

  for (const cycleId of UNDECODABLE_IDS) {
    test(`'${cycleId}' stays undefined → unclassified sentinel`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }

  test("never throws on a target-build-shaped cycleId (no crash path)", () => {
    assert.doesNotThrow(() => classifyAnchorType("claude-cycle-2026-07-18-2101", undefined));
    assert.doesNotThrow(() => inferAnchorTypeFromCycleId("claude-cycle-2026-07-18-2101"));
  });
});
