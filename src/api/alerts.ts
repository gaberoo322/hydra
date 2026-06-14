import { Router } from "express";
import {
  clearAlerts,
  pushAlert,
  readAllAlerts,
  readRecentAlerts,
  setAlertAt,
} from "../redis/alerts.ts";
import { pushToWorkQueue } from "../redis/work-queue.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { aggregatorRouteNoQuery } from "./route-helpers.ts";

/**
 * Alerts + Sentry webhook routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Alerts live in a Redis
 * list (`hydra:alerts`); Sentry webhook posts both queue an alert and enqueue
 * a work item.
 */
export function createAlertsRouter(_eventBus: any) {
  const router = Router();

  const ALERTS_MAX = 100;

  // GET /alerts — List recent alerts
  //
  // Issue #1863: the never-throw-500 isolation now comes from the
  // `aggregatorRouteNoQuery` seam (route-helpers.ts, #909) — the `[api/alerts]`
  // 500 log and the catch live there once. `limit` keeps its soft-parse
  // (default-on-garbage, NO behaviour-changing 400) INSIDE `produce`, per the
  // common.ts guidance that lenient read routes own their `safeParse`.
  router.get(
    "/alerts",
    aggregatorRouteNoQuery("api/alerts", async (req) => {
      // ADR-0022: read `limit` through the Schemas seam (safeParse on req.query).
      // countQuerySchema collapses bad/absent input to the default, preserving
      // the legacy `|| 50` semantics without a behaviour change.
      const limit = countQuerySchema(50).safeParse(req.query).data?.count ?? 50;
      const raw = await readRecentAlerts(limit + 1);
      return raw.map((s) => JSON.parse(s));
    }),
  );

  // POST /alerts/:id/dismiss — Dismiss an alert
  router.post("/alerts/:id/dismiss", async (req, res) => {
    try {
      const all = await readAllAlerts();
      for (let i = 0; i < all.length; i++) {
        const alert = JSON.parse(all[i]);
        if (alert.id === req.params.id) {
          alert.dismissed = true;
          await setAlertAt(i, JSON.stringify(alert));
          return res.json({ ok: true });
        }
      }
      res.status(404).json({ error: "Alert not found" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /alerts/dismiss-all — Dismiss all alerts
  router.post("/alerts/dismiss-all", async (_req, res) => {
    try {
      await clearAlerts();
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

      await pushAlert(JSON.stringify({
        id: `sentry-${Date.now()}`,
        type: "sentry:issue",
        timestamp: new Date().toISOString(),
        message: `Sentry ${level} in ${project}: ${title}${culprit ? ` (${culprit})` : ""}`,
        severity: level === "fatal" ? "error" : "warning",
        dismissed: false,
        payload: { project, title, culprit, url },
      }), ALERTS_MAX);

      console.log(`[Sentry Webhook] Queued: "${title}" from ${project}`);
      res.json({ queued: true, title });
    } catch (err: any) {
      console.error(`[Sentry Webhook] Failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
