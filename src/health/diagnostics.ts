// Health Assessment Module (issue #840)
//
// The pure core lifted out of the `/api/health/deep` route handler in
// `src/api/health.ts`. The handler owns ONLY the probe I/O fan-out and the
// HTTP wire-envelope projection; everything pure — disk/mem regex parsing,
// the `recent` pipeline derivation, the ~27 diagnostic rules, and the
// status/summary fold — lives here behind a testable seam.
//
// Terminology (see CONTEXT.md): a **Health Snapshot** is the normalized
// internal model a rule may read; a **Health Diagnostic** is one finding; a
// **Health Assessment** is the folded result (diagnostics + status + summary).
// Distinct from **Builder Health** (capability trend) and the `/api/health`
// liveness boolean (process up).

// Issue #1867: the diagnostic rule set (`RULES`) and the `fmtUp` uptime
// humanizer were extracted into the sibling `rules.ts` so rule authoring
// is a one-file edit. `assessHealth` below is now a thin runner over the
// imported `RULES`; `fmtUp` is consumed here by both `assessHealth`'s summary
// banner and `projectHealthDeepResponse`'s `uptimeHuman` field. The parse
// pipeline stays in this module; the structured type vocabulary was extracted
// to `types.ts` (see below).
import { RULES, fmtUp } from "./rules.ts";
// Issue #2492: the pure reflection-deposit-health projection VALUE, relocated to
// the metrics domain (it is a tally over the same cycle-trend rows the metrics
// probe already collects). Consuming it HERE — a downward edge into the metrics
// seam, NOT into the api/learning router — lets the deep-health reflection rule
// surface the verdict where operators actually look, so the recurring
// #1912→#2450→#2467→#2492 false-alarm re-file loop stops. parseProbes runs it
// over the metrics-probe trend it already has; no new I/O, no writer. Its report
// TYPE (ReflectionHealthReport) rides the HealthSnapshot vocabulary in types.ts.
import { projectReflectionHealth } from "../metrics/reflection-health.ts";
// Issue #3230: the canonical Health type vocabulary (ServiceProbe,
// ServiceProbeMap, HealthSnapshot, HealthSeverity, HealthDiagnostic,
// HealthAssessment, ProbeMetricsInput, ProbeInputs) plus the external-probe
// `import type` fan-in that HealthSnapshot embeds (OvSearchProbeStatus,
// OllamaVlmProbeResult, SkillCatalogState, OutcomeVerdict, ReflectionHealthReport)
// were extracted into the zero-logic leaf `types.ts`. This module — the parse
// seam — imports the vocabulary DOWN from the leaf and keeps ALL assessment
// logic. The leaf carries no logic, so importing it adds no runtime edge and
// cannot form a cycle. Re-exported below for zero-diff callers.
import type {
  ServiceProbeMap,
  HealthSnapshot,
  HealthSeverity,
  HealthDiagnostic,
  HealthAssessment,
  ProbeMetricsInput,
  ProbeInputs,
} from "./types.ts";
// Re-export the vocabulary still consumed through ./diagnostics.ts (the parse
// seam's own tests import HealthSnapshot/ProbeInputs from here; wire.ts and the
// barrel keep resolving HealthAssessment/ProbeMetricsInput from here). The
// ServiceProbe/ServiceProbeMap/HealthSeverity/HealthDiagnostic re-exports were
// dropped (issue #3314): every remaining consumer imports those four names from
// ./types.ts directly, so re-exporting them here was dead surface. New code
// SHOULD import the type vocabulary from ./types.ts directly.
export type {
  HealthSnapshot,
  HealthAssessment,
  ProbeMetricsInput,
  ProbeInputs,
} from "./types.ts";

