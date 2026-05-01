/**
 * Tests for src/jit-testing.ts — the JiT test generation module.
 *
 * Tests the pure functions (buildJitPrompt, parseJitResult) that can be
 * unit tested without requiring a real project directory or model call.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildJitPrompt, parseJitResult } from "../src/jit-testing.ts";

describe("buildJitPrompt", () => {
  test("includes task title in prompt", () => {
    const prompt = buildJitPrompt("+ const x = 1;", ["src/foo.ts"], "Add feature X");
    assert.ok(prompt.includes("Add feature X"));
  });

  test("includes changed files in prompt", () => {
    const prompt = buildJitPrompt("+ const x = 1;", ["src/foo.ts", "src/bar.ts"], "task");
    assert.ok(prompt.includes("src/foo.ts"));
    assert.ok(prompt.includes("src/bar.ts"));
  });

  test("includes diff in prompt", () => {
    const diff = "+ export function newHelper() { return 42; }";
    const prompt = buildJitPrompt(diff, ["src/helper.ts"], "task");
    assert.ok(prompt.includes("newHelper"));
  });

  test("truncates long diffs", () => {
    const longDiff = "x".repeat(10000);
    const prompt = buildJitPrompt(longDiff, ["src/foo.ts"], "task");
    assert.ok(prompt.includes("diff truncated"));
    assert.ok(prompt.length < longDiff.length);
  });

  test("requests node:test format", () => {
    const prompt = buildJitPrompt("diff", ["f.ts"], "task");
    assert.ok(prompt.includes("node:test"));
    assert.ok(prompt.includes("node:assert"));
  });

  test("specifies .test.mts extension", () => {
    const prompt = buildJitPrompt("diff", ["f.ts"], "task");
    assert.ok(prompt.includes(".test.mts"));
  });

  test("handles empty file list", () => {
    const prompt = buildJitPrompt("diff content", [], "task");
    assert.ok(typeof prompt === "string");
    assert.ok(prompt.length > 0);
  });

  test("handles empty diff", () => {
    const prompt = buildJitPrompt("", ["src/foo.ts"], "task");
    assert.ok(typeof prompt === "string");
    assert.ok(prompt.includes("src/foo.ts"));
  });
});

describe("parseJitResult", () => {
  test("parses valid JSON with tests", () => {
    const input = JSON.stringify({
      tests: [
        {
          filename: "test/jit-foo.test.mts",
          description: "verifies foo returns 42",
          code: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('foo', () => { assert.equal(1, 1); });",
        },
      ],
    });
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].filename, "test/jit-foo.test.mts");
  });

  test("parses multiple tests", () => {
    const input = JSON.stringify({
      tests: [
        {
          filename: "test/jit-a.test.mts",
          description: "test a",
          code: "import { test } from 'node:test';\ntest('a', () => {});",
        },
        {
          filename: "test/jit-b.test.mts",
          description: "test b",
          code: "import { test } from 'node:test';\ntest('b', () => {});",
        },
      ],
    });
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 2);
  });

  test("returns empty tests for empty output", () => {
    const { tests, error } = parseJitResult("");
    assert.equal(tests.length, 0);
    assert.ok(error?.includes("Empty"));
  });

  test("returns empty tests for null-ish output", () => {
    const { tests, error } = parseJitResult("   ");
    assert.equal(tests.length, 0);
    assert.ok(error !== null);
  });

  test("extracts JSON from surrounding text", () => {
    const input = `Here are the tests:\n${JSON.stringify({
      tests: [
        {
          filename: "test/jit-x.test.mts",
          description: "x test",
          code: "import { test } from 'node:test';\ntest('x', () => {});",
        },
      ],
    })}\nDone!`;
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 1);
  });

  test("filters out tests with wrong extension", () => {
    const input = JSON.stringify({
      tests: [
        {
          filename: "test/jit-good.test.mts",
          description: "good",
          code: "import { test } from 'node:test';\ntest('g', () => {});",
        },
        {
          filename: "test/jit-bad.test.ts",
          description: "bad extension",
          code: "import { test } from 'node:test';\ntest('b', () => {});",
        },
      ],
    });
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].filename, "test/jit-good.test.mts");
  });

  test("filters out tests missing node:test import", () => {
    const input = JSON.stringify({
      tests: [
        {
          filename: "test/jit-notest.test.mts",
          description: "missing import",
          code: "console.log('hello');",
        },
      ],
    });
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 0);
  });

  test("filters out tests missing filename", () => {
    const input = JSON.stringify({
      tests: [
        {
          description: "no filename",
          code: "import { test } from 'node:test';\ntest('x', () => {});",
        },
      ],
    });
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 0);
  });

  test("filters out tests missing code", () => {
    const input = JSON.stringify({
      tests: [
        {
          filename: "test/jit-nocode.test.mts",
          description: "no code field",
        },
      ],
    });
    const { tests, error } = parseJitResult(input);
    assert.equal(error, null);
    assert.equal(tests.length, 0);
  });

  test("handles missing tests array", () => {
    const input = JSON.stringify({ result: "no tests key" });
    const { tests, error } = parseJitResult(input);
    assert.equal(tests.length, 0);
    assert.ok(error?.includes("tests"));
  });

  test("handles invalid JSON gracefully", () => {
    const { tests, error } = parseJitResult("this is not json at all");
    assert.equal(tests.length, 0);
    assert.ok(error !== null);
  });

  test("handles empty tests array", () => {
    const input = JSON.stringify({ tests: [] });
    const { tests, error } = parseJitResult(input);
    assert.equal(tests.length, 0);
    assert.equal(error, null);
  });
});
