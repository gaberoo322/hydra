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

// ---- OV-search deep-health probe classification — RELOCATED (issue #2023) --
//
// The OV-search probe's status union (OvSearchProbeStatus), timeout ceiling
// (OV_SEARCH_PROBE_TIMEOUT_MS), private result-body shape (OvSearchResultBody),
// and pure classifier (classifyOvSearchProbe) used to live here. They are
// execution-side probe policy — mapping the OpenViking Request Adapter's
// discriminated result codes onto a probe-status — so #2023 moved them into the
// ServiceProbe Adapter Seam (src/health/probe.ts), next to
// probeService/probeOv/probeEmbedBackend. That eliminated the inverted edge
// where the adapter seam imported the timeout *value* from this IO-free assess
// seam. This module keeps ONLY a type-only import of OvSearchProbeStatus below
// (erased at compile time, zero runtime coupling) because
// HealthSnapshot.ovSearch.status still names that probe's result vocabulary.

// Issue #1867: the diagnostic rule set (`RULES`) and the `fmtUp` uptime
// humanizer were extracted into the sibling `rules.ts` so rule authoring
// is a one-file edit. `assessHealth` below is now a thin runner over the
// imported `RULES`; `fmtUp` is consumed here by both `assessHealth`'s summary
// banner and `projectHealthDeepResponse`'s `uptimeHuman` field. The structured
// types, parse pipeline, and wire projection all stay in this module.
import { RULES, fmtUp } from "./rules.ts";
// Issue #2023: type-only import — HealthSnapshot.ovSearch.status names the
// OV-search probe's result vocabulary, owned by the ServiceProbe Adapter Seam.
// `import type` is erased at compile time, so this is zero runtime coupling and
// does NOT re-create the value-import inversion the move removed.
import type { OvSearchProbeStatus, OllamaVlmProbeResult } from "./probe.ts";
// Issue #2386: type-only import — HealthSnapshot.skillCatalog carries the
// in-process OV skill-registration state so the two skill-catalog rules in
// rules.ts read it FROM the snapshot rather than calling getSkillCatalogState()
// out-of-band. `import type` is erased at compile time, so this is zero runtime
// coupling (mirroring the OvSearchProbeStatus type-only import above): the pure
// parse seam never imports the knowledge-base singleton as a value. The live
// read happens once, in collectProbeInputs (the fan-out I/O owner), exactly
// where every other in-process probe read already lives.
import type { SkillCatalogState } from "../knowledge-base/skill-registration.ts";

// Skill-catalog health gate moved to src/health/skill-catalog.ts (issue #1992).
// It described a separate concern — the Knowledge Base's in-process skill
// registration state — not a probe-marshalling input, so it now lives in its
// own focused module that type-imports `HealthDiagnostic` from here. Issue #2386:
// the catalog STATE itself now rides on HealthSnapshot.skillCatalog (assembled at
// fan-out time), so the rules read it from the snapshot like every other input.

// ---- Service Probe Map — the extensible external-service health record ----
//
// Issue #1869: `HealthSnapshot["svcProbes"]` used to be a hard-coded two-field
// struct (`{ vikingdb, openviking }`). Adding a third monitored service (e.g.
// the local Ollama embedding backend) meant edits in four places — the type,
// parseProbes' default, the wire projection, and the api/health.ts fan-out —
// plus a fifth in service-strip.ts. The field name named an implementation
// detail (a two-slot struct), not the domain concept: "the health of the
// external services the orchestrator depends on", a SET that can grow.
//
// Replacing the named duet with a string-keyed map concentrates the
// "what services exist" enumeration in the api/health.ts fan-out. The named
// keys (`"vikingdb"`, `"openviking"`) become map entries; diagnostic rules read
// `s.svcProbes["vikingdb"]?.status` via a keyed lookup that does NOT require a
// struct-field edit to add a new service. The on-wire field names in
// `/health/deep` are preserved for backward compatibility (out of scope per the
// issue): the projection reads the map by key.

/** One external-service probe result: liveness status + optional latency. */
export interface ServiceProbe {
  status: string;
  latencyMs?: number | null;
}

