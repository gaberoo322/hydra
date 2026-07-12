/**
 * Regression tests for the zod schema guard on **POST /metrics/record**
 * (issue #2636).
 *
 * The endpoint previously accepted an arbitrary body with only an ad-hoc
 * `cycleId` presence check and passed the raw remainder to
 * `recordCycleMetrics`, returning `{error:"Missing cycleId"}` (no `code`
 * field) on a miss — a violation of the CLAUDE.md § HTTP validation
 * convention: _"HTTP request bodies validate through a zod `safeParse`; on
 * failure return 400 `{code:"schema-validation-failed", issues}`."_
 *
 * The sibling endpoint POST /autopilot/cycle-record was refactored to
 * `CycleRecordBodySchema.safeParse()` in #2034; this suite pins the same
 * contract onto /metrics/record:
 *
 *   - happy path: a valid `{cycleId, ...metrics}` body returns 200 {ok:true}
 *     and the metrics land in Redis;
 *   - validation failure: a missing/empty/non-string `cycleId` returns 400
 *     with the machine-readable `{code:"schema-validation-failed", issues}`
 *     shape (NOT the old `{error:"Missing cycleId"}`).
 *
 * Issue #3048 (architecture-scan deepening): POST /metrics/record now routes
 * THROUGH the `recordCycle()` coordinator (src/autopilot/cycle-close.ts)
 * instead of calling `recordCycleMetrics()` directly, restoring the ADR-0016
 * sole-writer invariant for the previously-shallow path. So a cycle written via
 * this endpoint now gets the FULL deep record — a `hydra:cycle:<id>` hash entry
 * AND `hydra:cycle:index` ZSET membership — not just the metrics-hash write. The
 * happy-path case below asserts that deep write. The #2803 `classifyAnchorType`
 * band-aid in the handler is DROPPED; anchorType classification is preserved
 * because recordCycle calls the same classifyAnchorType leaf, so the three
 * anchorType cases still hold — the mechanism moved, the observable didn't.
 *
 * Issue #3220 (architecture-scan deepening): the POST /metrics/record handler
 * was RELOCATED out of the metrics read-aggregator router
 * (src/api/metrics.ts) into the autopilot lifecycle WRITE router
 * (src/api/autopilot-lifecycle.ts), where its structural twin
 * POST /autopilot/cycle-record already lives. The URL path is byte-identical
 * (both routers mount at the same base in src/api.ts). This suite therefore now
 * resolves the handler off `createAutopilotLifecycleRouter()` and asserts it is
 * NO LONGER mounted on the metrics read router — the response/write contract is
 * unchanged, only the handler's home file moved.
 *
 * Uses Redis DB 1 — never touches production (DB 0). A file-level `after()`
 * hook closes the Redis client so the runner emits `# pass N` lines and CI's
 * PASS_COUNT check doesn't blow up (PR #518 lesson).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

// Issue #3220: the handler now lives on the autopilot lifecycle write router.
// The metrics router import is retained so the relocation test can assert the
// handler is NO LONGER mounted there.
const { createMetricsRouter } = await import("../src/api/metrics.ts");
const { createAutopilotLifecycleRouter } = await import("../src/api/autopilot-lifecycle.ts");
const { CycleRecordBodySchema } = await import("../src/autopilot/schemas.ts");

let redis: any;

async function cleanTestKeys() {
  const keys = await redis.keys("hydra:metrics:*");
  if (keys.length > 0) await redis.del(...keys);
  await redis.del("hydra:metrics:index");
  // Issue #3048: /metrics/record now routes through recordCycle(), which writes
  // a `hydra:cycle:<id>` hash + `hydra:cycle:index` ZSET membership, so sweep
  // those between cases too. The per-test cycleIds are unique
  // (`test-metrics-record-*-${Date.now()}`) — delete the whole test-key family
  // rather than leak into a sibling case's index read.
  const cycleKeys = await redis.keys("hydra:cycle:test-metrics-record-*");
  if (cycleKeys.length > 0) await redis.del(...cycleKeys);
}

function mockReq(body: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body };
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

describe("POST /metrics/record zod schema guard (issue #2636)", () => {
  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanTestKeys();
  });

  after(async () => {
    if (redis) {
      await cleanTestKeys();
      redis.disconnect();
    }
  });

  test("handler is mounted on the autopilot lifecycle router, not the metrics read router (issue #3220)", () => {
    // Relocated in #3220: the write handler now lives on the lifecycle write
    // surface next to its POST /autopilot/cycle-record twin.
    const lifecycleRouter = createAutopilotLifecycleRouter();
    const post = findHandler(lifecycleRouter, "POST", "/metrics/record");
    assert.ok(post, "POST /metrics/record handler should exist on the lifecycle router");

    // And it is NO LONGER on the metrics read-aggregator router — that surface
    // is now read-only (plus the Cost module's /metrics/tokens write hook).
    const metricsRouter = createMetricsRouter();
    const stray = findHandler(metricsRouter, "POST", "/metrics/record");
    assert.equal(stray, null, "POST /metrics/record must NOT remain on the metrics router");
  });

  test("happy path: valid {cycleId, ...metrics} returns 200 {ok:true} and persists", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-2636-${Date.now()}`;
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed", tasksMerged: 3 }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);

    // The metrics landed in the per-cycle Redis hash. Issue #3048: the reroute
    // through recordCycle carries `status` on the CYCLE-hash, not the
    // metrics-hash — the metrics feed gets the task/anchor fields. (The old
    // shallow impl leaked `status` into the metrics hash as an ad-hoc field;
    // that pass-through is gone.)
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(hash.tasksMerged, "3");
    // recordCycleMetrics stamps the cycleId back onto the hash (record.ts:194).
    assert.equal(hash.cycleId, cycleId);
    // status now lives on the cycle-hash the coordinator writes.
    const cycleHash = await redis.hgetall(`hydra:cycle:${cycleId}`);
    assert.equal(cycleHash.status, "completed");
  });

  test("deep write (issue #3048): a valid record now writes a cycle-hash entry AND a ZSET index membership", async () => {
    // The reroute through recordCycle() restores the ADR-0016 sole-writer
    // invariant for this previously-shallow path: a cycle written via
    // /metrics/record must now be a FULL cycle record — visible to
    // getMetricsTrend / buildClassScoreboard / assembleRetroBundle — not just a
    // metrics-hash write. Assert the two deep-path artifacts the shallow impl
    // never produced: the `hydra:cycle:<id>` hash and `hydra:cycle:index`
    // membership. Against the pre-#3048 shallow handler these assertions go red.
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-3048-deep-${Date.now()}`;
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed", tasksMerged: 1 }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);

    // 1. The cycle-hash entry (`hydra:cycle:<id>`) exists with a status field —
    //    the shallow path never wrote this key.
    const cycleHash = await redis.hgetall(`hydra:cycle:${cycleId}`);
    assert.equal(cycleHash.status, "completed", "cycle-hash status is written");

    // 2. ZSET index membership (`hydra:cycle:index`) — the shallow path never
    //    added the cycle to the index, so trend aggregation was blind to it.
    const indexScore = await redis.zscore("hydra:cycle:index", cycleId);
    assert.ok(indexScore !== null, "cycle is a member of hydra:cycle:index");

    // The metrics-hash feed is still written (recordCycle calls
    // recordCycleMetrics) — the deep path is a superset, not a replacement.
    // Note: recordCycle carries `status` on the CYCLE-hash (asserted above), not
    // the metrics-hash — the metrics feed gets the task/anchor fields. This is
    // the intended split; the shallow impl used to leak `status` into the
    // metrics hash as an ad-hoc pass-through field.
    const metricsHash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(metricsHash.tasksMerged, "1", "metrics-hash carries the task counts");
    assert.equal(metricsHash.cycleId, cycleId, "recordCycleMetrics stamps the cycleId");
  });

  test("classifies explicit anchorType through verbatim (issue #2803)", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-2803-explicit-${Date.now()}`;
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed", anchorType: "work-queue" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(hash.anchorType, "work-queue");
  });

  test("classifies absent anchorType to the 'unclassified' sentinel, never 'unknown' (issue #2803)", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const cycleId = `test-metrics-record-2803-absent-${Date.now()}`;
    const res = mockRes();
    // No anchorType, and a cycleId that does NOT match the worktree-agent slot
    // pattern → classifyAnchorType falls back to the "unclassified" sentinel.
    await post!(mockReq({ cycleId, status: "completed" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    // The endpoint now ALWAYS writes an explicit, non-empty anchorType — the
    // aggregator (src/metrics/aggregate.ts) can never bucket this as "unknown".
    assert.equal(hash.anchorType, "unclassified");
  });

  test("infers anchorType from a worktree-agent-slot cycleId when absent (issue #2803)", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    // The synthesised worktree-branch cycleId format decodes to a slot → anchorType.
    const cycleId = `worktree-agent-abc12345-t3-dev_orch`;
    // Issue #3048: recordCycle dedups on an existing `hydra:cycle:<id>` status,
    // and a dedup post does NOT re-classify anchorType. This cycleId is a FIXED
    // literal (not a `test-metrics-record-*` unique id swept by cleanTestKeys),
    // so a leftover cycle-hash / index membership from a prior run would send
    // this post down the dedup arm and the anchorType assertion would read the
    // stale metrics hash. Pre-clean the cycle-hash + index membership so this
    // post always takes recordCycle's first-write (classifying) path.
    await redis.del(`hydra:cycle:${cycleId}`, `hydra:metrics:${cycleId}`);
    await redis.zrem("hydra:cycle:index", cycleId);
    const res = mockRes();
    await post!(mockReq({ cycleId, status: "completed" }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    const hash = await redis.hgetall(`hydra:metrics:${cycleId}`);
    assert.equal(hash.anchorType, "work-queue");
    // cleanTestKeys globs hydra:metrics:* so the metrics key is swept, but the
    // cycle-hash + index membership are keyed on this literal and NOT under the
    // test-metrics-record-* glob — clean them explicitly.
    await redis.del(`hydra:metrics:${cycleId}`, `hydra:cycle:${cycleId}`);
    await redis.zrem("hydra:cycle:index", cycleId);
  });

  test("validation failure: missing cycleId returns 400 schema-validation-failed", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const res = mockRes();
    await post!(mockReq({ status: "completed" }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues), "issues array is present");
    // The old ad-hoc {error:"Missing cycleId"} shape is gone.
    assert.equal(res._body.error, undefined);
  });

  test("validation failure: empty-string cycleId returns 400 schema-validation-failed", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const res = mockRes();
    await post!(mockReq({ cycleId: "   " }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("validation failure: non-string cycleId returns 400 schema-validation-failed", async () => {
    const router = createAutopilotLifecycleRouter();
    const post = findHandler(router, "POST", "/metrics/record");
    const res = mockRes();
    await post!(mockReq({ cycleId: 42 }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

/**
 * Issue #2852 — CLI-flag-token corruption guard on CycleRecordBodySchema.
 *
 * ~12% of recent cycle records stored CLI flag tokens (`--cycle-id`,
 * `--status`, `--skill`) as field VALUES — an argument-parsing failure in the
 * dispatch pipeline shifted flag names into value slots, and the loose-object
 * schema accepted them cleanly, landing 100%-empty phantom cycles in the
 * metrics store keyed on `--cycle-id`.
 *
 * This suite pins the `.superRefine()` that rejects any identity-field VALUE
 * beginning with `--` at the schema boundary (the single defensive chokepoint
 * every HTTP caller funnels through), while confirming legitimate values —
 * UUIDs, worktree branch names, issue-NNN refs, numeric prNumbers, mapped
 * anchorTypes — still pass.
 *
 * Schema-only (no Redis) so it lives in its own top-level describe with no
 * before/after lifecycle (per the CLAUDE.md test-authoring rules — never
 * piggyback on a sibling suite's shared-Redis teardown).
 */
