/**
 * Autopilot idle-diagnostics aggregator leaf (issue #3116, arch-scan #788).
 *
 * The pure data-assembly behind an IDLE verdict on the Now Console: *why* is
 * the Pace Gate (ADR-0021) not launching a `hydra-autopilot` run right now?
 * This leaf joins the two live sub-reads the Gate's own admission check
 * consults each ~15-min tick (`scripts/autopilot/pace-gate.sh`) and projects
 * them into one verdict (`blockedBy`) plus the numeric reasons behind it.
 *
 * Extracted from the `GET /autopilot/idle-diagnostics` route handler
 * (`src/api/autopilot-idle.ts`). This is the PURE composition layer: every
 * external touchpoint is injected via the resolved `IdleDiagnosticsDeps` bag —
 * no express, no Cost value import, no autopilot/status value import here. A
 * pure-composition caller therefore no longer transitively pulls express +
 * Cost + autopilot-status. That import-graph delta IS the deepening.
 *
 * Never-throw contract (ADR convention): the fan-out is `Promise.allSettled`;
 * a rejected sub-read logs a fail-loud `console.error` and degrades its slice
 * to a safe default. The composition never throws.
 *
 * Reachability is load-bearing: a REJECTED eligibility read yields
 * `blockedBy=endpoint-error` (the Pace Gate fail-safe). The aggregator
 * inspects `eligSettled.status === "fulfilled"` DIRECTLY — it does NOT route
 * eligibility through `settle.ts`'s `settledOrNull`, which would collapse the
 * rejected/fulfilled-null distinction onto one value and lose that signal.
 * Liveness, which has a clean total fallback, uses `settledOr`.
 */

import {
  type AutopilotIdleDiagnosticsResponse,
  type IdleBlockedBy,
  type IdlePace,
  type IdleAutopilotLiveness,
} from "../schemas/autopilot-idle.ts";
import type { EligibilityView } from "../cost/index.ts";

import { settledOr } from "./settle.ts";

// ---------------------------------------------------------------------------
// Resolved deps bag (the pure boundary)
// ---------------------------------------------------------------------------

/**
 * The RESOLVED (non-optional) deps bag the aggregator composes over. The route
 * layer owns the IO-defaulting (readers already defaulted, clock already a
 * function, interval already a number) and hands this fully-resolved bag in —
 * keeping default-resolution in the route and pure composition in the leaf.
 */
export interface IdleDiagnosticsDeps {
  /** Reader for the usage-eligibility projection. A REJECTED promise is
   * treated as "endpoint-error" (the Gate's fail-safe state), NOT a throw. */
  readEligibility: () => Promise<EligibilityView>;
  /** Reader for the dead-pid-swept autopilot lifecycle. A REJECTED promise
   * degrades to the `idle` safe default. */
  readAutopilotLiveness: () => Promise<IdleAutopilotLiveness>;
  /** Clock. */
  now: () => Date;
  /** Pace Gate cadence in seconds (systemd `OnUnitActiveSec`, ~15 min). */
  paceGateIntervalSeconds: number;
}

// ---------------------------------------------------------------------------
// Safe default for the liveness slice
// ---------------------------------------------------------------------------

export const IDLE_LIVENESS_DEFAULT: IdleAutopilotLiveness = {
  alive: false,
  state: "idle",
  runId: null,
  termReason: null,
  endedEpoch: null,
};

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

// ---------------------------------------------------------------------------
// Pure composition
// ---------------------------------------------------------------------------

/**
 * Assemble the idle-diagnostics response from the two injected sub-reads. Pure:
 * every external touchpoint arrives via `deps`; the body is `allSettled`-guarded
 * and never throws.
 *
 * Eligibility rejection is hand-folded (NOT routed through `settledOrNull`) so
 * the REJECTED bit survives as `eligibilityReachable=false` → `endpoint-error`.
 * Liveness rejection degrades to `IDLE_LIVENESS_DEFAULT` via `settledOr`.
 */
export async function getIdleDiagnostics(
  deps: IdleDiagnosticsDeps,
): Promise<AutopilotIdleDiagnosticsResponse> {
  const { readEligibility, readAutopilotLiveness, now, paceGateIntervalSeconds } =
    deps;

  const [eligSettled, livenessSettled] = await Promise.allSettled([
    readEligibility(),
    readAutopilotLiveness(),
  ]);

  // Eligibility — a rejected read is the Gate's fail-safe "blind to usage"
  // state, surfaced as `endpoint-error`. Inspect `.status` DIRECTLY: routing
  // through settledOrNull would collapse rejected/fulfilled-null and lose the
  // load-bearing endpoint-error signal. Use neutral pacing numerics on failure.
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

  // Liveness — a rejected read degrades to the idle safe default. This slice
  // has a clean total fallback, so the shared settledOr fold is safe here.
  const liveness: IdleAutopilotLiveness = settledOr(
    livenessSettled,
    IDLE_LIVENESS_DEFAULT,
    "autopilot/idle-diagnostics/liveness",
  );

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

  return {
    isEligible: blockedBy === null,
    blockedBy,
    calibrated: elig?.calibrated ?? false,
    emergencyStop,
    percentLast5h: elig?.percentLast5h ?? 0,
    pace,
    autopilot: liveness,
    nextPaceGateCheck: estimateNextPaceGateCheck(now(), paceGateIntervalSeconds),
    generatedAt: now().toISOString(),
  };
}
