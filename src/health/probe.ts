// ServiceProbe Adapter Seam (issue #1980) — extracted from src/api/health.ts.
//
// The plain-HTTP service probe (probeService) and the OpenViking liveness probe
// (probeOv), plus the {status, latencyMs} wire shape they fold to
// (ServiceProbeResult), used to live in the route file src/api/health.ts. Issue
// #1324 first hoisted them from inline closures (duplicated in /health/services
// and the /health/deep fan-out) to module-level; this issue completes the move
// by giving them a focused, named home so "how does the orchestrator classify a
// service as running vs failed?" has a single answer. (The Tailnet Ollama VLM
// liveness probe that once lived here was retired at the VLM cutover, #3544.)
//
// This is a thin probe-classification seam, NOT a new boundary Adapter family.
// It composes existing boundaries: probeOv() delegates to the OpenViking Request
// Adapter (ovHealthGet, src/knowledge-base/ov-request.ts, #954) and probeService
// uses globalThis.fetch via an injectable impl. There is no raw child_process or
// raw OpenViking fetch to fence, so — unlike the Host-Probe Adapter
// (src/host-probe/*) — it stays a single file with no seam-check ratchet.
//
// It deliberately lives at src/ top-level (NOT src/api/), mirroring the
// src/health/diagnostics.ts pure Health Assessment seam: the probes are a domain
// seam consumed by route code, and a non-route caller (e.g.
// src/aggregators/service-strip.ts) composing the canonical probes should not
// import from src/api/.
import {
  ovHealthGet,
  ovPostJson,
  ovRequest,
  isOvFailure,
  // Issue #2269: reuse the #2250 server-side-timeout body classifier so the skills
  // liveness probe treats OV's "Request timed out." 500 as down, NOT responsive.
  // Issue #2373: it now lives in the Request Adapter seam (was skill-registration.ts).
  isOvServerTimeout,
  type OvResult,
} from "../knowledge-base/ov-request.ts";

// ---- Pure display-status classification (issue #3115) ---------------------
//
// The three-way ok|degraded|down service DISPLAY classifiers (#2281) and the
// OV-search deep-health probe classification (#2023) — plus the constants/types
// they reason about (DEGRADED_LATENCY_THRESHOLD_MS, ProbeOutcome,
// OV_SEARCH_PROBE_TIMEOUT_MS, OvSearchProbeStatus) —
// were split out of this file into the zero-IO leaf src/health/probe-classify.ts
// so a consumer needing only the classifiers pulls none of the OV/fetch adapter
// machinery into module-load. They are re-exported here 1:1 so every existing
// importer keeps its EXACT current import from ./probe.ts (zero-diff relay). The
// IO probe PRODUCERS (probeService/probeOv/probeEmbedBackend/probeSkillsEndpoint)
// and their ServiceProbeResult producer output contract stay in
// THIS file below — the display classifiers are one level up from them.
export {
  classifyServiceProbe,
  classifyServiceBoolean,
  classifyOvSearchProbe,
  DEGRADED_LATENCY_THRESHOLD_MS,
  OV_SEARCH_PROBE_TIMEOUT_MS,
  type ProbeStatus,
  type ProbeOutcome,
  type OvSearchProbeStatus,
} from "./probe-classify.ts";
// The IO producers below (probeEmbedBackend, probeSkillsEndpoint) reference the
// OV-search ceiling as a value — import it for local use alongside the relay.
import { OV_SEARCH_PROBE_TIMEOUT_MS } from "./probe-classify.ts";

/** The wire shape every service probe folds to: `{status, latencyMs}`. */
export type ServiceProbeResult = {
  status: "running" | "failed";
  latencyMs: number | null;
};

/** The probe timeout for the plain-HTTP service probe (preserved 1:1 across both former call sites). */
const SERVICE_PROBE_TIMEOUT_MS = 3000;

// The Tailnet Ollama VLM liveness probe (`probeOllamaVlm`, issue #2278) was
// retired at the OpenViking VLM cutover (issue #3544). OpenViking's VLM backend
// moved off the gaming-PC Ollama host (`gabes-desktop-1:11434`) onto the in-repo
// claude-cli `/vlm` shim (issue #3542), so a DIRECT reachability probe of the
// gaming PC no longer measures anything OpenViking depends on — it monitored a
// host nothing uses. The embed-backend probe below (probeEmbedBackend) is
// UNAFFECTED: it exercises OV's live dense-embedding path (now TEI-backed, #3543)
// via the search/find transport, which is still a valid liveness signal.

