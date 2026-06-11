/**
 * Regression test for issue #1667 — friction-store fuzzy cue dedup.
 *
 * The friction store used to dedup patterns by EXACT category string match,
 * so free-authored kebab-case respellings of the same gotcha fragmented into
 * parallel hitCount:1 entries and the hitCount-based promotion/escalation
 * machinery never fired. recordPattern now normalizes write-side via
 * findPatternForCue (exact match first, then stemmed token-overlap >= 0.6).
 *
 * What this test proves:
 *   1. cueSimilarity scores the real fragment sets from the #1667 retro
 *      evidence above the merge threshold, and unrelated cue pairs below it.
 *   2. Single-token cues only match their exact spelling (degenerate-metric
 *      guard).
 *   3. findPatternForCue prefers an exact match over a fuzzy one, and breaks
 *      score ties toward the older pattern (firstSeen).
 *   4. recordPattern merges a respelled cue into the existing pattern: one
 *      entry, incremented hitCount, older spelling canonical, variant kept
 *      in `aliases`.
 *   5. Three fragment spellings of one gotcha now cross PROMOTION_THRESHOLD
 *      (crossedThreshold fires on the 3rd hit) — the exact recurrence the
 *      issue documents as structurally starved.
 *
 * Tests run against Redis DB 1 to avoid colliding with production state.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;
process.env.HYDRA_ESCALATION_DISABLED = "1"; // never spawn real gh during tests

let redis: any;
let agentMemory: typeof import("../src/pattern-memory/agent-memory.ts");

const noopEscalate = async () => null;

async function loadFrictionPatterns(skill: string): Promise<any[]> {
  const raw = await redis.get(`hydra:friction:${skill}:patterns`);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

// The real fragment sets from the #1667 retro evidence (run c79ae1d1).
const KNIP_SPELLINGS = [
  "knip-unused-export-is-internally-referenced-not-dead",
  "knip-unused-export-demote-not-delete",
  "knip-dead-export-still-internally-used",
  "knip-unused-export-is-internally-referenced",
];
const SENTRY_SPELLINGS = [
  "betting-worktree-npm-ci-missing-sentry-vercel-edge",
  "worktree-npm-ci-misses-sentry-vercel-edge-transitive",
  "next-build-missing-sentry-vercel-edge",
];

describe("fuzzy cue dedup (issue #1667)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
    agentMemory = await import("../src/pattern-memory/agent-memory.ts");
  });

  beforeEach(async () => {
    await cleanKeys();
  });

  after(async () => {
    if (redis) { await cleanKeys(); redis.disconnect(); }
  });

  // -------------------------------------------------------------------------
  // 1. cueSimilarity — the documented fragment sets merge
  // -------------------------------------------------------------------------

  test("knip fragment set: every respelling scores >= 0.6 vs the oldest spelling", () => {
    const [oldest, ...rest] = KNIP_SPELLINGS;
    for (const variant of rest) {
      const score = agentMemory.cueSimilarity(oldest, variant);
      assert.ok(
        score >= 0.6,
        `expected ${oldest} ~ ${variant} >= 0.6, got ${score}`,
      );
    }
  });

  test("sentry-vercel-edge fragment set: every respelling scores >= 0.6 vs the oldest spelling", () => {
    const [oldest, ...rest] = SENTRY_SPELLINGS;
    for (const variant of rest) {
      const score = agentMemory.cueSimilarity(oldest, variant);
      assert.ok(
        score >= 0.6,
        `expected ${oldest} ~ ${variant} >= 0.6, got ${score}`,
      );
    }
  });

  test("distinct gotchas sharing a prefix token stay below the merge threshold", () => {
    const pairs: [string, string][] = [
      // Two different real scope-check gotchas.
      ["scope-check-codespan-trap", "scope-check-reads-pr-body-live"],
      // Worktree-prefixed but unrelated.
      ["worktree-isolation-broken", "betting-worktree-npm-ci-missing-sentry-vercel-edge"],
      // Same subsystem, different failure.
      ["deploy-concurrency-cancels-master", "deploy-fails-on-dirty-tree"],
      ["verification-failure", "verification-timeout"],
    ];
    for (const [a, b] of pairs) {
      const score = agentMemory.cueSimilarity(a, b);
      assert.ok(score < 0.6, `expected ${a} ~ ${b} < 0.6, got ${score}`);
    }
  });

  test("single-token cues match exact spelling only (degenerate-metric guard)", () => {
    assert.equal(agentMemory.cueSimilarity("rollback", "rollback-loop"), 0);
    assert.equal(agentMemory.cueSimilarity("rollback", "rollback"), 1);
    // Two-token cues use the normal metric — sharing only "no" stays below threshold.
    assert.ok(agentMemory.cueSimilarity("no-diff", "no-op") < 0.6);
  });

  // -------------------------------------------------------------------------
  // 2. findPatternForCue — resolution order
  // -------------------------------------------------------------------------

  function mkPattern(category: string, firstSeen: string): any {
    return {
      category,
      severity: "prevent",
      hitCount: 1,
      firstSeen,
      lastSeen: firstSeen,
      lastCycleId: "test",
      action: "test action",
      examples: [],
      promoted: false,
    };
  }

  test("exact match wins over a fuzzy match — pre-existing fragments keep their identity", () => {
    const patterns = [
      mkPattern(KNIP_SPELLINGS[0], "2026-06-01"),
      mkPattern(KNIP_SPELLINGS[1], "2026-06-05"),
    ];
    const hit = agentMemory.findPatternForCue(patterns, KNIP_SPELLINGS[1]);
    assert.equal(hit?.category, KNIP_SPELLINGS[1]);
  });

  test("fuzzy match resolves to a pattern above threshold; no match returns undefined", () => {
    const patterns = [mkPattern(KNIP_SPELLINGS[0], "2026-06-01")];
    const hit = agentMemory.findPatternForCue(patterns, KNIP_SPELLINGS[2]);
    assert.equal(hit?.category, KNIP_SPELLINGS[0]);
    assert.equal(
      agentMemory.findPatternForCue(patterns, "scope-check-codespan-trap"),
      undefined,
    );
  });

  test("score ties break toward the OLDER pattern (firstSeen)", () => {
    // Identical token sets => identical (1.0) similarity to the probe.
    const younger = mkPattern("worktree-npm-ci-missing-sentry", "2026-06-08");
    const older = mkPattern("npm-ci-worktree-missing-sentry", "2026-06-02");
    const probe = "sentry-missing-worktree-npm-ci";
    const hit = agentMemory.findPatternForCue([younger, older], probe);
    assert.equal(hit?.category, "npm-ci-worktree-missing-sentry");
  });

  // -------------------------------------------------------------------------
  // 3. recordPattern — write-side merge end-to-end (friction namespace)
  // -------------------------------------------------------------------------

  test("recordPattern merges a respelled cue: one pattern, hitCount 2, older spelling canonical, alias kept", async () => {
    await agentMemory.recordPattern("hydra-dev", KNIP_SPELLINGS[0], {
      action: "demote the export, don't delete the symbol",
      example: "first sighting",
      cycleId: "cycle-1",
      source: "subagent",
      namespace: "friction",
      escalate: noopEscalate,
    });
    const result = await agentMemory.recordPattern("hydra-dev", KNIP_SPELLINGS[1], {
      action: "demote the export, don't delete the symbol",
      example: "second sighting under a different spelling",
      cycleId: "cycle-2",
      source: "subagent",
      namespace: "friction",
      escalate: noopEscalate,
    });

    assert.equal(result.pattern.category, KNIP_SPELLINGS[0]);
    assert.equal(result.pattern.hitCount, 2);
    assert.deepEqual(result.pattern.aliases, [KNIP_SPELLINGS[1]]);

    const stored = await loadFrictionPatterns("hydra-dev");
    assert.equal(stored.length, 1, "respelling must NOT fragment into a second entry");
    assert.equal(stored[0].category, KNIP_SPELLINGS[0]);
    assert.equal(stored[0].hitCount, 2);
    assert.deepEqual(stored[0].aliases, [KNIP_SPELLINGS[1]]);
  });

  test("three fragment spellings cross PROMOTION_THRESHOLD — recurrence promotion fires again", async () => {
    let crossed = false;
    let lastEscalationCue: string | null = null;
    const spyEscalate = async (input: any) => {
      if (input) lastEscalationCue = input.cue;
      return null;
    };

    for (let i = 0; i < 3; i++) {
      const result = await agentMemory.recordPattern("hydra-target-build", SENTRY_SPELLINGS[i], {
        action: "npm ci again inside the worktree before next build",
        example: `sighting ${i + 1}`,
        cycleId: `cycle-${i + 1}`,
        source: "subagent",
        namespace: "friction",
        escalate: spyEscalate,
      });
      if (result.crossedThreshold) crossed = true;
    }

    assert.equal(crossed, true, "3rd respelled hit must cross PROMOTION_THRESHOLD");

    const stored = await loadFrictionPatterns("hydra-target-build");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].category, SENTRY_SPELLINGS[0]);
    assert.equal(stored[0].hitCount, agentMemory.PROMOTION_THRESHOLD);
    assert.equal(stored[0].promoted, true);
    assert.deepEqual(
      [...stored[0].aliases].sort(),
      [SENTRY_SPELLINGS[1], SENTRY_SPELLINGS[2]].sort(),
    );
    // Escalation intent keys on the CANONICAL cue, not the last raw spelling.
    assert.equal(lastEscalationCue, SENTRY_SPELLINGS[0]);
  });

  test("unrelated cues still create separate patterns", async () => {
    await agentMemory.recordPattern("hydra-dev", "scope-check-codespan-trap", {
      action: "keep prose filenames plain-text",
      example: "a",
      cycleId: "c1",
      namespace: "friction",
      escalate: noopEscalate,
    });
    await agentMemory.recordPattern("hydra-dev", "stale-local-master-ref", {
      action: "diff against origin/master",
      example: "b",
      cycleId: "c2",
      namespace: "friction",
      escalate: noopEscalate,
    });

    const stored = await loadFrictionPatterns("hydra-dev");
    assert.equal(stored.length, 2);
    assert.ok(stored.every((p: any) => p.hitCount === 1));
    assert.ok(stored.every((p: any) => p.aliases === undefined));
  });
});
