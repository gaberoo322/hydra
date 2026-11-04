/**
 * test/lifecycle-seam-check.test.mts — blocking shrink-only ratchet against
 * direct lifecycle state-label writes (ADR-0047 D3/D7, issue #5311). Runs in
 * the required `test` job; the redis-seam-check pattern.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const {
  fileViolatesLifecycleSeam,
  findLifecycleSeamViolations,
  lifecycleSeamFailures,
} = await import("../scripts/ci/lifecycle-seam-check.ts");

const PB = "docs/operator-playbooks/hydra-x.md";

describe("lifecycle-seam-check: playbook grammar", () => {
  test("flags gh issue edit --add-label with a state", () => {
    assert.equal(fileViolatesLifecycleSeam(PB, "gh issue edit 5 --add-label needs-qa"), true);
  });

  test("flags --remove-label, quoted and comma-joined forms", () => {
    assert.equal(
      fileViolatesLifecycleSeam(PB, `gh issue edit "$N" --remove-label "ready-for-agent,foo"`),
      true,
    );
  });

  test("flags a backslash-continued command", () => {
    assert.equal(
      fileViolatesLifecycleSeam(PB, "gh issue edit 5 \\\n  --repo a/b \\\n  --add-label in-progress"),
      true,
    );
  });

  test("flags gh api labels naming a state", () => {
    assert.equal(
      fileViolatesLifecycleSeam(PB, "gh api repos/a/b/issues/5/labels -f 'labels[]=needs-qa'"),
      true,
    );
  });

  test("does not flag non-state labels or reads", () => {
    assert.equal(fileViolatesLifecycleSeam(PB, "gh issue edit 5 --add-label glm-eligible"), false);
    assert.equal(fileViolatesLifecycleSeam(PB, "gh issue list --label needs-qa"), false);
  });
});

describe("lifecycle-seam-check: source grammar", () => {
  test("flags addIssueLabel / editIssueLabels with a state literal outside src/lifecycle", () => {
    assert.equal(
      fileViolatesLifecycleSeam("src/foo.ts", `await addIssueLabel(1, "needs-qa");`),
      true,
    );
    assert.equal(
      fileViolatesLifecycleSeam("src/foo.ts", `editIssueLabels(1, { add: ["in-progress"] });`),
      true,
    );
  });

  test("flags a same-file const alias of a state", () => {
    assert.equal(
      fileViolatesLifecycleSeam(
        "src/foo.ts",
        `const L = "needs-qa";\nawait removeIssueLabel(1, L);`,
      ),
      true,
    );
  });

  test("does not flag non-state labels, comments, or src/lifecycle itself", () => {
    assert.equal(
      fileViolatesLifecycleSeam("src/foo.ts", `addIssueLabel(1, "glm-eligible");`),
      false,
    );
    assert.equal(
      fileViolatesLifecycleSeam("src/foo.ts", `// addIssueLabel(1, "needs-qa")`),
      false,
    );
    assert.equal(
      fileViolatesLifecycleSeam("src/lifecycle/seam.ts", `addIssueLabel(1, "needs-qa");`),
      false,
    );
  });
});

describe("lifecycle-seam-check: shrink-only ratchet", () => {
  test("the committed baseline matches the tree", async () => {
    const msgs = await lifecycleSeamFailures(await findLifecycleSeamViolations());
    assert.deepEqual(msgs, []);
  });

  test("a new violator fails naming scripts/lifecycle.ts", async () => {
    const current = await findLifecycleSeamViolations();
    const msgs = await lifecycleSeamFailures([...current, "docs/operator-playbooks/new.md"]);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0]!, /new\.md/);
    assert.match(msgs[0]!, /scripts\/lifecycle\.ts/);
  });

  test("a removed violator without a shrunk baseline fails with a shrink instruction", async () => {
    const current = await findLifecycleSeamViolations();
    const msgs = await lifecycleSeamFailures(current.slice(1));
    assert.equal(msgs.length, 1);
    assert.match(msgs[0]!, /--write-baseline/);
  });
});
