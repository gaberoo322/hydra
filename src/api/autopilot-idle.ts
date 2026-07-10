/**
 * Autopilot idle-diagnostics HTTP surface (issue #889, now-console-2 / PRD #887).
 *
 *   GET /api/autopilot/idle-diagnostics → AutopilotIdleDiagnosticsResponse
 *
 * The data behind an IDLE verdict on the Now Console: *why* is the Pace Gate
 * (ADR-0021) not launching a `hydra-autopilot` run right now? This route joins
 * the three live facts the Gate's own admission check consults each ~15-min
 * tick (`scripts/autopilot/pace-gate.sh`) and projects them into one verdict
 * (`blockedBy`) plus the numeric reasons behind it.
 *
 * The route is a thin adapter — like `now-page.ts`, every external read is an
 * overridable `deps` reader so tests stub the eligibility projection and the
 * autopilot lifecycle without a tracker scan, Redis, or the on-disk state file.
 *
 * Never-throw contract (ADR convention; AC #3): an unreachable eligibility
 * source or a missing run yields SAFE DEFAULTS plus a logged `console.error`,
 * NOT a 500. The only non-200 is a 400 `schema-validation-failed` for a
 * malformed query (AC #4).
 */

import { Router } from "express";

import {
  AutopilotIdleDiagnosticsQuerySchema,
  type AutopilotIdleDiagnosticsResponse,
  type IdleBlockedBy,
  type IdlePace,
  type IdleAutopilotLiveness,
} from "../schemas/autopilot-idle.ts";

import {
  getUsage as defaultGetUsage,
  projectEligibilityView as defaultProjectEligibilityView,
  type EligibilityView,
} from "../cost/index.ts";
import { getAutopilotStatusSnapshot } from "../autopilot/status.ts";

// Re-surface the canonical pacing-view type (issue #3108) so this route's own
// consumers (deps typing, tests) keep importing it from here — the type is
// OWNED by the Cost module now, no longer re-declared locally.
export type { EligibilityView } from "../cost/index.ts";

// ---------------------------------------------------------------------------
// Sub-source readers (all overridable for tests)
// ---------------------------------------------------------------------------

interface EligibilityReader {
  (): Promise<EligibilityView>;
}

interface AutopilotLivenessReader {
  (): Promise<IdleAutopilotLiveness>;
}

export interface AutopilotIdleRouterDeps {
  /**
   * Reader for the usage-eligibility projection. Defaults to a thin call
   * into the Cost Module (`getUsage` → `projectEligibility`). A REJECTED
   * promise is treated as "endpoint-error" (the Gate's fail-safe state),
   * NOT a 500.
   */
  readEligibility?: EligibilityReader;
  /**
   * Reader for the dead-pid-swept autopilot lifecycle (issue #888). Defaults
   * to `autopilot/runs.getCurrentLifecycle()`. A REJECTED promise degrades to
   * the `idle` safe default.
   */
  readAutopilotLiveness?: AutopilotLivenessReader;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Pace Gate cadence in seconds (systemd `OnUnitActiveSec`, ~15 min). Used to
   * compute the coarse `nextPaceGateCheck` upper bound. Defaults to
   * `HYDRA_PACE_GATE_INTERVAL_SECONDS` env or 900s.
   */
  paceGateIntervalSeconds?: number;
}

// ---------------------------------------------------------------------------
// Pure verdict derivation
// ---------------------------------------------------------------------------

/**
 * Derive the single launch-blocking verdict with the SAME precedence the Pace
 * Gate applies (`pace-gate.sh`):
 *
 *   1. A run is already live           → "running"   (the Gate never stacks).
 *   2. The eligibility source is down  → "endpoint-error" (Gate fails safe).
 *   3. The 5h emergency-stop tripped   → "emergency-stop".
 *   4. Burn is ahead of the curve      → "pacing-ahead".
 *   5. Otherwise                       → null (eligible — would launch).
 *
 * Pure (no I/O, no clock) so the route and tests can pin it.
 */
