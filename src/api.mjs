import express from "express";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startCycle, getCycleStatus, getCycleHistory, killCycle } from "./cycle.mjs";
import { listProposals, approveProposal, rejectProposal, runMetaAnalysis } from "./proposals.mjs";

const VAULT_PATH = process.env.HYDRA_VAULT_PATH || resolve(process.env.HOME, "obsidian-vault");
const KILL_FILE = resolve(VAULT_PATH, ".kill");

function createApi(eventBus) {
  const app = express();
  app.use(express.json());

  // POST /cycle/start — Trigger a new development cycle
  app.post("/cycle/start", async (req, res) => {
    try {
      const result = await startCycle(eventBus);
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

  // GET /spending — Token consumption and cost tracking
  app.get("/spending", (req, res) => {
    const cycle = getCycleStatus();
    res.json({
      currentCycle: cycle.spending || { tokens: 0, cost: 0 },
      daily: { tokens: 0, cost: 0 }, // TODO: aggregate from cycle history
    });
  });

  // POST /kill — Emergency stop
  app.post("/kill", (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    const result = killCycle();
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
