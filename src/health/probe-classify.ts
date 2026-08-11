// ProbeClassify — zero-IO display-status classification leaf (issue #3115).
//
// Originally split out as the PURE half of the ServiceProbe Adapter Seam
// (formerly src/health/probe.ts, #1980/#2281/#2023) so a consumer needing only
// the classifiers could import this module without pulling the OV/fetch
// adapter machinery into module-load. The OpenViking retirement (#3949) deleted
// probe.ts outright — its IO probe PRODUCERS (probeService/probeOv/
// probeEmbedBackend/probeSkillsEndpoint) and the ServiceProbeResult contract had
// no surviving consumer. This leaf SURVIVES: the dashboard service strip
// (src/aggregators/service-strip.ts) and src/health/strip-probes.ts still
// import the display vocabulary (ProbeOutcome, ProbeStatus) and classifiers
// directly from here.
//
// It holds ONLY the display-status classifiers and the constants/types they
// reason about: the three-way ok|degraded|down service DISPLAY vocabulary
// (#2281). (The OV-search deep-health probe classification, #2023, was removed
// with #3949 — its only consumer, probe.ts, is gone.)

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
