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
 *   - GET /observability/trace-url?cycleId=<id> — resolved deep-link or null
 *
 * The template may contain `{cycleId}`; if absent, the cycle ID is appended
 * as `?hydra_cycle_id=<id>`.
 */

export function isOtelEnabled(): boolean {
  return process.env.HYDRA_OTEL_ENABLED === "true" || process.env.HYDRA_OTEL_ENABLED === "1";
}

export function buildTraceUrl(cycleId: string | null | undefined, template?: string | undefined): string | null {
  const tpl = (template ?? process.env.HYDRA_TRACE_UI_URL ?? "").trim();
  if (!tpl) return null;
  const id = (cycleId ?? "").toString().trim();
  if (!id) return null;
  const encoded = encodeURIComponent(id);
  if (tpl.includes("{cycleId}")) {
    return tpl.replace(/\{cycleId\}/g, encoded);
  }
  const sep = tpl.includes("?") ? "&" : "?";
  return `${tpl}${sep}hydra_cycle_id=${encoded}`;
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

  // GET /observability/trace-url?cycleId=<id> — resolved deep-link
  router.get("/observability/trace-url", (req, res) => {
    const raw = req.query.cycleId;
    const cycleId = Array.isArray(raw) ? String(raw[0] ?? "") : (raw ? String(raw) : "");
    if (!cycleId) {
      return res.status(400).json({ error: "Missing query parameter 'cycleId'" });
    }
    const url = buildTraceUrl(cycleId);
    res.json({ cycleId, url });
  });

  return router;
}
