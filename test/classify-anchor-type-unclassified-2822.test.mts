/**
 * Issue #2822 — pin the bare-UUID `unclassified` invariant.
 *
 * #2822 reported that 14% of the recent metrics window carried
 * `anchorType: "unclassified"`. The design-concept (approved, hash 5265e45d…)
 * established that this is NOT a live bug:
 *
 *   - Both live anchorType writers — `recordCycle()` (POST
 *     /autopilot/cycle-record) and the direct POST /metrics/record handler —
 *     ALREADY route through `classifyAnchorType()` (src/autopilot/cycle-close.ts),
 *     and `dispatch.sh cycle-record` always stamps `anchor_type` from `$skill`.
 *     No code-writing dispatch produces `unclassified`.
 *   - The 14% was rolling-window RESIDUE: bare-UUID cycleIds recorded BEFORE the
 *     #2803/#2806 classify fixes deployed, still inside the 7-day rolling window.
 *   - The one residual live path — a bare-UUID POST to /metrics/record with no
 *     `anchorType` — is WORKING AS DESIGNED: a raw UUID is not slot-decodable, so
 *     the honest `unclassified` sentinel is the correct, visible outcome.
 *
 * This suite pins `classifyAnchorType` directly (a pure function — no Redis, no
 * clock) so the invariant behind the "false alarm" verdict can never silently
 * regress:
 *
 *   (a) a bare-UUID cycleId with NO anchorType records the `unclassified`
 *       SENTINEL — never the aggregator's `"unknown"` catch-all, never a crash;
 *   (b) a slot-suffixed worktree-branch cycleId still INFERS its anchorType.
 *
 * The exact bare-UUID / short-hex cycleIds `classifyAnchorType` receives are
 * taken from the #2822 evidence block so the regression is anchored to the
 * real telemetry that raised the alarm.
 *
 * Distinct from `autopilot-runs-anchortype-2762.test.mts` (which drives the
 * full `recordCycle` write path against an in-memory deps fixture) and
 * `metrics-record-schema-guard.test.mts` (which drives the HTTP handler against
 * Redis): this suite isolates the classifier itself, so a change to the
 * sentinel or the slot-inference regex fails HERE first, with no I/O in the way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAnchorType,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../src/autopilot/cycle-close.ts";

// The literal the metrics aggregator (src/metrics/aggregate.ts) maps an
// absent/empty/whitespace anchorType to. The whole point of the sentinel is
// that classifyAnchorType NEVER lets a metrics record fall into this bucket —
// so it must be a DISTINCT string from the sentinel.
const AGGREGATOR_UNKNOWN_BUCKET = "unknown";

describe("classifyAnchorType — bare-UUID unclassified invariant (#2822)", () => {
  // The bare-UUID + short-hex cycleIds from the #2822 evidence block. None is
  // slot-decodable (no `worktree-agent-…-tN-<slot>` shape), so each MUST land
  // the honest `unclassified` sentinel when no anchorType is supplied.
  const BARE_CYCLE_IDS = [
    "77d5c14c-0a6d-43ff-9fd4-d7c527964008", // → PR #2796
    "53bf2557-30a7-4605-a3f2-d033e8bf208d", // → PR #2786
    "991a8895-569a-4e38-ad1c-f3c79e696719", // → PR #2765
    "ab07ae73cbba50381", // short-hex, → PR #2787
    "aa6380135cb0ec4ba", // short-hex, → PR #2774
    "autopilot-28b7c14e", // autopilot- prefixed, → PR #2770
  ];

  for (const cycleId of BARE_CYCLE_IDS) {
    test(`bare cycleId '${cycleId}' with no anchorType → unclassified sentinel`, () => {
      // `undefined` is what recordCycle passes for an absent body.anchorType.
      const result = classifyAnchorType(cycleId, undefined);
      assert.equal(
        result,
        UNCLASSIFIED_ANCHOR_TYPE,
        "a non-slot-decodable cycleId with no anchorType must land the sentinel",
      );
    });
  }

  test("the sentinel is NEVER the aggregator's 'unknown' catch-all", () => {
    // The invariant that makes the sentinel worth having: it is a DISTINCT,
    // attributable value, so a post-fix `unknown` bucket can only mean a record
    // predates the classify fix — never that classification silently fell
    // through. If these two strings ever collide the distinction is lost.
    assert.notEqual(UNCLASSIFIED_ANCHOR_TYPE, AGGREGATOR_UNKNOWN_BUCKET);
    assert.equal(UNCLASSIFIED_ANCHOR_TYPE, "unclassified");
  });

  test("returns a non-empty string (never undefined/empty) so the aggregator can't bucket it 'unknown'", () => {
    // aggregate.ts maps an absent/empty/whitespace anchorType to "unknown"
    // (`(m.anchorType && String(m.anchorType).trim()) || "unknown"`). A
    // non-empty return here is precisely what prevents that fall-through.
    for (const raw of [undefined, null, "", "   "]) {
      const result = classifyAnchorType(
        "77d5c14c-0a6d-43ff-9fd4-d7c527964008",
        raw,
      );
      assert.equal(typeof result, "string");
      assert.ok(result.trim().length > 0, `non-empty for raw=${JSON.stringify(raw)}`);
      assert.notEqual(result, AGGREGATOR_UNKNOWN_BUCKET);
    }
  });

  test("never throws on a bare-UUID cycleId (no crash path)", () => {
    // #2822 explicitly requires the bare-UUID path to be crash-free.
    assert.doesNotThrow(() =>
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", undefined),
    );
  });

  test("(b) a slot-suffixed worktree-branch cycleId still INFERS its anchorType", () => {
    // The complementary invariant: the sentinel must NOT swallow a cycleId that
    // IS slot-decodable — a real anchorType is recovered from the slot suffix.
    assert.equal(
      classifyAnchorType("worktree-agent-568fde2a-t9-dev_orch", undefined),
      "work-queue",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-deadbeef-t12-qa_orch", undefined),
      "qa-review",
    );
    assert.equal(
      classifyAnchorType("worktree-agent-11223344-t2-design_concept_orch", undefined),
      "grill",
    );
  });

  test("an explicit anchorType on a bare-UUID cycleId is honoured (not overridden by the sentinel)", () => {
    // When the caller DID supply a good anchorType, the bare-UUID shape must not
    // force the sentinel — the explicit value wins.
    assert.equal(
      classifyAnchorType("77d5c14c-0a6d-43ff-9fd4-d7c527964008", "work-queue"),
      "work-queue",
    );
  });
});