export function deriveBlockedBy(input: {
  autopilotAlive: boolean;
  eligibilityReachable: boolean;
  emergencyStop: boolean;
  paceState: "behind" | "on" | "ahead";
}): IdleBlockedBy {
  if (input.autopilotAlive) return "running";
  if (!input.eligibilityReachable) return "endpoint-error";
  if (input.emergencyStop) return "emergency-stop";
  if (input.paceState === "ahead") return "pacing-ahead";
  return null;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

const IDLE_LIVENESS_DEFAULT: IdleAutopilotLiveness = {
  alive: false,
  state: "idle",
  runId: null,
  termReason: null,
  endedEpoch: null,
};

export function createAutopilotIdleRouter(deps: AutopilotIdleRouterDeps = {}) {
  const router = Router();
  const readEligibility = deps.readEligibility ?? defaultReadEligibility;
  const readLiveness = deps.readAutopilotLiveness ?? defaultReadAutopilotLiveness;
  const clock = deps.now ?? (() => new Date());
  const paceGateIntervalSeconds =
    deps.paceGateIntervalSeconds ?? defaultPaceGateIntervalSeconds();

  router.get("/autopilot/idle-diagnostics", async (req, res) => {
    const parsed = AutopilotIdleDiagnosticsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    try {
      const [eligSettled, livenessSettled] = await Promise.allSettled([
        readEligibility(),
        readLiveness(),
      ]);

      // Eligibility — a rejected read is the Gate's fail-safe "blind to usage"
      // state, surfaced as `endpoint-error`. Use neutral pacing numerics.
      const eligibilityReachable = eligSettled.status === "fulfilled";
      if (!eligibilityReachable) {
        console.error(
          `[autopilot/idle-diagnostics] eligibility read failed (never-throw → endpoint-error): ${
            (eligSettled as PromiseRejectedResult).reason?.message ||
            (eligSettled as PromiseRejectedResult).reason
          }`,
        );
      }
      const elig: EligibilityView | null = eligibilityReachable
        ? eligSettled.value
        : null;

      // Liveness — a rejected read degrades to the idle safe default.
      const liveness: IdleAutopilotLiveness =
        livenessSettled.status === "fulfilled"
          ? livenessSettled.value
          : IDLE_LIVENESS_DEFAULT;
      if (livenessSettled.status === "rejected") {
        console.error(
          `[autopilot/idle-diagnostics] autopilot-liveness read failed (never-throw → idle): ${livenessSettled.reason?.message || livenessSettled.reason}`,
        );
      }

      const paceState = elig?.paceState ?? "on";
      const emergencyStop = elig?.emergencyStop ?? false;

      const blockedBy = deriveBlockedBy({
        autopilotAlive: liveness.alive,
        eligibilityReachable,
        emergencyStop,
        paceState,
      });

      const pace: IdlePace = {
        state: paceState,
        targetPercent: elig?.targetPercent ?? 0,
        sinceResetPercent: elig?.sinceResetPercent ?? 0,
        anchor: elig?.anchor ?? null,
      };

      const body: AutopilotIdleDiagnosticsResponse = {
        isEligible: blockedBy === null,
        blockedBy,
        calibrated: elig?.calibrated ?? false,
        emergencyStop,
        percentLast5h: elig?.percentLast5h ?? 0,
        pace,
        autopilot: liveness,
        nextPaceGateCheck: estimateNextPaceGateCheck(clock(), paceGateIntervalSeconds),
        generatedAt: clock().toISOString(),
      };
      return res.json(body);
    } catch (err: any) {
      // Defensive: the body above is allSettled-guarded and should never
      // throw, but honour the never-throw contract belt-and-braces — log and
      // return a safe-default payload rather than a 500.
      console.error(
        `[autopilot/idle-diagnostics] handler threw despite never-throw contract: ${err?.message || err}`,
      );
      const safe: AutopilotIdleDiagnosticsResponse = {
        isEligible: false,
        blockedBy: "endpoint-error",
        calibrated: false,
        emergencyStop: false,
        percentLast5h: 0,
        pace: { state: "on", targetPercent: 0, sinceResetPercent: 0, anchor: null },
        autopilot: IDLE_LIVENESS_DEFAULT,
        nextPaceGateCheck: null,
        generatedAt: clock().toISOString(),
      };
      return res.json(safe);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// nextPaceGateCheck estimate
// ---------------------------------------------------------------------------

/**
 * Coarse upper-bound estimate of the next Pace Gate admission check. The Gate
 * is a systemd timer firing every `OnUnitActiveSec` (~15 min), so the next
 * check is *no later than* `now + interval`. We have no in-process handle on
 * the timer's last-fire, so this is deliberately an upper bound, not exact.
 *
 * Returns `null` when the interval is non-finite/non-positive — better a null
 * than a bogus timestamp.
 */
export function estimateNextPaceGateCheck(
  now: Date,
  intervalSeconds: number,
): string | null {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  return new Date(now.getTime() + intervalSeconds * 1000).toISOString();
}

function defaultPaceGateIntervalSeconds(): number {
  const raw = process.env.HYDRA_PACE_GATE_INTERVAL_SECONDS;
  if (!raw) return 900; // OnUnitActiveSec=15min
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 900;
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

async function defaultReadEligibility(): Promise<EligibilityView> {
  // Compose the snapshot read with the canonical pacing-view projection owned
  // by the Cost module (issue #3108) — the narrowing body no longer lives here.
  return defaultProjectEligibilityView(await defaultGetUsage());
}

/**
 * Default liveness reader — projects the shared AutopilotStatus snapshot's
 * lifecycle slice (issue #2673). `getCurrentLifecycle()` is the single source
 * of truth shared by all three autopilot read surfaces, so the liveness view is
 * derived through the seam (`getAutopilotStatusSnapshot()`), NOT a bespoke
 * `getCurrentLifecycle()` call. The idle route reads neither `eligibility` nor
 * `history` from the snapshot — eligibility stays its own reader (below), whose
 * REJECTION is load-bearing for the `endpoint-error` verdict; the seam's
 * never-throw eligibility slot would swallow that signal.
 */
async function defaultReadAutopilotLiveness(): Promise<IdleAutopilotLiveness> {
  const snap = await getAutopilotStatusSnapshot();
  const lc = snap.lifecycle;
  return {
    alive: lc.state === "running",
    state: lc.state,
    runId: lc.run_id,
    termReason: lc.term_reason,
    endedEpoch: lc.ended_epoch,
  };
}
