// ServiceProbe Adapter Seam (issue #1980) — extracted from src/api/health.ts.
//
// The plain-HTTP service probe (probeService) and the OpenViking liveness probe
// (probeOv), plus the {status, latencyMs} wire shape they fold to
// (ServiceProbeResult), used to live in the route file src/api/health.ts. Issue
// #1324 first hoisted them from inline closures (duplicated in /health/services
// and the /health/deep fan-out) to module-level; this issue completes the move
// by giving them a focused, named home so "how does the orchestrator classify a
// service as running vs failed?" has a single answer.
//
// This is a thin probe-classification seam, NOT a new boundary Adapter family.
// It composes existing boundaries: probeOv() delegates to the OpenViking Request
// Adapter (ovHealthGet, src/knowledge-base/ov-request.ts, #954) and probeService
// uses globalThis.fetch via an injectable impl. There is no raw child_process or
// raw OpenViking fetch to fence, so — unlike the Host-Probe Adapter
// (src/host-probe/*) — it stays a single file with no seam-check ratchet.
//
// It deliberately lives at src/ top-level (NOT src/api/), mirroring the
// src/health-diagnostics.ts pure Health Assessment seam: the probes are a domain
// seam consumed by route code, and a non-route caller (e.g.
// src/aggregators/service-strip.ts) composing the canonical probes should not
// import from src/api/.
import { ovHealthGet, ovPostJson, isOvFailure, type OvResult } from "./knowledge-base/ov-request.ts";
import { OV_SEARCH_PROBE_TIMEOUT_MS } from "./health-diagnostics.ts";

/** The wire shape every service probe folds to: `{status, latencyMs}`. */
export type ServiceProbeResult = {
  status: "running" | "failed";
  latencyMs: number | null;
};

/** The probe timeout for the plain-HTTP service probe (preserved 1:1 across both former call sites). */
const SERVICE_PROBE_TIMEOUT_MS = 3000;

/**
 * Probe a plain-HTTP service endpoint, folding the outcome to the
 * `{status, latencyMs}` wire shape both /health/services and /health/deep emit.
 *
 * NEVER throws — a transport failure or timeout folds to
 * `{status:"failed", latencyMs:null}`, the sentinel shape parseProbes/assessHealth
 * downstream depend on. A non-2xx response is `failed` unless `acceptAny` is set
 * (the probe only cares that the port answered). Unified on
 * `AbortSignal.timeout(3000)` (the modern primitive — no manual timer bookkeeping).
 *
 * `fetchImpl` is an injectable dependency (default `globalThis.fetch`) so the
 * test can stub success/non-2xx/throw/timeout without a real network.
 */
export async function probeService(
  url: string,
  {
    acceptAny = false,
    fetchImpl = globalThis.fetch,
  }: { acceptAny?: boolean; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<ServiceProbeResult> {
  try {
    const start = Date.now();
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(SERVICE_PROBE_TIMEOUT_MS) });
    return { status: r.ok || acceptAny ? "running" : "failed", latencyMs: Date.now() - start };
  } catch {
    // Fail-loud convention: this sentinel is the documented I/O-boundary fold,
    // not a silent swallow — both routes rely on a probe failure becoming
    // {status:"failed", latencyMs:null}.
    return { status: "failed", latencyMs: null };
  }
}

/**
 * Probe OpenViking liveness via the OpenViking Request Adapter (resolves
 * OPENVIKING_URL, 3000ms timeout) and fold it to the same `{status, latencyMs}`
 * wire shape. The adapter (`ovHealthGet`) never throws; we map its discriminated
 * result to running/failed. `ovHealthGetImpl` is injectable for the test.
 */
export async function probeOv(
  { ovHealthGetImpl = ovHealthGet }: { ovHealthGetImpl?: typeof ovHealthGet } = {},
): Promise<ServiceProbeResult> {
  const start = Date.now();
  const result = await ovHealthGetImpl("/health", { timeout: SERVICE_PROBE_TIMEOUT_MS });
  return {
    status: isOvFailure(result) ? "failed" : "running",
    latencyMs: isOvFailure(result) ? null : Date.now() - start,
  };
}

/**
 * Probe the OpenViking dense-embedding backend specifically (issue #2013).
 *
 * Why a DISTINCT probe (not the openviking liveness key, not the index-14
 * ovSearch quality field):
 *  - `probeOv()` (the `openviking` key) only hits OV's `GET /health`, which is a
 *    shallow app-liveness check (`{status:"ok"}`) — it reports OV-the-app is up
 *    even while its dense-embedding backend (`ollama-embed:11434`, reachable only
 *    INSIDE the OV container) is stale/unreachable. That blind spot is exactly
 *    what made #1921 invisible: OV looked healthy, search hung ~23s.
 *  - The index-14 ovSearch probe DOES exercise the embedding path, but it measures
 *    end-to-end search QUALITY (result count / fallback) — folding embed-backend
 *    liveness into a search-quality field conflates "OV searchable" with "the
 *    dense-embedding backend is live" (#2013 wants the latter attributable).
 *
 * The orchestrator has no direct network path to `ollama-embed` (OV owns that
 * hop via `extra_hosts`), so the honest embed-backend signal it CAN obtain is the
 * embedding-exercising `search/find` transport, routed through the existing
 * OpenViking Request Adapter (`ovPostJson` → resolves OPENVIKING_URL + auth — no
 * new hardcoded URL, no inline X-Api-Key). A transport failure that never reached
 * the backend (`ov-service-down`/`ov-timeout`) folds to `failed`; OV answering at
 * all (2xx, or even a non-2xx app error — the backend responded) folds to
 * `running`. This is the same `{status, latencyMs}` ServiceProbe shape every
 * other probe emits.
 *
 * NEVER throws — the adapter is contractually never-throwing; both arms map
 * exhaustively. `ovPostJsonImpl` is injectable for the test.
 */
export async function probeEmbedBackend(
  { ovPostJsonImpl = ovPostJson }: { ovPostJsonImpl?: typeof ovPostJson } = {},
): Promise<ServiceProbeResult> {
  const start = Date.now();
  const result: OvResult<any> = await ovPostJsonImpl(
    "/api/v1/search/find",
    { query: "embedding backend health", limit: 1 },
    { timeout: OV_SEARCH_PROBE_TIMEOUT_MS },
  );
  // A transport-level failure (DNS/ECONNREFUSED) or timeout means the
  // embedding-exercising path never reached the backend → embed backend down.
  // OV answering at all (success, or even an app-level non-2xx / malformed JSON)
  // means the backend was reachable enough to respond → running. Discriminate on
  // the machine-readable `code`, never on prose.
  const unreachable =
    isOvFailure(result) && (result.code === "ov-service-down" || result.code === "ov-timeout");
  return {
    status: unreachable ? "failed" : "running",
    latencyMs: unreachable ? null : Date.now() - start,
  };
}
