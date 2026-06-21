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
// src/health/diagnostics.ts pure Health Assessment seam: the probes are a domain
// seam consumed by route code, and a non-route caller (e.g.
// src/aggregators/service-strip.ts) composing the canonical probes should not
// import from src/api/.
import {
  ovHealthGet,
  ovPostJson,
  ovRequest,
  isOvFailure,
  type OvResult,
} from "../knowledge-base/ov-request.ts";
// Issue #2269: reuse the #2250 server-side-timeout body classifier so the skills
// liveness probe treats OV's "Request timed out." 500 as down, NOT responsive.
import { isOvServerTimeout } from "../knowledge-base/skill-registration.ts";

/** The wire shape every service probe folds to: `{status, latencyMs}`. */
export type ServiceProbeResult = {
  status: "running" | "failed";
  latencyMs: number | null;
};

// ---- OV-search deep-health probe — timeout + failure classification ------
//
// Issue #2023: the OV-search probe's classification policy (the status union,
// the timeout ceiling, and the pure classifier) was lifted here from the pure
// Health Assessment seam (src/health/diagnostics.ts). It is execution-side
// probe policy — it maps the OpenViking Request Adapter's discriminated result
// codes onto a probe-status — so it belongs in this ServiceProbe Adapter Seam
// next to probeService/probeOv/probeEmbedBackend, not in the IO-free assess
// seam. The relocation eliminates the inverted value-import edge (the seam used
// to import OV_SEARCH_PROBE_TIMEOUT_MS *from* the pure module). The only
// remaining cross-edge is health-diagnostics importing OvSearchProbeStatus as a
// type-only import (erased at compile time) so HealthSnapshot.ovSearch.status
// can name this probe's result vocabulary.
//
// Issue #1032: the index-14 `/api/v1/search/find` probe in `src/api/health.ts`
// was false-negativing `status:"failed"` (`latencyMs:null`) while OpenViking
// was fully healthy. Root cause: after #980 repointed OV's dense embedding to
// the gaming-PC Ollama (`nomic-embed-text`, 768-dim) over Tailscale, the
// query-embedding step incurs Tailnet RTT + local model inference and
// routinely exceeds the probe's old 3000ms `AbortSignal` ceiling. A timeout is
// classified by the OV Request Adapter as `ov-timeout` (distinct from the
// `ov-non-2xx` a real 5xx produces), so a slow-but-working plane was being
// reported as a hard failure — the inverse of the now-closed #985.
//
// Two changes close it:
//   1) raise the probe ceiling to OV_SEARCH_PROBE_TIMEOUT_MS so a healthy
//      Ollama-backed search completes inside the window and reports `running`
//      with its true latency, and
//   2) when the probe DOES still exhaust the (now generous) window, classify
//      it as a distinct `"timeout"` status — NOT `"failed"` — so a slow plane
//      is surfaced honestly instead of masquerading as a 5xx. Only a real
//      `ov-non-2xx` (OV reachable but search 500ing) or transport failure
//      (`ov-service-down`) folds to `"failed"`.

/**
 * The wire/snapshot status the OV-search deep-health probe can report.
 *  - `running` — `search/find` returned 200 (the true plane state).
 *  - `failed`  — OV reachable but search 5xx'd (`ov-non-2xx`), or a 2xx body
 *                failed to parse (`ov-malformed-json`). OV itself is up; its
 *                search path is broken. A genuine fault.
 *  - `timeout` — the probe exhausted its window (`ov-timeout`); the plane is
 *                likely working-but-slow (real agent searches have no 3s cap),
 *                so this is reported distinctly and treated as informational.
 *  - `backend-unreachable` — the search transport never completed a round-trip
 *                (`ov-service-down`: DNS/ECONNREFUSED/network). Issue #1781: the
 *                graceful-degradation signal distinct from `failed`. The
 *                `search/find` path is the one that exercises the embedding
 *                backend, so a transport failure on it — while the OV liveness
 *                probe may report differently — points the operator at the
 *                embedding/inference backend (the post-#1795 local
 *                `ollama-embed` service, or the Tailnet VLM host for indexing),
 *                NOT at an OV-internal 5xx. Collapsing it into `failed` was the
 *                indistinguishability #1781 exists to fix.
 */
export type OvSearchProbeStatus =
  | "running"
  | "failed"
  | "timeout"
  | "backend-unreachable";

