/**
 * Executor timeout tests.
 *
 * Regression: executor had a flat 600s timeout regardless of task complexity.
 * Large target project tests (~100s per run) caused timeouts when the executor
 * ran tests multiple times. Timeout is now complexity-dependent:
 *   quick-fix: 600s, standard: 900s, complex/high-risk: 1200s
 *
 * Also verifies that the executor prompt includes time budget information.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getExecutorTimeout } from "../src/codex-runner.ts";
import { buildExecutorPrompt } from "../src/executor-agent.ts";
import type { BuildPromptInput } from "../src/executor-agent.ts";

// ---------------------------------------------------------------------------
// getExecutorTimeout tests
// ---------------------------------------------------------------------------

describe("getExecutorTimeout", () => {
  test("returns 600_000 for quick-fix", () => {
    assert.equal(getExecutorTimeout("quick-fix"), 600_000);
  });

  test("returns 900_000 for standard", () => {
    assert.equal(getExecutorTimeout("standard"), 900_000);
  });

  test("returns 1_200_000 for complex", () => {
    assert.equal(getExecutorTimeout("complex"), 1_200_000);
  });

  test("returns 1_200_000 for high-risk", () => {
    assert.equal(getExecutorTimeout("high-risk"), 1_200_000);
  });

  test("defaults to 900_000 (standard) for unknown complexity", () => {
    assert.equal(getExecutorTimeout("unknown-tier"), 900_000);
    assert.equal(getExecutorTimeout(""), 900_000);
  });
});

// ---------------------------------------------------------------------------
// Time budget in executor prompt
// ---------------------------------------------------------------------------

describe("executor prompt time budget", () => {
  function makeInput(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
    return {
      task: {
        taskId: "task-001",
        title: "Add feature",
        description: "Implement the feature",
        scopeBoundary: { in: ["src/feature.ts"], out: [] },
        acceptanceCriteria: ["Feature works"],
      },
      groundingSummary: "Tests: 42 passed, 0 failed.",
      executorContext: "",
      executorKnowledge: "",
      testPatternHint: "",
      useWorktree: true,
      branchName: "feature/test-branch",
      complexity: "standard",
      ...overrides,
    };
  }

  test("includes TIME BUDGET section when timeRemainingMs is provided", () => {
    const prompt = buildExecutorPrompt(makeInput({
      timeRemainingMs: 900_000,
      deadlineUnix: Math.floor(Date.now() / 1000) + 900,
    }));
    assert.ok(prompt.includes("## TIME BUDGET"), "should have TIME BUDGET header");
    assert.ok(prompt.includes("900s remaining"), "should show seconds remaining");
    assert.ok(prompt.includes("timeRemainingMs < 120000"), "should include 2-minute warning guidance");
  });

  test("omits TIME BUDGET section when timeRemainingMs is not provided", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(!prompt.includes("## TIME BUDGET"), "should NOT have TIME BUDGET when not provided");
  });

  test("TIME BUDGET appears before RULES", () => {
    const prompt = buildExecutorPrompt(makeInput({
      timeRemainingMs: 600_000,
      deadlineUnix: Math.floor(Date.now() / 1000) + 600,
    }));
    const budgetIdx = prompt.indexOf("## TIME BUDGET");
    const rulesIdx = prompt.indexOf("## RULES");
    assert.ok(budgetIdx < rulesIdx, "TIME BUDGET should come before RULES");
  });
});
