/**
 * Regression tests for the service-strip aggregator (issue #618).
 *
 * Covers:
 *   - pure classifiers: classifyBoolean, classifyProbe (ok / degraded / down)
 *   - happy path: both surviving services up
 *   - down state for orchestrator + redis
 *   - sub-source failure isolation (a read throws → row still renders)
 *   - issue #2597: the strip is driven by the shared STRIP_PROBE_DESCRIPTORS
 *     enumeration.
 *
 * The vikingdb / openviking / embed-backend rows were removed with OpenViking —
 * the strip now reports orchestrator + redis only. `classifyProbe` is retained:
 * it is a generic HTTP-probe classifier and the descriptor set is designed to
 * grow a new probed service without re-adding it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getServiceStrip,
  classifyBoolean,
  classifyProbe,
  type ProbeResult,
  type ServiceStripDeps,
} from "../src/aggregators/service-strip.ts";
import { STRIP_PROBE_DESCRIPTORS } from "../src/health/strip-probes.ts";

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

function fulfilled<T>(value: T): PromiseSettledResult<T> {
  return { status: "fulfilled", value };
}
function rejected<T>(reason: any): PromiseSettledResult<T> {
  return { status: "rejected", reason };
}

describe("classifyBoolean — pure helper", () => {
  test("true → ok", () => {
    const row = classifyBoolean({
      service: "orchestrator",
      result: fulfilled(true),
      lastChecked: "ts",
    });
    assert.equal(row.status, "ok");
    assert.equal(row.lastError, undefined);
  });

  test("false → down with default message", () => {
    const row = classifyBoolean({
      service: "redis",
      result: fulfilled(false),
      lastChecked: "ts",
    });
    assert.equal(row.status, "down");
    assert.match(row.lastError ?? "", /redis is not responding/i);
  });

  test("false → down with the supplied degradedMessage when one is provided", () => {
    const row = classifyBoolean({
      service: "orchestrator",
      result: fulfilled(false),
      lastChecked: "ts",
      degradedMessage: "kill-switch active",
    });
    assert.equal(row.status, "down");
    assert.equal(row.lastError, "kill-switch active");
  });

  test("rejected → down with the rejection reason captured", () => {
    const row = classifyBoolean({
      service: "redis",
      result: rejected(new Error("connection refused")),
      lastChecked: "ts",
    });
    assert.equal(row.status, "down");
    assert.equal(row.lastError, "connection refused");
  });
});

describe("classifyProbe — pure helper", () => {
  test("ok probe under 1000ms → ok", () => {
    const row = classifyProbe({
      service: "some-http-service",
      result: fulfilled<ProbeResult>({ ok: true, latencyMs: 150 }),
      lastChecked: "ts",
    });
    assert.equal(row.status, "ok");
    assert.equal(row.latencyMs, 150);
    assert.equal(row.lastError, undefined);
  });

  test("ok probe >= 1000ms → degraded", () => {
    const row = classifyProbe({
      service: "some-http-service",
      result: fulfilled<ProbeResult>({ ok: true, latencyMs: 1500 }),
      lastChecked: "ts",
    });
    assert.equal(row.status, "degraded");
    assert.equal(row.latencyMs, 1500);
    assert.match(row.lastError ?? "", /slow probe/i);
  });

  test("failed probe → down with captured error", () => {
    const row = classifyProbe({
      service: "some-http-service",
      result: fulfilled<ProbeResult>({ ok: false, latencyMs: 99, error: "HTTP 503" }),
      lastChecked: "ts",
    });
    assert.equal(row.status, "down");
    assert.equal(row.lastError, "HTTP 503");
    assert.equal(row.latencyMs, 99);
  });

  test("rejected probe → down", () => {
    const row = classifyProbe({
      service: "some-http-service",
      result: rejected(new Error("DNS lookup failed")),
      lastChecked: "ts",
    });
    assert.equal(row.status, "down");
    assert.equal(row.lastError, "DNS lookup failed");
  });
});

// ---------------------------------------------------------------------------
// getServiceStrip — integration via deps
// ---------------------------------------------------------------------------

describe("getServiceStrip — integration", () => {
  test("both services up → two ok rows in descriptor order", async () => {
    const now = new Date("2026-05-26T12:00:00.000Z");
    const rows = await getServiceStrip({
      now,
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "ok", `expected ${row.service} ok`);
      assert.equal(row.lastChecked, now.toISOString());
    }
    assert.deepEqual(rows.map((r) => r.service), ["orchestrator", "redis"]);
  });

  test("row order matches STRIP_PROBE_DESCRIPTORS (issue #2597)", async () => {
    const rows = await getServiceStrip({
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
    });
    assert.deepEqual(
      rows.map((r) => r.service),
      STRIP_PROBE_DESCRIPTORS.map((d) => d.service),
      "the strip renders exactly the shared descriptor enumeration, in order",
    );
  });

  test("orchestrator kill-switch → down row with the descriptor's degradedMessage", async () => {
    const rows = await getServiceStrip({
      pingRedis: async () => true,
      checkOrchestrator: async () => false,
    });
    const orch = rows.find((r) => r.service === "orchestrator");
    assert.equal(orch?.status, "down");
    assert.equal(orch?.lastError, "kill-switch active");
  });

  test("redis unreachable → down row", async () => {
    const rows = await getServiceStrip({
      pingRedis: async () => false,
      checkOrchestrator: async () => true,
    });
    const redis = rows.find((r) => r.service === "redis");
    assert.equal(redis?.status, "down");
  });

  test("a throwing read isolates to its own row — the rest still render", async () => {
    const rows = await getServiceStrip({
      pingRedis: async () => { throw new Error("connection refused"); },
      checkOrchestrator: async () => true,
    });
    assert.equal(rows.length, 2);
    const redis = rows.find((r) => r.service === "redis");
    assert.equal(redis?.status, "down");
    assert.equal(redis?.lastError, "connection refused");
    assert.equal(rows.find((r) => r.service === "orchestrator")?.status, "ok");
  });
});
