/**
 * Regression test for issue #392 — subagent lesson-capture hook.
 *
 * Background: After issue #383 deletes codex-runner + the in-process control
 * loop, nothing writes to hydra:memory:{agent}:patterns from a cycle path.
 * The autopilot subagents (hydra-dev, hydra-qa, hydra-target-build) are the
 * new producers of cycle-level evidence and need a learning hook.
 *
 * captureSubagentLesson() wraps recordPattern() 1:1 so the existing 3-hit
 * auto-promotion pipeline keeps producing durable rules in
 * config/feedback/to-{agent}.md.
 *
 * What this test proves:
 *   1. A "qa-fail" lesson from hydra-qa lands in the planner pattern set.
 *   2. A "verification-failure" lesson from hydra-dev lands in the executor
 *      pattern set.
 *   3. The 3rd occurrence of the same cue auto-promotes to the feedback
 *      file — i.e. the existing promotion path is unchanged by the new
 *      writer.
 *   4. Invalid skill / outcome / cue inputs are rejected loudly so the API
 *      endpoint can return 400.
 *   5. The skill→agent mapping is stable (hydra-qa → planner, hydra-dev and
 *      hydra-target-build → executor).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Setup: isolate Redis (DB 1) and HYDRA_CONFIG_PATH BEFORE importing the
// learning module — CONFIG_PATH is captured at module-load time.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

// Suppress the GitHub-escalation hook so these tests don't shell out to `gh`.
// The escalation pipeline has its own dedicated regression in
// test/learning-escalation.test.mts.
process.env.HYDRA_ESCALATION_DISABLED = "1";

let tempConfigRoot: string;
let originalConfigPath: string | undefined;
let redis: any;

let captureSubagentLesson: typeof import("../src/pattern-memory/subagent-capture.ts").captureSubagentLesson;
let agentForSkill: typeof import("../src/pattern-memory/subagent-capture.ts").agentForSkill;
let isValidSkill: typeof import("../src/pattern-memory/subagent-capture.ts").isValidSkill;
let isValidOutcome: typeof import("../src/pattern-memory/subagent-capture.ts").isValidOutcome;

async function loadPatterns(agent: string): Promise<any[]> {
  const raw = await redis.get(`hydra:memory:${agent}:patterns`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("subagent lesson capture (issue #392)", () => {
  before(async () => {
    tempConfigRoot = await mkdtemp(join(tmpdir(), "hydra-subagent-capture-"));
    await mkdir(join(tempConfigRoot, "feedback"), { recursive: true });
    // Seed feedback files so promoteToFeedback() has something to append to.
    for (const agent of ["planner", "executor", "skeptic"]) {
      await writeFile(
        join(tempConfigRoot, "feedback", `to-${agent}.md`),
        `# Feedback for ${agent}\n\nInitial content.\n`,
      );
    }

    originalConfigPath = process.env.HYDRA_CONFIG_PATH;
    process.env.HYDRA_CONFIG_PATH = tempConfigRoot;

    redis = new Redis(REDIS_URL);

    // Import AFTER setting HYDRA_CONFIG_PATH so the module's CONFIG_PATH
    // constant points at our temp dir.
    const mod = await import("../src/pattern-memory/subagent-capture.ts");
    captureSubagentLesson = mod.captureSubagentLesson;
    agentForSkill = mod.agentForSkill;
    isValidSkill = mod.isValidSkill;
    isValidOutcome = mod.isValidOutcome;
  });

  beforeEach(async () => {
    await cleanKeys();
    // Reset feedback files to a known state — the promotion test rewrites them.
    for (const agent of ["planner", "executor", "skeptic"]) {
      await writeFile(
        join(tempConfigRoot, "feedback", `to-${agent}.md`),
        `# Feedback for ${agent}\n\nInitial content.\n`,
      );
    }
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
    if (originalConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = originalConfigPath;
    await rm(tempConfigRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Mapping + validation (pure)
  // -------------------------------------------------------------------------

  test("agentForSkill — hydra-qa trains planner, hydra-dev/target-build train executor", () => {
    assert.equal(agentForSkill("hydra-qa"), "planner");
    assert.equal(agentForSkill("hydra-dev"), "executor");
    assert.equal(agentForSkill("hydra-target-build"), "executor");
  });

  test("isValidSkill / isValidOutcome reject unknown values", () => {
    assert.equal(isValidSkill("hydra-qa"), true);
    assert.equal(isValidSkill("hydra-fake"), false);
    assert.equal(isValidSkill(""), false);
    assert.equal(isValidSkill(123 as any), false);

    assert.equal(isValidOutcome("qa-fail"), true);
    assert.equal(isValidOutcome("verification-failure"), true);
    assert.equal(isValidOutcome("nonsense"), false);
    assert.equal(isValidOutcome(undefined as any), false);
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion #2: hydra-qa FAIL → planner pattern
  // -------------------------------------------------------------------------

  test("hydra-qa qa-fail records a planner pattern with the failed criterion as cue", async () => {
    const result = await captureSubagentLesson({
      skill: "hydra-qa",
      outcome: "qa-fail",
      cue: "acceptance-criterion-unmet",
      context: "PR #500: 'add cache' — unmet criterion: 'cache returns 304 on If-None-Match'",
    });

    assert.equal(result.agent, "planner");
    assert.equal(result.category, "acceptance-criterion-unmet");

    const patterns = await loadPatterns("planner");
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].category, "acceptance-criterion-unmet");
    assert.equal(patterns[0].hitCount, 1);
    assert.equal(patterns[0].source, "subagent");
    assert.equal(patterns[0].severity, "prevent");
    assert.ok(patterns[0].action.includes("QA"));
    assert.ok(patterns[0].examples[0].includes("PR #500"));
  });

  // -------------------------------------------------------------------------
  // hydra-dev verification-failure → executor pattern
  // -------------------------------------------------------------------------

  test("hydra-dev verification-failure records an executor pattern", async () => {
    const result = await captureSubagentLesson({
      skill: "hydra-dev",
      outcome: "verification-failure",
      cue: "verification-failure",
      context: "issue-392: npm test failed — 3 tests broken in test/learning.test.mts",
    });

    assert.equal(result.agent, "executor");
    const patterns = await loadPatterns("executor");
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].source, "subagent");
    assert.ok(patterns[0].action.includes("npm test"));
  });

  test("hydra-target-build verification-failure also lands on executor", async () => {
    await captureSubagentLesson({
      skill: "hydra-target-build",
      outcome: "verification-failure",
      cue: "verification-failure",
      context: "build-cycle: typecheck failed in src/foo.ts",
    });

    const executor = await loadPatterns("executor");
    assert.equal(executor.length, 1);

    const planner = await loadPatterns("planner");
    assert.equal(planner.length, 0, "lesson should NOT leak into the planner set");
  });

  // -------------------------------------------------------------------------
  // Acceptance criterion #5: 3rd occurrence promotes to feedback file
  //
  // PROMOTION_THRESHOLD is 3 (test/learning-promotion-threshold.test.mts).
  // This test proves the pipeline fires through captureSubagentLesson().
  // -------------------------------------------------------------------------

  test("3rd lesson with the same cue auto-promotes to to-planner.md (5-hit AC is satisfied at threshold)", async () => {
    const feedbackPath = join(tempConfigRoot, "feedback", "to-planner.md");

    // Before any hits: feedback file is the initial seed.
    const before = await readFile(feedbackPath, "utf-8");
    assert.equal(before.includes("Auto-Promoted Rules"), false);

    // Hit 1 + Hit 2: pattern exists but not promoted.
    for (let i = 1; i <= 2; i++) {
      await captureSubagentLesson({
        skill: "hydra-qa",
        outcome: "qa-fail",
        cue: "acceptance-criterion-unmet",
        context: `PR #${500 + i}: unmet criterion`,
        cycleId: `qa-cycle-${i}`,
      });
    }
    let patterns = await loadPatterns("planner");
    assert.equal(patterns[0].hitCount, 2);
    assert.equal(patterns[0].promoted, false);

    const beforePromote = await readFile(feedbackPath, "utf-8");
    assert.equal(beforePromote.includes("Auto-Promoted Rules"), false);

    // Hit 3: PROMOTION_THRESHOLD reached → feedback file is rewritten.
    await captureSubagentLesson({
      skill: "hydra-qa",
      outcome: "qa-fail",
      cue: "acceptance-criterion-unmet",
      context: "PR #503: unmet criterion",
      cycleId: "qa-cycle-3",
    });

    patterns = await loadPatterns("planner");
    assert.equal(patterns[0].hitCount, 3);
    assert.equal(patterns[0].promoted, true);
    assert.equal(typeof patterns[0].promotedAt, "string");
    assert.equal(patterns[0].hitsAtPromotion, 3);

    const after = await readFile(feedbackPath, "utf-8");
    assert.ok(
      after.includes("Auto-Promoted Rules"),
      "feedback file should contain the auto-promoted section",
    );
    assert.ok(
      after.includes("acceptance-criterion-unmet"),
      "feedback file should mention the promoted category",
    );
    assert.ok(
      after.includes("(3x"),
      "feedback file should record the hit count at promotion",
    );
  });

  // -------------------------------------------------------------------------
  // Issue #524 — acceptance-criterion-deferred is metadata, not a defect.
  // The pattern is recorded and hit count climbs, but the auto-promotion
  // to to-planner.md must NOT happen at the 3-hit unmet threshold.
  // -------------------------------------------------------------------------

  test("acceptance-criterion-deferred records hits but does NOT auto-promote at 3 hits", async () => {
    const feedbackPath = join(tempConfigRoot, "feedback", "to-planner.md");

    // 3 hits with the deferred cue. Same shape as the unmet test above,
    // except the cue string changes — the writer should classify this as
    // metadata and skip the feedback-file write.
    for (let i = 1; i <= 3; i++) {
      await captureSubagentLesson({
        skill: "hydra-qa",
        outcome: "qa-fail",
        cue: "acceptance-criterion-deferred",
        context: `PR #${600 + i}: manually verify after 24h post-deploy`,
        cycleId: `qa-cycle-deferred-${i}`,
      });
    }

    const patterns = await loadPatterns("planner");
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].category, "acceptance-criterion-deferred");
    assert.equal(patterns[0].hitCount, 3);
    // `promoted: true` is stamped so we don't re-evaluate, but the feedback
    // file write was skipped (the cue is metadata).
    assert.equal(patterns[0].promoted, true);

    const after = await readFile(feedbackPath, "utf-8");
    assert.equal(
      after.includes("Auto-Promoted Rules"),
      false,
      "deferred cue must NOT add an Auto-Promoted Rules section",
    );
    assert.equal(
      after.includes("acceptance-criterion-deferred"),
      false,
      "deferred cue text must NOT leak into to-planner.md",
    );
  });

  test("acceptance-criterion-unmet still auto-promotes at 3 hits (regression guard)", async () => {
    // Same flow as the unmet test above — duplicated here so this test file
    // can be read as a single before/after for the cue split.
    const feedbackPath = join(tempConfigRoot, "feedback", "to-planner.md");

    for (let i = 1; i <= 3; i++) {
      await captureSubagentLesson({
        skill: "hydra-qa",
        outcome: "qa-fail",
        cue: "acceptance-criterion-unmet",
        context: `PR #${700 + i}: missing X behaviour in diff`,
        cycleId: `qa-cycle-unmet-${i}`,
      });
    }

    const patterns = await loadPatterns("planner");
    assert.equal(patterns[0].promoted, true);
    const after = await readFile(feedbackPath, "utf-8");
    assert.ok(
      after.includes("Auto-Promoted Rules"),
      "unmet cue MUST still promote — only deferred is metadata",
    );
    assert.ok(after.includes("acceptance-criterion-unmet"));
  });

  // -------------------------------------------------------------------------
  // Input validation — the API endpoint relies on these throwing.
  // -------------------------------------------------------------------------

  test("invalid skill throws", async () => {
    await assert.rejects(
      () =>
        captureSubagentLesson({
          skill: "not-a-skill" as any,
          outcome: "qa-fail",
          cue: "x",
          context: "",
        }),
      /invalid skill/,
    );
  });

  test("invalid outcome throws", async () => {
    await assert.rejects(
      () =>
        captureSubagentLesson({
          skill: "hydra-qa",
          outcome: "not-an-outcome" as any,
          cue: "x",
          context: "",
        }),
      /invalid outcome/,
    );
  });

  test("empty cue throws", async () => {
    await assert.rejects(
      () =>
        captureSubagentLesson({
          skill: "hydra-qa",
          outcome: "qa-fail",
          cue: "   ",
          context: "",
        }),
      /cue is required/,
    );
  });

  // -------------------------------------------------------------------------
  // Non-regression: existing in-cycle recordPattern callers still work.
  // -------------------------------------------------------------------------

  test("existing recordPattern (codex-cycle path) still records without a source tag", async () => {
    const { recordPattern } = await import("../src/pattern-memory/agent-memory.ts");
    await recordPattern("executor", "no-diff", {
      action: "Write actual code.",
      example: "cycle-99: no files modified",
      cycleId: "cycle-99",
    });

    const patterns = await loadPatterns("executor");
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].category, "no-diff");
    // source is optional — codex-cycle callers don't set it.
    assert.equal(patterns[0].source, undefined);
  });

  // -------------------------------------------------------------------------
  // The recordPattern() return contract: pre-threshold calls return
  // `escalation: null`; the threshold-crossing call returns a populated
  // EscalationInput. This is the seam between pattern accounting (Redis-only)
  // and the GitHub-side dispatch (escalateIfNeeded). Tests can exercise either
  // half independently because of the split.
  // -------------------------------------------------------------------------

  test("recordPattern returns escalation: null below threshold, populated at threshold", async () => {
    const { recordPattern, PROMOTION_THRESHOLD } = await import("../src/pattern-memory/agent-memory.ts");

    const args = (i: number) => ["planner", "scope-creep", {
      action: "Narrow scope.",
      example: `cycle-${i}: scope-creep`,
      cycleId: `cycle-${i}`,
    }] as const;

    const r1 = await recordPattern(...args(1));
    assert.equal(r1.escalation, null, "1st hit should not request escalation");
    assert.equal(r1.crossedThreshold, false);

    const r2 = await recordPattern(...args(2));
    assert.equal(r2.escalation, null, "2nd hit should not request escalation");
    assert.equal(r2.crossedThreshold, false);

    const r3 = await recordPattern(...args(3));
    assert.equal(r3.crossedThreshold, true, "3rd hit promotes for the first time");
    assert.ok(r3.escalation, "3rd hit (== threshold) should request escalation");
    assert.equal(r3.escalation!.kind, "lesson");
    assert.equal(r3.escalation!.cue, "scope-creep");
    assert.equal(r3.escalation!.hitCount, PROMOTION_THRESHOLD);
    assert.deepEqual(r3.escalation!.skills, ["planner"]);
  });
});