describe("CycleRecordBodySchema — CLI-flag-token value guard (issue #2852)", () => {
  test("rejects a cycleId that is a literal CLI flag token", () => {
    const result = CycleRecordBodySchema.safeParse({ cycleId: "--cycle-id" });
    assert.equal(result.success, false);
    assert.ok(
      !result.success && result.error.issues.some((i) => i.path[0] === "cycleId"),
      "the flag-shaped cycleId is the rejected field",
    );
  });

  test("rejects each flag-shaped identity field VALUE independently", () => {
    for (const [field, value] of [
      ["cycleId", "--cycle-id"],
      ["anchorType", "--status"],
      ["anchorReference", "--anchor"],
      ["taskTitle", "--skill"],
      ["prNumber", "--pr"],
    ] as const) {
      const body: Record<string, unknown> = { cycleId: "valid-cycle-id" };
      body[field] = value;
      const result = CycleRecordBodySchema.safeParse(body);
      assert.equal(result.success, false, `${field}=${value} should be rejected`);
      assert.ok(
        !result.success && result.error.issues.some((i) => i.path[0] === field),
        `${field} is flagged in the issues array`,
      );
    }
  });

  test("rejects the six real corruption samples from the issue evidence", () => {
    // The observed malformed records: flag tokens leaked into value slots.
    const corruptionSamples = [
      { cycleId: "--cycle-id", anchorType: "--status", taskTitle: "--skill" },
      { cycleId: "--cycle-id=a675d44e17fbcc82e" },
      { cycleId: "77d5c14c-0a6d-43ff-9fd4-d7c527964008", anchorType: "--status" },
      { cycleId: "ab07ae73cbba50381", taskTitle: "--skill" },
      { cycleId: "53bf2557-30a7-4605-a3f2-d033e8bf208d", anchorReference: "--anchor" },
      { cycleId: "aa6380135cb0ec4ba", prNumber: "--pr" },
    ];
    for (const sample of corruptionSamples) {
      const result = CycleRecordBodySchema.safeParse(sample);
      assert.equal(
        result.success,
        false,
        `corruption sample ${JSON.stringify(sample)} should be rejected`,
      );
    }
  });

  test("accepts a legitimate UUID cycleId (no false rejection)", () => {
    const result = CycleRecordBodySchema.safeParse({
      cycleId: "53bf2557-30a7-4605-a3f2-d033e8bf208d",
      status: "completed",
      anchorType: "work-queue",
    });
    assert.equal(result.success, true);
  });

  test("accepts a legitimate worktree-branch cycleId and issue-NNN anchorReference", () => {
    const result = CycleRecordBodySchema.safeParse({
      cycleId: "worktree-agent-abc12345-t3-dev_orch",
      status: "merged",
      anchorType: "work-queue",
      anchorReference: "issue-2852",
      taskTitle: "Fix the malformed cycle-record dispatch",
      prNumber: 2853,
    });
    assert.equal(result.success, true);
  });

  test("accepts a numeric prNumber and a string prNumber that is not flag-shaped", () => {
    for (const prNumber of [2853, "2853"]) {
      const result = CycleRecordBodySchema.safeParse({
        cycleId: "valid-cycle-id",
        prNumber,
      });
      assert.equal(result.success, true, `prNumber=${prNumber} should pass`);
    }
  });

  test("a single leading dash is NOT flag-shaped (only '--' prefix is refused)", () => {
    // The predicate is `/^--/`, so a single '-' or a mid-string '--' passes.
    const result = CycleRecordBodySchema.safeParse({
      cycleId: "-single-dash",
      anchorReference: "issue--with-double-dash-inside",
    });
    assert.equal(result.success, true);
  });
});
