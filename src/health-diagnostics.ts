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

export interface ProbeInputs {
  basicHealth: any;
  serviceProbes: any;
  scheduler: any;
  queueDepth: any;
  backlogCounts: any;
  metrics: any;
  disk: any;
  mem: any;
  sysdOrchestrator: any;
  sysdWatchdog: any;
  sysdTargetWeb: any;
  patterns: any;
  reflections: any;
  ovSearch: any;
  redisInfo: any;
  emergencyBrake: any;
  // Indices 17/18: consumed by projectHealthDeepResponse for OV quality trends
  ovSearchWindow: any;
  knowledgeContext: any;
}

// ---- parseProbes — owns the `recent` pipeline derivation ----------------
//
// Maps the ProbeInputs named record into a HealthSnapshot. Each field is
// named after the probe it carries — no integer subscripts, no shared-secret
// index table. A null field means the probe failed (rejected settle); safe
// defaults apply identically to the prior implementation.

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

  // Pipeline metrics
  const trend = mData.trend || [];
  const mergedN = trend.filter((m: any) => parseInt(m.tasksMerged || 0) > 0).length;
  const noTaskN = trend.filter(
    (m: any) =>
      m.taskTitle === "Planner produced no task" || (m.taskTitle || "").startsWith("Skipped:"),
  ).length;
  const revertN = trend.filter((m: any) => m.rolledBack === "true" || m.rolledBack === true).length;
  const durs = trend.map((m: any) => parseInt(m.totalDurationMs || 0)).filter((d: number) => d > 0);
  const avgDur =
    durs.length > 0 ? Math.round(durs.reduce((a: number, b: number) => a + b, 0) / durs.length) : 0;
  const recent = {
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

// ---- The ruleset ----------------------------------------------------------
//
// Each rule reads the snapshot and returns a HealthDiagnostic when it fires,
// else null. Adding a rule = append one fn here. Ordering is array order, so
// the resulting `diagnostics` list preserves the same order the inline
// if-ladder produced (load-bearing: `summary` quotes `diagnostics[0].what`).
// Thresholds stay inline in each rule — co-located = locality.

const RULES: Array<(s: HealthSnapshot) => HealthDiagnostic | null> = [
  (s) =>
    s.health.status === "killed"
      ? {
          severity: "critical",
          component: "orchestrator",
          what: "Kill switch is active",
          why: "A kill file blocks all cycles until removed.",
          impact: "No cycles can run.",
          action: "Investigate, then: rm ~/hydra/.kill",
          autoRecovery: false,
        }
      : null,
  // Issue #744: operator-only emergency brake engaged. Surfaced as a
  // warning (not critical) — it's a deliberate operator action, not a fault,
  // but it suppresses ALL auto-merge so it must be visible until released.
  (s) =>
    s.emergencyBrake.engaged
      ? {
          severity: "warning",
          component: "autopilot",
          what: "EMERGENCY BRAKE ENGAGED",
          why: `Operator pulled the emergency brake${s.emergencyBrake.engagedBy ? ` (${s.emergencyBrake.engagedBy})` : ""}. All auto-merge is paused and open PRs are routed to /hydra-review.`,
          impact: "No PR auto-merges until the brake is released.",
          action: "When the incident is resolved: hydra brake off",
          autoRecovery: false,
        }
      : null,
  (s) =>
    !s.health.redis
      ? {
          severity: "critical",
          component: "redis",
          what: "Redis disconnected",
          why: "Redis is the sole state store. Without it, cycles, backlog, memory, and metrics are unavailable.",
          impact: "All operations fail.",
          action: "docker exec hydra-redis-1 redis-cli ping",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.sched.consecutiveErrors >= 5
      ? {
          severity: "error",
          component: "scheduler",
          what: `Auto-stopped after ${s.sched.consecutiveErrors} errors`,
          why: `Last: "${s.sched.lastError || "unknown"}". Pauses at 5 to prevent runaway spend.`,
          impact: "No autonomous cycles.",
          action: "Check logs, then POST /api/scheduler/start",
          autoRecovery: false,
        }
      : !s.sched.running && (s.queueDepth > 0 || s.blCounts.total > 0)
        ? {
            severity: "error",
            component: "scheduler",
            what: "Stopped but work exists",
            why: `${s.queueDepth} queue + ${s.blCounts.total} backlog items waiting.`,
            impact: "Queue growing stale.",
            action: "POST /api/scheduler/start",
            autoRecovery: false,
          }
        : null,
  (s) =>
    s.disk.availableGb > 0 && s.disk.availableGb < 5
      ? {
          severity: "error",
          component: "disk",
          what: `Disk critical: ${s.disk.availableGb}GB free`,
          why: `NVMe at ${s.disk.usedPercent}%. Operations fail below ~2GB.`,
          impact: "Cycle failures.",
          action: "Clean Docker images or move to /mnt/hydra-ssd",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.mem.usedPercent > 95
      ? {
          severity: "error",
          component: "memory",
          what: `Memory critical: ${s.mem.availableGb}GB free`,
          why: "OOM killer may terminate processes.",
          impact: "Crashes.",
          action: "top -o %MEM",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.recent.revertRate > 30 && s.recent.mergedN >= 3
      ? {
          severity: "error",
          component: "pipeline",
          what: `High revert rate: ${s.recent.revertRate}%`,
          why: `${s.recent.revertN}/${s.recent.mergedN} merges reverted. Executor breaking existing tests.`,
          impact: "No forward progress.",
          action: "Review executor feedback, check flaky tests",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.sched.consecutiveErrors > 0 && s.sched.consecutiveErrors < 5
      ? {
          severity: "warning",
          component: "scheduler",
          what: `${s.sched.consecutiveErrors} consecutive error(s)`,
          why: `Auto-stops at 5. Last: "${s.sched.lastError || "unknown"}"`,
          impact: "May stop soon.",
          action: "Monitor next cycles",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.disk.availableGb >= 5 && s.disk.availableGb < 20 && s.disk.totalGb > 0
      ? {
          severity: "warning",
          component: "disk",
          what: `Disk low: ${s.disk.availableGb}GB free (${s.disk.usedPercent}%)`,
          why: "Below 20GB safety margin.",
          impact: "Heavy ops may fail.",
          action: "Clean old artifacts",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.mem.usedPercent > 85 && s.mem.usedPercent <= 95
      ? {
          severity: "warning",
          component: "memory",
          what: `Memory elevated: ${s.mem.usedPercent}%`,
          why: `${s.mem.availableGb}GB free of ${s.mem.totalGb}GB.`,
          impact: "OOM risk under load.",
          action: "Check resource-heavy processes",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.svcProbes.openviking.status === "failed"
      ? {
          severity: "warning",
          component: "openviking",
          what: "OpenViking unreachable",
          why: "Agents run without knowledge context, reducing quality.",
          impact: "Degraded quality.",
          action: "curl http://localhost:1933/health",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.svcProbes.vikingdb.status === "failed"
      ? {
          severity: "warning",
          component: "vikingdb",
          what: "VikingDB unreachable",
          why: "Embeddings storage down. Indexing and search fail.",
          impact: "Knowledge inoperative.",
          action: "docker ps | grep viking",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.queueDepth === 0 && s.blCounts.total === 0 && s.health.cycle !== "running"
      ? {
          severity: "warning",
          component: "pipeline",
          what: "Pipeline empty",
          why: "No queue or backlog. Falls back to priorities.md or research.",
          impact: "May idle.",
          action: "Add items or trigger research",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.recent.noTaskRate > 40 && s.recent.cycleCount >= 5
      ? {
          severity: "warning",
          component: "pipeline",
          what: `No-task rate: ${s.recent.noTaskRate}%`,
          why: `Planner failed in ${s.recent.noTaskN}/${s.recent.cycleCount} cycles. Items may be stale.`,
          impact: "~$1.55 wasted per cycle.",
          action: "Clean queue, update priorities",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.blCounts.blocked > 0
      ? {
          severity: "warning",
          component: "pipeline",
          what: `${s.blCounts.blocked} blocked item(s)`,
          why: "Need operator action.",
          impact: "Work stalled.",
          action: "Review on Backlog page",
          autoRecovery: false,
        }
      : null,
  // The dollar-based daily-spend cap diagnostic was retired with the
  // Subscription Usage Tracker. The new gate fires through the autopilot
  // (see /api/usage and /api/usage/eligibility), not the scheduler.
  (s) =>
    s.recent.mergeRate < 40 && s.recent.cycleCount >= 5
      ? {
          severity: "warning",
          component: "pipeline",
          what: `Low merge rate: ${s.recent.mergeRate}%`,
          why: `${s.recent.mergedN}/${s.recent.cycleCount} merged. Tasks too ambitious or failing.`,
          impact: "Slow progress.",
          action: "Narrow scope, review feedback",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.sysd.watchdog !== "active"
      ? {
          severity: "warning",
          component: "infrastructure",
          what: "Watchdog inactive",
          why: `Status: "${s.sysd.watchdog}". No auto-restart on hangs.`,
          impact: "No auto-recovery.",
          action: "systemctl --user start hydra-watchdog.timer",
          autoRecovery: false,
        }
      : null,
  (s) => {
    if (s.sched.running && s.sched.lastCycleAt) {
      const ss = (Date.now() - new Date(s.sched.lastCycleAt).getTime()) / 1000;
      if (ss > 900 && s.health.cycle !== "running") {
        return {
          severity: "info",
          component: "scheduler",
          what: `Idle ${Math.round(ss / 60)}m`,
          why: "Scheduler active but no recent cycle. May be paused.",
          impact: "May resume.",
          action: "Check status",
          autoRecovery: true,
        };
      }
    }
    return null;
  },
  (s) =>
    s.patterns.planner === 0 && s.patterns.executor === 0 && s.patterns.skeptic === 0
      ? {
          severity: "info",
          component: "intelligence",
          what: "No learned patterns",
          why: "Normal for fresh deployments.",
          impact: "Agents run without lessons.",
          action: "Accumulates automatically",
          autoRecovery: true,
        }
      : null,
  (s) =>
    s.ovSearch.status === "running" && s.ovSearch.resultCount === 0
      ? {
          severity: "info",
          component: "intelligence",
          what: "OV search empty",
          why: "Service up but index may be empty.",
          impact: "No knowledge context.",
          action: "Check indexer",
          autoRecovery: false,
        }
      : null,
  (s) =>
    s.ovSearch.status === "failed"
      ? {
          severity: "warning",
          component: "intelligence",
          what: "OV search failing",
          why: "Knowledge-plane search probe returned an error (OpenViking up but search 500ing — usually its LLM/embedding backend is down).",
          impact: "Agents run cycles with empty knowledge context.",
          action: "Check OpenViking + its LLM/embedding backend (#980).",
          autoRecovery: false,
        }
      : null,
  // Issue #1781: the search transport never reached OpenViking — distinct from a
  // 5xx (`failed`) and from a slow plane (`timeout`). The `search/find` path is
  // what exercises the embedding backend, so a transport failure here points at
  // the dense-embedding service (post-#1795 the local `ollama-embed` container)
  // or, for indexing, the Tailnet VLM host — NOT at OpenViking itself. Surface a
  // distinct, actionable warning so the operator checks the right hop. searchKnowledge
  // still returns empty (never throws), so this degrades quality, it does not crash cycles.
  (s) =>
    s.ovSearch.status === "backend-unreachable"
      ? {
          severity: "warning",
          component: "intelligence",
          what: "OV embedding backend unreachable",
          why: "Knowledge-plane search transport never reached OpenViking (DNS/connection-refused/timeout on the embedding-exercising search path). OpenViking may be up while its embedding backend is unreachable.",
          impact: "Search returns empty — agents run cycles with no knowledge context until the backend recovers.",
          action: "Check the dense-embedding service: docker exec hydra-openviking-1 curl -m5 http://ollama-embed:11434/api/tags (and the Tailnet VLM host gabes-desktop-1:11434 if indexing). See OpenViking embedding/VLM backend split in docs/reference.md.",
          autoRecovery: true,
        }
      : null,
  // Issue #1032: a probe TIMEOUT is NOT a fault — the Ollama-backed embedding
  // path is just slow, and real agent searches (no 3s cap) succeed. Surface it
  // as info so a slow-but-working plane is visible without folding the top-level
  // status to `degraded` the way the `failed` warning above does.
  (s) =>
    s.ovSearch.status === "timeout"
      ? {
          severity: "info",
          component: "intelligence",
          what: "OV search slow",
          why: "Search probe exceeded its deep-health timeout but did not error — the Ollama-backed embedding path (nomic-embed over Tailscale, #980) is slow, not down. Real agent searches have no such cap and succeed.",
          impact: "None on agents; the deep-health probe latency is just high.",
          action: "Monitor; raise OV_SEARCH_PROBE_TIMEOUT_MS if it persists.",
          autoRecovery: true,
        }
      : null,
];

// ---- assessHealth — the single entry point -------------------------------
//
// Runs every rule, collects the firings (in rule order), folds severity into
// `status`, and derives the `summary` banner — byte-for-byte identical to the
// inline logic the handler used to run.

function fmtUp(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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