// Skill-catalog health gate moved to src/health/skill-catalog.ts (issue #1992).
// It described a separate concern — the Knowledge Base's in-process skill
// registration state — not a probe-marshalling input, so it now lives in its
// own focused module that type-imports `HealthDiagnostic` from here. Issue #2386:
// the catalog STATE itself now rides on HealthSnapshot.skillCatalog (assembled at
// fan-out time), so the rules read it from the snapshot like every other input.

// ---- Type vocabulary — RELOCATED to types.ts (issue #3230) ---------------
//
// ServiceProbe, ServiceProbeMap, HealthSnapshot (incl. the Service Probe Map
// #1869 design), HealthSeverity, HealthDiagnostic, HealthAssessment,
// ProbeMetricsInput, and ProbeInputs — plus the external-probe `import type`
// fan-in they embed (OvSearchProbeStatus/OllamaVlmProbeResult from probe.ts,
// SkillCatalogState from knowledge-base/skill-registration.ts, OutcomeVerdict
// from scheduler/chores/wiring-liveness-outcomes.ts, ReflectionHealthReport
// from metrics/reflection-health.ts) — now live in the zero-logic leaf
// `src/health/types.ts`. They are imported down (and re-exported) at the top of
// this module. This module keeps ONLY the assessment logic (parseRedisInfoSnapshot,
// derivePipelineMetrics, parseProbes, assessHealth) below.

// ---- parseRedisInfoSnapshot — the redisInfo factory ----------------------
//
// Issue #1856: the regex parse of Redis INFO sections used to live inline in the
// `GET /health/deep` probe-15 lambda in `src/api/health.ts` — on the wrong side
// of the seam. `HealthSnapshot["redisInfo"]` declared the result SHAPE here in
// the pure seam (#840), but the code that PRODUCED the shape from raw INFO output
// sat in the I/O handler, unreachable by `test/health-diagnostics.test.mts`.
//
// The handler keeps only the three `redisInfo(section)` I/O calls and passes the
// raw strings here; this pure function does the parse. Its return type is the
// seam's declared `HealthSnapshot["redisInfo"]`, so a renamed/mis-typed field is
// a compile error rather than a silent runtime `null` in parseProbes' safe-read.
// A missing `used_memory_human` defaults to "unknown"; a missing/malformed
// integer field coerces to 0 (parseInt of "" → NaN, guarded by the `|| "0"`).

/**
 * Parse the raw Redis `INFO memory`/`INFO clients`/`INFO server` section
 * strings into the structured `redisInfo` snapshot shape. Pure: reads only its
 * string arguments, performs no Redis I/O.
 *
 * @param memory  the raw `INFO memory` section (carries `used_memory_human`).
 * @param clients the raw `INFO clients` section (carries `connected_clients`).
 * @param server  the raw `INFO server` section (carries `uptime_in_seconds`).
 * @returns the `{ memoryHuman, connectedClients, uptimeSeconds }` record. Missing
 *          fields fall back to `"unknown"` (memoryHuman) / `0` (the integers).
 */
export function parseRedisInfoSnapshot(
  memory: string,
  clients: string,
  server: string,
): NonNullable<HealthSnapshot["redisInfo"]> {
  return {
    memoryHuman: memory.match(/used_memory_human:(\S+)/)?.[1] || "unknown",
    connectedClients: parseInt(clients.match(/connected_clients:(\d+)/)?.[1] || "0"),
    uptimeSeconds: parseInt(server.match(/uptime_in_seconds:(\d+)/)?.[1] || "0"),
  };
}

// ---- HealthDiagnostic / HealthAssessment / ProbeInputs — RELOCATED --------
//
// Issue #3230: the HealthSeverity/HealthDiagnostic finding types, the
// HealthAssessment folded-result type, and the ProbeMetricsInput/ProbeInputs
// named-record vocabulary (issue #1771/#1833) all moved to the zero-logic leaf
// `src/health/types.ts` (imported + re-exported at the top of this module). The
// assessment logic that CONSUMES them — derivePipelineMetrics, parseProbes,
// assessHealth — stays below.

