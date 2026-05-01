import { Router } from "express";
import { writeFileSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { killCycle } from "../cycle.ts";
import { loadProjectGoals, summarizeGoalsForPrompt } from "../project-goals.ts";
import { getPlanCacheStats, invalidatePlanCache } from "../plan-cache.ts";
import { sendDigestNow } from "../digest.ts";
import { getAllReflections } from "../reflections.ts";
import { getTracker } from "../task-tracker.ts";
import { redisKeys } from "../redis-keys.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

export function createMiscRouter(eventBus: any) {
  const router = Router();

  // POST /kill — Emergency stop
  router.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    const result = await killCycle(eventBus);
    res.json({ ...result, killFile: KILL_FILE });
  });

  // GET /openviking/search — Proxy search to OpenViking
  router.get("/openviking/search", async (req, res) => {
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

  // GET /goals — Current project goals
  router.get("/goals", async (req, res) => {
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

  // GET /goals/summary — Goals formatted for prompts
  router.get("/goals/summary", async (req, res) => {
    try {
      const goals = await loadProjectGoals();
      const summary = summarizeGoalsForPrompt(goals);
      res.type("text/plain").send(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // OpenAI proxy — forward to localhost:4001
  // =========================================================================

  const OPENAI_PROXY_TOKEN = process.env.OPENAI_PROXY_TOKEN || "";
  const OPENAI_PROXY_UPSTREAM = "http://localhost:4001";

  router.use("/openai-proxy", async (req, res, next) => {
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
  router.post("/digest/send", async (req, res) => {
    try {
      await sendDigestNow();
      res.json({ sent: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /events/:stream — Read recent events from a stream
  router.get("/events/:stream", async (req, res) => {
    const stream = redisKeys.stream(req.params.stream);
    // @ts-expect-error — migrate to proper types
    const count = parseInt(req.query.count) || 10;
    try {
      const events = await eventBus.readRecent(stream, count);
      res.json(events);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /events/publish — Publish events from external sources
  router.post("/events/publish", async (req, res) => {
    try {
      const { type, payload, correlationId } = req.body || {};
      if (!type) {
        return res.status(400).json({ error: "Missing type" });
      }
      await eventBus.publish(redisKeys.streamNotifications(), {
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
  router.get("/config/:section", async (req, res) => {
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
  router.get("/config/:section/:name", async (req, res) => {
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
  router.put("/config/:section/:name", async (req, res) => {
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

  const ALERTS_KEY = redisKeys.alerts();
  const ALERTS_MAX = 100;

  // GET /alerts — List recent alerts
  router.get("/alerts", async (req, res) => {
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
  router.post("/alerts/:id/dismiss", async (req, res) => {
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
  router.post("/alerts/dismiss-all", async (req, res) => {
    try {
      await eventBus.publisher.del(ALERTS_KEY);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Sentry webhook
  // -----------------------------------------------------------------------

  router.post("/webhooks/sentry", async (req, res) => {
    try {
      const payload = req.body;
      const action = payload?.action;
      const data = payload?.data || {};
      const issue = data.issue || data.event || {};

      if (action && action !== "created" && action !== "triggered") {
        return res.json({ skipped: true, reason: `action ${action}` });
      }

      const title = issue.title || issue.message || "Unknown Sentry error";
      const project = payload?.project?.slug || payload?.project_slug || "unknown";
      const url = issue.web_url || issue.url || "";
      const culprit = issue.culprit || "";
      const level = issue.level || "error";

      if (level !== "error" && level !== "fatal") {
        return res.json({ skipped: true, reason: `level ${level}` });
      }

      const tracker = getTracker();
      await tracker.getRedisClient().rpush(redisKeys.anchorWorkQueue(), JSON.stringify({
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

      const r = eventBus.publisher;
      await r.lpush(redisKeys.alerts(), JSON.stringify({
        id: `sentry-${Date.now()}`,
        type: "sentry:issue",
        timestamp: new Date().toISOString(),
        message: `Sentry ${level} in ${project}: ${title}${culprit ? ` (${culprit})` : ""}`,
        severity: level === "fatal" ? "error" : "warning",
        dismissed: false,
        payload: { project, title, culprit, url },
      }));
      await r.ltrim(redisKeys.alerts(), 0, 99);

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

  router.get("/plan-cache/stats", async (req, res) => {
    res.json(getPlanCacheStats());
  });

  router.post("/plan-cache/invalidate", async (req, res) => {
    const count = await invalidatePlanCache();
    res.json({ invalidated: count });
  });

  // -----------------------------------------------------------------------
  // Reflections
  // -----------------------------------------------------------------------

  router.get("/reflections", async (req, res) => {
    try {
      const reflections = await getAllReflections();
      res.json({ reflections, count: reflections.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Calibration proxy
  // -----------------------------------------------------------------------

  const HYDRA_BETTING_URL = process.env.HYDRA_BETTING_URL || "http://localhost:3333";

  router.get("/calibration/outcomes", async (req, res) => {
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

  router.post("/calibration/outcomes/sync", async (req, res) => {
    try {
      const response = await fetch(`${HYDRA_BETTING_URL}/api/calibration/outcomes/sync`, { method: "POST" });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: `hydra-betting unavailable: ${err.message}` });
    }
  });

  // -----------------------------------------------------------------------
  // Environment variables
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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return { key, value, line };
    });
  }

  function maskValue(v: string): string {
    if (v.length <= 6) return "••••••";
    return v.slice(0, 3) + "•".repeat(Math.min(v.length - 6, 20)) + v.slice(-3);
  }

  // GET /env/:project — List env vars
  router.get("/env/:project", requireEnvAuth, async (req, res) => {
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

  // PUT /env/:project — Set/update a variable
  router.put("/env/:project", requireEnvAuth, async (req, res) => {
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
  router.delete("/env/:project/:key", requireEnvAuth, async (req, res) => {
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
  // Merge lock
  // -----------------------------------------------------------------------

  router.post("/merge/lock", async (req, res) => {
    try {
      const { cycleId } = req.body || {};
      const r = getTracker().getRedisClient();
      const acquired = await r.set(redisKeys.mergeLock(), cycleId || "unknown", "EX", 60, "NX");
      if (!acquired) {
        const holder = await r.get(redisKeys.mergeLock());
        return res.status(409).json({ locked: true, holder });
      }
      res.json({ acquired: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/merge/unlock", async (_req, res) => {
    try {
      await getTracker().getRedisClient().del(redisKeys.mergeLock());
      res.json({ released: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Agent memory
  // -----------------------------------------------------------------------

  router.post("/memory/:agent/pattern", async (req, res) => {
    try {
      const agentName = req.params.agent;
      const { category, action, example, cycleId, severity } = req.body || {};
      if (!category || !action) {
        return res.status(400).json({ error: "Missing category or action" });
      }
      const { recordPattern } = await import("../agent-memory.ts");
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

  router.get("/memory/:agent", async (req, res) => {
    try {
      const { loadAgentMemory } = await import("../agent-memory.ts");
      const memory = await loadAgentMemory(req.params.agent);
      res.type("text/plain").send(memory);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
