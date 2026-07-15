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
import { countReflectionKeys, probeReflectionOutcomesLedger } from "../redis/reflections.ts";
// Issue #3270: the attribution ledger LLEN probe — a best-effort LLEN read that
// surfaces ledger-dark state to the deep-health rule without fetching all rows.
import { getLedgerLen } from "../redis/attribution-ledger.ts";
import { getEmergencyBrake } from "../redis/emergency-brake.ts";
import { getOvSearchWindow, getKnowledgeContextAvailability } from "../redis/ov-search-metrics.ts";
import { getTargetServiceName } from "../target-config.ts";
import { ovPostJson } from "../knowledge-base/ov-request.ts";
// Issue #2386: the live in-process skill-catalog read. The fan-out is the I/O
// owner that resolves every probe input, so this synchronous in-memory read now
// happens HERE (next to the other probe reads) and is carried onto the snapshot
// via ProbeInputs.skillCatalog — rules.ts no longer reads it out-of-band.
import { getSkillCatalogState } from "../knowledge-base/skill-registration.ts";
// Issue #2805: the live dark leading-outcome check. Like the skill-catalog read
// above, this is a direct never-throwing read (not a Promise.allSettled probe),
// so it runs in the fan-out I/O owner and is carried onto the snapshot via
// ProbeInputs.darkOutcomes — the deep-health dark-outcome rule then reads it from
// the snapshot, staying pure. `evaluateDarkOutcomes` is contractually never-throw.
import { evaluateDarkOutcomes } from "../scheduler/chores/wiring-liveness-outcomes.ts";
// Issue #3251: project the retired reflection-outcomes ledger's residual state
// (read via probeReflectionOutcomesLedger) into a liveness report at fan-out
// time. Like the darkOutcomes read above, this is a direct never-throwing read;
// the projection needs a clock so it runs HERE (the I/O owner) and is carried
// onto the snapshot via ProbeInputs.reflectionOutcomesLiveness — the deep-health
// reflection-outcomes rule then reads it from the snapshot, staying pure.
import { projectReflectionOutcomesLiveness } from "./reflection-outcomes-liveness.ts";
import { probeService, probeOv, probeEmbedBackend, probeOllamaVlm, classifyOvSearchProbe, OV_SEARCH_PROBE_TIMEOUT_MS, type ServiceProbeResult, type ProbeOutcome } from "./probe.ts";
import { parseRedisInfoSnapshot } from "./diagnostics.ts";
// Issue #3230: the ProbeInputs named-record type comes from the zero-logic leaf.
import type { ProbeInputs } from "./types.ts";
import { readDisk, readMem, readServiceStatus, isProbeFailure } from "../host-probe/probe.ts";
import {
  getWolGates,
  WakeGate,
  maybeWakeEmbedBackend,
  maybeWakeVlmHost,
} from "./wol.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

// ---- Wake-on-LAN auto-recovery (issues #2228 + #2335 + #2570 + #2834) -------
//
// The probe-failure wake TRIGGERS (`maybeWakeEmbedBackend` / `maybeWakeVlmHost`)
// are recovery POLICY, not probe enumeration, so issue #2834 relocated them into
// the WoL module that already owns the mechanism (packet build, `WakeGate` timing,
// `sendMagicPacket`, `attempt*Wake`). The fan-out now IMPORTS them from
// src/health/wol.ts and calls them from its probe steps — it no longer owns a
// slice of the WoL policy itself.
//
// The cooldown + max-attempt state for both triggers must persist ACROSS
// heartbeats/health-deep requests (the fan-out runs once per request), so each is
// a single process-lifetime WakeGate — not a per-call object. Those two singletons
// (embed-backend gate #2228 + VLM-host gate #2335) once lived HERE as module-level
// `new WakeGate(...)` instances, which left this fan-out holding mutable
// module-global state and bled the gates' retry budget across test cases.
//
// Issue #2570 relocated that singleton lifecycle into the WoL Adapter that owns
// WakeGate (src/health/wol.ts `getWolGates()` / `resetWolGates()`). The adapter
// lazily constructs the SAME embed + vlm pair from the WoL config and hands it
// back on every call — preserving cross-request persistence — while the two gates
// stay distinct so the embed and VLM wake budgets remain independent. The embed
// gate is reset the moment the embed-backend probe reads `running` again; the VLM
// gate the moment the VLM-host probe reads `ok` again, so a future outage gets a
// fresh budget of wakes. `collectProbeInputs` reads NO module-global mutable state
// — the gates flow in through the injectable deps bag, defaulting to the adapter's
// singletons (so a no-gate production caller is unchanged).

