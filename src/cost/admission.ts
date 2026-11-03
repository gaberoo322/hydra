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
 * unreachable/unparseable/invalid body); those reasons live in the vocabulary
 * so the watchdog map and the drift test cover the whole tick vocabulary, but
 * {@link decideAdmission} never returns them. The OAuth refresh nudge (#4843)
 * and the launch-model fallback (#4585) are decided HERE (#5103): the verdict
 * carries `shouldNudgeOauth` and `launchModel`, and bash only performs the
 * effects (stamp + `claude -p` refresh, `--model` exec args) they name.
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
 * `record_tick "<literal>"` calls left in pace-gate.sh after #5103:
 * `curl-missing`, `jq-missing`, `eligibility-unreachable`,
 * `eligibility-unparseable` and `allow-invalid` (the admission object the gate
 * consumes is missing or malformed). Every other reason — including
 * `token-refresh-nudge` — reaches bash only as the typed `.admission.reason`
 * and is recorded verbatim.
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
  /**
   * Epoch-ms of the credentials file's `claudeAiOauth.expiresAt`, or null when
   * unreadable (read server-side, #5103). Drives the OAuth refresh nudge.
   */
  credentialsExpiresAtMs: number | null;
  /**
   * Epoch-SECONDS content of the launcher's nudge stamp file, or null when
   * absent / non-numeric (a launcher fact like `pidAlive`, #5103).
   */
  nudgeLastAtS: number | null;
  /** The launch-model pair (the launcher's own env pair, #5103). */
  primaryModel: string;
  fallbackModel: string;
}

export interface AdmissionVerdict {
  admit: boolean;
  reason: AdmissionReason;
  class: AdmissionClass;
  /** Informational: overage armed but policy=allow, so the tick still admits. */
  note: "extra-usage-armed-not-blocking" | null;
  /**
   * #5103: true iff the meter is dark because the OAuth token is expired /
   * expiring and the 30-minute nudge rate limit allows another one. The
   * `reason` is then `token-refresh-nudge`; bash performs the refresh effect.
   */
  shouldNudgeOauth: boolean;
  /** #5103/#4585: the model the exec branch launches on (fallback while the
   *  model-exhaustion flag is future, else primary). Present on EVERY verdict. */
  launchModel: string;
  primaryModel: string;
  fallbackModel: string;
  modelFallbackReason: "out-of-credits" | null;
}

/** The token is nudged when it expires within this window (#4843). */
const NUDGE_EXPIRY_WINDOW_MS = 600_000;
/** At most one nudge per this many seconds (#4843). */
const NUDGE_MIN_INTERVAL_S = 1800;

/** #4843 nudge rule: token expired / expiring within 10 min AND rate limit open. */
function isNudgeDue(ctx: AdmissionContext): boolean {
  const exp = ctx.credentialsExpiresAtMs;
  if (exp === null || !Number.isFinite(exp)) return false;
  if (exp > ctx.nowMs + NUDGE_EXPIRY_WINDOW_MS) return false;
  if (ctx.nudgeLastAtS === null) return true;
  const ageS = Math.floor(ctx.nowMs / 1000) - ctx.nudgeLastAtS;
  // A negative age (clock skew / future stamp) counts as due, as bash did.
  return ageS < 0 || ageS >= NUDGE_MIN_INTERVAL_S;
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
  models: Pick<
    AdmissionVerdict,
    "launchModel" | "primaryModel" | "fallbackModel" | "modelFallbackReason"
  >,
  admit = false,
  note: AdmissionVerdict["note"] = null,
  shouldNudgeOauth = false,
): AdmissionVerdict {
  return {
    admit,
    reason,
    class: ADMISSION_CLASS_OF[reason],
    note,
    shouldNudgeOauth,
    ...models,
  };
}

/**
 * Walk pace-gate.sh's ladder in its exact order; the first matching arm wins.
 */
export function decideAdmission(
  eligibility: UsageEligibility,
  ctx: AdmissionContext,
): AdmissionVerdict {
  const r = eligibility.reasons;
  // #5103/#4585: the launch model. Absent, past or unparseable flag -> primary
  // (fail-safe: a corrupt flag can never wedge the loop on the fallback).
  const exhausted = isFutureInstant(r.fableExhaustedUntil, ctx.nowMs);
  const models = {
    launchModel: exhausted ? ctx.fallbackModel : ctx.primaryModel,
    primaryModel: ctx.primaryModel,
    fallbackModel: ctx.fallbackModel,
    modelFallbackReason: exhausted ? ("out-of-credits" as const) : null,
  };
  const v = (reason: AdmissionReason) => verdict(reason, models);
  if (ctx.mode === "timer" && ctx.serviceActive) return v("already-running-service");
  if (ctx.pidAlive) return v("already-running-pid");
  if (r.paused) return v("paused");
  if (isFutureInstant(r.sessionBlockedUntil, ctx.nowMs)) return v("session-blocked");
  if (r.emergencyStop) return v("emergency-stop");
  if (r.weeklyEmergencyStop) return v("weekly-emergency-stop");
  // Keyed off extraUsageBlocking, NEVER extraUsageArmed (policy=allow leaves
  // blocking false while armed is true).
  if (r.extraUsageBlocking) return v("extra-usage-armed");
  if (r.meterUnavailable) {
    // #5103: a dark meter with an expired / expiring token is a deadlock
    // (#4843); the nudge arm is only reachable here, after every earlier arm.
    if (isNudgeDue(ctx)) return verdict("token-refresh-nudge", models, false, null, true);
    return v("meter-unavailable");
  }
  if (eligibility.allow === false) return v("allow-false");
  if (eligibility.paceState === "ahead") return v("pace-ahead");
  if (r.fiveHourThrottleShed) return v("five-hour-headroom");
  if (isFutureInstant(r.postQuotaUntil, ctx.nowMs)) return v("post-quota-cooldown");
  if (isFutureInstant(r.worklessUntil, ctx.nowMs)) return v("workless-backoff");
  return verdict(
    ctx.mode === "exec" ? "eligible-exec" : "eligible-launch",
    models,
    true,
    r.extraUsageArmed ? "extra-usage-armed-not-blocking" : null,
  );
}
