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
import { getMemoryPatterns } from "../redis/agent-memory.ts";
import { redisInfo as getRedisInfo } from "../redis/utility.ts";

// Issue #3459: getWorkQueueLen / getBacklogCounts stubs removed. These always
// returned 0/empty after ADR-0031 retired the Redis backlog subsystem; the four
// rules that gated on queueDepth/blCounts could never fire. The fields have been
// removed from HealthSnapshot and ProbeInputs.
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
import { probeService, probeOv, probeEmbedBackend, probeOllamaVlm, classifyOvSearchProbe, OV_SEARCH_PROBE_TIMEOUT_MS } from "./probe.ts";
import { parseRedisInfoSnapshot } from "./diagnostics.ts";
// Issue #3230: the ProbeInputs named-record type comes from the zero-logic leaf.
// Issue #3393: the pure settled-record → ProbeInputs mapping (assembleProbeInputs)
// and its structural-vocabulary types (AsyncProbeKey / InlineProbeKey /
// SettledByKey) + the inline honest-none registry (INLINE_FALLBACKS) now live in
// that same leaf, co-located with the ProbeInputs type they populate. This
// fan-out is a pure I/O coordinator that IMPORTS the assembly and calls it after
// the async fan-out — it no longer owns the structural mapping.
import {
  assembleProbeInputs,
  INLINE_FALLBACKS,
  type ProbeInputs,
  type AsyncProbeKey,
  type InlineProbeKey,
  type SettledByKey,
} from "./types.ts";
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

// ---- The unified probe registry — keyed, position-free (issue #3263/#3372) ----
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
// Issue #3263 replaced the positional array with a NAMED registry: each async
// probe became a `{ key, run }` descriptor whose `key` is the `ProbeInputs` field
// it feeds. The integer subscript vanished — but the three in-process reads
// (skillCatalog #2386, darkOutcomes #2805, reflectionOutcomesLiveness #3251) were
// left OUTSIDE that registry: an `Exclude<...>` type carved them out of the async
// key set, `assembleProbeInputs` hardcoded them to `null` placeholders, and
// `collectProbeInputs` ran three bespoke try/catch blocks after the fan-out to
// merge their live values. So TWO mental models co-existed, and adding one of
// those reads still meant three synchronised edits (the Exclude carve-out, the
// null placeholder, the bespoke post-fan-out block).
//
// Issue #3372 UNIFIES both kinds behind ONE discriminated `ProbeDescriptor` union:
//   - `{ kind: "async", key, run }` — the settle-array probe (unchanged): its
//     `run` is fanned out through ONE `Promise.allSettled`; a rejected settle
//     coalesces the field to `null` (parseProbes then applies its own default).
//   - `{ kind: "inline", key, run, fallback }` — the direct in-process read: its
//     `run` (sync OR async — awaited uniformly via `Promise.resolve`) runs inside
//     a per-descriptor try/catch that yields `fallback` on error. `fallback` is
//     the SEMANTIC honest-none value (empty catalog / [] / retired-empty report),
//     NOT raw `null` — which is exactly why these reads could never be ordinary
//     async probes (a rejected async settle coalesces to `null`, losing the
//     meaningful default). The true common property of the three reads is this
//     honest-none fallback, NOT "runs synchronously": only skillCatalog is truly
//     sync; darkOutcomes and reflectionOutcomesLiveness are awaited.
//
// `collectProbeInputs` builds ONE descriptor list, partitions by `kind`, fans out
// the async subset through `Promise.allSettled`, runs the inline subset with a
// per-descriptor try/catch, and folds both into the named `ProbeInputs` record via
// `assembleProbeInputs`. Adding a probe of EITHER kind is now one descriptor entry
// (+ its `ProbeInputs` field) — no `Exclude` list, no null placeholder, no bespoke
// post-fan-out block to keep in sync. The retired index-3 cycle probe stays absent.

// Issue #3393: `AsyncProbeKey` / `InlineProbeKey` (the structural key partition of
// `ProbeInputs`) now live in the type-vocabulary leaf (src/health/types.ts),
// alongside the `ProbeInputs` type they partition and the `assembleProbeInputs`
// mapping that consumes them — imported at the top of this file. The
// `ProbeDescriptor` union below is the fan-out's OWN I/O concern (it names the two
// execution paths this coordinator runs), so it stays here and references the
// imported key types.