/**
 * The skills-endpoint liveness probe `AbortSignal` ceiling (ms) — issue #2163.
 *
 * Deliberately SHORT (the SERVICE_PROBE_TIMEOUT_MS family, 3s) and NOT the 120s
 * SKILL_REGISTER_TIMEOUT_MS the real registration uses. The probe only asks "is
 * the `/api/v1/skills` POST handler answering RIGHT NOW?" — not "can a full
 * 120s registration complete?". When OpenViking is load-gated (#1831) the
 * handler does not answer inside this window and the probe folds to `ov-timeout`
 * → `failed`, which is exactly the gate signal the chore needs: do NOT launch a
 * doomed 4×120s registration pass against a handler that cannot even answer a
 * cheap validation reject in 3s.
 */
const SKILLS_PROBE_TIMEOUT_MS = 3000;

/**
 * The deliberately-invalid payload the skills liveness probe POSTs (issue #2163).
 *
 * The chore exercises `POST /api/v1/skills`, but there is NO read verb on that
 * resource — OpenViking answers GET/HEAD with a router-level `405 Method Not
 * Allowed` (`allow: POST`) BEFORE the request ever reaches the load-gated
 * registration handler. A GET/HEAD probe would therefore measure the wrong
 * resource: it would report `running` off an instant 405 even while the POST
 * handler is timing out under indexing load — the exact shallow-probe decoupling
 * (`probeOv`'s GET /health) this issue fixes.
 *
 * So the honest "is the skills POST handler responsive?" signal is a POST that
 * the handler rejects FAST on an obviously-invalid payload. An empty body makes
 * OV's skill validator reject with an instant app-error ("Skill data cannot be
 * None") BEFORE any indexing/embedding/catalog write happens — so it is
 * read-only in effect (INV2: it mutates NO catalog entry) yet it still routes
 * through the SAME load-gated handler the chore depends on. Under load that
 * handler cannot answer in 3s and the probe folds to `failed`.
 *
 * Issue #2365: because this reject is DELIBERATE and fires hourly, the probe POSTs
 * it with `expectNon2xx:true` (see `probeSkillsEndpoint`) so the OV Request Adapter
 * logs the "Skill data cannot be None" 500 at info level rather than the alarming
 * `console.error` ov-non-2xx line — which had been mistaken for a real
 * skill-registration failure in the orchestrator logs (the confusion that
 * generated #2365). The classification below is unaffected.
 */
const SKILLS_PROBE_INVALID_BODY = { data: null } as const;

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

