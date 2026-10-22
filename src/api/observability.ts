import { Router } from "express";

/**
 * Observability surface (issue #207, Tier-3).
 *
 * Exposes the operator-configured trace UI base URL so the dashboard can
 * deep-link from cycle IDs into the operator's observability backend
 * (Grafana → Tempo, SigNoz, Jaeger, ...). All configuration lives in
 * environment variables — no runtime mutation, no secrets sent to the
 * dashboard.
 *
 * Endpoints:
 *   - GET /observability/config — flags + URL template (safe to render)
 *
 * `GET /observability/trace-url` (the server-resolved deep-link) and its
 * `buildTraceUrl` helper were retired under ADR-0024 §3 (issue #4638): zero
 * callers. The template's `{cycleId}` placeholder contract is still echoed by
 * `/observability/config`.
 */

export function isOtelEnabled(): boolean {
  return process.env.HYDRA_OTEL_ENABLED === "true" || process.env.HYDRA_OTEL_ENABLED === "1";
}

export function createObservabilityRouter() {
  const router = Router();

  // GET /observability/config — what the dashboard needs to render OTel UI
  router.get("/observability/config", (_req, res) => {
    const template = (process.env.HYDRA_TRACE_UI_URL ?? "").trim();
    res.json({
      otelEnabled: isOtelEnabled(),
      traceUrlTemplate: template || null,
      // Echo the placeholder contract so the dashboard can hint at what
      // the operator should configure if `traceUrlTemplate` is null.
      placeholder: "{cycleId}",
    });
  });

  return router;
}
