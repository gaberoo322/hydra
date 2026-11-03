/**
 * Route-level tests for the additive `admission` field on
 * GET /api/usage/eligibility (issue #5101, QA round 1): field present, the
 * pre-existing verdict keys unchanged, and garbled / repeated query values
 * answer 200 (ADR-0022 GET-read leniency, never 400/500).
 *
 * Own top-level describe with its own lifecycle (CLAUDE.md authoring rule).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { createUsageRouter } = await import("../src/api/usage.ts");
const { EligibilityQuerySchema } = await import("../src/schemas/usage.ts");

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(c: number) { res._status = c; return res; },
    json(b: any) { res._body = b; return res; },
    send(b: any) { res._body = b; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

function findHandler(router: any, path: string): Function {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods.get) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error("handler not found");
}

async function get(query: any) {
  const h = findHandler(createUsageRouter(), "/usage/eligibility");
  const res = mockRes();
  await h({ method: "GET", url: "/", headers: {}, query, params: {}, body: {} }, res);
  return res;
}

describe("GET /api/usage/eligibility admission field (issue #5101)", () => {
  test("returns 200 with an admission field and the unchanged verdict keys", async () => {
    const res = await get({});
    assert.equal(res._status, 200);
    assert.ok(res._body.admission, "admission field present");
    assert.equal(typeof res._body.admission.reason, "string");
    assert.equal(typeof res._body.allow, "boolean", "pre-existing allow key unchanged");
  });

  test("repeated query keys (array values) answer 200, not 500", async () => {
    const res = await get({ pidAlive: ["1", "1"], serviceActive: ["1", "0"], mode: ["exec", "exec"] });
    assert.equal(res._status, 200);
    assert.ok(res._body.admission);
  });

  test("garbled query values answer 200", async () => {
    const res = await get({ mode: "bogus", pidAlive: "zzz", serviceActive: { a: 1 } });
    assert.equal(res._status, 200);
    assert.ok(res._body.admission);
  });

  test("schema: array values coerce to defaults; well-formed values still parse (sibling pin)", () => {
    const coerced = EligibilityQuerySchema.parse({ pidAlive: ["1", "1"], mode: ["exec"] });
    assert.equal(coerced.mode, "timer");
    assert.equal(coerced.serviceActive, false);
    assert.equal(coerced.pidAlive, false);
    const ok = EligibilityQuerySchema.parse({ pidAlive: "1", serviceActive: "true", mode: "exec" });
    assert.equal(ok.mode, "exec");
    assert.equal(ok.serviceActive, true);
    assert.equal(ok.pidAlive, true);
  });

  test("admission carries the #5103 fields; the launcher pair and stamp ride the query", async () => {
    const res = await get({ primaryModel: "sonnet", fallbackModel: "haiku", nudgeLastAt: "1700000000" });
    assert.equal(res._status, 200);
    const a = res._body.admission;
    assert.equal(typeof a.shouldNudgeOauth, "boolean");
    assert.equal(typeof a.launchModel, "string");
    assert.equal(a.primaryModel, "sonnet");
    assert.equal(a.fallbackModel, "haiku");
    assert.ok(a.modelFallbackReason === null || a.modelFallbackReason === "out-of-credits");
  });

  test("a garbled primaryModel / nudgeLastAt falls back to the env default (200, never 400)", async () => {
    const res = await get({ primaryModel: "bad model!", fallbackModel: ["x", "y"], nudgeLastAt: "-5" });
    assert.equal(res._status, 200);
    assert.equal(res._body.admission.primaryModel, process.env.HYDRA_AUTOPILOT_PRIMARY_MODEL || "fable");
    assert.equal(res._body.admission.fallbackModel, process.env.HYDRA_AUTOPILOT_FALLBACK_MODEL || "opus");
    const parsed = EligibilityQuerySchema.parse({ primaryModel: "bad model!", nudgeLastAt: "-5" });
    assert.equal(parsed.primaryModel, undefined);
    assert.equal(parsed.nudgeLastAt, undefined);
  });
});