// ---- derivePipelineMetrics — the pure `recent` derivation ---------------
//
// Issue #1936: the `recent` pipeline derivation used to be inlined in
// parseProbes, so a test covering mergedN/noTaskN/revertN/rates/avgDuration
// had to construct a full ProbeInputs and call parseProbes — even though the
// 15-field marshalling is irrelevant to the derivation. Extracted here as a
// pure function whose interface is exactly its concern: a raw trend-row array
// (from ProbeMetricsInput) in, a HealthSnapshot["recent"] out. parseProbes now
// calls it with `mData.trend || []`. No behaviour change — the body is the
// byte-for-byte derivation that lived inline.

export function derivePipelineMetrics(
  trend: NonNullable<ProbeMetricsInput["trend"]>,
): HealthSnapshot["recent"] {
  const mergedN = trend.filter((m: any) => parseInt(m.tasksMerged || 0) > 0).length;
  const noTaskN = trend.filter(
    (m: any) =>
      m.taskTitle === "Planner produced no task" || (m.taskTitle || "").startsWith("Skipped:"),
  ).length;
  const revertN = trend.filter((m: any) => m.rolledBack === "true" || m.rolledBack === true).length;
  const durs = trend.map((m: any) => parseInt(m.totalDurationMs || 0)).filter((d: number) => d > 0);
  const avgDur =
    durs.length > 0 ? Math.round(durs.reduce((a: number, b: number) => a + b, 0) / durs.length) : 0;
  return {
    cycleCount: trend.length,
    mergeRate: trend.length > 0 ? Math.round((mergedN / trend.length) * 100) : 0,
    failedRate:
      trend.length > 0
        ? Math.round(
            (trend.filter((m: any) => parseInt(m.tasksFailed || 0) > 0).length / trend.length) * 100,
          )
        : 0,
    noTaskRate: trend.length > 0 ? Math.round((noTaskN / trend.length) * 100) : 0,
    revertRate: mergedN > 0 ? Math.round((revertN / mergedN) * 100) : 0,
    mergedN,
    noTaskN,
    revertN,
    avgDurationMs: avgDur,
    avgDurationHuman: avgDur > 60000 ? `${Math.round(avgDur / 60000)}m` : `${Math.round(avgDur / 1000)}s`,
  };
}

// ---- parseProbes — marshals ProbeInputs into a HealthSnapshot ------------
//
// Maps the ProbeInputs named record into a HealthSnapshot. Each field is
// named after the probe it carries — no integer subscripts, no shared-secret
// index table. A null field means the probe failed (rejected settle); safe
// defaults apply identically to the prior implementation. The `recent`
// pipeline derivation is delegated to derivePipelineMetrics (issue #1936).

