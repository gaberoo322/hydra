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

// ---- OV-search deep-health probe — timeout + failure classification ------
//
// Issue #1032: the index-14 `/api/v1/search/find` probe in `src/api/health.ts`
// was false-negativing `status:"failed"` (`latencyMs:null`) while OpenViking
// was fully healthy. Root cause: after #980 repointed OV's dense embedding to
// the gaming-PC Ollama (`nomic-embed-text`, 768-dim) over Tailscale, the
// query-embedding step incurs Tailnet RTT + local model inference and
// routinely exceeds the probe's old 3000ms `AbortSignal` ceiling. A timeout is
// classified by the OV Request Adapter as `ov-timeout` (distinct from the
// `ov-non-2xx` a real 5xx produces), so a slow-but-working plane was being
// reported as a hard failure — the inverse of the now-closed #985.
//
// Two changes close it:
//   1) raise the probe ceiling to OV_SEARCH_PROBE_TIMEOUT_MS so a healthy
//      Ollama-backed search completes inside the window and reports `running`
//      with its true latency, and
//   2) when the probe DOES still exhaust the (now generous) window, classify
//      it as a distinct `"timeout"` status — NOT `"failed"` — so a slow plane
//      is surfaced honestly instead of masquerading as a 5xx. Only a real
//      `ov-non-2xx` (OV reachable but search 500ing) or transport failure
//      (`ov-service-down`) folds to `"failed"`.

/**
 * The wire/snapshot status the OV-search deep-health probe can report.
 *  - `running` — `search/find` returned 200 (the true plane state).
 *  - `failed`  — OV reachable but search 5xx'd (`ov-non-2xx`), or a 2xx body
 *                failed to parse (`ov-malformed-json`). OV itself is up; its
 *                search path is broken. A genuine fault.
 *  - `timeout` — the probe exhausted its window (`ov-timeout`); the plane is
 *                likely working-but-slow (real agent searches have no 3s cap),
 *                so this is reported distinctly and treated as informational.
 *  - `backend-unreachable` — the search transport never completed a round-trip
 *                (`ov-service-down`: DNS/ECONNREFUSED/network). Issue #1781: the
 *                graceful-degradation signal distinct from `failed`. The
 *                `search/find` path is the one that exercises the embedding
 *                backend, so a transport failure on it — while the OV liveness
 *                probe may report differently — points the operator at the
 *                embedding/inference backend (the post-#1795 local
 *                `ollama-embed` service, or the Tailnet VLM host for indexing),
 *                NOT at an OV-internal 5xx. Collapsing it into `failed` was the
 *                indistinguishability #1781 exists to fix.
 */

// Issue #1867: the diagnostic rule set (`RULES`) and the `fmtUp` uptime
// humanizer were extracted into the sibling `health-rules.ts` so rule authoring
// is a one-file edit. `assessHealth` below is now a thin runner over the
// imported `RULES`; `fmtUp` is consumed here by both `assessHealth`'s summary
// banner and `projectHealthDeepResponse`'s `uptimeHuman` field. The structured
// types, parse pipeline, and wire projection all stay in this module.
import { RULES, fmtUp } from "./health-rules.ts";

export type OvSearchProbeStatus =
  | "running"
  | "failed"
  | "timeout"
  | "backend-unreachable";

/**
 * OV-search deep-health probe `AbortSignal` ceiling (ms).
 *
 * Sized for the post-#980 Ollama-backed dense-embedding path
 * (`nomic-embed-text`, 768-dim, reached over Tailscale): query-embedding +
 * Tailnet RTT routinely pushes a warm `search/find` past the old 3000ms cap.
 * 15s matches the most generous existing OV timeout in the codebase
 * (`ov-search.ts`'s session-message POST) and gives the cold-embedding case
 * ample headroom while still bounding the deep-health fan-out. The real agent
 * search path uses 5000ms and has no probe; this ceiling exists only so a slow
 * plane reports `running`/`timeout` rather than a false `failed`.
 */
export const OV_SEARCH_PROBE_TIMEOUT_MS = 15_000;

/**
 * The shape of an OV `search/find` result body the probe counts hits from.
 * Optional everywhere — the probe coalesces missing arrays to 0.
 */
interface OvSearchResultBody {
  result?: {
    memories?: unknown[];
    resources?: unknown[];
    skills?: unknown[];
  };
}

/**
 * Pure classifier for the index-14 OV-search probe. Maps the OV Request Adapter
 * result (already discriminated by `code`) onto the `ovSearch` snapshot shape.
 *
 * Kept pure + exported so the timeout-vs-real-failure logic (#1032) is unit
 * testable without standing up `fetch`/OpenViking: a slow probe that times out
 * must report `"timeout"` (carrying its measured latency, not `null`) and a
 * genuine 5xx/transport fault must still report `"failed"`.
 *
 * @param result discriminated OV result for `POST /api/v1/search/find`.
 * @param latencyMs wall-clock ms the probe took (measured by the caller).
 */
