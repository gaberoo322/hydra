// Health Diagnostic Rules (issue #1867)
//
// The diagnostic rule set extracted from `src/health-diagnostics.ts` so the
// rule-authoring surface is one focused file: open this module, append a
// function literal to the `RULES` array. Each rule reads a Health Snapshot and
// returns a Health Diagnostic when it fires, else null. The parse pipeline,
// wire projection, and the structured-type definitions stay in
// `health-diagnostics.ts`; this module only consumes the `HealthSnapshot` /
// `HealthDiagnostic` types from that seam.
//
// `assessHealth` (still in `health-diagnostics.ts`) imports `RULES` and runs
// each rule in array order — see the runner there. Ordering is load-bearing:
// `summary` quotes `diagnostics[0].what`, so RULES order is the diagnostics
// order. Thresholds stay inline in each rule — co-located = locality.

import type { HealthSnapshot, HealthDiagnostic } from "./health-diagnostics.ts";
import { assessSkillCatalog } from "./health-skill-catalog.ts";
// Issue #1968: the OV skill-catalog state is in-process module state populated by
// startup `registerSkills` (resets on restart), NOT a deep-health probe — so it
// is read directly here rather than carried on the HealthSnapshot. The skill-rule
// below ignores its `s` argument and reads `getSkillCatalogState()`; that read is
// a pure, never-throw copy of an in-memory singleton (no Redis/OV I/O), so the
// rule stays side-effect-free even though it doesn't source from the snapshot.
import { getSkillCatalogState } from "./knowledge-base/skill-registration.ts";

// Issue #2013: service-probe keys that already have a bespoke diagnostic rule
// (with a tailored why/impact/action) earlier in RULES. The generic
// "external service not running" iterator rule skips these so a degraded service
// is reported exactly once — by its bespoke rule — never doubled. Any monitored
// service NOT listed here (e.g. the #2013 "embed-backend" key) is covered by the
// generic rule with zero per-service code.
const SVC_PROBES_WITH_BESPOKE_RULES = new Set(["openviking", "vikingdb"]);

export const RULES: Array<(s: HealthSnapshot) => HealthDiagnostic | null> = [
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
    s.svcProbes["openviking"]?.status === "failed"
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
    s.svcProbes["vikingdb"]?.status === "failed"
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
  // Issue #2013: a SINGLE generic "external service not running" rule that
  // iterates the keyed ServiceProbeMap (#1869) and fires for any monitored
  // service in a non-running state that does NOT already have a bespoke rule
  // above. This is the point of the #1869 map iterator: adding a new monitored
  // service (e.g. the #2013 "embed-backend" entry) needs ZERO new rule code —
  // it is covered automatically here, with no per-service duplication. The two
  // services with tailored action strings (openviking, vikingdb) keep their
  // bespoke rules and are excluded here so a service is never double-reported.
  // A status of "running" (or a missing key, which optional chaining leaves
  // undefined) does not fire.
  (s) => {
    for (const [name, probe] of Object.entries(s.svcProbes)) {
      if (SVC_PROBES_WITH_BESPOKE_RULES.has(name)) continue;
      if (probe?.status && probe.status !== "running") {
        return {
          severity: "warning",
          component: name,
          what: `External service "${name}" not running`,
          why: `The ${name} probe reported status "${probe.status}" instead of "running".`,
          impact: "A dependency the orchestrator monitors is degraded or unreachable.",
          action: `Check the ${name} service and its backing host/container.`,
          autoRecovery: true,
        };
      }
    }
    return null;
  },
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
  // Issue #1968: surface the silent empty/partial OV skill catalog through the
  // deep-health Health Assessment fold so an operator watching /api/health/deep
  // (or hydra-doctor) sees it — the standalone /api/health/skills endpoint is a
  // supplementary detail view, but only this rule folds the failure into the
  // top-level `status` and `diagnostics` array. The `_s` snapshot argument is
  // unused: skill-catalog state is in-process module state, not a deep-health
  // probe, so it's read directly via getSkillCatalogState() (a pure, never-throw
  // in-memory read). assessSkillCatalog already maps empty → severity:"error",
  // partial → severity:"warning", and ok/in-flight → diagnostic:null, so this
  // rule is a thin pass-through of that gate's diagnostic.
  (_s) => assessSkillCatalog(getSkillCatalogState()).diagnostic,
];

// ---- fmtUp — uptime humanizer shared by assessHealth + the wire projection -
//
// Pure seconds → "Hh Mm" / "Mm" formatter. Lives here alongside RULES (the
// rule-authoring surface) and is imported back by `health-diagnostics.ts`,
// where both `assessHealth`'s healthy-summary banner and
// `projectHealthDeepResponse`'s `uptimeHuman` field consume it.
export function fmtUp(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
