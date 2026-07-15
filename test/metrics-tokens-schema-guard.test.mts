/**
 * Regression tests for the zod schema guard on **POST /metrics/tokens**
 * (issue #3074).
 *
 * Before #3074 the handler validated its body with hand-rolled `typeof`/
 * `parseInt` branches and returned a NON-canonical `{error: "Missing 'skill'"}`
 * / `{error: "Missing or invalid 'tokens' ..."}` envelope — a violation of the
 * CLAUDE.md § HTTP validation convention: _"HTTP request bodies validate
 * through a zod `safeParse`; on failure return 400
 * `{code:"schema-validation-failed", issues}`."_
 *
 * The sibling endpoint POST /metrics/record was migrated to that seam in #2636;
 * this suite pins the same contract onto /metrics/tokens:
 *
 *   - happy path: a valid `{skill, tokens}` body returns 200 {ok:true} and the
 *     counters land in Redis;
 *   - string `tokens` is coerced (the schema owns the string→number policy the
 *     handler used to spell as `parseInt`);
 *   - validation failure: a missing/blank skill or a missing/negative/non-numeric
 *     tokens returns 400 with the machine-readable
 *     `{code:"schema-validation-failed", issues}` shape (NOT the old
 *     `{error:"Missing 'skill' ..."}`).
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

// Issue #3322: POST /metrics/tokens was split out of the metrics read router
// into the dedicated token-write seam (createMetricsTokensRouter). These
// mount-and-drive tests exercise that router; the route path is unchanged.
const { createMetricsTokensRouter } = await import("../src/api/metrics-tokens.ts");
const { SubagentTokensBodySchema } = await import("../src/schemas/metrics.ts");

let redis: any;

async function cleanTestKeys() {
  // The surrogate writer keys (src/redis/cost.ts): the daily total
  // `hydra:metrics:tokens:autopilot:daily:<date>`, the by-skill hash
  // `hydra:metrics:tokens:by-skill:daily:<date>`, and the per-cycle hash
  // `hydra:metrics:tokens:by-cycle:<id>`. Sweep the whole family.
  const keys = await redis.keys("hydra:metrics:tokens:*");
  if (keys.length > 0) await redis.del(...keys);
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

describe("POST /metrics/tokens zod schema guard (issue #3074)", () => {
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

  test("handler is mounted on the metrics-tokens write router", () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    assert.ok(post, "POST /metrics/tokens handler should exist");
  });

  // Issue #3322 invariant 4: after the split the metrics READ router is a pure
  // read surface — POST /metrics/tokens no longer lives on createMetricsRouter.
  test("POST /metrics/tokens is NOT on the metrics read router after the #3322 split", async () => {
    const { createMetricsRouter } = await import("../src/api/metrics.ts");
    const readRouter = createMetricsRouter();
    const postOnReadRouter = findHandler(readRouter, "POST", "/metrics/tokens");
    assert.equal(postOnReadRouter, null, "the write route moved off the read router");
  });

  test("happy path: valid {skill, tokens} returns 200 {ok:true} and persists", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const date = `2099-01-01`;
    const res = mockRes();
    await post!(mockReq({ skill: "hydra-dev", tokens: 12345, date }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.skill, "hydra-dev");
    assert.equal(res._body.tokens, 12345);

    // The counters landed in the per-day surrogate keys (src/redis/cost.ts).
    const dailyTotal = await redis.get(`hydra:metrics:tokens:autopilot:daily:${date}`);
    assert.equal(dailyTotal, "12345", "daily token counter is written");
    const skillTotal = await redis.hget(`hydra:metrics:tokens:by-skill:daily:${date}`, "hydra-dev");
    assert.equal(skillTotal, "12345", "per-skill token counter is written");
  });

  test("string tokens are coerced through the schema (was inline parseInt)", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const date = `2099-01-02`;
    const res = mockRes();
    // reap.py has historically posted a stringified count — the schema's
    // z.coerce.number() folds the old `parseInt(body.tokens, 10)` policy.
    await post!(mockReq({ skill: "hydra-qa", tokens: "500", date }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.tokens, 500);
    const skillTotal = await redis.hget(`hydra:metrics:tokens:by-skill:daily:${date}`, "hydra-qa");
    assert.equal(skillTotal, "500");
  });

  test("validation failure: missing skill returns 400 schema-validation-failed", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const res = mockRes();
    await post!(mockReq({ tokens: 100 }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues), "issues array is present");
    // The old ad-hoc {error:"Missing 'skill' (string)"} shape is gone.
    assert.equal(res._body.error, undefined);
  });

  test("validation failure: blank skill returns 400 schema-validation-failed", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const res = mockRes();
    await post!(mockReq({ skill: "   ", tokens: 100 }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("validation failure: missing tokens returns 400 schema-validation-failed", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const res = mockRes();
    await post!(mockReq({ skill: "hydra-dev" }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("validation failure: negative tokens returns 400 schema-validation-failed", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const res = mockRes();
    await post!(mockReq({ skill: "hydra-dev", tokens: -5 }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("validation failure: non-numeric tokens string returns 400 schema-validation-failed", async () => {
    const router = createMetricsTokensRouter();
    const post = findHandler(router, "POST", "/metrics/tokens");
    const res = mockRes();
    await post!(mockReq({ skill: "hydra-dev", tokens: "not-a-number" }), res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});

/**
 * Schema-level unit assertions for SubagentTokensBodySchema (issue #3074).
 *
 * Independently testable with synthetic inputs, no router mount and no Redis —
 * so this is its own top-level describe with no before/after lifecycle (per the
 * CLAUDE.md test-authoring rules — never piggyback on a sibling suite's
 * shared-Redis teardown).
 */
