import { Router } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { getEmergencyBrake } from "../redis/emergency-brake.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
// Issue #840: the pure Health Assessment ruleset — disk/mem parsing, the
// `recent` derivation, the ~27 diagnostic rules, and the status/summary fold
// all live behind this seam. The handler keeps only I/O + wire projection.
// Issue #2039: the wire projection (projectHealthDeepResponse) split out to the
// sibling src/health-wire.ts (the data-OUT leg) so the data-IN parse pipeline
// is testable in isolation; parseProbes/assessHealth stay on the parse seam.
import { parseProbes, assessHealth } from "../health-diagnostics.ts";
import { projectHealthDeepResponse } from "../health-wire.ts";
// Issue #2089: the GET /health/deep probe fan-out (the 19-probe
// `Promise.allSettled([...])` enumeration + the integer-subscript legend + the
// positional-to-named `assembleProbeInputs` mapping) was extracted to the Health
// Probe Fan-out Module (src/health-fan-out.ts). createHealthRouter now calls
// `collectProbeInputs(deps)` and receives a named ProbeInputs record — no integer
// subscript crosses into this route file. Adding a probe is a one-file edit in
// the fan-out module. The /health and /health/services routes keep their own
// inline probes; only the deep fan-out delegated.
import { collectProbeInputs } from "../health-fan-out.ts";
// Issue #1980: probeService/probeOv and the ServiceProbeResult wire shape live in
// the focused ServiceProbe Adapter Seam (src/health-probe.ts). The /health/services
// route below still composes the three canonical probes inline.
import { probeService, probeOv, probeEmbedBackend } from "../health-probe.ts";
import { assessSkillCatalog } from "../health-skill-catalog.ts";
// Issue #1968: the in-process OV skill-catalog state, so /api/health/skills can
// surface the silent empty-catalog failure (startup skill registration losing
// all four skills to OpenViking timeouts) that no health surface reflected.
import { getSkillCatalogState } from "../knowledge-base/skill-registration.ts";
import type { PingableBus } from "./event-bus-types.ts";

import { gitExec } from "../github/git.ts";
import { isGhFailure } from "../github/exec.ts";

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
// probe live in the focused ServiceProbe Adapter Seam (src/health-probe.ts) so
// the failed/running classification lives in ONE named home, unit-testable
// without Express (see test/health-probe.test.mts) and importable by non-route
// callers. The /health/services route below composes the three canonical probes
// inline; the /health/deep fan-out is owned by the Health Probe Fan-out Module
// (src/health-fan-out.ts, issue #2089).

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
    // Issue #2013: the embed-backend probe samples OV's dense-embedding backend
    // specifically (the surface that was stale-but-invisible during #1921) —
    // distinct from the openviking app-liveness key above. Routes through the
    // same OV Request Adapter (no new URL/auth).
    const [vikingdb, openviking, embedBackend] = await Promise.all([
      probeService("http://localhost:5000/health"),
      probeOv(),
      probeEmbedBackend(),
    ]);

    res.json({ vikingdb, openviking, "embed-backend": embedBackend });
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
    // Issue #2089: the 19-probe fan-out + the positional-to-named assembly is
    // owned by the Health Probe Fan-out Module (src/health-fan-out.ts). The
    // handler hands it the eventBus ping (the only request-scoped dep) and
    // receives a named ProbeInputs record — no Promise.allSettled positional
    // array or integer subscript crosses into this route file.
    const probeInputs = await collectProbeInputs({
      pingRedis: async () => {
        try { await eventBus.publisher.ping(); return true; } catch { /* intentional: ping failure reflected via redisOk=false */ return false; }
      },
    });

    // Issue #840: parse the named probe record into the normalized Health
    // Snapshot, then run the pure Health Assessment ruleset. The handler owns
    // only I/O coordination (the fan-out call above) and the wire-envelope
    // projection below; disk/mem parsing, the `recent` derivation, every
    // diagnostic rule, and the status/summary fold live in
    // src/health-diagnostics.ts.
    const snapshot = parseProbes(probeInputs);
    const { diagnostics, status, summary } = assessHealth(snapshot);

    // The in-process cycle was removed in PR-3 (issue #383): the deep fan-out's
    // index-3 cycle probe is a constant `{status:"idle"}`, so a running
    // activeCycle is never produced. The block is kept null-valued (out of scope
    // per issue #1513 — a vestigial concern) and handed to the pure projection.
    const activeCycle = null;

    // Issue #1513: the wire-projection half (the former inline res.json block)
    // is now the pure, unit-tested projectHealthDeepResponse in
    // src/health-wire.ts (issue #2039: split out of health-diagnostics.ts as the
    // data-OUT leg) — the third leg of the Snapshot pipeline alongside
    // parseProbes/assessHealth (#840). Issue #2089: the handler no longer owns
    // the fan-out (moved to src/health-fan-out.ts); it forwards the named
    // probeInputs record, from which the projection reads ovSearchWindow/
    // knowledgeContext (indices 17/18) that parseProbes does not consume.
    res.json(projectHealthDeepResponse(snapshot, diagnostics, status, summary, activeCycle, checkedAt, probeInputs));
  });

  // GET /recommendations (operator action items) was extracted to
  // createRecommendationsRouter in src/api/recommendations.ts (issue #1322).
  // The public /api/recommendations path is unchanged — that router mounts
  // prefix-less in src/api.ts, same as this one.

  return router;
}