// ---- The named async-probe registry — keyed, position-free (issue #3263) ----
//
// Issue #1771/#2089 moved the positional-to-named assembly here, but the
// probe-to-index mapping was still an INTEGER-SUBSCRIPT contract shared across
// three sites that had to stay in lock-step: the positional `Promise.allSettled`
// array literal, an inline integer-legend comment, and `assembleProbeInputs`'
// `settled[0]…[19]` reads. Adding a probe meant four synchronised edits; removing
// a retired probe meant renumbering every higher slot; a dead slot (the retired
// index-3 cycle probe) had to be held alive as an idle tombstone purely to avoid
// renumbering.
//
// Issue #3263 replaces the positional array with a NAMED registry: each async
// probe is a `{ key, run }` descriptor whose `key` is the `ProbeInputs` field it
// feeds. `collectProbeInputs` builds the descriptor list from the resolved deps,
// runs every `run()` through ONE `Promise.allSettled`, and folds the results into
// a key→settled record. `assembleProbeInputs` reads that record BY KEY. The
// integer subscript is gone from every site: adding a probe is one descriptor
// entry (+ its `ProbeInputs` field); removing a probe is deleting one entry (no
// renumbering, no tombstone). The retired index-3 cycle probe is simply absent.
//
// `ASYNC_PROBE_KEYS` names the async settle-array subset of `ProbeInputs`. The
// non-async in-memory reads (skillCatalog #2386, darkOutcomes #2805,
// reflectionOutcomesLiveness #3251) are NOT registry entries — they are direct
// never-throw reads merged onto the record after the fan-out, exactly as before.

/**
 * The `ProbeInputs` fields fed by an async settle-array probe (issue #3263). The
 * three non-async in-memory reads (skillCatalog / darkOutcomes /
 * reflectionOutcomesLiveness) are deliberately excluded — they are merged by
 * `collectProbeInputs` after the fan-out, not run as `Promise.allSettled` probes.
 */
type AsyncProbeKey = Exclude<
  keyof ProbeInputs,
  "skillCatalog" | "darkOutcomes" | "reflectionOutcomesLiveness"
>;

/**
 * One entry in the named async-probe registry (issue #3263). `key` is the
 * `ProbeInputs` field this probe feeds; `run` is the never-blocking closure the
 * fan-out awaits through `Promise.allSettled` (a rejected settle coalesces the
 * field to `null`). The registry replaces the former integer-subscript array — the
 * probe-to-field contract now lives in ONE place, keyed by name.
 *
 * Module-private (issue #3314): only `collectProbeInputs` below builds the
 * descriptor list — no external consumer references this shape, so it carries no
 * `export`.
 */
interface AsyncProbeDescriptor {
  key: AsyncProbeKey;
  run: () => Promise<unknown>;
}

/** A key→settled-result record — the keyed successor to the positional array. */
type SettledByKey = Partial<
  Record<AsyncProbeKey, { status: "fulfilled" | "rejected"; value?: any; reason?: any }>
>;