/**
 * Probe the OpenViking SKILLS endpoint specifically (issue #2163) — the resource
 * the skill-catalog-reregister chore actually writes to.
 *
 * Why a DISTINCT probe (not `probeOv`, not `probeEmbedBackend`):
 *  - `probeOv()` only hits OV's `GET /health` — shallow app-liveness. It reports
 *    `running` while `POST /api/v1/skills` is timing out under indexing load
 *    (#1831). Gating the chore on it green-lit a guaranteed-doomed registration
 *    pass EVERY hour: OV-the-app answered /health in <100ms, the gate passed,
 *    and the chore then hammered the down POST handler for up to ~24min/hour
 *    (4 skills × 3 attempts × 120s). That decoupling is this issue's root cause.
 *  - `probeEmbedBackend()` exercises the search/embedding path, not the
 *    skills-registration path — a healthy search would still green-light a doomed
 *    skills POST. The gate must probe the resource the chore depends on.
 *
 * Verb (the issue's OPEN GAP, resolved here): OpenViking exposes NO read verb on
 * `/api/v1/skills` — GET and HEAD both return a router-level `405 Method Not
 * Allowed` (`allow: POST`) before reaching the load-gated handler, so a GET/HEAD
 * probe would measure the wrong (router) layer and lie. The honest, side-effect-
 * free signal is a SHORT-timeout POST of a deliberately-invalid payload
 * ({@link SKILLS_PROBE_INVALID_BODY}): it routes through the SAME load-gated POST
 * handler, which validation-rejects it (instant app-error) WITHOUT mutating the
 * catalog (INV2 — read-only in effect). Under load the handler cannot answer in
 * {@link SKILLS_PROBE_TIMEOUT_MS} and the adapter returns `ov-timeout` →
 * `failed`, which is the chore's correct "do not launch a doomed pass" gate.
 *
 * Classification: a transport failure (`ov-service-down`) or a timeout
 * (`ov-timeout`) means the handler could not be reached / could not answer in
 * the short window → `failed`. ANY answer from the handler — a 2xx, or the
 * EXPECTED validation `ov-non-2xx` / `ov-malformed-json` — proves it is
 * responsive → `running`. We discriminate on the machine-readable `code`, never
 * on prose. Same `{status, latencyMs}` ServiceProbe shape every other probe
 * emits.
 *
 * SERVER-SIDE-TIMEOUT EXCEPTION (issue #2269) — the resilience gap this fixes:
 * under sustained indexing load OpenViking surfaces its OWN request timeout as a
 * `500` whose body is `{error:{code:"INTERNAL", message:"Request timed out."}}`
 * — structurally an `ov-non-2xx` (the adapter keys on `!res.ok`, not the body).
 * That 500 is NOT a fast validation reject; it is the load-gated handler failing
 * to answer in time — the EXACT doomed-pass condition #2163 built this probe to
 * suppress. Folding it to `running` defeats the gate: the chore green-lights an
 * hourly registration pass that then hits the same overloaded handler, every
 * skill 500s with the same "Request timed out." body, all 3 retries exhaust, and
 * the catalog stays empty (the #2269 evidence: `ov-non-2xx: 500` on every skill,
 * `contextAvailabilityRate: 0`). So an `ov-non-2xx` whose body matches OV's
 * server-side-timeout shape ({@link isOvServerTimeout} — the same #2250 predicate
 * the registration retry uses) folds to `failed`. A genuine validation `ov-non-2xx`
 * (any OTHER body) still proves the handler answered fast → stays `running`,
 * preserving the #2163 "an app-level reject means live" signal.
 *
 * NEVER throws — the OV Request Adapter is contractually never-throwing and both
 * arms map exhaustively. `ovRequestImpl` is injectable for the test.
 */
export async function probeSkillsEndpoint(
  { ovRequestImpl = ovRequest }: { ovRequestImpl?: typeof ovRequest } = {},
): Promise<ServiceProbeResult> {
  const start = Date.now();
  const result: OvResult<any> = await ovRequestImpl(
    "/api/v1/skills",
    { method: "POST", body: JSON.stringify(SKILLS_PROBE_INVALID_BODY) },
    // Issue #2365: `expectNon2xx` quiets the adapter's `console.error` for the
    // validation reject this probe DELIBERATELY provokes ({data:null} →
    // "Skill data cannot be None" 500). The reject IS the liveness signal, so it
    // must not be logged as an alarming registration failure every hour. The
    // returned OvResult is unchanged — the classification below is unaffected.
    { timeout: SKILLS_PROBE_TIMEOUT_MS, expectNon2xx: true },
  );
  // The handler is responsive UNLESS the request never reached it (transport
  // down), it could not answer inside the short window (timeout), OR it answered
  // with OV's own server-side-timeout 500 (an `ov-non-2xx` carrying the "Request
  // timed out." body — issue #2269). That last case looks like an answer but is
  // really the load-gated handler failing under indexing load; treating it as
  // live green-lit a doomed recovery pass every hour. An app-level non-2xx /
  // malformed-json with any OTHER body means the handler DID answer fast (it
  // rejected our deliberately-invalid payload) → the resource is live → running.
  const unreachable =
    isOvFailure(result) &&
    (result.code === "ov-service-down" ||
      result.code === "ov-timeout" ||
      // `isOvFailure` narrows away the optional `body`, so read it off the
      // failure arm explicitly (present only on ov-non-2xx; undefined otherwise).
      (result.code === "ov-non-2xx" &&
        isOvServerTimeout((result as { ok: false; code: typeof result.code; body?: string }).body)));
  return {
    status: unreachable ? "failed" : "running",
    latencyMs: unreachable ? null : Date.now() - start,
  };
}