/**
 * One entry in the unified probe registry (issue #3263/#3372) — a discriminated
 * union over the two execution paths. The `kind` discriminant lets
 * `collectProbeInputs` partition ONE descriptor array into the settle-array
 * fan-out (`async`) and the per-descriptor inline reads (`inline`), with the
 * compiler enforcing which path each descriptor takes:
 *
 *  - `async`  — `run` is fanned out through `Promise.allSettled`; a rejected
 *               settle coalesces the field to `null`.
 *  - `inline` — `run` (sync or async, awaited uniformly) runs inside a
 *               per-descriptor try/catch that yields `fallback` (the honest-none
 *               semantic default) on error — never `null`, never propagating, and
 *               never blocking the async fan-out.
 *
 * The inline arm is a mapped-type distribution over {@link InlineProbeKey} so
 * `run`/`fallback` are pinned to the SAME `ProbeInputs[K]` field type at each key —
 * the compiler enforces the field contract exactly as the async arm's assembly
 * does, so a renamed/dropped field is a build error here (the fan-out owner).
 *
 * Module-private (issue #3314): only `collectProbeInputs` below builds the
 * descriptor list — no external consumer references this shape, so it carries no
 * `export`.
 */
type ProbeDescriptor =
  | { kind: "async"; key: AsyncProbeKey; run: () => Promise<unknown> }
  | {
      [K in InlineProbeKey]: {
        kind: "inline";
        key: K;
        run: () => Promise<ProbeInputs[K]> | ProbeInputs[K];
        fallback: ProbeInputs[K];
      };
    }[InlineProbeKey];

