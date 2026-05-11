/**
 * Codex OpenTelemetry helpers.
 *
 * Issue #199: emit per-agent-call OTel spans correlated with Hydra cycles.
 *
 * Codex CLI emits OTel traces and logs natively when configured via
 * `~/.codex/config.toml` (see docs/reference.md). To correlate those traces
 * with Hydra cycles, we inject resource attributes into the spawned CLI
 * process environment for each agent call:
 *
 *   - `hydra.cycle_id`     — correlates all spans from one cycle
 *   - `hydra.agent_role`   — planner / executor / fixer / etc
 *   - `hydra.task_id`      — backlog item / spec task identifier
 *   - `hydra.model_tier`   — frontier / codex / mini / local
 *   - `hydra.complexity`   — quick-fix / standard / complex / high-risk
 *
 * These flow into Codex's OTel exporter (`OTEL_RESOURCE_ATTRIBUTES`) as
 * span resource attributes, so a SigNoz / Tempo / Jaeger backend can
 * filter and group spans by cycle/agent/etc.
 *
 * Tier-1 scope: instrumentation only. Collector setup (SigNoz docker-compose,
 * dashboard panels) is deferred to follow-up issues per #199's scope guard.
 */

export type OtelAttrs = {
  cycleId?: string | null;
  agentName?: string | null;
  taskId?: string | null;
  modelTier?: string | null;
  resolvedModel?: string | null;
  complexity?: string | null;
};

/**
 * Sanitize an attribute value for inclusion in `OTEL_RESOURCE_ATTRIBUTES`.
 *
 * The W3C Baggage spec used by OTEL_RESOURCE_ATTRIBUTES disallows commas,
 * equals signs, and percent-encoded characters in unencoded form. We
 * defensively strip those plus trim whitespace and cap length.
 */
export function sanitizeAttrValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value).trim();
  if (s.length === 0) return "";
  // Strip commas/equals (separator chars) — collapses to underscore
  s = s.replace(/[,=]/g, "_");
  // Cap length — OTel spec allows up to ~256 chars per value safely
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

/**
 * Build an `OTEL_RESOURCE_ATTRIBUTES` value from Hydra context.
 *
 * Returns a comma-separated key=value string, e.g.
 *   "hydra.cycle_id=abc123,hydra.agent_role=planner,hydra.model_tier=frontier"
 *
 * Empty/null fields are omitted. Returns "" when no attributes are present.
 */
export function buildOtelResourceAttrs(attrs: OtelAttrs): string {
  const pairs: string[] = [];
  const map: Record<string, unknown> = {
    "hydra.cycle_id": attrs.cycleId,
    "hydra.agent_role": attrs.agentName,
    "hydra.task_id": attrs.taskId,
    "hydra.model_tier": attrs.modelTier,
    "hydra.model": attrs.resolvedModel,
    "hydra.complexity": attrs.complexity,
  };
  for (const [key, value] of Object.entries(map)) {
    const sanitized = sanitizeAttrValue(value);
    if (sanitized) pairs.push(`${key}=${sanitized}`);
  }
  return pairs.join(",");
}

/**
 * Merge Hydra OTel attributes into a base `OTEL_RESOURCE_ATTRIBUTES` value
 * (typically inherited from `process.env`). Hydra attributes win on collision.
 *
 * Returns the merged comma-separated string, or "" if both inputs are empty.
 */
export function mergeOtelResourceAttrs(base: string | undefined, hydraAttrs: string): string {
  if (!base && !hydraAttrs) return "";
  if (!base) return hydraAttrs;
  if (!hydraAttrs) return base;

  // Parse base into a map, then overlay hydra keys
  const merged = new Map<string, string>();
  for (const part of base.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) merged.set(k, v);
  }
  for (const part of hydraAttrs.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) merged.set(k, v);
  }
  return Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join(",");
}

/**
 * Whether OTel injection is enabled for this Hydra process.
 *
 * Controlled by env var `HYDRA_OTEL_ENABLED` (default: false). Operators
 * opt in once the Codex CLI's `~/.codex/config.toml` has an `[otel]`
 * exporter configured.
 */
export function isOtelEnabled(): boolean {
  return process.env.HYDRA_OTEL_ENABLED === "true" || process.env.HYDRA_OTEL_ENABLED === "1";
}

/**
 * Build the env-var overlay to pass to the Codex CLI for one agent call.
 *
 * When OTel is disabled, returns null — callers should skip env injection
 * entirely to preserve the existing process.env inheritance behavior.
 *
 * When OTel is enabled, returns a record that:
 *   - inherits all current `process.env`
 *   - overrides `OTEL_RESOURCE_ATTRIBUTES` with a base+hydra merge
 *   - sets `OTEL_SERVICE_NAME` to `hydra-codex` (override-safe)
 */
export function buildCodexOtelEnv(attrs: OtelAttrs): Record<string, string> | null {
  if (!isOtelEnabled()) return null;

  const hydraAttrs = buildOtelResourceAttrs(attrs);
  const merged = mergeOtelResourceAttrs(process.env.OTEL_RESOURCE_ATTRIBUTES, hydraAttrs);

  const env: Record<string, string> = {};
  // Inherit current process env so Codex CLI keeps PATH, HOME, OPENAI_API_KEY etc.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }

  if (merged) env.OTEL_RESOURCE_ATTRIBUTES = merged;
  // Set service name only if the operator hasn't pinned one
  if (!env.OTEL_SERVICE_NAME) env.OTEL_SERVICE_NAME = "hydra-codex";

  return env;
}

/**
 * Build an operator-facing trace UI URL for a given cycle (issue #207, Tier-3).
 *
 * The operator points `HYDRA_TRACE_UI_URL` at their observability backend
 * (Grafana → Tempo, SigNoz, Jaeger, etc). The string may contain the literal
 * placeholder `{cycleId}`, which is URL-encoded and substituted in. If no
 * placeholder is present, the cycle ID is appended as a query parameter
 * `?hydra_cycle_id=<id>` so links still resolve to a useful page.
 *
 * Returns null when the env var is unset or empty, or when the cycle ID is
 * missing — callers should fall back to "no link" UX in that case.
 *
 * No new dependency is introduced: substitution and encoding use the
 * Node.js stdlib `encodeURIComponent` and `URL` constructor only when the
 * input is well-formed.
 */
export function buildTraceUrl(cycleId: string | null | undefined, template?: string | undefined): string | null {
  const tpl = (template ?? process.env.HYDRA_TRACE_UI_URL ?? "").trim();
  if (!tpl) return null;
  const id = (cycleId ?? "").toString().trim();
  if (!id) return null;
  const encoded = encodeURIComponent(id);
  if (tpl.includes("{cycleId}")) {
    return tpl.replace(/\{cycleId\}/g, encoded);
  }
  // No placeholder — append as a query parameter so the link still carries the ID.
  const sep = tpl.includes("?") ? "&" : "?";
  return `${tpl}${sep}hydra_cycle_id=${encoded}`;
}
