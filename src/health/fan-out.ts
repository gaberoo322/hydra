// Health Probe Fan-out Module (issue #2089) — extracted from src/api/health.ts.
//
// This module owns ONE concern: the probe enumeration — "which things to fan
// out against, in what order" — plus the positional-to-named assembly that maps
// the raw `Promise.allSettled([...])` array onto the named `ProbeInputs` record.
//
// Why a dedicated home (the #2089 deepening):
//   The GET /health/deep handler used to interleave two distinct concerns:
//   (1) the probe fan-out (the positional array + the integer-subscript legend +
//   `assembleProbeInputs`) and (2) the HTTP route wiring (parse the request,
//   coordinate the fan-out, project the response). The pure assessment logic
//   (#840), the diagnostic ruleset (#1867), the wire projection (#2039), and the
//   ServiceProbe Adapter Seam (#1980/#2023) were already extracted; the fan-out
//   itself stayed in the route handler. Adding a probe required THREE synchronized
//   edits across two files: push into the positional array, bump the index-legend
//   comment, and add a named `ProbeInputs` field. The integer subscripts were a
//   shared secret between this fan-out and the pure seam.
//
//   After this extraction the enumeration + the integer-to-name mapping live in
//   ONE file. `collectProbeInputs(deps?)` is the single entry point; it returns a
//   named `ProbeInputs` record directly. The route handler shrinks to:
//   `collectProbeInputs` -> `parseProbes` -> `assessHealth` -> respond — it never
//   sees the positional array or an integer subscript again. Adding a new probe
//   is a one-file edit here (push a probe + a named-record field + the legend),
//   with the compiler enforcing the `ProbeInputs` shape at `assembleProbeInputs`.
//
// Testability (the #2089 leverage): `collectProbeInputs` takes injectable deps so
// the full 19-probe pipeline is exercisable without network/subprocess/Redis —
// the surface that previously had no test because it lived inside the route
// handler. The pure positional-to-named `assembleProbeInputs` is also exported
// for direct unit testing.
//
// This module deliberately lives at src/ top-level (NOT src/api/), mirroring the
// pure Health Assessment seam (src/health/diagnostics.ts) and the ServiceProbe
// Adapter Seam (src/health/probe.ts): the fan-out is a domain concern consumed by
// route code, importable by a non-route caller without coupling to src/api/.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getMetricsTrend } from "../metrics/trend.ts";
import { getAggregateStats } from "../metrics/aggregate.ts";
import { getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import { getBacklogCounts } from "../backlog/reads.ts";
import { getMemoryPatterns } from "../redis/agent-memory.ts";
import { redisInfo as getRedisInfo } from "../redis/utility.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import { countReflectionKeys } from "../redis/reflections.ts";
import { getEmergencyBrake } from "../redis/emergency-brake.ts";
import { getOvSearchWindow, getKnowledgeContextAvailability } from "../redis/ov-search-metrics.ts";
import { getTargetServiceName } from "../target-config.ts";
import { ovPostJson } from "../knowledge-base/ov-request.ts";
import { probeService, probeOv, probeEmbedBackend, classifyOvSearchProbe, OV_SEARCH_PROBE_TIMEOUT_MS, type ServiceProbeResult } from "./probe.ts";
import { parseRedisInfoSnapshot, type ProbeInputs } from "./diagnostics.ts";
import { readDisk, readMem, readServiceStatus, isProbeFailure } from "../host-probe/probe.ts";
import {
  readWolConfig,
  attemptEmbedBackendWake,
  WakeGate,
  type WolConfig,
  type WakeOutcome,
} from "./wol.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

// ---- embed-backend Wake-on-LAN auto-recovery (issue #2228) -----------------
//
// The cooldown + max-attempt state must persist ACROSS heartbeats/health-deep
// requests (the fan-out runs once per request), so the WakeGate is a single
// module-level instance — not a per-call object. `embedWakeGate` is reset the
// moment the embed-backend probe reads `running` again, so a future outage gets
// a fresh budget of wakes. The WoL config is resolved once at module load from
// the environment (conservative defaults; auto-wake OFF unless HYDRA_WOL_ENABLED).
const embedWakeGate = new WakeGate(
  readWolConfig().cooldownMs,
  readWolConfig().maxAttempts,
);

/**
 * If the embed-backend probe reported `failed`, attempt a best-effort WoL wake
 * (respecting the module-level cooldown + max-attempt gate), then re-probe once
 * after a short delay so the existing #2131 alert only fires if the backend is
 * STILL down after the wake. Returns the (possibly re-probed) ServiceProbeResult.
 *
 * NEVER throws — every failure path inside `attemptEmbedBackendWake` /
 * `sendMagicPacket` already folds to a result object + fail-loud console.error,
 * and the re-probe reuses the never-throwing `probeEmbedBackendImpl`. A healthy
 * read resets the gate so the next outage starts fresh.
 *
 * Injectable `config`, `wake`, `reprobe`, and `sleep` keep this unit-testable
 * without a real socket, clock, or network.
 */
export async function maybeWakeEmbedBackend(
  initial: ServiceProbeResult,
  probeEmbedBackendImpl: typeof probeEmbedBackend,
  {
    config = readWolConfig(),
    gate = embedWakeGate,
    wake = attemptEmbedBackendWake,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    reprobeDelayMs = WOL_REPROBE_DELAY_MS,
  }: {
    config?: WolConfig;
    gate?: WakeGate;
    wake?: typeof attemptEmbedBackendWake;
    sleep?: (ms: number) => Promise<void>;
    reprobeDelayMs?: number;
  } = {},
): Promise<ServiceProbeResult> {
  if (initial.status !== "failed") {
    // Backend healthy → clear the attempt budget so a later outage re-arms.
    gate.reset();
    return initial;
  }
  const outcome: WakeOutcome = await wake(config, gate);
  if (!outcome.attempted) {
    // Disabled, cooled-down, or attempt budget exhausted — surface the original
    // failure so the #2131 alert fires unchanged.
    return initial;
  }
  if (!outcome.sent.ok) {
    // The wake couldn't be broadcast (different subnet / send error) — already
    // logged loud inside sendMagicPacket; leave the failure to the alert path.
    return initial;
  }
  // Give the box time to POST + the Ollama backend to self-recover (~40s in
  // #1794), then re-probe ONCE. If it came back, reset the gate and report it
  // healthy so no alert fires; if still down, the original failure stands.
  await sleep(reprobeDelayMs);
  const reprobed = await probeEmbedBackendImpl();
  if (reprobed.status !== "failed") gate.reset();
  return reprobed;
}

/**
 * Delay between sending the wake packet and re-probing the embed backend.
 * #1794 measured ~40s for a cold gaming PC to POST and the Ollama backend to
 * answer; this is intentionally generous but still bounded so it never wedges
 * the deep-health fan-out. Overridable in the test (and effectively skipped via
 * the injectable `sleep`).
 */
export const WOL_REPROBE_DELAY_MS = 45_000;

// ---- assembleProbeInputs — maps the positional settled array to named ProbeInputs --
//
// Issue #1771: the I/O layer is the only place that ever sees the raw positional
// Promise.allSettled results — that positional identity is internal to the
// fan-out and should not cross a module boundary. assembleProbeInputs() maps the
// array immediately after the fan-out so parseProbes() (in the pure seam
// src/health/diagnostics.ts) receives field names, not integer subscripts. The
// ProbeInputs type is the only thing that crosses the seam; the SettledLike shape
// and all integer index knowledge live here, in the fan-out owner (#840/#2089).
//
// Index legend (the ONLY place these numbers appear):
//   0 basicHealth, 1 serviceProbes, 2 scheduler, 3 cycle (handler-only),
//   4 queueDepth, 5 backlogCounts, 6 metrics, 7 disk, 8 mem,
//   9 sysdOrchestrator, 10 sysdWatchdog, 11 sysdTargetWeb,
//   12 patterns, 13 reflections, 14 ovSearch, 15 redisInfo, 16 emergencyBrake.
//   17/18 are ovSearchWindow/ovContextAvailability — consumed only by
//   projectHealthDeepResponse, not part of ProbeInputs.
type SettledLike = Array<{ status: "fulfilled" | "rejected"; value?: any; reason?: any }>;
export function assembleProbeInputs(settled: SettledLike): ProbeInputs {
  // Issue #1833: `val<T>(i)` coalesces a rejected settle to null and brands the
  // fulfilled value as the field's declared type T. The settled array is
  // heterogeneous + untyped (Promise.allSettled over 19 unrelated probes), so the
  // fulfilled branch is an unavoidable assertion — but naming T at each call site
  // hands the compiler the field's expected shape, so the object literal below is
  // type-checked against ProbeInputs by NAME (a renamed/dropped field is now a
  // build error here, the fan-out owner, instead of a silent runtime miss in
  // parseProbes' `|| default`).
  const val = <T>(i: number): T | null =>
    settled[i] && settled[i].status === "fulfilled" ? ((settled[i] as any).value as T) : null;
  return {
    basicHealth: val<ProbeInputs["basicHealth"]>(0),
    serviceProbes: val<ProbeInputs["serviceProbes"]>(1),
    scheduler: val<ProbeInputs["scheduler"]>(2),
    queueDepth: val<ProbeInputs["queueDepth"]>(4),
    backlogCounts: val<ProbeInputs["backlogCounts"]>(5),
    metrics: val<ProbeInputs["metrics"]>(6),
    disk: val<ProbeInputs["disk"]>(7),
    mem: val<ProbeInputs["mem"]>(8),
    sysdOrchestrator: val<ProbeInputs["sysdOrchestrator"]>(9),
    sysdWatchdog: val<ProbeInputs["sysdWatchdog"]>(10),
    sysdTargetWeb: val<ProbeInputs["sysdTargetWeb"]>(11),
    patterns: val<ProbeInputs["patterns"]>(12),
    reflections: val<ProbeInputs["reflections"]>(13),
    ovSearch: val<ProbeInputs["ovSearch"]>(14),
    redisInfo: val<ProbeInputs["redisInfo"]>(15),
    emergencyBrake: val<ProbeInputs["emergencyBrake"]>(16),
    ovSearchWindow: val<ProbeInputs["ovSearchWindow"]>(17),
    knowledgeContext: val<ProbeInputs["knowledgeContext"]>(18),
  };
}

// ---- collectProbeInputs — runs the 19-probe fan-out and assembles ProbeInputs --
//
// The single entry point. Runs every probe through one `Promise.allSettled`
// (so a slow/failing probe never blocks the others or the response) and folds the
// positional results to a named `ProbeInputs` record via `assembleProbeInputs`.
//
// Every probe is an injectable dependency (defaulted to its real implementation)
// so the full pipeline is testable without standing up Redis/OpenViking/the host
// — the test surface that did not exist while the fan-out lived in the route
// handler. The `pingRedis` dep folds the eventBus `publisher.ping()` to a boolean
// the basic-health probe carries; `killFileExists` defaults to a real fs check.
export interface CollectProbeDeps {
  /** Resolve the basic-health `redis` boolean (default: eventBus.publisher.ping). */
  pingRedis: () => Promise<boolean>;
  /** Whether the `.kill` file exists (default: real fs check on $HYDRA_ROOT/.kill). */
  killFileExists?: () => boolean;
  schedulerStatus?: typeof getSchedulerStatus;
  workQueueLen?: typeof getWorkQueueLen;
  backlogCounts?: typeof getBacklogCounts;
  metricsTrend?: typeof getMetricsTrend;
  aggregateStats?: typeof getAggregateStats;
  disk?: typeof readDisk;
  mem?: typeof readMem;
  serviceStatus?: typeof readServiceStatus;
  memoryPatterns?: typeof getMemoryPatterns;
  reflectionKeys?: typeof countReflectionKeys;
  emergencyBrake?: typeof getEmergencyBrake;
  ovSearchWindow?: typeof getOvSearchWindow;
  knowledgeContextAvailability?: typeof getKnowledgeContextAvailability;
  redisInfoImpl?: typeof getRedisInfo;
  ovPostJsonImpl?: typeof ovPostJson;
  probeServiceImpl?: typeof probeService;
  probeOvImpl?: typeof probeOv;
  probeEmbedBackendImpl?: typeof probeEmbedBackend;
  targetServiceName?: () => string;
}

export async function collectProbeInputs(deps: CollectProbeDeps): Promise<ProbeInputs> {
  const {
    pingRedis,
    killFileExists = () => existsSync(KILL_FILE),
    schedulerStatus = getSchedulerStatus,
    workQueueLen = getWorkQueueLen,
    backlogCounts = getBacklogCounts,
    metricsTrend = getMetricsTrend,
    aggregateStats = getAggregateStats,
    disk = readDisk,
    mem = readMem,
    serviceStatus = readServiceStatus,
    memoryPatterns = getMemoryPatterns,
    reflectionKeys = countReflectionKeys,
    emergencyBrake = getEmergencyBrake,
    ovSearchWindow = getOvSearchWindow,
    knowledgeContextAvailability = getKnowledgeContextAvailability,
    redisInfoImpl = getRedisInfo,
    ovPostJsonImpl = ovPostJson,
    probeServiceImpl = probeService,
    probeOvImpl = probeOv,
    probeEmbedBackendImpl = probeEmbedBackend,
    targetServiceName = getTargetServiceName,
  } = deps;

  const settled = await Promise.allSettled([
    /* 0: basic health */ (async () => {
      const killed = killFileExists();
      const redisOk = await pingRedis();
      // In-process cycle removed in PR-3 (issue #383); status is "idle" forever.
      return { status: killed ? "killed" : "ok", redis: redisOk, cycle: "idle", uptime: process.uptime() };
    })(),
    /* 1: service probes */ (async () => {
      // Issue #1324: probe/probeOv are the shared module-level helpers
      // probeService()/probeOv() (see /health/services) — same classification,
      // one place, unit-tested. vikingdb stays an inline probe (not an OpenViking
      // boundary); openviking routes through the OV Request Adapter (#954,
      // resolves OPENVIKING_URL — no hardcoded localhost:1933). openai-proxy
      // diagnostic removed in PR-3 (issue #383).
      // Issue #2013: a DISTINCT embed-backend key samples OV's dense-embedding
      // backend (ollama-embed) via the embedding-exercising search/find transport
      // through the OV Request Adapter. The svcProbes map is keyed (post-#1869),
      // so this is an ADDED key — vikingdb/openviking unchanged.
      const [vikingdb, ov, embedBackend] = await Promise.all([
        probeServiceImpl("http://localhost:5000/health"),
        probeOvImpl(),
        probeEmbedBackendImpl(),
      ]);
      // Issue #2228: if the embed-backend probe failed, attempt a best-effort
      // Wake-on-LAN of the gaming PC and re-probe before reporting — so a
      // powered-off box self-heals (the #1794 stretch goal) and the #2131 alert
      // only fires if it's STILL down after the wake. NEVER throws.
      const embedFinal = await maybeWakeEmbedBackend(embedBackend, probeEmbedBackendImpl);
      return { vikingdb, openviking: ov, "embed-backend": embedFinal };
    })(),
    /* 2 */ schedulerStatus(),
    /* 3 */ Promise.resolve({ status: "idle" }),
    /* 4 */ workQueueLen(),
    /* 5 */ backlogCounts(),
    /* 6 */ (async () => ({ trend: await metricsTrend(20), stats: await aggregateStats(20) }))(),
    // Issue #939: host-info probes go through the Host-Probe Adapter, which owns
    // the argv + timeout + df/free parse and returns a typed never-throw result.
    // The fan-out coalesces a probe failure back to the same shape the old
    // `.catch()` sentinels produced (null disk/mem, "unknown" service-status) so
    // parseProbes' downstream contract is unchanged — the difference is the
    // failure mode is now a discriminated `code` we log, not a silent swallow.
    /* 7  df    */ disk().then(r => (isProbeFailure(r) ? null : r.data)),
    /* 8  free  */ mem().then(r => (isProbeFailure(r) ? null : r.data)),
    /* 9  sysd  */ serviceStatus("hydra-orchestrator.service").then(r => (isProbeFailure(r) ? "unknown" : r.data)),
    /* 10 sysd  */ serviceStatus("hydra-watchdog.timer").then(r => (isProbeFailure(r) ? "unknown" : r.data)),
    /* 11 sysd  */ serviceStatus(targetServiceName()).then(r => (isProbeFailure(r) ? "unknown" : r.data)),
    /* 12 */ (async () => {
      const [p, e, s] = await Promise.all([memoryPatterns("planner"), memoryPatterns("executor"), memoryPatterns("skeptic")]);
      const cnt = (raw) => { try { return JSON.parse(raw).length; } catch { return 0; } };
      return { planner: cnt(p), executor: cnt(e), skeptic: cnt(s) };
    })(),
    /* 13 */ reflectionKeys(),
    /* 14 */ (async () => {
      // Issue #954: OV search probe via the adapter (resolves OPENVIKING_URL +
      // auth headers + timeout + JSON unwrap) — no hardcoded localhost:1933, no
      // inline X-Api-Key. Never throws.
      // Issue #1032: timeout raised to OV_SEARCH_PROBE_TIMEOUT_MS and the
      // result→snapshot mapping lives in the pure, unit-tested
      // classifyOvSearchProbe so timeout vs real-failure is testable.
      const start = Date.now();
      const result = await ovPostJsonImpl<any>("/api/v1/search/find", { query: "system health", limit: 3 }, { timeout: OV_SEARCH_PROBE_TIMEOUT_MS });
      return classifyOvSearchProbe(result, Date.now() - start);
    })(),
    /* 15: I/O only — the raw INFO regex parse lives in the pure
       parseRedisInfoSnapshot in diagnostics.ts (issue #1856). */
    (async () => {
      try {
        const [info, clients, server] = await Promise.all([redisInfoImpl("memory"), redisInfoImpl("clients"), redisInfoImpl("server")]);
        return parseRedisInfoSnapshot(info, clients, server);
      } catch { return null; }
    })(),
    /* 16: emergency brake (issue #744) */ emergencyBrake(),
    // Issue #1440: persisted OV search-quality trend (24h hour-buckets) and
    // per-day knowledge-context availability (7d). Both degrade to null on a
    // Redis error so the probe never blocks /health/deep — the projection
    // coalesces a rejected settle to null.
    /* 17 */ ovSearchWindow(24),
    /* 18 */ knowledgeContextAvailability(7),
  ]);

  return assembleProbeInputs(settled);
}
