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
import { pingRedis } from "../redis/utility.ts";
// Issue #2281: the probe-status DISPLAY vocabulary ("ok"|"degraded"|"down"), the
// degraded latency threshold, and the pure classify logic are owned by the
// ServiceProbe Adapter Seam (src/health/probe.ts), next to the probe producers
// whose results they classify. service-strip composes those canonical
// classifiers instead of re-implementing them inline, so the status vocabulary
// has a single definition rather than two that silently diverge. ServiceRow
// stays a DISTINCT display record (it layers service/lastChecked/lastError onto
// the shared status) — #2281 converged the vocabulary, NOT the record types.
import {
  classifyServiceBoolean,
  classifyServiceProbe,
  type ProbeStatus,
} from "../health/probe.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// The Now-page display status. Aliases the canonical ProbeStatus union from the
// ServiceProbe Adapter Seam (#2281) so there is one definition of the
// "ok"|"degraded"|"down" vocabulary, not a parallel copy here.
type ServiceStatus = ProbeStatus;

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
 *
 * Issue #2281: the status/lastError classification is delegated to the shared
 * `classifyServiceBoolean` in the ServiceProbe Adapter Seam; this function only
 * layers the display fields (`service`, `lastChecked`) onto the result.
 */
export function classifyBoolean(input: {
  service: string;
  result: PromiseSettledResult<boolean>;
  lastChecked: string;
  degradedMessage?: string;
}): ServiceRow {
  const c = classifyServiceBoolean(input.result, {
    service: input.service,
    degradedMessage: input.degradedMessage,
  });
  return {
    service: input.service,
    status: c.status,
    lastChecked: input.lastChecked,
    ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
  };
}

/**
 * Project a probe result into a ServiceRow. Three-way: ok / degraded / down.
 *
 *   - `ok`        — probe returned 2xx, latency < 1000ms
 *   - `degraded`  — probe returned 2xx but latency >= 1000ms (slow but alive)
 *   - `down`      — probe failed or threw
 *
 * Issue #2281: the three-way classification + the 1000ms degraded threshold are
 * delegated to the shared `classifyServiceProbe` in the ServiceProbe Adapter
 * Seam; this function only layers the display fields (`service`, `lastChecked`)
 * onto the result.
 */
export function classifyProbe(input: {
  service: string;
  result: PromiseSettledResult<ProbeResult>;
  lastChecked: string;
}): ServiceRow {
  const c = classifyServiceProbe(input.result);
  return {
    service: input.service,
    status: c.status,
    lastChecked: input.lastChecked,
    ...(c.lastError !== undefined ? { lastError: c.lastError } : {}),
    ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
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

// The Redis liveness probe goes through the typed `pingRedis()` accessor in
// the redis/connection seam module (issue #1121) — no dynamic await-import of
// the raw connection, no raw `getRedisConnection()`. The accessor already
// swallows connection errors and resolves `false`, preserving the
// degrade-to-down contract.
const defaultPingRedis = pingRedis;

async function defaultOrchestratorOk(): Promise<boolean> {
  // Same convention as src/api/health.ts: presence of `~/hydra/.kill`
  // means the kill switch is active. No file → orchestrator is healthy.
  const hydraRoot = process.env.HYDRA_ROOT || resolve(process.env.HOME ?? "", "hydra");
  const killFile = resolve(hydraRoot, ".kill");
  return !existsSync(killFile);
}
