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
import { getTargetServiceName } from "../target-config.ts";
// Issue #954: the OpenViking health/search probes route through the OpenViking
// Request Adapter, which resolves the base URL from OPENVIKING_URL (via
// ov-config.ts). This kills the hardcoded `http://localhost:1933/...` literals
// that made the probe lie under a non-default OPENVIKING_URL (the #231-class
// bug) — the same structural fix #939 did for this file's df/free/systemctl
// probes via the Host-Probe Adapter. The OV liveness GET and the OV /search/find
// probe are both adapter request shapes; vikingdb stays a plain inline probe
// (it is not an OpenViking boundary).
import { ovHealthGet, ovPostJson, isOvFailure } from "../knowledge-base/ov-request.ts";
// Issue #840: the pure Health Assessment ruleset — disk/mem parsing, the
// `recent` derivation, the ~27 diagnostic rules, and the status/summary fold
// all live behind this seam. The handler keeps only I/O + wire projection.
import { parseProbes, assessHealth, classifyOvSearchProbe, OV_SEARCH_PROBE_TIMEOUT_MS } from "../health-diagnostics.ts";
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

export function createHealthRouter(eventBus: any) {
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
    async function probe(url, acceptAny = false) {
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return { status: (r.ok || acceptAny) ? "running" : "failed", latencyMs: Date.now() - start };
      } catch {
        return { status: "failed", latencyMs: null };
      }
    }

    // OpenViking liveness via the adapter (resolves OPENVIKING_URL, 3000ms);
    // vikingdb stays a plain inline probe (not an OpenViking boundary).
    async function probeOv() {
      const start = Date.now();
      const result = await ovHealthGet("/health", { timeout: 3000 });
      return {
        status: isOvFailure(result) ? "failed" : "running",
        latencyMs: isOvFailure(result) ? null : Date.now() - start,
      };
    }

    const [vikingdb, openviking] = await Promise.all([
      probe("http://localhost:5000/health"),
      probeOv(),
    ]);

    res.json({ vikingdb, openviking });
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
        const probe = async (url, acceptAny = false) => {
          try {
            const start = Date.now();
            const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
            return { status: (r.ok || acceptAny) ? "running" : "failed", latencyMs: Date.now() - start };
          } catch { return { status: "failed", latencyMs: null }; }
        };
        // Issue #954: OpenViking liveness via the adapter (resolves OPENVIKING_URL,
        // 3000ms) — no hardcoded localhost:1933. vikingdb stays an inline probe.
        // openai-proxy diagnostic removed in PR-3 (issue #383) — port 4001 only
        // existed to feed the codex CLI agents.
        const probeOv = async () => {
          const start = Date.now();
          const r = await ovHealthGet("/health", { timeout: 3000 });
          return { status: isOvFailure(r) ? "failed" : "running", latencyMs: isOvFailure(r) ? null : Date.now() - start };
        };
        const [vikingdb, ov] = await Promise.all([probe("http://localhost:5000/health"), probeOv()]);
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
      /* 15 */ (async () => {
        try {
          const [info, clients, server] = await Promise.all([getRedisInfo("memory"), getRedisInfo("clients"), getRedisInfo("server")]);
          return { memoryHuman: info.match(/used_memory_human:(\S+)/)?.[1] || "unknown", connectedClients: parseInt(clients.match(/connected_clients:(\d+)/)?.[1] || "0"), uptimeSeconds: parseInt(server.match(/uptime_in_seconds:(\d+)/)?.[1] || "0") };
        } catch { return null; }
      })(),
      /* 16: emergency brake (issue #744) */ getEmergencyBrake(),
    ]);

    // Issue #840: parse the raw probe fan-out into the normalized Health
    // Snapshot, then run the pure Health Assessment ruleset. The handler owns
    // only I/O (the fan-out above) and the wire-envelope projection below;
    // disk/mem parsing, the `recent` derivation, every diagnostic rule, and the
    // status/summary fold now live in src/health-diagnostics.ts.
    const snapshot = parseProbes(settled);
    const { diagnostics, status, summary } = assessHealth(snapshot);

    // Destructure the snapshot fields the wire envelope projects below. The
    // `cycle` probe (index 3) drives only the activeCycle block, which stays
    // here at the HTTP layer (out of scope per the issue — vestigial concern).
    const { health, svcProbes, sched, queueDepth, blCounts, patterns, reflCount, ovSearch, redisInfo, emergencyBrake, disk, mem, recent } = snapshot;
    const { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb } = snapshot.sysd;
    const cycle = (settled[3] && settled[3].status === "fulfilled" ? (settled[3] as any).value : null) || {};

    const fmtUp = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };

    let activeCycle = null;
    if (cycle.status === "running" && cycle.cycleId) {
      const sa = cycle.startedAt || cycle.tasks?.[0]?.startedAt;
      const dur = sa ? Date.now() - new Date(sa).getTime() : 0;
      activeCycle = { id: cycle.cycleId, status: cycle.status, startedAt: sa, durationMs: dur, durationHuman: dur > 60000 ? `${Math.round(dur / 60000)}m ${Math.round((dur % 60000) / 1000)}s` : `${Math.round(dur / 1000)}s`, tasks: (cycle.tasks || []).map(t => ({ id: t.taskId || t.id, title: t.title, state: t.state || t.status })) };
    }

    res.json({
      status, summary, checkedAt,
      services: {
        orchestrator: { status: health.status === "ok" ? "running" : health.status, uptime: health.uptime, uptimeHuman: fmtUp(health.uptime), cycle: health.cycle },
        redis: { status: health.redis ? "running" : "failed", memoryHuman: redisInfo?.memoryHuman || null, connectedClients: redisInfo?.connectedClients || null, uptimeSeconds: redisInfo?.uptimeSeconds || null },
        scheduler: { status: sched.running ? "running" : (sched.consecutiveErrors >= 5 ? "failed" : "idle"), intervalHuman: sched.intervalHuman, cyclesRun: sched.cyclesRun, cyclesMerged: sched.cyclesMerged || 0, cyclesFailed: sched.cyclesFailed || 0, mergeRate: sched.mergeRate || 0, consecutiveErrors: sched.consecutiveErrors, lastError: sched.lastError, lastCycleAt: sched.lastCycleAt, research: { lastResearchAt: sched.research?.lastResearchAt || null } },
        vikingdb: svcProbes.vikingdb, openviking: svcProbes.openviking,
      },
      activeCycle,
      // Issue #744: emergency-brake state alongside the kill switch — both are
      // operator-controlled merge/cycle gates the dashboard surfaces.
      // recentMetrics projects only the rate fields the wire contract has
      // always carried — the new raw counts (mergedN/noTaskN/revertN) on the
      // snapshot's `recent` are for rule guards, not the HTTP envelope.
      pipeline: { queueDepth, backlogCounts: blCounts, recentMetrics: { cycleCount: recent.cycleCount, mergeRate: recent.mergeRate, failedRate: recent.failedRate, noTaskRate: recent.noTaskRate, revertRate: recent.revertRate, avgDurationMs: recent.avgDurationMs, avgDurationHuman: recent.avgDurationHuman }, killSwitch: health.status === "killed", emergencyBrake },
      infrastructure: { disk, memory: mem, systemd: { orchestrator: sysdOrch, watchdog: sysdWatch, targetWeb: sysdWeb } },
      intelligence: { patterns, reflections: reflCount, ovSearch },
      diagnostics,
    });
  });

  // GET /recommendations (operator action items) was extracted to
  // createRecommendationsRouter in src/api/recommendations.ts (issue #1322).
  // The public /api/recommendations path is unchanged — that router mounts
  // prefix-less in src/api.ts, same as this one.

  return router;
}
