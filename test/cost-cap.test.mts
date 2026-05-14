/**
 * Regression tests for the per-cycle cost cap circuit breaker (issue #209).
 *
 * Bug: There was no per-cycle spending cap on the build loop. Recent
 * metrics showed abandoned cycles consuming up to $56 each before
 * hitting their gate (Preflight, Auto-decompose, Planner noWork). With
 * 31 abandoned cycles in the last 50, this was the dominant cost-leak
 * class — a single bad cycle cost ~3x the median cycle.
 *
 * Fix: New `HYDRA_PER_CYCLE_COST_CAP_USD` env (default $25) aborts a
 * build cycle once accumulated agent cost crosses the threshold. The
 * cycle records `Cost cap exceeded: ...` as `abandonReason` so it
 * appears as a category in `/api/metrics/abandonment`.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import {
  createMockCycleContext,
  createMockAnchor,
} from "./helpers/mock-context.ts";

// Force test DB before adapter imports
process.env.REDIS_URL = "redis://localhost:6379/1";

// Lazy module imports (after env override)
const {
  getPerCycleCostCapUsd,
  getCycleCostUsd,
  checkCostCap,
  runCostCapCheck,
  COST_CAP_REASON_PREFIX,
  StreamingBudget,
  createStreamingBudget,
  isStreamingBudgetEnabled,
} = await import("../src/cost-cap.ts");
// `maybeUpdateStreamBudget` lived in `src/codex-runner.ts` and was removed
// in PR-3 (issue #383). The describe block that tested it was deleted at
// the bottom of this file along with the 9-cycle replay regression suite
// that depended on it.
const { getAbandonmentBreakdown } = await import("../src/metrics.ts");

let testRedis: any;

async function cleanKeys() {
  const patterns = [
    "hydra:cycle:*",
    "hydra:metrics:*",
    "hydra:anchors:*",
    "hydra:reflections:*",
  ];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
}

describe("per-cycle cost cap circuit breaker (issue #209)", () => {
  // Snapshot env so individual tests can mutate without leaking to siblings
  let savedCap: string | undefined;

  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    savedCap = process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    await cleanKeys();
  });

  afterEach(() => {
    if (savedCap === undefined) {
      delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    } else {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = savedCap;
    }
  });

  after(async () => {
    if (testRedis) {
      await cleanKeys();
      testRedis.disconnect();
    }
  });

  // -----------------------------------------------------------------
  // getPerCycleCostCapUsd — env parsing and default
  // -----------------------------------------------------------------

  describe("getPerCycleCostCapUsd", () => {
    test("returns default $25 when env unset", () => {
      delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
      assert.equal(getPerCycleCostCapUsd(), 25);
    });

    test("parses numeric env value", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      assert.equal(getPerCycleCostCapUsd(), 10);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "0.5";
      assert.equal(getPerCycleCostCapUsd(), 0.5);
    });

    test("returns Infinity for 'Infinity' value", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "Infinity";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "infinity";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
    });

    test("returns Infinity for non-finite or non-positive values (off)", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "0";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "-5";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "not-a-number";
      assert.equal(getPerCycleCostCapUsd(), Infinity);
    });

    test("treats empty string as default", () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "";
      assert.equal(getPerCycleCostCapUsd(), 25);
    });
  });

  // -----------------------------------------------------------------
  // getCycleCostUsd — Redis read of accumulated microdollars
  // -----------------------------------------------------------------

  describe("getCycleCostUsd", () => {
    test("returns 0 for cycle with no recorded spend", async () => {
      const cost = await getCycleCostUsd("cycle-cc-empty");
      assert.equal(cost, 0);
    });

    test("converts microdollars to dollars", async () => {
      // Manually seed the costs hash that task-tracker normally writes
      await testRedis.hset(
        "hydra:cycle:cycle-cc-seed:costs",
        "costMicrodollars",
        12_500_000, // $12.50
      );
      const cost = await getCycleCostUsd("cycle-cc-seed");
      assert.equal(cost, 12.5);
    });

    test("handles negative or invalid values defensively", async () => {
      await testRedis.hset(
        "hydra:cycle:cycle-cc-bad:costs",
        "costMicrodollars",
        "-100",
      );
      const cost = await getCycleCostUsd("cycle-cc-bad");
      assert.equal(cost, 0);
    });
  });

  // -----------------------------------------------------------------
  // checkCostCap — pure status query
  // -----------------------------------------------------------------

  describe("checkCostCap", () => {
    test("not exceeded under cap", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "25";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-under:costs",
        "costMicrodollars",
        10_000_000, // $10
      );
      const status = await checkCostCap("cycle-cc-under");
      assert.equal(status.exceeded, false);
      assert.equal(status.costUsd, 10);
      assert.equal(status.capUsd, 25);
    });

    test("exceeded when cost meets cap exactly", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "5";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-eq:costs",
        "costMicrodollars",
        5_000_000, // $5
      );
      const status = await checkCostCap("cycle-cc-eq");
      assert.equal(status.exceeded, true);
      assert.match(status.reason, new RegExp(`^${COST_CAP_REASON_PREFIX}: \\$5\\.00`));
    });

    test("exceeded when cost is above cap", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-over:costs",
        "costMicrodollars",
        56_000_000, // $56 — the worst observed cycle
      );
      const status = await checkCostCap("cycle-cc-over");
      assert.equal(status.exceeded, true);
      assert.equal(status.costUsd, 56);
    });

    test("never exceeded when cap is Infinity", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "Infinity";
      await testRedis.hset(
        "hydra:cycle:cycle-cc-inf:costs",
        "costMicrodollars",
        100_000_000, // $100
      );
      const status = await checkCostCap("cycle-cc-inf");
      assert.equal(status.exceeded, false);
      assert.equal(status.capUsd, Infinity);
    });
  });

  // -----------------------------------------------------------------
  // runCostCapCheck — pipeline step abandonment flow
  // -----------------------------------------------------------------

  describe("runCostCapCheck pipeline step", () => {
    test("continue=true when under cap (normal path)", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "25";
      const ctx = createMockCycleContext({ cycleId: "cycle-cc-pipe-under" });
      // No microdollars seeded → cost = 0 → not exceeded
      const result = await runCostCapCheck(ctx, { title: "x" }, "task-1", "post-preflight");
      assert.equal(result.continue, true);
      assert.equal(result.status.exceeded, false);
    });

    test("aborts with stable reason when over cap", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      const cycleId = "cycle-cc-pipe-over";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        15_000_000,
      );
      const ctx = createMockCycleContext({ cycleId });
      const result = await runCostCapCheck(
        ctx,
        { title: "expensive task", __plannerModel: "gpt-5.4" },
        "task-1",
        "post-preflight",
      );
      assert.equal(result.continue, false);
      assert.ok(result.result, "should return a LoopResult");
      assert.match(
        result.result.reason,
        /Cost cap exceeded: \$15\.00 >= \$10\.00 \(after post-preflight\)/,
      );
      assert.equal(result.result.cycleId, cycleId);
      assert.deepEqual(result.result.tasks, [
        { taskId: "task-1", finalState: "abandoned", reason: result.result.reason },
      ]);
    });

    test("publishes task:cost_cap_exceeded notification on abort", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "5";
      const cycleId = "cycle-cc-pipe-event";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        20_000_000,
      );
      const ctx = createMockCycleContext({ cycleId });
      const eventBus = ctx.eventBus as any;
      await runCostCapCheck(ctx, { title: "t" }, "task-1", "post-executor");
      const evt = eventBus.published.find(
        (e: any) => e.type === "task:cost_cap_exceeded",
      );
      assert.ok(evt, "expected task:cost_cap_exceeded event");
      assert.equal(evt.payload.checkpoint, "post-executor");
      assert.equal(evt.payload.costUsd, 20);
      assert.equal(evt.payload.capUsd, 5);
    });

    test("abandonment metrics record reason starting with 'Cost cap exceeded'", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      const cycleId = "cycle-cc-pipe-metrics";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        30_000_000,
      );
      const ctx = createMockCycleContext({
        cycleId,
        anchor: createMockAnchor({ type: "priorities", reference: "expensive-anchor" }),
      });
      await runCostCapCheck(
        ctx,
        { title: "blew the budget" },
        "task-1",
        "post-preflight",
      );

      // Verify metrics row written with abandonReason starting with our prefix
      const rawReason = await testRedis.hget(
        `hydra:metrics:${cycleId}`,
        "abandonReason",
      );
      assert.ok(rawReason, "abandonReason should be persisted");
      assert.ok(
        rawReason.startsWith(COST_CAP_REASON_PREFIX),
        `abandonReason should start with "${COST_CAP_REASON_PREFIX}", got: ${rawReason}`,
      );

      // Verify it shows up under a "Cost cap exceeded" category
      const breakdown = await getAbandonmentBreakdown(20);
      const category = breakdown.byCategory.find(
        (c) => c.category === COST_CAP_REASON_PREFIX,
      );
      assert.ok(
        category,
        `expected '${COST_CAP_REASON_PREFIX}' category in /api/metrics/abandonment breakdown`,
      );
      assert.equal(category!.count, 1);
    });

    test("Infinity cap means no abort even with high spend", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "Infinity";
      const cycleId = "cycle-cc-pipe-inf";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        99_000_000,
      );
      const ctx = createMockCycleContext({ cycleId });
      const result = await runCostCapCheck(ctx, { title: "t" }, "task-1", "post-preflight");
      assert.equal(result.continue, true);
      assert.equal(result.status.exceeded, false);
    });

    test("includes checkpoint label in abort reason", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "1";
      const cycleId = "cycle-cc-pipe-ckpt";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        5_000_000,
      );
      const ctx = createMockCycleContext({ cycleId });
      const result = await runCostCapCheck(ctx, { title: "t" }, "task-1", "post-executor");
      assert.equal(result.continue, false);
      assert.match(result.result.reason, /\(after post-executor\)/);
    });
  });

  // -----------------------------------------------------------------
  // Streaming budget — issue #286
  // -----------------------------------------------------------------

  describe("StreamingBudget — mid-stream cost projector (issue #286)", () => {
    // Frontier-tier pricing for tests. Matches MODEL_PRICING in codex-runner.
    const FRONTIER_PRICING = { input: 3.0, output: 15.0 };

    let savedStreamEnabled: string | undefined;

    beforeEach(() => {
      savedStreamEnabled = process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
      delete process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
    });

    afterEach(() => {
      if (savedStreamEnabled === undefined) {
        delete process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
      } else {
        process.env.HYDRA_STREAM_COST_CHECK_ENABLED = savedStreamEnabled;
      }
    });

    test("isStreamingBudgetEnabled defaults to on", () => {
      delete process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
      assert.equal(isStreamingBudgetEnabled(), true);
      process.env.HYDRA_STREAM_COST_CHECK_ENABLED = "true";
      assert.equal(isStreamingBudgetEnabled(), true);
      process.env.HYDRA_STREAM_COST_CHECK_ENABLED = "false";
      assert.equal(isStreamingBudgetEnabled(), false);
      process.env.HYDRA_STREAM_COST_CHECK_ENABLED = "0";
      assert.equal(isStreamingBudgetEnabled(), false);
    });

    test("zero output produces zero projected call cost (input cost only)", () => {
      const b = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 25,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 1_000_000, // exactly $3 of input
      });
      assert.equal(b.estimatedOutputTokens(), 0);
      assert.equal(b.projectedCallCostUsd(), 3.0);
      assert.equal(b.projectedTotalUsd(), 3.0);
      assert.equal(b.shouldAbort(), false);
    });

    test("output chars roll up into projected output cost", () => {
      const b = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 100,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
        charsPerTokenOutput: 4, // explicit for predictable math
      });
      // 400 chars -> 100 tokens -> $15 * 100/1e6 = $0.0015
      b.updateItemChars("msg-1", 400);
      assert.equal(b.estimatedOutputTokens(), 100);
      assert.equal(Number(b.projectedCallCostUsd().toFixed(4)), 0.0015);
    });

    test("multiple in-flight items sum into projection", () => {
      const b = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 100,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
        charsPerTokenOutput: 4,
      });
      b.updateItemChars("msg-1", 400); // 100 tokens
      b.updateItemChars("reason-1", 800); // 200 tokens
      assert.equal(b.estimatedOutputTokens(), 300);
    });

    test("completeItem moves chars to completed pool so later updates don't lose them", () => {
      const b = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 100,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
        charsPerTokenOutput: 4,
      });
      b.updateItemChars("msg-1", 400);
      b.completeItem("msg-1", 400);
      assert.equal(b.estimatedOutputTokens(), 100);
      // Starting a new item must not erase the completed one.
      b.updateItemChars("msg-2", 400);
      assert.equal(b.estimatedOutputTokens(), 200);
    });

    test("shouldAbort fires when projected total crosses cap (mid-planner scenario)", () => {
      // Scenario: cycle already burned $20 on preflight; cap is $25.
      // Planner is now streaming output. After enough chars, projection
      // should cross $25 and trip the abort.
      const b = new StreamingBudget({
        baselineUsd: 20,
        capUsd: 25,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 100_000, // $0.30 of input
        charsPerTokenOutput: 4,
      });
      assert.equal(b.shouldAbort(), false);
      // 4 chars/token, $15/1M output: need ~$4.70 in output -> ~313k tokens
      // -> ~1.25M chars. Stream a giant message.
      b.updateItemChars("msg-1", 1_500_000); // 375k tokens -> $5.625
      assert.equal(b.shouldAbort(), true);
      const reason = b.markAborted("mid-stream");
      assert.match(reason, /^Cost cap exceeded: projected \$\d+\.\d+ >= \$25\.00 mid-planner/);
      assert.equal(b.hasAborted(), true);
    });

    test("Infinity cap never aborts even on huge output", () => {
      const b = new StreamingBudget({
        baselineUsd: 1000,
        capUsd: Infinity,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 10_000_000,
      });
      b.updateItemChars("msg-1", 10_000_000);
      assert.equal(b.shouldAbort(), false);
    });

    test("markAborted is idempotent — second call returns the original reason", () => {
      const b = new StreamingBudget({
        baselineUsd: 50,
        capUsd: 25,
        pricing: FRONTIER_PRICING,
        agentName: "executor",
        inputTokens: 0,
      });
      const r1 = b.markAborted("pre-stream");
      const r2 = b.markAborted("mid-stream");
      assert.equal(r1, r2);
    });

    test("updates after markAborted are no-ops", () => {
      const b = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 25,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
        charsPerTokenOutput: 4,
      });
      b.markAborted("mid-stream");
      const tokensBefore = b.estimatedOutputTokens();
      b.updateItemChars("msg-1", 1_000_000);
      assert.equal(b.estimatedOutputTokens(), tokensBefore);
    });

    test("conservative chars-per-token (3.5) over-counts output vs 4-char baseline", () => {
      // 3500 chars -> 1000 tokens at 3.5, vs 875 at 4.0.
      const conservative = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 100,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
        charsPerTokenOutput: 3.5,
      });
      const generous = new StreamingBudget({
        baselineUsd: 0,
        capUsd: 100,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
        charsPerTokenOutput: 4,
      });
      conservative.updateItemChars("m", 3500);
      generous.updateItemChars("m", 3500);
      assert.equal(conservative.estimatedOutputTokens(), 1000);
      assert.equal(generous.estimatedOutputTokens(), 875);
      // Conservative MUST project >= generous so we trip earlier, not later.
      assert.ok(conservative.projectedCallCostUsd() >= generous.projectedCallCostUsd());
    });
  });

  // -----------------------------------------------------------------
  // createStreamingBudget — async factory tied to live cycle cost
  // -----------------------------------------------------------------

  describe("createStreamingBudget", () => {
    const FRONTIER_PRICING = { input: 3.0, output: 15.0 };

    let savedStreamEnabled: string | undefined;
    beforeEach(() => {
      savedStreamEnabled = process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
      delete process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
    });
    afterEach(() => {
      if (savedStreamEnabled === undefined) {
        delete process.env.HYDRA_STREAM_COST_CHECK_ENABLED;
      } else {
        process.env.HYDRA_STREAM_COST_CHECK_ENABLED = savedStreamEnabled;
      }
    });

    test("returns null when stream check is disabled", async () => {
      process.env.HYDRA_STREAM_COST_CHECK_ENABLED = "false";
      const b = await createStreamingBudget({
        cycleId: "cycle-cc-sb-off",
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 100,
      });
      assert.equal(b, null);
    });

    test("returns null when cap is Infinity", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "Infinity";
      const b = await createStreamingBudget({
        cycleId: "cycle-cc-sb-inf",
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 100,
      });
      assert.equal(b, null);
    });

    test("returns null when cycleId missing", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      const b = await createStreamingBudget({
        cycleId: null,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 100,
      });
      assert.equal(b, null);
    });

    test("constructs budget seeded with current cycle spend", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "25";
      const cycleId = "cycle-cc-sb-real";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        7_500_000, // $7.50 already spent
      );
      const b = await createStreamingBudget({
        cycleId,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
      });
      assert.ok(b, "expected a StreamingBudget");
      assert.equal(b!.baselineUsd, 7.5);
      assert.equal(b!.capUsd, 25);
      assert.equal(b!.shouldAbort(), false);
    });

    test("already-over-cap cycle constructs a budget that immediately reports abort", async () => {
      process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "10";
      const cycleId = "cycle-cc-sb-over";
      await testRedis.hset(
        `hydra:cycle:${cycleId}:costs`,
        "costMicrodollars",
        15_000_000, // $15 already spent, over the $10 cap
      );
      const b = await createStreamingBudget({
        cycleId,
        pricing: FRONTIER_PRICING,
        agentName: "planner",
        inputTokens: 0,
      });
      assert.ok(b);
      assert.equal(b!.shouldAbort(), true);
    });
  });

  // The `maybeUpdateStreamBudget` describe blocks and the 9-cycle replay
  // regression suite that lived here were removed in PR-3 (issue #383)
  // along with `src/codex-runner.ts`. The `StreamingBudget` class itself
  // is still exported from `src/cost-cap.ts` and exercised by the cap
  // unit tests above; the SDK-event integration tests had no replacement
  // surface to test against once codex-runner went away.
});
