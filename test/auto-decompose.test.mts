/**
 * Auto-decompose complex tasks into specs — regression tests
 *
 * Issue #171: Complex tasks (>5 files) have 0% merge rate. When
 * classifyComplexity() returns "complex", the control loop should
 * auto-decompose the task into a spec with per-file tasks instead
 * of sending the whole plan to the executor.
 *
 * Tests the pure logic in buildSpecTasks() (no Redis needed) and
 * the integration with createSpec() (Redis DB 1).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import { buildSpecTasks, autoDecomposeComplexTask } from "../src/auto-decompose.ts";

// ---------------------------------------------------------------------------
// Redis setup for integration tests
// ---------------------------------------------------------------------------

let redis: any;

async function cleanSpecKeys() {
  const keys = await redis.keys("hydra:specs:*");
  if (keys.length > 0) await redis.del(...keys);
}

// ---------------------------------------------------------------------------
// buildSpecTasks — pure function tests (no I/O)
// ---------------------------------------------------------------------------

describe("buildSpecTasks", () => {
  test("6 files produce 3 tasks (2 files per task)", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    const criteria = ["A works", "B works", "C works"];
    const tasks = buildSpecTasks("Implement feature", files, criteria);

    assert.equal(tasks.length, 3, `Expected 3 tasks, got ${tasks.length}`);
  });

  test("7 files produce 4 tasks (last task has 1 file)", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const tasks = buildSpecTasks("Feature", files, []);

    assert.equal(tasks.length, 4, `Expected 4 tasks, got ${tasks.length}`);
  });

  test("each task title includes original title and filename", () => {
    const files = ["src/widget.ts", "src/api.ts"];
    const tasks = buildSpecTasks("Add widget", files, []);

    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].title.includes("Add widget"), `Title should include original: ${tasks[0].title}`);
    assert.ok(tasks[0].title.includes("widget.ts"), `Title should include filename: ${tasks[0].title}`);
    assert.ok(tasks[0].title.includes("api.ts"), `Title should include filename: ${tasks[0].title}`);
  });

  test("acceptance criteria are distributed across tasks", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    const criteria = ["Criterion 1", "Criterion 2", "Criterion 3"];
    const tasks = buildSpecTasks("Feature", files, criteria);

    // 3 tasks, 3 criteria => each task gets 1 criterion (round-robin)
    assert.equal(tasks.length, 3);
    assert.ok(tasks[0].description.includes("Criterion 1"), `Task 0 should have Criterion 1`);
    assert.ok(tasks[1].description.includes("Criterion 2"), `Task 1 should have Criterion 2`);
    assert.ok(tasks[2].description.includes("Criterion 3"), `Task 2 should have Criterion 3`);
  });

  test("task description includes file scope", () => {
    const files = ["src/auth.ts", "src/middleware.ts", "src/types.ts", "src/routes.ts"];
    const tasks = buildSpecTasks("Implement auth", files, ["Tests pass"]);

    assert.equal(tasks.length, 2);
    assert.ok(tasks[0].description.includes("src/auth.ts"), `Task 0 should scope auth.ts`);
    assert.ok(tasks[0].description.includes("src/middleware.ts"), `Task 0 should scope middleware.ts`);
    assert.ok(tasks[1].description.includes("src/types.ts"), `Task 1 should scope types.ts`);
    assert.ok(tasks[1].description.includes("src/routes.ts"), `Task 1 should scope routes.ts`);
  });

  test("empty files array produces no tasks", () => {
    const tasks = buildSpecTasks("Feature", [], ["Criterion"]);
    assert.equal(tasks.length, 0);
  });

  test("empty criteria produces tasks with scope-only descriptions", () => {
    const files = ["a.ts", "b.ts"];
    const tasks = buildSpecTasks("Feature", files, []);

    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].description.includes("Scope:"), `Description should include scope`);
    assert.ok(!tasks[0].description.includes("Criteria:"), `Description should not include empty criteria section`);
  });
});

// ---------------------------------------------------------------------------
// autoDecomposeComplexTask — integration tests (requires Redis)
// ---------------------------------------------------------------------------

describe("autoDecomposeComplexTask", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
      process.env.REDIS_URL = "redis://localhost:6379/1";
    }
    await cleanSpecKeys();
  });

  after(async () => {
    if (redis) {
      await cleanSpecKeys();
      redis.disconnect();
    }
  });

  test("6-file task produces spec with 3 tasks", async () => {
    const result = await autoDecomposeComplexTask({
      title: "Implement auth system",
      description: "Add JWT authentication with refresh tokens",
      scopeBoundary: {
        in: ["src/auth.ts", "src/tokens.ts", "src/middleware.ts", "src/routes.ts", "src/types.ts", "src/config.ts"],
      },
      acceptanceCriteria: ["JWT tokens work", "Refresh flow works", "Middleware protects routes"],
      anchorReference: "direction/priorities.md",
    });

    assert.ok(result !== null, "Should produce a decompose result");
    assert.equal(result!.decomposed, true);
    assert.equal(result!.taskCount, 3, `Expected 3 tasks, got ${result!.taskCount}`);
    assert.ok(result!.spec.slug.includes("implement-auth-system"), `Slug should derive from title: ${result!.spec.slug}`);
    assert.equal(result!.spec.status, "active", "Spec should be active for selectAnchor() pickup");
    assert.equal(result!.spec.source, "auto-decompose");
  });

  test("no files in scope returns null", async () => {
    const result = await autoDecomposeComplexTask({
      title: "Empty task",
      description: "No scope",
      scopeBoundary: { in: [] },
    });

    assert.equal(result, null);
  });

  test("duplicate spec (same title) returns null on second call", async () => {
    const task = {
      title: "Duplicate test task",
      description: "Should only create once",
      scopeBoundary: {
        in: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      },
    };

    const first = await autoDecomposeComplexTask(task);
    assert.ok(first !== null, "First call should succeed");

    const second = await autoDecomposeComplexTask(task);
    assert.equal(second, null, "Second call should return null (spec already exists)");
  });

  test("spec tasks carry distributed acceptance criteria", async () => {
    const result = await autoDecomposeComplexTask({
      title: "Criteria distribution test",
      description: "Test criteria are spread across tasks",
      scopeBoundary: {
        in: ["a.ts", "b.ts", "c.ts", "d.ts"],
      },
      acceptanceCriteria: ["First criterion", "Second criterion"],
    });

    assert.ok(result !== null);
    assert.equal(result!.taskCount, 2);

    // Verify criteria are distributed
    const task0Desc = result!.spec.tasks[0].description || "";
    const task1Desc = result!.spec.tasks[1].description || "";
    assert.ok(task0Desc.includes("First criterion"), `Task 0 should have first criterion`);
    assert.ok(task1Desc.includes("Second criterion"), `Task 1 should have second criterion`);
  });

  test("spec rationale includes original description and file count", async () => {
    const result = await autoDecomposeComplexTask({
      title: "Rationale check",
      description: "Original detailed description here",
      scopeBoundary: {
        in: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      },
    });

    assert.ok(result !== null);
    assert.ok(result!.spec.rationale.includes("6 files"), `Rationale should mention file count: ${result!.spec.rationale}`);
    assert.ok(result!.spec.rationale.includes("Original detailed description"), `Rationale should include original description`);
  });
});
