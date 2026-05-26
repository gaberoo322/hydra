/**
 * Regression test for cost-attribution aggregation (issue #271).
 *
 * Context: cost-per-merge regressed from $2.21 (baseline 2026-04-30) to
 * $11.68 (50-cycle window after high-risk review, mutation, JIT, and
 * adversarial validation gates were added). Operators needed a per-role,
 * per-tier, per-anchor, per-complexity breakdown to identify which gate is
 * dominating spend.
 *
 * The aggregation logic is pure (no Redis), so this test feeds fixture
 * cycle summaries and asserts the rollup shape.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateCostAttribution,
  modelToTier,
  agentRoleToTier,
  deriveOutcome,
  KNOWN_AGENT_ROLES,
  type CycleSummary,
} from "../src/cost/index.ts";

describe("cost-attribution aggregation (issue #271)", () => {
  // --------------------------------------------------------------------
  // Pure helpers
  // --------------------------------------------------------------------

  test("modelToTier maps known aliases and raw names", () => {
    assert.equal(modelToTier("frontier"), "frontier");
    assert.equal(modelToTier("gpt-5.4"), "frontier");
    assert.equal(modelToTier("codex"), "codex");
    assert.equal(modelToTier("gpt-5.3-codex"), "codex");
    assert.equal(modelToTier("mini"), "mini");
    assert.equal(modelToTier("gpt-5.4-mini"), "mini");
    assert.equal(modelToTier("local"), "mini");
    assert.equal(modelToTier(""), "unknown");
    assert.equal(modelToTier(undefined), "unknown");
    assert.equal(modelToTier("something-else"), "unknown");
  });

  // Issue #303: the planner was bumped to `gpt-5.5` but `modelToTier`'s old
  // hard-coded "5.4" substring made it return "unknown" for ~77% of spend.
  // Lock every model id used by `src/codex-runner.ts` MODEL_PRICING into the
  // regression suite so adding a new model without updating cost-attribution
  // fails fast at CI rather than silently mis-bucketing dashboards.
  test("modelToTier recognizes every model id in MODEL_PRICING (issue #303)", () => {
    assert.equal(modelToTier("gpt-5.5"), "frontier");
    assert.equal(modelToTier("gpt-5.4"), "frontier");
    assert.equal(modelToTier("gpt-5.3-codex"), "codex");
    assert.equal(modelToTier("gpt-5.3-codex-spark"), "codex");
    assert.equal(modelToTier("gpt-5.4-mini"), "mini");
    assert.equal(modelToTier("gemma-4-26b"), "mini");
    // Tier aliases the runner emits
    assert.equal(modelToTier("rapid"), "codex");
    assert.equal(modelToTier("cache"), "frontier");
  });

  test("agentRoleToTier covers the standard roles", () => {
    // executor / fixer / jit-tester are LEGACY entries kept in the role
    // table for back-compat with historical Redis records emitted before
    // PR-3 (issue #383) deleted the codex agents themselves. They MUST
    // continue to resolve to "codex" so the cost-attribution dashboard
    // stays accurate for retention-window queries.
    assert.equal(agentRoleToTier("planner"), "frontier");
    assert.equal(agentRoleToTier("executor"), "codex");
    assert.equal(agentRoleToTier("fixer"), "codex");
    assert.equal(agentRoleToTier("jit-tester"), "codex");
    assert.equal(agentRoleToTier("skeptic"), "mini");
    assert.equal(agentRoleToTier("unknown-role"), "unknown");
  });

  // Issue #303: research roles (director, domain-researcher, …) were absent
  // from agentRoleToTier, so any research-loop agent run lacking a `model`
  // field fell through to "unknown". They all run on the frontier tier.
  test("agentRoleToTier covers research roles (issue #303)", () => {
    assert.equal(agentRoleToTier("director"), "frontier");
    assert.equal(agentRoleToTier("research-director"), "frontier");
    assert.equal(agentRoleToTier("domain-researcher"), "frontier");
    assert.equal(agentRoleToTier("technical-researcher"), "frontier");
    assert.equal(agentRoleToTier("market-researcher"), "frontier");
    assert.equal(agentRoleToTier("research-strategist"), "frontier");
    assert.equal(agentRoleToTier("strategist"), "frontier");
  });

  test("agentRoleToTier soft-falls-back for research-* / *-researcher variants", () => {
    // A new researcher config in config/research/ should not immediately
    // drop into "unknown" before someone updates the static table.
    assert.equal(agentRoleToTier("research-foo"), "frontier");
    assert.equal(agentRoleToTier("foo-researcher"), "frontier");
    assert.equal(agentRoleToTier("foo-reviewer"), "codex");
  });

  // Issue #303 acceptance: every role string emitted by `logAgentRun` call
  // sites in src/ resolves to a non-"unknown" tier. PR-3 (issue #383) removed
  // the codex-driven src/executor-agent.ts / src/fixer.ts / src/jit.ts /
  // src/preflight.ts call sites, but legacy Redis records from before the
  // cut are still attributed via the role table — `executor` etc. remain
  // in the role list as LEGACY entries.
  test("every role emitted by logAgentRun in src/ maps to a known tier (issue #303)", () => {
    const ROLES_FROM_SRC = [
      "planner",        // plan-cache hit-recording + (legacy) src/planner-prompt.ts
      "executor",       // LEGACY — historical runs from src/executor-agent.ts
      "fixer",          // LEGACY — historical runs from src/fixer.ts
      "jit-tester",     // LEGACY — historical runs from src/jit.ts
      "skeptic",        // LEGACY — historical runs from src/preflight.ts
    ];
    for (const role of ROLES_FROM_SRC) {
      const tier = agentRoleToTier(role);
      assert.notEqual(tier, "unknown", `role "${role}" maps to "unknown"`);
    }
    // Sanity-check that the exported enumeration is non-empty and all entries
    // resolve to a real tier.
    assert.ok(KNOWN_AGENT_ROLES.length > 0);
    for (const role of KNOWN_AGENT_ROLES) {
      const tier = agentRoleToTier(role);
      assert.ok(
        tier === "frontier" || tier === "codex" || tier === "mini",
        `KNOWN_AGENT_ROLES["${role}"] resolved to "${tier}"`,
      );
    }
  });

  test("deriveOutcome prefers merge > failure > abandoned > noWork", () => {
    assert.equal(deriveOutcome({ cycleId: "a", tasksMerged: 1, agentRuns: [] }), "merge");
    assert.equal(deriveOutcome({ cycleId: "b", tasksMerged: 0, tasksFailed: 1, agentRuns: [] }), "failure");
    assert.equal(deriveOutcome({ cycleId: "c", tasksAbandoned: 1, agentRuns: [] }), "abandoned");
    assert.equal(deriveOutcome({ cycleId: "d", agentRuns: [] }), "noWork");
  });

  // --------------------------------------------------------------------
  // Empty / edge inputs
  // --------------------------------------------------------------------

  test("empty input returns zeroed result without crashing", () => {
    const r = aggregateCostAttribution([]);
    assert.equal(r.windowCycles, 0);
    assert.equal(r.totalCostUsd, 0);
    assert.equal(r.costPerMerge, null);
    assert.deepEqual(r.byRole, []);
    assert.deepEqual(r.byTier, []);
    assert.deepEqual(r.byAnchorType, []);
    assert.deepEqual(r.byComplexity, []);
    assert.deepEqual(r.top5ExpensiveCycles, []);
  });

  test("cycles with no agent runs still count toward outcome bucketing", () => {
    const r = aggregateCostAttribution([
      { cycleId: "c1", tasksMerged: 1, anchorType: "issue", complexity: "standard", agentRuns: [] },
    ]);
    assert.equal(r.windowCycles, 1);
    assert.equal(r.mergedCycles, 1);
    assert.equal(r.totalCostUsd, 0);
    assert.equal(r.costPerMerge, 0);
    assert.equal(r.byOutcome[0].outcome, "merge");
  });

  // --------------------------------------------------------------------
  // Core attribution
  // --------------------------------------------------------------------

  test("aggregates cost by role, tier, anchor, complexity, outcome", () => {
    const cycles: CycleSummary[] = [
      {
        cycleId: "cycle-A",
        taskTitle: "Add metrics route",
        anchorType: "issue",
        complexity: "standard",
        tasksMerged: 1,
        agentRuns: [
          { agent: "planner",  costUsd: 1.0, model: "frontier" },
          { agent: "executor", costUsd: 3.0, model: "codex" },
          { agent: "skeptic",  costUsd: 0.1, model: "mini" },
        ],
      },
      {
        cycleId: "cycle-B",
        taskTitle: "Fix flaky test",
        anchorType: "failing-test",
        complexity: "quick-fix",
        tasksMerged: 1,
        agentRuns: [
          { agent: "planner",  costUsd: 0.5, model: "codex" },   // quick-fix uses codex
          { agent: "executor", costUsd: 2.0, model: "codex" },
        ],
      },
      {
        cycleId: "cycle-C",
        taskTitle: "Big refactor (failed)",
        anchorType: "research",
        complexity: "complex",
        tasksFailed: 1,
        agentRuns: [
          { agent: "planner",  costUsd: 2.0, model: "frontier" },
          { agent: "executor", costUsd: 5.0, model: "codex" },
          { agent: "fixer",    costUsd: 1.5, model: "codex" },
        ],
      },
    ];

    const r = aggregateCostAttribution(cycles);

    assert.equal(r.windowCycles, 3);
    assert.equal(r.mergedCycles, 2);
    assert.equal(r.failedCycles, 1);
    // 1+3+0.1 + 0.5+2 + 2+5+1.5 = 15.1
    assert.equal(r.totalCostUsd, 15.1);
    // costPerMerge = 15.1 / 2 = 7.55
    assert.equal(r.costPerMerge, 7.55);

    // Role rollup — executor dominates
    const roleMap = Object.fromEntries(r.byRole.map((b) => [b.role, b]));
    assert.equal(roleMap.executor.costUsd, 10);
    assert.equal(roleMap.planner.costUsd, 3.5);
    assert.equal(roleMap.fixer.costUsd, 1.5);
    assert.equal(roleMap.skeptic.costUsd, 0.1);
    assert.equal(r.byRole[0].role, "executor"); // sorted desc

    // Tier rollup — codex (executor + fixer + quick-fix planner) is largest
    const tierMap = Object.fromEntries(r.byTier.map((b) => [b.tier, b]));
    assert.equal(tierMap.codex.costUsd, 12); // 3 + 0.5 + 2 + 5 + 1.5
    assert.equal(tierMap.frontier.costUsd, 3); // 1 + 2
    assert.equal(tierMap.mini.costUsd, 0.1);

    // Anchor rollup
    const anchorMap = Object.fromEntries(r.byAnchorType.map((b) => [b.anchorType, b]));
    assert.equal(anchorMap.research.costUsd, 8.5); // 2+5+1.5
    assert.equal(anchorMap.issue.costUsd, 4.1);
    assert.equal(anchorMap["failing-test"].costUsd, 2.5);

    // Complexity rollup with per-merge derivation
    const complexityMap = Object.fromEntries(r.byComplexity.map((b) => [b.complexity, b]));
    assert.equal(complexityMap.standard.cycles, 1);
    assert.equal(complexityMap.standard.mergedCycles, 1);
    assert.equal(complexityMap.standard.costPerMerge, 4.1);
    assert.equal(complexityMap.complex.mergedCycles, 0);
    assert.equal(complexityMap.complex.costPerMerge, null); // no merges, no division-by-zero

    // Outcome
    const outcomeMap = Object.fromEntries(r.byOutcome.map((b) => [b.outcome, b]));
    assert.equal(outcomeMap.merge.cycles, 2);
    assert.equal(outcomeMap.failure.cycles, 1);
  });

  test("top5ExpensiveCycles is sorted desc and carries role breakdown", () => {
    const cycles: CycleSummary[] = Array.from({ length: 8 }, (_, i) => ({
      cycleId: `cycle-${i}`,
      taskTitle: `Task ${i}`,
      anchorType: "issue",
      complexity: "standard",
      tasksMerged: 1,
      agentRuns: [
        { agent: "planner", costUsd: 1.0 * (i + 1), model: "frontier" },
        { agent: "executor", costUsd: 2.0 * (i + 1), model: "codex" },
      ],
    }));

    const r = aggregateCostAttribution(cycles);
    assert.equal(r.top5ExpensiveCycles.length, 5);
    // Costs descending — first entry is cycle-7 (index 7) with cost 3*8=24
    assert.equal(r.top5ExpensiveCycles[0].cycleId, "cycle-7");
    assert.equal(r.top5ExpensiveCycles[0].totalCostUsd, 24);
    assert.equal(r.top5ExpensiveCycles[0].outcome, "merge");
    // Role breakdown sorted by cost desc
    assert.equal(r.top5ExpensiveCycles[0].roleBreakdown[0].role, "executor");
    assert.equal(r.top5ExpensiveCycles[0].roleBreakdown[0].costUsd, 16);
    assert.equal(r.top5ExpensiveCycles[0].roleBreakdown[1].role, "planner");
    assert.equal(r.top5ExpensiveCycles[0].roleBreakdown[1].costUsd, 8);
  });

  test("falls back to role->tier when run.model is missing (back-compat)", () => {
    // Pre-#271 agent-run entries lack the `model` field. The aggregator must
    // still produce a sensible tier breakdown via agentRoleToTier().
    const r = aggregateCostAttribution([
      {
        cycleId: "old-cycle",
        taskTitle: "Legacy entry",
        anchorType: "issue",
        complexity: "standard",
        tasksMerged: 1,
        agentRuns: [
          { agent: "planner",  costUsd: 1.0 },  // no model
          { agent: "executor", costUsd: 3.0 },  // no model
        ],
      },
    ]);

    const tierMap = Object.fromEntries(r.byTier.map((b) => [b.tier, b]));
    assert.equal(tierMap.frontier.costUsd, 1); // planner default
    assert.equal(tierMap.codex.costUsd, 3);    // executor default
  });

  test("percentages add up to ~100 when total > 0", () => {
    const r = aggregateCostAttribution([
      {
        cycleId: "c1",
        anchorType: "issue",
        complexity: "standard",
        tasksMerged: 1,
        agentRuns: [
          { agent: "planner", costUsd: 1, model: "frontier" },
          { agent: "executor", costUsd: 3, model: "codex" },
        ],
      },
    ]);
    const totalPct = r.byRole.reduce((sum, b) => sum + b.pct, 0);
    // Round-off tolerance — pct is rounded to 2 decimals
    assert.ok(Math.abs(totalPct - 100) < 0.1, `byRole pct sum ${totalPct} should be ~100`);
  });

  // Issue #303: end-to-end regression for the actual bug. Before the fix,
  // planner runs with model="gpt-5.5" landed in `byTier.unknown` because the
  // substring matcher only knew about 5.4. With the fix every dollar is
  // accounted for under a known tier.
  test("planner runs on gpt-5.5 land under frontier, not unknown (issue #303)", () => {
    const cycles: CycleSummary[] = [
      {
        cycleId: "c1",
        anchorType: "issue",
        complexity: "standard",
        tasksMerged: 1,
        agentRuns: [
          { agent: "planner",  costUsd: 5.0, model: "gpt-5.5" },
          { agent: "executor", costUsd: 1.0, model: "gpt-5.3-codex" },
        ],
      },
    ];
    const r = aggregateCostAttribution(cycles);
    const tierMap = Object.fromEntries(r.byTier.map((b) => [b.tier, b]));
    assert.equal(tierMap.frontier?.costUsd, 5.0, "planner spend should land under frontier");
    assert.equal(tierMap.codex?.costUsd, 1.0);
    assert.equal(tierMap.unknown, undefined, "no spend should be classified unknown");
  });

  test("ignores zero-cost agent runs in role/tier rollup but still counts cycles", () => {
    const r = aggregateCostAttribution([
      {
        cycleId: "c1",
        anchorType: "issue",
        complexity: "quick-fix",
        tasksMerged: 1,
        agentRuns: [
          { agent: "planner", costUsd: 0, model: "cache" },     // cache hit, $0
          { agent: "executor", costUsd: 2, model: "codex" },
        ],
      },
    ]);
    assert.equal(r.windowCycles, 1);
    assert.equal(r.totalCostUsd, 2);
    assert.equal(r.byRole.length, 1);
    assert.equal(r.byRole[0].role, "executor");
  });
});