/**
 * The health of the external services the orchestrator depends on — an
 * extensible map keyed by service name (`"vikingdb"`, `"openviking"`, …) rather
 * than a fixed struct. Adding a new monitored service is a one-entry edit to the
 * api/health.ts probe fan-out (push a key + result), with no type, default, or
 * rule-set struct-field edits. A missing key reads `undefined` — rules guard
 * with optional chaining, so an absent probe is treated as "not failed".
 */
type ServiceProbeMap = Record<string, ServiceProbe>;

// ---- Health Snapshot — the normalized internal model ---------------------

export interface HealthSnapshot {
  health: { status: string; redis: boolean; cycle: string; uptime: number };
  sched: {
    running: boolean;
    cyclesRun?: number;
    cyclesMerged?: number;
    cyclesFailed?: number;
    mergeRate?: number;
    consecutiveErrors: number;
    lastError?: string | null;
    lastCycleAt?: string | null;
    intervalHuman?: string;
    research?: { lastResearchAt?: string | null };
  };
  // Issue #1869: extensible keyed map, not a fixed `{ vikingdb, openviking }`
  // struct — a new monitored service is a one-entry edit to the api/health.ts
  // fan-out, not a four-file struct-field change.
  svcProbes: ServiceProbeMap;
  queueDepth: number;
  blCounts: {
    triage: number;
    backlog: number;
    inProgress: number;
    blocked: number;
    done: number;
    total: number;
  };
  patterns: { planner: number; executor: number; skeptic: number };
  reflCount: number;
  // Issue #2386: the in-process OV skill-registration state (registered/total/
  // completed/skills/vlmDeferred), read live at fan-out time and carried here so
  // the two skill-catalog rules are pure over the snapshot — "what state did the
  // rules read?" is answerable from HealthSnapshot alone. Joins patterns/reflCount
  // as the other in-process (non-deep-probe) reads that flow through the pipeline.
  skillCatalog: SkillCatalogState;
  ovSearch: { status: OvSearchProbeStatus; latencyMs: number | null; resultCount: number };
  // Issue #2278: the Tailnet Ollama VLM host (gabes-desktop-1:11434) liveness
  // probe. A DIRECT reachability check of the host OpenViking uses for its
  // vision/indexing model — distinct from the OV-internal embed-backend probe.
  // `down` surfaces the recurring silent skill-catalog failure (#2277/#2269/…).
  ollamaVlm: OllamaVlmProbeResult;
  redisInfo: {
    memoryHuman: string;
    connectedClients: number;
    uptimeSeconds: number;
  } | null;
  emergencyBrake: { engaged: boolean; since?: number; engagedBy?: string };
  disk: { availableGb: number; totalGb: number; usedPercent: number };
  mem: { totalGb: number; availableGb: number; usedPercent: number };
  sysd: { orchestrator: string; watchdog: string; targetWeb: string };
  // Raw counts, NOT just rates — rules guard on mergedN>=3 and trend.length>=5.
  recent: {
    cycleCount: number;
    mergeRate: number;
    failedRate: number;
    noTaskRate: number;
    revertRate: number;
    mergedN: number;
    noTaskN: number;
    revertN: number;
    avgDurationMs: number;
    avgDurationHuman: string;
  };
}

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

// ---- Health Diagnostic — one finding -------------------------------------

type HealthSeverity = "critical" | "error" | "warning" | "info";

export interface HealthDiagnostic {
  severity: HealthSeverity;
  component: string;
  what: string;
  why: string;
  impact: string;
  action: string;
  autoRecovery: boolean;
}

// ---- Health Assessment — the folded result -------------------------------

export interface HealthAssessment {
  diagnostics: HealthDiagnostic[];
  status: "healthy" | "degraded" | "unhealthy" | "critical";
  summary: string;
}

