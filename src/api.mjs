import express from "express";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startCycle, getCycleStatus, getCycleHistory, killCycle } from "./cycle.mjs";
import { listProposals, approveProposal, rejectProposal, runMetaAnalysis } from "./proposals.mjs";
// getCycleReport is now served directly from the tracker
import { getTracker } from "./task-tracker.mjs";
import { getMetricsTrend, getAggregateStats } from "./metrics.mjs";

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
  app.get("/cycle/status", (req, res) => {
    res.json(getCycleStatus());
  });

  // GET /cycle/history — Recent cycle results
  app.get("/cycle/history", (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    res.json(getCycleHistory(limit));
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

  // GET /spending — Token consumption from cycle metrics
  app.get("/spending", async (req, res) => {
    try {
      const trend = await getMetricsTrend(20);
      const totalTokens = trend.reduce((s, m) => s + (m.totalDurationMs || 0), 0);
      res.json({
        recentCycles: trend.length,
        totalAgentTimeMs: totalTokens,
        totalAgentTimeHuman: `${Math.round(totalTokens / 1000)}s`,
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

  // POST /proposals/:id/approve — Approve a proposal
  app.post("/proposals/:id/approve", async (req, res) => {
    const id = parseInt(req.params.id);
    const result = await approveProposal(id, eventBus);
    if (result.error) {
      res.status(404).json(result);
    } else {
      res.json(result);
    }
  });

  // POST /proposals/:id/reject — Reject a proposal
  app.post("/proposals/:id/reject", async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = req.body?.reason;
    const result = await rejectProposal(id, reason, eventBus);
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
