/**
 * test/api-class-stats.test.mts — pin the read-only
 * GET /api/autopilot/class-stats view (issue #2943).
 *
 * The view composes the per-dispatch outcome records (#2942) + the spine
 * estimate into the per-class yield scoreboard and the shadow-mode dampener
 * plan. It is READ-ONLY (aside from a best-effort snapshot cache write). These
 * tests drive the factory's handler directly with an INJECTED composer fake (no
 * Redis, no HTTP server), asserting:
 *
 *   - the response carries `scoreboard`, `shadow`, and `generatedAt`;
 *   - the shadow plan's multipliers mirror the scoreboard verdicts (soft, never
 *     zero, time-boxed for underperformers);
 *   - a best-effort snapshot-persist failure NEVER fails the read (still 200);
 *   - the composer degrading to an empty board is a 200, not a 500 (dark-tolerant).
 *
 * New top-level describe with its own (trivial) lifecycle — touches no shared
 * Redis seam.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createAutopilotClassStatsRouter } from "../src/api/class-stats.ts";
import {
  computeClassScoreboard,
  type ClassScoreboard,
} from "../src/autopilot/class-stats-math.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";

const NOW = 1_800_000_000_000;

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

async function callRoute(
  build: () => Promise<ClassScoreboard>,
  persist: (s: ClassScoreboard) => Promise<unknown> = async () => undefined,
): Promise<any> {
  const router = createAutopilotClassStatsRouter(build, persist);
  const handler = findHandler(router, "GET", "/autopilot/class-stats");
  assert.ok(handler, "GET /autopilot/class-stats handler must be registered");
  const res = mockRes();
  await handler!({ query: {}, params: {} }, res);
  return res;
}

/** A scoreboard with one underperforming dev class + the rest empty. */
function underperformingBoard(): ClassScoreboard {
  const records: DispatchOutcomeRecord[] = [];
  for (let i = 0; i < 12; i++) {
    records.push({
      cycleId: "worktree-agent-277e4476-t4-dev_orch",
      runIdPrefix: "277e4476",
      turn: 4,
      className: "dev_orch",
      skill: "hydra-dev",
      outcome: i < 1 ? "merged" : "failed",
      tokens: 40_000,
      durationMs: 60_000,
      escalationAttempt: null,
      escalatedModel: null,
      recordedAt: NOW - (i + 1) * 60_000,
    });
  }
  return computeClassScoreboard(records, { metrics: [] }, { now: NOW });
}

