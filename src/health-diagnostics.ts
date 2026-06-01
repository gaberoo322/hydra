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
  ovSearch: { status: string; latencyMs: number | null; resultCount: number };
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

export type HealthSeverity = "critical" | "error" | "warning" | "info";

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

// ---- parseProbes — owns disk/mem regex + recent derivation ---------------
//
// Maps the raw `Promise.allSettled` results from the handler's probe fan-out
// into a HealthSnapshot. Indices match the handler's settled array exactly:
//   0 basic health, 1 service probes, 2 scheduler, 3 cycle, 4 queue depth,
//   5 backlog counts, 6 metrics {trend,stats}, 7 df, 8 free,
//   9 systemd orchestrator, 10 systemd watchdog, 11 systemd target web,
//   12 patterns, 13 reflections, 14 ov search, 15 redis info, 16 brake.

type SettledLike = Array<{ status: "fulfilled" | "rejected"; value?: any; reason?: any }>;

export function parseProbes(settled: SettledLike): HealthSnapshot {
  const val = (i: number) =>
    settled[i] && settled[i].status === "fulfilled" ? (settled[i] as any).value : null;

  const health = val(0) || { status: "failed", redis: false, cycle: "unknown", uptime: 0 };
  const svcProbes = val(1) || {
    vikingdb: { status: "failed" },
    openviking: { status: "failed" },
  };
  const sched = val(2) || {
    running: false,
    cyclesRun: 0,
    cyclesMerged: 0,
    cyclesFailed: 0,
    mergeRate: 0,
    consecutiveErrors: 0,
  };
  const queueDepth = val(4) || 0;
  const blCounts = val(5) || {
    triage: 0,
    backlog: 0,
    inProgress: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };
  const mData = val(6) || { trend: [], stats: {} };
  const patterns = val(12) || { planner: 0, executor: 0, skeptic: 0 };
  const reflCount = val(13) || 0;
  const ovSearch = val(14) || { status: "failed", latencyMs: null, resultCount: 0 };
  const redisInfo = val(15);
  // Issue #744: emergency-brake state. Fail-safe to disengaged if the read
  // rejected (val(16) === null) so a Redis blip never reports a phantom brake.
  const emergencyBrake = val(16) || { engaged: false };

  // Parse disk
  let disk = { availableGb: 0, totalGb: 0, usedPercent: 0 };
  const diskRaw = val(7);
  if (diskRaw?.stdout) {
    const dl = diskRaw.stdout.trim().split("\n").pop()?.trim();
    if (dl) {
      const p = dl.split(/\s+/);
      disk = {
        availableGb: Math.round((parseInt(p[0] || "0") / 1073741824) * 10) / 10,
        totalGb: Math.round((parseInt(p[1] || "0") / 1073741824) * 10) / 10,
        usedPercent: parseInt((p[2] || "0").replace("%", "")) || 0,
      };
    }
  }
  // Parse memory
  let mem = { totalGb: 0, availableGb: 0, usedPercent: 0 };
  const memRaw = val(8);
  if (memRaw?.stdout) {
    const ml = memRaw.stdout.split("\n").find((l: string) => l.startsWith("Mem:"));
    if (ml) {
      const p = ml.split(/\s+/);
      const t = parseInt(p[1]) || 0,
        a = parseInt(p[6]) || 0;
      mem = {
        totalGb: Math.round((t / 1073741824) * 10) / 10,
        availableGb: Math.round((a / 1073741824) * 10) / 10,
        usedPercent: t > 0 ? Math.round((1 - a / t) * 100) : 0,
      };
    }
  }
  const sysdOrch = val(9) || "unknown",
    sysdWatch = val(10) || "unknown",
    sysdWeb = val(11) || "unknown";

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
          action: "systemctl --user start hydra-orchestrator-watchdog.timer",
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