// ---- assembleProbeInputs — maps the keyed settled record to named ProbeInputs --
//
// Issue #1771: the I/O layer is the only place that ever sees the raw
// Promise.allSettled results — that identity is internal to the fan-out and must
// not cross a module boundary. `assembleProbeInputs` maps the settled results
// immediately after the fan-out so parseProbes() (in the pure seam
// src/health/diagnostics.ts) receives field names. The ProbeInputs type is the
// only thing that crosses the seam.
//
// Issue #3263: the input is now a key→settled RECORD, not a positional array —
// there is no integer subscript anywhere. `val("basicHealth")` reads the settle
// for that field by name; a missing/rejected settle coalesces to null.
export function assembleProbeInputs(settled: SettledByKey): ProbeInputs {
  // Issue #1833/#3263: `val<T>(key)` coalesces a rejected/absent settle to null
  // and brands the fulfilled value as the field's declared type T. The settled
  // record is heterogeneous + untyped (Promise.allSettled over unrelated probes),
  // so the fulfilled branch is an unavoidable assertion — but naming T at each
  // call site hands the compiler the field's expected shape, so the object literal
  // below is type-checked against ProbeInputs BY NAME (a renamed/dropped field is
  // now a build error here, the fan-out owner, instead of a silent runtime miss in
  // parseProbes' `|| default`). The `<K extends AsyncProbeKey>` binding ties the
  // string key to a real ProbeInputs field, so a typo is a compile error too.
  const val = <T>(key: AsyncProbeKey): T | null => {
    const s = settled[key];
    return s && s.status === "fulfilled" ? (s.value as T) : null;
  };
  return {
    basicHealth: val<ProbeInputs["basicHealth"]>("basicHealth"),
    serviceProbes: val<ProbeInputs["serviceProbes"]>("serviceProbes"),
    scheduler: val<ProbeInputs["scheduler"]>("scheduler"),
    queueDepth: val<ProbeInputs["queueDepth"]>("queueDepth"),
    backlogCounts: val<ProbeInputs["backlogCounts"]>("backlogCounts"),
    metrics: val<ProbeInputs["metrics"]>("metrics"),
    disk: val<ProbeInputs["disk"]>("disk"),
    mem: val<ProbeInputs["mem"]>("mem"),
    sysdOrchestrator: val<ProbeInputs["sysdOrchestrator"]>("sysdOrchestrator"),
    sysdWatchdog: val<ProbeInputs["sysdWatchdog"]>("sysdWatchdog"),
    sysdTargetWeb: val<ProbeInputs["sysdTargetWeb"]>("sysdTargetWeb"),
    patterns: val<ProbeInputs["patterns"]>("patterns"),
    reflections: val<ProbeInputs["reflections"]>("reflections"),
    // Issue #3270: attribution ledger LLEN.
    attributionLedgerCount: val<ProbeInputs["attributionLedgerCount"]>("attributionLedgerCount"),
    ovSearch: val<ProbeInputs["ovSearch"]>("ovSearch"),
    redisInfo: val<ProbeInputs["redisInfo"]>("redisInfo"),
    emergencyBrake: val<ProbeInputs["emergencyBrake"]>("emergencyBrake"),
    ovSearchWindow: val<ProbeInputs["ovSearchWindow"]>("ovSearchWindow"),
    knowledgeContext: val<ProbeInputs["knowledgeContext"]>("knowledgeContext"),
    // Issue #2278: the Tailnet Ollama VLM-host liveness probe.
    ollamaVlm: val<ProbeInputs["ollamaVlm"]>("ollamaVlm"),
    // Issue #2386: the skill-catalog state is NOT an async settle-array probe (it
    // is a synchronous in-memory read), so it is not a registry key here.
    // assembleProbeInputs sets it null; collectProbeInputs overrides it with the
    // live read. A direct caller of assembleProbeInputs (e.g. the round-trip test)
    // therefore gets null, which parseProbes coalesces to the empty-catalog
    // default — the two skill-catalog rules no-op, matching the prior behaviour
    // where assembleProbeInputs carried no catalog at all.
    skillCatalog: null,
    // Issue #2805: like skillCatalog, the dark-outcome verdicts are a direct
    // never-throw read (not an async settle-array probe), so assembleProbeInputs
    // sets null and collectProbeInputs overrides it with the live read. A direct
    // caller gets null → parseProbes coalesces to [] → the dark-outcome rule
    // no-ops (honest-none).
    darkOutcomes: null,
    // Issue #3251: like darkOutcomes, the reflection-outcomes ledger liveness is
    // a direct never-throw read+projection (not an async settle-array probe), so
    // assembleProbeInputs sets null and collectProbeInputs overrides it with the
    // live projection. A direct caller gets null → parseProbes coalesces to the
    // `retired-empty` honest-none default → the rule fires the plain retirement INFO.
    reflectionOutcomesLiveness: null,
  };
}