describe("GET /api/autopilot/class-stats (issue #2943)", () => {
  test("returns scoreboard + shadow + generatedAt at 200", async () => {
    const board = underperformingBoard();
    const res = await callRoute(async () => board);
    assert.equal(res._status, 200);
    assert.ok(res._body.scoreboard, "scoreboard present");
    assert.ok(res._body.shadow, "shadow plan present");
    assert.equal(typeof res._body.generatedAt, "string");
    assert.equal(res._body.scoreboard.computedAt, NOW);
  });

  test("shadow plan dampens the underperforming dev class (2x, time-boxed) and leaves others at 1.0", async () => {
    const board = underperformingBoard();
    const res = await callRoute(async () => board);
    const verdicts = res._body.shadow.verdicts;
    const dev = verdicts.find((v: any) => v.className === "dev_orch");
    assert.ok(dev);
    assert.equal(dev.multiplier, 2.0);
    assert.ok(dev.reprobeAt !== null, "underperformer is time-boxed");
    // A class with no in-window dispatches stays at 1.0 / no re-probe.
    const qa = verdicts.find((v: any) => v.className === "qa_orch");
    assert.ok(qa);
    assert.equal(qa.multiplier, 1.0);
    assert.equal(qa.reprobeAt, null);
  });

  test("a snapshot-persist failure never fails the read (still 200)", async () => {
    const board = underperformingBoard();
    const res = await callRoute(
      async () => board,
      async () => {
        throw new Error("redis SET failed");
      },
    );
    assert.equal(res._status, 200, "persist failure must not surface as a 500");
    assert.ok(res._body.scoreboard);
  });

  test("an empty (dark) board is 200, not 500", async () => {
    const empty = computeClassScoreboard([], { metrics: [] }, { now: NOW });
    const res = await callRoute(async () => empty);
    assert.equal(res._status, 200);
    for (const c of res._body.scoreboard.classes) {
      assert.equal(c.verdict, "insufficient-sample");
    }
  });

  test("a composer that throws is caught → 500 with a body (never bodyless)", async () => {
    const res = await callRoute(async () => {
      throw new Error("boom");
    });
    assert.equal(res._status, 500);
    assert.ok(res._body.error, "500 carries an error body");
  });

  test("serializes the weightedQuota cost axis on each ClassStat (issue #3548)", async () => {
    // Build a board WITH weighted-quota inputs so dev_orch carries a computed
    // axis; assert the API passes it through the JSON body verbatim.
    const records: DispatchOutcomeRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push({
        cycleId: "worktree-agent-277e4476-t4-dev_orch",
        runIdPrefix: "277e4476",
        turn: 4,
        className: "dev_orch",
        skill: "hydra-dev",
        outcome: i < 6 ? "merged" : "failed",
        tokens: 40_000,
        durationMs: 60_000,
        escalationAttempt: null,
        escalatedModel: null,
        recordedAt: NOW - (i + 1) * 60_000,
      });
    }
    const board = computeClassScoreboard(records, { metrics: [] }, {
      now: NOW,
      weightedQuota: {
        byClassBreakdown: {
          dev_orch: {
            opus: { input: 250_000, output: 0, cacheCreation: 0, cacheRead: 0, total: 250_000 },
            sonnet: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
            haiku: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
            unknown: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
          },
        },
        cacheReadWeight: 1.0,
        burnWeights: { opus: 1, sonnet: 1, haiku: 1 },
      },
    });
    const res = await callRoute(async () => board);
    assert.equal(res._status, 200);
    const dev = res._body.scoreboard.classes.find((c: any) => c.className === "dev_orch");
    assert.ok(dev, "dev_orch row serialized");
    assert.equal(dev.weightedQuota, 250_000, "weightedQuota serialized verbatim");
    // A class whose skill produced no tokens (absent breakdown) serializes null.
    const qa = res._body.scoreboard.classes.find((c: any) => c.className === "qa_orch");
    assert.ok(qa);
    assert.equal(qa.weightedQuota, null);
  });

  test("serializes weightedQuotaPerMerge alongside the preserved tokensPerMerge (issue #3549)", async () => {
    // 10 dispatches, 6 merged @ 60k output tokens each; skill burned 300k
    // weighted quota in-window → per-merge = 300k / 6 = 50k.
    const records: DispatchOutcomeRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push({
        cycleId: "worktree-agent-277e4476-t4-dev_orch",
        runIdPrefix: "277e4476",
        turn: 4,
        className: "dev_orch",
        skill: "hydra-dev",
        outcome: i < 6 ? "merged" : "failed",
        tokens: 60_000,
        durationMs: 60_000,
        escalationAttempt: null,
        escalatedModel: null,
        recordedAt: NOW - (i + 1) * 60_000,
      });
    }
    const board = computeClassScoreboard(records, { metrics: [] }, {
      now: NOW,
      weightedQuota: {
        byClassBreakdown: {
          dev_orch: {
            opus: { input: 300_000, output: 0, cacheCreation: 0, cacheRead: 0, total: 300_000 },
            sonnet: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
            haiku: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
            unknown: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
          },
        },
        cacheReadWeight: 1.0,
        burnWeights: { opus: 1, sonnet: 1, haiku: 1 },
      },
    });
    const res = await callRoute(async () => board);
    assert.equal(res._status, 200);
    const dev = res._body.scoreboard.classes.find((c: any) => c.className === "dev_orch");
    assert.ok(dev, "dev_orch row serialized");
    // The weighted (subscription-cost) figure and the output-based figure both
    // serialize, and are distinct — never conflated.
    assert.equal(dev.weightedQuotaPerMerge, 50_000, "weighted-quota-per-merge serialized");
    assert.equal(dev.tokensPerMerge, 60_000, "output-based tokensPerMerge preserved unchanged");
    // A non-dev class carries no per-merge cost (null when inputs are injected).
    const qa = res._body.scoreboard.classes.find((c: any) => c.className === "qa_orch");
    assert.ok(qa);
    assert.equal(qa.weightedQuotaPerMerge, null);
  });
});
