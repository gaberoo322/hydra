/**
 * Issue #3138 — prefix-less relay cycleId anchorType inference.
 *
 * A dispatch cycle recorded with the PREFIX-LESS relay cycleId
 * `6fd1300b-t1-qa_orch` (no `worktree-agent-` prefix) was bucketed as
 * `unclassified`, because `inferAnchorTypeFromCycleId`'s regex hard-required the
 * `worktree-agent-` prefix. This is the qa_orch relay first-write case
 * (cycle-merge-reconcile / holdback-merge-watch write a cycle-record for a PR
 * the reap path never recorded, using a relay cycleId). The taxonomy module
 * (`producerClassFromCycleId`) ALREADY accepts the prefix-less shape by trailing
 * slot; the anchor-type leaf was the outlier.
 *
 * The fix makes the `worktree-agent-` prefix OPTIONAL and anchors the slot on
 * `_(orch|target)` (design-concept issue-3138, CANDIDATE B). This suite pins:
 *
 *   (1) a prefix-less `<runToken>-t<N>-<slot>` id resolves to the SAME
 *       anchorType its worktree-agent-prefixed twin resolves to;
 *   (2) every #2822 bare-UUID / short-hex / autopilot-prefixed id STILL returns
 *       the `unclassified` sentinel (the widened regex must not swallow them);
 *   (3) the harness's own bare `worktree-agent-<longhash>` branch (no -tN-<slot>
 *       suffix) STILL falls through to the sentinel.
 *
 * Isolates the pure `classifyAnchorType` seam (no Redis, no clock), so a change
 * to the regex fails HERE first, with no I/O in the way. Complementary to
 * `classify-anchor-type-unclassified-2822.test.mts` and
 * `autopilot-runs-anchortype-2762.test.mts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAnchorType,
  inferAnchorTypeFromCycleId,
  UNCLASSIFIED_ANCHOR_TYPE,
} from "../src/autopilot/anchor-type.ts";

// ADR-0027: the unclassified-anchorType fail-loud alarm now logs through the
// pino structured-logger seam (module singleton → process.stderr) instead of a
// freeform console.warn. Capture the serialized JSON lines and assert on the
// structured `level` field (pino: warn=40) rather than grepping console.warn.
function captureStderr(): { lines: () => Record<string, any>[]; restore: () => void } {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  return {
    lines: () =>
      buf
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, any>),
    restore: () => {
      (process.stderr as any).write = originalWrite;
    },
  };
}

describe("classifyAnchorType — prefix-less relay cycleId inference (#3138)", () => {
  // (1) The reported id plus one variant per slot family. Each is the
  // prefix-less twin of a worktree-agent-prefixed id the #2762 suite pins.
  const PREFIXLESS_CASES: ReadonlyArray<readonly [string, string]> = [
    ["6fd1300b-t1-qa_orch", "qa-review"], // the exact reported id
    ["6fd1300b-t3-dev_target", "work-queue"],
    ["568fde2a-t9-dev_orch", "work-queue"],
    ["cafe1234-t5-qa_target", "qa-review"],
    ["11223344-t2-design_concept_orch", "grill"],
    ["aabbccdd-t7-research_orch", "research"],
    ["local-t0-research_orch", "research"], // `local` run-token fallback
  ];

  for (const [cycleId, expected] of PREFIXLESS_CASES) {
    test(`prefix-less '${cycleId}' with no anchorType → ${expected}`, () => {
      assert.equal(classifyAnchorType(cycleId, undefined), expected);
    });
  }

  test("a prefix-less id resolves to the SAME anchorType as its worktree-agent twin", () => {
    // The core invariant: prefix presence must not change the answer.
    assert.equal(
      inferAnchorTypeFromCycleId("6fd1300b-t1-qa_orch"),
      inferAnchorTypeFromCycleId("worktree-agent-6fd1300b-t1-qa_orch"),
    );
    assert.equal(
      inferAnchorTypeFromCycleId("568fde2a-t9-dev_orch"),
      inferAnchorTypeFromCycleId("worktree-agent-568fde2a-t9-dev_orch"),
    );
  });

  test("does NOT emit a warn-level line when a prefix-less id resolves", () => {
    const cap = captureStderr();
    try {
      assert.equal(classifyAnchorType("6fd1300b-t1-qa_orch", undefined), "qa-review");
    } finally {
      cap.restore();
    }
    const warns = cap.lines().filter((o) => o.level === 40);
    assert.equal(warns.length, 0, "no warn when the slot is decodable");
  });
});

describe("classifyAnchorType — widened regex preserves #2822/harness negatives (#3138)", () => {
  // (2) The #2822 evidence ids. None carries a `-t<N>-<slot_ending_in_orch|target>`
  // middle, so each MUST still return the sentinel — the widened regex must not
  // swallow them. If any of these goes red, the regex is too loose.
  const SENTINEL_IDS = [
    "77d5c14c-0a6d-43ff-9fd4-d7c527964008", // bare UUID
    "53bf2557-30a7-4605-a3f2-d033e8bf208d",
    "ab07ae73cbba50381", // short-hex
    "aa6380135cb0ec4ba",
    "autopilot-28b7c14e", // autopilot- prefixed
    "worktree-agent-ab3a8b01c3f11f366", // (3) harness branch, no turn/slot suffix
    "6fd1300b-t1-unknown_class", // prefix-less but unmapped slot (not _orch/_target)
  ];

  for (const cycleId of SENTINEL_IDS) {
    test(`'${cycleId}' with no anchorType → unclassified sentinel`, () => {
      assert.equal(inferAnchorTypeFromCycleId(cycleId), undefined);
      assert.equal(classifyAnchorType(cycleId, undefined), UNCLASSIFIED_ANCHOR_TYPE);
    });
  }

  test("an explicit anchorType still wins over cycleId inference on a prefix-less id", () => {
    // The caller-supplied value takes precedence (classifyAnchorType's first
    // branch is unchanged) even when the cycleId would otherwise infer.
    assert.equal(classifyAnchorType("6fd1300b-t1-qa_orch", "work-queue"), "work-queue");
  });
});