/**
 * OV-search deep-health probe `AbortSignal` ceiling (ms).
 *
 * Sized for the post-#980 Ollama-backed dense-embedding path
 * (`nomic-embed-text`, 768-dim, reached over Tailscale): query-embedding +
 * Tailnet RTT routinely pushes a warm `search/find` past the old 3000ms cap.
 * 15s matches the most generous existing OV timeout in the codebase
 * (`ov-search.ts`'s session-message POST) and gives the cold-embedding case
 * ample headroom while still bounding the deep-health fan-out. The real agent
 * search path uses 5000ms and has no probe; this ceiling exists only so a slow
 * plane reports `running`/`timeout` rather than a false `failed`.
 */
export const OV_SEARCH_PROBE_TIMEOUT_MS = 15_000;

/**
 * The shape of an OV `search/find` result body the probe counts hits from.
 * Optional everywhere — the probe coalesces missing arrays to 0.
 */
interface OvSearchResultBody {
  result?: {
    memories?: unknown[];
    resources?: unknown[];
    skills?: unknown[];
  };
}

/**
 * Pure classifier for the index-14 OV-search probe. Maps the OV Request Adapter
 * result (already discriminated by `code`) onto the `ovSearch` snapshot shape.
 *
 * Kept pure + exported so the timeout-vs-real-failure logic (#1032) is unit
 * testable without standing up `fetch`/OpenViking: a slow probe that times out
 * must report `"timeout"` (carrying its measured latency, not `null`) and a
 * genuine 5xx/transport fault must still report `"failed"`.
 *
 * @param result discriminated OV result for `POST /api/v1/search/find`.
 * @param latencyMs wall-clock ms the probe took (measured by the caller).
 */
export function classifyOvSearchProbe(
  result:
    | { ok: true; data: OvSearchResultBody | null | undefined }
    | { ok: false; code: string },
  latencyMs: number,
): { status: OvSearchProbeStatus; latencyMs: number | null; resultCount: number } {
  if (result.ok === false) {
    // `ov-timeout` is a slow-but-likely-working plane, not a fault: surface it
    // distinctly and KEEP the measured latency so the deep-health view shows how
    // long the (uncapped, in real use) embedding path is actually taking.
    if (result.code === "ov-timeout") {
      return { status: "timeout", latencyMs, resultCount: 0 };
    }
    // Issue #1781: `ov-service-down` is a transport failure — the request never
    // reached OV's search handler (DNS/ECONNREFUSED/network). Because the
    // `search/find` path is the one that exercises the embedding backend, this
    // is the distinct, operator-actionable "embedding backend unreachable"
    // signal — NOT a generic OV-internal 5xx. Keep it separate from `failed` so
    // the diagnostic can point the operator at the backend host rather than at
    // OpenViking itself. No round-trip completed, so latency is meaningless → null.
    if (result.code === "ov-service-down") {
      return { status: "backend-unreachable", latencyMs: null, resultCount: 0 };
    }
    // `ov-non-2xx` reached OV but search 5xx'd — a real OV-internal fault; keep
    // its latency. `ov-malformed-json` round-tripped a 2xx but the body was
    // garbage, so `latencyMs` would be meaningless → null.
    return {
      status: "failed",
      latencyMs: result.code === "ov-non-2xx" ? latencyMs : null,
      resultCount: 0,
    };
  }
  const rs = result.data?.result || {};
  return {
    status: "running",
    latencyMs,
    resultCount:
      (rs.memories?.length || 0) + (rs.resources?.length || 0) + (rs.skills?.length || 0),
  };
}

/** The probe timeout for the plain-HTTP service probe (preserved 1:1 across both former call sites). */
const SERVICE_PROBE_TIMEOUT_MS = 3000;

