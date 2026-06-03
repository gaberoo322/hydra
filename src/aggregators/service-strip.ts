/**
 * Service-strip aggregator (issue #618, PRD #615).
 *
 * Reshapes the existing `/api/health/services` payload into a list of rows
 * the Now-page health strip can render verbatim. Probes the same two
 * dependencies the dashboard's Health page already shows — VikingDB and
 * OpenViking — plus the orchestrator process itself and Redis, so the
 * pinned strip has all the load-bearing dependencies in one place.
 *
 * Why "pinned at top": the operator's first question every morning is
 * "is anything red?". One glance at the strip should answer it without
 * scrolling.
 *
 * # Design contract — same as overnight-summary.ts
 *
 * - Pure aggregator. All external touchpoints injected via `deps`.
 * - Never throws. A failed probe degrades to `{ status: "down" }` with the
 *   error captured in `lastError` — the row still renders.
 * - Probe timeout is 3s per service, hard-cap. The strip refreshes every
 *   15s on the dashboard, so a stuck probe can't pin the request.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Issue #954: resolve the OpenViking base URL from OPENVIKING_URL (via the
// OpenViking Request Adapter's `ovBaseUrl`) instead of hardcoding
// `http://localhost:1933` — a non-default OPENVIKING_URL must reach this probe
// too, or the strip lies exactly as the #231-class health-probe bug did. This
// aggregator keeps its injectable generic `probe(url, timeout)` dep; only the
// OV URL it passes is no longer a hardcoded literal.
import { ovBaseUrl } from "../knowledge-base/ov-request.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ServiceStatus = "ok" | "degraded" | "down";

export interface ServiceRow {
  service: string;
  status: ServiceStatus;
  lastChecked: string;
  lastError?: string;
  latencyMs?: number;
}

export interface ServiceStripDeps {
  /** Wall-clock anchor; defaults to `new Date()`. */
  now?: Date;
  /** HTTP probe — receives URL + timeout, returns ok / fail and latency. */
  probe?: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  /** Redis ping — returns true on success. */
  pingRedis?: () => Promise<boolean>;
  /**
   * Orchestrator self-check: returns true when the host process is healthy.
   * Defaults to checking for the absence of `~/hydra/.kill` (the operator
   * kill switch — same surface `/health` consults).
   */
  checkOrchestrator?: () => Promise<boolean>;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getServiceStrip(deps: ServiceStripDeps = {}): Promise<ServiceRow[]> {
  const now = deps.now ?? new Date();
  const lastChecked = now.toISOString();
  const probe = deps.probe ?? defaultProbe;
  const pingRedis = deps.pingRedis ?? defaultPingRedis;
  const checkOrch = deps.checkOrchestrator ?? defaultOrchestratorOk;

  // Run all four checks in parallel — none depends on another, and a slow
  // probe must not delay the rest.
  const [orchSettled, redisSettled, vikingdbSettled, openvikingSettled] =
    await Promise.allSettled([
      checkOrch(),
      pingRedis(),
      probe("http://localhost:5000/health", 3000),
      probe(`${ovBaseUrl()}/health`, 3000),
    ]);

  return [
    classifyBoolean({
      service: "orchestrator",
      result: orchSettled,
      lastChecked,
      degradedMessage: "kill-switch active",
    }),
    classifyBoolean({
      service: "redis",
      result: redisSettled,
      lastChecked,
      degradedMessage: undefined,
    }),
    classifyProbe({
      service: "vikingdb",
      result: vikingdbSettled,
      lastChecked,
    }),
    classifyProbe({
      service: "openviking",
      result: openvikingSettled,
      lastChecked,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Pure classifiers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Project a bool-returning health check into a ServiceRow. Used by the
 * orchestrator + Redis checks. `false` is treated as `down`; a thrown
 * promise also goes to `down` with the error captured. There's no
 * meaningful "degraded" middle state for these two — they're up or they're
 * not — but the `degradedMessage` knob lets the caller stamp a more
 * specific reason when relevant (e.g. orchestrator kill-switch).
 */
export function classifyBoolean(input: {
  service: string;
  result: PromiseSettledResult<boolean>;
  lastChecked: string;
  degradedMessage?: string;
}): ServiceRow {
  if (input.result.status === "rejected") {
    return {
      service: input.service,
      status: "down",
      lastChecked: input.lastChecked,
      lastError: input.result.reason?.message || String(input.result.reason),
    };
  }
  if (input.result.value === true) {
    return { service: input.service, status: "ok", lastChecked: input.lastChecked };
  }
  return {
    service: input.service,
    status: "down",
    lastChecked: input.lastChecked,
    lastError: input.degradedMessage ?? `${input.service} is not responding`,
  };
}

/**
 * Project a probe result into a ServiceRow. Three-way: ok / degraded / down.
 *
 *   - `ok`        — probe returned 2xx, latency < 1000ms
 *   - `degraded`  — probe returned 2xx but latency >= 1000ms (slow but alive)
 *   - `down`      — probe failed or threw
 */
export function classifyProbe(input: {
  service: string;
  result: PromiseSettledResult<ProbeResult>;
  lastChecked: string;
}): ServiceRow {
  if (input.result.status === "rejected") {
    return {
      service: input.service,
      status: "down",
      lastChecked: input.lastChecked,
      lastError: input.result.reason?.message || String(input.result.reason),
    };
  }
  const probe = input.result.value;
  if (!probe.ok) {
    return {
      service: input.service,
      status: "down",
      lastChecked: input.lastChecked,
      lastError: probe.error || "probe failed",
      latencyMs: probe.latencyMs,
    };
  }
  if (probe.latencyMs >= 1000) {
    return {
      service: input.service,
      status: "degraded",
      lastChecked: input.lastChecked,
      lastError: `slow probe (${probe.latencyMs}ms)`,
      latencyMs: probe.latencyMs,
    };
  }
  return {
    service: input.service,
    status: "ok",
    lastChecked: input.lastChecked,
    latencyMs: probe.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Default probes — production wiring
// ---------------------------------------------------------------------------

async function defaultProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      const latencyMs = Date.now() - start;
      if (!r.ok) {
        return { ok: false, latencyMs, error: `HTTP ${r.status}` };
      }
      return { ok: true, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err?.message || String(err) };
  }
}

async function defaultPingRedis(): Promise<boolean> {
  try {
    const { getRedisConnection } = await import("../redis/connection.ts");
    const r = getRedisConnection();
    const reply = await r.ping();
    return reply === "PONG" || reply === "PONG\n" || reply === true || reply === "PONG\r\n";
  } catch (err: any) {
    console.error(`[service-strip] redis ping failed: ${err?.message || err}`);
    return false;
  }
}

async function defaultOrchestratorOk(): Promise<boolean> {
  // Same convention as src/api/health.ts: presence of `~/hydra/.kill`
  // means the kill switch is active. No file → orchestrator is healthy.
  const hydraRoot = process.env.HYDRA_ROOT || resolve(process.env.HOME ?? "", "hydra");
  const killFile = resolve(hydraRoot, ".kill");
  return !existsSync(killFile);
}