describe("SubagentTokensBodySchema (issue #3074)", () => {
  test("accepts a minimal {skill, tokens} body and trims skill", () => {
    const result = SubagentTokensBodySchema.safeParse({ skill: "  hydra-dev  ", tokens: 42 });
    assert.equal(result.success, true);
    assert.ok(result.success && result.data.skill === "hydra-dev", "skill is trimmed");
    assert.ok(result.success && result.data.tokens === 42);
  });

  test("coerces a string tokens value to a number", () => {
    const result = SubagentTokensBodySchema.safeParse({ skill: "hydra-dev", tokens: "999" });
    assert.equal(result.success, true);
    assert.ok(result.success && result.data.tokens === 999);
  });

  test("accepts zero tokens (non-negative, not strictly positive)", () => {
    const result = SubagentTokensBodySchema.safeParse({ skill: "hydra-dev", tokens: 0 });
    assert.equal(result.success, true);
  });

  test("carries optional date and cycleId through when present", () => {
    const result = SubagentTokensBodySchema.safeParse({
      skill: "hydra-dev",
      tokens: 1,
      date: "2026-07-09",
      cycleId: "worktree-agent-abc12345-t3-dev_orch",
    });
    assert.equal(result.success, true);
    assert.ok(result.success && result.data.date === "2026-07-09");
    assert.ok(result.success && result.data.cycleId === "worktree-agent-abc12345-t3-dev_orch");
  });

  test("rejects a blank skill", () => {
    const result = SubagentTokensBodySchema.safeParse({ skill: "   ", tokens: 1 });
    assert.equal(result.success, false);
    assert.ok(
      !result.success && result.error.issues.some((i) => i.path[0] === "skill"),
      "skill is the rejected field",
    );
  });

  test("rejects a negative tokens value", () => {
    const result = SubagentTokensBodySchema.safeParse({ skill: "hydra-dev", tokens: -1 });
    assert.equal(result.success, false);
    assert.ok(
      !result.success && result.error.issues.some((i) => i.path[0] === "tokens"),
      "tokens is the rejected field",
    );
  });

  test("rejects a non-numeric tokens string", () => {
    const result = SubagentTokensBodySchema.safeParse({ skill: "hydra-dev", tokens: "abc" });
    assert.equal(result.success, false);
  });

  test("ignores unknown fields (loose object, matching sibling autopilot schemas)", () => {
    const result = SubagentTokensBodySchema.safeParse({
      skill: "hydra-dev",
      tokens: 1,
      unknownField: "ignored",
    });
    assert.equal(result.success, true);
  });
});
