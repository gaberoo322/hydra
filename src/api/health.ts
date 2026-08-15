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
  // Issue #3626: the embed-backend Wake-on-LAN recovery is now an EXPLICIT
  // post-assembly step this route composes after collectProbeInputs — no longer a
  // side-effect buried in the fan-out. It is fire-and-return (returns the probe
  // record byte-for-byte unchanged) and never throws.
  // Issue #2605: the advisory deployed-SHA probe (the #734 deploy-drift backstop
  // read) + its 60s TTL cache were the last module-level mutable state in this
  // route file. They were extracted to the focused src/health/deployed-sha.ts
  // leaf (owns the cache singleton + gitExec seam behind an injectable deps bag,
  // like fan-out.ts/wol.ts) so this route becomes stateless. Zero behavioural
  // change — /health produces `deployedSha` exactly as before.
  getDeployedSha,
  // Issue #4008: the origin/master sibling probe — the second raw input of the
  // /health page's deploy-DRIFT axis. Same never-throw / TTL-cache contract as
  // getDeployedSha (see src/health/deployed-sha.ts).
  getRemoteMasterSha,
} from "../health/index.ts";
import type { PingableBus } from "../event-bus-seams.ts";
import type { ProbeInputs } from "../health/types.ts";
import type { EmergencyBrakeState } from "../redis/emergency-brake.ts";
import type { AutopilotPauseState } from "../redis/autopilot-pause.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const KILL_FILE = resolve(HYDRA_ROOT, ".kill");

/**
 * Injectable dependencies for {@link createHealthRouter} (issue #4008) — the
 * same factory-seam pattern as createTodayPageRouter. Every reader defaults to
 * the production binding, so existing one-arg callers are unchanged; a test
 * substitutes them to pin the trust fields (generatedAt / originMasterSha /
 * the ok flags) without a live git remote or a broken Redis.
 */
export interface HealthRouteDeps {
  /** Clock source (default `new Date`) — pins generatedAt in tests. */
  now?: () => Date;
  getDeployedSha?: () => Promise<string | null>;
  getRemoteMasterSha?: () => Promise<string | null>;
  getEmergencyBrake?: () => Promise<EmergencyBrakeState>;
  getAutopilotPaused?: () => Promise<AutopilotPauseState>;
  /** Deep-route probe fan-out (default the real collectProbeInputs). */
  collectProbeInputs?: (deps: { pingRedis: () => Promise<boolean> }) => Promise<ProbeInputs>;
}

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