export function parseProbes(probes: ProbeInputs): HealthSnapshot {
  const health = probes.basicHealth || { status: "failed", redis: false, cycle: "unknown", uptime: 0 };
  // Issue #1869: svcProbes is now a ServiceProbeMap. On a rejected probe settle
  // (probes.serviceProbes === null) fall back to a map carrying the two wire
  // services as "failed" — byte-for-byte the prior default, so the /health/deep
  // `services.vikingdb`/`.openviking` envelope and the vikingdb/openviking
  // diagnostic rules see the identical values. New services added to the fan-out
  // need no entry here: the rules guard absent keys with optional chaining.
  const svcProbes: ServiceProbeMap = probes.serviceProbes || {
    vikingdb: { status: "failed" },
    openviking: { status: "failed" },
    // Issue #2013: the embed-backend probe is part of the index-1 fan-out, so a
    // rejected settle defaults it to "failed" alongside the two wire services —
    // honest-none (the whole fan-out failed), not a phantom "running".
    "embed-backend": { status: "failed" },
  };
  const sched = probes.scheduler || {
    running: false,
    cyclesRun: 0,
    cyclesMerged: 0,
    cyclesFailed: 0,
    mergeRate: 0,
    consecutiveErrors: 0,
  };
  const queueDepth = probes.queueDepth || 0;
  const blCounts = probes.backlogCounts || {
    triage: 0,
    backlog: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };
  const mData = probes.metrics || { trend: [], stats: {} };
  const patterns = probes.patterns || { planner: 0, executor: 0, skeptic: 0 };
  const reflCount = probes.reflections || 0;
  // Issue #3270: attribution ledger LLEN — coalesces null (rejected settle or
  // probe not yet running) to 0 so the rule sees "empty", never a phantom populated
  // ledger. Honest-zero: the probe itself already returns 0 on Redis error.
  const attributionLedgerCount = probes.attributionLedgerCount ?? 0;
  // Issue #2386: a null skillCatalog (the fan-out could not resolve the live
  // read) defaults to an un-run, empty catalog — `completed:false` so both
  // skill-catalog rules (assessSkillCatalog / assessRegistrationFailureRate)
  // no-op, exactly the "registration still in flight / no pass yet" framing
  // they already treat as a non-alarm. This is honest-none, never a phantom
  // populated catalog.
  const skillCatalog: HealthSnapshot["skillCatalog"] = probes.skillCatalog || {
    skills: [],
    registered: 0,
    total: 0,
    completed: false,
    lastAttemptAt: null,
    vlmDeferred: false,
    skillsDeferred: false,
  };
  // Issue #2805: a null darkOutcomes (the fan-out could not run the dark-outcome
  // check) defaults to an empty array — honest-none, the dark-outcome rule
  // no-ops. Never a phantom populated verdict.
  const darkOutcomes = probes.darkOutcomes || [];
  // Issue #3251: a null reflectionOutcomesLiveness (the fan-out could not project
  // the retired-ledger probe) defaults to the `retired-empty` honest-none report
  // — the reflection-outcomes rule then fires the plain retirement INFO, never a
  // phantom alarm. Mirrors the darkOutcomes empty-array default above.
  const reflectionOutcomesLiveness: HealthSnapshot["reflectionOutcomesLiveness"] =
    probes.reflectionOutcomesLiveness || {
      verdict: "retired-empty",
      count: 0,
      latestEntryMs: null,
      ageMs: null,
      note: "Retired reflection-outcomes ledger is empty/absent (writer removed #1006, reader swept #1655) — expected.",
    };
  const ovSearch = probes.ovSearch || { status: "failed", latencyMs: null, resultCount: 0 };
  // Issue #2278: a rejected settle (probes.ollamaVlm === null) defaults to a
  // `down` result — honest-none (the whole probe settle failed), never a phantom
  // `ok`. carries a synthetic error so the operator can tell it apart from a real
  // transport failure surfaced by the probe itself.
  const ollamaVlm = probes.ollamaVlm || {
    status: "down" as const,
    latencyMs: 0,
    error: "probe settle rejected",
  };
  const redisInfo = probes.redisInfo ?? null;
  // Issue #744: emergency-brake state. Fail-safe to disengaged if the read
  // rejected (probes.emergencyBrake === null) so a Redis blip never reports a phantom brake.
  const emergencyBrake = probes.emergencyBrake || { engaged: false };

  // Issue #939: disk/mem arrive already parsed from the Host-Probe Adapter
  // (DiskUsage/MemUsage, or null on a probe failure). The zeroed default matches
  // the old "unparseable \u2192 all-zero" fallback, so every downstream disk/mem rule
  // sees the identical values.
  const disk = probes.disk || { availableGb: 0, totalGb: 0, usedPercent: 0 };
  const mem = probes.mem || { totalGb: 0, availableGb: 0, usedPercent: 0 };
  const sysdOrch = probes.sysdOrchestrator || "unknown",
    sysdWatch = probes.sysdWatchdog || "unknown",
    sysdWeb = probes.sysdTargetWeb || "unknown";

  // Pipeline metrics (issue #1936: derivation extracted to derivePipelineMetrics)
  const recent = derivePipelineMetrics(mData.trend || []);

  // Issue #2492: tally the reflection-deposit health verdict over the SAME
  // metrics-probe trend rows (each already carries a derived
  // `reflectionMatchSource` from getMetricsTrend/deriveReflectionMatchSource).
  // Pure — no new I/O, no writer; a rejected metrics settle (mData.trend absent)
  // yields the `no-data` verdict, never throws. The deep-health reflection rule
  // reads this off the snapshot as an info-only (never-alarm) diagnostic.
  const reflectionHealth = projectReflectionHealth(mData.trend || []);

  return {
    health,
    sched,
    svcProbes,
    queueDepth,
    blCounts,
    patterns,
    reflCount,
    attributionLedgerCount,
    reflectionHealth,
    skillCatalog,
    darkOutcomes,
    reflectionOutcomesLiveness,
    ovSearch,
    ollamaVlm,
    redisInfo,
    emergencyBrake,
    disk,
    mem,
    sysd: { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb },
    recent,
  };
}

