/**
 * The decide.py side of the Target board's advisory-only keys (#3973, #4528,
 * #4823): nothing in decide.py may read or gate on them. The collectors that
 * emit them are pinned in test/turn-snapshot-target-board.test.mts.
 *
 * This file used to pin the Target board emission (issues #3435, #3709,
 * #3710, #3973, #4130, #4528, #4823) and then the `gh issue list` page-size
 * ratchet over collect-state.sh (#3710). The emission moved to the typed Turn
 * Snapshot collectors (ADR-0043 slice 4, #4932) and collect-state.sh itself
 * was deleted with the kv wire (slice 6b, #4934), taking the ratchet's subject
 * with it: the collectors read GitHub through the typed port with an explicit
 * `ghListLimit`.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("decide.py never gates on the Target board's advisory keys (#3973, #4528, #4823)", () => {
  const decide = readFileSync(join(REPO_ROOT, "scripts", "autopilot", "decide.py"), "utf-8");

  test("target_ready_blocker_excluded is advisory: nothing in decide.py reads or gates on it", () => {
    assert.doesNotMatch(decide, /target_ready_blocker_excluded/);
  });

  test("wire_or_retire_target_unlabelled is advisory: nothing in decide.py reads or gates on it", () => {
    assert.doesNotMatch(decide, /wire_or_retire_target_unlabelled/);
  });

  test("design_qa_target_adr_present is advisory: decide.py never gates on it", () => {
    assert.doesNotMatch(decide, /design_qa_target_adr_present/);
  });
});
