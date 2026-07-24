// ProbeClassify — zero-IO display-status classification leaf (issue #3115).
//
// This is the PURE half of the ServiceProbe Adapter Seam (src/health/probe.ts,
// #1980/#2281/#2023) split out into a leaf with NO IO in its import closure —
// no value import of the OpenViking Request Adapter (ov-request.ts), no
// globalThis.fetch, no AbortSignal.timeout, no process.env, no Date.now(). A
// consumer or test that needs only the classifiers can import THIS module and
// pull none of the OV/fetch adapter machinery into module-load (the leaf
// motivation shared by event-bus-vocabulary #1985, cost/eligibility #1377,
// design-concept-gate #3039).
//
// It holds ONLY the display-status classifiers and the constants/types they
// reason about: the three-way ok|degraded|down service DISPLAY vocabulary
// (#2281) and the OV-search deep-health probe classification (#2023). The IO
// probe PRODUCERS (probeService/probeOv/probeEmbedBackend/probeSkillsEndpoint)
// and their producer output contract (ServiceProbeResult,
// running|failed) stay in probe.ts, which re-exports every symbol below so all
// existing importers keep their EXACT current import from ./probe.ts (zero-diff
// relay — the split does not push work onto callers).

// ---- Service display-status classification (issue #2281) ------------------
//
// The Now-page health strip (src/aggregators/service-strip.ts) and the
// /health/deep view classify the SAME domain concept — "the liveness status of
// an external dependency the orchestrator probes" — into a DISPLAY status. That
// display vocabulary is a THREE-WAY union ("ok"|"degraded"|"down") with a
// latency-based "degraded" threshold, deliberately DISTINCT from the binary
// "running"|"failed" ServiceProbeResult producer vocabulary (which the fan-out /
// rules.ts / wire.ts read and which this classification leaf leaves untouched).
//
// Before #2281 service-strip re-implemented this classification inline as its
// own classifyProbe/classifyBoolean, so the status vocabulary + the latency
// threshold lived in two places and could silently diverge as probes were
// added/renamed (#1869/#1980/#2023). #2281 converged the VOCABULARY + classify
// LOGIC in the ServiceProbe Adapter Seam; #3115 relocates that PURE half here.
// It does NOT collapse the ServiceRow display record into ServiceProbe: those
// stay separate types with different consumers (#2281 rejected-alternative).
// The classifiers are PURE and NEVER throw (a rejected settle folds to "down"),
// matching the seam's fail-loud I/O-boundary fold convention.

/**
 * The three-way DISPLAY status a probed external service can report.
 *  - `ok`       — probe answered, latency under the degraded threshold.
 *  - `degraded` — probe answered but latency >= {@link DEGRADED_LATENCY_THRESHOLD_MS}
 *                 (slow but alive), OR a bool-check's caller-supplied degraded knob.
 *  - `down`     — probe failed, returned non-2xx, or its settle rejected.
 *
 * Distinct from the binary `ServiceProbeResult` ("running"|"failed") producer
 * vocabulary: that is transport classification; this is the operator-facing
 * three-way the Now-page strip glances at for "is anything red/yellow?".
 */
export type ProbeStatus = "ok" | "degraded" | "down";

/**
 * The latency ceiling (ms) above which a successful probe is `degraded` rather
 * than `ok`. A probe that answers but takes >= this is "slow but alive" — a
 * yellow on the strip, not a green. Preserved 1:1 from the former inline
 * service-strip threshold (#2281).
 */
export const DEGRADED_LATENCY_THRESHOLD_MS = 1000;

/**
 * The generic settled-probe outcome the display classifier maps to a
 * {@link ProbeStatus}. This is the `{ok, latencyMs, error?}` shape an HTTP probe
 * already folds to (service-strip's `ProbeResult`), NOT the binary
 * `ServiceProbeResult` the producers emit — the display classifier is one level
 * up, mapping a settled probe outcome onto the three-way display vocabulary.
 */
export interface ProbeOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** A probe-status classification carrying the display status + the fields a row renders. */
interface ProbeStatusClassification {
  status: ProbeStatus;
  lastError?: string;
  latencyMs?: number;
}

/**
 * Classify a settled probe outcome into the three-way DISPLAY status. Pure;
 * NEVER throws — a rejected settle folds to `down` with the rejection reason in
 * `lastError`, so the caller's row always renders.
 *
 *   - rejected settle      → `down` (rejection reason captured)
 *   - `ok: false`          → `down` (probe error captured, latency kept)
 *   - latency >= threshold → `degraded` (slow but alive, latency kept)
 *   - otherwise            → `ok` (latency kept)
 */
export function classifyServiceProbe(
  result: PromiseSettledResult<ProbeOutcome>,
): ProbeStatusClassification {
  if (result.status === "rejected") {
    return { status: "down", lastError: result.reason?.message || String(result.reason) };
  }
  const probe = result.value;
  if (!probe.ok) {
    return { status: "down", lastError: probe.error || "probe failed", latencyMs: probe.latencyMs };
  }
  if (probe.latencyMs >= DEGRADED_LATENCY_THRESHOLD_MS) {
    return {
      status: "degraded",
      lastError: `slow probe (${probe.latencyMs}ms)`,
      latencyMs: probe.latencyMs,
    };
  }
  return { status: "ok", latencyMs: probe.latencyMs };
}

/**
 * Classify a settled bool-returning health check into the DISPLAY status. Pure;
 * NEVER throws. There is no meaningful "degraded" middle for a boolean check —
 * it is up or it is not — but `degradedMessage` lets the caller stamp a more
 * specific `down` reason (e.g. the orchestrator kill-switch). `false`/rejected
 * → `down`.
 *
 *   - rejected settle → `down` (rejection reason captured)
 *   - `value === true`→ `ok`
 *   - `value !== true`→ `down` (`degradedMessage` if supplied, else a default)
 */
export function classifyServiceBoolean(
  result: PromiseSettledResult<boolean>,
  opts: { service: string; degradedMessage?: string },
): ProbeStatusClassification {
  if (result.status === "rejected") {
    return { status: "down", lastError: result.reason?.message || String(result.reason) };
  }
  if (result.value === true) {
    return { status: "ok" };
  }
  return {
    status: "down",
    lastError: opts.degradedMessage ?? `${opts.service} is not responding`,
  };
}

// ---- OV-search deep-health probe — timeout + failure classification ------
//
// Issue #2023: the OV-search probe's classification policy (the status union,
// the timeout ceiling, and the pure classifier) was lifted into the ServiceProbe
// Adapter Seam from the pure Health Assessment seam (src/health/diagnostics.ts).
// It is execution-side probe policy — it maps the OpenViking Request Adapter's
// discriminated result codes onto a probe-status. #3115 relocates this PURE
// classification (which reads no IO — the caller measures latency and hands it
// the already-discriminated OvResult) here into the zero-IO leaf next to the
// display classifiers it is a sibling of.
//
// Issue #1032: the index-14 `/api/v1/search/find` probe in `src/api/health.ts`
// was false-negativing `status:"failed"` (`latencyMs:null`) while OpenViking
// was fully healthy. Root cause: after #980 repointed OV's dense embedding to
// the gaming-PC Ollama (`nomic-embed-text`, 768-dim) over Tailscale, the
// query-embedding step incurs Tailnet RTT + local model inference and routinely
// exceeds the probe's old 3000ms `AbortSignal` ceiling. A timeout is classified
// by the OV Request Adapter as `ov-timeout` (distinct from the `ov-non-2xx` a
// real 5xx produces), so a slow-but-working plane was being reported as a hard
// failure — the inverse of the now-closed #985.
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
