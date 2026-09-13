/**
 * Regression tests for **GET /metrics/unclassified** (issue #3443).
 *
 * Issue #3403 (PR #3406) shipped the instrumentation that captures each
 * still-`unclassified` cycle's attribution metadata (cycleId, prNumber,
 * anchorReference, taskTitle) via `getUnclassifiedAnchors()` in
 * `src/metrics/aggregate.ts`, but the function was exported without a consumer —
 * no API route, so the discovery playbook's >10%-unclassified investigation
 * could not reach it. This route exposes it: a thin delegate that returns the
 * aggregator's body RAW (`{ windowCycles, unclassified[], rate }`, no envelope).
 *
 * The route is exercised by invoking the mounted handler with a mock req/res
 * (the same harness as the sibling `test/metrics-session-tokens-api.test.mts`),
 * seeding the Redis metrics trend the same way `test/abandonment-metrics.test.mts`
 * does. The aggregator's own filter/rate math is covered by
 * `test/unclassified-anchors-instrumentation-3403.test.mts`; this file's job is
 * the HTTP exposure — mount, payload passthrough, rate, and the `count` clamp.
 *
 * Fixture note: to persist as a genuine `unclassified` trend row, a fixture must
 * (a) record an explicit `anchorType: "unclassified"` AND (b) use a
 * STRUCTURALLY UNDECODABLE cycleId (a bare UUID). `getMetricsTrend` re-infers a
 * decodable cycleId's lane at read time (#3390), so a decodable id would be
 * lifted OUT of the sentinel bucket; a bare UUID carries no class signal and
 * correctly stays unclassified (the #2822 never-guess invariant).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set test DB before any adapter imports (mirrors abandonment-metrics.test.mts).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { createMetricsRouter } = await import("../src/api/metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  await testRedis.del("hydra:metrics:index");
}

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query, params: {}, body: {} };
}

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
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

// Structurally-undecodable cycleIds (bare UUIDs / harness branch names) — these
// stay the `unclassified` sentinel at read time even after #3390 re-inference.
const UNDECODABLE = [
  "b8a3071f-a783-4812-bec5-8fa0f5079a08",
  "ec3928e1-e125-4342-8d4c-51bcd834fa19",
  "worktree-agent-a9c177cfbcf1de7bf",
];

describe("GET /metrics/unclassified (issue #3443)", () => {
  before(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL!);
  });

  beforeEach(async () => {
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("handler is mounted on the metrics router", () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    assert.ok(get, "GET /metrics/unclassified handler should exist");
  });

  test("happy path: returns unclassified records with cycleId + prNumber and a rate", async () => {
    // 2 unclassified (bare UUIDs, explicit sentinel) + 3 classified (decodable
    // cycleId, real lane) → 5 window cycles, 2/5 = 40.0% unclassified.
    await recordCycleMetrics(UNDECODABLE[0], {
      tasksAttempted: 1,
      anchorType: "unclassified",
      prNumber: "3406",
      taskTitle: "instrument unclassified residue",
    });
    await recordCycleMetrics(UNDECODABLE[1], {
      tasksAttempted: 1,
      anchorType: "unclassified",
      prNumber: "3401",
      anchorReference: "issue-3400",
    });
    for (let i = 0; i < 3; i++) {
      await recordCycleMetrics(`dev-${9000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({}), res);

    assert.equal(res._status, 200);
    // Body is the aggregator's RAW shape — no {ok}/envelope wrapping.
    assert.equal(res._body.windowCycles, 5);
    assert.equal(res._body.rate, 40.0, "2 of 5 cycles unclassified → 40.0%");
    assert.equal(res._body.unclassified.length, 2);
    // #3602 sub-bucket split: both fixtures are bare UUIDs with NO worktreeBranch,
    // so nothing decodes → both `no-attribution`, fixableRate 0.
    assert.equal(res._body.fixable, 0);
    assert.equal(res._body.noAttribution, 2);
    assert.equal(res._body.fixableRate, 0);
    for (const u of res._body.unclassified) {
      assert.equal(u.classification, "no-attribution");
    }

    const byId = Object.fromEntries(
      res._body.unclassified.map((u: any) => [u.cycleId, u]),
    );
    // Operator can trace each unclassified cycle back to its PR (success criterion).
    assert.equal(byId[UNDECODABLE[0]].prNumber, "3406");
    assert.equal(byId[UNDECODABLE[0]].taskTitle, "instrument unclassified residue");
    assert.equal(byId[UNDECODABLE[1]].prNumber, "3401");
    assert.equal(byId[UNDECODABLE[1]].anchorReference, "issue-3400");
  });

  test("empty state: no unclassified cycles → empty array and 0 rate", async () => {
    // Only classified cycles seeded → nothing in the unclassified bucket.
    for (let i = 0; i < 4; i++) {
      await recordCycleMetrics(`dev-${8000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({}), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.windowCycles, 4);
    assert.deepEqual(res._body.unclassified, []);
    assert.equal(res._body.rate, 0);
  });

  test("rate calculation: 1 unclassified in 4 cycles → 25.0%", async () => {
    await recordCycleMetrics(UNDECODABLE[2], {
      tasksAttempted: 1,
      anchorType: "unclassified",
      prNumber: "3299",
    });
    for (let i = 0; i < 3; i++) {
      await recordCycleMetrics(`dev-${7000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({}), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.windowCycles, 4);
    assert.equal(res._body.unclassified.length, 1);
    assert.equal(res._body.rate, 25.0);
    assert.equal(res._body.unclassified[0].prNumber, "3299");
  });

  test("the count query param bounds the read window (clamped-coercion idiom)", async () => {
    // Seed 5 cycles; a count=2 read must only see the 2 most-recent, so the
    // window shrinks — proving `count` is honoured (a hostile value can't fan
    // out unbounded Redis reads).
    for (let i = 0; i < 5; i++) {
      await recordCycleMetrics(`dev-${6000 + i}`, {
        tasksAttempted: 1,
        tasksMerged: 1,
        anchorType: "work-queue",
      });
    }

    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics/unclassified");
    const res = mockRes();
    await get!(mockReq({ count: "2" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.windowCycles, 2, "count=2 bounds the trend window to 2");
  });
});

// ---------------------------------------------------------------------------
// GET /metrics — cycle-ledger coverage label (issue #4392)
// ---------------------------------------------------------------------------

/**
 * `stats.anchorDistribution` (and every other cycle-derived view in this
 * payload) is folded from metrics-trend rows, which only exist for skills in
 * reap.py's CYCLE_RECORD_SKILLS — so producer classes (discover/architecture/
 * cleanup/scout/retro) structurally cannot appear in it, however often they
 * dispatch. That blind spot produced three false "producers dark" alarms
 * (#3752, #4302, #4388). The route now labels it: `coverage.classesNotRecorded`
 * names the classes this ledger can never carry, so a consumer — human or
 * hydra-discover — reads "not in this ledger" instead of a confident 0.
 *
 * The fixture transcript root is pinned via HYDRA_CLAUDE_PROJECTS_ROOT (the
 * same seam as test/metrics-session-tokens-api.test.mts) so the best-effort
 * costByClass arm scans an empty temp tree instead of the real
 * ~/.claude/projects — and its OAuth read is auto-stubbed by the override.
 */