// ---- The keyed settled record + inline fallbacks + assembleProbeInputs ------
//
// Issue #3393: the `SettledByKey` record type, the `INLINE_FALLBACKS` honest-none
// registry, and the pure `assembleProbeInputs` mapping all moved to the
// type-vocabulary leaf (src/health/types.ts), co-located with the `ProbeInputs`
// type they populate. They are imported at the top of this file; `collectProbeInputs`
// below zips the async settles into a `SettledByKey`, hands it to
// `assembleProbeInputs`, and overrides the inline seeds with the live reads.

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
  // Issue #3459: workQueueLen + backlogCounts removed (stubs always returned 0
  // after ADR-0031 retired the Redis backlog subsystem).
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
    // Issue #3459: workQueueLen + backlogCounts removed.
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

  // Issue #3263/#3372: the unified probe registry — the SINGLE source of the
  // probe-to-field contract. Each descriptor's `key` is the ProbeInputs field it
  // feeds; `run` is its never-blocking closure. No integer subscript, no legend
  // comment, no retired-slot tombstone: adding a probe (of EITHER kind) is one
  // entry here (+ the ProbeInputs field), removing one is deleting one entry. The
  // former index-3 cycle probe (a permanently-idle tombstone kept alive only to
  // avoid renumbering) is simply ABSENT — the in-process cycle was removed in PR-3
  // (issue #383) and the handler hardcodes activeCycle=null.
  //
  // The `async` descriptors fan out through Promise.allSettled (a rejected settle
  // coalesces to null); the three `inline` descriptors are direct in-process reads
  // run through a per-descriptor try/catch that yields their honest-none `fallback`
  // on error (issue #3372 — see the ProbeDescriptor union above).
  const descriptors: ProbeDescriptor[] = [
    {
      kind: "async",
      key: "basicHealth",
      run: async () => {
        const killed = killFileExists();
        const redisOk = await pingRedis();
        // In-process cycle removed in PR-3 (issue #383); status is "idle" forever.
        return { status: killed ? "killed" : "ok", redis: redisOk, cycle: "idle", uptime: process.uptime() };
      },
    },
    {
      kind: "async",
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
    { kind: "async", key: "scheduler", run: () => schedulerStatus() },
    // Issue #3459: queueDepth + backlogCounts descriptors removed.
    { kind: "async", key: "metrics", run: async () => ({ trend: await metricsTrend(20), stats: await aggregateStats(20) }) },
    // Issue #939: host-info probes go through the Host-Probe Adapter, which owns
    // the argv + timeout + df/free parse and returns a typed never-throw result.
    // The fan-out coalesces a probe failure back to the same shape the old
    // `.catch()` sentinels produced (null disk/mem, "unknown" service-status) so
    // parseProbes' downstream contract is unchanged — the difference is the
    // failure mode is now a discriminated `code` we log, not a silent swallow.
    { kind: "async", key: "disk", run: () => disk().then(r => (isProbeFailure(r) ? null : r.data)) },
    { kind: "async", key: "mem", run: () => mem().then(r => (isProbeFailure(r) ? null : r.data)) },
    { kind: "async", key: "sysdOrchestrator", run: () => serviceStatus("hydra-orchestrator.service").then(r => (isProbeFailure(r) ? "unknown" : r.data)) },
    { kind: "async", key: "sysdWatchdog", run: () => serviceStatus("hydra-watchdog.timer").then(r => (isProbeFailure(r) ? "unknown" : r.data)) },
    { kind: "async", key: "sysdTargetWeb", run: () => serviceStatus(targetServiceName()).then(r => (isProbeFailure(r) ? "unknown" : r.data)) },
    {
      kind: "async",
      key: "patterns",
      run: async () => {
        const [p, e, s] = await Promise.all([memoryPatterns("planner"), memoryPatterns("executor"), memoryPatterns("skeptic")]);
        const cnt = (raw: string) => { try { return JSON.parse(raw).length; } catch { return 0; } };
        return { planner: cnt(p), executor: cnt(e), skeptic: cnt(s) };
      },
    },
    { kind: "async", key: "reflections", run: () => reflectionKeys() },
    // Issue #3270: ledger LLEN — surfaces "ledger remains empty" to the
    // deep-health attribution-ledger-dark rule. Best-effort: getLedgerLen already
    // returns 0 on any Redis error (never throws), so a rejected settle here is
    // an extra defensive layer only.
    { kind: "async", key: "attributionLedgerCount", run: () => attributionLedgerLen() },
    {
      kind: "async",
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
      kind: "async",
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
    { kind: "async", key: "emergencyBrake", run: () => emergencyBrake() /* issue #744 */ },
    // Issue #1440: persisted OV search-quality trend (24h hour-buckets) and
    // per-day knowledge-context availability (7d). Both degrade to null on a
    // Redis error so the probe never blocks /health/deep — the projection
    // coalesces a rejected settle to null. Consumed only by
    // projectHealthDeepResponse (not parseProbes).
    { kind: "async", key: "ovSearchWindow", run: () => ovSearchWindow(24) },
    { kind: "async", key: "knowledgeContext", run: () => knowledgeContextAvailability(7) },
    {
      kind: "async",
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
    // ---- The three inline in-process reads (issue #3372) --------------------
    //
    // Not async settle-array probes — direct in-process reads whose failure mode
    // is a SEMANTIC honest-none `fallback` (empty catalog / [] / retired-empty),
    // not raw null. Each `run` runs inside a per-descriptor try/catch below that
    // yields `fallback` on error, never propagating and never blocking the async
    // fan-out. Before #3372 these lived OUTSIDE the registry (an Exclude carve-out
    // + null placeholders in assembleProbeInputs + three bespoke post-fan-out
    // try/catch blocks); now they are ordinary registry entries of `kind:"inline"`.
    {
      // Issue #2386: the in-process OV skill-catalog state — a synchronous,
      // never-throw in-memory copy (the ONLY genuinely-sync read of the three).
      // parseProbes copies it onto HealthSnapshot.skillCatalog; the two
      // skill-catalog rules read it from the snapshot, so this fan-out is the
      // single place the live read happens. `fallback` is the un-run empty catalog.
      kind: "inline",
      key: "skillCatalog",
      run: () => skillCatalogState(),
      fallback: INLINE_FALLBACKS.skillCatalog,
    },
    {
      // Issue #2805: the dark leading-outcome verdicts — a never-throwing chore
      // read (async) that plucks `.outcomeVerdicts` (the dark verdicts with
      // producerHint + query the rule surfaces). `fallback` is [] → the
      // dark-outcome rule no-ops (honest-none), so a check hiccup never breaks
      // /health/deep.
      kind: "inline",
      key: "darkOutcomes",
      run: async () => (await darkOutcomesEval({})).outcomeVerdicts,
      fallback: INLINE_FALLBACKS.darkOutcomes,
    },
    {
      // Issue #3251: probe the retired reflection-outcomes ledger (async, never
      // throws — folds a Redis error to the absent state) and project its residual
      // state into a liveness report with the injected clock. `fallback` is the
      // `retired-empty` report → the reflection-outcomes rule fires the plain
      // retirement INFO, never a phantom alarm.
      kind: "inline",
      key: "reflectionOutcomesLiveness",
      run: async () =>
        projectReflectionOutcomesLiveness(
          await reflectionOutcomesLedgerProbe(),
          reflectionOutcomesNow ? { now: reflectionOutcomesNow } : {},
        ),
      fallback: INLINE_FALLBACKS.reflectionOutcomesLiveness,
    },
  ];

  // Partition the unified registry by `kind` (issue #3372). The `async` subset
  // fans out through ONE Promise.allSettled (so a slow/failing probe never blocks
  // the others); the `inline` subset runs directly through a per-descriptor
  // try/catch that yields the honest-none `fallback` on error. Both merge into the
  // named ProbeInputs record — assembleProbeInputs maps the async keys, the inline
  // results override their honest-none seeds.
  const asyncDescriptors = descriptors.filter(
    (d): d is Extract<ProbeDescriptor, { kind: "async" }> => d.kind === "async",
  );
  const inlineDescriptors = descriptors.filter(
    (d): d is Extract<ProbeDescriptor, { kind: "inline" }> => d.kind === "inline",
  );

  // Run the async subset through ONE Promise.allSettled, then zip the positional
  // results back to their keys. The integer index is a private detail of this zip
  // — it never escapes into the probe-to-field contract, which is keyed by name.
  const results = await Promise.allSettled(asyncDescriptors.map(d => d.run()));
  const settled: SettledByKey = {};
  for (let i = 0; i < asyncDescriptors.length; i++) {
    settled[asyncDescriptors[i].key] = results[i];
  }

  // Run each inline read directly. `Promise.resolve(run())` awaits a sync OR async
  // `run` uniformly; a throw/rejection folds to the descriptor's honest-none
  // `fallback` (never null, never propagating). This replaces the former three
  // bespoke post-fan-out try/catch blocks with one uniform loop.
  const inline: Partial<{ [K in InlineProbeKey]: ProbeInputs[K] }> = {};
  for (const d of inlineDescriptors) {
    try {
      // The union-distributed run/fallback are `ProbeInputs[K]` for this key, but
      // the loop erases K to the InlineProbeKey union — the assignment through the
      // Partial record is sound because the descriptor's own key binds run→fallback.
      (inline as any)[d.key] = await Promise.resolve(d.run());
    } catch (err: any) {
      (inline as any)[d.key] = d.fallback;
      console.error(
        `[health/fan-out] inline probe '${d.key}' failed (folding to honest-none fallback): ${err?.message || err}`,
      );
    }
  }

  return {
    ...assembleProbeInputs(settled),
    ...inline,
  };
}

// ---- Now-page strip probe enumeration ---------------------------------------
//
// Issue #3482: the strip-probe enumeration (STRIP_PROBE_DESCRIPTORS,
// StripProbeDescriptor, StripProbeDeps, and the serviceProbeToOutcome adapter)
// moved to its own focused leaf, src/health/strip-probes.ts. The fan-out is the
// deep-health probe owner; the strip enumeration is the user-facing external-
// service liveness subset that service-strip.ts renders. Co-locating them here
// coupled service-strip's load path to the fan-out's heavy import closure (Redis
// adapters, WoL gates, reflection/ledger readers) even though the strip needs
// none of it. The enumeration now lives in a pure leaf that imports downward
// only (src/health/probe.ts); the strip imports from there (or via ../health).
// The #2597 invariant — ONE owner of which services appear on the strip, in what
// order — is preserved; the owner is just the named leaf now.
