/**
 * Health Probe Fan-out Module tests (issue #2089).
 *
 * `collectProbeInputs(deps)` runs the 19-probe `Promise.allSettled` fan-out and
 * folds the positional results to a named `ProbeInputs` record. Before this
 * extraction the fan-out lived inside the GET /health/deep route handler, so the
 * full probe pipeline had NO test — it could only be exercised through Express
 * with a live Redis/OpenViking/host. Every probe is now an injectable dependency,
 * so these tests drive the complete pipeline with stubs: a happy path (every
 * probe maps to its named field) and a degradation path (a throwing/rejecting
 * probe coalesces to `null`, never blocking the others).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { collectProbeInputs, type CollectProbeDeps } from "../src/health-fan-out.ts";

// A fully-stubbed dep set: every probe resolves to a recognizable value so the
// test can assert the positional-to-named mapping end-to-end. Callers override
// individual fields to exercise the degradation path.
function happyDeps(overrides: Partial<CollectProbeDeps> = {}): CollectProbeDeps {
  return {
    pingRedis: async () => true,
    killFileExists: () => false,
    schedulerStatus: (async () => ({ running: true, consecutiveErrors: 2 })) as any,
    workQueueLen: (async () => 7) as any,
    backlogCounts: (async () => ({ triage: 1, backlog: 2, inProgress: 0, blocked: 0, done: 0, total: 3 })) as any,
    metricsTrend: (async () => []) as any,
    aggregateStats: (async () => ({})) as any,
    disk: (async () => ({ ok: true, data: { availableGb: 50, totalGb: 500, usedPercent: 10 } })) as any,
    mem: (async () => ({ ok: true, data: { totalGb: 32, availableGb: 20, usedPercent: 38 } })) as any,
    serviceStatus: (async (name: string) => ({ ok: true, data: name === "hydra-betting-web.service" ? "inactive" : "active" })) as any,
    memoryPatterns: (async (role: string) =>
      JSON.stringify(role === "planner" ? [1, 2, 3, 4, 5] : role === "executor" ? [1, 2, 3] : [1])) as any,
    reflectionKeys: (async () => 12) as any,
    emergencyBrake: (async () => ({ engaged: true, since: 1234 })) as any,
    ovSearchWindow: (async () => [{ hour: 0, count: 5 }]) as any,
    knowledgeContextAvailability: (async () => ({ available: 0.95 })) as any,
    redisInfoImpl: (async (section: string) =>
      section === "memory" ? "used_memory_human:512M\r\n"
      : section === "clients" ? "connected_clients:3\r\n"
      : "uptime_in_seconds:900\r\n") as any,
    ovPostJsonImpl: (async () => ({ ok: true, data: { result: { memories: [1, 2], resources: [1], skills: [1] } } })) as any,
    probeServiceImpl: (async () => ({ status: "running", latencyMs: 5 })) as any,
    probeOvImpl: (async () => ({ status: "running", latencyMs: 6 })) as any,
    probeEmbedBackendImpl: (async () => ({ status: "running", latencyMs: 7 })) as any,
    targetServiceName: () => "hydra-betting-web.service",
    ...overrides,
  };
}

describe("collectProbeInputs — full fan-out pipeline (issue #2089)", () => {
  test("happy path: every probe maps to its named ProbeInputs field", async () => {
    const probes = await collectProbeInputs(happyDeps());

    // index 0 — basic health: pingRedis() boolean + kill-file + idle cycle.
    assert.equal(probes.basicHealth?.status, "ok");
    assert.equal(probes.basicHealth?.redis, true);
    assert.equal(probes.basicHealth?.cycle, "idle");
    assert.equal(typeof probes.basicHealth?.uptime, "number");

    // index 1 — service probes folded to the keyed svcProbes map.
    assert.equal((probes.serviceProbes as any)?.vikingdb?.status, "running");
    assert.equal((probes.serviceProbes as any)?.openviking?.status, "running");
    assert.equal((probes.serviceProbes as any)?.["embed-backend"]?.status, "running");

    // indices 2,4,5,12,13,16,17,18 — direct probe values.
    assert.equal((probes.scheduler as any)?.consecutiveErrors, 2);
    assert.equal(probes.queueDepth, 7);
    assert.equal((probes.backlogCounts as any)?.total, 3);
    assert.deepEqual(probes.patterns, { planner: 5, executor: 3, skeptic: 1 });
    assert.equal(probes.reflections, 12);
    assert.equal((probes.emergencyBrake as any)?.engaged, true);
    assert.deepEqual(probes.ovSearchWindow, [{ hour: 0, count: 5 }]);
    assert.deepEqual(probes.knowledgeContext, { available: 0.95 });

    // indices 7,8 — host-probe success unwraps `.data`.
    assert.deepEqual(probes.disk, { availableGb: 50, totalGb: 500, usedPercent: 10 });
    assert.deepEqual(probes.mem, { totalGb: 32, availableGb: 20, usedPercent: 38 });

    // indices 9,10,11 — service-status; targetServiceName routes index 11.
    assert.equal(probes.sysdOrchestrator, "active");
    assert.equal(probes.sysdWatchdog, "active");
    assert.equal(probes.sysdTargetWeb, "inactive");

    // index 14 — OV-search classifier folds 200 + bodies to running w/ count.
    assert.equal((probes.ovSearch as any)?.status, "running");
    assert.equal((probes.ovSearch as any)?.resultCount, 4);

    // index 15 — redis INFO snapshot parse.
    assert.equal((probes.redisInfo as any)?.memoryHuman, "512M");
    assert.equal((probes.redisInfo as any)?.connectedClients, 3);
  });

  test("pingRedis=false flows into basicHealth.redis", async () => {
    const probes = await collectProbeInputs(happyDeps({ pingRedis: async () => false }));
    assert.equal(probes.basicHealth?.redis, false);
    assert.equal(probes.basicHealth?.status, "ok");
  });

  test("kill-file present sets basicHealth.status to killed", async () => {
    const probes = await collectProbeInputs(happyDeps({ killFileExists: () => true }));
    assert.equal(probes.basicHealth?.status, "killed");
  });

  test("host-probe failure coalesces disk/mem/sysd to the sentinel shape", async () => {
    const probes = await collectProbeInputs(happyDeps({
      disk: (async () => ({ ok: false, code: "probe-timeout" })) as any,
      mem: (async () => ({ ok: false, code: "probe-failed" })) as any,
      serviceStatus: (async () => ({ ok: false, code: "probe-failed" })) as any,
    }));
    // isProbeFailure → null for disk/mem, "unknown" for service-status.
    assert.equal(probes.disk, null);
    assert.equal(probes.mem, null);
    assert.equal(probes.sysdOrchestrator, "unknown");
    assert.equal(probes.sysdWatchdog, "unknown");
    assert.equal(probes.sysdTargetWeb, "unknown");
  });

  test("a throwing probe rejects its settle and coalesces that field to null without blocking others", async () => {
    const probes = await collectProbeInputs(happyDeps({
      workQueueLen: (async () => { throw new Error("redis down"); }) as any,
      reflectionKeys: (async () => { throw new Error("redis down"); }) as any,
    }));
    // The two throwing probes coalesce to null...
    assert.equal(probes.queueDepth, null);
    assert.equal(probes.reflections, null);
    // ...while every other probe still resolves (no one slow/failing probe
    // blocks the fan-out — the Promise.allSettled guarantee).
    assert.equal(probes.basicHealth?.status, "ok");
    assert.equal((probes.backlogCounts as any)?.total, 3);
    assert.equal((probes.emergencyBrake as any)?.engaged, true);
  });

  test("OV-search transport failure folds to backend-unreachable (the classifier path)", async () => {
    const probes = await collectProbeInputs(happyDeps({
      ovPostJsonImpl: (async () => ({ ok: false, code: "ov-service-down" })) as any,
    }));
    assert.equal((probes.ovSearch as any)?.status, "backend-unreachable");
    assert.equal((probes.ovSearch as any)?.latencyMs, null);
  });
});