// ---- collectProbeInputs — runs the named-registry fan-out and assembles ProbeInputs --
//
// The single entry point. Builds the named async-probe registry from the resolved
// deps, runs every descriptor's `run()` through one `Promise.allSettled` (so a
// slow/failing probe never blocks the others or the response), zips the results
// back to their keys, and folds that key→settled record to a named `ProbeInputs`
// record via `assembleProbeInputs`. No integer subscript appears anywhere (issue
// #3263) — the probe-to-field contract is keyed by name in the registry below.
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
  /** Issue #3270: ledger LLEN probe (default: getLedgerLen). Best-effort — returns 0 on error. */
  attributionLedgerLen?: typeof getLedgerLen;
  emergencyBrake?: typeof getEmergencyBrake;
  ovSearchWindow?: typeof getOvSearchWindow;
  knowledgeContextAvailability?: typeof getKnowledgeContextAvailability;
  redisInfoImpl?: typeof getRedisInfo;
  ovPostJsonImpl?: typeof ovPostJson;
  probeServiceImpl?: typeof probeService;
  probeOvImpl?: typeof probeOv;
  probeEmbedBackendImpl?: typeof probeEmbedBackend;
  /** Issue #2278: the Tailnet Ollama VLM-host liveness probe (default: real fetch). */
  probeOllamaVlmImpl?: typeof probeOllamaVlm;
  /**
   * Issue #2386: the in-process OV skill-catalog read (default: the real
   * getSkillCatalogState). A synchronous, never-throwing in-memory copy — NOT a
   * Promise.allSettled probe — so the full fan-out pipeline (and therefore the
   * two skill-catalog rules downstream) is testable with an injected catalog
   * state, no module-singleton reset and no registerSkills lifecycle dependency.
   */
  skillCatalogState?: typeof getSkillCatalogState;
  /**
   * Issue #2805: the live dark leading-outcome check (default: the real
   * evaluateDarkOutcomes). A never-throwing read — NOT a Promise.allSettled probe
   * — so the full fan-out pipeline (and the deep-health dark-outcome rule
   * downstream) is testable with an injected evaluation, no real outcomes.yaml or
   * metric files.
   */
  darkOutcomesEval?: typeof evaluateDarkOutcomes;
  /**
   * Issue #3251: the read-only liveness probe of the RETIRED reflection-outcomes
   * ledger (default: the real probeReflectionOutcomesLedger). A never-throwing
   * ZSET read — NOT a Promise.allSettled probe — so the full fan-out pipeline (and
   * the deep-health reflection-outcomes rule downstream) is testable with an
   * injected ledger state, no real Redis. Its result is projected through
   * projectReflectionOutcomesLiveness onto the snapshot.
   */
  reflectionOutcomesLedgerProbe?: typeof probeReflectionOutcomesLedger;
  /**
   * Issue #3251: injectable clock (ms) for the reflection-outcomes liveness
   * projection's staleness boundary (defaults to Date.now via the projector). A
   * test pins this to make the retired-frozen-tail vs unexpected-live-tail
   * boundary deterministic without touching wall-clock.
   */
  reflectionOutcomesNow?: () => number;
  targetServiceName?: () => string;
  /**
   * Issue #2498/#2570: the embed-backend Wake-on-LAN gate forwarded to
   * {@link maybeWakeEmbedBackend} (default: the WoL Adapter's `embed` singleton,
   * src/health/wol.ts `getWolGates().embed`, so production callers passing no
   * gate are byte-for-byte identical and keep cross-request cooldown/attempt
   * persistence). Injecting a fresh `new WakeGate(cooldown, maxAttempts)` lets a
   * test exercise gate exhaustion at the `collectProbeInputs` seam without
   * touching the adapter singleton.
   */
  embedWakeGate?: WakeGate;
  /**
   * Issue #2498/#2570: the VLM-host Wake-on-LAN gate forwarded to
   * {@link maybeWakeVlmHost} (default: the WoL Adapter's `vlm` singleton,
   * src/health/wol.ts `getWolGates().vlm`). Kept distinct from `embedWakeGate`
   * so the two wake budgets stay independent — no cross-wiring even though both
   * wake the same physical host.
   */
  vlmWakeGate?: WakeGate;
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
    attributionLedgerLen = getLedgerLen,
    emergencyBrake = getEmergencyBrake,
    ovSearchWindow = getOvSearchWindow,
    knowledgeContextAvailability = getKnowledgeContextAvailability,
    redisInfoImpl = getRedisInfo,
    ovPostJsonImpl = ovPostJson,
    probeServiceImpl = probeService,
    probeOvImpl = probeOv,
    probeEmbedBackendImpl = probeEmbedBackend,
    probeOllamaVlmImpl = probeOllamaVlm,
    skillCatalogState = getSkillCatalogState,
    darkOutcomesEval = evaluateDarkOutcomes,
    reflectionOutcomesLedgerProbe = probeReflectionOutcomesLedger,
    reflectionOutcomesNow,
    targetServiceName = getTargetServiceName,
    // Issue #2498/#2570: default to the WoL Adapter's process-lifetime gate pair
    // (src/health/wol.ts getWolGates()) so a no-gate production caller is
    // identical to today and keeps cross-request cooldown/attempt persistence
    // (ONE embed + ONE vlm budget across requests). A test injects a fresh
    // WakeGate to exercise exhaustion without touching the singleton — and, for
    // the default path, can call resetWolGates() to clear the memo between cases.
    // Distinct local names (embedGate/vlmGate) avoid self-referential destructure
    // shadowing against the same-named CollectProbeDeps fields.
    embedWakeGate: embedGate = getWolGates().embed,
    vlmWakeGate: vlmGate = getWolGates().vlm,
  } = deps;

  // Issue #3263: the named async-probe registry — the SINGLE source of the
  // probe-to-field contract. Each descriptor's `key` is the ProbeInputs field it
  // feeds; `run` is its never-blocking closure. No integer subscript, no legend
  // comment, no retired-slot tombstone: adding a probe is one entry here (+ the
  // ProbeInputs field), removing one is deleting one entry. The former index-3
  // cycle probe (a permanently-idle tombstone kept alive only to avoid
  // renumbering) is simply ABSENT — the in-process cycle was removed in PR-3
  // (issue #383) and the handler hardcodes activeCycle=null.
  const descriptors: AsyncProbeDescriptor[] = [
    {
      key: "basicHealth",
      run: async () => {
        const killed = killFileExists();
        const redisOk = await pingRedis();
        // In-process cycle removed in PR-3 (issue #383); status is "idle" forever.
        return { status: killed ? "killed" : "ok", redis: redisOk, cycle: "idle", uptime: process.uptime() };
      },
    },
    {
      key: "serviceProbes",
      run: async () => {
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
        // Issue #2228: if the embed-backend probe failed, FIRE a best-effort
        // Wake-on-LAN of the gaming PC and return the current probe result
        // immediately — never block the /health/deep fan-out waiting for the box
        // to POST. The powered-off box self-heals (the #1794 stretch goal) by the
        // NEXT scheduled health tick; this tick still surfaces the failure (so the
        // #2131 alert fires correctly while it's down). NEVER throws.
        const embedFinal = await maybeWakeEmbedBackend(embedBackend, { gate: embedGate });
        return { vikingdb, openviking: ov, "embed-backend": embedFinal };
      },
    },
    { key: "scheduler", run: () => schedulerStatus() },
    { key: "queueDepth", run: () => workQueueLen() },
    { key: "backlogCounts", run: () => backlogCounts() },
    { key: "metrics", run: async () => ({ trend: await metricsTrend(20), stats: await aggregateStats(20) }) },
    // Issue #939: host-info probes go through the Host-Probe Adapter, which owns
    // the argv + timeout + df/free parse and returns a typed never-throw result.
    // The fan-out coalesces a probe failure back to the same shape the old
    // `.catch()` sentinels produced (null disk/mem, "unknown" service-status) so
    // parseProbes' downstream contract is unchanged — the difference is the
    // failure mode is now a discriminated `code` we log, not a silent swallow.
    { key: "disk", run: () => disk().then(r => (isProbeFailure(r) ? null : r.data)) },
    { key: "mem", run: () => mem().then(r => (isProbeFailure(r) ? null : r.data)) },
    { key: "sysdOrchestrator", run: () => serviceStatus("hydra-orchestrator.service").then(r => (isProbeFailure(r) ? "unknown" : r.data)) },
    { key: "sysdWatchdog", run: () => serviceStatus("hydra-watchdog.timer").then(r => (isProbeFailure(r) ? "unknown" : r.data)) },
    { key: "sysdTargetWeb", run: () => serviceStatus(targetServiceName()).then(r => (isProbeFailure(r) ? "unknown" : r.data)) },
    {
      key: "patterns",
      run: async () => {
        const [p, e, s] = await Promise.all([memoryPatterns("planner"), memoryPatterns("executor"), memoryPatterns("skeptic")]);
        const cnt = (raw: string) => { try { return JSON.parse(raw).length; } catch { return 0; } };
        return { planner: cnt(p), executor: cnt(e), skeptic: cnt(s) };
      },
    },
    { key: "reflections", run: () => reflectionKeys() },
    // Issue #3270: ledger LLEN — surfaces "ledger remains empty" to the
    // deep-health attribution-ledger-dark rule. Best-effort: getLedgerLen already
    // returns 0 on any Redis error (never throws), so a rejected settle here is
    // an extra defensive layer only.
    { key: "attributionLedgerCount", run: () => attributionLedgerLen() },
    {
      key: "ovSearch",
      run: async () => {
        // Issue #954: OV search probe via the adapter (resolves OPENVIKING_URL +
        // auth headers + timeout + JSON unwrap) — no hardcoded localhost:1933, no
        // inline X-Api-Key. Never throws.
        // Issue #1032: timeout raised to OV_SEARCH_PROBE_TIMEOUT_MS and the
        // result→snapshot mapping lives in the pure, unit-tested
        // classifyOvSearchProbe so timeout vs real-failure is testable.
        const start = Date.now();
        const result = await ovPostJsonImpl<any>("/api/v1/search/find", { query: "system health", limit: 3 }, { timeout: OV_SEARCH_PROBE_TIMEOUT_MS });
        return classifyOvSearchProbe(result, Date.now() - start);
      },
    },
    {
      // I/O only — the raw INFO regex parse lives in the pure
      // parseRedisInfoSnapshot in diagnostics.ts (issue #1856).
      key: "redisInfo",
      run: async () => {
        try {
          const [info, clients, server] = await Promise.all([redisInfoImpl("memory"), redisInfoImpl("clients"), redisInfoImpl("server")]);
          return parseRedisInfoSnapshot(info, clients, server);
        } catch { return null; }
      },
    },
    { key: "emergencyBrake", run: () => emergencyBrake() /* issue #744 */ },
    // Issue #1440: persisted OV search-quality trend (24h hour-buckets) and
    // per-day knowledge-context availability (7d). Both degrade to null on a
    // Redis error so the probe never blocks /health/deep — the projection
    // coalesces a rejected settle to null. Consumed only by
    // projectHealthDeepResponse (not parseProbes).
    { key: "ovSearchWindow", run: () => ovSearchWindow(24) },
    { key: "knowledgeContext", run: () => knowledgeContextAvailability(7) },
    {
      // Issue #2278: DIRECT liveness probe of the Tailnet Ollama VLM host
      // (gabes-desktop-1:11434) — the host OpenViking uses for its vision/indexing
      // model. Distinct from the serviceProbes embed-backend probe (OV-internal
      // ollama-embed). A `down` result is surfaced as `ollamaVlm` on the wire and
      // flips the deep-health envelope to `degraded: true` (a visibility signal,
      // never a 5xx). The probe is contractually never-throwing.
      // Issue #2335: if the VLM host reads `status:down`, FIRE a best-effort
      // Wake-on-LAN of the gaming PC and return the current probe result
      // immediately (never block the fan-out on a re-probe). This is the host that
      // OpenViking's skill-registration handler blocks on, so waking it lets the
      // FROZEN registration chore self-heal the empty skill catalog on the next
      // hourly tick once the box answers. THIS tick still surfaces `down` so the
      // #2278 degraded signal + #2131 alert stay correct. NEVER throws.
      key: "ollamaVlm",
      run: async () => maybeWakeVlmHost(await probeOllamaVlmImpl(), { gate: vlmGate }),
    },
  ];

  // Run every descriptor through ONE Promise.allSettled (so a slow/failing probe
  // never blocks the others), then zip the positional results back to their keys.
  // The integer index is a private detail of this zip — it never escapes into the
  // probe-to-field contract, which is now keyed by name in the registry above.
  const results = await Promise.allSettled(descriptors.map(d => d.run()));
  const settled: SettledByKey = {};
  for (let i = 0; i < descriptors.length; i++) {
    settled[descriptors[i].key] = results[i];
  }

  // Issue #2386: the in-process skill-catalog state is a synchronous, never-throw
  // in-memory copy — not an async probe — so it is read directly (not a descriptor
  // in the named async-probe registry, which is reserved for I/O settle-array
  // probes) and merged onto the assembled named record. parseProbes copies it
  // onto HealthSnapshot.skillCatalog; the two skill-catalog rules read it from the
  // snapshot, so this fan-out is the single place the live read happens.
  // Issue #2805: the dark leading-outcome verdicts are a direct never-throw read
  // (like the skill-catalog state), merged onto the assembled record. A defensive
  // catch folds any unexpected error to null → parseProbes coalesces to [] → the
  // dark-outcome rule no-ops (honest-none), so a dark-outcome-check hiccup never
  // breaks /health/deep. Only `outcomeVerdicts` is carried (it holds the dark
  // verdicts with producerHint + query the rule surfaces).
  let darkOutcomes: ProbeInputs["darkOutcomes"] = null;
  try {
    const evaluated = await darkOutcomesEval({});
    darkOutcomes = evaluated.outcomeVerdicts;
  } catch (err: any) {
    console.error(
      `[health/fan-out] dark-outcome check failed (folding to honest-none): ${err?.message || err}`,
    );
  }
  // Issue #3251: probe the retired reflection-outcomes ledger and project its
  // residual state into a liveness report. The probe itself never throws (folds a
  // Redis error to the absent state); a defensive catch here folds any unexpected
  // error to null → parseProbes coalesces to `retired-empty` → the rule fires the
  // plain retirement INFO. So a ledger-probe hiccup never breaks /health/deep.
  let reflectionOutcomesLiveness: ProbeInputs["reflectionOutcomesLiveness"] = null;
  try {
    const ledger = await reflectionOutcomesLedgerProbe();
    reflectionOutcomesLiveness = projectReflectionOutcomesLiveness(
      ledger,
      reflectionOutcomesNow ? { now: reflectionOutcomesNow } : {},
    );
  } catch (err: any) {
    console.error(
      `[health/fan-out] reflection-outcomes ledger probe failed (folding to retired-empty): ${err?.message || err}`,
    );
  }
  return {
    ...assembleProbeInputs(settled),
    skillCatalog: skillCatalogState(),
    darkOutcomes,
    reflectionOutcomesLiveness,
  };
}

