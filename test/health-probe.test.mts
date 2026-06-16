/**
 * Unit tests for the ServiceProbe Adapter Seam (issue #1324, extracted to its
 * own module in issue #1980).
 *
 * The plain-HTTP service probe and the OpenViking liveness probe used to be
 * duplicated as inline closures inside both GET /health/services and the GET
 * /health/deep fan-out — exercisable only by standing up the full Express route
 * + a real network. #1324 hoisted them to module-level probeService()/probeOv()
 * with an injectable fetch/adapter impl; #1980 moved them out of the route file
 * into the focused src/health-probe.ts seam. They are testable directly: stub
 * the dependency, assert the {status, latencyMs} fold.
 *
 * These assert the failed/running/timeout classification and the acceptAny
 * branch WITHOUT Express, without a real fetch, and without a network — the
 * "testable seam" the issue exists to create.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { probeService, probeOv, type ServiceProbeResult } from "../src/health-probe.ts";
import type { OvResult } from "../src/knowledge-base/ov-request.ts";

// ---------------------------------------------------------------------------
// probeService — plain-HTTP probe, classification via injected fetchImpl
// ---------------------------------------------------------------------------

describe("probeService", () => {
  test("2xx response → running with a numeric latency", async () => {
    const fetchImpl = (async () => ({ ok: true }) as Response) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { fetchImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
    assert.ok(r.latencyMs! >= 0);
  });

  test("non-2xx response → failed (acceptAny default false)", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { fetchImpl });
    assert.equal(r.status, "failed");
    // A reached-but-non-2xx port still measured latency (it answered).
    assert.equal(typeof r.latencyMs, "number");
  });

  test("non-2xx response → running when acceptAny is true", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { acceptAny: true, fetchImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("thrown transport error → {failed, latencyMs:null}, never re-throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    let r: ServiceProbeResult;
    await assert.doesNotReject(async () => {
      r = await probeService("http://localhost:5000/health", { fetchImpl });
    });
    assert.equal(r!.status, "failed");
    assert.equal(r!.latencyMs, null);
  });

  test("AbortSignal timeout (TimeoutError) → {failed, latencyMs:null}", async () => {
    const fetchImpl = (async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as typeof globalThis.fetch;
    const r = await probeService("http://localhost:5000/health", { fetchImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });
});

// ---------------------------------------------------------------------------
// probeOv — OpenViking liveness, classification via injected ovHealthGet impl
// ---------------------------------------------------------------------------

describe("probeOv", () => {
  test("adapter ok → running with a numeric latency", async () => {
    const ovHealthGetImpl = (async () => ({ ok: true, data: undefined }) as OvResult<void>);
    const r = await probeOv({ ovHealthGetImpl });
    assert.equal(r.status, "running");
    assert.equal(typeof r.latencyMs, "number");
  });

  test("adapter failure (ov-service-down) → {failed, latencyMs:null}", async () => {
    const ovHealthGetImpl = (async () => ({ ok: false, code: "ov-service-down" }) as OvResult<void>);
    const r = await probeOv({ ovHealthGetImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("adapter timeout (ov-timeout) → {failed, latencyMs:null}", async () => {
    const ovHealthGetImpl = (async () => ({ ok: false, code: "ov-timeout" }) as OvResult<void>);
    const r = await probeOv({ ovHealthGetImpl });
    assert.equal(r.status, "failed");
    assert.equal(r.latencyMs, null);
  });

  test("never re-throws even if the adapter impl rejects is not its contract — adapter never throws", async () => {
    // The OV Request Adapter is contractually never-throwing; probeOv relies on
    // that. This guards the happy/failure mapping covers both arms exhaustively.
    const okR = await probeOv({ ovHealthGetImpl: async () => ({ ok: true, data: undefined }) as OvResult<void> });
    const failR = await probeOv({ ovHealthGetImpl: async () => ({ ok: false, code: "ov-non-2xx" }) as OvResult<void> });
    assert.equal(okR.status, "running");
    assert.equal(failR.status, "failed");
    assert.equal(failR.latencyMs, null);
  });
});
