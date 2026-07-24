import { Router } from "express";
import {
  clearAlerts,
  pushAlert,
  readAllAlerts,
  readRecentAlerts,
  setAlertAt,
} from "../redis/alerts.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { SentryWebhookPayloadSchema } from "../schemas/webhooks.ts";
import { aggregatorRouteNoQuery, isolateAggregator, schemaValidationError } from "./route-helpers.ts";
import { logger } from "../logger.ts";

/**
 * Alerts + Sentry webhook routes.
 *
 * Extracted from api/misc.ts as part of issue #268. Alerts live in a Redis
 * list (`hydra:alerts`); a Sentry webhook post records an alert. (The prior
 * Redis work-queue enqueue was retired with the Redis backlog subsystem —
 * ADR-0031 contract phase, issue #3439.)
 */
export function createAlertsRouter() {
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

  // POST /alerts/:id/dismiss — Dismiss an alert.
  //
  // Not an isolateAggregator route: the success path writes a 404 for a
  // not-found id directly, which the seam (JSON-at-200 of produce's return)
  // can't express. ADR-0027 eighth sweep: the catch adopts the pino seam.
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
      logger.error({ alertId: req.params.id, err }, "[api/alerts] dismiss failed");
      res.status(500).json({ error: err.message });
    }
  });

  // POST /alerts/dismiss-all — Dismiss all alerts.
  //
  // Issue #909 / ADR-0027 eighth sweep: the 500 envelope + pino `err`-field log
  // live in the isolateAggregator seam (route-helpers.ts) once.
  router.post("/alerts/dismiss-all", async (_req, res) =>
    isolateAggregator(res, "api/alerts/dismiss-all", async () => {
      await clearAlerts();
      return { ok: true };
    }),
  );

  // POST /webhooks/sentry — Sentry alert webhook
  //
  // ADR-0022: validate the external webhook body through the Schemas seam
  // (issue #3199). SentryWebhookPayloadSchema uses .passthrough() so unknown
  // keys do not 400 (Sentry's payload shape varies by event type/SDK version);
  // the guard only rejects payloads that are structurally not objects.
  router.post("/webhooks/sentry", async (req, res) => {
    try {
      const parseResult = SentryWebhookPayloadSchema.safeParse(req.body);
      if (!parseResult.success) {
        logger.error({ issues: parseResult.error.issues }, "[Sentry Webhook] schema validation failed");
        return res.status(400).json(schemaValidationError(parseResult.error));
      }
      const payload = parseResult.data;
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

      await pushAlert(JSON.stringify({
        id: `sentry-${Date.now()}`,
        type: "sentry:issue",
        timestamp: new Date().toISOString(),
        message: `Sentry ${level} in ${project}: ${title}${culprit ? ` (${culprit})` : ""}`,
        severity: level === "fatal" ? "error" : "warning",
        dismissed: false,
        payload: { project, title, culprit, url },
      }), ALERTS_MAX);

      logger.info({ title, project }, "[Sentry Webhook] alerted");
      res.json({ queued: true, title });
    } catch (err: any) {
      logger.error({ err }, "[Sentry Webhook] failed");
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