// ---- Now-page strip probe enumeration (issue #2597) ------------------------
//
// Why this lives HERE (the #2597 deepening):
//   The fan-out is the single owner of "which external services does the
//   orchestrator monitor?" — the positional array above enumerates the full
//   19-probe deep-health set. But the Now-page health strip
//   (src/aggregators/service-strip.ts) is a SECOND consumer that wants only the
//   user-facing subset of EXTERNAL-SERVICE LIVENESS probes (orchestrator, redis,
//   vikingdb, openviking, embed-backend, ollamaVlm) projected as display rows.
//   Before #2597 the strip hand-maintained its OWN 4-probe fan-out inline, so it
//   silently drifted from this file: it omitted embed-backend (#2013) and
//   ollamaVlm (#2278) — the two silent-failure probes the operator most needs at
//   a glance. Adding a probe meant editing both lists.
//
//   This ordered descriptor enumeration is the single source of that subset. The
//   strip maps each descriptor to a ServiceRow via the shared classifiers in the
//   ServiceProbe Adapter Seam (src/health/probe.ts) — it no longer decides WHICH
//   probes appear or in WHAT order. Adding a probe to the strip is now a
//   one-entry edit HERE.
//
// Scope boundary (design concept #2597 rejected-alternative): this is the
// LIVENESS subset the strip wants, NOT the full HealthSnapshot fan-out. The
// strip deliberately does not pull collectProbeInputs (that couples it to
// Redis/host reads it does not want and blows its 3s-per-probe budget). The
// /health/deep wire envelope keeps its own explicit named projection (#1869) —
// this enumeration does not change it.

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
 * the descriptor enumeration lives in the fan-out (the probe owner) without the
 * fan-out importing the strip (which would be circular — the strip imports this
 * module). The strip passes its resolved deps through verbatim.
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
  /** Tailnet Ollama VLM-host liveness (issue #2278). */
  probeOllamaVlm: typeof probeOllamaVlm;
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
 * (orchestrator, redis, vikingdb, openviking); the last two are the previously-
 * omitted embed-backend (#2013) and ollamaVlm (#2278) probes.
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
  {
    // Issue #2278: the Tailnet Ollama VLM host, previously omitted from the
    // strip. probeOllamaVlm folds `down` to `status:"down"`; map it to the
    // strip's ProbeOutcome (a `down` result → ok:false → a down row).
    service: "ollamaVlm",
    kind: "probe",
    run: async (deps) => {
      const r = await deps.probeOllamaVlm();
      return r.status === "ok"
        ? { ok: true, latencyMs: r.latencyMs }
        : { ok: false, latencyMs: r.latencyMs, error: r.error || "VLM host unreachable" };
    },
  },
];
