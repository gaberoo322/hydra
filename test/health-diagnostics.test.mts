/**
 * Unit tests for the pure Health Assessment Module (issue #840).
 *
 * The ~27 diagnostic rules, the disk/mem regex parsing, the `recent` pipeline
 * derivation, and the status/summary fold used to live inline in the
 * `/api/health/deep` route handler — exercisable only by standing up the full
 * probe fan-out against real Redis (test/api-health.test.mts covers ZERO
 * rules). Extracted into src/health/diagnostics.ts, they are now testable
 * directly: build a HealthSnapshot, run a rule, assert the Diagnostic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseProbes,
  derivePipelineMetrics,
  assessHealth,
  parseRedisInfoSnapshot,
  type HealthSnapshot,
  type ProbeInputs,
} from "../src/health/diagnostics.ts";
// Issue #2039: the wire projection split out to src/health/wire.ts (the
// data-OUT leg). The parse-pipeline tests above import only from the parse seam;
// this projection-specific suite imports the projection from its new home.
import { projectHealthDeepResponse } from "../src/health/wire.ts";
// Issue #3393: assembleProbeInputs (the pure settled-record → ProbeInputs mapping)
// now lives in the type-vocabulary leaf (src/health/types.ts), co-located with the
// ProbeInputs type it populates — it moved out of the fan-out I/O coordinator
// (src/health/fan-out.ts, its #2089 home) so the pure mapping is unit-testable from
// a SettledByKey fixture without touching the async fan-out.
import { assembleProbeInputs } from "../src/health/types.ts";
// Issue #2131: the ServiceProbe Adapter Seam — drive the embed-backend probe
// end-to-end (probe → rule fold) via its injected `ovPostJsonImpl` seam, no network.
import { probeEmbedBackend } from "../src/health/probe.ts";

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
    // Issue #3459: queueDepth + blCounts removed from HealthSnapshot.
    patterns: { planner: 4, executor: 6, skeptic: 2 },
    reflCount: 12,
    // Issue #3270: a non-zero ledger count — the attribution-ledger-dark rule
    // fires ONLY when count === 0, so any positive value keeps the baseline
    // "fires zero diagnostics" assertion holding.
    attributionLedgerCount: 14,
    // Issue #2492: a `healthy` reflection-deposit verdict — the reflection rule
    // fires ONLY on `served-but-bucketed-none`, so this keeps the baseline
    // "fires zero diagnostics" assertion holding while exercising the field.
    reflectionHealth: {
      sampleSize: 20,
      distribution: { both: 5, none: 15 },
      reflectionSourcesPresent: 5,
      verdict: "healthy",
      note: "Reflection context reached 5/20 recent cycles; deposit plumbing is live.",
    },
    // Issue #2386: a fully-registered skill catalog — both skill-catalog rules
    // (assessSkillCatalog / assessRegistrationFailureRate) no-op, so the baseline
    // "fully-healthy snapshot fires zero diagnostics" assertion holds.
    skillCatalog: {
      skills: [],
      registered: 4,
      total: 4,
      completed: true,
      lastAttemptAt: Date.now(),
      vlmDeferred: false,
      skillsDeferred: false,
    },
    // Issue #2805: no dark leading outcomes by default — the dark-outcome rule
    // fires ONLY when at least one verdict has status "dark", so an empty array
    // keeps the baseline "fires zero diagnostics" assertion holding.
    darkOutcomes: [],
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
    // Issue #3459: queueDepth removed from healthy summary (always 0 after ADR-0031).
    assert.equal(
      a.summary,
      "All systems operational. Scheduler running, uptime 1h 0m.",
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

  // Issue #3459: "Stopped but work exists" rule removed — gated on queueDepth/blCounts
  // which were always 0 after ADR-0031. Flipped to assert the rule does NOT fire.
  test("scheduler stopped with consecutiveErrors<5 and no errors → no scheduler error (issue #3459)", () => {
    const d = find(
      clone((s) => {
        s.sched.running = false;
        s.sched.consecutiveErrors = 0;
      }),
      "scheduler",
      "error",
    );
    // The old "Stopped but work exists" rule is gone; a stopped-but-no-errors
    // scheduler with no consecutive error count fires no scheduler error.
    assert.equal(d, undefined);
  });

  test("consecutiveErrors>=5 still fires auto-stopped (the queueDepth branch is removed, not the error-count branch)", () => {
    const diags = assessHealth(
      clone((s) => {
        s.sched.consecutiveErrors = 6;
        s.sched.running = false;
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

  // Issue #2131: the embed-backend failed state now fires a BESPOKE warning that
  // names the offline embedding/VLM backend and points at the Wake-on-LAN
  // recovery path (#1794) — promoted from the generic #2013 "external service
  // not running" message so the 2026-06-18 silent-info gap escalates loudly.
  test("embed-backend failed → bespoke 'Embedding/VLM backend unreachable' warning naming the backend + recovery path", () => {
    const d = find(
      clone((s) => (s.svcProbes["embed-backend"] = { status: "failed" })),
      "embed-backend",
      "warning",
    );
    assert.ok(d);
    assert.equal(d!.what, "Embedding/VLM backend unreachable");
    // Names the offline backend (gaming-PC Ollama over Tailscale) …
    assert.match(d!.why, /gaming-PC Ollama|gabes-desktop-1/);
    // … and points at the #1794 Wake-on-LAN recovery path.
    assert.match(d!.action, /1794|Wake-on-LAN/);
  });

  test("embed-backend running → bespoke rule does NOT fire (slow-but-reachable stays quiet)", () => {
    const d = find(
      clone((s) => (s.svcProbes["embed-backend"] = { status: "running" })),
      "embed-backend",
    );
    assert.equal(d, undefined);
  });

  test("embed-backend failed is reported by its bespoke rule only — the generic iterator does not double-report it", () => {
    const diags = assessHealth(
      clone((s) => (s.svcProbes["embed-backend"] = { status: "failed" })),
    ).diagnostics.filter((x) => x.component === "embed-backend");
    assert.equal(diags.length, 1);
    assert.equal(diags[0].what, "Embedding/VLM backend unreachable");
  });

  // Issue #2131 acceptance: drive the embed-backend probe end-to-end via the
  // injected `probeEmbedBackend({ ovPostJsonImpl })` seam (no real network) and
  // assert the rule fold — proving an UNREACHABLE backend escalates to an
  // operator-visible warning while a SLOW-but-reachable plane stays the benign
  // `info` "OV search slow". This closes the 2026-06-18 silent-info gap: the
  // same root condition (offline gaming-PC Ollama) must not read as informational.
  describe("embed-backend probe → rule, driven via the injected ovPostJson seam (#2131)", () => {
    // The two branches: ov-service-down/ov-timeout on the embedding-exercising
    // search transport fold the probe to "failed"; OV answering (2xx) → "running".
    async function snapshotFromProbe(
      ovPostJsonImpl: (...a: any[]) => Promise<any>,
      ovSearch?: HealthSnapshot["ovSearch"],
    ): Promise<HealthSnapshot> {
      const embedBackend = await probeEmbedBackend({ ovPostJsonImpl: ovPostJsonImpl as any });
      return clone((s) => {
        s.svcProbes["embed-backend"] = embedBackend;
        if (ovSearch) s.ovSearch = ovSearch;
      });
    }

    test("UNREACHABLE backend (ov-service-down) → operator-visible warning, NOT info", async () => {
      const snap = await snapshotFromProbe(
        async () => ({ ok: false, code: "ov-service-down" }),
        // The offline backend also drives the through-OV search to timeout →
        // "timeout" (the historical false-info path). The bespoke warning must
        // still escalate despite that info rule also firing.
        { status: "timeout", latencyMs: 14200, resultCount: 0 },
      );
      const a = assessHealth(snap);
      const alert = a.diagnostics.find((d) => d.component === "embed-backend");
      assert.ok(alert, "embed-backend must fire a diagnostic when unreachable");
      assert.equal(alert!.severity, "warning");
      assert.equal(alert!.what, "Embedding/VLM backend unreachable");
      // It is a NON-info, operator-visible signal — the top-level fold is at
      // least `degraded` (a warning is never `healthy`/info-only).
      assert.notEqual(a.status, "healthy");
      // The probe folded to failed (the seam, exercised without a network).
      assert.equal(snap.svcProbes["embed-backend"].status, "failed");
    });

    test("UNREACHABLE backend (ov-timeout on the embed transport) → warning", async () => {
      const snap = await snapshotFromProbe(async () => ({ ok: false, code: "ov-timeout" }));
      const alert = assessHealth(snap).diagnostics.find((d) => d.component === "embed-backend");
      assert.ok(alert);
      assert.equal(alert!.severity, "warning");
    });

    test("REACHABLE-but-slow plane (OV answers 2xx) → embed-backend stays quiet; only the existing info 'OV search slow' fires", async () => {
      const snap = await snapshotFromProbe(
        // OV answered (2xx) → probe reads "running"; the embedding path is slow,
        // which the SEPARATE ovSearch probe reports as "timeout" → info.
        async () => ({ ok: true, data: { result: { memories: [], resources: [], skills: [] } } }),
        { status: "timeout", latencyMs: 14200, resultCount: 0 },
      );
      const a = assessHealth(snap);
      // No embed-backend alert — a slow-but-reachable backend is not down.
      assert.equal(
        a.diagnostics.some((d) => d.component === "embed-backend"),
        false,
        "a reachable (slow) backend must NOT raise the embed-backend alert",
      );
      assert.equal(snap.svcProbes["embed-backend"].status, "running");
      // The benign slow-plane info signal is unchanged.
      const slow = a.diagnostics.find((d) => d.what === "OV search slow");
      assert.ok(slow, "the slow plane still surfaces the existing info signal");
      assert.equal(slow!.severity, "info");
    });
  });

  test("openviking failed is reported by its bespoke rule only — the generic rule does not double-report it", () => {
    const diags = assessHealth(
      clone((s) => (s.svcProbes.openviking = { status: "failed" })),
    ).diagnostics.filter((x) => x.component === "openviking");
    assert.equal(diags.length, 1);
    assert.equal(diags[0].what, "OpenViking unreachable");
  });

  // Issue #3459: "Pipeline empty" rule removed — gated on queueDepth/blCounts,
  // always 0 after ADR-0031. Flipped to assert the rule no longer fires.
  test("pipeline empty no longer fires a diagnostic (issue #3459)", () => {
    const d = assessHealth(
      clone((s) => {
        s.health.cycle = "idle";
      }),
    ).diagnostics.find((x) => x.what === "Pipeline empty");
    assert.equal(d, undefined);
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

  // Issue #3459: "Blocked items" rule removed — gated on blCounts.blocked,
  // always 0 after ADR-0031. Flipped to assert the rule no longer fires.
  test("blCounts.blocked no longer fires a blocked-items diagnostic (issue #3459)", () => {
    // HealthSnapshot no longer carries blCounts, so the diagnostic cannot fire.
    const d = assessHealth(healthySnapshot()).diagnostics.find((x) =>
      x.what?.includes("blocked item"),
    );
    assert.equal(d, undefined);
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

  // Issue #1032: a probe TIMEOUT is the Ollama-backed embedding path being slow,
  // NOT a fault. It must surface as info ("OV search slow"), must NOT fire the
  // hard-failure warning, and (being info, not warning) must not drive the
  // top-level status to a WARNING-grade degradation the way `failed` does.
  test("OV search timeout → info intelligence, NOT the failing warning", () => {
    const a = assessHealth(
      clone((s) => (s.ovSearch = { status: "timeout", latencyMs: 14200, resultCount: 0 })),
    );
    const slow = a.diagnostics.filter((x) => x.what === "OV search slow");
    assert.equal(slow.length, 1, "exactly one OV-search-slow diagnostic");
    assert.equal(slow[0]!.severity, "info");
    assert.equal(slow[0]!.component, "intelligence");
    assert.equal(slow[0]!.autoRecovery, true);
    // A timeout must NOT fire the hard-failure warning rule…
    assert.ok(
      !a.diagnostics.some((x) => x.what === "OV search failing"),
      "timeout must not fire the OV-search-failing warning",
    );
    // …nor the empty-index info rule (that one keys off status === 'running').
    assert.ok(
      !a.diagnostics.some((x) => x.what === "OV search empty"),
      "timeout must not fire the empty-index info rule",
    );
    // The timeout firing is info-only — there is no WARNING-or-worse diagnostic
    // attributable to the slow probe (the `failed` path produces a warning).
    assert.ok(
      !a.diagnostics.some(
        (x) => x.component === "intelligence" && x.severity !== "info",
      ),
      "a slow probe must not contribute any warning/error intelligence diagnostic",
    );
  });

  // Issue #1781: a transport failure on the search path surfaces as a DISTINCT
  // "OV embedding backend unreachable" warning — not the generic "OV search
  // failing" 5xx warning — so the operator is pointed at the embedding backend
  // host rather than at OpenViking itself. This is the indistinguishability the
  // issue exists to fix.
  test("OV search backend-unreachable → distinct warning, NOT the 5xx failing warning", () => {
    const a = assessHealth(
      clone((s) => (s.ovSearch = { status: "backend-unreachable", latencyMs: null, resultCount: 0 })),
    );
    const unreachable = a.diagnostics.filter((x) => x.what === "OV embedding backend unreachable");
    assert.equal(unreachable.length, 1, "exactly one backend-unreachable diagnostic");
    const d = unreachable[0]!;
    assert.equal(d.severity, "warning");
    assert.equal(d.component, "intelligence");
    // It must NOT collapse into the OV-5xx warning — distinguishing the two is the point of #1781.
    assert.ok(
      !a.diagnostics.some((x) => x.what === "OV search failing"),
      "backend-unreachable must not fire the generic OV-search-failing 5xx warning",
    );
    // …nor the empty-index info rule (that keys off status === 'running')…
    assert.ok(
      !a.diagnostics.some((x) => x.what === "OV search empty"),
      "backend-unreachable must not fire the empty-index info rule",
    );
    // …nor the slow/timeout info rule.
    assert.ok(
      !a.diagnostics.some((x) => x.what === "OV search slow"),
      "backend-unreachable must not fire the timeout info rule",
    );
    // The action names a concrete reachability probe so the operator can check the right hop.
    assert.ok(/ollama-embed|gabes-desktop-1/.test(d.action), "action names the backend host to probe");
    // A lone warning folds the top-level status to degraded (not unhealthy/critical).
    assert.equal(a.status, "degraded");
  });
});

// ---------------------------------------------------------------------------
// Reflection-deposit-health deep-health rule (issue #2492)
//
// The recurring #1912→#2450→#2467→#2492 re-file loop misreads a flat 100%-`none`
// reflectionMatchSource distribution as a broken-telemetry bug. It is the HONEST
// steady state of an empty reflection store (reflections are produced only on a
// non-merged failure). This rule surfaces the verdict in /api/health/deep — where
// the re-files kept landing — but MUST NOT alarm on that honest state: it fires a
// single INFO ONLY on the genuine candidate false-none (`served-but-bucketed-none`),
// and NOTHING on `healthy` / `all-none-empty-store` / `no-data`. The full verdict
// always rides the wire envelope (covered in the projectHealthDeepResponse suite).
// ---------------------------------------------------------------------------

describe("assessHealth — reflection-deposit health rule (#2492)", () => {
  const reflDiag = (s: HealthSnapshot) =>
    assessHealth(s).diagnostics.find((d) => d.what === "Reflection deposit served but bucketed 'none'");

  test("honest all-none-empty-store does NOT fire and keeps status healthy (no false alarm)", () => {
    const a = assessHealth(
      clone((s) => {
        s.reflectionHealth = {
          sampleSize: 50,
          distribution: { none: 50 },
          reflectionSourcesPresent: 0,
          verdict: "all-none-empty-store",
          note: "All 50 recent cycles bucketed 'none' with no deposit served — Expected, not an alarm.",
        };
      }),
    );
    assert.ok(
      !a.diagnostics.some((d) => d.what === "Reflection deposit served but bucketed 'none'"),
      "the EXPECTED empty-store none must not surface a diagnostic",
    );
    assert.equal(a.status, "healthy", "the honest all-none state must not degrade status");
  });

  test("healthy verdict (a non-none bucket present) does NOT fire", () => {
    assert.equal(reflDiag(clone(() => {})), undefined, "the baseline healthy verdict is silent");
  });

  test("no-data verdict (metrics probe rejected) does NOT fire", () => {
    const d = reflDiag(
      clone((s) => {
        s.reflectionHealth = {
          sampleSize: 0,
          distribution: {},
          reflectionSourcesPresent: 0,
          verdict: "no-data",
          note: "No cycle metrics recorded yet — nothing to assess.",
        };
      }),
    );
    assert.equal(d, undefined);
  });

  test("served-but-bucketed-none → a single INFO intelligence diagnostic (the genuine candidate false-none)", () => {
    const a = assessHealth(
      clone((s) => {
        s.reflectionHealth = {
          sampleSize: 20,
          distribution: { none: 20 },
          reflectionSourcesPresent: 3,
          verdict: "served-but-bucketed-none",
          note: "3/20 cycles carried a reflectionSources deposit yet bucketed 'none' — candidate false-none; inspect the deposit/read path.",
        };
      }),
    );
    const d = a.diagnostics.find((x) => x.what === "Reflection deposit served but bucketed 'none'");
    assert.ok(d, "the candidate false-none must surface a diagnostic");
    assert.equal(d!.severity, "info", "NEVER warning/error — it annotates, it does not alarm");
    assert.equal(d!.component, "intelligence");
    assert.equal(d!.autoRecovery, true);
    // The note (the verdict's own explanation) is threaded into `why`.
    assert.match(d!.why, /candidate false-none/);
    // An info diagnostic with no higher-severity sibling folds status to degraded
    // (the established info-rule behaviour) — it is the genuine signal worth a look.
    assert.equal(a.status, "degraded");
  });
});

// ---------------------------------------------------------------------------
// Dark leading-outcome rule (issue #2805)
//
// The deep-health rule surfaces a DARK leading outcome (null reading) as a
// WARNING intelligence diagnostic (never critical — Invariant 7), pure over the
// snapshot's `darkOutcomes` field (Invariant 5). It fires only when a verdict
// has status "dark"; an all-live / empty array is honest-none (no diagnostic).
// The why/action carry the producerHint + metric file path (Invariant 6).
// ---------------------------------------------------------------------------

describe("assessHealth — dark leading-outcome rule (#2805)", () => {
  const darkDiag = (s: HealthSnapshot) =>
    assessHealth(s).diagnostics.find((d) => d.component === "intelligence" && /Dark leading outcome/.test(d.what));

  test("empty darkOutcomes does NOT fire and keeps status healthy (honest-none)", () => {
    const a = assessHealth(clone((s) => (s.darkOutcomes = [])));
    assert.equal(darkDiag(healthySnapshot()), undefined);
    assert.equal(a.status, "healthy");
  });

  test("a live-only verdict does NOT fire (only status:dark trips the rule)", () => {
    const d = darkDiag(
      clone((s) => {
        s.darkOutcomes = [
          { name: "forecast-calibration-brier", kind: "leading", status: "live", value: 0.2, ts: new Date().toISOString(), ageMs: 1000 },
        ];
      }),
    );
    assert.equal(d, undefined);
  });

  test("a dark verdict → WARNING intelligence diagnostic carrying producerHint + query", () => {
    const a = assessHealth(
      clone((s) => {
        s.darkOutcomes = [
          {
            name: "forecast-calibration-brier",
            kind: "leading",
            status: "dark",
            query: "metrics/forecast-calibration-brier.txt",
            producerHint: "producer chain: the Target's directional runner → forecast-outcome settlement",
          },
        ];
      }),
    );
    const d = a.diagnostics.find((x) => x.component === "intelligence" && /Dark leading outcome/.test(x.what));
    assert.ok(d, "a dark leading outcome must surface a diagnostic");
    assert.equal(d!.severity, "warning", "advisory WARNING, never critical (Invariant 7)");
    assert.match(d!.what, /forecast-calibration-brier/);
    // Invariant 6: the producer identity + metric file path ride the why.
    assert.match(d!.why, /producer chain/);
    assert.match(d!.why, /metrics\/forecast-calibration-brier\.txt/);
    assert.equal(d!.autoRecovery, false);
    // A warning (no critical/error sibling) folds status to degraded, not critical.
    assert.equal(a.status, "degraded");
  });

  test("multiple dark verdicts pluralize the headline and list all names", () => {
    const d = darkDiag(
      clone((s) => {
        s.darkOutcomes = [
          { name: "a-metric", kind: "leading", status: "dark", query: "metrics/a.txt", producerHint: "hint-a" },
          { name: "b-metric", kind: "leading", status: "dark", query: "metrics/b.txt", producerHint: "hint-b" },
        ];
      }),
    );
    assert.ok(d);
    assert.match(d!.what, /Dark leading outcomes:/);
    assert.match(d!.what, /a-metric/);
    assert.match(d!.what, /b-metric/);
  });
});

// Issue #2023: the `classifyOvSearchProbe` describe block moved to
// test/health-probe.test.mts, tracking the classifier's move into the
// ServiceProbe Adapter Seam (src/health/probe.ts).

// ---------------------------------------------------------------------------
// parseRedisInfoSnapshot — pure Redis INFO regex parse (issue #1856)
//
// The parse moved off the I/O side of the seam (the GET /health/deep probe-15
// lambda in src/api/health.ts) into the pure seam where HealthSnapshot["redisInfo"]
// already declared its result shape. These tests reach it directly — no Express,
// no Redis — which was impossible while the regex lived in the handler.
// ---------------------------------------------------------------------------

describe("parseRedisInfoSnapshot", () => {
  test("extracts all three fields from well-formed INFO sections", () => {
    const out = parseRedisInfoSnapshot(
      "# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\n",
      "# Clients\r\nconnected_clients:42\r\nblocked_clients:0\r\n",
      "# Server\r\nredis_version:7.2.0\r\nuptime_in_seconds:86400\r\n",
    );
    assert.equal(out.memoryHuman, "1.00M");
    assert.equal(out.connectedClients, 42);
    assert.equal(out.uptimeSeconds, 86400);
  });

  test("missing used_memory_human defaults to 'unknown'", () => {
    const out = parseRedisInfoSnapshot(
      "# Memory\r\nused_memory:1048576\r\n",
      "connected_clients:7\r\n",
      "uptime_in_seconds:100\r\n",
    );
    assert.equal(out.memoryHuman, "unknown");
    assert.equal(out.connectedClients, 7);
    assert.equal(out.uptimeSeconds, 100);
  });

  test("missing integer fields coerce to 0 (never NaN)", () => {
    const out = parseRedisInfoSnapshot(
      "used_memory_human:512.00K\r\n",
      "# Clients (no connected_clients line)\r\n",
      "# Server (no uptime line)\r\n",
    );
    assert.equal(out.memoryHuman, "512.00K");
    assert.equal(out.connectedClients, 0, "absent connected_clients → 0, not NaN");
    assert.equal(out.uptimeSeconds, 0, "absent uptime_in_seconds → 0, not NaN");
    assert.ok(!Number.isNaN(out.connectedClients));
    assert.ok(!Number.isNaN(out.uptimeSeconds));
  });

  test("fully empty input yields the all-default snapshot", () => {
    const out = parseRedisInfoSnapshot("", "", "");
    assert.deepEqual(out, { memoryHuman: "unknown", connectedClients: 0, uptimeSeconds: 0 });
  });

  test("integer regex requires digits — a non-numeric value falls through to 0", () => {
    // The /connected_clients:(\d+)/ pattern only matches digit runs, so a
    // garbage value (e.g. a partial/truncated INFO read) does not match and the
    // safe default applies — never a NaN leaking onto the wire.
    const out = parseRedisInfoSnapshot(
      "used_memory_human:2.00G\r\n",
      "connected_clients:notanumber\r\n",
      "uptime_in_seconds:\r\n",
    );
    assert.equal(out.memoryHuman, "2.00G");
    assert.equal(out.connectedClients, 0);
    assert.equal(out.uptimeSeconds, 0);
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
  // Issue #3459: queueDepth removed from the healthy summary banner.
  test("healthy banner reflects scheduler/uptime (no queue count — issue #3459)", () => {
    // Healthy requires a running scheduler. queueDepth is no longer on the snapshot.
    const a = assessHealth(
      clone((s) => {
        s.health.uptime = 90; // 1m
      }),
    );
    assert.equal(a.status, "healthy");
    assert.equal(a.summary, "All systems operational. Scheduler running, uptime 1m.");
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
  // Issue #1771: tests now build ProbeInputs named records directly —
  // no integer subscripts, no count-to-the-right-index to understand the fixture.
  // emptyProbes() is the "all probes failed" baseline; spread to override one field.
  // Issue #3459: queueDepth + backlogCounts removed from ProbeInputs.
  function emptyProbes(): ProbeInputs {
    return {
      basicHealth: null, serviceProbes: null, scheduler: null,
      metrics: null,
      disk: null, mem: null,
      sysdOrchestrator: null, sysdWatchdog: null, sysdTargetWeb: null,
      patterns: null, reflections: null, ovSearch: null,
      redisInfo: null, emergencyBrake: null,
      ovSearchWindow: null, knowledgeContext: null,
      // Issue #2386: null = the fan-out could not resolve the live skill-catalog
      // read; parseProbes defaults it to an un-run empty catalog so both
      // skill-catalog rules no-op (honest-none, never a phantom populated catalog).
      skillCatalog: null,
      // Issue #2805: null = the fan-out could not run the dark-outcome check;
      // parseProbes defaults it to [] so the dark-outcome rule no-ops (honest-none).
      darkOutcomes: null,
      // Issue #3270: null = the ledger LLEN probe settle rejected; parseProbes
      // coalesces to 0 (honest-zero → empty-ledger) so the attribution-ledger-dark
      // rule fires. This is intentional in the "all probes failed" baseline.
      attributionLedgerCount: null,
    };
  }

  // Issue #939: the df/free COLUMNAR PARSE moved to the Host-Probe Adapter
  // (src/host-probe/probe.ts — tested in test/host-probe.test.mts via
  // parseDfOutput/parseFreeOutput). parseProbes now receives already-parsed
  // DiskUsage/MemUsage via ProbeInputs.disk/mem and simply passes them through.
  test("passes the already-parsed DiskUsage through (disk field)", () => {
    const disk = { availableGb: 50, totalGb: 500, usedPercent: 90 };
    const snap = parseProbes({ ...emptyProbes(), disk });
    assert.deepEqual(snap.disk, disk);
  });

  test("passes the already-parsed MemUsage through (mem field)", () => {
    const mem = { totalGb: 32, availableGb: 20, usedPercent: 38 };
    const snap = parseProbes({ ...emptyProbes(), mem });
    assert.deepEqual(snap.mem, mem);
  });

  test("disk/mem probe failure (null) -> zeros (degraded fallback, no throw)", () => {
    const snap = parseProbes(emptyProbes()); // disk/mem null -> zeroed defaults
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
    const snap = parseProbes({ ...emptyProbes(), metrics: { trend, stats: {} } });
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

  test("empty trend -> zero rates, no divide-by-zero", () => {
    const snap = parseProbes({ ...emptyProbes(), metrics: { trend: [], stats: {} } });
    assert.equal(snap.recent.cycleCount, 0);
    assert.equal(snap.recent.mergeRate, 0);
    assert.equal(snap.recent.revertRate, 0); // mergedN=0 guard
    assert.equal(snap.recent.avgDurationHuman, "0s");
  });

  test("all probes null -> safe defaults across the snapshot", () => {
    const snap = parseProbes(emptyProbes());
    assert.equal(snap.health.status, "failed");
    assert.equal(snap.health.redis, false);
    assert.equal(snap.sched.running, false);
    assert.equal(snap.sched.consecutiveErrors, 0);
    // Issue #3459: queueDepth + blCounts removed from HealthSnapshot.
    assert.deepEqual(snap.patterns, { planner: 0, executor: 0, skeptic: 0 });
    assert.equal(snap.reflCount, 0);
    assert.equal(snap.emergencyBrake.engaged, false); // fail-safe to disengaged
    assert.equal(snap.redisInfo, null);
    assert.equal(snap.sysd.orchestrator, "unknown");
  });

  test("end-to-end: parseProbes -> assessHealth on a degraded fan-out", () => {
    // A realistic partial-failure: OV down, watchdog inactive, disk low.
    // Issue #3459: queueDepth + backlogCounts removed from ProbeInputs.
    const snap = parseProbes({
      basicHealth: { status: "ok", redis: true, cycle: "idle", uptime: 1000 },
      serviceProbes: { vikingdb: { status: "running" }, openviking: { status: "failed" } },
      scheduler: { running: true, consecutiveErrors: 0, lastCycleAt: new Date().toISOString() },
      metrics: { trend: [], stats: {} },
      disk: { availableGb: 12, totalGb: 500, usedPercent: 90 }, // low (issue #939: already-parsed)
      mem: null,
      sysdOrchestrator: "active",
      sysdWatchdog: "inactive",
      sysdTargetWeb: "active",
      patterns: { planner: 1, executor: 1, skeptic: 1 },
      reflections: 3,
      ovSearch: { status: "running", latencyMs: 10, resultCount: 2 },
      redisInfo: null,
      emergencyBrake: { engaged: false },
      ovSearchWindow: null,
      knowledgeContext: null,
      // Issue #2386: a fully-registered catalog so the skill-catalog rules don't
      // add a diagnostic to this degraded-fan-out assertion.
      skillCatalog: {
        skills: [],
        registered: 4,
        total: 4,
        completed: true,
        lastAttemptAt: Date.now(),
        vlmDeferred: false,
        skillsDeferred: false,
      },
      // Issue #2805: no dark outcomes in this fan-out — the dark-outcome rule
      // must not add a diagnostic to the degraded-fan-out assertion below.
      darkOutcomes: [],
      // Issue #3270: non-zero count keeps the attribution-ledger-dark rule silent
      // in this degraded-fan-out test (only other degraded-path rules are expected).
      attributionLedgerCount: 1,
    });
    const a = assessHealth(snap);
    assert.equal(a.status, "degraded"); // only warnings
    const components = a.diagnostics.map((d) => d.component);
    assert.ok(components.includes("openviking"));
    assert.ok(components.includes("disk"));
    assert.ok(components.includes("infrastructure"));
  });

  test("assembleProbeInputs round-trip: keyed settled -> ProbeInputs -> HealthSnapshot", () => {
    // Issue #3263: assembleProbeInputs now reads a key→settled RECORD, not a
    // positional array — the integer-subscript contract is gone. This verifies the
    // key-to-field mapping by constructing the settled record under each ProbeInputs
    // key, assembling ProbeInputs, and checking parseProbes produces the expected
    // snapshot field values. Regression guard for the keyed mapping table.
    const disk = { availableGb: 50, totalGb: 500, usedPercent: 10 };
    const mem = { totalGb: 32, availableGb: 20, usedPercent: 38 };
    const fv = (v: any) => ({ status: "fulfilled" as const, value: v });

    // The former retired index-3 cycle slot has no key — it is simply absent from
    // the record (no tombstone). A key not present coalesces to null, exactly as a
    // rejected settle would.
    // Issue #3459: queueDepth + backlogCounts removed from SettledByKey.
    const settled = {
      basicHealth: fv({ status: "ok", redis: true, cycle: "idle", uptime: 42 }),
      serviceProbes: fv({ vikingdb: { status: "running" }, openviking: { status: "running" } }),
      scheduler: fv({ running: true, consecutiveErrors: 2 }),
      metrics: fv({ trend: [], stats: {} }),
      disk: fv(disk),
      mem: fv(mem),
      sysdOrchestrator: fv("active"),
      sysdWatchdog: fv("active"),
      sysdTargetWeb: fv("inactive"),
      patterns: fv({ planner: 5, executor: 3, skeptic: 1 }),
      reflections: fv(12),
      ovSearch: fv({ status: "running", latencyMs: 100, resultCount: 4 }),
      redisInfo: fv({ memoryHuman: "512M", connectedClients: 3, uptimeSeconds: 900 }),
      emergencyBrake: fv({ engaged: true, since: 1234 }),
      ovSearchWindow: fv([{ hour: 0, count: 5 }]),
      knowledgeContext: fv({ available: 0.95 }),
    };

    const probeInputs = assembleProbeInputs(settled);
    const snap = parseProbes(probeInputs);

    // Issue #3459: queueDepth + blCounts assertions removed from this round-trip test.
    assert.equal(snap.health.uptime, 42);
    assert.equal(snap.health.redis, true);
    assert.equal(snap.sched.consecutiveErrors, 2);
    assert.deepEqual(snap.disk, disk);
    assert.deepEqual(snap.mem, mem);
    assert.equal(snap.sysd.orchestrator, "active");
    assert.equal(snap.sysd.watchdog, "active");
    assert.equal(snap.sysd.targetWeb, "inactive");
    assert.deepEqual(snap.patterns, { planner: 5, executor: 3, skeptic: 1 });
    assert.equal(snap.reflCount, 12);
    assert.equal(snap.ovSearch.resultCount, 4);
    assert.equal(snap.redisInfo?.memoryHuman, "512M");
    assert.equal(snap.emergencyBrake.engaged, true);
  });
});

// ---------------------------------------------------------------------------
// derivePipelineMetrics — the pure `recent` derivation (issue #1936)
//
// Exercised directly with canned trend-row arrays — no ProbeInputs fixture
// required. The interface is exactly the concern: a trend-row array in, a
// HealthSnapshot["recent"] out.
// ---------------------------------------------------------------------------

describe("derivePipelineMetrics", () => {
  test("derives counts, rates, and avg duration from a mixed trend", () => {
    const trend = [
      { tasksMerged: "1", totalDurationMs: "60000" },
      { tasksMerged: "1", totalDurationMs: "120000" },
      { tasksMerged: "0", taskTitle: "Planner produced no task" },
      { tasksMerged: "0", rolledBack: "true", tasksFailed: "1" },
      { tasksMerged: "0", taskTitle: "Skipped: low value" },
    ];
    const r = derivePipelineMetrics(trend);
    assert.equal(r.cycleCount, 5);
    assert.equal(r.mergedN, 2);
    assert.equal(r.noTaskN, 2); // "Planner produced no task" + "Skipped:"
    assert.equal(r.revertN, 1);
    assert.equal(r.mergeRate, 40); // 2/5
    assert.equal(r.noTaskRate, 40); // 2/5
    assert.equal(r.failedRate, 20); // 1/5
    assert.equal(r.revertRate, 50); // 1/2 mergedN
    assert.equal(r.avgDurationMs, 90000); // (60000+120000)/2
    assert.equal(r.avgDurationHuman, "2m"); // > 60000
  });

  test("empty trend -> zero rates, no divide-by-zero", () => {
    const r = derivePipelineMetrics([]);
    assert.equal(r.cycleCount, 0);
    assert.equal(r.mergedN, 0);
    assert.equal(r.noTaskN, 0);
    assert.equal(r.revertN, 0);
    assert.equal(r.mergeRate, 0);
    assert.equal(r.failedRate, 0);
    assert.equal(r.noTaskRate, 0);
    assert.equal(r.revertRate, 0); // mergedN=0 guard
    assert.equal(r.avgDurationMs, 0);
    assert.equal(r.avgDurationHuman, "0s");
  });

  test("revertRate divides by mergedN, not cycleCount", () => {
    // 4 merged, 2 of them rolled back -> 50% revert rate over MERGES.
    const trend = [
      { tasksMerged: "1", rolledBack: "true" },
      { tasksMerged: "1", rolledBack: true },
      { tasksMerged: "1" },
      { tasksMerged: "1" },
      { tasksMerged: "0", taskTitle: "Planner produced no task" },
    ];
    const r = derivePipelineMetrics(trend);
    assert.equal(r.mergedN, 4);
    assert.equal(r.revertN, 2);
    assert.equal(r.revertRate, 50); // 2/4 mergedN, not 2/5 cycleCount
    assert.equal(r.noTaskN, 1);
  });

  test("avgDuration ignores zero/missing durations and renders sub-minute as seconds", () => {
    const trend = [
      { tasksMerged: "0", totalDurationMs: "10000" },
      { tasksMerged: "0", totalDurationMs: "0" }, // filtered out (d>0 guard)
      { tasksMerged: "0" }, // no duration -> parseInt(0) -> filtered out
      { tasksMerged: "0", totalDurationMs: "20000" },
    ];
    const r = derivePipelineMetrics(trend);
    assert.equal(r.avgDurationMs, 15000); // (10000+20000)/2, zeros excluded
    assert.equal(r.avgDurationHuman, "15s"); // <= 60000 -> seconds
  });

  test("accepts numeric (not just string) trend fields", () => {
    const trend = [
      { tasksMerged: 1, totalDurationMs: 30000 },
      { tasksMerged: 0, tasksFailed: 1 },
    ];
    const r = derivePipelineMetrics(trend);
    assert.equal(r.mergedN, 1);
    assert.equal(r.failedRate, 50); // 1/2
    assert.equal(r.avgDurationMs, 30000);
  });
});

// ---------------------------------------------------------------------------
// projectHealthDeepResponse — pure wire-projection (issue #1513)
//
// The ~60-line res.json({...}) block in the GET /health/deep handler used to be
// reachable only via Express supertest. Extracted into a pure function, the
// HealthSnapshot → wire-envelope mapping (field names, the ovSearchWindow/
// knowledgeContext probe reads) is now unit-testable with a stub snapshot — no
// Redis/OpenViking. Issue #3263: those reads are keyed by name, not by subscript.
// ---------------------------------------------------------------------------

describe("projectHealthDeepResponse", () => {
  const CHECKED_AT = "2026-06-09T00:00:00.000Z";

  // Build a ProbeInputs from a keyed record of settled values (issue #3263).
  // Every ProbeInputs async-probe key that is not supplied is left ABSENT, which
  // assembleProbeInputs coalesces to null (equivalent to a rejected settle). The
  // key-to-field mapping lives in assembleProbeInputs (src/health/fan-out.ts); the
  // tests reuse it here to keep the key-to-field correspondence a single source of
  // truth — no integer subscripts anywhere.
  function makeProbes(values: Record<string, any> = {}): ProbeInputs {
    const settled: Record<string, { status: "fulfilled" | "rejected"; value?: any; reason?: any }> = {};
    for (const [key, value] of Object.entries(values)) {
      settled[key] = { status: "fulfilled", value };
    }
    return assembleProbeInputs(settled as any);
  }

  function project(
    snap: HealthSnapshot,
    opts: { activeCycle?: unknown; settledValues?: Record<string, any> } = {},
  ) {
    const { diagnostics, status, summary } = assessHealth(snap);
    return projectHealthDeepResponse(
      snap,
      diagnostics,
      status,
      summary,
      opts.activeCycle ?? null,
      CHECKED_AT,
      makeProbes(opts.settledValues),
    );
  }

  test("top-level envelope carries status/summary/checkedAt and the documented key set", () => {
    const r = project(healthySnapshot());
    assert.equal(r.status, "healthy");
    assert.equal(r.checkedAt, CHECKED_AT);
    assert.match(r.summary, /All systems operational/);
    // Issue #3544: the `ollamaVlm` wire field was removed with the VLM-host probe
    // at the VLM cutover. `degraded` stays on the envelope (its only historical
    // source was that probe) but is now always `false`.
    assert.deepEqual(Object.keys(r).sort(), [
      "activeCycle",
      "checkedAt",
      "degraded",
      "diagnostics",
      "infrastructure",
      "intelligence",
      "pipeline",
      "services",
      "status",
      "summary",
    ]);
    assert.equal(r.degraded, false);
  });

  test("degraded is always false — its only source (the Ollama VLM host probe) was retired at the VLM cutover (issue #3544)", () => {
    // The #2278 VLM-host visibility probe drove `degraded`; at the VLM cutover it
    // was removed (OpenViking's VLM moved off the gaming-PC host onto the in-repo
    // claude-cli shim, #3542). The `degraded` field is retained on the wire so a
    // future soft-down probe can flip it without an envelope change, but nothing
    // sets it true now — assert the always-false invariant on both a healthy and a
    // failing snapshot, and confirm the field is a plain boolean.
    assert.equal(project(healthySnapshot()).degraded, false);
    const failing = project(
      clone((s) => {
        s.health.redis = false; // an unrelated failure must not resurrect `degraded`
      }),
    );
    assert.equal(failing.degraded, false);
    assert.equal(typeof failing.degraded, "boolean");
    // `degraded` is a visibility flag, never the HTTP status: the route still 200s.
    assert.equal(project(healthySnapshot()).status, "healthy");
  });

  test("intelligence carries the EXACT field names (ovSearchTrend, knowledgeContext — typo regression guard)", () => {
    const r = project(healthySnapshot());
    // The #1513 friction: a `ovSeachTrend` typo or a 17/18 swap silently nulls a
    // field. Pin the exact key set so a rename/typo fails the test, not the UI.
    assert.deepEqual(Object.keys(r.intelligence).sort(), [
      // Issue #2805: the dark leading-outcome verdicts ride the intelligence
      // block so /api/health/deep surfaces the producer identity + metric path.
      "darkOutcomes",
      "knowledgeContext",
      "ovSearch",
      "ovSearchTrend",
      "patterns",
      // Issue #2492: the reflection-deposit-health verdict now rides the
      // intelligence block so /api/health/deep surfaces it where operators look.
      "reflectionHealth",
      "reflections",
    ]);
  });

  test("intelligence.reflectionHealth carries the verdict the snapshot computed (issue #2492)", () => {
    const r = project(healthySnapshot());
    // The full verdict ALWAYS rides the wire envelope (it is a pure read), even
    // when no deep-health diagnostic fires — that always-on visibility is the
    // discoverability fix that stops the #1912→#2450→#2467→#2492 re-file loop.
    assert.deepEqual(r.intelligence.reflectionHealth, healthySnapshot().reflectionHealth);
  });

  test("intelligence.darkOutcomes rides the wire envelope carrying producer identity (issue #2805)", () => {
    const verdicts = [
      {
        name: "forecast-calibration-brier",
        kind: "leading" as const,
        status: "dark" as const,
        query: "metrics/forecast-calibration-brier.txt",
        producerHint: "producer chain hint",
      },
    ];
    const r = project(clone((s) => (s.darkOutcomes = verdicts)));
    // Always-on visibility: the verdicts (with producerHint + query) ride the
    // envelope so an operator reading /api/health/deep gets the producer identity.
    assert.deepEqual(r.intelligence.darkOutcomes, verdicts);
  });

  test("ovSearchTrend/knowledgeContext coalesce to null when their keys are absent (issue #3263)", () => {
    const r = project(healthySnapshot()); // makeProbes leaves ovSearchWindow/knowledgeContext absent by default
    assert.equal(r.intelligence.ovSearchTrend, null);
    assert.equal(r.intelligence.knowledgeContext, null);
  });

  test("ovSearchTrend ← ovSearchWindow key, knowledgeContext ← knowledgeContext key (issue #3263)", () => {
    const trend = { window: "24h", buckets: [{ hour: 0, zeroResultRate: 0.1 }] };
    const ctx = { window: "7d", days: [{ day: "2026-06-09", availability: 0.9 }] };
    const r = project(healthySnapshot(), { settledValues: { ovSearchWindow: trend, knowledgeContext: ctx } });
    assert.deepEqual(r.intelligence.ovSearchTrend, trend);
    assert.deepEqual(r.intelligence.knowledgeContext, ctx);
    // ovSearch (the live probe) still flows straight from the snapshot.
    assert.deepEqual(r.intelligence.ovSearch, { status: "running", latencyMs: 40, resultCount: 3 });
  });

  test("services block maps health/redis/scheduler/probes; uptimeHuman uses fmtUp", () => {
    const r = project(healthySnapshot());
    // uptime 3600 → "1h 0m" (the local fmtUp the projection now owns).
    assert.deepEqual(r.services.orchestrator, {
      status: "running",
      uptime: 3600,
      uptimeHuman: "1h 0m",
      cycle: "idle",
    });
    assert.deepEqual(r.services.redis, {
      status: "running",
      memoryHuman: "12M",
      connectedClients: 4,
      uptimeSeconds: 9999,
    });
    assert.equal(r.services.scheduler.status, "running");
    // Issue #3133: the vestigial always-null `scheduler.research` wire field was
    // removed — the deep-health envelope must no longer carry it.
    assert.ok(
      !("research" in r.services.scheduler),
      "scheduler wire object must not carry the removed `research` field",
    );
    assert.deepEqual(r.services.vikingdb, { status: "running" });
    assert.deepEqual(r.services.openviking, { status: "running" });
  });

  test("orchestrator.status reflects a non-ok health status; redis.status flips to failed", () => {
    const r = project(
      clone((s) => {
        s.health.status = "killed";
        s.health.redis = false;
      }),
    );
    assert.equal(r.services.orchestrator.status, "killed");
    assert.equal(r.services.redis.status, "failed");
    assert.equal(r.pipeline.killSwitch, true);
  });

  test("scheduler.status is 'failed' at >=5 consecutiveErrors, else 'idle' when stopped", () => {
    const failed = project(
      clone((s) => {
        s.sched.running = false;
        s.sched.consecutiveErrors = 5;
      }),
    );
    assert.equal(failed.services.scheduler.status, "failed");
    const idle = project(
      clone((s) => {
        s.sched.running = false;
        s.sched.consecutiveErrors = 0;
      }),
    );
    assert.equal(idle.services.scheduler.status, "idle");
  });

  // Issue #3459: pipeline.queueDepth + backlogCounts removed from the wire shape.
  test("pipeline projects rate fields only — NOT the raw rule-guard counts (issue #3459: no queueDepth/backlogCounts)", () => {
    const r = project(healthySnapshot());
    // queueDepth and backlogCounts are no longer on the pipeline wire shape.
    assert.ok(!("queueDepth" in r.pipeline));
    assert.ok(!("backlogCounts" in r.pipeline));
    assert.deepEqual(Object.keys(r.pipeline.recentMetrics).sort(), [
      "avgDurationHuman",
      "avgDurationMs",
      "cycleCount",
      "failedRate",
      "mergeRate",
      "noTaskRate",
      "revertRate",
    ]);
    // mergedN/noTaskN/revertN are rule guards, never on the wire envelope.
    assert.ok(!("mergedN" in r.pipeline.recentMetrics));
    assert.ok(!("revertN" in r.pipeline.recentMetrics));
  });

  test("infrastructure maps disk/mem/systemd (mem under the `memory` key)", () => {
    const r = project(healthySnapshot());
    assert.deepEqual(r.infrastructure.disk, { availableGb: 120, totalGb: 500, usedPercent: 60 });
    assert.deepEqual(r.infrastructure.memory, { totalGb: 32, availableGb: 20, usedPercent: 40 });
    assert.deepEqual(r.infrastructure.systemd, {
      orchestrator: "active",
      watchdog: "active",
      targetWeb: "active",
    });
  });

  test("activeCycle is passed through verbatim from the handler", () => {
    const ac = { id: "c1", status: "running", startedAt: "x", durationMs: 1, durationHuman: "1s", tasks: [] };
    const r = project(healthySnapshot(), { activeCycle: ac });
    assert.equal(r.activeCycle, ac);
    // null when the handler derives none.
    assert.equal(project(healthySnapshot()).activeCycle, null);
  });

  test("diagnostics array is the assessment's, passed straight through", () => {
    const snap = clone((s) => (s.svcProbes.openviking = { status: "failed" }));
    const { diagnostics } = assessHealth(snap);
    const r = project(snap);
    assert.deepEqual(r.diagnostics, diagnostics);
    assert.equal(r.status, "degraded");
  });

  test("redis info nulls coalesce when redisInfo is absent (probe rejected)", () => {
    const r = project(clone((s) => (s.redisInfo = null)));
    assert.equal(r.services.redis.memoryHuman, null);
    assert.equal(r.services.redis.connectedClients, null);
    assert.equal(r.services.redis.uptimeSeconds, null);
  });
});

// assessSkillCatalog tests moved to test/health-skill-catalog.test.mts with the
// Skill-Catalog Health Seam extraction (issue #1992).