export function classifyOvSearchProbe(
  result:
    | { ok: true; data: OvSearchResultBody | null | undefined }
    | { ok: false; code: string },
  latencyMs: number,
): { status: OvSearchProbeStatus; latencyMs: number | null; resultCount: number } {
  if (result.ok === false) {
    // `ov-timeout` is a slow-but-likely-working plane, not a fault: surface it
    // distinctly and KEEP the measured latency so the deep-health view shows how
    // long the (uncapped, in real use) embedding path is actually taking.
    if (result.code === "ov-timeout") {
      return { status: "timeout", latencyMs, resultCount: 0 };
    }
    // Issue #1781: `ov-service-down` is a transport failure — the request never
    // reached OV's search handler (DNS/ECONNREFUSED/network). Because the
    // `search/find` path is the one that exercises the embedding backend, this
    // is the distinct, operator-actionable "embedding backend unreachable"
    // signal — NOT a generic OV-internal 5xx. Keep it separate from `failed` so
    // the diagnostic can point the operator at the backend host rather than at
    // OpenViking itself. No round-trip completed, so latency is meaningless → null.
    if (result.code === "ov-service-down") {
      return { status: "backend-unreachable", latencyMs: null, resultCount: 0 };
    }
    // `ov-non-2xx` reached OV but search 5xx'd — a real OV-internal fault; keep
    // its latency. `ov-malformed-json` round-tripped a 2xx but the body was
    // garbage, so `latencyMs` would be meaningless → null.
    return {
      status: "failed",
      latencyMs: result.code === "ov-non-2xx" ? latencyMs : null,
      resultCount: 0,
    };
  }
  const rs = result.data?.result || {};
  return {
    status: "running",
    latencyMs,
    resultCount:
      (rs.memories?.length || 0) + (rs.resources?.length || 0) + (rs.skills?.length || 0),
  };
}

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
  svcProbes: {
    vikingdb: { status: string; latencyMs?: number | null };
    openviking: { status: string; latencyMs?: number | null };
  };
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
  ovSearch: { status: OvSearchProbeStatus; latencyMs: number | null; resultCount: number };
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
// health-diagnostics.ts documented only in comments.
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
export interface ProbeMetricsInput {
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
  ovSearch: HealthSnapshot["ovSearch"] | null;
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
  const svcProbes = probes.serviceProbes || {
    vikingdb: { status: "failed" },
    openviking: { status: "failed" },
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
  const ovSearch = probes.ovSearch || { status: "failed", latencyMs: null, resultCount: 0 };
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
    ovSearch,
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

// ---- projectHealthDeepResponse — the pure wire-projection ----------------
//
// Issue #1513: the third leg of the Snapshot pipeline, lifted out of the inline
// `res.json({...})` block in the `GET /health/deep` route handler. #840 already
// pulled the parse (`parseProbes`) and assessment (`assessHealth`) halves behind
// this seam; the wire projection was still inline and only reachable via Express
// supertest. This maps a HealthSnapshot + HealthAssessment (already typed) into
// the documented `/health/deep` wire envelope — byte-identically — so the field
// names and settled-index subscripts (`ovSearchTrend` not `ovSeachTrend`,
// settled[17] vs [18]) are unit-testable without standing up Redis/OpenViking.
//
// The handler keeps ONLY the I/O fan-out and the `activeCycle` derivation from
// settled[3] (a vestigial HTTP-layer concern, out of scope per the issue); the
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
    vikingdb: HealthSnapshot["svcProbes"]["vikingdb"];
    openviking: HealthSnapshot["svcProbes"]["openviking"];
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
  const { health, svcProbes, sched, queueDepth, blCounts, patterns, reflCount, ovSearch, redisInfo, emergencyBrake, disk, mem, recent } = snapshot;
  const { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb } = snapshot.sysd;

  // Issue #1440: coalesce the two persisted OV-quality reads.
  // A rejected settle (Redis error) becomes null — surfaced as absent trend
  // data, never a 500. parseProbes stops at emergencyBrake, so these arrive
  // via the ProbeInputs named fields ovSearchWindow/knowledgeContext.
  const ovSearchWindow = probes.ovSearchWindow ?? null;
  const ovContextAvailability = probes.knowledgeContext ?? null;

  return {
    status, summary, checkedAt,
    services: {
      orchestrator: { status: health.status === "ok" ? "running" : health.status, uptime: health.uptime, uptimeHuman: fmtUp(health.uptime), cycle: health.cycle },
      redis: { status: health.redis ? "running" : "failed", memoryHuman: redisInfo?.memoryHuman || null, connectedClients: redisInfo?.connectedClients || null, uptimeSeconds: redisInfo?.uptimeSeconds || null },
      scheduler: { status: sched.running ? "running" : (sched.consecutiveErrors >= 5 ? "failed" : "idle"), intervalHuman: sched.intervalHuman, cyclesRun: sched.cyclesRun, cyclesMerged: sched.cyclesMerged || 0, cyclesFailed: sched.cyclesFailed || 0, mergeRate: sched.mergeRate || 0, consecutiveErrors: sched.consecutiveErrors, lastError: sched.lastError, lastCycleAt: sched.lastCycleAt, research: { lastResearchAt: sched.research?.lastResearchAt || null } },
      vikingdb: svcProbes.vikingdb, openviking: svcProbes.openviking,
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
