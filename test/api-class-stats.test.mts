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

import {
  createAutopilotClassStatsRouter,
  CLASS_STATS_MEMO_MS,
} from "../src/api/class-stats.ts";
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
      anchorReference: null,
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
        anchorReference: null,
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
        anchorReference: null,
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

// ---------------------------------------------------------------------------
// Issue #4637 — the 10-minute in-process memo (closure-scoped, injected clock)
// ---------------------------------------------------------------------------

describe("GET /api/autopilot/class-stats — 10-minute memo (issue #4637)", () => {
  /** One router instance (one memo) with a controllable clock + call counters. */
  function memoHarness(opts: { fail?: () => boolean; degraded?: () => boolean } = {}) {
    let clock = NOW;
    let builds = 0;
    let persists = 0;
    let releaseBuild: (() => void) | null = null;
    let gate: Promise<void> | null = null;
    const build = async () => {
      builds += 1;
      if (gate) await gate;
      if (opts.fail?.()) throw new Error("fictional composer failure");
      // Each build stamps a distinct computedAt so a recompute is observable.
      const board = computeClassScoreboard([], { metrics: [] }, { now: NOW + builds * 1000 });
      return opts.degraded?.() ? { ...board, degraded: true } : board;
    };
    const persist = async () => {
      persists += 1;
    };
    const router = createAutopilotClassStatsRouter(build, persist, () => clock);
    const handler = findHandler(router, "GET", "/autopilot/class-stats");
    assert.ok(handler, "GET /autopilot/class-stats handler must be registered");
    return {
      async get() {
        const res = mockRes();
        await handler!({ query: {}, params: {} }, res);
        return res;
      },
      advance(ms: number) {
        clock += ms;
      },
      holdBuilds() {
        gate = new Promise<void>((r) => {
          releaseBuild = r;
        });
      },
      release() {
        releaseBuild?.();
        gate = null;
      },
      get builds() {
        return builds;
      },
      get persists() {
        return persists;
      },
    };
  }

  test("CLASS_STATS_MEMO_MS is 10 minutes", () => {
    assert.equal(CLASS_STATS_MEMO_MS, 10 * 60 * 1000);
  });

  test("two requests inside the window build ONCE and return identical bodies (same generatedAt)", async () => {
    const h = memoHarness();
    const first = await h.get();
    h.advance(CLASS_STATS_MEMO_MS - 1);
    const second = await h.get();
    assert.equal(h.builds, 1, "one build per window");
    assert.equal(h.persists, 1, "persist runs once per recompute, never on a hit");
    assert.equal(first._status, 200);
    assert.equal(second._status, 200);
    assert.deepEqual(second._body, first._body, "identical memoised body");
    assert.equal(
      second._body.generatedAt,
      first._body.generatedAt,
      "a cached body keeps its original generatedAt — never a fresh timestamp",
    );
    assert.equal(first._body.generatedAt, new Date(NOW + 1000).toISOString());
  });

  test("a request at the end of the window recomputes (new generatedAt, second persist)", async () => {
    const h = memoHarness();
    const first = await h.get();
    h.advance(CLASS_STATS_MEMO_MS);
    const second = await h.get();
    assert.equal(h.builds, 2, "window elapsed → recompute");
    assert.equal(h.persists, 2, "persist runs once per recompute");
    assert.notEqual(second._body.generatedAt, first._body.generatedAt);
    // The response shape is unchanged.
    assert.deepEqual(Object.keys(second._body).sort(), ["generatedAt", "scoreboard", "shadow"]);
  });

  test("concurrent cold requests share ONE in-flight build", async () => {
    const h = memoHarness();
    h.holdBuilds();
    const pending = [h.get(), h.get(), h.get()];
    // Let the three handlers reach the shared in-flight promise.
    await new Promise((r) => setImmediate(r));
    h.release();
    const results = await Promise.all(pending);
    assert.equal(h.builds, 1, "one build for three concurrent cold requests");
    assert.equal(h.persists, 1);
    for (const res of results) {
      assert.equal(res._status, 200);
      assert.equal(res._body.generatedAt, results[0]._body.generatedAt);
    }
  });

  test("a failed recompute is NOT memoised — 500 with a body, then the next request retries", async () => {
    let failing = true;
    const h = memoHarness({ fail: () => failing });
    const first = await h.get();
    assert.equal(first._status, 500);
    assert.ok(first._body.error, "500 carries an error body");
    failing = false;
    const second = await h.get();
    assert.equal(second._status, 200, "the failure was not cached");
    assert.equal(h.builds, 2);
    assert.equal(h.persists, 1, "persist only follows a successful build");
  });

  test("a degraded board is served but NOT memoised — the next request recomputes (issue #5161)", async () => {
    let degraded = true;
    const h = memoHarness({ degraded: () => degraded });
    const first = await h.get();
    assert.equal(first._status, 200);
    assert.equal(first._body.scoreboard.degraded, true);
    degraded = false;
    const second = await h.get();
    assert.equal(h.builds, 2, "degraded board was not pinned");
    assert.equal(second._body.scoreboard.degraded, undefined);
    await h.get();
    assert.equal(h.builds, 2, "a healthy board IS memoised");
  });

  test("the scoreboard serves its verdict thresholds (issue #5161)", async () => {
    const h = memoHarness();
    const res = await h.get();
    assert.deepEqual(res._body.scoreboard.thresholds, {
      devWeakMergeRate: 0.1,
      producerWeakBeta: 0,
      devExpensiveWeightedQuotaPerMerge: 5_000_000,
    });
  });
});
