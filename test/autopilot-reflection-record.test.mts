/**
 * Regression tests for the reflection WRITE-gap fix (issue #1119, Slice 1).
 *
 * Bug: `recordAnchorReflection`/`recordReflection` lost their only live caller
 * when #710 deleted the in-process planner. The per-anchor reflection store has
 * been structurally empty ever since — every `GET /api/reflections?anchor=`
 * returns `count:0`, so a retry of a prior-failure anchor silently loses its
 * own failure context (the #193 retry-correctness invariant). The CONSUMERS
 * (`loadAnchorReflectionsRaw` in anchor scoring, the #841 injection API,
 * retro-bundle's `readAnchorReflections`) were live but starved.
 *
 * Fix (Slice 1): a reap-side reflection PRODUCER —
 *   - `ReflectionRecordBodySchema` (src/autopilot/schemas.ts),
 *   - `POST /autopilot/reflection-record` (src/api/autopilot.ts),
 *   - `recordReflectionOutcome()` never-throws wrapper (src/autopilot/runs.ts),
 *   - `scripts/autopilot/reap.py::_fire_reflection_record` best-effort POST,
 *     fired from `self_heal.append_failure` on a NON-MERGED outcome.
 *
 * These tests pin:
 *   AC1 — producer→consumer round-trip: POST then `loadAnchorReflectionsRaw`
 *         returns a non-empty narrative (the #193 payload).
 *   AC2 — schema rejects an empty anchorRef / a missing outcome with
 *         `code:"schema-validation-failed"`.
 *   AC3 — endpoint 400s on a bad body, 200s + persists on a good one.
 *   AC4 — idempotent-ish on cycleId: re-posting the same cycleId does not grow
 *         the per-anchor reflection ring (the producer's push semantics dedup).
 *
 * Slice 2 (the `reflectionMatchSource` telemetry stamp) is explicitly OUT of
 * scope — these tests grade "a retry now receives a non-empty narrative", NOT
 * the metric label.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanReflections() {
  const keys = await redis.keys("hydra:reflections:*");
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

// ---------------------------------------------------------------------------
// Schema (AC2) — pure, no Redis required.
// ---------------------------------------------------------------------------

describe("ReflectionRecordBodySchema (issue #1119)", () => {
  test("AC2: rejects an empty anchorRef", async () => {
    const { ReflectionRecordBodySchema } = await import("../src/autopilot/schemas.ts");
    const parsed = ReflectionRecordBodySchema.safeParse({
      anchorRef: "",
      outcome: "no-diff",
      reason: "made zero changes",
    });
    assert.equal(parsed.success, false, "empty anchorRef must be rejected");
  });

  test("AC2: rejects a missing outcome", async () => {
    const { ReflectionRecordBodySchema } = await import("../src/autopilot/schemas.ts");
    const parsed = ReflectionRecordBodySchema.safeParse({
      anchorRef: "issue-1119",
      reason: "made zero changes",
    });
    assert.equal(parsed.success, false, "missing outcome must be rejected");
  });

  test("AC2: rejects an unknown field (strict)", async () => {
    const { ReflectionRecordBodySchema } = await import("../src/autopilot/schemas.ts");
    const parsed = ReflectionRecordBodySchema.safeParse({
      anchorRef: "issue-1119",
      outcome: "no-diff",
      reason: "x",
      bogus: true,
    });
    assert.equal(parsed.success, false, "unknown field must be rejected (strict schema)");
  });

  test("AC2: accepts a complete valid body", async () => {
    const { ReflectionRecordBodySchema } = await import("../src/autopilot/schemas.ts");
    const parsed = ReflectionRecordBodySchema.safeParse({
      anchorRef: "issue-1119",
      taskTitle: "Re-wire the reflection producer",
      outcome: "verification-failure",
      reason: "npm test failed on the new endpoint test",
      cycleId: "autopilot-turn-7",
      scopeFiles: ["src/autopilot/runs.ts"],
    });
    assert.equal(parsed.success, true, "complete valid body must parse");
  });
});

// ---------------------------------------------------------------------------
// Endpoint + producer→consumer round-trip (AC1, AC3, AC4).
// ---------------------------------------------------------------------------

describe("POST /api/autopilot/reflection-record (issue #1119)", () => {
  let handler: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanReflections();
    const mod = await import("../src/api/autopilot.ts");
    const router = mod.createAutopilotRouter();
    handler = findHandler(router, "POST", "/autopilot/reflection-record");
    assert.ok(handler, "POST /autopilot/reflection-record handler should exist");
  });

  after(async () => {
    if (redis) {
      await cleanReflections();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  // AC3 — bad body → 400 with schema-validation-failed code, no write.
  test("AC3: malformed body returns 400 schema-validation-failed and writes nothing", async () => {
    const res = mockRes();
    await handler(mockReq({ anchorRef: "", outcome: "no-diff", reason: "x" }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues), "400 carries the zod issues array");

    const keys = await redis.keys("hydra:reflections:*");
    assert.equal(keys.length, 0, "a rejected body must not write any reflection");
  });

  // AC1 + AC3 — good body → 200, persists, and the LIVE consumer reads it.
  test("AC1: a good POST persists a reflection that loadAnchorReflectionsRaw then returns", async () => {
    const anchorRef = "issue-1119-roundtrip";
    const res = mockRes();
    await handler(
      mockReq({
        anchorRef,
        taskTitle: "Re-wire the reflection producer",
        outcome: "verification-failure",
        reason: "npm test failed: endpoint returned 500",
        cycleId: "autopilot-turn-100",
      }),
      res,
    );

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
    assert.equal(res._body.anchorRef, anchorRef);
    assert.equal(res._body.outcome, "verification-failure");

    // The CONSUMER side — the exact reader anchor-scoring + the #841 API use.
    const { loadAnchorReflectionsRaw } = await import("../src/reflections/reflections.ts");
    const reflections = await loadAnchorReflectionsRaw(anchorRef);
    assert.equal(reflections.length, 1, "the live consumer must read the just-written reflection");
    const r = reflections[0];
    assert.equal(r.anchorRef, anchorRef);
    assert.equal(r.outcome, "verification-failure");
    assert.equal(r.taskTitle, "Re-wire the reflection producer");
    assert.match(r.whyItFailed, /npm test failed/);
    assert.ok(r.whatShouldChange.length > 0, "advice narrative must be generated");
  });

  // AC1 — the #841 injection API serves the narrative after the write.
  test("AC1: the #841 injection read returns a non-empty PRIOR ATTEMPTS block after the write", async () => {
    const anchorRef = "issue-1119-injection";
    const res = mockRes();
    await handler(
      mockReq({ anchorRef, outcome: "no-diff", reason: "made zero file changes" }),
      res,
    );
    assert.equal(res._status, 200);

    const { loadAnchorReflections } = await import("../src/reflections/reflections.ts");
    const block = await loadAnchorReflections(anchorRef);
    assert.ok(block.count > 0, "injection block count must be > 0 after a write");
    assert.match(block.content, /PRIOR ATTEMPTS/, "formatted block carries the PRIOR ATTEMPTS header");
  });

  // AC4 — re-posting the same cycleId does not grow the ring (dedup-ish).
  test("AC4: re-posting the same cycleId does not duplicate the per-anchor record", async () => {
    const anchorRef = "issue-1119-idempotent";
    const body = {
      anchorRef,
      outcome: "no-diff",
      reason: "made zero file changes",
      cycleId: "autopilot-turn-200",
    };

    const res1 = mockRes();
    await handler(mockReq(body), res1);
    assert.equal(res1._status, 200);

    const res2 = mockRes();
    await handler(mockReq(body), res2);
    assert.equal(res2._status, 200);

    const { loadAnchorReflectionsRaw } = await import("../src/reflections/reflections.ts");
    const reflections = await loadAnchorReflectionsRaw(anchorRef);
    assert.equal(
      reflections.length,
      1,
      "re-posting the same cycleId must not add a second record for the same anchor",
    );
  });
});

// ---------------------------------------------------------------------------
// recordReflectionOutcome wrapper — never-throws contract (issue #1119).
// ---------------------------------------------------------------------------

describe("recordReflectionOutcome wrapper (issue #1119)", () => {
  test("returns an Err (never throws) on an invalid anchorRef", async () => {
    const { recordReflectionOutcome } = await import("../src/autopilot/runs.ts");
    // The schema normally blocks this, but the wrapper is the never-throw
    // backstop: a whitespace-only anchorRef must yield an Err result object,
    // not a thrown exception.
    const result = await recordReflectionOutcome({
      anchorRef: "   ",
      outcome: "no-diff",
      reason: "x",
    } as any);
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "invalid");
  });
});
