/**
 * Regression tests for the reflectionMatchSource telemetry stamp
 * (issue #1136 — Slice 2 follow-up to #1119).
 *
 * Slice 1 (#1119 / PR #1135) re-wired a reflection PRODUCER onto the reap
 * path, so the per-anchor store is non-empty again and the #841 live
 * injection path serves real prior-attempt narratives. But the
 * `reflectionMatchSource` cycle metric still read `'none'` on every cycle:
 * nothing ever wrote the underlying `reflectionSources` field.
 *
 * Slice 2 closes that gap. The code-writing dispatch reports the
 * comma-separated reflection bucket tokens it was SERVED at planning time,
 * the report rides reap's single authoritative `cycle-record` write (NOT a
 * competing skill-side POST — that loses the idempotency race), and
 * `recordCycle` passes it THROUGH to the metrics hash unchanged. The read
 * path's `deriveReflectionMatchSource` then buckets a real value instead of
 * `'none'`.
 *
 * These tests pin:
 *   - the block→token mapping the dispatch must perform (API emits
 *     `per-anchor-reflections` / `by-file-reflections`; the derivation
 *     matches the bare tokens `per-anchor` / `by-file`);
 *   - the pure pass-through: a `cycle-record` POST carrying reflectionSources
 *     lands the field on hydra:metrics:<cycleId>;
 *   - the round-trip: getMetricsTrend then reports reflectionMatchSource
 *     != 'none' for that cycle;
 *   - the truthful-none invariant: a cycle that served nothing omits the
 *     field and still buckets to 'none'.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

function mockReq(body: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
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

/**
 * The block→token mapping the SKILL.md deposit recipe performs, reproduced
 * here as a pure helper so the trap (raw API source strings mis-bucket) is
 * pinned by a unit test. Mirrors the jq in the playbook recipe.
 */
function mapBlocksToSources(blocks: Array<{ source: string; count: number }>): string {
  const tokens: string[] = [];
  for (const b of blocks) {
    if ((b.count ?? 0) <= 0) continue;
    const s = b.source ?? "";
    if (s.includes("per-anchor")) tokens.push("per-anchor");
    else if (s.includes("by-file")) tokens.push("by-file");
    else if (s.includes("global")) tokens.push("global");
  }
  return [...new Set(tokens)].join(",");
}

