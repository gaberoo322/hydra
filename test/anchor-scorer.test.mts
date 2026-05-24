/**
 * Regression tests for src/anchor-scorer.ts — anchor confidence scoring.
 *
 * Phase A (issue #346): the scorer is now fully deterministic — Tier 1 is the
 * pure heuristic, Tier 2 is the pure-given-inputs `refineScore` that combines
 * research-score, prior-attempt penalty, priorities alignment, and reframe
 * queue presence. There is no longer any LLM dependency, so every test below
 * exercises pure functions or `scoreAnchor` with a controlled config path.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  scoreHeuristic,
  scoreAnchor,
  refineScore,
  extractResearchScore,
  extractPriorAttempts,
  alignmentScore,
  resetPrioritiesCache,
  getMinConfidence,
} from "../src/anchor-scorer.ts";

// ---------------------------------------------------------------------------
// Helpers — minimal grounding stubs
// ---------------------------------------------------------------------------

function makeGrounding(overrides: Record<string, any> = {}) {
  return {
    testReport: { passed: 42, failed: 0 },
    typecheckReport: { exitCode: 0 },
    todoMarkers: [],
    failingTests: [],
    fileTree: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tier 1: Deterministic heuristic scoring
// ---------------------------------------------------------------------------

describe("anchor-scorer heuristic scoring", () => {
  // --- failing-test ---
  test("failing-test anchor always scores 1.0", () => {
    const result = scoreHeuristic(
      { type: "failing-test", reference: "auth login test" },
      makeGrounding(),
    );
    assert.equal(result.score, 1.0);
    assert.equal(result.tier, "heuristic");
  });

  // --- prior-failure ---
  test("prior-failure anchor scores 0.6", () => {
    const result = scoreHeuristic(
      { type: "prior-failure", reference: "task-123" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.6);
    assert.equal(result.tier, "heuristic");
  });

  // --- reframe ---
  test("reframe anchor scores 0.7", () => {
    const result = scoreHeuristic(
      { type: "reframe", reference: "auth refactor" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.7);
    assert.equal(result.tier, "heuristic");
  });

  // --- regression-hunt ---
  test("regression-hunt anchor scores 0.8", () => {
    const result = scoreHeuristic(
      { type: "regression-hunt", reference: "periodic hunt" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.8);
    assert.equal(result.tier, "heuristic");
  });

  // --- research ---
  test("research anchor with valid reference scores 0.8", () => {
    const result = scoreHeuristic(
      { type: "research", reference: "Add WebSocket reconnection" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.8);
    assert.equal(result.tier, "heuristic");
  });

  test("research anchor with empty reference scores 0", () => {
    const result = scoreHeuristic(
      { type: "research", reference: "" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  // --- user-request ---
  test("user-request with context scores 0.9", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "Add dark mode", context: "Toggle in settings" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.9);
  });

  test("user-request with description scores 0.9", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "Fix header", description: "Header overlaps on mobile" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.9);
  });

  test("user-request with reference only scores 0.6", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "Add feature X" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.6);
  });

  test("user-request with empty reference scores 0", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  test("user-request with completed prefix scores 0", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "COMPLETED: old task" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  // --- codebase-health ---
  test("codebase-health with no signal scores 0", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: large-file in src/api.ts" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  test("codebase-health with failing tests scores 0.8", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: coverage in src/api.ts" },
      makeGrounding({ failingTests: ["test-1"], testReport: { passed: 40, failed: 2 } }),
    );
    assert.equal(result.score, 0.8);
  });

  test("codebase-health with typecheck errors scores 0.7", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: type-safety" },
      makeGrounding({ typecheckReport: { exitCode: 1 } }),
    );
    assert.equal(result.score, 0.7);
  });

  test("codebase-health with TODO markers scores 0.5", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: docs" },
      makeGrounding({ todoMarkers: ["TODO: fix this"] }),
    );
    assert.equal(result.score, 0.5);
  });

  // --- issue (TODO/FIXME markers) ---
  test("issue anchor with active TODO markers scores 0.7", () => {
    const result = scoreHeuristic(
      { type: "issue", reference: "TODO: fix auth" },
      makeGrounding({ todoMarkers: ["TODO: fix auth"] }),
    );
    assert.equal(result.score, 0.7);
  });

  test("issue anchor with no markers scores 0.3", () => {
    const result = scoreHeuristic(
      { type: "issue", reference: "TODO: old task" },
      makeGrounding({ todoMarkers: [] }),
    );
    assert.equal(result.score, 0.3);
  });

  // --- doc (priorities fallback) ---
  test("doc anchor scores 0.5", () => {
    const result = scoreHeuristic(
      { type: "doc", reference: "direction/priorities.md" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.5);
  });

  // --- unknown type ---
  test("unknown anchor type scores 0.5", () => {
    const result = scoreHeuristic(
      { type: "banana", reference: "mystery" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.5);
  });

  // --- null/undefined anchor ---
  test("null anchor defaults to unknown type with 0.5", () => {
    const result = scoreHeuristic(null, makeGrounding());
    assert.equal(result.score, 0.5);
    assert.match(result.reason, /unknown/i);
  });

  // --- all results have required shape ---
  test("all results include score, reason, and tier", () => {
    const anchors = [
      { type: "failing-test", reference: "x" },
      { type: "prior-failure", reference: "x" },
      { type: "reframe", reference: "x" },
      { type: "research", reference: "x" },
      { type: "user-request", reference: "x" },
      { type: "codebase-health", reference: "x" },
      { type: "issue", reference: "x" },
      { type: "doc", reference: "x" },
      { type: "unknown-thing", reference: "x" },
    ];
    for (const anchor of anchors) {
      const result = scoreHeuristic(anchor, makeGrounding());
      assert.ok(typeof result.score === "number", `${anchor.type}: score is number`);
      assert.ok(result.score >= 0 && result.score <= 1, `${anchor.type}: score in range`);
      assert.ok(typeof result.reason === "string", `${anchor.type}: reason is string`);
      assert.ok(result.reason.length > 0, `${anchor.type}: reason non-empty`);
      assert.ok(result.tier === "heuristic", `${anchor.type}: tier is heuristic`);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Deterministic refinement (pure)
// ---------------------------------------------------------------------------

describe("anchor-scorer signal extractors", () => {
  test("extractResearchScore handles 0–1 floats", () => {
    assert.equal(extractResearchScore({ researchScore: 0.85 }), 0.85);
    assert.equal(extractResearchScore({ research_score: 0.4 }), 0.4);
    assert.equal(extractResearchScore({ score: 0 }), 0);
  });

  test("extractResearchScore normalises 0–100 ranges", () => {
    assert.equal(extractResearchScore({ researchScore: 75 }), 0.75);
    assert.equal(extractResearchScore({ score: 100 }), 1);
  });

  test("extractResearchScore reads from context", () => {
    assert.equal(
      extractResearchScore({ context: { researchScore: 0.6 } }),
      0.6,
    );
  });

  test("extractResearchScore returns null when absent", () => {
    assert.equal(extractResearchScore({}), null);
    assert.equal(extractResearchScore(null), null);
    assert.equal(extractResearchScore({ researchScore: "not a number" }), null);
  });

  test("extractPriorAttempts reads from multiple aliases", () => {
    assert.equal(extractPriorAttempts({ priorFailureCount: 3 }), 3);
    assert.equal(extractPriorAttempts({ retryCount: 2 }), 2);
    assert.equal(extractPriorAttempts({ totalAttempts: 5 }), 5);
    assert.equal(extractPriorAttempts({ context: { priorFailureCount: 1 } }), 1);
  });

  test("extractPriorAttempts defaults to 0", () => {
    assert.equal(extractPriorAttempts({}), 0);
    assert.equal(extractPriorAttempts(null), 0);
    assert.equal(extractPriorAttempts({ retryCount: "bad" }), 0);
  });
});

describe("anchor-scorer alignmentScore", () => {
  test("returns 0 when priorities content is missing", () => {
    assert.equal(alignmentScore("anything goes here", null), 0);
    assert.equal(alignmentScore("anything goes here", ""), 0);
  });

  test("returns 0 when reference is empty", () => {
    assert.equal(alignmentScore("", "# Priority tasks\nFix the websocket"), 0);
  });

  test("scores higher when reference tokens overlap with priorities", () => {
    const priorities = `# Priority tasks
## 1. Project proposed trade size in single-market exposure preflight
Update server-risk-limit-preflight to project exposure.
`;
    const onTopic = alignmentScore("Project proposed trade size in preflight", priorities);
    const offTopic = alignmentScore("Refactor unrelated dashboard typography", priorities);
    assert.ok(onTopic > offTopic, `on-topic ${onTopic} should beat off-topic ${offTopic}`);
    assert.ok(onTopic > 0, "on-topic alignment should be positive");
  });

  test("ignores the completed-work section", () => {
    const priorities = `# Priority tasks
## 1. Fix websocket reconnection
# What's been completed
- Add dark mode toggle
`;
    // "dark mode" is only mentioned in completed work — should NOT align.
    const score = alignmentScore("Add dark mode preference", priorities);
    assert.equal(score, 0);
  });
});

describe("anchor-scorer refineScore", () => {
  test("returns heuristic verbatim when no refinement signals fire", () => {
    const heuristic = { score: 0.6, reason: "baseline", tier: "heuristic" as const };
    const out = refineScore(heuristic, { type: "user-request", reference: "x" }, {
      prioritiesContent: null,
      reframeQueueDepth: 0,
    });
    assert.equal(out, heuristic);
  });

  test("research-score above 0.5 nudges score up; promotes tier to classifier", () => {
    const heuristic = { score: 0.5, reason: "baseline", tier: "heuristic" as const };
    const out = refineScore(heuristic, { type: "user-request", reference: "x", researchScore: 1 }, {
      prioritiesContent: null,
      reframeQueueDepth: 0,
    });
    assert.ok(out.score > heuristic.score, `expected ${out.score} > ${heuristic.score}`);
    assert.equal(out.tier, "classifier");
    assert.match(out.reason, /research-score/);
  });

  test("research-score below 0.5 nudges score down", () => {
    const heuristic = { score: 0.5, reason: "baseline", tier: "heuristic" as const };
    const out = refineScore(heuristic, { type: "user-request", reference: "x", researchScore: 0 }, {
      prioritiesContent: null,
      reframeQueueDepth: 0,
    });
    assert.ok(out.score < heuristic.score);
    assert.equal(out.tier, "classifier");
  });

  test("prior-attempt count penalises the score", () => {
    const heuristic = { score: 0.6, reason: "baseline", tier: "heuristic" as const };
    const out = refineScore(heuristic, { type: "prior-failure", reference: "x", retryCount: 2 }, {
      prioritiesContent: null,
      reframeQueueDepth: 0,
    });
    assert.ok(out.score < heuristic.score);
    assert.match(out.reason, /prior-attempt/);
  });

  test("prior-attempt penalty is capped", () => {
    const heuristic = { score: 0.6, reason: "baseline", tier: "heuristic" as const };
    const out = refineScore(heuristic, { type: "prior-failure", reference: "x", retryCount: 99 }, {
      prioritiesContent: null,
      reframeQueueDepth: 0,
    });
    // Penalty capped at 0.20, so score >= 0.40
    assert.ok(out.score >= 0.4 - 1e-9);
  });

  test("priorities alignment grants a small bonus", () => {
    const heuristic = { score: 0.5, reason: "baseline", tier: "heuristic" as const };
    const priorities = `# Priority tasks
## 1. Improve websocket reconnection latency
`;
    const out = refineScore(
      heuristic,
      { type: "user-request", reference: "Improve websocket reconnection" },
      { prioritiesContent: priorities, reframeQueueDepth: 0 },
    );
    assert.ok(out.score > heuristic.score);
    assert.match(out.reason, /priorities-alignment/);
  });

  test("reframe-queue bonus only applies to reframe anchors", () => {
    const heuristic = { score: 0.5, reason: "baseline", tier: "heuristic" as const };
    const reframeOut = refineScore(
      heuristic,
      { type: "reframe", reference: "x" },
      { prioritiesContent: null, reframeQueueDepth: 2 },
    );
    const otherOut = refineScore(
      heuristic,
      { type: "user-request", reference: "x" },
      { prioritiesContent: null, reframeQueueDepth: 2 },
    );
    assert.ok(reframeOut.score > heuristic.score);
    assert.equal(otherOut, heuristic);
  });

  test("score is clamped to [0, 1] under extreme inputs", () => {
    const heuristic = { score: 0.5, reason: "baseline", tier: "heuristic" as const };
    const high = refineScore(
      heuristic,
      { type: "user-request", reference: "x", researchScore: 1, retryCount: 0 },
      { prioritiesContent: "# Priority tasks\nx", reframeQueueDepth: 0 },
    );
    assert.ok(high.score <= 1);

    const low = refineScore(
      heuristic,
      { type: "prior-failure", reference: "x", researchScore: 0, retryCount: 99 },
      { prioritiesContent: null, reframeQueueDepth: 0 },
    );
    assert.ok(low.score >= 0);
  });
});

// ---------------------------------------------------------------------------
// scoreAnchor — end-to-end (no LLM, deterministic)
// ---------------------------------------------------------------------------

describe("anchor-scorer scoreAnchor end-to-end", () => {
  let configDir: string;

  before(async () => {
    configDir = await mkdtemp(join(tmpdir(), "anchor-scorer-test-"));
    await mkdir(join(configDir, "direction"), { recursive: true });
    await writeFile(
      join(configDir, "direction", "priorities.md"),
      `# Priority tasks\n## 1. Improve websocket reconnection latency\n`,
      "utf-8",
    );
    process.env.HYDRA_CONFIG_PATH = configDir;
  });

  after(async () => {
    try { await rm(configDir, { recursive: true, force: true }); } catch { /* intentional: cleanup */ }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  beforeEach(() => {
    resetPrioritiesCache();
  });

  test("returns identical shape to legacy API", async () => {
    const result = await scoreAnchor(
      { type: "user-request", reference: "Add feature X" },
      makeGrounding(),
    );
    assert.ok("score" in result);
    assert.ok("reason" in result);
    assert.ok("tier" in result);
    assert.ok(result.tier === "heuristic" || result.tier === "classifier");
    assert.ok(result.score >= 0 && result.score <= 1);
  });

  test("confident heuristic scores skip refinement (tier=heuristic)", async () => {
    const high = await scoreAnchor(
      { type: "failing-test", reference: "auth test", researchScore: 0 },
      makeGrounding(),
    );
    assert.equal(high.tier, "heuristic");
    assert.equal(high.score, 1.0);

    const low = await scoreAnchor(
      { type: "codebase-health", reference: "no signal anchor" },
      makeGrounding(),
    );
    assert.equal(low.tier, "heuristic");
    assert.equal(low.score, 0);
  });

  test("ambiguous heuristic + research signal promotes to classifier tier", async () => {
    const result = await scoreAnchor(
      { type: "user-request", reference: "improve websocket reconnection", researchScore: 0.9 },
      makeGrounding(),
    );
    // user-request with reference-only baseline is 0.6 (ambiguous)
    assert.equal(result.tier, "classifier");
    assert.ok(result.score >= 0.6);
  });

  test("deterministic: identical inputs produce identical outputs", async () => {
    const anchor = { type: "user-request", reference: "improve websocket reconnection", researchScore: 0.8, retryCount: 1 };
    const a = await scoreAnchor(anchor, makeGrounding());
    const b = await scoreAnchor(anchor, makeGrounding());
    assert.deepEqual(a, b);
  });

  // Snapshot test — pins the exact scoring shape for a known input set.
  // If anchor-scoring weights change deliberately, update this snapshot.
  test("snapshot: fixed inputs produce stable scores", async () => {
    const cases: Array<{ name: string; anchor: any; expected: { score: number; tier: string } }> = [
      {
        name: "failing-test always 1.0",
        anchor: { type: "failing-test", reference: "auth test" },
        expected: { score: 1.0, tier: "heuristic" },
      },
      {
        name: "prior-failure baseline 0.6 with no extra signals refined down by nothing",
        anchor: { type: "prior-failure", reference: "task-xyz" },
        expected: { score: 0.6, tier: "heuristic" },
      },
      {
        name: "user-request ref-only with research 0.5 stays at 0.6 (no refinement delta)",
        anchor: { type: "user-request", reference: "do thing", researchScore: 0.5 },
        expected: { score: 0.6, tier: "heuristic" },
      },
      {
        name: "user-request ref-only with research 1.0 lifts to ~0.75",
        anchor: { type: "user-request", reference: "do thing", researchScore: 1.0 },
        expected: { score: 0.75, tier: "classifier" },
      },
      {
        name: "user-request ref-only with research 0 and 1 prior-attempt drops to ~0.40",
        anchor: { type: "user-request", reference: "do thing", researchScore: 0, retryCount: 1 },
        expected: { score: 0.40, tier: "classifier" },
      },
      {
        name: "codebase-health with no signal stays 0",
        anchor: { type: "codebase-health", reference: "n/a" },
        expected: { score: 0, tier: "heuristic" },
      },
      {
        name: "issue anchor with no markers stays 0.3 (boundary — refinement skipped)",
        anchor: { type: "issue", reference: "TODO: ancient" },
        expected: { score: 0.3, tier: "heuristic" },
      },
    ];

    for (const c of cases) {
      const result = await scoreAnchor(c.anchor, makeGrounding());
      // Allow a tiny floating-point tolerance.
      assert.ok(
        Math.abs(result.score - c.expected.score) < 1e-9,
        `${c.name}: expected score=${c.expected.score}, got ${result.score} (reason: ${result.reason})`,
      );
      assert.equal(result.tier, c.expected.tier, `${c.name}: expected tier=${c.expected.tier}, got ${result.tier}`);
    }
  });

  // No-side-effects assertion: scoreAnchor must not call runAgent / codex-runner.
  // Strip comments before grepping so we only check actual code.
  test("scoreAnchor source does not import runAgent (issue #346)", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../src/anchor-scorer.ts", import.meta.url), "utf-8");
    const code = src
      // strip block comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // strip line comments
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/from\s+["']\.\/codex-runner/.test(code), "anchor-scorer.ts code must not import from codex-runner");
    assert.ok(!/\bawait\s+runAgent\b/.test(code), "anchor-scorer.ts code must not call runAgent");
    assert.ok(!/\bimport[^;]*\brunAgent\b/.test(code), "anchor-scorer.ts code must not import runAgent");
  });

  // Cleanup-style test — bust the cache so other tests aren't affected.
  test("resetPrioritiesCache clears cached content", async () => {
    // Read once to populate cache.
    await scoreAnchor({ type: "user-request", reference: "x", researchScore: 0.5 }, makeGrounding());
    resetPrioritiesCache();
    // Subsequent call re-reads — still works (no crash).
    const result = await scoreAnchor({ type: "user-request", reference: "x" }, makeGrounding());
    assert.ok(result);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("anchor-scorer configuration", () => {
  test("getMinConfidence returns a number", () => {
    const min = getMinConfidence();
    assert.ok(typeof min === "number");
    assert.ok(min >= 0 && min <= 1);
  });

  test("default min confidence is 0.4", () => {
    // Only valid when ANCHOR_MIN_CONFIDENCE env var is not set
    if (!process.env.ANCHOR_MIN_CONFIDENCE) {
      assert.equal(getMinConfidence(), 0.4);
    }
  });
});
