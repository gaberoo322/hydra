/**
 * Executor agent tests.
 *
 * Regression: executor prompt construction and output parsing were inline
 * in control-loop.ts with no unit test coverage. Malformed JSON from the
 * executor caused silent failures. Now both are tested independently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildExecutorPrompt, parseExecutorOutput } from "../src/executor-agent.ts";
import type { BuildPromptInput, ExecutorResult } from "../src/executor-agent.ts";

// ---------------------------------------------------------------------------
// buildExecutorPrompt tests
// ---------------------------------------------------------------------------

describe("buildExecutorPrompt", () => {
  function makeInput(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
    return {
      task: {
        taskId: "task-001",
        title: "Add user auth",
        description: "Implement JWT-based authentication",
        scopeBoundary: { in: ["src/auth.ts", "src/middleware.ts"], out: ["src/db.ts"] },
        acceptanceCriteria: ["JWT tokens are validated", "Expired tokens return 401"],
        verificationPlan: [
          { label: "Tests pass", command: "npm test", expected: "exit 0" },
          { label: "Typecheck", command: "tsc --noEmit", expected: "exit 0" },
        ],
      },
      groundingSummary: "Tests: 42 passed, 0 failed. Typecheck clean.",
      executorContext: "",
      executorKnowledge: "",
      testPatternHint: "",
      useWorktree: true,
      branchName: "feature/cycle-2026-05-01-1200-slug",
      complexity: "standard",
      ...overrides,
    };
  }

  test("produces well-formed prompt with task title and description", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(prompt.includes("Title: Add user auth"));
    assert.ok(prompt.includes("Description: Implement JWT-based authentication"));
  });

  test("includes scope boundary files", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(prompt.includes('"src/auth.ts"'));
    assert.ok(prompt.includes('"src/middleware.ts"'));
    assert.ok(prompt.includes('"src/db.ts"'));
  });

  test("includes acceptance criteria numbered", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(prompt.includes("1. JWT tokens are validated"));
    assert.ok(prompt.includes("2. Expired tokens return 401"));
  });

  test("includes verification plan", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(prompt.includes("Tests pass: `npm test` (expected: exit 0)"));
  });

  test("worktree rule when useWorktree is true", () => {
    const prompt = buildExecutorPrompt(makeInput({ useWorktree: true }));
    assert.ok(prompt.includes("isolated worktree"));
    assert.ok(!prompt.includes("git checkout main && git pull"));
  });

  test("checkout rule when useWorktree is false", () => {
    const prompt = buildExecutorPrompt(makeInput({ useWorktree: false }));
    assert.ok(prompt.includes("git checkout main && git pull"));
    assert.ok(!prompt.includes("isolated worktree"));
  });

  test("quick-fix complexity uses simpler rules", () => {
    const prompt = buildExecutorPrompt(makeInput({ complexity: "quick-fix" }));
    assert.ok(prompt.includes("Make the SMALLEST change"));
    assert.ok(!prompt.includes("TEST-FIRST"));
  });

  test("standard complexity uses test-first rules", () => {
    const prompt = buildExecutorPrompt(makeInput({ complexity: "standard" }));
    assert.ok(prompt.includes("TEST-FIRST"));
    assert.ok(prompt.includes("MUTATION SELF-CHECK"));
  });

  test("ends with JSON output instruction", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(prompt.includes("Output ONLY valid JSON"));
    assert.ok(prompt.includes('"summary"'));
  });

  test("handles missing scopeBoundary gracefully", () => {
    const input = makeInput();
    input.task.scopeBoundary = undefined;
    const prompt = buildExecutorPrompt(input);
    assert.ok(prompt.includes("Files to modify: []"));
    assert.ok(prompt.includes("Files to NOT touch: []"));
  });

  test("handles missing acceptanceCriteria gracefully", () => {
    const input = makeInput();
    input.task.acceptanceCriteria = undefined;
    const prompt = buildExecutorPrompt(input);
    // Should not throw, just have empty criteria section
    assert.ok(prompt.includes("## ACCEPTANCE CRITERIA"));
  });

  test("includes CODEBASE CONTEXT section when repoMapContext is provided", () => {
    const repoMapContext = "src/utils.ts — log (imported by 4 files)\nsrc/api.ts — createApp (imported by 1 files)";
    const prompt = buildExecutorPrompt(makeInput({ repoMapContext }));
    assert.ok(prompt.includes("## CODEBASE CONTEXT"), "should have CODEBASE CONTEXT header");
    assert.ok(prompt.includes("src/utils.ts"), "should include repo map content");
    assert.ok(prompt.includes("imported by 4 files"), "should include importer count");
    // Verify order: CODEBASE CONTEXT between ACCEPTANCE CRITERIA and VERIFICATION
    const contextIdx = prompt.indexOf("## CODEBASE CONTEXT");
    const criteriaIdx = prompt.indexOf("## ACCEPTANCE CRITERIA");
    const verificationIdx = prompt.indexOf("## VERIFICATION");
    assert.ok(criteriaIdx < contextIdx, "CODEBASE CONTEXT should come after ACCEPTANCE CRITERIA");
    assert.ok(contextIdx < verificationIdx, "CODEBASE CONTEXT should come before VERIFICATION");
  });

  test("omits CODEBASE CONTEXT section when repoMapContext is empty", () => {
    const prompt = buildExecutorPrompt(makeInput({ repoMapContext: "" }));
    assert.ok(!prompt.includes("## CODEBASE CONTEXT"), "should NOT have CODEBASE CONTEXT when empty");
  });

  test("omits CODEBASE CONTEXT section when repoMapContext is undefined", () => {
    const prompt = buildExecutorPrompt(makeInput());
    assert.ok(!prompt.includes("## CODEBASE CONTEXT"), "should NOT have CODEBASE CONTEXT when undefined");
  });

  test("truncates groundingSummary at 3000 chars", () => {
    const marker = "\u2603"; // snowman char not used elsewhere in prompt
    const longSummary = marker.repeat(5000);
    const prompt = buildExecutorPrompt(makeInput({ groundingSummary: longSummary }));
    const markerCount = (prompt.match(new RegExp(marker, "g")) || []).length;
    assert.equal(markerCount, 3000);
  });
});

// ---------------------------------------------------------------------------
// parseExecutorOutput tests
// ---------------------------------------------------------------------------

describe("parseExecutorOutput", () => {
  test("parses valid JSON output", () => {
    const raw = JSON.stringify({
      summary: "Added auth",
      filesChanged: ["src/auth.ts"],
      commits: ["abc123"],
      branch: "feature/auth",
      testsRun: { passed: 10, failed: 0 },
    });
    const result = parseExecutorOutput(raw, 0, 5000, "gpt-5.3-codex", true);
    assert.equal(result.summary, "Added auth");
    assert.deepEqual(result.filesChanged, ["src/auth.ts"]);
    assert.deepEqual(result.commits, ["abc123"]);
    assert.equal(result.branch, "feature/auth");
    assert.equal(result.testsRun.passed, 10);
    assert.equal(result.exitCode, 0);
    assert.equal(result.duration, 5000);
    assert.equal(result.__executorModel, "gpt-5.3-codex");
    assert.equal(result.__worktreeUsed, true);
    assert.equal(result.__parseError, undefined);
  });

  test("extracts JSON from mixed output (regex fallback)", () => {
    const raw = `Some preamble text\n${JSON.stringify({
      summary: "Fixed bug",
      filesChanged: ["src/fix.ts"],
      commits: ["def456"],
      branch: "feature/fix",
      testsRun: { passed: 5, failed: 0 },
    })}\nSome trailing text`;
    const result = parseExecutorOutput(raw, 0, 3000, "codex", false);
    assert.equal(result.summary, "Fixed bug");
    assert.deepEqual(result.filesChanged, ["src/fix.ts"]);
    assert.equal(result.__worktreeUsed, false);
  });

  test("returns structured error for completely unparseable output", () => {
    const raw = "This is not JSON at all and has no braces";
    const result = parseExecutorOutput(raw, 1, 2000, "codex", false);
    assert.equal(result.summary, "");
    assert.deepEqual(result.filesChanged, []);
    assert.ok(result.__parseError);
    assert.ok(result.__parseError!.includes("no JSON object"));
    assert.equal(result.exitCode, 1);
    assert.equal(result.duration, 2000);
  });

  test("returns structured error for malformed JSON with braces", () => {
    const raw = "Here is output: { broken json } extra";
    const result = parseExecutorOutput(raw, 0, 1000, "codex", true);
    assert.ok(result.__parseError);
    assert.ok(result.__parseError!.includes("unparseable") || result.__parseError!.includes("no JSON"));
  });

  test("preserves exitCode, duration, model from outer result", () => {
    const raw = JSON.stringify({ summary: "ok", filesChanged: [], commits: [], branch: "b", testsRun: { passed: 1, failed: 0 } });
    const result = parseExecutorOutput(raw, 137, 99999, "gpt-5.4", false);
    assert.equal(result.exitCode, 137);
    assert.equal(result.duration, 99999);
    assert.equal(result.__executorModel, "gpt-5.4");
  });
});
