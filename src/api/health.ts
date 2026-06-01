import { Router } from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { getMetricsTrend } from "../metrics/trend.ts";
import { getAggregateStats } from "../metrics/aggregate.ts";
import { getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import { getBacklogCounts } from "../backlog/reads.ts";
import { getMemoryPatterns } from "../redis/agent-memory.ts";
import { redisInfo as getRedisInfo } from "../redis/utility.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import { countReflectionKeys } from "../redis/reflections.ts";
import { getTargetServiceName } from "../target-config.ts";
// Issue #231: shared OV credential — health probe must use the same key as agent searches.
import { OPENVIKING_API_KEY } from "../knowledge-base/ov-config.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

// Issue #734 (deploy-drift backstop): expose the SHA the orchestrator is
// running from so the watchdog (and operators) can compare it against
// origin/master HEAD. This is a pure read — `git rev-parse HEAD` against
// $HYDRA_ROOT, which deploy.sh leaves checked out on master. Cached for 60s
// so the per-2-minute watchdog poll plus dashboard traffic doesn't fork a git
// process on every /health hit. Fail-safe: any error resolves to null and is
// simply omitted from the response (never throws, never blocks /health).
let deployedShaCache: { sha: string | null; at: number } = { sha: null, at: 0 };
const DEPLOYED_SHA_TTL_MS = 60_000;

async function getDeployedSha(): Promise<string | null> {
  const now = Date.now();
  if (deployedShaCache.sha !== null && now - deployedShaCache.at < DEPLOYED_SHA_TTL_MS) {
    return deployedShaCache.sha;
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", HYDRA_ROOT, "rev-parse", "HEAD"], { timeout: 3000 });
    const sha = stdout.trim() || null;
    deployedShaCache = { sha, at: now };
    return sha;
  } catch (err: any) {
    // Intentional: not a git checkout, git missing, or timeout — the field is
    // advisory. Log once-per-cache-window so a misconfigured host is visible
    // without spamming, then omit the field.
    console.error(`[API] /health deployedSha unavailable: ${err?.message ?? err}`);
    deployedShaCache = { sha: null, at: now };
    return null;
  }
}

export function createHealthRouter(eventBus: any) {
  const router = Router();

  // GET /health — Basic health check
  router.get("/health", async (req, res) => {
    const killFileExists = existsSync(KILL_FILE);
    let redisOk = false;
    try {
      await eventBus.publisher.ping();
      redisOk = true;
    } catch { /* intentional: ping failure reflected via redisOk=false in the response */ }

    // Issue #734: advisory deployed-SHA for the deploy-drift backstop. null
    // when unresolvable (omitted-by-coalesce below); never blocks /health.
    const deployedSha = await getDeployedSha();

    res.json({
      status: killFileExists ? "killed" : "ok",
      redis: redisOk,
      // In-process control loop removed in PR-3 (issue #383). Autopilot
      // subagents own execution now; "idle" is the only status this surface
      // ever returns.
      cycle: "idle",
      uptime: process.uptime(),
      // Issue #734: SHA the orchestrator is running from (deploy.sh leaves
      // $HYDRA_ROOT on master HEAD). Advisory — null/absent if git is
      // unavailable. The watchdog compares this against origin/master.
      deployedSha,
    });
  });

  // GET /health/services — Probe VikingDB and OpenViking
  // The openai-proxy and ollama probes were retired in PR-3 (issue #383) —
  // both only existed to serve the in-process codex CLI agents.
  router.get("/health/services", async (req, res) => {
    async function probe(url, acceptAny = false) {
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return { status: (r.ok || acceptAny) ? "running" : "failed", latencyMs: Date.now() - start };
      } catch {
        return { status: "failed", latencyMs: null };
      }
    }

    const [vikingdb, openviking] = await Promise.all([
      probe("http://localhost:5000/health"),
      probe("http://localhost:1933/health"),
    ]);

    res.json({ vikingdb, openviking });
  });

  // GET /health/deep — Comprehensive health with diagnostic reasoning
  router.get("/health/deep", async (req, res) => {
    const checkedAt = new Date().toISOString();
    const settled = await Promise.allSettled([
      /* 0: basic health */ (async () => {
        const killed = existsSync(KILL_FILE);
        let redisOk = false;
        try { await eventBus.publisher.ping(); redisOk = true; } catch { /* intentional: ping failure reflected via redisOk=false */ }
        // In-process cycle removed in PR-3 (issue #383); status is "idle" forever.
        return { status: killed ? "killed" : "ok", redis: redisOk, cycle: "idle", uptime: process.uptime() };
      })(),
      /* 1: service probes */ (async () => {
        const probe = async (url, acceptAny = false) => {
          try {
            const start = Date.now();
            const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
            return { status: (r.ok || acceptAny) ? "running" : "failed", latencyMs: Date.now() - start };
          } catch { return { status: "failed", latencyMs: null }; }
        };
        // openai-proxy diagnostic removed in PR-3 (issue #383) — port 4001 only
        // existed to feed the codex CLI agents.
        const [vikingdb, ov] = await Promise.all([probe("http://localhost:5000/health"), probe("http://localhost:1933/health")]);
        return { vikingdb, openviking: ov };
      })(),
      /* 2 */ getSchedulerStatus(),
      /* 3 */ Promise.resolve({ status: "idle" }),
      /* 4 */ getWorkQueueLen(),
      /* 5 */ getBacklogCounts(),
      /* 6 */ (async () => ({ trend: await getMetricsTrend(20), stats: await getAggregateStats(20) }))(),
      /* 7 */ execFileAsync("df", ["-B1", "--output=avail,size,pcent", "/"], { timeout: 3000 }).catch(() => null),
      /* 8 */ execFileAsync("free", ["-b"], { timeout: 3000 }).catch(() => null),
      /* 9 */ execFileAsync("systemctl", ["--user", "is-active", "hydra-orchestrator.service"], { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => "unknown"),
      /* 10 */ execFileAsync("systemctl", ["--user", "is-active", "hydra-orchestrator-watchdog.timer"], { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => "unknown"),
      /* 11 */ execFileAsync("systemctl", ["--user", "is-active", getTargetServiceName()], { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => "unknown"),
      /* 12 */ (async () => {
        const [p, e, s] = await Promise.all([getMemoryPatterns("planner"), getMemoryPatterns("executor"), getMemoryPatterns("skeptic")]);
        const cnt = (raw) => { try { return JSON.parse(raw).length; } catch { return 0; } };
        return { planner: cnt(p), executor: cnt(e), skeptic: cnt(s) };
      })(),
      /* 13 */ countReflectionKeys(),
      /* 14 */ (async () => {
        try {
          const ovKey = OPENVIKING_API_KEY;
          const start = Date.now();
          const r = await fetch("http://localhost:1933/api/v1/search/find", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": ovKey }, body: JSON.stringify({ query: "system health", limit: 3 }), signal: AbortSignal.timeout(3000) });
          const lat = Date.now() - start;
          if (!r.ok) return { status: "failed", latencyMs: lat, resultCount: 0 };
          const d = await r.json() as any; const rs = d?.result || {};
          return { status: "running", latencyMs: lat, resultCount: (rs.memories?.length || 0) + (rs.resources?.length || 0) + (rs.skills?.length || 0) };
        } catch { return { status: "failed", latencyMs: null, resultCount: 0 }; }
      })(),
      /* 15 */ (async () => {
        try {
          const [info, clients, server] = await Promise.all([getRedisInfo("memory"), getRedisInfo("clients"), getRedisInfo("server")]);
          return { memoryHuman: info.match(/used_memory_human:(\S+)/)?.[1] || "unknown", connectedClients: parseInt(clients.match(/connected_clients:(\d+)/)?.[1] || "0"), uptimeSeconds: parseInt(server.match(/uptime_in_seconds:(\d+)/)?.[1] || "0") };
        } catch { return null; }
      })(),
    ]);

    const val = (i) => settled[i].status === "fulfilled" ? (settled[i] as any).value : null;
    const health = val(0) || { status: "failed", redis: false, cycle: "unknown", uptime: 0 };
    const svcProbes = val(1) || { vikingdb: { status: "failed" }, openviking: { status: "failed" } };
    const sched = val(2) || { running: false, cyclesRun: 0, cyclesMerged: 0, cyclesFailed: 0, mergeRate: 0, consecutiveErrors: 0 };
    const cycle = val(3) || {};
    const queueDepth = val(4) || 0;
    const blCounts = val(5) || { triage: 0, backlog: 0, inProgress: 0, blocked: 0, done: 0, total: 0 };
    const mData = val(6) || { trend: [], stats: {} };
    const patterns = val(12) || { planner: 0, executor: 0, skeptic: 0 };
    const reflCount = val(13) || 0;
    const ovSearch = val(14) || { status: "failed", latencyMs: null, resultCount: 0 };
    const redisInfo = val(15);

    // Parse disk
    let disk = { availableGb: 0, totalGb: 0, usedPercent: 0 };
    const diskRaw = val(7);
    if (diskRaw?.stdout) {
      const dl = diskRaw.stdout.trim().split("\n").pop()?.trim();
      if (dl) { const p = dl.split(/\s+/); disk = { availableGb: Math.round(parseInt(p[0] || "0") / 1073741824 * 10) / 10, totalGb: Math.round(parseInt(p[1] || "0") / 1073741824 * 10) / 10, usedPercent: parseInt((p[2] || "0").replace("%", "")) || 0 }; }
    }
    // Parse memory
    let mem = { totalGb: 0, availableGb: 0, usedPercent: 0 };
    const memRaw = val(8);
    if (memRaw?.stdout) {
      const ml = memRaw.stdout.split("\n").find(l => l.startsWith("Mem:"));
      if (ml) { const p = ml.split(/\s+/); const t = parseInt(p[1]) || 0, a = parseInt(p[6]) || 0; mem = { totalGb: Math.round(t / 1073741824 * 10) / 10, availableGb: Math.round(a / 1073741824 * 10) / 10, usedPercent: t > 0 ? Math.round((1 - a / t) * 100) : 0 }; }
    }
    const sysdOrch = val(9) || "unknown", sysdWatch = val(10) || "unknown", sysdWeb = val(11) || "unknown";

    // Pipeline metrics
    const trend = mData.trend || [];
    const mergedN = trend.filter(m => parseInt(m.tasksMerged || 0) > 0).length;
    const noTaskN = trend.filter(m => m.taskTitle === "Planner produced no task" || (m.taskTitle || "").startsWith("Skipped:")).length;
    const revertN = trend.filter(m => m.rolledBack === "true" || m.rolledBack === true).length;
    const durs = trend.map(m => parseInt(m.totalDurationMs || 0)).filter(d => d > 0);
    const avgDur = durs.length > 0 ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
    const recent = {
      cycleCount: trend.length,
      mergeRate: trend.length > 0 ? Math.round(mergedN / trend.length * 100) : 0,
      failedRate: trend.length > 0 ? Math.round(trend.filter(m => parseInt(m.tasksFailed || 0) > 0).length / trend.length * 100) : 0,
      noTaskRate: trend.length > 0 ? Math.round(noTaskN / trend.length * 100) : 0,
      revertRate: mergedN > 0 ? Math.round(revertN / mergedN * 100) : 0,
      avgDurationMs: avgDur, avgDurationHuman: avgDur > 60000 ? `${Math.round(avgDur / 60000)}m` : `${Math.round(avgDur / 1000)}s`,
    };

    // Diagnostics engine
    const diagnostics: any[] = [];
    if (health.status === "killed") diagnostics.push({ severity: "critical", component: "orchestrator", what: "Kill switch is active", why: "A kill file blocks all cycles until removed.", impact: "No cycles can run.", action: "Investigate, then: rm ~/hydra/.kill", autoRecovery: false });
    if (!health.redis) diagnostics.push({ severity: "critical", component: "redis", what: "Redis disconnected", why: "Redis is the sole state store. Without it, cycles, backlog, memory, and metrics are unavailable.", impact: "All operations fail.", action: "docker exec hydra-redis-1 redis-cli ping", autoRecovery: false });
    if (sched.consecutiveErrors >= 5) diagnostics.push({ severity: "error", component: "scheduler", what: `Auto-stopped after ${sched.consecutiveErrors} errors`, why: `Last: "${sched.lastError || "unknown"}". Pauses at 5 to prevent runaway spend.`, impact: "No autonomous cycles.", action: "Check logs, then POST /api/scheduler/start", autoRecovery: false });
    else if (!sched.running && (queueDepth > 0 || blCounts.total > 0)) diagnostics.push({ severity: "error", component: "scheduler", what: "Stopped but work exists", why: `${queueDepth} queue + ${blCounts.total} backlog items waiting.`, impact: "Queue growing stale.", action: "POST /api/scheduler/start", autoRecovery: false });
    if (disk.availableGb > 0 && disk.availableGb < 5) diagnostics.push({ severity: "error", component: "disk", what: `Disk critical: ${disk.availableGb}GB free`, why: `NVMe at ${disk.usedPercent}%. Operations fail below ~2GB.`, impact: "Cycle failures.", action: "Clean Docker images or move to /mnt/hydra-ssd", autoRecovery: false });
    if (mem.usedPercent > 95) diagnostics.push({ severity: "error", component: "memory", what: `Memory critical: ${mem.availableGb}GB free`, why: "OOM killer may terminate processes.", impact: "Crashes.", action: "top -o %MEM", autoRecovery: false });
    if (recent.revertRate > 30 && mergedN >= 3) diagnostics.push({ severity: "error", component: "pipeline", what: `High revert rate: ${recent.revertRate}%`, why: `${revertN}/${mergedN} merges reverted. Executor breaking existing tests.`, impact: "No forward progress.", action: "Review executor feedback, check flaky tests", autoRecovery: false });
    if (sched.consecutiveErrors > 0 && sched.consecutiveErrors < 5) diagnostics.push({ severity: "warning", component: "scheduler", what: `${sched.consecutiveErrors} consecutive error(s)`, why: `Auto-stops at 5. Last: "${sched.lastError || "unknown"}"`, impact: "May stop soon.", action: "Monitor next cycles", autoRecovery: true });
    if (disk.availableGb >= 5 && disk.availableGb < 20 && disk.totalGb > 0) diagnostics.push({ severity: "warning", component: "disk", what: `Disk low: ${disk.availableGb}GB free (${disk.usedPercent}%)`, why: "Below 20GB safety margin.", impact: "Heavy ops may fail.", action: "Clean old artifacts", autoRecovery: false });
    if (mem.usedPercent > 85 && mem.usedPercent <= 95) diagnostics.push({ severity: "warning", component: "memory", what: `Memory elevated: ${mem.usedPercent}%`, why: `${mem.availableGb}GB free of ${mem.totalGb}GB.`, impact: "OOM risk under load.", action: "Check resource-heavy processes", autoRecovery: false });
    if (svcProbes.openviking.status === "failed") diagnostics.push({ severity: "warning", component: "openviking", what: "OpenViking unreachable", why: "Agents run without knowledge context, reducing quality.", impact: "Degraded quality.", action: "curl http://localhost:1933/health", autoRecovery: true });
    if (svcProbes.vikingdb.status === "failed") diagnostics.push({ severity: "warning", component: "vikingdb", what: "VikingDB unreachable", why: "Embeddings storage down. Indexing and search fail.", impact: "Knowledge inoperative.", action: "docker ps | grep viking", autoRecovery: true });
    if (queueDepth === 0 && blCounts.total === 0 && health.cycle !== "running") diagnostics.push({ severity: "warning", component: "pipeline", what: "Pipeline empty", why: "No queue or backlog. Falls back to priorities.md or research.", impact: "May idle.", action: "Add items or trigger research", autoRecovery: true });
    if (recent.noTaskRate > 40 && trend.length >= 5) diagnostics.push({ severity: "warning", component: "pipeline", what: `No-task rate: ${recent.noTaskRate}%`, why: `Planner failed in ${noTaskN}/${trend.length} cycles. Items may be stale.`, impact: "~$1.55 wasted per cycle.", action: "Clean queue, update priorities", autoRecovery: false });
    if (blCounts.blocked > 0) diagnostics.push({ severity: "warning", component: "pipeline", what: `${blCounts.blocked} blocked item(s)`, why: "Need operator action.", impact: "Work stalled.", action: "Review on Backlog page", autoRecovery: false });
    // The dollar-based daily-spend cap diagnostic was retired with the
    // Subscription Usage Tracker. The new gate fires through the autopilot
    // (see /api/usage and /api/usage/eligibility), not the scheduler.
    if (recent.mergeRate < 40 && trend.length >= 5) diagnostics.push({ severity: "warning", component: "pipeline", what: `Low merge rate: ${recent.mergeRate}%`, why: `${mergedN}/${trend.length} merged. Tasks too ambitious or failing.`, impact: "Slow progress.", action: "Narrow scope, review feedback", autoRecovery: false });
    if (sysdWatch !== "active") diagnostics.push({ severity: "warning", component: "infrastructure", what: "Watchdog inactive", why: `Status: "${sysdWatch}". No auto-restart on hangs.`, impact: "No auto-recovery.", action: "systemctl --user start hydra-orchestrator-watchdog.timer", autoRecovery: false });
    if (sched.running && sched.lastCycleAt) { const ss = (Date.now() - new Date(sched.lastCycleAt).getTime()) / 1000; if (ss > 900 && health.cycle !== "running") diagnostics.push({ severity: "info", component: "scheduler", what: `Idle ${Math.round(ss / 60)}m`, why: "Scheduler active but no recent cycle. May be paused.", impact: "May resume.", action: "Check status", autoRecovery: true }); }
    if (patterns.planner === 0 && patterns.executor === 0 && patterns.skeptic === 0) diagnostics.push({ severity: "info", component: "intelligence", what: "No learned patterns", why: "Normal for fresh deployments.", impact: "Agents run without lessons.", action: "Accumulates automatically", autoRecovery: true });
    if (ovSearch.status === "running" && ovSearch.resultCount === 0) diagnostics.push({ severity: "info", component: "intelligence", what: "OV search empty", why: "Service up but index may be empty.", impact: "No knowledge context.", action: "Check indexer", autoRecovery: false });

    let status = "healthy";
    if (diagnostics.some(d => d.severity === "critical")) status = "critical";
    else if (diagnostics.some(d => d.severity === "error")) status = "unhealthy";
    else if (diagnostics.length > 0) status = "degraded";

    const fmtUp = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
    let summary;
    if (status === "healthy") { summary = `All systems operational. Scheduler ${sched.running ? "running" : "idle"}, uptime ${fmtUp(health.uptime)}, ${queueDepth} queued.`; }
    else { const c = { critical: 0, error: 0, warning: 0, info: 0 }; for (const d of diagnostics) c[d.severity]++; const ps: string[] = []; if (c.critical) ps.push(`${c.critical} critical`); if (c.error) ps.push(`${c.error} error${c.error > 1 ? "s" : ""}`); if (c.warning) ps.push(`${c.warning} warning${c.warning > 1 ? "s" : ""}`); if (c.info) ps.push(`${c.info} info`); summary = `${ps.join(", ")}. ${diagnostics[0]?.what || ""}`; }

    let activeCycle = null;
    if (cycle.status === "running" && cycle.cycleId) {
      const sa = cycle.startedAt || cycle.tasks?.[0]?.startedAt;
      const dur = sa ? Date.now() - new Date(sa).getTime() : 0;
      activeCycle = { id: cycle.cycleId, status: cycle.status, startedAt: sa, durationMs: dur, durationHuman: dur > 60000 ? `${Math.round(dur / 60000)}m ${Math.round((dur % 60000) / 1000)}s` : `${Math.round(dur / 1000)}s`, tasks: (cycle.tasks || []).map(t => ({ id: t.taskId || t.id, title: t.title, state: t.state || t.status })) };
    }

    res.json({
      status, summary, checkedAt,
      services: {
        orchestrator: { status: health.status === "ok" ? "running" : health.status, uptime: health.uptime, uptimeHuman: fmtUp(health.uptime), cycle: health.cycle },
        redis: { status: health.redis ? "running" : "failed", memoryHuman: redisInfo?.memoryHuman || null, connectedClients: redisInfo?.connectedClients || null, uptimeSeconds: redisInfo?.uptimeSeconds || null },
        scheduler: { status: sched.running ? "running" : (sched.consecutiveErrors >= 5 ? "failed" : "idle"), intervalHuman: sched.intervalHuman, cyclesRun: sched.cyclesRun, cyclesMerged: sched.cyclesMerged || 0, cyclesFailed: sched.cyclesFailed || 0, mergeRate: sched.mergeRate || 0, consecutiveErrors: sched.consecutiveErrors, lastError: sched.lastError, lastCycleAt: sched.lastCycleAt, research: { lastResearchAt: sched.research?.lastResearchAt || null } },
        vikingdb: svcProbes.vikingdb, openviking: svcProbes.openviking,
      },
      activeCycle,
      pipeline: { queueDepth, backlogCounts: blCounts, recentMetrics: recent, killSwitch: health.status === "killed" },
      infrastructure: { disk, memory: mem, systemd: { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb } },
      intelligence: { patterns, reflections: reflCount, ovSearch },
      diagnostics,
    });
  });

  // GET /recommendations — Operator action items computed from system state
  router.get("/recommendations", async (req, res) => {
    const recs = [];
    try {
      // 1. Triage items awaiting approval
      const counts = await getBacklogCounts();
      if (counts.triage > 0) {
        recs.push({
          type: "review",
          priority: 2,
          title: `${counts.triage} item${counts.triage > 1 ? "s" : ""} in Triage awaiting review`,
          description: "Research suggestions need approval before entering the backlog",
          action: "Review on the Backlog page",
          link: "/backlog",
        });
      }

      // 2. Blocked backlog items
      if (counts.blocked > 0) {
        recs.push({
          type: "action",
          priority: 1,
          title: `${counts.blocked} blocked item${counts.blocked > 1 ? "s" : ""} need intervention`,
          description: "These items can't proceed without operator action",
          action: "Unblock on the Backlog page",
          link: "/backlog",
        });
      }

      // 3. Scheduler not running
      const sched = await getSchedulerStatus();
      if (!sched.running) {
        recs.push({
          type: "action",
          priority: 1,
          title: "Scheduler is stopped",
          description: "Hydra won't run autonomous cycles until the scheduler is started",
          action: "Start from the Overview page",
          link: "/",
        });
      }

      // 4. Empty work pipeline
      if (counts.total === 0 && counts.inProgress === 0 && counts.triage === 0) {
        recs.push({
          type: "info",
          priority: 3,
          title: "Work pipeline is empty",
          description: "No items in triage, backlog, or queue. Hydra will fall back to priorities.md or run research to find work.",
          action: "Add items on the Backlog page or update Vision",
          link: "/backlog",
        });
      }

      // 5. Check priorities.md for BLOCKED items
      try {
        const prioritiesContent = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
        const blockedHeaders = prioritiesContent.match(/^##.*\[BLOCKED\].*$/gim) || [];
        const blockedReasons = prioritiesContent.match(/^\s*-\s*Blocked on.*$/gim) || [];
        if (blockedHeaders.length > 0) {
          const items = blockedHeaders.map((h: string) => h.replace(/^##\s*\d+\)\s*\[BLOCKED\]\s*/i, "").trim());
          const reasons = blockedReasons.map((r: string) => r.replace(/^\s*-\s*Blocked on operator:\s*/i, "").trim());
          recs.push({
            type: "action",
            priority: 1,
            title: `${blockedHeaders.length} priorit${blockedHeaders.length > 1 ? "ies" : "y"} blocked on operator action`,
            description: items.map((item: string, i: number) => `${item}${reasons[i] ? ` — needs: ${reasons[i]}` : ""}`).join("\n"),
            action: "Provide required credentials/approvals to unblock",
            link: "/vision",
          });
        }
      } catch { /* intentional: no priorities file present yet — degrade silently */ }

      // 6. Kill file present
      if (existsSync(KILL_FILE)) {
        recs.push({
          type: "action",
          priority: 1,
          title: "Kill switch is active",
          description: "All cycles are blocked. Remove the kill file to resume.",
          action: "Investigate and remove ~/.hydra/.kill",
          link: "/health",
        });
      }

      // Sort by priority (1=urgent first)
      recs.sort((a, b) => a.priority - b.priority);
    } catch (err: any) {
      console.error(`[API] recommendations error: ${err.message}`);
    }
    res.json(recs);
  });

  return router;
}
