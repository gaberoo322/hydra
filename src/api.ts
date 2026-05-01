import express from "express";
import * as Sentry from "@sentry/node";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { startCycle, getCycleStatus, getCycleHistory, killCycle } from "./cycle.ts";
import { listProposals, approveProposal, rejectProposal, runMetaAnalysis } from "./proposals.ts";
import { getTracker } from "./task-tracker.ts";
import { getMetricsTrend, getAggregateStats, recordCycleMetrics } from "./metrics.ts";
import { start as startScheduler, stop as stopScheduler, getStatus as getSchedulerStatus } from "./scheduler.ts";
import { runResearchLoop, getLatestResearch, listResearchReports, vetoOpportunity } from "./research-loop.ts";
import { loadProjectGoals, summarizeGoalsForPrompt } from "./project-goals.ts";
import { getPlanCacheStats, invalidatePlanCache } from "./plan-cache.ts";
import { listSpecs, getSpec, createSpec, archiveSpec } from "./specs.ts";
import { sendDigestNow } from "./digest.ts";
import { loadBacklog, getBacklogCounts, addToBacklog, moveItemToLane, deleteItem, updateItem, getItemsByParent, isWipLimitReached, claimNextQueuedItem } from "./backlog.ts";
import { getAllReflections } from "./reflections.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

