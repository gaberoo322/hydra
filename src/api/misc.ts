import { Router } from "express";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { killCycle } from "../cycle.ts";
import { sendDigestNow } from "../digest.ts";
import { classifyChange } from "../tier-classifier.ts";

/**
 * Residual "misc" routes that don't fit elsewhere.
 *
 * Issue #268 split this file — see api/openviking.ts, api/goals.ts,
 * api/events.ts, api/config.ts, api/alerts.ts, api/plan-cache.ts,
 * api/reflections.ts, api/merge-lock.ts. What remains here are operational
 * routes without a natural domain home: kill switch, OpenAI proxy, digest
 * trigger, tier classifier, and agent-memory CRUD.
 *
 * New routes should prefer a domain-specific sub-router. Only land here if
 * the route is genuinely orphan-operational.
 */
export function createMiscRouter(eventBus: any) {
  const router = Router();

  const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
  const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

  // POST /kill — Emergency stop
  router.post("/kill", async (req, res) => {
    writeFileSync(KILL_FILE, new Date().toISOString());
    const result = await killCycle(eventBus);
    res.json({ ...result, killFile: KILL_FILE });
  });

  // GET /tier?files=a,b,c — Modification tier classification (issue #243,
  // ADR-0004 work-order step 3). Used by autopilot/dashboard to know
  // which merge policy applies to a proposed change.
  router.get("/tier", (req, res) => {
    const raw = req.query.files;
    if (raw === undefined || raw === null) {
      return res.status(400).json({ error: "Missing query parameter 'files' (comma-separated)" });
    }
    const list = Array.isArray(raw) ? raw.flatMap(s => String(s).split(",")) : String(raw).split(",");
    const files = list.map(s => s.trim()).filter(s => s.length > 0);
    const result = classifyChange(files);
    res.json(result);
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
      const { recordPattern } = await import("../learning.ts");
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
      const { loadAgentMemory } = await import("../learning.ts");
      const memory = await loadAgentMemory(req.params.agent);
      res.type("text/plain").send(memory);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /memory/subagent-lesson (issue #392) — lesson-capture hook for
  // autopilot-dispatched subagents (hydra-dev / hydra-qa / hydra-target-build).
  // After codex-runner is deleted by issue #383, this is the *only*
  // post-cycle writer to hydra:memory:{agent}:patterns. The endpoint is
  // intentionally a thin wrapper around captureSubagentLesson() so the
  // existing 3-hit auto-promotion pipeline continues to apply unchanged.
  router.post("/memory/subagent-lesson", async (req, res) => {
    try {
      const { skill, outcome, cue, context, action, severity, cycleId } = req.body || {};
      const { captureSubagentLesson, isValidSkill, isValidOutcome } =
        await import("../learning/subagent-capture.ts");

      if (!isValidSkill(skill)) {
        return res.status(400).json({
          error: `Invalid or missing 'skill' — expected hydra-qa | hydra-dev | hydra-target-build`,
        });
      }
      if (!isValidOutcome(outcome)) {
        return res.status(400).json({
          error: `Invalid or missing 'outcome' — expected qa-fail | verification-failure | no-diff | rollback`,
        });
      }
      if (typeof cue !== "string" || cue.trim().length === 0) {
        return res.status(400).json({ error: "Missing 'cue' (non-empty string)" });
      }

      const result = await captureSubagentLesson({
        skill,
        outcome,
        cue,
        context: typeof context === "string" ? context : "",
        action: typeof action === "string" ? action : undefined,
        severity: severity === "reinforce" ? "reinforce" : "prevent",
        cycleId: typeof cycleId === "string" ? cycleId : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error(`[api/memory/subagent-lesson] failed:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
