import { Router } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Issue #939: the `df`/`free`/`systemctl` host-info probes are now routed
// through the **Host-Probe Adapter** (`src/host-probe/*`) — a sibling Seam to
// the GitHub CLI Adapter, on its own private spawn primitive. With the raw
// child-process import gone, this file drops off the `github-seam-check`
// baseline (which closes to zero). The one `git` call (getDeployedSha) stays on
// the GitHub CLI Adapter seam below.
import { getMetricsTrend } from "../metrics/trend.ts";
import { getAggregateStats } from "../metrics/aggregate.ts";
import { getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import { getBacklogCounts } from "../backlog/reads.ts";
import { getMemoryPatterns } from "../redis/agent-memory.ts";
import { redisInfo as getRedisInfo } from "../redis/utility.ts";
import { getWorkQueueLen } from "../redis/work-queue.ts";
import { countReflectionKeys } from "../redis/reflections.ts";
import { getEmergencyBrake } from "../redis/emergency-brake.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
// Issue #1440: persisted, restart-surviving OpenViking search-quality trends.
// The /health/deep `intelligence.ovSearch` block has always carried the live
// liveness probe; these add the hour-bucketed zero-result/fallback-success
// trend and the per-day knowledge-context-availability rate so the operator can
// see "search quality degraded this hour" without the counters resetting on
// every restart.
import { getOvSearchWindow, getKnowledgeContextAvailability } from "../redis/ov-search-metrics.ts";
import { getTargetServiceName } from "../target-config.ts";
// Issue #954: the OpenViking health/search probes route through the OpenViking
// Request Adapter, which resolves the base URL from OPENVIKING_URL (via
// ov-config.ts). This kills the hardcoded `http://localhost:1933/...` literals
// that made the probe lie under a non-default OPENVIKING_URL (the #231-class
// bug) — the same structural fix #939 did for this file's df/free/systemctl
// probes via the Host-Probe Adapter. The OV liveness GET and the OV /search/find
// probe are both adapter request shapes; vikingdb stays a plain inline probe
// (it is not an OpenViking boundary).
// Issue #1980: the OV liveness GET (ovHealthGet) + isOvFailure now reach this
// file only through the ServiceProbe Adapter Seam (src/health-probe.ts), which
// owns probeOv(); this route file keeps only the direct ovPostJson use (the OV
// /search/find quality probe in /health/deep index 14).
import { ovPostJson } from "../knowledge-base/ov-request.ts";
// Issue #1980: probeService/probeOv and the ServiceProbeResult wire shape moved
// out of this route file into the focused ServiceProbe Adapter Seam
// (src/health-probe.ts). createHealthRouter now imports + delegates — the
// {status, latencyMs} fold and running/failed classification live in one named
// home, importable by non-route callers (e.g. aggregators/service-strip.ts)
// without coupling to src/api/. Behaviour-neutral: same probes, same wire shape.
import { probeService, probeOv } from "../health-probe.ts";
// Issue #840: the pure Health Assessment ruleset — disk/mem parsing, the
// `recent` derivation, the ~27 diagnostic rules, and the status/summary fold
// all live behind this seam. The handler keeps only I/O + wire projection.
import { parseProbes, assessHealth, projectHealthDeepResponse, classifyOvSearchProbe, parseRedisInfoSnapshot, OV_SEARCH_PROBE_TIMEOUT_MS, type ProbeInputs } from "../health-diagnostics.ts";
import { assessSkillCatalog } from "../health-skill-catalog.ts";
// Issue #1968: the in-process OV skill-catalog state, so /api/health/skills can
// surface the silent empty-catalog failure (startup skill registration losing
// all four skills to OpenViking timeouts) that no health surface reflected.
import { getSkillCatalogState } from "../knowledge-base/skill-registration.ts";
import type { PingableBus } from "./event-bus-types.ts";

// ---- assembleProbeInputs — maps the positional settled array to named ProbeInputs --
//
// Issue #1771: the I/O layer (this handler) is the only file that ever sees the
// raw positional Promise.allSettled results — that positional identity is
// internal to the fan-out and should not cross a module boundary.
// assembleProbeInputs() maps the array immediately after the fan-out so
// parseProbes() (in the pure seam src/health-diagnostics.ts) receives field
// names, not integer subscripts. The ProbeInputs type is the only thing that
// crosses the seam; the SettledLike shape and all integer index knowledge live
// here, the I/O owner (#840).
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
  // build error here, the I/O owner, instead of a silent runtime miss in
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
import { gitExec } from "../github/git.ts";
import { isGhFailure } from "../github/exec.ts";
// Issue #939: Host-Probe Adapter — typed, never-throw disk/mem/service-status
// readers. Replaces the inline `execFileAsync(...).catch(() => null|"unknown")`
// host-info probes that kept this file on the github-seam-check baseline.
import { readDisk, readMem, readServiceStatus, isProbeFailure } from "../host-probe/probe.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

// Issue #734 (deploy-drift backstop): expose the SHA the orchestrator is
// running from so the watchdog (and operators) can compare it against
// origin/master HEAD. This is a pure read — `git rev-parse HEAD` against
// $HYDRA_ROOT, which deploy.sh leaves checked out on master. Cached for 60s
// so the per-2-minute watchdog poll plus dashboard traffic doesn't fork a git
// process on every /health hit. Fail-safe: any error resolves to null and is
// simply omitted from the response (never throws, never blocks /health).
let deployedShaCache: { sha: string | null; at: number } = { sha: null, at: 0 };
const DEPLOYED_SHA_TTL_MS = 60_000;

// Issue #1324 + #1980: the plain-HTTP service probe and the OpenViking liveness
// probe used to be duplicated as inline closures inside both GET /health/services
// and the GET /health/deep fan-out (index 1). #1324 hoisted them to module level
// here; #1980 moved them into the focused ServiceProbe Adapter Seam
// (src/health-probe.ts) so the failed/running classification lives in ONE named
// home, unit-testable without Express (see test/health-probe.test.mts) and
// importable by non-route callers. They stay at the I/O layer (NOT in
// src/health-diagnostics.ts, the deliberately pure I/O-free Health Assessment
// seam, #840). vikingdb is a plain inline probeService call (not an OpenViking
// boundary), so it does NOT route through the OpenViking Request Adapter; only
// probeOv() does. createHealthRouter imports probeService/probeOv from the seam.

async function getDeployedSha(): Promise<string | null> {
  const now = Date.now();
  if (deployedShaCache.sha !== null && now - deployedShaCache.at < DEPLOYED_SHA_TTL_MS) {
    return deployedShaCache.sha;
  }
  // Routes the `git rev-parse HEAD` through the GitHub CLI Adapter seam (issue
  // #899). The seam never throws; a failure arm (not a git checkout, git
  // missing, or timeout) degrades to null — the field is advisory and must
  // never block /health.
  const result = await gitExec(["-C", HYDRA_ROOT, "rev-parse", "HEAD"], { timeout: 3000 });
  if (isGhFailure(result)) {
    // Log once-per-cache-window so a misconfigured host is visible without
    // spamming, then omit the field.
    console.error(`[API] /health deployedSha unavailable (${result.code}): ${result.stderr.slice(0, 200)}`);
    deployedShaCache = { sha: null, at: now };
    return null;
  }
  const sha = result.data.stdout.trim() || null;
  deployedShaCache = { sha, at: now };
  return sha;
}

export function createHealthRouter(eventBus: PingableBus) {
  const router = Router();

  // GET /health — Basic health check
  router.get("/health", async (req, res) => {
    const killFileExists = existsSync(KILL_FILE);
    let redisOk = false;
    try {
      await eventBus.publisher.ping();
      redisOk = true;
    } catch { /* intentional: ping failure reflected via redisOk=false in the response */ }

    // Issue #734: advisory deployed-SHA for the deploy-drift backstop. null
    // when unresolvable (omitted-by-coalesce below); never blocks /health.
    const deployedSha = await getDeployedSha();

    // Issue #744: operator-only emergency-brake state. Fail-safe to
    // disengaged if Redis is unreachable — the brake read must never block
    // /health (the watchdog polls this surface). The brake itself still
    // holds; this read is purely advisory observability.
    let emergencyBrake: { engaged: boolean; since?: number; engagedBy?: string } = { engaged: false };
    try {
      emergencyBrake = await getEmergencyBrake();
    } catch (err: any) {
      console.error(`[API] /health emergency-brake read failed: ${err?.message ?? err}`);
    }

    // Issue #988: operator-only autopilot-pause state. A deliberate pause is a
    // HEALTHY/expected state — surfaced so hydra-doctor / the watchdog can
    // distinguish "operator paused autopilot on purpose" from "autopilot
    // wedged", and never report a pause as degraded. Fail-safe to not-paused
    // if Redis is unreachable; the read is purely advisory observability.
    let autopilotPause: { paused: boolean; since?: number } = { paused: false };
    try {
      autopilotPause = await getAutopilotPaused();
    } catch (err: any) {
      console.error(`[API] /health autopilot-pause read failed: ${err?.message ?? err}`);
    }

    res.json({
      status: killFileExists ? "killed" : "ok",
      redis: redisOk,
      // In-process control loop removed in PR-3 (issue #383). Autopilot
      // subagents own execution now; "idle" is the only status this surface
      // ever returns.
      cycle: "idle",
      uptime: process.uptime(),
      // Issue #734: SHA the orchestrator is running from (deploy.sh leaves
      // $HYDRA_ROOT on master HEAD). Advisory — null/absent if git is
      // unavailable. The watchdog compares this against origin/master.
      deployedSha,
      // Issue #744: emergency-brake state. `{engaged:false}` by default;
      // `{engaged:true, since, engagedBy}` while the operator holds the brake.
      emergencyBrake,
      // Issue #988: autopilot-pause state. `{paused:false}` by default;
      // `{paused:true, since}` while the operator has paused autopilot. A
      // HEALTHY/expected state — NOT degraded.
      autopilotPause,
    });
  });

  // GET /health/services — Probe VikingDB and OpenViking
  // The openai-proxy and ollama probes were retired in PR-3 (issue #383) —
  // both only existed to serve the in-process codex CLI agents.
  router.get("/health/services", async (req, res) => {
    // Issue #1324: the probe/probeOv closures that used to live here are now the
    // module-level probeService()/probeOv() helpers (one classification site,
    // unit-tested in test/health-probe.test.mts). vikingdb stays a plain inline
    // probe (not an OpenViking boundary); openviking routes through the OV
    // Request Adapter inside probeOv().
    const [vikingdb, openviking] = await Promise.all([
      probeService("http://localhost:5000/health"),
      probeOv(),
    ]);

    res.json({ vikingdb, openviking });
  });

  // GET /health/skills — OV skill-catalog registration state (issue #1968)
  //
  // Surfaces the previously-silent failure mode where startup skill
  // registration loses all four skills to OpenViking timeouts/5xx under load,
  // leaving the catalog empty while the service reports a clean startup. Reads
  // the in-process state (no Redis/OV round-trip) and folds it through the pure
  // `assessSkillCatalog` gate so the operator can tell `ok` from `degraded`
  // (some missing) from `empty` (the silent knowledge-plane failure).
  router.get("/health/skills", (_req, res) => {
    const state = getSkillCatalogState();
    const assessment = assessSkillCatalog(state);
    res.json({
      status: assessment.status,
      registered: state.registered,
      total: state.total,
      completed: state.completed,
      lastAttemptAt: state.lastAttemptAt,
      skills: state.skills,
      diagnostic: assessment.diagnostic,
    });
  });

  // GET /health/deep — Comprehensive health with diagnostic reasoning
  router.get("/health/deep", async (req, res) => {
    const checkedAt = new Date().toISOString();
    const settled = await Promise.allSettled([
      /* 0: basic health */ (async () => {
        const killed = existsSync(KILL_FILE);
        let redisOk = false;
        try { await eventBus.publisher.ping(); redisOk = true; } catch { /* intentional: ping failure reflected via redisOk=false */ }
        // In-process cycle removed in PR-3 (issue #383); status is "idle" forever.
        return { status: killed ? "killed" : "ok", redis: redisOk, cycle: "idle", uptime: process.uptime() };
      })(),
      /* 1: service probes */ (async () => {
        // Issue #1324: probe/probeOv are now the shared module-level helpers
        // probeService()/probeOv() (see /health/services above) — same
        // classification, one place, unit-tested. vikingdb stays an inline probe
        // (not an OpenViking boundary); openviking routes through the OV Request
        // Adapter (#954, resolves OPENVIKING_URL — no hardcoded localhost:1933).
        // openai-proxy diagnostic removed in PR-3 (issue #383).
        const [vikingdb, ov] = await Promise.all([probeService("http://localhost:5000/health"), probeOv()]);
        return { vikingdb, openviking: ov };
      })(),
      /* 2 */ getSchedulerStatus(),
      /* 3 */ Promise.resolve({ status: "idle" }),
      /* 4 */ getWorkQueueLen(),
      /* 5 */ getBacklogCounts(),
      /* 6 */ (async () => ({ trend: await getMetricsTrend(20), stats: await getAggregateStats(20) }))(),
      // Issue #939: host-info probes now go through the Host-Probe Adapter,
      // which owns the argv + timeout + df/free parse and returns a typed
      // never-throw result. The fan-out coalesces a probe failure back to the
      // same shape the old `.catch()` sentinels produced (null disk/mem,
      // "unknown" service-status) so parseProbes' downstream contract is
      // unchanged — the difference is the failure mode is now a discriminated
      // `code` we log, not an indistinguishable swallow.
      /* 7  df    */ readDisk().then(r => (isProbeFailure(r) ? null : r.data)),
      /* 8  free  */ readMem().then(r => (isProbeFailure(r) ? null : r.data)),
      /* 9  sysd  */ readServiceStatus("hydra-orchestrator.service").then(r => (isProbeFailure(r) ? "unknown" : r.data)),
      /* 10 sysd  */ readServiceStatus("hydra-watchdog.timer").then(r => (isProbeFailure(r) ? "unknown" : r.data)),
      /* 11 sysd  */ readServiceStatus(getTargetServiceName()).then(r => (isProbeFailure(r) ? "unknown" : r.data)),
      /* 12 */ (async () => {
        const [p, e, s] = await Promise.all([getMemoryPatterns("planner"), getMemoryPatterns("executor"), getMemoryPatterns("skeptic")]);
        const cnt = (raw) => { try { return JSON.parse(raw).length; } catch { return 0; } };
        return { planner: cnt(p), executor: cnt(e), skeptic: cnt(s) };
      })(),
      /* 13 */ countReflectionKeys(),
      /* 14 */ (async () => {
        // Issue #954: OV search probe via the adapter (resolves OPENVIKING_URL +
        // auth headers + timeout + JSON unwrap) — no hardcoded localhost:1933,
        // no inline X-Api-Key. Never throws.
        // Issue #1032: timeout raised to OV_SEARCH_PROBE_TIMEOUT_MS (the old
        // 3000ms was tighter than even the real search path and false-negatived
        // `failed` against the Ollama-backed embedding latency), and the
        // result→snapshot mapping moved to the pure, unit-tested
        // `classifyOvSearchProbe` so timeout vs real-failure is testable.
        const start = Date.now();
        const result = await ovPostJson<any>("/api/v1/search/find", { query: "system health", limit: 3 }, { timeout: OV_SEARCH_PROBE_TIMEOUT_MS });
        return classifyOvSearchProbe(result, Date.now() - start);
      })(),
      /* 15: I/O only — the raw INFO regex parse moved to the pure
         parseRedisInfoSnapshot in health-diagnostics.ts (issue #1856). */
      (async () => {
        try {
          const [info, clients, server] = await Promise.all([getRedisInfo("memory"), getRedisInfo("clients"), getRedisInfo("server")]);
          return parseRedisInfoSnapshot(info, clients, server);
        } catch { return null; }
      })(),
      /* 16: emergency brake (issue #744) */ getEmergencyBrake(),
      // Issue #1440: persisted OV search-quality trend (24h hour-buckets) and
      // per-day knowledge-context availability (7d). Both degrade to null on a
      // Redis error so the probe never blocks /health/deep — the projection
      // below coalesces a rejected settle to null.
      /* 17 */ getOvSearchWindow(24),
      /* 18 */ getKnowledgeContextAvailability(7),
    ]);

    // Issue #840: parse the raw probe fan-out into the normalized Health
    // Snapshot, then run the pure Health Assessment ruleset. The handler owns
    // only I/O (the fan-out above) and the wire-envelope projection below;
    // disk/mem parsing, the `recent` derivation, every diagnostic rule, and the
    // status/summary fold now live in src/health-diagnostics.ts.
    // Issue #1771: map the positional settled array to the named ProbeInputs record
    // immediately after the fan-out. The ProbeInputs type — defined in health-diagnostics.ts,
    // the pure seam (#840) — carries all 19 probes (0-18, except 3=cycle handled below).
    // parseProbes and projectHealthDeepResponse both receive the named record;
    // no integer subscript crosses a file boundary.
    const probeInputs = assembleProbeInputs(settled);
    const snapshot = parseProbes(probeInputs);
    const { diagnostics, status, summary } = assessHealth(snapshot);

    // The `cycle` probe (index 3) drives only the activeCycle block, which stays
    // here at the HTTP layer (out of scope per issue #1513 — a vestigial concern).
    // The already-built activeCycle object is handed to the pure projection.
    const cycle = (settled[3] && settled[3].status === "fulfilled" ? (settled[3] as any).value : null) || {};

    let activeCycle = null;
    if (cycle.status === "running" && cycle.cycleId) {
      const sa = cycle.startedAt || cycle.tasks?.[0]?.startedAt;
      const dur = sa ? Date.now() - new Date(sa).getTime() : 0;
      activeCycle = { id: cycle.cycleId, status: cycle.status, startedAt: sa, durationMs: dur, durationHuman: dur > 60000 ? `${Math.round(dur / 60000)}m ${Math.round((dur % 60000) / 1000)}s` : `${Math.round(dur / 1000)}s`, tasks: (cycle.tasks || []).map(t => ({ id: t.taskId || t.id, title: t.title, state: t.state || t.status })) };
    }

    // Issue #1513: the wire-projection half (the former inline res.json block)
    // is now the pure, unit-tested projectHealthDeepResponse in
    // src/health-diagnostics.ts — the third leg of the Snapshot pipeline
    // alongside parseProbes/assessHealth (#840). The handler owns only the
    // Promise.allSettled fan-out (I/O) and the activeCycle derivation; settled
    // is passed through for indices 17/18 (ovSearchTrend/knowledgeContext),
    // which parseProbes does not consume.
    res.json(projectHealthDeepResponse(snapshot, diagnostics, status, summary, activeCycle, checkedAt, probeInputs));
  });

  // GET /recommendations (operator action items) was extracted to
  // createRecommendationsRouter in src/api/recommendations.ts (issue #1322).
  // The public /api/recommendations path is unchanged — that router mounts
  // prefix-less in src/api.ts, same as this one.

  return router;
}
