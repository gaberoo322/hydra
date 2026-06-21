// Health Wire-Projection Module (issue #2039)
//
// The data-OUT leg of the Health Snapshot pipeline, lifted out of
// `src/health/diagnostics.ts` so the data-IN pipeline (`parseProbes`:
// `ProbeInputs` → `HealthSnapshot`) is independently testable without importing
// the wire projection or its `HealthDeepResponse` type. `parseProbes` (data-in)
// and `projectHealthDeepResponse` (data-out) have opposite data-flow directions;
// #2039 splits them along that internal boundary, mirroring the prior
// `rules.ts` / `diagnostics.ts` (issue #1867) and
// `eligibility.ts` / `usage-tracker.ts` extractions.
//
// Seam discipline (issue #840/#1771): the canonical type vocabulary
// (`HealthSnapshot`, `ProbeInputs`, `ServiceProbe`, `HealthAssessment`,
// `HealthDiagnostic`) stays in exactly ONE module — `diagnostics.ts`,
// the pure parse seam. This module **type-imports** that vocabulary (erased at
// compile time, zero runtime coupling) and does NOT redeclare or fork any shape.
// The dependency direction stays acyclic: the parse module imports nothing from
// here; this module type-only-imports the parse module's vocabulary plus the
// `fmtUp` uptime humanizer from `rules.ts`. No new value-import edge is
// created back into the I/O layer (`src/api/`).
//
// The single value-consumer is `src/api/health.ts`, which imports
// `projectHealthDeepResponse` from here while continuing to import
// `parseProbes`/`assessHealth`/`parseRedisInfoSnapshot` from
// `diagnostics.ts`.
import { fmtUp } from "./rules.ts";
import type {
  HealthSnapshot,
  HealthAssessment,
  HealthDiagnostic,
  ServiceProbe,
  ProbeInputs,
} from "./diagnostics.ts";

// ---- projectHealthDeepResponse — the pure wire-projection ----------------
//
// Issue #1513: the third leg of the Snapshot pipeline, lifted out of the inline
// `res.json({...})` block in the `GET /health/deep` route handler. #840 already
// pulled the parse (`parseProbes`) and assessment (`assessHealth`) halves behind
// the pure seam; the wire projection was still inline and only reachable via
// Express supertest. This maps a HealthSnapshot + HealthAssessment (already
// typed) into the documented `/health/deep` wire envelope — byte-identically —
// so the field names and settled-index subscripts (`ovSearchTrend` not
// `ovSeachTrend`, settled[17] vs [18]) are unit-testable without standing up
// Redis/OpenViking.
//
// Issue #2039: relocated from diagnostics.ts to this dedicated
// wire-projection module, but otherwise unchanged — the body is moved verbatim.
//
// The handler keeps ONLY the I/O fan-out and the `activeCycle` derivation from
// settled[3] (a vestigial HTTP-layer concern, out of scope per #1513); the
// already-built `activeCycle` object and `checkedAt` ISO string are passed in.
//
// `settled` is taken ONLY for indices 17/18 (ovSearchTrend/knowledgeContext),
// which `parseProbes` stops short of (it ends at index 16, the brake). A rejected
// settle coalesces to null — surfaced as absent trend data, never a 500 — exactly
// as the inline #1440 lines did.

/** The wire shape of the `/health/deep` response envelope. */
export interface HealthDeepResponse {
  status: HealthAssessment["status"];
  summary: string;
  checkedAt: string;
  // Issue #2278: a top-level visibility flag — `true` when a soft-failing probe
  // (today: the Tailnet Ollama VLM host) is down. It does NOT change the HTTP
  // status code (the route always answers 200; `degraded` is the operator's
  // at-a-glance "something is soft-down" signal). Distinct from `status`, which
  // is the rule-derived severity fold (healthy/degraded/unhealthy/critical).
  degraded: boolean;
  // Issue #2278: the Tailnet Ollama VLM host (gabes-desktop-1:11434) liveness
  // probe — the host OpenViking uses for its vision/indexing model. A DIRECT
  // reachability check distinct from the embed-backend (OV-internal) probe. When
  // `down`, the recurring silent skill-catalog failure (#2277/#2269/…) is finally
  // visible. `{status:'ok'|'down', latencyMs, error?}`.
  ollamaVlm: HealthSnapshot["ollamaVlm"];
  services: {
    orchestrator: { status: string; uptime: number; uptimeHuman: string; cycle: string };
    redis: {
      status: string;
      memoryHuman: string | null;
      connectedClients: number | null;
      uptimeSeconds: number | null;
    };
    scheduler: {
      status: string;
      intervalHuman: string | undefined;
      cyclesRun: number | undefined;
      cyclesMerged: number;
      cyclesFailed: number;
      mergeRate: number;
      consecutiveErrors: number;
      lastError: string | null | undefined;
      lastCycleAt: string | null | undefined;
      research: { lastResearchAt: string | null };
    };
    // Issue #1869: the wire contract still names these two services explicitly
    // (backward compatibility — out of scope to change the envelope shape). The
    // projection reads them out of the svcProbes map by key.
    vikingdb: ServiceProbe;
    openviking: ServiceProbe;
    // Issue #2013: the OpenViking dense-embedding backend, sampled distinctly
    // from the `openviking` app-liveness key (the surface that was stale-but-
    // invisible during #1921). An ADDED field — never a rename/removal of the
    // two above. The probe is a normal svcProbes entry (keyed "embed-backend");
    // a missing key coalesces to "failed" so the wire field is always present.
    "embed-backend": ServiceProbe;
  };
  activeCycle: unknown;
  pipeline: {
    queueDepth: number;
    backlogCounts: HealthSnapshot["blCounts"];
    recentMetrics: {
      cycleCount: number;
      mergeRate: number;
      failedRate: number;
      noTaskRate: number;
      revertRate: number;
      avgDurationMs: number;
      avgDurationHuman: string;
    };
    killSwitch: boolean;
    emergencyBrake: HealthSnapshot["emergencyBrake"];
  };
  infrastructure: {
    disk: HealthSnapshot["disk"];
    memory: HealthSnapshot["mem"];
    systemd: { orchestrator: string; watchdog: string; targetWeb: string };
  };
  intelligence: {
    patterns: HealthSnapshot["patterns"];
    reflections: number;
    ovSearch: HealthSnapshot["ovSearch"];
    ovSearchTrend: unknown;
    knowledgeContext: unknown;
  };
  diagnostics: HealthDiagnostic[];
}