function createApi(eventBus) {
  const app = express();
  app.use(express.json());

  // CORS — allow dashboard from any origin (Vercel, local dev, etc.)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // All API routes go on a Router, mounted at "/api".
  // Dashboard and external callers use /api/* paths.
  const api = express.Router();
  app.use("/api", api);

  // POST /cycle/start — Trigger a new development cycle
  // Accepts optional body: { anchor: { type, reference } } to direct what to work on
  api.post("/cycle/start", async (req, res) => {
    try {
      const opts: Record<string, any> = {};
      if (req.body?.anchor) {
        opts.anchor = req.body.anchor;
      }
      const result = await startCycle(eventBus, opts);
      if (result.error) {
        res.status(409).json(result);
      } else {
        res.json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/status — Current cycle state
  api.get("/cycle/status", async (req, res) => {
    try {
      res.json(await getCycleStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/history — Recent cycle results
  api.get("/cycle/history", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const limit = parseInt(req.query.limit) || 10;
      res.json(await getCycleHistory(limit));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/report — Structured cycle report with agent runs and costs
  api.get("/cycle/report", async (req, res) => {
    try {
      res.json(await getTracker().getCycleReport());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks — Per-task state from Redis (shows exactly where each task is)
  api.get("/tasks", async (req, res) => {
    try {
      const state = await getTracker().getCycleState();
      res.json(state.tasks || []);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id — Single task detail
  api.get("/tasks/:id", async (req, res) => {
    try {
      const task = await getTracker().getTaskState(req.params.id);
      if (!task || !task.cycleId) {
        res.status(404).json({ error: "Task not found" });
      } else {
        res.json({ taskId: req.params.id, ...task });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id/evidence — Full evidence chain for a task (v2 state machine)
  api.get("/tasks/:id/evidence", async (req, res) => {
    try {
      const evidence = await getTracker().getTaskEvidence(req.params.id);
      if (!evidence || Object.keys(evidence).length === 0) {
        res.status(404).json({ error: "No evidence found for task" });
      } else {
        res.json({ taskId: req.params.id, evidence });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /grounding/latest — Most recent grounding report
  api.get("/grounding/latest", async (req, res) => {
    try {
      const { groundProject } = await import("./grounding.ts");
      const projectDir = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";
      const report = await groundProject(projectDir);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /queue — Queue a work item for the next cycle
  // Body: { reference: "what to build", reason: "why", context: "optional detail" }
  api.post("/queue", async (req, res) => {
    try {
      const { reference, reason, context } = req.body || {};
      if (!reference) {
        return res.status(400).json({ error: "Missing 'reference' field — what should Hydra work on?" });
      }

      // Dedup: check if an item with the same reference already exists in the queue
      const existing = await getTracker().redis.lrange("hydra:anchors:work-queue", 0, -1);
      const refLower = reference.toLowerCase().trim();
      const duplicate = existing.some(raw => {
        try {
          const item = JSON.parse(raw);
          return (item.reference || "").toLowerCase().trim() === refLower;
        } catch { return false; }
      });
      if (duplicate) {
        return res.json({ queued: false, reason: "Duplicate — item with same reference already in queue", reference });
      }

      const item = { reference, reason: reason || "queued by operator", context, queuedAt: new Date().toISOString() };
      await getTracker().redis.rpush("hydra:anchors:work-queue", JSON.stringify(item));
      const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue");
      res.json({ queued: true, item, position: queueLen });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /queue — View queued work items
  api.get("/queue", async (req, res) => {
    try {
      const items = await getTracker().redis.lrange("hydra:anchors:work-queue", 0, -1);
      res.json(items.map((i) => { try { return JSON.parse(i); } catch { return i; } }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /summary — Human-readable system summary
  api.get("/summary", async (req, res) => {
    try {
      const { getMetricsTrend: gmt, getAggregateStats: gas, getCumulativeAccomplishments: gca } = await import("./metrics.ts");
      const stats = await gas(20);
      const acc = await gca(20);
      const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue");
      const priorFails = await getTracker().redis.llen("hydra:anchors:prior-failures");

      const lines = [
        `Hydra V2 — ${stats.cycles} cycles completed`,
        `Merged: ${stats.mergedRate}% | Failed: ${stats.failedRate}% | Regressed: ${stats.regressionRate}%`,
        `Avg cycle: ${stats.avgDurationHuman}`,
        `Work queue: ${queueLen} item(s) | Prior failures: ${priorFails}`,
        "",
        "Accomplished:",
        ...acc.map((a) => `  - ${a.title} (tests ${a.tests})`),
      ];

      res.type("text/plain").send(lines.join("\n"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics — Recent cycle metrics
  api.get("/metrics", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const count = parseInt(req.query.count) || 20;
      const trend = await getMetricsTrend(count);
      const stats = await getAggregateStats(count);
      res.json({ stats, trend });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /agents/status — Agent health and task assignments
  api.get("/agents/status", async (req, res) => {
    const cycle = await getCycleStatus();
    res.json({
    // @ts-expect-error — migrate to proper types
      cycle: cycle.id || null,
    // @ts-expect-error — migrate to proper types
      agents: cycle.agents || {},
    });
  });

  // POST /agents/:id/pause — Pause a specific agent
  api.post("/agents/:id/pause", async (req, res) => {
    const { id } = req.params;
    const cycle = await getCycleStatus();
    // @ts-expect-error — migrate to proper types
    if (cycle.agents?.[id]) {
    // @ts-expect-error — migrate to proper types
      cycle.agents[id].status = "paused";
      res.json({ paused: true, agent: id });
    } else {
      res.status(404).json({ error: `Agent '${id}' not found in current cycle` });
    }
  });

  // GET /spending — Token consumption and dollar costs from Redis
  api.get("/spending", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const count = parseInt(req.query.count) || 20;
      const tracker = getTracker();
      const trend = await getMetricsTrend(count);

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCostUsd = 0;
      let totalAgentTimeMs = 0;
      const perCycle = [];

      for (const m of trend) {
        const costs = await tracker.redis.hgetall(`hydra:cycle:${m.cycleId}:costs`);
        const input = parseInt(costs.inputTokens) || 0;
        const output = parseInt(costs.outputTokens) || 0;
        const costMicro = parseInt(costs.costMicrodollars) || 0;
        const costUsd = costMicro / 1_000_000;

        totalInputTokens += input;
        totalOutputTokens += output;
        totalCostUsd += costUsd;
        totalAgentTimeMs += m.totalDurationMs || 0;

        perCycle.push({
          cycleId: m.cycleId,
          inputTokens: input,
          outputTokens: output,
          costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
          durationMs: m.totalDurationMs || 0,
          task: m.taskTitle,
        });
      }

      res.json({
        recentCycles: trend.length,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCostUsd: Math.round(totalCostUsd * 100) / 100,
        totalAgentTimeMs,
        totalAgentTimeHuman: `${Math.round(totalAgentTimeMs / 1000)}s`,
        avgCostPerCycle: trend.length > 0
          ? Math.round((totalCostUsd / trend.length) * 100) / 100
          : 0,
        perCycle,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /kill — Emergency stop
  api.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    const result = await killCycle(eventBus);
    res.json({ ...result, killFile: KILL_FILE });
  });

  // GET /openviking/search — Proxy search to OpenViking
  api.get("/openviking/search", async (req, res) => {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }

    try {
      const ovUrl = process.env.OPENVIKING_URL || "http://localhost:1933";
      const ovKey = process.env.OPENVIKING_API_KEY || "1080bb34205409e58aa433512cb5e5d6344560adce963c442543001808181115";
      const response = await fetch(`${ovUrl}/api/v1/search/find`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": ovKey },
    // @ts-expect-error — migrate to proper types
        body: JSON.stringify({ query, limit: parseInt(req.query.limit) || 10 }),
      });
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      res.status(502).json({ error: `OpenViking unavailable: ${err.message}` });
    }
  });

  // GET /health — Basic health check
  api.get("/health", async (req, res) => {
    const killFileExists = existsSync(KILL_FILE);
    let redisOk = false;
    try {
      await eventBus.publisher.ping();
      redisOk = true;
    } catch {}

    res.json({
      status: killFileExists ? "killed" : "ok",
      redis: redisOk,
      cycle: (await getCycleStatus()).status || "idle",
      uptime: process.uptime(),
    });
  });

  // GET /health/services — Probe VikingDB, OpenViking, OpenAI Proxy
  api.get("/health/services", async (req, res) => {
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

    const [vikingdb, openviking, openaiProxy] = await Promise.all([
      probe("http://localhost:5000/health"),
      probe("http://localhost:1933/health"),
      probe("http://localhost:4001/v1/embeddings", true),
    ]);

    res.json({ vikingdb, openviking, openaiProxy });
  });

  // GET /health/deep — Comprehensive health with diagnostic reasoning
  api.get("/health/deep", async (req, res) => {
    const checkedAt = new Date().toISOString();
    const settled = await Promise.allSettled([
      /* 0: basic health */ (async () => {
        const killed = existsSync(KILL_FILE);
        let redisOk = false;
        try { await eventBus.publisher.ping(); redisOk = true; } catch {}
        return { status: killed ? "killed" : "ok", redis: redisOk, cycle: (await getCycleStatus()).status || "idle", uptime: process.uptime() };
      })(),
      /* 1: service probes */ (async () => {
        const probe = async (url, acceptAny = false) => {
          try {
            const start = Date.now();
            const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
            return { status: (r.ok || acceptAny) ? "running" : "failed", latencyMs: Date.now() - start };
          } catch { return { status: "failed", latencyMs: null }; }
        };
        const [vikingdb, ov, proxy] = await Promise.all([probe("http://localhost:5000/health"), probe("http://localhost:1933/health"), probe("http://localhost:4001/v1/embeddings", true)]);
        return { vikingdb, openviking: ov, openaiProxy: proxy };
      })(),
      /* 2 */ getSchedulerStatus(),
      /* 3 */ getCycleStatus(),
      /* 4 */ getTracker().redis.llen("hydra:anchors:work-queue"),
      /* 5 */ getTracker().redis.llen("hydra:anchors:prior-failures"),
      /* 6 */ getBacklogCounts(),
      /* 7 */ (async () => ({ trend: await getMetricsTrend(20), stats: await getAggregateStats(20) }))(),
      /* 8 */ execFileAsync("df", ["-B1", "--output=avail,size,pcent", "/"], { timeout: 3000 }).catch(() => null),
      /* 9 */ execFileAsync("free", ["-b"], { timeout: 3000 }).catch(() => null),
      /* 10 */ execFileAsync("systemctl", ["--user", "is-active", "hydra-orchestrator.service"], { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => "unknown"),
      /* 11 */ execFileAsync("systemctl", ["--user", "is-active", "hydra-orchestrator-watchdog.timer"], { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => "unknown"),
      /* 12 */ execFileAsync("systemctl", ["--user", "is-active", "hydra-betting-web.service"], { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => "unknown"),
      /* 13 */ (async () => {
        const r = getTracker().redis;
        const [p, e, s] = await Promise.all([r.get("hydra:memory:planner:patterns"), r.get("hydra:memory:executor:patterns"), r.get("hydra:memory:skeptic:patterns")]);
        const cnt = (raw) => { try { return JSON.parse(raw).length; } catch { return 0; } };
        return { planner: cnt(p), executor: cnt(e), skeptic: cnt(s) };
      })(),
      /* 14 */ (async () => {
        const r = getTracker().redis; let count = 0, cursor = "0";
        do { const [next, keys] = await r.scan(cursor, "MATCH", "hydra:reflections:*", "COUNT", 100); cursor = next; count += keys.length; } while (cursor !== "0");
        return count;
      })(),
      /* 15 */ (async () => {
        try {
          const ovKey = process.env.OPENVIKING_API_KEY || "56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c";
          const start = Date.now();
          const r = await fetch("http://localhost:1933/api/v1/search/find", { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": ovKey }, body: JSON.stringify({ query: "system health", limit: 3 }), signal: AbortSignal.timeout(3000) });
          const lat = Date.now() - start;
          if (!r.ok) return { status: "failed", latencyMs: lat, resultCount: 0 };
          const d = await r.json() as any; const rs = d?.result || {};
          return { status: "running", latencyMs: lat, resultCount: (rs.memories?.length || 0) + (rs.resources?.length || 0) + (rs.skills?.length || 0) };
        } catch { return { status: "failed", latencyMs: null, resultCount: 0 }; }
      })(),
      /* 16 */ (async () => {
        try {
          const [info, clients, server] = await Promise.all([getTracker().redis.info("memory"), getTracker().redis.info("clients"), getTracker().redis.info("server")]);
          return { memoryHuman: info.match(/used_memory_human:(\S+)/)?.[1] || "unknown", connectedClients: parseInt(clients.match(/connected_clients:(\d+)/)?.[1] || "0"), uptimeSeconds: parseInt(server.match(/uptime_in_seconds:(\d+)/)?.[1] || "0") };
        } catch { return null; }
      })(),
    ]);

    const val = (i) => settled[i].status === "fulfilled" ? (settled[i] as any).value : null;
    const health = val(0) || { status: "failed", redis: false, cycle: "unknown", uptime: 0 };
    const svcProbes = val(1) || { vikingdb: { status: "failed" }, openviking: { status: "failed" }, openaiProxy: { status: "failed" } };
    const sched = val(2) || { running: false, cyclesRun: 0, cyclesMerged: 0, cyclesFailed: 0, mergeRate: 0, consecutiveErrors: 0 };
    const cycle = val(3) || {};
    const queueDepth = val(4) || 0;
    const priorFailures = val(5) || 0;
    const blCounts = val(6) || { triage: 0, backlog: 0, inProgress: 0, blocked: 0, done: 0, total: 0 };
    const mData = val(7) || { trend: [], stats: {} };
    const patterns = val(13) || { planner: 0, executor: 0, skeptic: 0 };
    const reflCount = val(14) || 0;
    const ovSearch = val(15) || { status: "failed", latencyMs: null, resultCount: 0 };
    const redisInfo = val(16);

    // Parse disk
    let disk = { availableGb: 0, totalGb: 0, usedPercent: 0 };
    const diskRaw = val(8);
    if (diskRaw?.stdout) {
      const dl = diskRaw.stdout.trim().split("\n").pop()?.trim();
      if (dl) { const p = dl.split(/\s+/); disk = { availableGb: Math.round(parseInt(p[0] || "0") / 1073741824 * 10) / 10, totalGb: Math.round(parseInt(p[1] || "0") / 1073741824 * 10) / 10, usedPercent: parseInt((p[2] || "0").replace("%", "")) || 0 }; }
    }
    // Parse memory
    let mem = { totalGb: 0, availableGb: 0, usedPercent: 0 };
    const memRaw = val(9);
    if (memRaw?.stdout) {
      const ml = memRaw.stdout.split("\n").find(l => l.startsWith("Mem:"));
      if (ml) { const p = ml.split(/\s+/); const t = parseInt(p[1]) || 0, a = parseInt(p[6]) || 0; mem = { totalGb: Math.round(t / 1073741824 * 10) / 10, availableGb: Math.round(a / 1073741824 * 10) / 10, usedPercent: t > 0 ? Math.round((1 - a / t) * 100) : 0 }; }
    }
    const sysdOrch = val(10) || "unknown", sysdWatch = val(11) || "unknown", sysdWeb = val(12) || "unknown";

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
    if (svcProbes.openaiProxy.status === "failed") diagnostics.push({ severity: "error", component: "openai-proxy", what: "OpenAI Proxy unreachable", why: "Port 4001 provides LLM access. Planning and execution will fail.", impact: "All cycles fail.", action: "Check codex-proxy service", autoRecovery: false });
    if (disk.availableGb > 0 && disk.availableGb < 5) diagnostics.push({ severity: "error", component: "disk", what: `Disk critical: ${disk.availableGb}GB free`, why: `NVMe at ${disk.usedPercent}%. Operations fail below ~2GB.`, impact: "Cycle failures.", action: "Clean Docker images or move to /mnt/hydra-ssd", autoRecovery: false });
    if (mem.usedPercent > 95) diagnostics.push({ severity: "error", component: "memory", what: `Memory critical: ${mem.availableGb}GB free`, why: "OOM killer may terminate processes.", impact: "Crashes.", action: "top -o %MEM", autoRecovery: false });
    if (recent.revertRate > 30 && mergedN >= 3) diagnostics.push({ severity: "error", component: "pipeline", what: `High revert rate: ${recent.revertRate}%`, why: `${revertN}/${mergedN} merges reverted. Executor breaking existing tests.`, impact: "No forward progress.", action: "Review executor feedback, check flaky tests", autoRecovery: false });
    if (sched.consecutiveErrors > 0 && sched.consecutiveErrors < 5) diagnostics.push({ severity: "warning", component: "scheduler", what: `${sched.consecutiveErrors} consecutive error(s)`, why: `Auto-stops at 5. Last: "${sched.lastError || "unknown"}"`, impact: "May stop soon.", action: "Monitor next cycles", autoRecovery: true });
    if (disk.availableGb >= 5 && disk.availableGb < 20 && disk.totalGb > 0) diagnostics.push({ severity: "warning", component: "disk", what: `Disk low: ${disk.availableGb}GB free (${disk.usedPercent}%)`, why: "Below 20GB safety margin.", impact: "Heavy ops may fail.", action: "Clean old artifacts", autoRecovery: false });
    if (mem.usedPercent > 85 && mem.usedPercent <= 95) diagnostics.push({ severity: "warning", component: "memory", what: `Memory elevated: ${mem.usedPercent}%`, why: `${mem.availableGb}GB free of ${mem.totalGb}GB.`, impact: "OOM risk under load.", action: "Check resource-heavy processes", autoRecovery: false });
    if (svcProbes.openviking.status === "failed") diagnostics.push({ severity: "warning", component: "openviking", what: "OpenViking unreachable", why: "Agents run without knowledge context, reducing quality.", impact: "Degraded quality.", action: "curl http://localhost:1933/health", autoRecovery: true });
    if (svcProbes.vikingdb.status === "failed") diagnostics.push({ severity: "warning", component: "vikingdb", what: "VikingDB unreachable", why: "Embeddings storage down. Indexing and search fail.", impact: "Knowledge inoperative.", action: "docker ps | grep viking", autoRecovery: true });
    if (queueDepth === 0 && blCounts.total === 0 && priorFailures === 0 && health.cycle !== "running") diagnostics.push({ severity: "warning", component: "pipeline", what: "Pipeline empty", why: "No queue, backlog, or failures. Falls back to priorities.md or research.", impact: "May idle.", action: "Add items or trigger research", autoRecovery: true });
    if (recent.noTaskRate > 40 && trend.length >= 5) diagnostics.push({ severity: "warning", component: "pipeline", what: `No-task rate: ${recent.noTaskRate}%`, why: `Planner failed in ${noTaskN}/${trend.length} cycles. Items may be stale.`, impact: "~$1.55 wasted per cycle.", action: "Clean queue, update priorities", autoRecovery: false });
    if (blCounts.blocked > 0) diagnostics.push({ severity: "warning", component: "pipeline", what: `${blCounts.blocked} blocked item(s)`, why: "Need operator action.", impact: "Work stalled.", action: "Review on Backlog page", autoRecovery: false });
    if (sched.research?.dailySpendUsd > 0 && sched.research?.dailyCostCapUsd > 0 && (sched.research.dailySpendUsd / sched.research.dailyCostCapUsd) > 0.8) { const pct = Math.round((sched.research.dailySpendUsd / sched.research.dailyCostCapUsd) * 100); diagnostics.push({ severity: "warning", component: "scheduler", what: `Spend at ${pct}% of cap`, why: `$${sched.research.dailySpendUsd.toFixed(2)}/$${sched.research.dailyCostCapUsd}.`, impact: "Research may stop today.", action: "Resets at midnight", autoRecovery: true }); }
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
        scheduler: { status: sched.running ? "running" : (sched.consecutiveErrors >= 5 ? "failed" : "idle"), intervalHuman: sched.intervalHuman, cyclesRun: sched.cyclesRun, cyclesMerged: sched.cyclesMerged || 0, cyclesFailed: sched.cyclesFailed || 0, mergeRate: sched.mergeRate || 0, consecutiveErrors: sched.consecutiveErrors, lastError: sched.lastError, lastCycleAt: sched.lastCycleAt, research: { dailySpendUsd: sched.research?.dailySpendUsd || 0, dailyCostCapUsd: sched.research?.dailyCostCapUsd || 50, lastResearchAt: sched.research?.lastResearchAt || null } },
        vikingdb: svcProbes.vikingdb, openviking: svcProbes.openviking, openaiProxy: svcProbes.openaiProxy,
      },
      activeCycle,
      pipeline: { queueDepth, priorFailures, backlogCounts: blCounts, recentMetrics: recent, killSwitch: health.status === "killed" },
      infrastructure: { disk, memory: mem, systemd: { orchestrator: sysdOrch, watchdog: sysdWatch, bettingWeb: sysdWeb } },
      intelligence: { patterns, reflections: reflCount, ovSearch },
      diagnostics,
    });
  });

  // GET /recommendations — Operator action items computed from system state
  api.get("/recommendations", async (req, res) => {
    const recs = [];
    try {
      // 1. Pending proposals awaiting review
      const proposals = await listProposals("pending");
      if (proposals.length > 0) {
        recs.push({
          type: "review",
          priority: 2,
          title: `${proposals.length} proposal${proposals.length > 1 ? "s" : ""} awaiting review`,
          description: proposals.map(p => p.title).join(", "),
          action: "Review on the Proposals page",
          link: "/proposals",
        });
      }

      // 2. Triage items awaiting approval
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

      // 3. Blocked backlog items
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

      // 4. Scheduler not running
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

      // 5. Empty work pipeline
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

      // 6. Check priorities.md for BLOCKED items
      try {
        const prioritiesContent = await readFile(join(CONFIG_PATH, "direction", "priorities.md"), "utf-8");
        // Match section headers like "## 1) [BLOCKED] Place the first real Kalshi trade"
        const blockedHeaders = prioritiesContent.match(/^##.*\[BLOCKED\].*$/gim) || [];
        // Match "Blocked on operator:" lines for context
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
      } catch { /* no priorities file */ }

      // 7. Kill file present
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

  // GET /proposals — List proposals
  api.get("/proposals", async (req, res) => {
    const status = req.query.status;
    res.json(await listProposals(status));
  });

  // POST /proposals/:id/approve — Approve a proposal (id is the full proposalId string)
  api.post("/proposals/:id/approve", async (req, res) => {
    const proposalId = req.params.id;
    const result = await approveProposal(proposalId, eventBus);
    if (result.error) {
      res.status(404).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /proposals/:id/reject — Reject a proposal
  api.post("/proposals/:id/reject", async (req, res) => {
    const proposalId = req.params.id;
    const reason = req.body?.reason;
    const result = await rejectProposal(proposalId, reason, eventBus);
    if (result.error) {
      res.status(404).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /meta/analyze — Manually trigger Meta analysis
  api.post("/meta/analyze", async (req, res) => {
    try {
      const result = await runMetaAnalysis(eventBus, { correlationId: "manual" });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /scheduler/start — Start automatic cycle scheduling
  api.post("/scheduler/start", async (req, res) => {
    const intervalMs = req.body?.intervalMs;
    const result = await startScheduler(eventBus, { intervalMs });
    if (result.error) {
      res.status(409).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /scheduler/stop — Stop automatic cycle scheduling
  api.post("/scheduler/stop", (req, res) => {
    const result = stopScheduler();
    if (result.error) {
      res.status(409).json(result);
    } else {
      res.json(result);
    }
  });

  // GET /scheduler/status — Scheduler state and stats
  api.get("/scheduler/status", async (req, res) => {
    res.json(await getSchedulerStatus());
  });

  // =========================================================================
  // Research endpoints
  // =========================================================================

  // POST /research/start — Run a research cycle
  api.post("/research/start", async (req, res) => {
    try {
      const opts: Record<string, any> = {};
      if (req.body?.focusOverride) opts.focusOverride = req.body.focusOverride;
      const result = await runResearchLoop(eventBus, opts);
    // @ts-expect-error — migrate to proper types
      if (result.error) {
        res.status(400).json(result);
      } else {
        res.json({
          researchId: result.researchId,
    // @ts-expect-error — migrate to proper types
          opportunityCount: result.opportunityCount,
    // @ts-expect-error — migrate to proper types
          autoQueued: result.autoQueued,
    // @ts-expect-error — migrate to proper types
          summary: result.synthesis?.summary,
    // @ts-expect-error — migrate to proper types
          topOpportunities: (result.synthesis?.opportunities || []).slice(0, 5).map(o => ({
            rank: o.rank,
            title: o.title,
            adjustedScore: o.adjustedScore,
            confidence: o.confidence,
            autoQueue: o.autoQueue,
            category: o.category,
          })),
    // @ts-expect-error — migrate to proper types
          duration: result.duration?.totalHuman,
    // @ts-expect-error — migrate to proper types
          cost: result.cost?.totalUsd,
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /research/latest — Most recent research report
  api.get("/research/latest", async (req, res) => {
    try {
      const report = await getLatestResearch();
      if (!report) {
        res.status(404).json({ error: "No research reports found. Run POST /research/start first." });
      } else {
        res.json(report);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /research/history — List recent research reports (metadata)
  api.get("/research/history", async (req, res) => {
    try {
    // @ts-expect-error — migrate to proper types
      const count = parseInt(req.query.count) || 10;
      const reports = await listResearchReports(count);
      res.json(reports);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /research/veto — Remove a research-recommended item from the queue
  api.post("/research/veto", async (req, res) => {
    try {
      const { title } = req.body || {};
      if (!title) {
        return res.status(400).json({ error: "Missing 'title' — which opportunity to veto?" });
      }
      const result = await vetoOpportunity(title);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog — Full Kanban backlog with all lanes
  api.get("/backlog", async (req, res) => {
    try {
      const lanes = await loadBacklog();
      const counts = await getBacklogCounts();
      res.json({ ...lanes, counts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/counts — Just the counts per lane (includes WIP limit status)
  api.get("/backlog/counts", async (req, res) => {
    try {
      const counts = await getBacklogCounts();
      const wip = await isWipLimitReached();
      res.json({ ...counts, wip });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog — Manually add an item to the backlog
  api.post("/backlog", async (req, res) => {
    try {
      const { title, category, priority, description, labels, estimate, parentId } = req.body || {};
      if (!title) return res.status(400).json({ error: "Missing 'title'" });
      const result = await addToBacklog({
        title, category: category || "uncategorized", source: "operator",
        priority, description, labels, estimate, parentId,
      });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/enhance — Agent-enhanced backlog item creation
  // Takes raw operator text, uses LLM to produce a well-structured backlog item
  api.post("/backlog/enhance", async (req, res) => {
    try {
      const { text } = req.body || {};
      if (!text || !text.trim()) return res.status(400).json({ error: "Missing 'text'" });

      const systemPrompt = `You are a backlog item structuring agent for an autonomous software development system called Hydra. Hydra builds an algorithmic prediction market betting platform (sports-focused, Kalshi + Polymarket).

Your job: take the operator's raw input and produce a well-structured backlog item that Hydra's planner agent can act on without ambiguity.

Output ONLY valid JSON with these fields:
{
  "title": "Clear, specific, action-oriented title (verb + noun). Under 80 chars.",
  "category": "One of: feature, bugfix, research, integration, automation, security, refactor, observability",
  "priority": 0-4 where 1=urgent 2=high 3=medium 4=low 0=none,
  "description": "Structured description with: what to do, why it matters, acceptance criteria, and how to verify. Use markdown. Include ## Prerequisites if relevant.",
  "labels": ["array", "of", "relevant", "labels"],
  "estimate": null or fibonacci (1=XS, 2=S, 3=M, 5=L, 8=XL)
}

Guidelines for a good item:
- Title should be specific enough that a planner can propose a bounded task from it
- Description should include concrete acceptance criteria (done-when conditions)
- Description should reference specific files, modules, or subsystems when possible
- Anchor to concrete evidence: failing tests, missing coverage, API gaps, operator visibility needs
- Avoid vague scope like "build the full foundation for X" — prefer narrow, verifiable slices
- If the input is vague, make reasonable assumptions and state them in the description
- Labels should include the relevant subsystem (e.g., arbitrage, execution, reconciliation, polymarket, kalshi, scanner, dashboard)

Respond with ONLY the JSON object, no markdown fences, no explanation.`;

      const response = await fetch("http://localhost:4001/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text.trim() },
          ],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(502).json({ error: `LLM proxy error: ${response.status}`, detail: errText });
      }

      const completion = await response.json();
      const raw = completion.choices?.[0]?.message?.content || "";

      // Parse the LLM JSON output (strip markdown fences if present)
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      let structured;
      try {
        structured = JSON.parse(cleaned);
      } catch {
        return res.status(422).json({ error: "LLM returned invalid JSON", raw });
      }

      if (!structured.title) {
        return res.status(422).json({ error: "LLM output missing title", raw });
      }

      // Add the item to backlog with enhanced fields
      const result = await addToBacklog({
        title: structured.title,
        category: structured.category || "uncategorized",
        source: "operator",
        priority: typeof structured.priority === "number" ? structured.priority : 0,
        description: structured.description || "",
        labels: Array.isArray(structured.labels) ? structured.labels : undefined,
        estimate: typeof structured.estimate === "number" ? structured.estimate : undefined,
      });

      res.json({ ...result, enhanced: structured });
    } catch (err: any) {
      console.error("[backlog/enhance] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /backlog/:id — Update item fields (priority, description, labels, estimate, parentId, title)
  api.patch("/backlog/:id", async (req, res) => {
    try {
      const result = await updateItem(req.params.id, req.body || {});
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /backlog/:id/move — Move item between lanes (for dashboard drag-drop)
  api.patch("/backlog/:id/move", async (req, res) => {
    try {
      const { lane } = req.body || {};
      if (!lane) return res.status(400).json({ error: "Missing 'lane'" });
      const result = await moveItemToLane(req.params.id, lane);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog/:id/approve — Move item from triage to backlog
  api.post("/backlog/:id/approve", async (req, res) => {
    try {
      const result = await moveItemToLane(req.params.id, "backlog");
      if (!result.ok) return res.status(404).json(result);
      res.json({ ...result, approved: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/:id/children — List child items for a parent
  api.get("/backlog/:id/children", async (req, res) => {
    try {
      const children = await getItemsByParent(req.params.id);
      res.json(children);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /backlog/:id — Remove an item
  api.delete("/backlog/:id", async (req, res) => {
    try {
      const result = await deleteItem(req.params.id);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // GET /goals — Current project goals
  api.get("/goals", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      if (!goals) {
        res.status(404).json({ error: "No goals file found. Create config/direction/goals.md." });
      } else {
        res.json(goals);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /goals/summary — Goals formatted for prompts (useful for debugging)
  api.get("/goals/summary", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      const summary = summarizeGoalsForPrompt(goals);
      res.type("text/plain").send(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // OpenAI proxy — forward to localhost:4001 (Codex OAuth → OpenAI API)
  // Allows the Vercel frontend to use Codex auth for LLM calls.
  // =========================================================================

  const OPENAI_PROXY_TOKEN = process.env.OPENAI_PROXY_TOKEN || "";
  const OPENAI_PROXY_UPSTREAM = "http://localhost:4001";

  api.use("/openai-proxy", async (req, res, next) => {
    // Bearer token auth
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!OPENAI_PROXY_TOKEN || token !== OPENAI_PROXY_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Forward full sub-path to upstream
    const upstreamUrl = `${OPENAI_PROXY_UPSTREAM}${req.path}`;

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
      });

      const contentType = upstreamRes.headers.get("content-type") || "application/json";
      res.status(upstreamRes.status).set("content-type", contentType);
      const buffer = Buffer.from(await upstreamRes.arrayBuffer());
      res.send(buffer);
    } catch (err: any) {
      console.error(`[OpenAI Proxy Route] Failed:`, err.message);
      res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
    }
  });

  // POST /digest/send — Manually trigger a digest summary now
  api.post("/digest/send", async (req, res) => {
    try {
      await sendDigestNow();
      res.json({ sent: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // GET /events/:stream — Read recent events from a stream (for debugging)
  api.get("/events/:stream", async (req, res) => {
    const stream = `hydra:${req.params.stream}`;
    // @ts-expect-error — migrate to proper types
    const count = parseInt(req.query.count) || 10;
    try {
      const events = await eventBus.readRecent(stream, count);
      res.json(events);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Config endpoints — read/write git-tracked config files
  // -----------------------------------------------------------------------

  const CONFIG_SECTIONS = {
    agents: { dir: "agents", ext: ".md" },
    feedback: { dir: "feedback", ext: ".md" },
    direction: { dir: "direction", ext: ".md" },
    research: { dir: "research", ext: ".md" },
  };

  // GET /config/:section — List files in a config section
  api.get("/config/:section", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    try {
      const dir = join(CONFIG_PATH, section.dir);
      const files = (await readdir(dir)).filter(f => f.endsWith(section.ext));
      res.json(files.map(f => f.replace(section.ext, "")));
    } catch (err: any) {
      if (err.code === "ENOENT") return res.json([]);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /config/:section/:name — Read a config file
  api.get("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    const filePath = join(CONFIG_PATH, section.dir, `${req.params.name}${section.ext}`);
    try {
      const content = await readFile(filePath, "utf-8");
      res.type("text/plain").send(content);
    } catch (err: any) {
      if (err.code === "ENOENT") return res.status(404).json({ error: `Not found: ${req.params.name}` });
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /config/:section/:name — Update a config file
  api.put("/config/:section/:name", async (req, res) => {
    const section = CONFIG_SECTIONS[req.params.section];
    if (!section) return res.status(404).json({ error: `Unknown config section: ${req.params.section}` });
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "Body must include 'content' string" });
    const filePath = join(CONFIG_PATH, section.dir, `${req.params.name}${section.ext}`);
    try {
      await writeFile(filePath, content);
      res.json({ ok: true, path: filePath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Alerts — persisted notifications for the dashboard
  // -----------------------------------------------------------------------

  const ALERTS_KEY = "hydra:alerts";
  const ALERTS_MAX = 100;

  // GET /alerts — List recent alerts
  api.get("/alerts", async (req, res) => {
    try {
      const r = eventBus.publisher;
    // @ts-expect-error — migrate to proper types
      const raw = await r.lrange(ALERTS_KEY, 0, parseInt(req.query.limit) || 50);
      res.json(raw.map(s => JSON.parse(s)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /alerts/:id/dismiss — Dismiss an alert
  api.post("/alerts/:id/dismiss", async (req, res) => {
    try {
      const r = eventBus.publisher;
      const all = await r.lrange(ALERTS_KEY, 0, -1);
      for (let i = 0; i < all.length; i++) {
        const alert = JSON.parse(all[i]);
        if (alert.id === req.params.id) {
          alert.dismissed = true;
          await r.lset(ALERTS_KEY, i, JSON.stringify(alert));
          return res.json({ ok: true });
        }
      }
      res.status(404).json({ error: "Alert not found" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /alerts/dismiss-all — Dismiss all alerts
  api.post("/alerts/dismiss-all", async (req, res) => {
    try {
      await eventBus.publisher.del(ALERTS_KEY);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Sentry webhook — receives issue alerts and queues them for Hydra cycles
  // Configure in Sentry: Settings → Integrations → Webhooks → POST to
  // https://admin.clawstreetbets.xyz/webhooks/sentry
  // -----------------------------------------------------------------------

  api.post("/webhooks/sentry", async (req, res) => {
    try {
      const payload = req.body;
      const action = payload?.action;
      const data = payload?.data || {};
      const issue = data.issue || data.event || {};

      // Only act on new/regression issues, not resolved/ignored
      if (action && action !== "created" && action !== "triggered") {
        return res.json({ skipped: true, reason: `action ${action}` });
      }

      const title = issue.title || issue.message || "Unknown Sentry error";
      const project = payload?.project?.slug || payload?.project_slug || "unknown";
      const url = issue.web_url || issue.url || "";
      const culprit = issue.culprit || "";
      const level = issue.level || "error";

      // Skip info/warning level issues
      if (level !== "error" && level !== "fatal") {
        return res.json({ skipped: true, reason: `level ${level}` });
      }

      // Queue as work for the next cycle
      const tracker = getTracker();
      await tracker.redis.rpush("hydra:anchors:work-queue", JSON.stringify({
        reference: `Fix Sentry ${level}: ${title}`,
        reason: `Sentry issue in ${project}${culprit ? ` at ${culprit}` : ""}${url ? ` — ${url}` : ""}`,
        context: JSON.stringify({
          source: "sentry-webhook",
          project,
          title,
          culprit,
          level,
          url,
          firstSeen: issue.first_seen || issue.firstSeen,
          count: issue.count,
        }),
        queuedAt: new Date().toISOString(),
        source: "sentry",
      }));

      // Also create a dashboard alert
      const r = eventBus.publisher;
      await r.lpush("hydra:alerts", JSON.stringify({
        id: `sentry-${Date.now()}`,
        type: "sentry:issue",
        timestamp: new Date().toISOString(),
        message: `Sentry ${level} in ${project}: ${title}${culprit ? ` (${culprit})` : ""}`,
        severity: level === "fatal" ? "error" : "warning",
        dismissed: false,
        payload: { project, title, culprit, url },
      }));
      await r.ltrim("hydra:alerts", 0, 99);

      console.log(`[Sentry Webhook] Queued: "${title}" from ${project}`);
      res.json({ queued: true, title });
    } catch (err: any) {
      console.error(`[Sentry Webhook] Failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Plan cache stats
  // -----------------------------------------------------------------------

  api.get("/plan-cache/stats", async (req, res) => {
    res.json(getPlanCacheStats());
  });

  api.post("/plan-cache/invalidate", async (req, res) => {
    const count = await invalidatePlanCache();
    res.json({ invalidated: count });
  });

  // -----------------------------------------------------------------------
  // Reflections — Reflexion-style post-mortem buffer
  // -----------------------------------------------------------------------

  // GET /reflections — All reflections in the global buffer (most recent first)
  api.get("/reflections", async (req, res) => {
    try {
      const reflections = await getAllReflections();
      res.json({ reflections, count: reflections.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Calibration proxy — forward to hydra-betting app
  // -----------------------------------------------------------------------

  const HYDRA_BETTING_URL = process.env.HYDRA_BETTING_URL || "http://localhost:3333";

  api.get("/calibration/outcomes", async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const url = `${HYDRA_BETTING_URL}/api/calibration/outcomes${qs ? `?${qs}` : ""}`;
      const response = await fetch(url);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `hydra-betting unavailable: ${err.message}` });
    }
  });

  api.post("/calibration/outcomes/sync", async (req, res) => {
    try {
      const response = await fetch(`${HYDRA_BETTING_URL}/api/calibration/outcomes/sync`, { method: "POST" });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `hydra-betting unavailable: ${err.message}` });
    }
  });

  // -----------------------------------------------------------------------
  // Environment variables — read/update/delete .env files for hydra & hydra-betting
  // Protected by CRON_SECRET bearer token
  // -----------------------------------------------------------------------

  const ENV_PROJECTS: Record<string, string> = {
    hydra: resolve(process.env.HOME || "", "hydra", ".env"),
    "hydra-betting": resolve(process.env.HOME || "", "hydra-betting", ".env.local"),
  };

  const CRON_SECRET = process.env.CRON_SECRET || "";

  function requireEnvAuth(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!CRON_SECRET || token !== CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  }

  function parseEnvFile(raw: string): { key: string; value: string; line: string }[] {
    return raw.split("\n").filter(l => l && !l.startsWith("#") && l.includes("=")).map(line => {
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return { key, value, line };
    });
  }

  // GET /env/:project — List env vars (values masked unless ?reveal=true)
  api.get("/env/:project", requireEnvAuth, async (req, res) => {
    const envPath = ENV_PROJECTS[req.params.project];
    if (!envPath) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
    try {
      const raw = await readFile(envPath, "utf-8");
      const vars = parseEnvFile(raw);
      const reveal = req.query.reveal === "true";
      res.json(vars.map(v => ({
        key: v.key,
        value: reveal ? v.value : maskValue(v.value),
      })));
    } catch (err: any) {
      if (err.code === "ENOENT") return res.json([]);
      res.status(500).json({ error: err.message });
    }
  });

  function maskValue(v: string): string {
    if (v.length <= 6) return "••••••";
    return v.slice(0, 3) + "•".repeat(Math.min(v.length - 6, 20)) + v.slice(-3);
  }

  // PUT /env/:project — Set/update a variable { key, value }
  api.put("/env/:project", requireEnvAuth, async (req, res) => {
    const envPath = ENV_PROJECTS[req.params.project];
    if (!envPath) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
    const { key, value } = req.body || {};
    if (!key || typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return res.status(400).json({ error: "Invalid key — must be a valid env var name" });
    }
    if (typeof value !== "string") {
      return res.status(400).json({ error: "Value must be a string" });
    }
    try {
      let raw = "";
      try { raw = await readFile(envPath, "utf-8"); } catch { /* new file */ }
      const lines = raw.split("\n");
      const needle = `${key}=`;
      const idx = lines.findIndex(l => l.startsWith(needle) || l.startsWith(`${key} =`));
      const needsQuotes = value.includes(" ") || value.includes("#") || value.includes('"') || value.includes("\n");
      const formatted = needsQuotes ? `${key}="${value.replace(/"/g, '\\"')}"` : `${key}=${value}`;
      if (idx >= 0) {
        lines[idx] = formatted;
      } else {
        // Append — add blank line separator if file doesn't end with one
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(formatted);
      }
      await writeFile(envPath, lines.join("\n"));
      res.json({ ok: true, key, action: idx >= 0 ? "updated" : "added" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /env/:project/:key — Remove a variable
  api.delete("/env/:project/:key", requireEnvAuth, async (req, res) => {
    const envPath = ENV_PROJECTS[req.params.project];
    if (!envPath) return res.status(404).json({ error: `Unknown project: ${req.params.project}` });
    const key = req.params.key;
    try {
      const raw = await readFile(envPath, "utf-8");
      const lines = raw.split("\n");
      const filtered = lines.filter(l => !l.startsWith(`${key}=`) && !l.startsWith(`${key} =`));
      if (filtered.length === lines.length) {
        return res.status(404).json({ error: `Key not found: ${key}` });
      }
      await writeFile(envPath, filtered.join("\n"));
      res.json({ ok: true, key, action: "deleted" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Serve dashboard static files (built with `npm run build` in dashboard/)
  // Falls back to index.html for SPA client-side routing
  // -----------------------------------------------------------------------

  // Sentry error handler — must be after all routes, before other error handlers
  Sentry.setupExpressErrorHandler(app);

  // Serve dashboard — static files first, then SPA fallback for client routes
  const DASHBOARD_DIR = resolve(HYDRA_ROOT, "dashboard", "dist");
  const DASHBOARD_INDEX = resolve(DASHBOARD_DIR, "index.html");
  app.use(express.static(DASHBOARD_DIR));

  // SPA fallback — only for browser navigation (Accept: text/html), not API calls.
  // API calls from fetch/XHR send Accept: application/json and are handled by routes above.
  // Browser refreshes on client-side routes (e.g. /backlog, /cycles) send Accept: text/html.
  app.use((req, res, next) => {
    const accept = req.headers.accept || "";
    if (req.method === "GET" && accept.includes("text/html")) {
      res.sendFile(DASHBOARD_INDEX, (err) => {
        if (err) res.status(404).send("Dashboard not built. Run: cd dashboard && npm run build");
      });
    } else {
      next();
    }
  });

  // =========================================================================
  // Specs — persistent multi-cycle task decomposition
  // =========================================================================

  api.get("/specs", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const specs = await listSpecs(limit);
      res.json({ specs, count: specs.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  api.get("/specs/:slug", async (req, res) => {
    try {
      const spec = await getSpec(req.params.slug);
      if (!spec) {
        res.status(404).json({ error: `Spec "${req.params.slug}" not found` });
      } else {
        res.json(spec);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  api.post("/specs", async (req, res) => {
    try {
      const { title, rationale, tasks } = req.body;
      if (!title || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
        res.status(400).json({ error: "title and tasks[] are required" });
        return;
      }
      const spec = await createSpec({
        title,
        rationale: rationale || "",
        source: "operator",
        tasks: tasks.map((t) => typeof t === "string" ? { title: t } : t),
      });
      if (!spec) {
        res.status(409).json({ error: "Spec with this title already exists" });
      } else {
        res.status(201).json(spec);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  api.post("/specs/:slug/archive", async (req, res) => {
    try {
      const ok = await archiveSpec(req.params.slug);
      if (!ok) {
        res.status(404).json({ error: `Spec "${req.params.slug}" not found` });
      } else {
        res.json({ archived: true, slug: req.params.slug });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // Parallel execution endpoints — enable Claude Code /hydra-build cycles
  // to participate as a first-class cycle source alongside Codex.
  // =========================================================================

  // Register an external cycle (Claude Code)
  api.post("/cycle/register", async (req, res) => {
    try {
      const { cycleId, source } = req.body || {};
      if (!cycleId || !source) {
        return res.status(400).json({ error: "Missing cycleId or source" });
      }
      const r = getTracker().redis;
      await r.set(`hydra:cycle:active:${source}`, cycleId, "EX", 900);
      await r.hset(`hydra:cycle:${cycleId}`,
        "status", "running",
        "startedAt", new Date().toISOString(),
        "source", source,
        "total", 1,
        "completed", 0,
        "failed", 0,
        "abandoned", 0,
      );
      await r.expire(`hydra:cycle:${cycleId}`, 604800); // 7 days
      res.json({ ok: true, cycleId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Complete an external cycle
  api.post("/cycle/complete", async (req, res) => {
    try {
      const { cycleId, source, status } = req.body || {};
      if (!cycleId) {
        return res.status(400).json({ error: "Missing cycleId" });
      }
      const r = getTracker().redis;
      await r.del(`hydra:cycle:active:${source || "claude"}`);
      await r.hset(`hydra:cycle:${cycleId}`,
        "status", status || "completed",
        "completedAt", new Date().toISOString(),
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Atomic claim of next queued backlog item (Lua-based, safe for concurrent consumers)
  api.post("/backlog/claim", async (req, res) => {
    try {
      const { claimedBy } = req.body || {};
      const result = await claimNextQueuedItem(claimedBy || "claude");
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Acquire short-lived merge serialization lock (60s TTL)
  api.post("/merge/lock", async (req, res) => {
    try {
      const { cycleId } = req.body || {};
      const r = getTracker().redis;
      const acquired = await r.set("hydra:merge:lock", cycleId || "unknown", "EX", 60, "NX");
      if (!acquired) {
        const holder = await r.get("hydra:merge:lock");
        return res.status(409).json({ locked: true, holder });
      }
      res.json({ acquired: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Release merge lock
  api.post("/merge/unlock", async (_req, res) => {
    try {
      await getTracker().redis.del("hydra:merge:lock");
      res.json({ released: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Record cycle metrics from external sources (Claude Code)
  api.post("/metrics/record", async (req, res) => {
    try {
      const { cycleId, ...metrics } = req.body || {};
      if (!cycleId) {
        return res.status(400).json({ error: "Missing cycleId" });
      }
      await recordCycleMetrics(cycleId, metrics);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Write agent memory pattern (supports cross-source learning)
  api.post("/memory/:agent/pattern", async (req, res) => {
    try {
      const agentName = req.params.agent;
      const { category, action, example, cycleId, severity } = req.body || {};
      if (!category || !action) {
        return res.status(400).json({ error: "Missing category or action" });
      }
      const { recordPattern } = await import("./agent-memory.ts");
      await recordPattern(agentName, category, {
        severity: severity || "prevent",
        action,
        example: example || "",
        cycleId: cycleId || `claude-${Date.now()}`,
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read agent memory patterns
  api.get("/memory/:agent", async (req, res) => {
    try {
      const { loadAgentMemory } = await import("./agent-memory.ts");
      const memory = await loadAgentMemory(req.params.agent);
      res.type("text/plain").send(memory);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publish events from external sources (dashboard, Telegram digest)
  api.post("/events/publish", async (req, res) => {
    try {
      const { type, payload, correlationId } = req.body || {};
      if (!type) {
        return res.status(400).json({ error: "Missing type" });
      }
      await eventBus.publish("hydra:notifications", {
        type,
        source: "claude-build",
        correlationId: correlationId || null,
        payload: payload || {},
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

export { createApi };
