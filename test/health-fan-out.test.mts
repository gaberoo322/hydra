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

import { collectProbeInputs, type CollectProbeDeps } from "../src/health/fan-out.ts";

// A fully-stubbed dep set: every probe resolves to a recognizable value so the
// test can assert the positional-to-named mapping end-to-end. Callers override
// individual fields to exercise the degradation path.
function happyDeps(overrides: Partial<CollectProbeDeps> = {}): CollectProbeDeps {
  return {
    pingRedis: async () => true,
    killFileExists: () => false,
    schedulerStatus: (async () => ({ running: true, consecutiveErrors: 2 })) as any,
    // Issue #3459: workQueueLen + backlogCounts removed (stubs retired with ADR-0031).
    metricsTrend: (async () => []) as any,
    aggregateStats: (async () => ({})) as any,
    disk: (async () => ({ ok: true, data: { availableGb: 50, totalGb: 500, usedPercent: 10 } })) as any,
    mem: (async () => ({ ok: true, data: { totalGb: 32, availableGb: 20, usedPercent: 38 } })) as any,
    serviceStatus: (async (name: string) => ({ ok: true, data: name === "hydra-betting-web.service" ? "inactive" : "active" })) as any,
    memoryPatterns: (async (role: string) =>
      JSON.stringify(role === "planner" ? [1, 2, 3, 4, 5] : role === "executor" ? [1, 2, 3] : [1])) as any,
    reflectionKeys: (async () => 12) as any,
    emergencyBrake: (async () => ({ engaged: true, since: 1234 })) as any,
    redisInfoImpl: (async (section: string) =>
      section === "memory" ? "used_memory_human:512M\r\n"
      : section === "clients" ? "connected_clients:3\r\n"
      : "uptime_in_seconds:900\r\n") as any,
    // Issue #2805: stub the dark-outcome check so collectProbeInputs' merged
    // darkOutcomes is deterministic (no dependency on the real outcomes.yaml or
    // metric files). One dark verdict so the merge is observable.
    darkOutcomesEval: (async () => ({
      darkOutcomes: ["forecast-calibration-brier"],
      staleOutcomes: [],
      outcomeVerdicts: [
        {
          name: "forecast-calibration-brier",
          kind: "leading",
          status: "dark",
          query: "metrics/forecast-calibration-brier.txt",
          producerHint: "producer must write metrics/forecast-calibration-brier.txt",
        },
      ],
    })) as any,
    // Issue #3270: stub the attribution ledger LLEN probe so the fan-out never
    // hits real Redis in tests. A non-zero count (7) makes the merge observable.
    attributionLedgerLen: (async () => 7) as any,
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

    // The `serviceProbes` descriptor was removed with OpenViking — every
    // service it probed (vikingdb / openviking / embed-backend) was OV.
    assert.equal((probes as any).serviceProbes, undefined);

    // Direct probe values.
    // Issue #3459: queueDepth + backlogCounts removed from ProbeInputs.
    assert.equal((probes.scheduler as any)?.consecutiveErrors, 2);
    assert.deepEqual(probes.patterns, { planner: 5, executor: 3, skeptic: 1 });
    assert.equal(probes.reflections, 12);
    assert.equal((probes.emergencyBrake as any)?.engaged, true);

    // indices 7,8 — host-probe success unwraps `.data`.
    assert.deepEqual(probes.disk, { availableGb: 50, totalGb: 500, usedPercent: 10 });
    assert.deepEqual(probes.mem, { totalGb: 32, availableGb: 20, usedPercent: 38 });

    // indices 9,10,11 — service-status; targetServiceName routes index 11.
    assert.equal(probes.sysdOrchestrator, "active");
    assert.equal(probes.sysdWatchdog, "active");
    assert.equal(probes.sysdTargetWeb, "inactive");

    // redis INFO snapshot parse.
    assert.equal((probes.redisInfo as any)?.memoryHuman, "512M");
    assert.equal((probes.redisInfo as any)?.connectedClients, 3);

    // Issue #2805 — the dark-outcome verdicts (a direct never-throw read) are
    // merged onto the named record by collectProbeInputs.
    assert.equal((probes.darkOutcomes as any)?.length, 1);
    assert.equal((probes.darkOutcomes as any)?.[0]?.status, "dark");
    assert.equal((probes.darkOutcomes as any)?.[0]?.name, "forecast-calibration-brier");

    // Issue #3270 — the attribution ledger LLEN (an async settle-array probe).
    assert.equal(probes.attributionLedgerCount, 7);
  });

  test("empty attribution ledger (count 0) flows into attributionLedgerCount (issue #3270)", async () => {
    const probes = await collectProbeInputs(happyDeps({
      attributionLedgerLen: (async () => 0) as any,
    }));
    assert.equal(probes.attributionLedgerCount, 0);
  });

  // Issue #3544: the "a down VLM host flows into ollamaVlm (#2278)" test was
  // removed with the ollamaVlm probe at the VLM cutover.

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

  // Issue #3459: workQueueLen + backlogCounts probes removed. Coalesce-to-null
  // test now uses reflections (another async probe) to verify the guarantee.
  test("a throwing probe rejects its settle and coalesces that field to null without blocking others", async () => {
    const probes = await collectProbeInputs(happyDeps({
      reflectionKeys: (async () => { throw new Error("redis down"); }) as any,
    }));
    // The throwing probe coalesces to null...
    assert.equal(probes.reflections, null);
    // ...while every other probe still resolves (no one slow/failing probe
    // blocks the fan-out — the Promise.allSettled guarantee).
    assert.equal(probes.basicHealth?.status, "ok");
    assert.equal((probes.emergencyBrake as any)?.engaged, true);
  });

  // Issue #3372: the unified registry's `inline` descriptor variant. Each of the
  // in-process read (darkOutcomes async #2805) runs
  // inside a per-descriptor try/catch that yields its SEMANTIC honest-none
  // `fallback` on error — NOT raw null, never propagating, and never blocking the
  // async settle-array fan-out. This is the invariant the descriptor-union
  // refactor introduces; these reads previously had no error-path coverage in
  // this suite.
  test("a throwing inline read folds to its semantic honest-none fallback without blocking the async fan-out (issue #3372)", async () => {
    const probes = await collectProbeInputs(happyDeps({
      // The async inline read rejects.
      darkOutcomesEval: (async () => { throw new Error("outcomes.yaml unreadable"); }) as any,
    }));

    // darkOutcomes folds to [] (the dark-outcome rule no-ops), NOT null.
    assert.deepEqual(probes.darkOutcomes, []);

    // ...and every async settle-array probe still resolved (no inline failure
    // blocked the fan-out — the Promise.allSettled guarantee is intact).
    // Issue #3459: queueDepth + backlogCounts removed from ProbeInputs.
    assert.equal(probes.basicHealth?.status, "ok");
    assert.equal((probes.emergencyBrake as any)?.engaged, true);
  });
});

// Issue #3626's `serviceProbes` pure-enumerator suite was removed with
// OpenViking: the descriptor it pinned (and the Wake-on-LAN recovery step whose
// absence it asserted) both went with the OV stack.