describe("reflectionMatchSource telemetry stamp (issue #1136)", () => {
  let deriveReflectionMatchSource: any;
  let getMetricsTrend: any;
  let createAutopilotRouter: any;
  let handler: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!deriveReflectionMatchSource) {
      const trend = await import("../src/metrics/trend.ts");
      deriveReflectionMatchSource = trend.deriveReflectionMatchSource;
      getMetricsTrend = trend.getMetricsTrend;
    }
    if (!createAutopilotRouter) {
      const mod = await import("../src/api/autopilot-lifecycle.ts");
      createAutopilotRouter = mod.createAutopilotLifecycleRouter;
    }
    const router = createAutopilotRouter();
    handler = findHandler(router, "POST", "/autopilot/cycle-record");
    assert.ok(handler, "POST /autopilot/cycle-record handler should exist");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // AC: deriveReflectionMatchSource maps a stamped field correctly.
  // ---------------------------------------------------------------------------
  test("deriveReflectionMatchSource buckets the mapped token strings", () => {
    assert.equal(deriveReflectionMatchSource(""), "none");
    assert.equal(deriveReflectionMatchSource("per-anchor"), "by-anchor");
    assert.equal(deriveReflectionMatchSource("by-file"), "by-file");
    assert.equal(deriveReflectionMatchSource("per-anchor,by-file"), "both");
  });

  // ---------------------------------------------------------------------------
  // Issue #2209: the literal string "none" (persisted in historical
  // cycle-metrics hashes before #1136's empty-omit guards, or by a
  // since-retired writer) must bucket to "none", NOT the catch-all "mixed".
  // Without the sentinel guard, split(",") yields ["none"] — length > 0,
  // matches no bucket token — and falls through to "mixed", silently
  // mislabeling ~40% of recent cycles. Surrounding whitespace is tolerated.
  // ---------------------------------------------------------------------------
  test('deriveReflectionMatchSource treats literal "none" sentinel as "none" (#2209)', () => {
    assert.equal(deriveReflectionMatchSource("none"), "none");
    assert.equal(deriveReflectionMatchSource("  none  "), "none");
    assert.notEqual(deriveReflectionMatchSource("none"), "mixed");
    // null/undefined already short-circuit to "none"; pin them alongside so
    // the full "no reflections served" surface is one assertion block.
    assert.equal(deriveReflectionMatchSource(null), "none");
    assert.equal(deriveReflectionMatchSource(undefined), "none");
  });

  // ---------------------------------------------------------------------------
  // The block→token mapping trap: the API's blocks[].source strings are
  // 'per-anchor-reflections' / 'by-file-reflections', NOT the bare tokens
  // the derivation matches. The deposit recipe MUST map.
  // ---------------------------------------------------------------------------
  test("block→token mapping yields tokens deriveReflectionMatchSource matches", () => {
    // Raw API source strings.
    const perAnchorOnly = mapBlocksToSources([
      { source: "per-anchor-reflections", count: 2 },
      { source: "by-file-reflections", count: 0 },
    ]);
    assert.equal(perAnchorOnly, "per-anchor");
    assert.equal(deriveReflectionMatchSource(perAnchorOnly), "by-anchor");

    const byFileOnly = mapBlocksToSources([
      { source: "per-anchor-reflections", count: 0 },
      { source: "by-file-reflections", count: 3 },
    ]);
    assert.equal(byFileOnly, "by-file");
    assert.equal(deriveReflectionMatchSource(byFileOnly), "by-file");

    const both = mapBlocksToSources([
      { source: "per-anchor-reflections", count: 1 },
      { source: "by-file-reflections", count: 1 },
    ]);
    assert.equal(both, "per-anchor,by-file");
    assert.equal(deriveReflectionMatchSource(both), "both");

    // Served nothing (all count 0) → empty → truthful 'none'.
    const nothing = mapBlocksToSources([
      { source: "per-anchor-reflections", count: 0 },
      { source: "by-file-reflections", count: 0 },
    ]);
    assert.equal(nothing, "");
    assert.equal(deriveReflectionMatchSource(nothing), "none");

    // Guard against the trap: the RAW source string must NOT bucket as the
    // correct 'by-anchor'. deriveReflectionMatchSource comma-splits and matches
    // the BARE tokens; 'per-anchor-reflections' is not the bare 'per-anchor'
    // member, so it falls through to the catch-all 'mixed' — proving the raw
    // API string would mis-bucket if the deposit recipe forgot to map.
    assert.equal(deriveReflectionMatchSource("per-anchor-reflections"), "mixed");
    assert.notEqual(deriveReflectionMatchSource("per-anchor-reflections"), "by-anchor");
  });

  // ---------------------------------------------------------------------------
  // Pure pass-through: a cycle-record POST carrying reflectionSources lands
  // the field on the metrics hash, and getMetricsTrend reports a real bucket.
  // ---------------------------------------------------------------------------
  test("cycle-record with reflectionSources stamps the metric and trend != 'none'", async () => {
    const req = mockReq({
      cycleId: "autopilot-turn-1136a",
      status: "merged",
      source: "claude",
      tasksMerged: 1,
      reflectionSources: "per-anchor,by-file",
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);

    // Field persisted verbatim on the metrics hash (pure pass-through).
    const metric = await redis.hgetall("hydra:metrics:autopilot-turn-1136a");
    assert.equal(metric.reflectionSources, "per-anchor,by-file");

    // Read path derives a real bucket.
    const trend = await getMetricsTrend(10);
    const row = trend.find((r: any) => r.cycleId === "autopilot-turn-1136a");
    assert.ok(row, "cycle should appear in the metrics trend");
    assert.equal(row.reflectionSources, "per-anchor,by-file");
    assert.equal(row.reflectionMatchSource, "both");
    assert.notEqual(row.reflectionMatchSource, "none");
  });

  // ---------------------------------------------------------------------------
  // Truthful-none: a cycle that served nothing omits the field and still
  // buckets to 'none' — distinguishing 'served nothing' from the pre-#1136
  // 'served but unstamped' false 'none'.
  // ---------------------------------------------------------------------------
  test("cycle-record without reflectionSources omits the field and buckets to 'none'", async () => {
    const req = mockReq({
      cycleId: "autopilot-turn-1136b",
      status: "merged",
      source: "claude",
      tasksMerged: 1,
      // no reflectionSources
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._body.ok, true);

    const metric = await redis.hgetall("hydra:metrics:autopilot-turn-1136b");
    assert.equal(metric.reflectionSources, undefined);

    const trend = await getMetricsTrend(10);
    const row = trend.find((r: any) => r.cycleId === "autopilot-turn-1136b");
    assert.ok(row, "cycle should appear in the metrics trend");
    assert.equal(row.reflectionMatchSource, "none");
  });

  // ---------------------------------------------------------------------------
  // Empty-string reflectionSources is treated as 'served nothing' (the
  // recordCycle guard strips a zero-length value), still bucketing to 'none'.
  // ---------------------------------------------------------------------------
  test("empty reflectionSources is stripped, not persisted as ''", async () => {
    const req = mockReq({
      cycleId: "autopilot-turn-1136c",
      status: "merged",
      source: "claude",
      tasksMerged: 1,
      reflectionSources: "",
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._body.ok, true);

    const metric = await redis.hgetall("hydra:metrics:autopilot-turn-1136c");
    assert.equal(metric.reflectionSources, undefined);

    const trend = await getMetricsTrend(10);
    const row = trend.find((r: any) => r.cycleId === "autopilot-turn-1136c");
    assert.equal(row.reflectionMatchSource, "none");
  });
});
