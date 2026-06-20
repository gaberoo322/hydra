/**
 * Regression tests for the GET /tier route after issue #2183 moved it from the
 * retired `src/api/misc.ts` catch-all into its own domain Module
 * (`src/api/tier.ts`), next to `src/tier-classifier.ts`.
 *
 * These pin the route-level behaviour that the move must preserve byte-for-byte:
 *   - an ABSENT `files` query param 400s with the legacy error message,
 *   - a present (even empty) `files` param classifies via `classifyChange()`,
 *   - CSV and repeated-param array inputs both normalise to a trimmed file list.
 *
 * Pattern mirrors test/api-scheduler.test.mts — extract the handler from the
 * Router stack and drive it with mock req/res (no Express server, no Redis).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTierRouter } from "../src/api/tier.ts";

function mockReq(overrides: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query: {}, params: {}, body: {}, ...overrides };
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

describe("GET /tier route (issue #2183 — moved out of misc.ts)", () => {
  test("route handler exists on the tier router", () => {
    const router = createTierRouter();
    const handler = findHandler(router, "GET", "/tier");
    assert.ok(handler, "GET /tier handler should exist on createTierRouter()");
  });

  test("400s with the legacy message when `files` is absent", async () => {
    const router = createTierRouter();
    const handler = findHandler(router, "GET", "/tier")!;
    const req = mockReq({ query: {} });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._status, 400);
    assert.equal(res._body.error, "Missing query parameter 'files' (comma-separated)");
  });

  test("classifies a CSV `files` value and returns the classifyChange() shape", async () => {
    const router = createTierRouter();
    const handler = findHandler(router, "GET", "/tier")!;
    const req = mockReq({ query: { files: "src/foo.ts,src/bar.ts" } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    // classifyChange() returns { tier, reason, perFile } — pin the contract the
    // hydra-dev skill reads verbatim.
    assert.equal(typeof res._body.tier, "number");
    assert.equal(typeof res._body.reason, "string");
    assert.ok(Array.isArray(res._body.perFile));
    assert.equal(res._body.perFile.length, 2);
  });

  test("normalises a repeated-param array (?files=a&files=b) into the file list", async () => {
    const router = createTierRouter();
    const handler = findHandler(router, "GET", "/tier")!;
    const req = mockReq({ query: { files: ["src/foo.ts", "src/bar.ts"] } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.perFile.length, 2);
  });

  test("accepts an empty `files` value (classifies the empty change set, no 400)", async () => {
    const router = createTierRouter();
    const handler = findHandler(router, "GET", "/tier")!;
    const req = mockReq({ query: { files: "" } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.perFile, []);
  });
});