describe("GET /metrics — coverage.classesNotRecorded (issue #4392)", () => {
  const savedRoot = process.env.HYDRA_CLAUDE_PROJECTS_ROOT;

  // Own lifecycle, no shared-Redis teardown reuse (the sibling describe above
  // disconnects `testRedis` in its after; this suite writes nothing and reads
  // an empty trend off the DB the file-level REDIS_URL already selected).
  before(async () => {
    process.env.HYDRA_CLAUDE_PROJECTS_ROOT = await mkdtemp(
      join(tmpdir(), "metrics-coverage-root-"),
    );
  });

  after(() => {
    if (savedRoot === undefined) delete process.env.HYDRA_CLAUDE_PROJECTS_ROOT;
    else process.env.HYDRA_CLAUDE_PROJECTS_ROOT = savedRoot;
  });

  test("response carries coverage.classesNotRecorded labelling the blind spot", async () => {
    const router = createMetricsRouter();
    const get = findHandler(router, "GET", "/metrics");
    assert.ok(get, "GET /metrics handler should exist");
    const res = mockRes();
    await get(mockReq({}), res);
    assert.equal(res._status, 200, `expected 200, body=${JSON.stringify(res._body)}`);
    const { CLASSES_WITHOUT_CYCLE_RECORD, CLASSES_WITH_CYCLE_RECORD } = await import(
      "../src/taxonomy/classes.ts"
    );
    // Design-concept INV-4: the additive top-level coverage object names the
    // ledger, BOTH partition halves, and the durable liveness source — while
    // stats.anchorDistribution keeps its numeric shape (no fabricated rows).
    const cov = res._body.coverage;
    assert.equal(cov.ledger, "cycle-record");
    assert.deepEqual(cov.recordedClasses, [...CLASSES_WITH_CYCLE_RECORD]);
    assert.deepEqual(cov.classesNotRecorded, [...CLASSES_WITHOUT_CYCLE_RECORD]);
    assert.equal(
      cov.livenessSource,
      "GET /api/autopilot/runs/:runId -> turns[].actions[].class",
    );
    assert.match(cov.note, /#3284/);
    // The #4388 false-alarm family is labelled; the cycle-recorded three are not.
    assert.ok(cov.classesNotRecorded.includes("discover_orch"));
    assert.ok(cov.classesNotRecorded.includes("architecture_orch"));
    assert.ok(cov.classesNotRecorded.includes("cleanup_orch"));
    assert.equal(cov.classesNotRecorded.includes("dev_orch"), false);
    // The existing views stay structurally unchanged: anchorDistribution is a
    // plain Record<string, number> — no string / fabricated-0 producer row.
    for (const value of Object.values(res._body.stats.anchorDistribution ?? {})) {
      assert.equal(typeof value, "number");
    }
  });

  // Design-concept INV-6 (issue #4392): the fix is read-side only — no new
  // write route may ride along on the metrics router.
  test("metrics router stays a pure read surface — no POST/PUT/DELETE/PATCH routes", () => {
    // `any`-typed like findHandler above: Express routes DO carry a runtime
    // `.methods` map, but @types/express's IRoute doesn't expose it.
    const router: any = createMetricsRouter();
    const methods = new Set<string>();
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const m of Object.keys(layer.route.methods)) methods.add(m.toLowerCase());
    }
    assert.deepEqual(
      [...methods].sort(),
      ["get"],
      `expected only GET routes, saw: ${[...methods].join(",")}`,
    );
  });
});
