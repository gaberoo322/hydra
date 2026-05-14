/**
 * Regression tests for src/incremental-verification.ts (issue #362 — follow-up
 * to PR #360, which landed the pure test-impact-graph foundation for issue
 * #341).
 *
 * Scope of this suite:
 *   - readIncrementalEnv: env-flag parsing, fallback to defaults
 *   - isTestFile / isSourceFile: heuristic predicates
 *   - buildIncrementalTestStep + injectIncrementalTestStep: CLI translation
 *   - computeSelection: orchestrator gates (env off, every-Nth, no diff,
 *     no test files, graph build failure, saturation, empty selection,
 *     normal incremental). All tests inject I/O hooks so nothing touches
 *     git or the filesystem.
 *
 * Out of scope (covered by test/test-impact-graph.test.mts):
 *   - parseImports / resolveImport / buildImportGraph / selectAffectedTests
 *     correctness (the pure foundation from PR #360).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  readIncrementalEnv,
  DEFAULT_FULL_SUITE_EVERY_N,
  isTestFile,
  isSourceFile,
  buildIncrementalTestStep,
  injectIncrementalTestStep,
  computeSelection,
  type ProjectFiles,
} from "../src/incremental-verification.ts";

// =========================================================================
// readIncrementalEnv
// =========================================================================

describe("readIncrementalEnv", () => {
  test("disabled by default when flag is absent", () => {
    const env = readIncrementalEnv({});
    assert.equal(env.enabled, false);
    assert.equal(env.fullSuiteEveryN, DEFAULT_FULL_SUITE_EVERY_N);
  });

  test("enabled with HYDRA_INCREMENTAL_GROUNDING=true", () => {
    const env = readIncrementalEnv({ HYDRA_INCREMENTAL_GROUNDING: "true" });
    assert.equal(env.enabled, true);
  });

  test("enabled with HYDRA_INCREMENTAL_GROUNDING=1", () => {
    const env = readIncrementalEnv({ HYDRA_INCREMENTAL_GROUNDING: "1" });
    assert.equal(env.enabled, true);
  });

  test("enabled case-insensitively", () => {
    const env = readIncrementalEnv({ HYDRA_INCREMENTAL_GROUNDING: "TRUE" });
    assert.equal(env.enabled, true);
  });

  test("disabled with HYDRA_INCREMENTAL_GROUNDING=false", () => {
    const env = readIncrementalEnv({ HYDRA_INCREMENTAL_GROUNDING: "false" });
    assert.equal(env.enabled, false);
  });

  test("disabled with empty string", () => {
    const env = readIncrementalEnv({ HYDRA_INCREMENTAL_GROUNDING: "" });
    assert.equal(env.enabled, false);
  });

  test("fullSuiteEveryN parses from env", () => {
    const env = readIncrementalEnv({
      HYDRA_INCREMENTAL_GROUNDING: "true",
      HYDRA_FULL_SUITE_EVERY_N: "5",
    });
    assert.equal(env.fullSuiteEveryN, 5);
  });

  test("fullSuiteEveryN falls back to default on garbage", () => {
    const env = readIncrementalEnv({ HYDRA_FULL_SUITE_EVERY_N: "abc" });
    assert.equal(env.fullSuiteEveryN, DEFAULT_FULL_SUITE_EVERY_N);
  });

  test("fullSuiteEveryN falls back on zero/negative", () => {
    assert.equal(
      readIncrementalEnv({ HYDRA_FULL_SUITE_EVERY_N: "0" }).fullSuiteEveryN,
      DEFAULT_FULL_SUITE_EVERY_N,
    );
    assert.equal(
      readIncrementalEnv({ HYDRA_FULL_SUITE_EVERY_N: "-3" }).fullSuiteEveryN,
      DEFAULT_FULL_SUITE_EVERY_N,
    );
  });
});

// =========================================================================
// File predicates
// =========================================================================

describe("isTestFile", () => {
  test("matches .test.ts / .test.mts / .test.tsx", () => {
    assert.equal(isTestFile("src/foo.test.ts"), true);
    assert.equal(isTestFile("test/foo.test.mts"), true);
    assert.equal(isTestFile("src/foo.test.tsx"), true);
  });

  test("matches .spec.ts variants", () => {
    assert.equal(isTestFile("src/foo.spec.ts"), true);
    assert.equal(isTestFile("src/foo.spec.tsx"), true);
  });

  test("matches files under test/ tests/ __tests__/", () => {
    assert.equal(isTestFile("test/something.ts"), true);
    assert.equal(isTestFile("tests/nested/foo.mts"), true);
    assert.equal(isTestFile("src/__tests__/bar.ts"), true);
  });

  test("rejects non-test source", () => {
    assert.equal(isTestFile("src/foo.ts"), false);
    assert.equal(isTestFile("src/utils/bar.tsx"), false);
  });

  test("rejects empty / null", () => {
    assert.equal(isTestFile(""), false);
    assert.equal(isTestFile(null as any), false);
  });
});

describe("isSourceFile", () => {
  test("matches TS/JS variants", () => {
    for (const f of [
      "src/a.ts", "src/b.tsx", "src/c.mts", "src/d.js",
      "src/e.mjs", "src/f.cjs", "src/g.jsx",
    ]) {
      assert.equal(isSourceFile(f), true, `expected source: ${f}`);
    }
  });

  test("rejects non-source", () => {
    for (const f of [
      "README.md", "package.json", "src/data.yaml", "image.png",
    ]) {
      assert.equal(isSourceFile(f), false, `expected non-source: ${f}`);
    }
  });
});

// =========================================================================
// CLI translation
// =========================================================================

describe("buildIncrementalTestStep", () => {
  test("builds vitest invocation with test:raw and quoted paths", () => {
    const step = buildIncrementalTestStep(
      ["test/a.test.mts", "test/b.test.mts"],
    );
    assert.equal(step.label, "tests");
    assert.equal(step.expected, "exit code 0");
    assert.match(step.command, /npm --prefix web run test:raw --/);
    assert.match(step.command, /"test\/a\.test\.mts"/);
    assert.match(step.command, /"test\/b\.test\.mts"/);
  });

  test("uses npx vitest run when appSubdir is empty", () => {
    const step = buildIncrementalTestStep(["test/a.test.mts"], "");
    assert.match(step.command, /npx vitest run/);
    assert.match(step.command, /"test\/a\.test\.mts"/);
  });

  test("falls back to 'npm test' on empty selection (defensive)", () => {
    const step = buildIncrementalTestStep([]);
    assert.equal(step.command, "npm test");
    assert.equal(step.label, "tests");
  });
});

describe("injectIncrementalTestStep", () => {
  test("replaces the 'tests' step in-place", () => {
    const plan = [
      { command: "npm test", expected: "exit code 0", label: "tests" },
      { command: "npm run typecheck", expected: "exit code 0", label: "typecheck" },
      { command: "npm run build", expected: "exit code 0", label: "build" },
    ];
    const newStep = { command: "npx vitest run a.test.ts", expected: "exit code 0", label: "tests" };
    const result = injectIncrementalTestStep(plan, newStep);
    assert.equal(result.replaced, true);
    assert.equal(result.plan.length, 3);
    assert.equal(result.plan[0].command, "npx vitest run a.test.ts");
    assert.equal(result.plan[1].label, "typecheck");
    assert.equal(result.plan[2].label, "build");
  });

  test("does NOT mutate the input plan", () => {
    const plan = [
      { command: "npm test", expected: "exit code 0", label: "tests" },
    ];
    const newStep = { command: "X", expected: "Y", label: "tests" };
    injectIncrementalTestStep(plan, newStep);
    assert.equal(plan[0].command, "npm test", "input mutated");
  });

  test("returns replaced=false when no 'tests' step exists", () => {
    const plan = [
      { command: "npm run typecheck", expected: "exit code 0", label: "typecheck" },
      { command: "npm run build", expected: "exit code 0", label: "build" },
    ];
    const newStep = { command: "X", expected: "Y", label: "tests" };
    const result = injectIncrementalTestStep(plan, newStep);
    assert.equal(result.replaced, false);
    assert.equal(result.plan.length, 2);
    assert.equal(result.plan[0].label, "typecheck");
  });

  test("replaces only the first 'tests' step (defensive)", () => {
    const plan = [
      { command: "npm test", expected: "exit code 0", label: "tests" },
      { command: "npm test:e2e", expected: "exit code 0", label: "tests" },
    ];
    const newStep = { command: "REPLACED", expected: "exit code 0", label: "tests" };
    const result = injectIncrementalTestStep(plan, newStep);
    assert.equal(result.replaced, true);
    assert.equal(result.plan[0].command, "REPLACED");
    assert.equal(result.plan[1].command, "npm test:e2e");
  });
});

// =========================================================================
// computeSelection — orchestrator gates
// =========================================================================

describe("computeSelection", () => {
  // A modest project fixture: 4 test files + 4 sources.
  const projectFixture: ProjectFiles = {
    allFiles: [
      "src/a.ts", "src/b.ts", "src/c.ts", "src/util.ts",
      "test/a.test.mts", "test/b.test.mts", "test/c.test.mts", "test/d.test.mts",
    ],
    testFiles: [
      "test/a.test.mts", "test/b.test.mts", "test/c.test.mts", "test/d.test.mts",
    ],
  };

  function mkSources(map: Record<string, string>): (p: string) => Promise<string> {
    return async (absPath) => {
      // The graph builder calls readFileImpl(join(projectDir, relPath)).
      // Our test cycles use projectDir="/project", so strip that prefix.
      const rel = absPath.replace(/^\/project\//, "");
      if (rel in map) return map[rel];
      return "";
    };
  }

  test("disabled — returns mode=''", async () => {
    const decision = await computeSelection({
      projectDir: "/project",
      env: {}, // flag absent
      listProjectFilesImpl: async () => projectFixture,
      listChangedFilesImpl: async () => ["src/a.ts"],
      readFileImpl: mkSources({}),
    });
    assert.equal(decision.mode, "");
    assert.equal(decision.testsSelected, 0);
    assert.match(decision.reason, /not set/);
  });

  test("every-Nth cycle — returns full with safety-net reason", async () => {
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true", HYDRA_FULL_SUITE_EVERY_N: "5" },
      cycleCounter: 10, // multiple of 5
      listProjectFilesImpl: async () => projectFixture,
      listChangedFilesImpl: async () => ["src/a.ts"],
      readFileImpl: mkSources({}),
    });
    assert.equal(decision.mode, "full");
    assert.match(decision.reason, /safety-net/);
    assert.match(decision.reason, /multiple of 5/);
    assert.equal(decision.cycleCounter, 10);
  });

  test("no test files discovered — returns full", async () => {
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true" },
      cycleCounter: 1,
      listProjectFilesImpl: async () => ({ allFiles: ["src/a.ts"], testFiles: [] }),
      listChangedFilesImpl: async () => ["src/a.ts"],
      readFileImpl: mkSources({}),
    });
    assert.equal(decision.mode, "full");
    assert.match(decision.reason, /no test files/);
  });

  test("no diff — returns full with no-diff reason", async () => {
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true" },
      cycleCounter: 1,
      listProjectFilesImpl: async () => projectFixture,
      listChangedFilesImpl: async () => [],
      readFileImpl: mkSources({}),
    });
    assert.equal(decision.mode, "full");
    assert.match(decision.reason, /no-diff/);
    assert.equal(decision.totalTests, 4);
  });

  test("normal selection — incremental with matched tests", async () => {
    // a.test imports src/a; b.test imports src/b; c.test imports src/c; d.test imports src/util
    // Changing src/a.ts should select only test/a.test.mts.
    const sources = {
      "test/a.test.mts": `import "./../src/a.ts";`,
      "test/b.test.mts": `import "./../src/b.ts";`,
      "test/c.test.mts": `import "./../src/c.ts";`,
      "test/d.test.mts": `import "./../src/util.ts";`,
      "src/a.ts": ``,
      "src/b.ts": ``,
      "src/c.ts": ``,
      "src/util.ts": ``,
    };
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true", HYDRA_FULL_SUITE_EVERY_N: "100" },
      cycleCounter: 1,
      listProjectFilesImpl: async () => projectFixture,
      listChangedFilesImpl: async () => ["src/a.ts"],
      readFileImpl: mkSources(sources),
    });
    assert.equal(decision.mode, "incremental");
    assert.equal(decision.testsSelected, 1);
    assert.equal(decision.totalTests, 4);
    assert.deepEqual(decision.selectedTests, ["test/a.test.mts"]);
    assert.match(decision.reason, /incremental/);
  });

  test("saturation — selection covers >=90% of tests → full", async () => {
    // All four test files share the same util import.
    const sources = {
      "test/a.test.mts": `import "./../src/util.ts";`,
      "test/b.test.mts": `import "./../src/util.ts";`,
      "test/c.test.mts": `import "./../src/util.ts";`,
      "test/d.test.mts": `import "./../src/util.ts";`,
      "src/util.ts": ``,
    };
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true", HYDRA_FULL_SUITE_EVERY_N: "100" },
      cycleCounter: 1,
      listProjectFilesImpl: async () => projectFixture,
      listChangedFilesImpl: async () => ["src/util.ts"],
      readFileImpl: mkSources(sources),
    });
    assert.equal(decision.mode, "full");
    assert.match(decision.reason, /saturation/);
  });

  test("zero-selection safety-net — changed file no test depends on", async () => {
    const sources = {
      "test/a.test.mts": `import "./../src/a.ts";`,
      "test/b.test.mts": `import "./../src/b.ts";`,
      "test/c.test.mts": `import "./../src/c.ts";`,
      "test/d.test.mts": `import "./../src/util.ts";`,
      "src/a.ts": ``,
      "src/b.ts": ``,
      "src/c.ts": ``,
      "src/util.ts": ``,
    };
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true", HYDRA_FULL_SUITE_EVERY_N: "100" },
      cycleCounter: 1,
      listProjectFilesImpl: async () => projectFixture,
      // Changed file isn't imported by any test.
      listChangedFilesImpl: async () => ["src/orphan.ts"],
      readFileImpl: mkSources(sources),
    });
    assert.equal(decision.mode, "full");
    assert.match(decision.reason, /safety-net/);
  });

  test("disabled flag short-circuits before counter bump", async () => {
    // Even without a counter, disabled must not call I/O hooks.
    let listProjectCalled = false;
    let listChangedCalled = false;
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "false" },
      listProjectFilesImpl: async () => { listProjectCalled = true; return projectFixture; },
      listChangedFilesImpl: async () => { listChangedCalled = true; return []; },
      readFileImpl: mkSources({}),
    });
    assert.equal(decision.mode, "");
    assert.equal(listProjectCalled, false, "should not list files when disabled");
    assert.equal(listChangedCalled, false, "should not list changes when disabled");
  });

  test("cycle counter is preserved in the decision", async () => {
    const decision = await computeSelection({
      projectDir: "/project",
      env: { HYDRA_INCREMENTAL_GROUNDING: "true", HYDRA_FULL_SUITE_EVERY_N: "100" },
      cycleCounter: 42,
      listProjectFilesImpl: async () => projectFixture,
      listChangedFilesImpl: async () => [],
      readFileImpl: mkSources({}),
    });
    assert.equal(decision.cycleCounter, 42);
  });
});