export function createHealthRouter(eventBus: PingableBus, deps: HealthRouteDeps = {}) {
  const router = Router();
  // Issue #4008: the injectable production defaults (see HealthRouteDeps).
  const readDeployedSha = deps.getDeployedSha ?? getDeployedSha;
  const readRemoteMasterSha = deps.getRemoteMasterSha ?? getRemoteMasterSha;
  const readEmergencyBrake = deps.getEmergencyBrake ?? getEmergencyBrake;
  const readAutopilotPaused = deps.getAutopilotPaused ?? getAutopilotPaused;
  const collectInputs = deps.collectProbeInputs ?? collectProbeInputs;
  const now = deps.now ?? (() => new Date());

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
    const deployedSha = await readDeployedSha();
    // Issue #4008: advisory origin/master HEAD — the second raw input the
    // /health page's drift axis decomposes into (the CLIENT computes
    // deployedSha !== originMasterSha; the server never asserts a derived
    // drift boolean). null when unresolvable; never blocks /health. The probe
    // itself never throws by contract — this guard is the belt-and-braces
    // that keeps /health answering even if that contract is ever violated.
    let originMasterSha: string | null = null;
    try {
      originMasterSha = await readRemoteMasterSha();
    } catch (err: any) {
      console.error(`[API] /health originMasterSha read failed: ${err?.message ?? err}`);
    }

    // Issue #744: operator-only emergency-brake state. Fail-safe to
    // disengaged if Redis is unreachable — the brake read must never block
    // /health (the watchdog polls this surface). The brake itself still
    // holds; this read is purely advisory observability.
    // Issue #4008 (design-concept 2880e735 INV-5): the fail-safe fallback now
    // carries an additive sibling `ok:false` so an UNVERIFIED
    // `{engaged:false}` is distinguishable from a verified one on the wire —
    // the /health page renders the brake UNKNOWN (never a confident
    // "disengaged") when the read failed.
    let emergencyBrake: { engaged: boolean; since?: number; engagedBy?: string; ok: boolean } = { engaged: false, ok: false };
    try {
      emergencyBrake = { ...(await readEmergencyBrake()), ok: true };
    } catch (err: any) {
      console.error(`[API] /health emergency-brake read failed: ${err?.message ?? err}`);
    }

    // Issue #988: operator-only autopilot-pause state. A deliberate pause is a
    // HEALTHY/expected state — surfaced so hydra-doctor / the watchdog can
    // distinguish "operator paused autopilot on purpose" from "autopilot
    // wedged", and never report a pause as degraded. Fail-safe to not-paused
    // if Redis is unreachable; the read is purely advisory observability.
    // Issue #4008 (INV-5): same additive `ok` flag as the brake read above.
    let autopilotPause: { paused: boolean; since?: number; ok: boolean } = { paused: false, ok: false };
    try {
      autopilotPause = { ...(await readAutopilotPaused()), ok: true };
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
      // Issue #4008 (ADR-0034 §5 rule 4): machine-readable as-of timestamp so
      // the /health page renders an always-visible age per panel. /health
      // never carried checkedAt, so this is purely additive.
      generatedAt: now().toISOString(),
      // Issue #734: SHA the orchestrator is running from (deploy.sh leaves
      // $HYDRA_ROOT on master HEAD). Advisory — null/absent if git is
      // unavailable. The watchdog compares this against origin/master.
      deployedSha,
      // Issue #4008: origin/master HEAD from the sibling ls-remote probe.
      // Advisory — null when the remote is unreachable; the page's drift axis
      // renders UNKNOWN rather than guessing.
      originMasterSha,
      // Issue #744: emergency-brake state. `{engaged:false, ok:true}` when
      // verified disengaged; `{engaged:true, since, engagedBy, ok:true}` while
      // the operator holds the brake; `{engaged:false, ok:false}` when the
      // read itself failed (INV-5 — not-verified, never confident).
      emergencyBrake,
      // Issue #988: autopilot-pause state. `{paused:false, ok:true}` when
      // verified not-paused; `{paused:true, since, ok:true}` while the
      // operator has paused autopilot (a HEALTHY/expected state — NOT
      // degraded); `{paused:false, ok:false}` when the read itself failed.
      autopilotPause,
    });
  });

  // The /health/services, /health/skills and /health/source-index routes were
  // removed with OpenViking: services probed only the OV stack (vikingdb /
  // openviking / embed-backend), skills surfaced the OV skill-catalog
  // registration state (#1968), and source-index compared the dedup cache
  // against OV's indexed source resources (#2267).

  // GET /health/deep — Comprehensive health with diagnostic reasoning
  router.get("/health/deep", async (req, res) => {
    // Issue #4008: stamped through the injectable clock (production: new
    // Date) so a test can pin generatedAt/checkedAt deterministically.
    const checkedAt = now().toISOString();
    // Issue #2089: the 19-probe fan-out + the positional-to-named assembly is
    // owned by the Health Probe Fan-out Module (src/health/fan-out.ts). The
    // handler hands it the eventBus ping (the only request-scoped dep) and
    // receives a named ProbeInputs record — no Promise.allSettled positional
    // array or integer subscript crosses into this route file.
    const probeInputs = await collectInputs({
      pingRedis: async () => {
        try { await eventBus.publisher.ping(); return true; } catch { /* intentional: ping failure reflected via redisOk=false */ return false; }
      },
    });

    // Issue #3626: fire the embed-backend Wake-on-LAN recovery EXPLICITLY here,
    // after the fan-out has assembled the probe record — no longer a side-effect
    // buried in the enumeration. It reads the assembled
    // serviceProbes['embed-backend'] result, fires a best-effort WoL wake through
    // the process-lifetime gate (getWolGates().embed) if the backend read failed,
    // and writes the UNCHANGED result back (fire-and-return): the record parseProbes
    // sees is byte-for-byte identical, so the #2131 down-alert still fires this
    // tick and recovery is observed on the next scheduled tick — exactly as before.
    // NEVER throws; never blocks the response waiting for the box to POST.

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
    // the fan-out (moved to src/health/fan-out.ts). The projection took a
    // `probeInputs` argument only to read the two OV-quality rollups
    // (ovSearchWindow/knowledgeContext) that parseProbes did not consume; both
    // were removed with OpenViking, so it now projects from the snapshot alone.
    //
    // Issue #4008 (design-concept 2880e735 INV-1): the response now ALSO
    // carries `generatedAt` — the machine-readable as-of the /health page's
    // panels derive their always-visible age from. It aliases checkedAt (same
    // instant), and checkedAt is KEPT, not removed — every existing consumer
    // keeps working; this is an additive sibling field.
    res.json({
      ...projectHealthDeepResponse(snapshot, diagnostics, status, summary, activeCycle, checkedAt),
      generatedAt: checkedAt,
    });
  });

  // GET /recommendations (operator action items) was extracted to
  // createRecommendationsRouter in src/api/recommendations.ts (issue #1322).
  // The public /api/recommendations path is unchanged — that router mounts
  // prefix-less in src/api.ts, same as this one.

  return router;
}
