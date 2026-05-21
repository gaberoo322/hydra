/**
 * Regression test for issue #512 — friction-capture endpoint + namespace
 * isolation + threshold-cross escalation hook.
 *
 * What this test proves:
 *   1. captureSubagentFriction records into `hydra:friction:{skill}:patterns`
 *      (the friction namespace), NOT into `hydra:memory:{agent}:patterns`.
 *   2. Idempotent on (skill, cue) — second call with same cue increments
 *      hit count instead of duplicating.
 *   3. Friction patterns DO NOT promote to `config/feedback/to-{agent}.md`
 *      (those files are only for the planner/executor lesson set).
 *   4. The escalation hook fires on threshold-cross. With
 *      HYDRA_ESCALATION_DISABLED=1, the hook is short-circuited but the
 *      pattern itself is still promoted.
 *   5. Invalid skill / cue / workaround are rejected.
 *
 * Tests run against Redis DB 1 to avoid colliding with production state.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;
process.env.HYDRA_ESCALATION_DISABLED = "1"; // never spawn real gh during tests

let tempConfigRoot: string;
let originalConfigPath: string | undefined;
let redis: any;

let captureSubagentFriction: typeof import("../src/pattern-memory/subagent-capture.ts").captureSubagentFriction;

async function loadFrictionPatterns(skill: string): Promise<any[]> {
  const raw = await redis.get(`hydra:friction:${skill}:patterns`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function loadMemoryPatterns(agent: string): Promise<any[]> {
  const raw = await redis.get(`hydra:memory:${agent}:patterns`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("subagent friction capture (issue #512)", () => {
  before(async () => {
    tempConfigRoot = await mkdtemp(join(tmpdir(), "hydra-friction-capture-"));
    await mkdir(join(tempConfigRoot, "feedback"), { recursive: true });
    for (const agent of ["planner", "executor", "skeptic"]) {
      await writeFile(
        join(tempConfigRoot, "feedback", `to-${agent}.md`),
        `# Feedback for ${agent}\n\nInitial content.\n`,
      );
    }
    originalConfigPath = process.env.HYDRA_CONFIG_PATH;
    process.env.HYDRA_CONFIG_PATH = tempConfigRoot;

    redis = new Redis(REDIS_URL);
    const mod = await import("../src/pattern-memory/subagent-capture.ts");
    captureSubagentFriction = mod.captureSubagentFriction;
  });

  beforeEach(async () => {
    await cleanKeys();
    for (const agent of ["planner", "executor", "skeptic"]) {
      await writeFile(
        join(tempConfigRoot, "feedback", `to-${agent}.md`),
        `# Feedback for ${agent}\n\nInitial content.\n`,
      );
    }
  });

  after(async () => {
    if (redis) { await cleanKeys(); redis.disconnect(); }
    if (originalConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = originalConfigPath;
    await rm(tempConfigRoot, { recursive: true, force: true });
  });

  test("records into hydra:friction:{skill}:patterns — NOT the memory namespace", async () => {
    const result = await captureSubagentFriction({
      skill: "hydra-dev",
      cue: "stale-local-master-ref",
      workaround: "used origin/master for diff base",
      context: "git rev-parse origin/master",
    });

    assert.equal(result.skill, "hydra-dev");
    assert.equal(result.category, "stale-local-master-ref");

    const friction = await loadFrictionPatterns("hydra-dev");
    assert.equal(friction.length, 1);
    assert.equal(friction[0].category, "stale-local-master-ref");
    assert.equal(friction[0].hitCount, 1);
    assert.equal(friction[0].source, "subagent");
    assert.equal(friction[0].action, "used origin/master for diff base");

    // Friction MUST NOT leak into planner/executor memory.
    assert.equal((await loadMemoryPatterns("planner")).length, 0);
    assert.equal((await loadMemoryPatterns("executor")).length, 0);
    assert.equal((await loadMemoryPatterns("hydra-dev")).length, 0);
  });

  test("idempotent on (skill, cue) — second call increments hit count", async () => {
    await captureSubagentFriction({
      skill: "hydra-dev",
      cue: "orchestrator-watchdog-units-not-in-repo",
      workaround: "first workaround",
      context: "scripts/deploy.sh",
    });
    await captureSubagentFriction({
      skill: "hydra-dev",
      cue: "orchestrator-watchdog-units-not-in-repo",
      workaround: "second workaround",
      context: "scripts/deploy.sh again",
    });
    const friction = await loadFrictionPatterns("hydra-dev");
    assert.equal(friction.length, 1);
    assert.equal(friction[0].hitCount, 2);
    // Examples roll: newest first.
    assert.ok(friction[0].examples[0].includes("again"));
  });

  test("different skills land in different namespaces", async () => {
    await captureSubagentFriction({
      skill: "hydra-dev",
      cue: "same-cue",
      workaround: "w",
      context: "c",
    });
    await captureSubagentFriction({
      skill: "hydra-target-build",
      cue: "same-cue",
      workaround: "w",
      context: "c",
    });
    assert.equal((await loadFrictionPatterns("hydra-dev")).length, 1);
    assert.equal((await loadFrictionPatterns("hydra-target-build")).length, 1);
  });

  test("threshold-cross does NOT write to feedback file (friction stays out of to-{agent}.md)", async () => {
    const feedbackPath = join(tempConfigRoot, "feedback", "to-planner.md");
    const feedbackPath2 = join(tempConfigRoot, "feedback", "to-executor.md");

    for (let i = 0; i < 3; i++) {
      await captureSubagentFriction({
        skill: "hydra-dev",
        cue: "hook-registration-location-unspecified",
        workaround: "chose sibling .settings.json",
        context: ".claude/hooks/",
        cycleId: `cycle-${i}`,
      });
    }
    const friction = await loadFrictionPatterns("hydra-dev");
    assert.equal(friction[0].hitCount, 3);
    assert.equal(friction[0].promoted, true);

    const planner = await readFile(feedbackPath, "utf-8");
    const executor = await readFile(feedbackPath2, "utf-8");
    assert.equal(planner.includes("Auto-Promoted Rules"), false,
      "friction MUST NOT write to to-planner.md");
    assert.equal(executor.includes("Auto-Promoted Rules"), false,
      "friction MUST NOT write to to-executor.md");
  });

  test("threshold-cross fires escalation hook (mocked via HYDRA_ESCALATION_DISABLED)", async () => {
    // With escalation disabled, the hook returns "skipped" without
    // spawning gh — so this test verifies the wiring (promoted=true) without
    // depending on a real GitHub call.
    for (let i = 0; i < 3; i++) {
      await captureSubagentFriction({
        skill: "hydra-target-build",
        cue: "scheduler-stop-semantics-test-flake",
        workaround: `attempt ${i}`,
        context: "test/scheduler-stop-semantics.test.mts",
        cycleId: `c-${i}`,
      });
    }
    const friction = await loadFrictionPatterns("hydra-target-build");
    assert.equal(friction[0].promoted, true);
    assert.equal(friction[0].hitsAtPromotion, 3);
  });

  test("invalid skill throws", async () => {
    await assert.rejects(
      () => captureSubagentFriction({
        skill: "not-a-skill" as any,
        cue: "x",
        workaround: "w",
        context: "c",
      }),
      /invalid skill/,
    );
  });

  test("empty cue throws", async () => {
    await assert.rejects(
      () => captureSubagentFriction({
        skill: "hydra-dev",
        cue: "   ",
        workaround: "w",
        context: "c",
      }),
      /cue is required/,
    );
  });

  test("empty workaround throws", async () => {
    await assert.rejects(
      () => captureSubagentFriction({
        skill: "hydra-dev",
        cue: "x",
        workaround: "",
        context: "c",
      }),
      /workaround is required/,
    );
  });
});
