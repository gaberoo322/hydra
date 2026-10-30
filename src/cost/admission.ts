/**
 * src/cost/admission.ts — the launcher's admission ladder as a pure fold
 * (issue #5101, ADR-0042 layer L3).
 *
 * `scripts/autopilot/pace-gate.sh` walks an ordered ladder of arms over the
 * composed `/api/usage/eligibility` verdict and records one `record_tick`
 * reason per tick. This module is the TypeScript home of that ladder: the first
 * argument is the COMPOSED verdict ({@link UsageEligibility}), the second is the
 * handful of facts only the launcher host knows. The fold is read-only — it
 * never mutates or re-derives `allow`, `shed`, `paceState` or any `reasons.*`
 * value, so the launcher-only arms (pace-ahead, five-hour-headroom,
 * post-quota-cooldown, workless-backoff) coexist with `allow=true`.
 *
 * The bash gate keeps owning the transport fail-safes (curl/jq missing,
 * unreachable/unparseable/invalid body) and the token-refresh nudge; those
 * reasons live in the vocabulary so the watchdog map and the drift test cover
 * the whole tick vocabulary, but {@link decideAdmission} never returns them.
 *
 * Pure: no `Date.now()` (`nowMs` is injected), no env, no logger.
 */

import type { UsageEligibility } from "./eligibility.ts";

/**
 * The whole tick-reason vocabulary (21 reasons); decideAdmission owns ladder
 * order for the ones it returns. `test/admission.test.mts` drift-guards this
 * tuple against pace-gate.sh's literal `record_tick` calls.
 *
 * Bash-emitted literals (decideAdmission never returns them), the only
 * `record_tick "<literal>"` calls left in pace-gate.sh after #5102:
 * `curl-missing`, `jq-missing`, `eligibility-unreachable`,
 * `eligibility-unparseable`, `allow-invalid` (the admission object the gate
 * consumes is missing or malformed — post-#5102) and `token-refresh-nudge`
 * (moves into the verdict in #5103). Every other reason reaches bash only as
 * the typed `.admission.reason` and is recorded verbatim.
 */
export const ADMISSION_REASONS = [
  "already-running-service",
  "already-running-pid",
  "curl-missing",
  "jq-missing",
  "eligibility-unreachable",
  "eligibility-unparseable",
  "allow-invalid",
  "paused",
  "session-blocked",
  "emergency-stop",
  "weekly-emergency-stop",
  "extra-usage-armed",
  "meter-unavailable",
  "token-refresh-nudge",
  "allow-false",
  "pace-ahead",
  "five-hour-headroom",
  "post-quota-cooldown",
  "workless-backoff",
  "eligible-exec",
  "eligible-launch",
] as const;

export type AdmissionReason = (typeof ADMISSION_REASONS)[number];

export type AdmissionClass =
  | "already-running"
  | "fail-safe"
  | "deliberate-skip"
  | "launch";

/** The class pace-gate.sh records alongside each reason. */
export const ADMISSION_CLASS_OF: Readonly<Record<AdmissionReason, AdmissionClass>> = {
  "already-running-service": "already-running",
  "already-running-pid": "already-running",
  "curl-missing": "fail-safe",
  "jq-missing": "fail-safe",
  "eligibility-unreachable": "fail-safe",
  "eligibility-unparseable": "fail-safe",
  "allow-invalid": "fail-safe",
  paused: "deliberate-skip",
  "session-blocked": "deliberate-skip",
  "emergency-stop": "deliberate-skip",
  "weekly-emergency-stop": "deliberate-skip",
  "extra-usage-armed": "deliberate-skip",
  "meter-unavailable": "fail-safe",
  "token-refresh-nudge": "fail-safe",
  "allow-false": "deliberate-skip",
  "pace-ahead": "deliberate-skip",
  "five-hour-headroom": "deliberate-skip",
  "post-quota-cooldown": "deliberate-skip",
  "workless-backoff": "deliberate-skip",
  "eligible-exec": "launch",
  "eligible-launch": "launch",
};

/** Facts only the launcher host knows. */
export interface AdmissionContext {
  nowMs: number;
  mode: "timer" | "exec";
  serviceActive: boolean;
  pidAlive: boolean;
}

export interface AdmissionVerdict {
  admit: boolean;
  reason: AdmissionReason;
  class: AdmissionClass;
  /** Informational: overage armed but policy=allow, so the tick still admits. */
  note: "extra-usage-armed-not-blocking" | null;
}

/**
 * True iff `iso` parses to a finite instant strictly after `nowMs`. Null,
 * empty, unparseable or past instants are not future, so the arm falls through
 * (launches) — the bash `date -d … || echo ''` + `-gt NOW` behaviour.
 */
export function isFutureInstant(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > nowMs;
}

function verdict(
  reason: AdmissionReason,
  admit = false,
  note: AdmissionVerdict["note"] = null,
): AdmissionVerdict {
  return { admit, reason, class: ADMISSION_CLASS_OF[reason], note };
}

/**
 * Walk pace-gate.sh's ladder in its exact order; the first matching arm wins.
 */
export function decideAdmission(
  eligibility: UsageEligibility,
  ctx: AdmissionContext,
): AdmissionVerdict {
  const r = eligibility.reasons;
  if (ctx.mode === "timer" && ctx.serviceActive) return verdict("already-running-service");
  if (ctx.pidAlive) return verdict("already-running-pid");
  if (r.paused) return verdict("paused");
  if (isFutureInstant(r.sessionBlockedUntil, ctx.nowMs)) return verdict("session-blocked");
  if (r.emergencyStop) return verdict("emergency-stop");
  if (r.weeklyEmergencyStop) return verdict("weekly-emergency-stop");
  // Keyed off extraUsageBlocking, NEVER extraUsageArmed (policy=allow leaves
  // blocking false while armed is true).
  if (r.extraUsageBlocking) return verdict("extra-usage-armed");
  if (r.meterUnavailable) return verdict("meter-unavailable");
  if (eligibility.allow === false) return verdict("allow-false");
  if (eligibility.paceState === "ahead") return verdict("pace-ahead");
  if (r.fiveHourThrottleShed) return verdict("five-hour-headroom");
  if (isFutureInstant(r.postQuotaUntil, ctx.nowMs)) return verdict("post-quota-cooldown");
  if (isFutureInstant(r.worklessUntil, ctx.nowMs)) return verdict("workless-backoff");
  return verdict(
    ctx.mode === "exec" ? "eligible-exec" : "eligible-launch",
    true,
    r.extraUsageArmed ? "extra-usage-armed-not-blocking" : null,
  );
}
