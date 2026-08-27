/**
 * Regression guard for issue #4177's INV-10: the #4175 detection backstop
 * (the node_modules integrity watchdog) is untouched by the #4177 worktree
 * relocation — this issue must not edit scripts/hydra-watchdog.sh,
 * src/notification/alert-grammar.ts, src/event-bus-vocabulary.ts, or
 * src/digest.ts.
 *
 * #4175 and #4177 are deliberately independent (detection vs. prevention),
 * so #4177's diff must never touch the four files the #4175 feature lives
 * in. This test asserts the exact structural markers of that feature are
 * still present, verbatim, in all four — the mechanical proxy for
 * "the detection backstop was not broken by this PR" a `test:` assertion
 * can express (a pure git-diff-excludes-these-paths check has no assertion
 * grammar of its own; this is the closest behavioural proxy).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf-8");

describe("issue #4177 must not touch the #4175 node_modules integrity watchdog (INV-10)", () => {
  test("scripts/hydra-watchdog.sh still carries the NODE MODULES INTEGRITY block", () => {
    const src = read("scripts/hydra-watchdog.sh");
    assert.match(src, /## NODE MODULES INTEGRITY/);
    assert.match(src, /run_node_modules_integrity/);
  });

  test("src/event-bus-vocabulary.ts still declares INFRA_NODE_MODULES_WIPED", () => {
    const src = read("src/event-bus-vocabulary.ts");
    assert.match(src, /INFRA_NODE_MODULES_WIPED:\s*"infra:node_modules_wiped"/);
  });

  test("src/notification/alert-grammar.ts still formats INFRA_NODE_MODULES_WIPED", () => {
    const src = read("src/notification/alert-grammar.ts");
    assert.match(src, /E\.INFRA_NODE_MODULES_WIPED/);
  });

  test("src/digest.ts still routes INFRA_NODE_MODULES_WIPED through the immediate CRITICAL bypass", () => {
    const src = read("src/digest.ts");
    assert.match(src, /E\.INFRA_NODE_MODULES_WIPED/);
  });
});
