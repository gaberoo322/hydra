/**
 * Unit tests for the pure Health Assessment Module (issue #840).
 *
 * The ~27 diagnostic rules, the disk/mem regex parsing, the `recent` pipeline
 * derivation, and the status/summary fold used to live inline in the
 * `/api/health/deep` route handler — exercisable only by standing up the full
 * probe fan-out against real Redis (test/api-health.test.mts covers ZERO
 * rules). Extracted into src/health-diagnostics.ts, they are now testable
 * directly: build a HealthSnapshot, run a rule, assert the Diagnostic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseProbes,
  assessHealth,
  type HealthSnapshot,
} from "../src/health-diagnostics.ts";

// ---------------------------------------------------------------------------
// A baseline all-healthy snapshot. Each test clones it and perturbs ONE field
// so a fired diagnostic is unambiguously attributable to that field.
// ---------------------------------------------------------------------------

function healthySnapshot(): HealthSnapshot {
  return {
    health: { status: "ok", redis: true, cycle: "idle", uptime: 3600 },
    sched: {
      running: true,
      cyclesRun: 10,
      cyclesMerged: 8,
      cyclesFailed: 2,
      mergeRate: 80,
      consecutiveErrors: 0,
      lastError: null,
      lastCycleAt: new Date().toISOString(),
    },
    svcProbes: {
      vikingdb: { status: "running" },
      openviking: { status: "running" },
    },
    queueDepth: 3,
    blCounts: { triage: 0, backlog: 2, inProgress: 1, blocked: 0, done: 5, total: 3 },
    patterns: { planner: 4, executor: 6, skeptic: 2 },
    reflCount: 12,
    ovSearch: { status: "running", latencyMs: 40, resultCount: 3 },
    redisInfo: { memoryHuman: "12M", connectedClients: 4, uptimeSeconds: 9999 },
    emergencyBrake: { engaged: false },
    disk: { availableGb: 120, totalGb: 500, usedPercent: 60 },
    mem: { totalGb: 32, availableGb: 20, usedPercent: 40 },
    sysd: { orchestrator: "active", watchdog: "active", targetWeb: "active" },
    recent: {
      cycleCount: 10,
      mergeRate: 80,
      failedRate: 10,
      noTaskRate: 10,
      revertRate: 0,
      mergedN: 8,
      noTaskN: 1,
      revertN: 0,
      avgDurationMs: 45000,
      avgDurationHuman: "45s",
    },
  };
}

function clone(mut: (s: HealthSnapshot) => void): HealthSnapshot {
  const s = healthySnapshot();
  mut(s);
  return s;
}

/** Convenience: find a fired diagnostic by component+severity. */
function find(s: HealthSnapshot, component: string, severity?: string) {
  return assessHealth(s).diagnostics.find(
    (d) => d.component === component && (severity === undefined || d.severity === severity),
  );
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

describe("assessHealth — baseline", () => {
  test("a fully-healthy snapshot fires zero diagnostics and reports healthy", () => {
    const a = assessHealth(healthySnapshot());
    assert.equal(a.diagnostics.length, 0);
    assert.equal(a.status, "healthy");
    assert.equal(
      a.summary,
      "All systems operational. Scheduler running, uptime 1h 0m, 3 queued.",
    );
  });
});

// ---------------------------------------------------------------------------
// Per-rule firing — one snapshot trips exactly one rule
// ---------------------------------------------------------------------------

describe("assessHealth — per-rule firing", () => {
  test("kill switch → critical orchestrator", () => {
    const d = find(clone((s) => (s.health.status = "killed")), "orchestrator", "critical");
    assert.ok(d);
    assert.equal(d!.what, "Kill switch is active");
    assert.equal(d!.autoRecovery, false);
  });

  test("emergency brake engaged → warning autopilot, with engagedBy in why", () => {
    const d = find(
      clone((s) => (s.emergencyBrake = { engaged: true, engagedBy: "gabe" })),
      "autopilot",
      "warning",
    );
    assert.ok(d);
    assert.equal(d!.what, "EMERGENCY BRAKE ENGAGED");
    assert.match(d!.why, /\(gabe\)/);
  });

  test("redis down → critical redis", () => {
    const d = find(clone((s) => (s.health.redis = false)), "redis", "critical");
    assert.ok(d);
    assert.equal(d!.what, "Redis disconnected");
  });

  test("consecutiveErrors >= 5 → error scheduler (auto-stopped)", () => {
    const d = find(
      clone((s) => {
        s.sched.consecutiveErrors = 5;
        s.sched.lastError = "boom";
      }),
      "scheduler",
      "error",
    );
    assert.ok(d);
    assert.match(d!.what, /Auto-stopped after 5 errors/);
    assert.match(d!.why, /boom/);
  });

  test("scheduler stopped with work → error scheduler (stopped but work exists)", () => {
    const d = find(
      clone((s) => {
        s.sched.running = false;
        s.queueDepth = 2;
        s.blCounts.total = 3;
      }),
      "scheduler",
      "error",
    );
    assert.ok(d);
    assert.equal(d!.what, "Stopped but work exists");
  });

  test("consecutiveErrors>=5 takes precedence over stopped-but-work (mutual exclusion)", () => {
    // Both conditions true; the original if/else-if fired only the first.
    const diags = assessHealth(
      clone((s) => {
        s.sched.consecutiveErrors = 6;
        s.sched.running = false;
        s.queueDepth = 5;
        s.blCounts.total = 5;
      }),
    ).diagnostics.filter((d) => d.component === "scheduler" && d.severity === "error");
    assert.equal(diags.length, 1);
    assert.match(diags[0].what, /Auto-stopped/);
  });

  test("disk < 5GB → error disk (critical)", () => {
    const d = find(
      clone((s) => (s.disk = { availableGb: 3, totalGb: 500, usedPercent: 99 })),
      "disk",
      "error",
    );
    assert.ok(d);
    assert.match(d!.what, /Disk critical: 3GB free/);
  });

  test("disk between 5 and 20GB → warning disk (low)", () => {
    const d = find(
      clone((s) => (s.disk = { availableGb: 12, totalGb: 500, usedPercent: 90 })),
      "disk",
      "warning",
    );
    assert.ok(d);
    assert.match(d!.what, /Disk low: 12GB free \(90%\)/);
  });

  test("mem > 95% → error memory (critical)", () => {
    const d = find(
      clone((s) => (s.mem = { totalGb: 32, availableGb: 1, usedPercent: 97 })),
      "memory",
      "error",
    );
    assert.ok(d);
    assert.match(d!.what, /Memory critical/);
  });

  test("mem 85-95% → warning memory (elevated)", () => {
    const d = find(
      clone((s) => (s.mem = { totalGb: 32, availableGb: 3, usedPercent: 90 })),
      "memory",
      "warning",
    );
    assert.ok(d);
    assert.match(d!.what, /Memory elevated: 90%/);
  });

  test("revert rate guard: fires only when mergedN >= 3", () => {
    // High rate but mergedN=2 → no fire (load-bearing guard).
    const noFire = find(
      clone((s) => {
        s.recent.revertRate = 50;
        s.recent.mergedN = 2;
        s.recent.revertN = 1;
      }),
      "pipeline",
      "error",
    );
    assert.equal(noFire, undefined);
    // Same rate, mergedN=3 → fires.
    const d = find(
      clone((s) => {
        s.recent.revertRate = 50;
        s.recent.mergedN = 4;
        s.recent.revertN = 2;
      }),
      "pipeline",
      "error",
    );
    assert.ok(d);
    assert.match(d!.what, /High revert rate: 50%/);
    assert.match(d!.why, /2\/4 merges reverted/);
  });

  test("consecutiveErrors 1-4 → warning scheduler", () => {
    const d = find(
      clone((s) => {
        s.sched.consecutiveErrors = 3;
        s.sched.lastError = "flaky";
      }),
      "scheduler",
      "warning",
    );
    assert.ok(d);
    assert.match(d!.what, /3 consecutive error\(s\)/);
    assert.equal(d!.autoRecovery, true);
  });

  test("openviking failed → warning openviking", () => {
    const d = find(
      clone((s) => (s.svcProbes.openviking = { status: "failed" })),
      "openviking",
      "warning",
    );
    assert.ok(d);
    assert.equal(d!.what, "OpenViking unreachable");
  });

  test("vikingdb failed → warning vikingdb", () => {
    const d = find(
      clone((s) => (s.svcProbes.vikingdb = { status: "failed" })),
      "vikingdb",
      "warning",
    );
    assert.ok(d);
    assert.equal(d!.what, "VikingDB unreachable");
  });

  test("empty pipeline → warning pipeline", () => {
    const d = assessHealth(
      clone((s) => {
        s.queueDepth = 0;
        s.blCounts.total = 0;
        s.health.cycle = "idle";
      }),
    ).diagnostics.find((x) => x.what === "Pipeline empty");
    assert.ok(d);
    assert.equal(d!.severity, "warning");
  });

  test("no-task rate guard: fires only when cycleCount (trend.length) >= 5", () => {
    const noFire = assessHealth(
      clone((s) => {
        s.recent.noTaskRate = 50;
        s.recent.cycleCount = 4;
        s.recent.noTaskN = 2;
      }),
    ).diagnostics.find((x) => x.what?.startsWith("No-task rate"));
    assert.equal(noFire, undefined);
    const d = assessHealth(
      clone((s) => {
        s.recent.noTaskRate = 50;
        s.recent.cycleCount = 6;
        s.recent.noTaskN = 3;
      }),
    ).diagnostics.find((x) => x.what?.startsWith("No-task rate"));
    assert.ok(d);
    assert.match(d!.why, /3\/6 cycles/);
  });

  test("blocked items → warning pipeline", () => {
    const d = assessHealth(clone((s) => (s.blCounts.blocked = 2))).diagnostics.find((x) =>
      x.what?.includes("blocked item"),
    );
    assert.ok(d);
    assert.equal(d!.what, "2 blocked item(s)");
  });

  test("merge rate guard: fires only when cycleCount (trend.length) >= 5", () => {
    const noFire = assessHealth(
      clone((s) => {
        s.recent.mergeRate = 20;
        s.recent.cycleCount = 4;
      }),
    ).diagnostics.find((x) => x.what?.startsWith("Low merge rate"));
    assert.equal(noFire, undefined);
    const d = assessHealth(
      clone((s) => {
        s.recent.mergeRate = 20;
        s.recent.cycleCount = 6;
        s.recent.mergedN = 1;
      }),
    ).diagnostics.find((x) => x.what?.startsWith("Low merge rate"));
    assert.ok(d);
    assert.match(d!.why, /1\/6 merged/);
  });

  test("watchdog inactive → warning infrastructure", () => {
    const d = find(clone((s) => (s.sysd.watchdog = "inactive")), "infrastructure", "warning");
    assert.ok(d);
    assert.equal(d!.what, "Watchdog inactive");
  });

  test("scheduler idle > 15m → info scheduler", () => {
    const d = find(
      clone((s) => {
        s.sched.running = true;
        s.sched.lastCycleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        s.health.cycle = "idle";
      }),
      "scheduler",
      "info",
    );
    assert.ok(d);
    assert.match(d!.what, /Idle \d+m/);
  });

  test("no learned patterns → info intelligence", () => {
    const d = assessHealth(
      clone((s) => (s.patterns = { planner: 0, executor: 0, skeptic: 0 })),
    ).diagnostics.find((x) => x.what === "No learned patterns");
    assert.ok(d);
    assert.equal(d!.severity, "info");
  });

  test("OV search empty → info intelligence", () => {
    const d = assessHealth(
      clone((s) => (s.ovSearch = { status: "running", latencyMs: 10, resultCount: 0 })),
    ).diagnostics.find((x) => x.what === "OV search empty");
    assert.ok(d);
    assert.equal(d!.severity, "info");
  });

  test("OV search failed → warning intelligence (and not the empty info rule)", () => {
    const a = assessHealth(
      clone((s) => (s.ovSearch = { status: "failed", latencyMs: 1471, resultCount: 0 })),
    );
    const failing = a.diagnostics.filter((x) => x.what === "OV search failing");
    assert.equal(failing.length, 1, "exactly one OV-search-failing diagnostic");
    const d = failing[0]!;
    assert.equal(d.severity, "warning");
    assert.equal(d.component, "intelligence");
    assert.equal(d.autoRecovery, false);
    // The failed probe must NOT also fire the empty-index info rule (mutually exclusive).
    assert.ok(
      !a.diagnostics.some((x) => x.what === "OV search empty"),
      "must not fire the empty-index info rule on a failed probe",
    );
    // A warning with no higher-severity diagnostic folds top-level status to degraded.
    assert.equal(a.status, "degraded");
  });
});

// ---------------------------------------------------------------------------
// Status fold ordering: critical > unhealthy(error) > degraded > healthy
// ---------------------------------------------------------------------------

describe("assessHealth — status fold", () => {
  test("any critical → critical (even alongside errors/warnings)", () => {
    const a = assessHealth(
      clone((s) => {
        s.health.redis = false; // critical
        s.mem = { totalGb: 32, availableGb: 1, usedPercent: 97 }; // error
        s.sysd.watchdog = "inactive"; // warning
      }),
    );
    assert.equal(a.status, "critical");
  });

  test("error but no critical → unhealthy", () => {
    const a = assessHealth(
      clone((s) => {
        s.mem = { totalGb: 32, availableGb: 1, usedPercent: 97 }; // error
        s.sysd.watchdog = "inactive"; // warning
      }),
    );
    assert.equal(a.status, "unhealthy");
  });

  test("only warning/info → degraded", () => {
    const a = assessHealth(clone((s) => (s.sysd.watchdog = "inactive")));
    assert.equal(a.status, "degraded");
  });

  test("info only → degraded (any diagnostic demotes from healthy)", () => {
    const a = assessHealth(clone((s) => (s.patterns = { planner: 0, executor: 0, skeptic: 0 })));
    assert.equal(a.status, "degraded");
  });
});

// ---------------------------------------------------------------------------
// Summary strings
// ---------------------------------------------------------------------------

describe("assessHealth — summary", () => {
  test("healthy banner reflects scheduler/uptime/queue", () => {
    // Healthy requires a running scheduler: a stopped scheduler with waiting
    // work trips "Stopped but work exists", and with no work trips "Pipeline
    // empty" — both demote from healthy. So the healthy banner always reads
    // "running".
    const a = assessHealth(
      clone((s) => {
        s.health.uptime = 90; // 1m
        s.queueDepth = 7;
      }),
    );
    assert.equal(a.status, "healthy");
    assert.equal(a.summary, "All systems operational. Scheduler running, uptime 1m, 7 queued.");
  });

  test("non-healthy summary counts severities and quotes first diagnostic", () => {
    const a = assessHealth(
      clone((s) => {
        s.health.redis = false; // critical (1st in rule order after kill/brake)
        s.mem = { totalGb: 32, availableGb: 1, usedPercent: 97 }; // error
        s.sysd.watchdog = "inactive"; // warning
      }),
    );
    // Order: redis critical, memory error, watchdog warning.
    assert.equal(a.summary, "1 critical, 1 error, 1 warning. Redis disconnected");
  });

  test("pluralizes errors/warnings", () => {
    const a = assessHealth(
      clone((s) => {
        s.disk = { availableGb: 3, totalGb: 500, usedPercent: 99 }; // error
        s.mem = { totalGb: 32, availableGb: 1, usedPercent: 97 }; // error
        s.sysd.watchdog = "inactive"; // warning
        s.svcProbes.openviking = { status: "failed" }; // warning
      }),
    );
    assert.match(a.summary, /2 errors, 2 warnings\./);
  });
});

// ---------------------------------------------------------------------------
// parseProbes — disk/mem regex, recent derivation, degraded fallbacks
// ---------------------------------------------------------------------------

describe("parseProbes", () => {
  function settled(values: Record<number, any>) {
    const arr: any[] = [];
    for (let i = 0; i <= 16; i++) {
      if (i in values) arr.push({ status: "fulfilled", value: values[i] });
      else arr.push({ status: "rejected", reason: new Error("probe failed") });
    }
    return arr;
  }

  // Issue #939: the df/free COLUMNAR PARSE moved to the Host-Probe Adapter
  // (src/host-probe/probe.ts — tested in test/host-probe.test.mts via
  // parseDfOutput/parseFreeOutput). parseProbes now receives already-parsed
  // DiskUsage/MemUsage at indices 7/8 and simply passes them through, with the
  // same zeroed default on a probe failure.
  test("passes the already-parsed DiskUsage through (index 7)", () => {
    const disk = { availableGb: 50, totalGb: 500, usedPercent: 90 };
    const snap = parseProbes(settled({ 7: disk }));
    assert.deepEqual(snap.disk, disk);
  });

  test("passes the already-parsed MemUsage through (index 8)", () => {
    const mem = { totalGb: 32, availableGb: 20, usedPercent: 38 };
    const snap = parseProbes(settled({ 8: mem }));
    assert.deepEqual(snap.mem, mem);
  });

  test("disk/mem probe failure (null) → zeros (degraded fallback, no throw)", () => {
    const snap = parseProbes(settled({})); // indices 7/8 rejected → val() null
    assert.deepEqual(snap.disk, { availableGb: 0, totalGb: 0, usedPercent: 0 });
    assert.deepEqual(snap.mem, { totalGb: 0, availableGb: 0, usedPercent: 0 });
  });

  test("derives recent counts and rates from the metrics trend", () => {
    const trend = [
      { tasksMerged: "1", totalDurationMs: "60000" },
      { tasksMerged: "1", totalDurationMs: "120000" },
      { tasksMerged: "0", taskTitle: "Planner produced no task" },
      { tasksMerged: "0", rolledBack: "true", tasksFailed: "1" },
      { tasksMerged: "0", taskTitle: "Skipped: low value" },
    ];
    const snap = parseProbes(settled({ 6: { trend, stats: {} } }));
    assert.equal(snap.recent.cycleCount, 5);
    assert.equal(snap.recent.mergedN, 2);
    assert.equal(snap.recent.noTaskN, 2); // "Planner produced no task" + "Skipped:"
    assert.equal(snap.recent.revertN, 1);
    assert.equal(snap.recent.mergeRate, 40); // 2/5
    assert.equal(snap.recent.noTaskRate, 40); // 2/5
    assert.equal(snap.recent.failedRate, 20); // 1/5
    assert.equal(snap.recent.revertRate, 50); // 1/2 mergedN
    assert.equal(snap.recent.avgDurationMs, 90000); // (60000+120000)/2
    assert.equal(snap.recent.avgDurationHuman, "2m"); // > 60000
  });

  test("empty trend → zero rates, no divide-by-zero", () => {
    const snap = parseProbes(settled({ 6: { trend: [], stats: {} } }));
    assert.equal(snap.recent.cycleCount, 0);
    assert.equal(snap.recent.mergeRate, 0);
    assert.equal(snap.recent.revertRate, 0); // mergedN=0 guard
    assert.equal(snap.recent.avgDurationHuman, "0s");
  });

  test("all probes rejected → safe defaults across the snapshot", () => {
    const snap = parseProbes(settled({}));
    assert.equal(snap.health.status, "failed");
    assert.equal(snap.health.redis, false);
    assert.equal(snap.sched.running, false);
    assert.equal(snap.sched.consecutiveErrors, 0);
    assert.equal(snap.queueDepth, 0);
    assert.equal(snap.blCounts.total, 0);
    assert.deepEqual(snap.patterns, { planner: 0, executor: 0, skeptic: 0 });
    assert.equal(snap.reflCount, 0);
    assert.equal(snap.emergencyBrake.engaged, false); // fail-safe to disengaged
    assert.equal(snap.redisInfo, null);
    assert.equal(snap.sysd.orchestrator, "unknown");
  });

  test("end-to-end: parseProbes → assessHealth on a degraded fan-out", () => {
    // A realistic partial-failure: OV down, watchdog inactive, disk low.
    const snap = parseProbes(
      settled({
        0: { status: "ok", redis: true, cycle: "idle", uptime: 1000 },
        1: { vikingdb: { status: "running" }, openviking: { status: "failed" } },
        2: { running: true, consecutiveErrors: 0, lastCycleAt: new Date().toISOString() },
        4: 2,
        5: { triage: 0, backlog: 1, inProgress: 0, blocked: 0, done: 0, total: 1 },
        6: { trend: [], stats: {} },
        7: { availableGb: 12, totalGb: 500, usedPercent: 90 }, // already-parsed (issue #939) → low
        9: "active",
        10: "inactive", // watchdog
        11: "active",
        12: { planner: 1, executor: 1, skeptic: 1 },
        13: 3,
        14: { status: "running", latencyMs: 10, resultCount: 2 },
        16: { engaged: false },
      }),
    );
    const a = assessHealth(snap);
    assert.equal(a.status, "degraded"); // only warnings
    const components = a.diagnostics.map((d) => d.component);
    assert.ok(components.includes("openviking"));
    assert.ok(components.includes("disk"));
    assert.ok(components.includes("infrastructure"));
  });
});