// ---- assessHealth — the single entry point -------------------------------
//
// Runs every rule, collects the firings (in rule order), folds severity into
// `status`, and derives the `summary` banner — byte-for-byte identical to the
// inline logic the handler used to run.

export function assessHealth(snapshot: HealthSnapshot): HealthAssessment {
  const diagnostics: HealthDiagnostic[] = [];
  for (const rule of RULES) {
    const d = rule(snapshot);
    if (d) diagnostics.push(d);
  }

  let status: HealthAssessment["status"] = "healthy";
  if (diagnostics.some((d) => d.severity === "critical")) status = "critical";
  else if (diagnostics.some((d) => d.severity === "error")) status = "unhealthy";
  else if (diagnostics.length > 0) status = "degraded";

  let summary: string;
  if (status === "healthy") {
    summary = `All systems operational. Scheduler ${snapshot.sched.running ? "running" : "idle"}, uptime ${fmtUp(snapshot.health.uptime)}, ${snapshot.queueDepth} queued.`;
  } else {
    const c: Record<HealthSeverity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) c[d.severity]++;
    const ps: string[] = [];
    if (c.critical) ps.push(`${c.critical} critical`);
    if (c.error) ps.push(`${c.error} error${c.error > 1 ? "s" : ""}`);
    if (c.warning) ps.push(`${c.warning} warning${c.warning > 1 ? "s" : ""}`);
    if (c.info) ps.push(`${c.info} info`);
    summary = `${ps.join(", ")}. ${diagnostics[0]?.what || ""}`;
  }

  return { diagnostics, status, summary };
}

// ---- projectHealthDeepResponse — RELOCATED (issue #2039) -----------------
//
// The pure wire-projection (the data-OUT leg: HealthSnapshot + HealthAssessment
// → the `/health/deep` envelope) moved to the sibling `src/health/wire.ts` so
// this module's data-IN pipeline (`parseProbes`: ProbeInputs → HealthSnapshot)
// is independently testable without importing the wire projection or its
// `HealthDeepResponse` type. `parseProbes` (data-in) and projectHealthDeepResponse
// (data-out) have opposite data-flow directions — #2039 splits them along that
// internal boundary, mirroring the #1867 rules.ts extraction.
//
// The canonical type vocabulary (HealthSnapshot, ProbeInputs, ServiceProbe,
// HealthAssessment, HealthDiagnostic) stays HERE in one place; wire.ts
// type-imports it. The dependency direction is acyclic: this parse module imports
// nothing from wire.ts; wire.ts type-only-imports the vocabulary
// from here. src/api/health.ts now imports projectHealthDeepResponse +
// HealthDeepResponse from wire.ts and parseProbes/assessHealth/
// parseRedisInfoSnapshot from here.
