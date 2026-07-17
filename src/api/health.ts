import { Router } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { getEmergencyBrake } from "../redis/emergency-brake.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
// Issue #2123: the six health-* modules were collected into the src/health/
// subdirectory (probe fan-out → parse → rule-assess → project response). This
// route — the single external consumer — imports their public surface through
// the src/health/index.ts barrel (`../health`).
//
// Issue #840: the pure Health Assessment ruleset — disk/mem parsing, the
// `recent` derivation, the ~27 diagnostic rules, and the status/summary fold
// all live behind the parse seam (src/health/diagnostics.ts). The handler keeps
// only I/O + wire projection.
// Issue #2039: the wire projection (projectHealthDeepResponse) split out to the
// sibling src/health/wire.ts (the data-OUT leg) so the data-IN parse pipeline
// is testable in isolation; parseProbes/assessHealth stay on the parse seam.
// Issue #2089: the GET /health/deep probe fan-out (the 19-probe
// `Promise.allSettled([...])` enumeration + the integer-subscript legend + the
// positional-to-named `assembleProbeInputs` mapping) was extracted to the Health
// Probe Fan-out Module (src/health/fan-out.ts). createHealthRouter now calls
// `collectProbeInputs(deps)` and receives a named ProbeInputs record — no integer
// subscript crosses into this route file. Adding a probe is a one-file edit in
// the fan-out module. The /health and /health/services routes keep their own
// inline probes; only the deep fan-out delegated.
// Issue #1980: probeService/probeOv and the ServiceProbeResult wire shape live in
// the focused ServiceProbe Adapter Seam (src/health/probe.ts). The /health/services
// route below still composes the three canonical probes inline.
import {
  parseProbes,
  assessHealth,
  projectHealthDeepResponse,
  collectProbeInputs,
  probeService,
  probeOv,
  probeEmbedBackend,
  assessSkillCatalog,
  // Issue #2605: the advisory deployed-SHA probe (the #734 deploy-drift backstop
  // read) + its 60s TTL cache were the last module-level mutable state in this
  // route file. They were extracted to the focused src/health/deployed-sha.ts
  // leaf (owns the cache singleton + gitExec seam behind an injectable deps bag,
  // like fan-out.ts/wol.ts) so this route becomes stateless. Zero behavioural
  // change — /health produces `deployedSha` exactly as before.
  getDeployedSha,
} from "../health/index.ts";
// Issue #1968: the in-process OV skill-catalog state, so /api/health/skills can
// surface the silent empty-catalog failure (startup skill registration losing
// all four skills to OpenViking timeouts) that no health surface reflected.
import { getSkillCatalogState } from "../knowledge-base/skill-registration.ts";
// Issue #2267: read-only source-index freshness diagnostic. countSourceHashes()
// reads the durable dedup-cache size; probeOvSourceResourcesPresent() runs a
// search probe to see whether OpenViking still holds indexed source resources.
// Both are best-effort/never-throw. This route MUTATES NOTHING — the auto-clear
// repair lives in the lifecycle path (learning-lifecycle.ts), not the probe.
import { countSourceHashes } from "../redis/source-index.ts";
import { probeOvSourceResourcesPresent } from "../knowledge-base/indexer.ts";
import type { PingableBus } from "../event-bus-seams.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

// Issue #734 (deploy-drift backstop): the SHA the orchestrator is running from
// (advisory `git rev-parse HEAD` vs origin/master HEAD, cached 60s). Issue #2605:
// the probe + its cache singleton moved to the focused src/health/deployed-sha.ts
// leaf (imported via the ../health barrel as getDeployedSha) — this route file no
// longer holds any module-level mutable state.

// Issue #1324 + #1980: the plain-HTTP service probe and the OpenViking liveness
// probe live in the focused ServiceProbe Adapter Seam (src/health/probe.ts) so
// the failed/running classification lives in ONE named home, unit-testable
// without Express (see test/health-probe.test.mts) and importable by non-route
// callers. The /health/services route below composes the three canonical probes
// inline; the /health/deep fan-out is owned by the Health Probe Fan-out Module
// (src/health/fan-out.ts, issue #2089).

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
      // Issue #2277: surface the deferred (VLM-down) state so the operator can
      // tell a deliberate graceful degradation from the #1968 under-load empty.
      vlmDeferred: state.vlmDeferred,
      // Issue #3402: surface the second deferred mode — VLM up but OV's skills
      // handler load-gated — as a sibling flag so the operator can distinguish the
      // two deliberate degradations from each other and from the under-load empty.
      skillsDeferred: state.skillsDeferred,
      skills: state.skills,
      diagnostic: assessment.diagnostic,
    });
  });

  // GET /health/source-index — source-index freshness diagnostic (issue #2267)
  //
  // Surfaces the stale-cache failure where the durable source-hash dedup cache
  // (`hydra:knowledge:source-hashes`) claims full coverage but OpenViking was
  // reset out from under it, so agents search an empty knowledge base. READ-ONLY:
  // reports the cache size and an OV-truth probe (is any indexed source resource
  // present?), and folds them into a `stale` boolean — it performs ZERO mutation
  // (the auto-clear repair lives in the lifecycle path, not this probe). Operators
  // and watchdogs read this to confirm freshness after a deploy/OV bounce.
  //
  // stale := cachedSourceHashes > 0 AND ovSourceResourcesPresent == false.
  // Note the probe fails SAFE (errors report present), so `stale` is only ever
  // true on a conclusive empty-OV probe — never on a transient OV hiccup.
  router.get("/health/source-index", async (_req, res) => {
    const cachedSourceHashes = await countSourceHashes();
    const ovSourceResourcesPresent = await probeOvSourceResourcesPresent();
    const stale = cachedSourceHashes > 0 && !ovSourceResourcesPresent;
    res.json({
      status: stale ? "stale" : "ok",
      cachedSourceHashes,
      ovSourceResourcesPresent,
      stale,
      diagnostic: stale
        ? "Source-hash cache is populated but OpenViking holds no indexed source resources — OV was likely reset out from under the cache. The lifecycle detector clears the cache on the next restart to force a re-index (issue #2267)."
        : cachedSourceHashes === 0
          ? "Source-hash cache is empty (cold start); the indexer will populate it on the initial pass."
          : "Source index is fresh: cache claims coverage and OpenViking holds indexed source resources.",
    });
  });

  // GET /health/deep — Comprehensive health with diagnostic reasoning
  router.get("/health/deep", async (req, res) => {
    const checkedAt = new Date().toISOString();
    // Issue #2089: the 19-probe fan-out + the positional-to-named assembly is
    // owned by the Health Probe Fan-out Module (src/health/fan-out.ts). The
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
    // src/health/diagnostics.ts.
    const snapshot = parseProbes(probeInputs);
    const { diagnostics, status, summary } = assessHealth(snapshot);

    // The in-process cycle was removed in PR-3 (issue #383): the deep fan-out's
    // index-3 cycle probe is a constant `{status:"idle"}`, so a running
    // activeCycle is never produced. The block is kept null-valued (out of scope
    // per issue #1513 — a vestigial concern) and handed to the pure projection.
    const activeCycle = null;

    // Issue #1513: the wire-projection half (the former inline res.json block)
    // is now the pure, unit-tested projectHealthDeepResponse in
    // src/health/wire.ts (issue #2039: split out of health/diagnostics.ts as the
    // data-OUT leg) — the third leg of the Snapshot pipeline alongside
    // parseProbes/assessHealth (#840). Issue #2089: the handler no longer owns
    // the fan-out (moved to src/health/fan-out.ts); it forwards the named
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
