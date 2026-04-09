import express from "express";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startCycle, getCycleStatus, getCycleHistory, killCycle } from "./cycle.mjs";
import { listProposals, approveProposal, rejectProposal, runMetaAnalysis } from "./proposals.mjs";
import { getTracker } from "./task-tracker.mjs";
import { getMetricsTrend, getAggregateStats } from "./metrics.mjs";
import { start as startScheduler, stop as stopScheduler, getStatus as getSchedulerStatus } from "./scheduler.mjs";
import { runResearchLoop, getLatestResearch, listResearchReports, vetoOpportunity } from "./research-loop.mjs";
import { runArchitectReview } from "./research-architect.mjs";
import { loadProjectGoals, summarizeGoalsForPrompt } from "./project-goals.mjs";
import { sendDigestNow } from "./digest.mjs";
import { loadBacklog, getBacklogCounts, addToBacklog } from "./backlog.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const KILL_FILE = resolve(VAULT_PATH, ".kill");

function createApi(eventBus) {
  const app = express();
  app.use(express.json());

  // POST /cycle/start — Trigger a new development cycle
  // Accepts optional body: { anchor: { type, reference } } to direct what to work on
  app.post("/cycle/start", async (req, res) => {
    try {
      const opts = {};
      if (req.body?.anchor) {
        opts.anchor = req.body.anchor;
      }
      const result = await startCycle(eventBus, opts);
      if (result.error) {
        res.status(409).json(result);
      } else {
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/status — Current cycle state
  app.get("/cycle/status", async (req, res) => {
    try {
      res.json(await getCycleStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/history — Recent cycle results
  app.get("/cycle/history", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      res.json(await getCycleHistory(limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /cycle/report — Structured cycle report with agent runs and costs
  app.get("/cycle/report", async (req, res) => {
    try {
      res.json(await getTracker().getCycleReport());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks — Per-task state from Redis (shows exactly where each task is)
  app.get("/tasks", async (req, res) => {
    try {
      const state = await getTracker().getCycleState();
      res.json(state.tasks || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id — Single task detail
  app.get("/tasks/:id", async (req, res) => {
    try {
      const task = await getTracker().getTaskState(req.params.id);
      if (!task || !task.cycleId) {
        res.status(404).json({ error: "Task not found" });
      } else {
        res.json({ taskId: req.params.id, ...task });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/:id/evidence — Full evidence chain for a task (v2 state machine)
  app.get("/tasks/:id/evidence", async (req, res) => {
    try {
      const evidence = await getTracker().getTaskEvidence(req.params.id);
      if (!evidence || Object.keys(evidence).length === 0) {
        res.status(404).json({ error: "No evidence found for task" });
      } else {
        res.json({ taskId: req.params.id, evidence });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /grounding/latest — Most recent grounding report
  app.get("/grounding/latest", async (req, res) => {
    try {
      const { groundProject } = await import("./grounding.mjs");
      const projectDir = process.env.HYDRA_PROJECT_WORKSPACE || "/home/gabe/hydra-betting";
      const report = await groundProject(projectDir);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /queue — Queue a work item for the next cycle
  // Body: { reference: "what to build", reason: "why", context: "optional detail" }
  app.post("/queue", async (req, res) => {
    try {
      const { reference, reason, context } = req.body || {};
      if (!reference) {
        return res.status(400).json({ error: "Missing 'reference' field — what should Hydra work on?" });
      }
      const item = { reference, reason: reason || "queued by operator", context, queuedAt: new Date().toISOString() };
      await getTracker().redis.rpush("hydra:anchors:work-queue", JSON.stringify(item));
      const queueLen = await getTracker().redis.llen("hydra:anchors:work-queue");
      res.json({ queued: true, item, position: queueLen });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /queue — View queued work items
  app.get("/queue", async (req, res) => {
    try {
      const items = await getTracker().redis.lrange("hydra:anchors:work-queue", 0, -1);
      res.json(items.map((i) => { try { return JSON.parse(i); } catch { return i; } }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /summary — Human-readable system summary
  app.get("/summary", async (req, res) => {
    try {
      const { getMetricsTrend: gmt, getAggregateStats: gas, getCumulativeAccomplishments: gca } = await import("./metrics.mjs");
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
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /metrics — Recent cycle metrics
  app.get("/metrics", async (req, res) => {
    try {
      const count = parseInt(req.query.count) || 20;
      const trend = await getMetricsTrend(count);
      const stats = await getAggregateStats(count);
      res.json({ stats, trend });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /agents/status — Agent health and task assignments
  app.get("/agents/status", (req, res) => {
    const cycle = getCycleStatus();
    res.json({
      cycle: cycle.id || null,
      agents: cycle.agents || {},
    });
  });

  // POST /agents/:id/pause — Pause a specific agent
  app.post("/agents/:id/pause", (req, res) => {
    const { id } = req.params;
    const cycle = getCycleStatus();
    if (cycle.agents?.[id]) {
      cycle.agents[id].status = "paused";
      res.json({ paused: true, agent: id });
    } else {
      res.status(404).json({ error: `Agent '${id}' not found in current cycle` });
    }
  });

  // GET /spending — Token consumption and dollar costs from Redis
  app.get("/spending", async (req, res) => {
    try {
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
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /kill — Emergency stop
  app.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    const result = await killCycle(eventBus);
    res.json({ ...result, killFile: KILL_FILE });
  });

  // GET /openviking/search — Proxy search to OpenViking
  app.get("/openviking/search", async (req, res) => {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }

    try {
      const ovUrl = process.env.OPENVIKING_URL || "http://localhost:1933";
      const response = await fetch(`${ovUrl}/api/v1/find?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: `OpenViking unavailable: ${err.message}` });
    }
  });

  // GET /health — Basic health check
  app.get("/health", async (req, res) => {
    const killFileExists = existsSync(KILL_FILE);
    let redisOk = false;
    try {
      await eventBus.publisher.ping();
      redisOk = true;
    } catch {}

    res.json({
      status: killFileExists ? "killed" : "ok",
      redis: redisOk,
      cycle: getCycleStatus().status || "idle",
      uptime: process.uptime(),
    });
  });

  // GET /proposals — List proposals
  app.get("/proposals", (req, res) => {
    const status = req.query.status;
    res.json(listProposals(status));
  });

  // POST /proposals/:id/approve — Approve a proposal (id is the full proposalId string)
  app.post("/proposals/:id/approve", async (req, res) => {
    const proposalId = req.params.id;
    const result = await approveProposal(proposalId, eventBus);
    if (result.error) {
      res.status(404).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /proposals/:id/reject — Reject a proposal
  app.post("/proposals/:id/reject", async (req, res) => {
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
  app.post("/meta/analyze", async (req, res) => {
    try {
      const result = await runMetaAnalysis(eventBus, { correlationId: "manual" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /scheduler/start — Start automatic cycle scheduling
  app.post("/scheduler/start", (req, res) => {
    const intervalMs = req.body?.intervalMs;
    const result = startScheduler(eventBus, { intervalMs });
    if (result.error) {
      res.status(409).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /scheduler/stop — Stop automatic cycle scheduling
  app.post("/scheduler/stop", (req, res) => {
    const result = stopScheduler();
    if (result.error) {
      res.status(409).json(result);
    } else {
      res.json(result);
    }
  });

  // GET /scheduler/status — Scheduler state and stats
  app.get("/scheduler/status", async (req, res) => {
    res.json(await getSchedulerStatus());
  });

  // =========================================================================
  // Research endpoints
  // =========================================================================

  // POST /research/start — Run a research cycle
  app.post("/research/start", async (req, res) => {
    try {
      const opts = {};
      if (req.body?.focusOverride) opts.focusOverride = req.body.focusOverride;
      const result = await runResearchLoop(eventBus, opts);
      if (result.error) {
        res.status(400).json(result);
      } else {
        res.json({
          researchId: result.researchId,
          opportunityCount: result.opportunityCount,
          autoQueued: result.autoQueued,
          summary: result.synthesis?.summary,
          topOpportunities: (result.synthesis?.opportunities || []).slice(0, 5).map(o => ({
            rank: o.rank,
            title: o.title,
            adjustedScore: o.adjustedScore,
            confidence: o.confidence,
            autoQueue: o.autoQueue,
            category: o.category,
          })),
          duration: result.duration?.totalHuman,
          cost: result.cost?.totalUsd,
        });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /research/latest — Most recent research report
  app.get("/research/latest", async (req, res) => {
    try {
      const report = await getLatestResearch();
      if (!report) {
        res.status(404).json({ error: "No research reports found. Run POST /research/start first." });
      } else {
        res.json(report);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /research/history — List recent research reports (metadata)
  app.get("/research/history", async (req, res) => {
    try {
      const count = parseInt(req.query.count) || 10;
      const reports = await listResearchReports(count);
      res.json(reports);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /research/veto — Remove a research-recommended item from the queue
  app.post("/research/veto", async (req, res) => {
    try {
      const { title } = req.body || {};
      if (!title) {
        return res.status(400).json({ error: "Missing 'title' — which opportunity to veto?" });
      }
      const result = await vetoOpportunity(title);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog — Full Kanban backlog with all lanes
  app.get("/backlog", async (req, res) => {
    try {
      const lanes = await loadBacklog();
      const counts = await getBacklogCounts();
      res.json({ ...lanes, counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /backlog/counts — Just the counts per lane
  app.get("/backlog/counts", async (req, res) => {
    try {
      res.json(await getBacklogCounts());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /backlog — Manually add an item to the backlog
  app.post("/backlog", async (req, res) => {
    try {
      const { title, category } = req.body || {};
      if (!title) return res.status(400).json({ error: "Missing 'title'" });
      const result = await addToBacklog({ title, category: category || "uncategorized", source: "operator" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /goals — Current project goals
  app.get("/goals", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      if (!goals) {
        res.status(404).json({ error: "No goals file found. Create direction/goals.md in the vault." });
      } else {
        res.json(goals);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /goals/summary — Goals formatted for prompts (useful for debugging)
  app.get("/goals/summary", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      const summary = summarizeGoalsForPrompt(goals);
      res.type("text/plain").send(summary);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /digest/send — Manually trigger a digest summary now
  app.post("/digest/send", async (req, res) => {
    try {
      await sendDigestNow();
      res.json({ sent: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /architect/review — Manually trigger Research Architect review
  app.post("/architect/review", async (req, res) => {
    try {
      const result = await runArchitectReview(eventBus);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /events/:stream — Read recent events from a stream (for debugging)
  app.get("/events/:stream", async (req, res) => {
    const stream = `hydra:${req.params.stream}`;
    const count = parseInt(req.query.count) || 10;
    try {
      const events = await eventBus.readRecent(stream, count);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

export { createApi };