export function projectHealthDeepResponse(
  snapshot: HealthSnapshot,
  diagnostics: HealthDiagnostic[],
  status: HealthAssessment["status"],
  summary: string,
  activeCycle: unknown,
  checkedAt: string,
  probes: ProbeInputs,
): HealthDeepResponse {
  const { health, svcProbes, sched, queueDepth, blCounts, patterns, reflCount, ovSearch, ollamaVlm, redisInfo, emergencyBrake, disk, mem, recent } = snapshot;
  const { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb } = snapshot.sysd;

  // Issue #1440: coalesce the two persisted OV-quality reads.
  // A rejected settle (Redis error) becomes null — surfaced as absent trend
  // data, never a 500. parseProbes stops at emergencyBrake, so these arrive
  // via the ProbeInputs named fields ovSearchWindow/knowledgeContext.
  const ovSearchWindow = probes.ovSearchWindow ?? null;
  const ovContextAvailability = probes.knowledgeContext ?? null;

  return {
    status, summary, checkedAt,
    // Issue #2278: a `down` Ollama VLM host flips the visibility flag. Never a
    // 5xx — the route still answers 200; `degraded` is the soft-down signal.
    degraded: ollamaVlm.status === "down",
    ollamaVlm,
    services: {
      orchestrator: { status: health.status === "ok" ? "running" : health.status, uptime: health.uptime, uptimeHuman: fmtUp(health.uptime), cycle: health.cycle },
      redis: { status: health.redis ? "running" : "failed", memoryHuman: redisInfo?.memoryHuman || null, connectedClients: redisInfo?.connectedClients || null, uptimeSeconds: redisInfo?.uptimeSeconds || null },
      scheduler: { status: sched.running ? "running" : (sched.consecutiveErrors >= 5 ? "failed" : "idle"), intervalHuman: sched.intervalHuman, cyclesRun: sched.cyclesRun, cyclesMerged: sched.cyclesMerged || 0, cyclesFailed: sched.cyclesFailed || 0, mergeRate: sched.mergeRate || 0, consecutiveErrors: sched.consecutiveErrors, lastError: sched.lastError, lastCycleAt: sched.lastCycleAt, research: { lastResearchAt: sched.research?.lastResearchAt || null } },
      // Issue #1869: keyed reads off the ServiceProbeMap. A missing key (e.g. a
      // probe failure that produced an empty map) coalesces to "failed" so the
      // wire field is always present, preserving the envelope contract.
      vikingdb: svcProbes.vikingdb ?? { status: "failed" }, openviking: svcProbes.openviking ?? { status: "failed" },
      // Issue #2013: the distinct embed-backend entry. Same keyed-read +
      // coalesce-to-"failed" contract as the two services above.
      "embed-backend": svcProbes["embed-backend"] ?? { status: "failed" },
    },
    activeCycle,
    // Issue #744: emergency-brake state alongside the kill switch — both are
    // operator-controlled merge/cycle gates the dashboard surfaces.
    // recentMetrics projects only the rate fields the wire contract has
    // always carried — the new raw counts (mergedN/noTaskN/revertN) on the
    // snapshot's `recent` are for rule guards, not the HTTP envelope.
    pipeline: { queueDepth, backlogCounts: blCounts, recentMetrics: { cycleCount: recent.cycleCount, mergeRate: recent.mergeRate, failedRate: recent.failedRate, noTaskRate: recent.noTaskRate, revertRate: recent.revertRate, avgDurationMs: recent.avgDurationMs, avgDurationHuman: recent.avgDurationHuman }, killSwitch: health.status === "killed", emergencyBrake },
    infrastructure: { disk, memory: mem, systemd: { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb } },
    // Issue #1440: `ovSearch` is the live in-memory snapshot + liveness probe
    // (resets on restart). `ovSearchTrend` is the restart-surviving 24h
    // hour-bucketed rollup (zeroResultRate/fallbackSuccessRate trends) and
    // `knowledgeContext` the 7d per-day context-availability rate.
    intelligence: { patterns, reflections: reflCount, ovSearch, ovSearchTrend: ovSearchWindow, knowledgeContext: ovContextAvailability },
    diagnostics,
  };
}
