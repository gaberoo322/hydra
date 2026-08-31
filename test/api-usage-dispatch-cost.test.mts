/**
 * Regression tests for the two dispatch -> issue cost-join HTTP routes (issue
 * #4126, ADR-0032 epic #4123 slice gamma):
 *
 *   - POST /api/usage/dispatch-cost — the reap-time writer
 *     (`scripts/autopilot/reap.py`'s `run_completion` is the real caller).
 *   - GET  /api/usage/by-issue      — the read surface #4123's A/B primary
 *     endpoint is blocked on.
 *
 * Mirrors `test/session-block.test.mts`'s handler-level testing pattern
 * (invoke the route handler directly via `findHandler`, no live HTTP
 * server) — same router (`src/api/usage.ts`), same mock req/res shape.
 *
 * Authored as its own file with a dedicated top-level `describe` +
 * before/beforeEach/after lifecycle (CLAUDE.md authoring rule) rather than
 * nested inside `test/session-block.test.mts`'s existing suite, so this
 * file's Redis cleanup can never race that file's shared-client teardown.
 * Uses Redis db 1 — same convention as the other Cost-domain suites.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { createUsageRouter } = await import("../src/api/usage.ts");

function mockReq(opts: { body?: any; query?: any } = {}): any {
  return {
    method: "POST",
    url: "/",
    headers: {},
    query: opts.query ?? {},
    params: {},
    body: opts.body ?? {},
  };
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
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("POST /api/usage/dispatch-cost + GET /api/usage/by-issue (issue #4126)", () => {
  let testRedis: any;

  async function cleanKeys() {
    const keys = await testRedis.keys("hydra:cost:dispatch-join:*");
    if (keys.length > 0) await testRedis.del(...keys);
  }

  before(async () => {
    testRedis = new Redis(process.env.REDIS_URL);
  });
  beforeEach(async () => {
    await cleanKeys();
  });
  after(async () => {
    await cleanKeys();
    await testRedis.quit();
  });

  test("POST records an attributed dispatch and stamps reapedAt server-side", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/dispatch-cost");
    assert.ok(post, "POST /usage/dispatch-cost handler should exist");

    const res = mockRes();
    await post!(
      mockReq({
        body: {
          issue: 4126,
          class: "dev_orch",
          dispatchKind: "autopilot-dispatched",
          dispatchTokensEstimate: 4200,
        },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.attributed, true);

    // Caller-supplied reapedAt is never accepted — verify the route stamped
    // its own via a direct read of the ledger.
    const raw = await testRedis.lrange("hydra:cost:dispatch-join:by-issue:4126", 0, -1);
    assert.equal(raw.length, 1);
    const stored = JSON.parse(raw[0]);
    assert.equal(stored.dispatchTokensEstimate, 4200);
    assert.ok(typeof stored.reapedAt === "string" && stored.reapedAt.length > 0);

    // Issue #4126 INV-2: no `skill` in the body -> the composer never reaches
    // for the getUsage() snapshot, so weightedQuotaTokensEstimate degrades to
    // the raw identity, and skill is stored as the explicit null.
    assert.equal(stored.skill, null);
    assert.equal(stored.weightedQuotaTokensEstimate, 4200);
    assert.equal(typeof stored.quotaWeightCalibrated, "boolean");

    // INV-8: the per-issue list carries a refreshed (bounded, non-permanent)
    // TTL, not -1 (no expiry).
    const ttl = await testRedis.ttl("hydra:cost:dispatch-join:by-issue:4126");
    assert.ok(ttl > 0, `expected a positive TTL, got ${ttl}`);
  });

  test("POST with issue:null records unattributed, attributed:false in the response", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/dispatch-cost");
    const res = mockRes();
    await post!(
      mockReq({
        body: {
          issue: null,
          class: "sweep_orch",
          dispatchKind: "autopilot-dispatched",
          dispatchTokensEstimate: 300,
        },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.recorded, true);
    assert.equal(res._body.attributed, false);

    const raw = await testRedis.lrange("hydra:cost:dispatch-join:unattributed", 0, -1);
    assert.equal(raw.length, 1);
  });

  test("POST with a malformed body is a 400 schema-validation-failed", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/dispatch-cost");
    const res = mockRes();
    await post!(mockReq({ body: { class: "dev_orch" } }), res); // missing required fields
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("GET /usage/by-issue with no query returns every attributed issue plus the residual", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/dispatch-cost");
    await post!(
      mockReq({
        body: {
          issue: 4126,
          class: "dev_orch",
          dispatchKind: "autopilot-dispatched",
          dispatchTokensEstimate: 5000,
        },
      }),
      mockRes(),
    );
    await post!(
      mockReq({
        body: {
          issue: null,
          class: "health",
          dispatchKind: "autopilot-dispatched",
          dispatchTokensEstimate: 100,
        },
      }),
      mockRes(),
    );

    const get = findHandler(router, "GET", "/usage/by-issue");
    assert.ok(get, "GET /usage/by-issue handler should exist");
    const res = mockRes();
    await get!(mockReq({ query: {} }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.byIssue.length, 1);
    assert.equal(res._body.byIssue[0].issue, 4126);
    assert.equal(res._body.byIssue[0].totalDispatchTokensEstimate, 5000);
    assert.equal(res._body.residualTokensEstimate, 100);
    assert.ok(res._body.attributedPercent < 100); // residual keeps this honest, never 100%
  });

  test("GET /usage/by-issue?issue=N narrows byIssue but keeps attributedPercent global", async () => {
    const router = createUsageRouter();
    const post = findHandler(router, "POST", "/usage/dispatch-cost");
    await post!(
      mockReq({
        body: { issue: 1, class: "dev_orch", dispatchKind: "autopilot-dispatched", dispatchTokensEstimate: 100 },
      }),
      mockRes(),
    );
    await post!(
      mockReq({
        body: { issue: 2, class: "qa_orch", dispatchKind: "autopilot-dispatched", dispatchTokensEstimate: 200 },
      }),
      mockRes(),
    );

    const get = findHandler(router, "GET", "/usage/by-issue");
    const res = mockRes();
    await get!(mockReq({ query: { issue: "1" } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.byIssue.length, 1);
    assert.equal(res._body.byIssue[0].issue, 1);
    // The residual/attributedPercent fold over the WHOLE ledger (issue #2's
    // 200 tokens are NOT visible in byIssue here, but ARE folded into
    // totalAttributedTokensEstimate via the global getUsageByIssue read).
  });

  test("GET /usage/by-issue?issue=not-a-number is a 400 schema-validation-failed", async () => {
    const router = createUsageRouter();
    const get = findHandler(router, "GET", "/usage/by-issue");
    const res = mockRes();
    await get!(mockReq({ query: { issue: "not-a-number" } }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });
});
