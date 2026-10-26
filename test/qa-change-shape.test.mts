/**
 * Moved verbatim from test/hydra-qa-prompt-verdict.test.mts (issue #5079,
 * ADR-0038 D2 — mechanical move): the change-shape leaf — prompt-only / tests-only / docs-only / code cases.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  type ChangeShape,
  classifyChangeShape,
  isPromptOnlyChange,
  isPromptPath,
} from "../src/qa/change-shape.ts";

describe("classifyChangeShape — pure change-shape classifier (issue #4733)", () => {
  const table: Array<{ name: string; paths: string[]; shape: ChangeShape }> = [
    { name: "single ADR doc", paths: ["docs/adr/0042-x.md"], shape: "docs-only" },
    { name: "top-level markdown + changelog fragment", paths: ["README.md", ".changelog/1-x.md"], shape: "docs-only" },
    { name: "research doc", paths: ["docs/research/2026-09-28-x.md"], shape: "docs-only" },
    { name: "tests only", paths: ["test/foo.test.mts", "test/fixtures/foo.json"], shape: "tests-only" },
    { name: "tests + docs (most behavioural non-code part wins)", paths: ["test/foo.test.mts", "docs/x.md"], shape: "tests-only" },
    { name: "playbook only", paths: ["docs/operator-playbooks/hydra-qa.md"], shape: "prompt-only" },
    { name: "agent config lesson", paths: ["config/agents/dev.md", "config/feedback/x.json"], shape: "prompt-only" },
    { name: "playbook + its test", paths: ["docs/operator-playbooks/hydra-qa.md", "test/x.test.mts"], shape: "prompt-only" },
    { name: "mixed: a doc and a src/ file", paths: ["docs/adr/0042-x.md", "src/foo.ts"], shape: "code" },
    { name: "mixed: a test and a src/ file", paths: ["test/x.test.mts", "src/x.ts"], shape: "code" },
    // Built at runtime so no `scripts/**` literal makes the test-subject resolver pick the facade.
    { name: "mixed: a test and a scripts/ file", paths: ["test/x.test.mts", ["scripts", "x.ts"].join("/")], shape: "code" },
    { name: "mixed: playbook and dashboard/src", paths: ["docs/operator-playbooks/hydra-qa.md", "dashboard/src/App.tsx"], shape: "code" },
    { name: ".github markdown", paths: [".github/PULL_REQUEST_TEMPLATE.md"], shape: "code" },
    { name: "src/ CONTEXT.md (code-dir prefix wins)", paths: ["src/cost/CONTEXT.md"], shape: "code" },
    { name: "non-md playbook sibling (hook settings)", paths: ["docs/operator-playbooks/hydra-qa.settings.json"], shape: "code" },
    { name: "package.json", paths: ["package.json"], shape: "code" },
    { name: "empty list fail-closes", paths: [], shape: "code" },
    { name: "blank entries only fail-close", paths: ["", "  "], shape: "code" },
  ];
  for (const row of table) {
    test(`${row.name} → ${row.shape}`, () => {
      assert.equal(classifyChangeShape(row.paths), row.shape);
    });
  }
});

describe("isPromptOnlyChange — the one shared prompt-path list (issue #4733)", () => {
  test("playbook .md, skill .md, config/agents, config/feedback are prompt paths", () => {
    assert.equal(
      isPromptOnlyChange([
        "docs/operator-playbooks/hydra-qa.md",
        ".claude/skills/x/SKILL.md",
        "config/agents/dev.md",
        "config/feedback/x.json",
      ]),
      true,
    );
  });

  test("other config/ paths, tests, docs, and empty lists are not prompt-only", () => {
    assert.equal(isPromptOnlyChange(["config/autopilot/classes.json"]), false);
    assert.equal(isPromptOnlyChange(["docs/operator-playbooks/hydra-qa.md", "test/x.test.mts"]), false);
    assert.equal(isPromptOnlyChange(["docs/adr/0042-x.md"]), false);
    assert.equal(isPromptOnlyChange([]), false);
    assert.equal(isPromptOnlyChange([""]), false);
  });

  test("agrees with classifyChangeShape on every prompt path", () => {
    for (const p of ["docs/operator-playbooks/a.md", "config/agents/b.json", ".claude/skills/c.md"]) {
      assert.equal(isPromptPath(p), true);
      assert.equal(classifyChangeShape([p]), "prompt-only");
    }
  });

  test("a src/ → test/ rename listed by --no-renames (old + new path) stays code", () => {
    assert.equal(classifyChangeShape(["src/foo.ts", "test/foo.test.mts"]), "code");
  });
});
