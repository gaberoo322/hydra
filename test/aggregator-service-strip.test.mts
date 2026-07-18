/**
 * Regression tests for the service-strip aggregator (issue #618).
 *
 * Covers:
 *   - pure classifiers: classifyBoolean, classifyProbe (ok / degraded / down)
 *   - happy path: all six services up
 *   - degraded latency (probe ok but >=1000ms)
 *   - down state for orchestrator + vendor probes
 *   - sub-source failure isolation (a probe throws → row still renders)
 *   - issue #2597: the strip is driven by the shared STRIP_PROBE_DESCRIPTORS
 *     enumeration and now includes embed-backend (#2013) + ollamaVlm (#2278)
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

// Issue #2597: the strip now runs six probes; embed-backend + ollamaVlm default
// to real network producers. Inject hermetic stubs (all "up") so the existing
// four-service cases stay offline and deterministic — a case that wants one of
// them down overrides the relevant stub.
const upStubProbes: Pick<ServiceStripDeps, "probeEmbedBackend" | "probeOllamaVlm"> = {
  probeEmbedBackend: async () => ({ status: "running", latencyMs: 42 }),
  probeOllamaVlm: async () => ({ status: "ok", latencyMs: 42 }),
};

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
      service: "vikingdb",
      result: fulfilled<ProbeResult>({ ok: true, latencyMs: 150 }),
      lastChecked: "ts",
    });
    assert.equal(row.status, "ok");
    assert.equal(row.latencyMs, 150);
    assert.equal(row.lastError, undefined);
  });

  test("ok probe >= 1000ms → degraded", () => {
    const row = classifyProbe({
      service: "openviking",
      result: fulfilled<ProbeResult>({ ok: true, latencyMs: 1500 }),
      lastChecked: "ts",
    });
    assert.equal(row.status, "degraded");
    assert.equal(row.latencyMs, 1500);
    assert.match(row.lastError ?? "", /slow probe/i);
  });

  test("failed probe → down with captured error", () => {
    const row = classifyProbe({
      service: "vikingdb",
      result: fulfilled<ProbeResult>({ ok: false, latencyMs: 99, error: "HTTP 503" }),
      lastChecked: "ts",
    });
    assert.equal(row.status, "down");
    assert.equal(row.lastError, "HTTP 503");
    assert.equal(row.latencyMs, 99);
  });

  test("rejected probe → down", () => {
    const row = classifyProbe({
      service: "openviking",
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

describe("getServiceStrip — happy path", () => {
  test("all six services up, all ok, in the shared enumeration order", async () => {
    const now = new Date("2026-05-26T12:00:00.000Z");
    const rows = await getServiceStrip({
      now,
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      ...upStubProbes,
    });
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.status, "ok", `expected ${row.service} ok`);
      assert.equal(row.lastChecked, now.toISOString());
    }
    // Order is driven by STRIP_PROBE_DESCRIPTORS (issue #2597) — the strip no
    // longer hard-codes it. Assert the rows match that enumeration exactly.
    assert.deepEqual(
      rows.map((r) => r.service),
      STRIP_PROBE_DESCRIPTORS.map((d) => d.service),
    );
    assert.deepEqual(
      rows.map((r) => r.service),
      ["orchestrator", "redis", "vikingdb", "openviking", "embed-backend", "ollamaVlm"],
    );
  });
});

describe("getServiceStrip — degraded latency", () => {
  test("a slow probe marks the row degraded while others stay ok", async () => {
    const rows = await getServiceStrip({
      probe: async (url) => {
        if (url.includes(":1933")) return { ok: true, latencyMs: 1500 };
        return { ok: true, latencyMs: 80 };
      },
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      ...upStubProbes,
    });
    const ov = rows.find((r) => r.service === "openviking");
    const vdb = rows.find((r) => r.service === "vikingdb");
    assert.equal(ov?.status, "degraded");
    assert.equal(vdb?.status, "ok");
  });
});

describe("getServiceStrip — down state", () => {
  test("orchestrator kill-switch flips orchestrator to down with kill-switch message", async () => {
    const rows = await getServiceStrip({
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => true,
      checkOrchestrator: async () => false,
      ...upStubProbes,
    });
    const orch = rows.find((r) => r.service === "orchestrator");
    assert.equal(orch?.status, "down");
    assert.equal(orch?.lastError, "kill-switch active");
  });

  test("failing vendor probe → vendor row is down, others unaffected", async () => {
    const rows = await getServiceStrip({
      probe: async (url) => {
        if (url.includes(":5000")) return { ok: false, latencyMs: 50, error: "HTTP 503" };
        return { ok: true, latencyMs: 80 };
      },
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      ...upStubProbes,
    });
    const vdb = rows.find((r) => r.service === "vikingdb");
    const ov = rows.find((r) => r.service === "openviking");
    assert.equal(vdb?.status, "down");
    assert.equal(vdb?.lastError, "HTTP 503");
    assert.equal(ov?.status, "ok");
  });

  test("Redis ping fails → redis row is down", async () => {
    const rows = await getServiceStrip({
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => false,
      checkOrchestrator: async () => true,
      ...upStubProbes,
    });
    const redis = rows.find((r) => r.service === "redis");
    assert.equal(redis?.status, "down");
  });

  // Issue #2013/#2597: the embed-backend probe (previously omitted) now renders
  // a row; a `failed` producer result folds to a down row.
  test("embed-backend probe failed → embed-backend row is down", async () => {
    const rows = await getServiceStrip({
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      probeEmbedBackend: async () => ({ status: "failed", latencyMs: null }),
      probeOllamaVlm: async () => ({ status: "ok", latencyMs: 30 }),
    });
    const embed = rows.find((r) => r.service === "embed-backend");
    assert.equal(embed?.status, "down");
    assert.match(embed?.lastError ?? "", /embed backend unreachable/i);
  });

  // Issue #2278/#2597: the ollamaVlm probe (previously omitted) now renders a
  // row; a `down` producer result folds to a down row carrying its error.
  test("ollamaVlm probe down → ollamaVlm row is down with the probe error", async () => {
    const rows = await getServiceStrip({
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      probeEmbedBackend: async () => ({ status: "running", latencyMs: 20 }),
      probeOllamaVlm: async () => ({ status: "down", latencyMs: 5000, error: "fetch timeout" }),
    });
    const vlm = rows.find((r) => r.service === "ollamaVlm");
    assert.equal(vlm?.status, "down");
    assert.equal(vlm?.lastError, "fetch timeout");
  });
});

describe("getServiceStrip — sub-source failure isolation", () => {
  test("probe throws → that row is down; other rows still render", async () => {
    const rows = await getServiceStrip({
      probe: async (url) => {
        if (url.includes(":1933")) throw new Error("network unreachable");
        return { ok: true, latencyMs: 80 };
      },
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      ...upStubProbes,
    });
    assert.equal(rows.length, 6);
    const ov = rows.find((r) => r.service === "openviking");
    const vdb = rows.find((r) => r.service === "vikingdb");
    assert.equal(ov?.status, "down");
    assert.equal(vdb?.status, "ok");
  });

  test("pingRedis throws → redis row is down, never throws out", async () => {
    const rows = await getServiceStrip({
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => {
        throw new Error("ECONNREFUSED");
      },
      checkOrchestrator: async () => true,
      ...upStubProbes,
    });
    const redis = rows.find((r) => r.service === "redis");
    assert.equal(redis?.status, "down");
    assert.equal(redis?.lastError, "ECONNREFUSED");
  });

  // Issue #2597: an added probe whose `run` REJECTS still renders a down row —
  // the strip's Promise.allSettled + shared classifier fold preserves the
  // never-throw contract for the newly-enumerated probes too.
  test("an enumerated probe rejects → its row is down; the strip never throws", async () => {
    const rows = await getServiceStrip({
      probe: async () => ({ ok: true, latencyMs: 80 }),
      pingRedis: async () => true,
      checkOrchestrator: async () => true,
      probeEmbedBackend: async () => {
        throw new Error("boom");
      },
      probeOllamaVlm: async () => ({ status: "ok", latencyMs: 30 }),
    });
    assert.equal(rows.length, 6);
    const embed = rows.find((r) => r.service === "embed-backend");
    assert.equal(embed?.status, "down");
    assert.equal(embed?.lastError, "boom");
  });
});
