import { Router } from "express";
import { redisKeys } from "../redis-keys.ts";
import { pushToWorkQueue } from "../redis-adapter.ts";

/**
 * Alerts + Sentry webhook routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Alerts live in a Redis
 * list (`hydra:alerts`); Sentry webhook posts both queue an alert and enqueue
 * a work item.
 */
export function createAlertsRouter(eventBus: any) {
  const router = Router();

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

  // POST /webhooks/sentry — Sentry alert webhook
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

      await pushToWorkQueue(JSON.stringify({
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

  return router;
}
