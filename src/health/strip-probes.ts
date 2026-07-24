// Now-page strip probe enumeration (issue #2597) — extracted from
// src/health/fan-out.ts into a focused leaf (issue #3482).
//
// Why a dedicated home (the #3482 deepening):
//   The fan-out (src/health/fan-out.ts) owns the 19-probe deep-health registry
//   for GET /health/deep — a heavy I/O closure pulling WoL gates, Redis readers,
//   countReflectionKeys, getLedgerLen, getSkillCatalogState, etc. The Now-page
//   health strip (src/aggregators/service-strip.ts) is a SECOND consumer that
//   wants only the user-facing subset of EXTERNAL-SERVICE LIVENESS probes
//   (orchestrator, redis, vikingdb, openviking, embed-backend)
//   projected as display rows. The strip's enumeration originally lived in the
//   fan-out body ("the fan-out owns which external services the orchestrator
//   monitors"), which meant service-strip.ts pulled the fan-out's entire heavy
//   import closure — Redis adapters, WoL gates, reflection/ledger readers — into
//   its load path even though the strip needs none of it.
//
//   Issue #3482 concentrates the strip-probe concern in this named leaf. The
//   "single owner of which services appear on the strip, in what order" invariant
//   (the #2597 acceptance criterion) is preserved — the enumeration still has ONE
//   home; it just lives in a leaf the fan-out (and the strip) import downward,
//   rather than being co-located in the deep-health fan-out body. A developer
//   editing the WoL wake-on-LAN behaviour no longer reads the strip section; a
//   developer adding a service to the strip no longer navigates the fan-out.
//
// Scope boundary (design concept #2597 rejected-alternative): this is the
// LIVENESS subset the strip wants, NOT the full HealthSnapshot fan-out. The
// strip deliberately does not pull collectProbeInputs (that couples it to
// Redis/host reads it does not want and blows its 3s-per-probe budget). The
// /health/deep wire envelope keeps its own explicit named projection (#1869) —
// this enumeration does not change it.
//
// This leaf is a PURE downward edge: it imports only the ServiceProbe Adapter
// Seam types/producers (src/health/probe.ts) it needs to describe the probes —
// no Redis, no WoL, no fan-out. The fan-out imports nothing from here; the strip
// imports the enumeration from here (directly or via the ../health barrel).

import {
  probeEmbedBackend,
  type ServiceProbeResult,
  type ProbeOutcome,
} from "./probe.ts";

/**
 * The generic HTTP probe the strip injects: receives a URL + timeout, returns a
 * never-throwing {@link ProbeOutcome} (`{ok, latencyMs, error?}`). Defaulted by
 * the strip to a real `fetch`-based probe; injectable for tests. The 3s cap the
 * strip contract guarantees is applied by the caller passing `timeoutMs`.
 */
type StripHttpProbe = (url: string, timeoutMs: number) => Promise<ProbeOutcome>;

/**
 * The minimal dependency bag a strip probe descriptor's `run` closure consumes.
 * Deliberately a SUPERSET-free subset of the strip's own `ServiceStripDeps` so
 * the descriptor enumeration lives in this leaf (the probe owner) without
 * importing the strip (which would be circular — the strip imports this module).
 * The strip passes its resolved deps through verbatim.
 *
 * Every field is required at call time (the strip fills defaults before calling
 * `run`), so a descriptor never has to defend against an absent dep.
 */
export interface StripProbeDeps {
  /** Generic HTTP liveness probe (vikingdb/openviking). */
  probe: StripHttpProbe;
  /** Redis ping — true on success, never throws (the redis/utility accessor swallows). */
  pingRedis: () => Promise<boolean>;
  /** Orchestrator self-check — true when the host process is healthy (no kill-switch). */
  checkOrchestrator: () => Promise<boolean>;
  /** OpenViking base URL (resolves OPENVIKING_URL via the OV Request Adapter, #954). */
  ovBaseUrl: () => string;
  /** Embed-backend liveness (issue #2013) — the OV dense-embedding backend probe. */
  probeEmbedBackend: typeof probeEmbedBackend;
}

/**
 * One entry in the ordered strip-probe enumeration.
 *
 *  - `service`  — the display name the strip renders (and the row order).
 *  - `kind`     — how the shared classifier interprets the `run` result:
 *                   `boolean` → classifyServiceBoolean (up/down; `degradedMessage`
 *                               stamps a specific down reason, e.g. kill-switch).
 *                   `probe`   → classifyServiceProbe (ok/degraded/down by latency).
 *  - `run`      — a never-throwing closure that resolves the probe result from the
 *                 injected deps. A `boolean`-kind descriptor returns a boolean; a
 *                 `probe`-kind descriptor returns a {@link ProbeOutcome}.
 *  - `degradedMessage` — (boolean kind only) the down reason stamped when the
 *                 boolean check returns false.
 */
export type StripProbeDescriptor =
  | {
      service: string;
      kind: "boolean";
      run: (deps: StripProbeDeps) => Promise<boolean>;
      degradedMessage?: string;
    }
  | {
      service: string;
      kind: "probe";
      run: (deps: StripProbeDeps) => Promise<ProbeOutcome>;
    };

/**
 * Adapt a fan-out {@link ServiceProbeResult} (`{status:"running"|"failed",
 * latencyMs:number|null}`) into the strip's {@link ProbeOutcome} (`{ok,
 * latencyMs, error?}`) shape the display classifier consumes. `failed` →
 * `ok:false` (latency null → 0 so the numeric field is uniform); `running` → ok
 * with its measured latency. Pure; the source producers never throw.
 */
function serviceProbeToOutcome(r: ServiceProbeResult, downError: string): ProbeOutcome {
  if (r.status === "running") {
    return { ok: true, latencyMs: r.latencyMs ?? 0 };
  }
  return { ok: false, latencyMs: r.latencyMs ?? 0, error: downError };
}

/**
 * The ordered, shared enumeration of external-service liveness probes the
 * Now-page strip renders (issue #2597). ONE source of "which probes appear on
 * the strip and in what order". The strip maps this list to `ServiceRow[]` via
 * the shared classifiers — adding a probe is a one-entry edit here, with NO edit
 * to the strip's row-assembly logic (the #2597 deepening acceptance criterion).
 *
 * The first four entries preserve the strip's historical order + behaviour
 * (orchestrator, redis, vikingdb, openviking); the last is the previously-omitted
 * embed-backend (#2013) probe. (Issue #3544: the ollamaVlm strip probe (#2278) was
 * retired at the VLM cutover — OpenViking no longer uses the gaming-PC VLM host.)
 */
export const STRIP_PROBE_DESCRIPTORS: readonly StripProbeDescriptor[] = [
  {
    service: "orchestrator",
    kind: "boolean",
    run: (deps) => deps.checkOrchestrator(),
    degradedMessage: "kill-switch active",
  },
  {
    service: "redis",
    kind: "boolean",
    run: (deps) => deps.pingRedis(),
  },
  {
    service: "vikingdb",
    kind: "probe",
    run: (deps) => deps.probe("http://localhost:5000/health", 3000),
  },
  {
    service: "openviking",
    kind: "probe",
    run: (deps) => deps.probe(`${deps.ovBaseUrl()}/health`, 3000),
  },
  {
    // Issue #2013: the OV dense-embedding backend, previously omitted from the
    // strip. probeEmbedBackend is never-throwing and self-times (via the OV
    // Request Adapter); a transport failure folds to `failed` → a down row.
    service: "embed-backend",
    kind: "probe",
    run: async (deps) =>
      serviceProbeToOutcome(await deps.probeEmbedBackend(), "embed backend unreachable"),
  },
];