// ---- Ollama VLM liveness probe (issue #2278) ------------------------------
//
// Why a DISTINCT probe (not probeEmbedBackend, not probeOv):
//  - probeEmbedBackend() exercises the OpenViking dense-embedding backend
//    (ollama-embed:11434) via the OV search/find transport — that backend lives
//    INSIDE the OV container and is reached over `extra_hosts`, NOT the Tailnet
//    gaming-PC host. A healthy embed backend says nothing about whether the
//    Tailnet VLM host (gabes-desktop-1:11434) — the one OpenViking uses for the
//    vision/indexing model (gemma) — is reachable. That VLM host being offline is
//    the recurring silent-failure pattern (#2277/#2269/#2250/#2148/#2103/#2064/
//    #1968): the skill catalog quietly empties for hours with no /api/health
//    signal because nothing probes the Tailnet host DIRECTLY.
//  - probeOv() only hits OV's app-liveness GET /health (OV-the-app is up). It is
//    blind to the Tailnet VLM host the same way #2013 motivated the embed-backend
//    split.
//
// This is the orchestrator's DIRECT reachability probe of the Tailnet VLM host,
// reachable from the orchestrator itself (unlike ollama-embed, which is only
// OV-internal). It is a VISIBILITY probe, not a hard gate: a `down` result makes
// /health/deep report `degraded: true` but never 5xx (per #2278 acceptance).

/**
 * The Ollama VLM host base URL — the Tailnet gaming-PC endpoint
 * (`gabes-desktop-1:11434`) OpenViking uses for its vision/indexing model
 * (#980/#1795). Env-overridable (`HYDRA_OLLAMA_VLM_URL`) so a relocated host or a
 * test does not require a code edit; defaults to the documented Tailnet host.
 */
const OLLAMA_VLM_URL = process.env.HYDRA_OLLAMA_VLM_URL || "http://gabes-desktop-1:11434";

/**
 * The Ollama VLM liveness probe `AbortSignal` ceiling (ms) — issue #2278.
 * 5s per the acceptance criteria: long enough to absorb Tailnet RTT + a cold
 * host's first answer, short enough to bound the /health/deep fan-out.
 */
const OLLAMA_VLM_PROBE_TIMEOUT_MS = 5000;

/**
 * The wire shape the Ollama VLM liveness probe folds to (issue #2278).
 * Deliberately `ok`/`down` (NOT the running/failed ServiceProbeResult vocabulary)
 * and carries an optional `error` string — the acceptance criteria name this
 * exact shape so the operator sees WHY the VLM host is unreachable, not just that
 * it is. `latencyMs` is always a number (0 on a transport failure that never
 * round-tripped) so the wire field is uniformly numeric.
 */
export type OllamaVlmProbeResult = {
  status: "ok" | "down";
  latencyMs: number;
  error?: string;
};

/**
 * Probe the Tailnet Ollama VLM host (`gabes-desktop-1:11434`) for liveness —
 * issue #2278. Fires a GET to `${OLLAMA_VLM_URL}/api/health` with a 5s
 * AbortSignal timeout and folds the outcome to `{status, latencyMs, error?}`.
 *
 * Reachability semantics: this is a LIVENESS probe — any HTTP response (even a
 * non-2xx, e.g. Ollama's 404 on an unmapped path) proves the host's HTTP server
 * answered, so it is `ok`. Only a transport failure (DNS/ECONNREFUSED — the box
 * is off/unreachable) or a timeout (the box did not answer inside the window)
 * folds to `down`, carrying the error message so the operator can tell an offline
 * box from a slow one.
 *
 * NEVER throws — a transport failure or timeout is caught and folded to
 * `{status:"down", latencyMs, error}`, mirroring the fail-loud I/O-boundary fold
 * the other probes use. `fetchImpl` is injectable (default `globalThis.fetch`) so
 * the test can stub reachable / non-2xx / throw / timeout without a real network.
 */
export async function probeOllamaVlm(
  {
    url = OLLAMA_VLM_URL,
    fetchImpl = globalThis.fetch,
  }: { url?: string; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<OllamaVlmProbeResult> {
  const start = Date.now();
  try {
    // Any answer (ok or non-2xx) proves the HTTP server is reachable → ok. We do
    // NOT gate on r.ok: the path is a liveness target, not a contract endpoint.
    await fetchImpl(`${url}/api/health`, {
      signal: AbortSignal.timeout(OLLAMA_VLM_PROBE_TIMEOUT_MS),
    });
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    // Fail-loud I/O-boundary fold: a transport failure (host off / DNS /
    // ECONNREFUSED) or an AbortSignal timeout means the VLM host did not answer.
    // Surface the reason so the operator can distinguish "box is off" from
    // "Tailnet/slow". A TimeoutError carries the documented abort message.
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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
    { timeout: SKILLS_PROBE_TIMEOUT_MS },
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