// ---- ProbeInputs — named record replacing the integer-indexed settled array --
//
// Issue #1771: the GET /health/deep handler fans out 19 probes in a
// Promise.allSettled([]) positional array, then passed the raw settled array to
// parseProbes(), which extracted values by integer subscript (settled[0]...[16]).
// The integer subscripts were a shared secret between api/health.ts and
// diagnostics.ts documented only in comments.
//
// Fix: the handler's assembleProbeInputs() (in api/health.ts, the I/O owner)
// maps the settled results into this named record immediately after the fan-out,
// then passes it to parseProbes() and projectHealthDeepResponse(). Only the
// named-record TYPE lives here in the pure seam (#840); the integer-indexed
// mapping stays in the I/O handler. Adding a probe is now a new named field —
// the compiler enforces that the builder (api/health.ts) and both consumers
// agree by name.
//
// Index 3 (cycle) is handler-only and not part of ProbeInputs.
//
// Issue #1833: every field below carries the shape its probe actually produces,
// `| null` for the rejected-settle case (assembleProbeInputs' `val()` returns
// null when a settle rejected). The field types are the SAME shapes parseProbes
// already reasons about via its `|| default` reads and projectHealthDeepResponse
// reads — they reuse the local HealthSnapshot sub-shapes so the pure seam stays
// import-free (no coupling back to the I/O-layer producer modules), keeping the
// dependency direction #840/#1771 established. A probe field renamed on the I/O
// side (api/health.ts) is now a compile error at assembleProbeInputs rather than
// a silent runtime miss caught only by a `|| default`.

/**
 * The two persisted-metrics fields parseProbes' `recent` pipeline reads off the
 * index-6 metrics probe. Only `trend` is consumed (the per-cycle rollup rows);
 * `stats` rides along from getAggregateStats but no rule reads it, so it stays
 * loosely typed. Each trend row's numeric fields arrive as strings (Redis hash
 * values) — parseProbes coerces with parseInt — so they're typed string|number.
 */
interface ProbeMetricsInput {
  trend?: Array<{
    tasksMerged?: string | number;
    tasksFailed?: string | number;
    taskTitle?: string;
    rolledBack?: string | boolean;
    totalDurationMs?: string | number;
  }>;
  stats?: unknown;
}

export interface ProbeInputs {
  basicHealth: HealthSnapshot["health"] | null;
  serviceProbes: HealthSnapshot["svcProbes"] | null;
  scheduler: HealthSnapshot["sched"] | null;
  queueDepth: number | null;
  backlogCounts: HealthSnapshot["blCounts"] | null;
  metrics: ProbeMetricsInput | null;
  disk: HealthSnapshot["disk"] | null;
  mem: HealthSnapshot["mem"] | null;
  sysdOrchestrator: string | null;
  sysdWatchdog: string | null;
  sysdTargetWeb: string | null;
  patterns: HealthSnapshot["patterns"] | null;
  reflections: number | null;
  // Issue #2386: the in-process OV skill-catalog state, read synchronously at
  // fan-out time (NOT a Promise.allSettled probe — it is a pure in-memory copy,
  // never I/O). `| null` so a fan-out that cannot resolve it degrades to the
  // parseProbes safe default (an un-run, empty catalog → the two skill-catalog
  // rules no-op) exactly as a rejected async probe would.
  skillCatalog: HealthSnapshot["skillCatalog"] | null;
  ovSearch: HealthSnapshot["ovSearch"] | null;
  // Issue #2278: the Tailnet Ollama VLM host liveness probe result. `| null` on a
  // rejected settle (the never-throwing probe folds its own failures to a `down`
  // result, so null only ever means the whole settle rejected upstream).
  ollamaVlm: HealthSnapshot["ollamaVlm"] | null;
  redisInfo: HealthSnapshot["redisInfo"];
  emergencyBrake: HealthSnapshot["emergencyBrake"] | null;
  // Indices 17/18: consumed by projectHealthDeepResponse for OV quality trends.
  // projectHealthDeepResponse passes both straight onto the wire as `unknown`
  // (ovSearchTrend/knowledgeContext) — the persisted-rollup shapes live in the
  // I/O-layer ov-search-metrics module, so they stay `unknown` here to avoid
  // importing that producer type into the pure seam.
  ovSearchWindow: unknown;
  knowledgeContext: unknown;
}

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

  return {
    health,
    sched,
    svcProbes,
    queueDepth,
    blCounts,
    patterns,
    reflCount,
    skillCatalog,
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
