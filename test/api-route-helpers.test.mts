/**
 * test/api-route-helpers.test.mts — pin the aggregator-route seam (issue #909).
 *
 * The seam folds two cross-cutting HTTP contracts into one tested surface:
 *   1. validate-or-400: a bad query → 400 `schema-validation-failed` with the
 *      zod issues attached.
 *   2. never-throw-500: a thrown aggregator → a logged 500 `{ error }`, never a
 *      crash (the CLAUDE.md fail-loud rule).
 *
 * These were previously asserted by convention at ~35/21 per-route sites; here
 * they are pinned once, directly against the helper.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  aggregatorRoute,
  aggregatorRouteNoQuery,
  degradeIssueRead,
  isolateAggregator,
  schemaValidationError,
} from "../src/api/route-helpers.ts";

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
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
  };
  return res;
}

/**
 * The never-throw catch now logs through the pino structured-logger seam
 * (module singleton → process.stderr, ADR-0027) instead of a freeform
 * console.error. Capture the serialized JSON lines and assert on the
 * structured `routeLabel`/`msg` fields rather than mocking console.error.
 */
function captureStderr(): {
  lines: () => Record<string, any>[];
  restore: () => void;
} {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  return {
    lines: () =>
      buf
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, any>),
    restore: () => {
      (process.stderr as any).write = originalWrite;
    },
  };
}

const WindowSchema = z
  .object({ window: z.coerce.number().int().min(1).max(30).default(7) })
  .strict();

describe("schemaValidationError", () => {
  test("wraps zod issues in the canonical 400 envelope", () => {
    const parsed = WindowSchema.safeParse({ window: 999 });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      const env = schemaValidationError(parsed.error);
      assert.equal(env.code, "schema-validation-failed");
      assert.ok(Array.isArray(env.issues));
      assert.ok(env.issues.length >= 1);
    }
  });
});

describe("aggregatorRoute — validate half", () => {
  test("bad query → 400 schema-validation-failed with issues", async () => {
    const handler = aggregatorRoute(WindowSchema, "test/route", async () => ({
      ok: true,
    }));
    const res = mockRes();
    await handler(mockReq({ window: 999 }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues));
  });

  test("unknown key (strict) → 400, aggregator never runs", async () => {
    let ran = false;
    const handler = aggregatorRoute(WindowSchema, "test/route", async () => {
      ran = true;
      return { ok: true };
    });
    const res = mockRes();
    await handler(mockReq({ window: 7, bogus: 1 }), res);
    assert.equal(res._status, 400);
    assert.equal(ran, false);
  });

  test("valid query → produce receives parsed data (defaults applied)", async () => {
    let seen: number | null = null;
    const handler = aggregatorRoute(
      WindowSchema,
      "test/route",
      async (data) => {
        seen = data.window;
        return { window: data.window };
      },
    );
    const res = mockRes();
    await handler(mockReq({}), res); // empty → default window=7
    assert.equal(res._status, 200);
    assert.equal(seen, 7);
    assert.deepEqual(res._body, { window: 7 });
  });

  test("coerces stringified numbers (Express query shape)", async () => {
    const handler = aggregatorRoute(
      WindowSchema,
      "test/route",
      async (data) => ({
        window: data.window,
      }),
    );
    const res = mockRes();
    await handler(mockReq({ window: "14" }), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.window, 14);
  });
});

describe("aggregatorRoute — never-throw half", () => {
  test("aggregator throws → logged 500 { error }, no crash", async () => {
    const cap = captureStderr();
    try {
      const handler = aggregatorRoute(WindowSchema, "test/route", async () => {
        throw new Error("aggregator boom");
      });
      const res = mockRes();
      await handler(mockReq({ window: 7 }), res);
      cap.restore();
      assert.equal(res._status, 500);
      assert.equal(res._body.error, "aggregator boom");
      // fail-loud: the catch logged with the route label + canonical literal
      const lines = cap.lines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.routeLabel, "test/route");
      assert.match(String(lines[0]!.msg), /never-throw contract/);
    } finally {
      cap.restore();
    }
  });
});

describe("aggregatorRouteNoQuery", () => {
  test("happy path — produce body JSONed, no parse step", async () => {
    const handler = aggregatorRouteNoQuery("test/noquery", async () => ({
      rows: [1, 2, 3],
    }));
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { rows: [1, 2, 3] });
  });

  test("aggregator throws → logged 500 { error }", async () => {
    const cap = captureStderr();
    try {
      const handler = aggregatorRouteNoQuery("test/noquery", async () => {
        throw new Error("noquery boom");
      });
      const res = mockRes();
      await handler(mockReq(), res);
      cap.restore();
      assert.equal(res._status, 500);
      assert.equal(res._body.error, "noquery boom");
      assert.equal(cap.lines().length, 1);
    } finally {
      cap.restore();
    }
  });
});

describe("isolateAggregator", () => {
  test("non-Error throw stringifies into the 500 body", async () => {
    const cap = captureStderr();
    try {
      const res = mockRes();
      await isolateAggregator(res, "test/iso", async () => {
        throw "string failure";
      });
      cap.restore();
      assert.equal(res._status, 500);
      assert.equal(res._body.error, "string failure");
    } finally {
      cap.restore();
    }
  });
});

/**
 * The degrade-to-flag sibling (issue #4327). Unlike `isolateAggregator`, a
 * failed read here must NEVER become a 500 — the `/autopilot/*` read routes
 * promise a 200 safe default with `degraded:true` / `sourcesOk:false` on ANY
 * read failure. The helper therefore never touches `res` and never throws; it
 * reports failure purely by return value and logs exactly once per failure
 * (the single log site that replaced the two per-route call sites). The
 * per-route response shapes stay pinned in `test/autopilot-board.test.mts` and
 * `test/work-page.test.mts`; this suite pins only the shared contract.
 */
describe("degradeIssueRead — degrade-to-flag (never-throw-200, #4327)", () => {
  test("ok:true read → returned as-is, no log", async () => {
    const cap = captureStderr();
    try {
      const out = await degradeIssueRead("test/degrade", async () => ({
        ok: true as const,
        rows: [1, 2, 3],
      }));
      cap.restore();
      assert.deepEqual(out, { ok: true, rows: [1, 2, 3] });
      assert.equal(cap.lines().length, 0);
    } finally {
      cap.restore();
    }
  });

  test("ok:false read → {ok:false}, exactly one logger.error with routeLabel + code", async () => {
    const cap = captureStderr();
    try {
      const out = await degradeIssueRead("test/degrade", async () => ({
        ok: false as const,
        code: "gh-failed",
      }));
      cap.restore();
      assert.deepEqual(out, { ok: false });
      const lines = cap.lines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.routeLabel, "test/degrade");
      assert.equal(lines[0]!.code, "gh-failed");
      assert.match(String(lines[0]!.msg), /read failed — degraded/);
    } finally {
      cap.restore();
    }
  });

  test("thrown read → {ok:false}, exactly one logger.error, never rethrows", async () => {
    const cap = captureStderr();
    try {
      const out = await degradeIssueRead("test/degrade", async () => {
        throw new Error("read boom");
      });
      cap.restore();
      assert.deepEqual(out, { ok: false });
      const lines = cap.lines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.routeLabel, "test/degrade");
      assert.match(String(lines[0]!.msg), /despite never-throw seam/);
      assert.match(String(lines[0]!.err?.message ?? ""), /read boom/);
    } finally {
      cap.restore();
    }
  });
});
