/**
 * test/lifecycle-seam-check.test.mts — blocking shrink-only ratchet against
 * direct lifecycle state-label writes (ADR-0047 D3/D7, issue #5311).
 *
 * The live describe is the gate (runs in the REQUIRED `test` job). This file
 * does no fs read itself — it calls the script's exported functions.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { OPEN_STATES } from "../src/lifecycle/index.ts";

const {
  LIFECYCLE_STATE_NAMES,
  REPO_ROOT,
  checkLifecycleRatchet,
  loadLifecycleBaseline,
  scanFileSites,
  scanLifecycleSeam,
} = await import("../scripts/ci/lifecycle-seam-check.ts");

describe("lifecycle-seam-check: live tree vs committed baseline", () => {
  test("scanner vocabulary is exactly OPEN_STATES", () => {
    assert.deepEqual([...LIFECYCLE_STATE_NAMES], [...OPEN_STATES]);
    assert.equal(LIFECYCLE_STATE_NAMES.includes("closed"), false);
  });

  test("no new direct state-label write sites and the baseline is not stale", async () => {
    const verdict = checkLifecycleRatchet(
      await scanLifecycleSeam(REPO_ROOT),
      await loadLifecycleBaseline(REPO_ROOT),
    );
    assert.deepEqual(verdict.messages, []);
    assert.equal(verdict.ok, true);
  });
});

describe("lifecycle-seam-check: ratchet verdicts", () => {
  const observed = { "docs/operator-playbooks/hydra-x.md": { count: 2, lines: [3, 9] } };

  test("observed above baseline (unlisted = 0) fails naming the file, lines and scripts/lifecycle.ts", () => {
    const v = checkLifecycleRatchet(observed, { files: {} });
    assert.equal(v.ok, false);
    assert.match(v.messages[0]!, /new direct state-label write in docs\/operator-playbooks\/hydra-x\.md/);
    assert.match(v.messages[0]!, /lines 3, 9/);
    assert.match(v.messages[0]!, /scripts\/lifecycle\.ts advance/);
  });

  test("a new site in an already-baselined file still fails (per-file count)", () => {
    const v = checkLifecycleRatchet(observed, { files: { "docs/operator-playbooks/hydra-x.md": 1 } });
    assert.equal(v.ok, false);
    assert.match(v.messages[0]!, /new direct state-label write/);
  });

  test("observed below baseline, or a vanished file, fails with the shrink command", () => {
    const below = checkLifecycleRatchet(observed, { files: { "docs/operator-playbooks/hydra-x.md": 3 } });
    assert.equal(below.ok, false);
    assert.match(below.messages[0]!, /baseline is stale/);
    assert.match(below.messages[0]!, /--shrink-baseline/);
    const gone = checkLifecycleRatchet({}, { files: { "docs/gone.md": 1 } });
    assert.equal(gone.ok, false);
    assert.match(gone.messages[0]!, /baseline is stale/);
  });

  test("an exact match passes with the total", () => {
    const v = checkLifecycleRatchet(observed, { files: { "docs/operator-playbooks/hydra-x.md": 2 } });
    assert.equal(v.ok, true);
    assert.equal(v.total, 2);
  });
});

describe("lifecycle-seam-check: detection grammar (synthetic)", () => {
  const md = (text: string) => scanFileSites("docs/operator-playbooks/hydra-x.md", text);
  const ts = (text: string) => scanFileSites("src/x.ts", text);

  test("state literal after --add-label is a site", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label needs-qa"), [1]);
  });

  test("flag-only literal writes are not sites", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label glm-withhold"), []);
  });

  test("needs-qa-override never matches needs-qa", () => {
    assert.deepEqual(md("gh issue edit 5 --add-label needs-qa-override"), []);
  });

  test("a variable operand is a site", () => {
    assert.deepEqual(md('gh issue edit 5 --remove-label "$l"'), [1]);
  });

  test("one line is at most one site", () => {
    assert.deepEqual(md("gh issue edit 5 --remove-label needs-qa --add-label in-progress"), [1]);
  });

  test("gh api labels GET is not a site; DELETE of a state is", () => {
    assert.deepEqual(md("gh api repos/a/b/issues/5/labels"), []);
    assert.deepEqual(md("gh api -X DELETE repos/a/b/issues/5/labels/needs-qa"), [1]);
  });

  test("TS: ORCH_BOARD_LABELS key resolving to a state is a site", () => {
    assert.deepEqual(ts("await addIssueLabel(1, ORCH_BOARD_LABELS.needs_qa);"), [1]);
  });

  test("TS: a flag const is not a site, a state const is", () => {
    assert.deepEqual(ts('const F = "glm-withhold";\nawait addIssueLabel(1, F);'), []);
    assert.deepEqual(ts('const S = "in-progress";\nawait removeIssueLabel(1, S);'), [2]);
  });

  test("TS: pass-through labels object and parameters fail closed", () => {
    assert.deepEqual(ts("await deps.editIssueLabels(1, labels);"), [1]);
    assert.deepEqual(ts("await addIssueLabel(n, label);"), [1]);
  });

  test("TS: each editIssueLabels array element is its own site", () => {
    assert.equal(ts('editIssueLabels(1, { remove: ["in-progress"], add: ["needs-qa", "glm-withhold"] });').length, 2);
  });

  test("TS: comment-only mentions and function definitions are not sites", () => {
    assert.deepEqual(ts('// addIssueLabel(1, "needs-qa")'), []);
    assert.deepEqual(ts("export async function addIssueLabel(n: number, label: string) {}"), []);
  });

  test("exempt paths yield no sites", () => {
    assert.deepEqual(scanFileSites("src/lifecycle/seam.ts", 'addIssueLabel(1, "needs-qa");'), []);
    assert.deepEqual(scanFileSites("scripts/lifecycle.ts", 'addIssueLabel(1, "needs-qa");'), []);
    assert.deepEqual(
      scanFileSites("docs/operator-playbooks/hydra-target-qa.md", "gh issue edit 5 --add-label needs-qa"),
      [],
    );
  });
});
