/**
 * Regression pins for issue #4224 — the operator-review fence's step-skip
 * carve-out (the advisory finding of the #4230 QA review).
 *
 * The fenced branch of the merge-flow fragment's 7b decision table tells the
 * build agent which post-merge steps to skip when handing a fenced PR to the
 * operator. The merged wording enumerated the skip as a range — "Steps
 * 7.5–8.6" — one sentence after an explicit carve-out said local worktree
 * cleanup (Step 8.5) "is safe and should still run". 8.5 sits numerically
 * inside that range, so the two statements contradict each other, and a
 * build agent that reads the range over the carve-out leaks the worktree and
 * its branch claim on every fenced handoff. These pins hold the skip list to
 * the QA-suggested explicit enumeration.
 *
 * Companion to the fail-closed lookup pins in test/sync-target-gate.test.mts
 * (open PR #4232) — this file deliberately does not touch that one, so the
 * two PRs merge without textual conflicts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENT_PATH =
  "docs/operator-playbooks/_fragments/hydra-target-build-merge-flow.md";
const FRAGMENT = readFileSync(join(REPO_ROOT, FRAGMENT_PATH), "utf-8");

test("the fenced branch step-skip list names its steps and excludes Step 8.5 (#4224, #4230 QA advisory)", () => {
  // The skip enumeration must be the explicit list ...
  assert.match(
    FRAGMENT,
    /Skip Steps 7\.5, 8, and 8\.6 — NOT Step 8\.5/,
    "the fenced skip list must enumerate 7.5, 8, and 8.6 explicitly, excluding 8.5",
  );
  // ... and the range form that numerically swallows Step 8.5 must not
  // return as an instruction.
  assert.doesNotMatch(
    FRAGMENT,
    /Skip Steps 7\.5–8\.6/,
    "a 'Skip Steps 7.5–8.6' range contradicts the Step 8.5 carve-out one bullet above",
  );
});

test("the fenced branch still carves out local worktree cleanup while skipping the merged-PR steps (#4224)", () => {
  assert.match(
    FRAGMENT,
    /Local worktree cleanup \(Step 8\.5\)\s*is safe and should still run\./,
    "the fenced branch must keep the explicit Step 8.5 carve-out",
  );
});
