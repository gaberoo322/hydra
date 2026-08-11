/**
 * Pace-gate launch-flow telemetry Redis seam (issue #3845, epic #3844).
 *
 * `scripts/autopilot/pace-gate.sh` decides, on every ~15-min tick, whether to
 * launch `hydra-autopilot.service` right now. Before this issue that verdict
 * was ephemeral — visible only in the systemd journal for the tick that
 * produced it, with no durable, structured record a later reader (a chore, a
 * dashboard, a retro) could join against. #3844's failure class is exactly
 * this: a launcher-side signal that only ever surfaces as a log line is
 * "green-everything-no-alarm" the moment nobody is tailing the journal.
 *
 * `hydra:autopilot:pace-gate:last-tick` (HASH, no TTL — see below) is the
 * durable record of the MOST RECENT tick's outcome:
 *
 *   - `reason`     — the exit reason. Rooted in the 15-exit / 4-class table
 *                     from map #3807's #3809 resolution (Decision 2), plus the
 *                     `meter-unavailable` reason #3845 adds (see below):
 *                     `already-running-service` | `already-running-pid` |
 *                     `curl-missing` | `jq-missing` | `eligibility-unreachable`
 *                     | `eligibility-unparseable` | `allow-invalid` | `paused`
 *                     | `session-blocked` | `emergency-stop` |
 *                     `weekly-emergency-stop` | `meter-unavailable` |
 *                     `allow-false` | `pace-ahead` | `workless-backoff` |
 *                     `eligible-launch` | `eligible-exec`.
 *   - `class`      — the coarse class the reason buckets into:
 *                     `already-running` | `fail-safe` | `deliberate-skip` |
 *                     `launch`. `meter-unavailable` is classed `fail-safe`
 *                     (its CHARACTER is "defective" per #3809's resolution
 *                     addendum — the usage meter cannot be read — even
 *                     though the verdict itself WAS readable, so it isn't in
 *                     the literal fail-safe exit list either); this is the
 *                     classification choice made in #3845, not a re-run of
 *                     #3809's own decision.
 *   - `at`         — epoch-ms the tick recorded the outcome at.
 *   - `latency_ms` — the eligibility probe's round-trip time in milliseconds
 *                     (curl `%{time_total}`, converted — no extra HTTP
 *                     request issued to measure it), or absent when the tick
 *                     never reached the probe (e.g. an already-running skip)
 *                     or the probe itself never completed (e.g.
 *                     `eligibility-unreachable`).
 *
 * The actual HSET happens from bash (`pace-gate.sh`), via the same
 * docker-exec redis-cli pattern `scripts/autopilot/hooks/on-subagent-stop.sh`
 * uses (HYDRA_REDIS_HOST defaulting to `docker`, `-h $HOST` fallback for
 * tests) — a shell script talking to a typed TS accessor is not a thing, so
 * the write path is necessarily bash. This module exists so that (a) the key
 * NAME has exactly one TypeScript definition, cross-checked against the
 * shell literal by `test/launch-flow-key-contract.test.mts` (a rename on
 * either side alone now fails a test instead of silently going
 * green-everything-no-alarm — the launcher writes an orphan key while a
 * detector reads an empty one), and (b) any future in-process reader (a
 * chore, an API route) has a typed read instead of a raw `hgetall` string
 * literal.
 *
 * **No TTL.** Unlike most per-run telemetry in this repo (dispatch outcomes,
 * cycle metrics, …) this key is NOT time-bounded — it always reflects the
 * LAST tick, overwritten wholesale on every tick (a bare HSET, not an
 * append). Stateless recovery: there is nothing to expire because there is
 * nothing to accumulate — the key mirrors `wiring-liveness-dark-outcomes.ts`'s
 * "always reflects current state" contract, not the TTLed-record contract.
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`).
 */

import { getRedisConnection } from "./connection.ts";

/**
 * The single source of truth for the pace-gate last-tick hash key.
 * `scripts/autopilot/pace-gate.sh` writes this SAME literal string via
 * redis-cli HSET; `test/launch-flow-key-contract.test.mts` asserts the two
 * never drift apart.
 */
export const PACE_GATE_LAST_TICK_KEY = "hydra:autopilot:pace-gate:last-tick";

/** Typed shape of the `hydra:autopilot:pace-gate:last-tick` hash fields. */
export interface PaceGateLastTick {
  reason: string | null;
  class: string | null;
  at: number | null;
  latencyMs: number | null;
}

/**
 * Read the most recent pace-gate tick record. Returns a struct of `null`
 * fields (never throws) when the key is absent (no tick has ever recorded
 * yet, e.g. a fresh Redis) or a numeric field fails to parse — the read side
 * is dark-tolerant, matching every other best-effort accessor in this repo:
 * a missing/corrupt telemetry record must never crash a caller.
 */
export async function getPaceGateLastTick(): Promise<PaceGateLastTick> {
  const r = getRedisConnection();
  const fields = await r.hgetall(PACE_GATE_LAST_TICK_KEY);
  if (!fields || Object.keys(fields).length === 0) {
    return { reason: null, class: null, at: null, latencyMs: null };
  }
  const at = Number(fields.at);
  const latencyMs = Number(fields.latency_ms);
  return {
    reason: fields.reason ?? null,
    class: fields.class ?? null,
    at: Number.isFinite(at) ? at : null,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
  };
}

// ---------------------------------------------------------------------------
// Launch-flow DETECTION state (issue #3847, epic #3844).
//
// `scripts/hydra-watchdog.sh`'s `run_launch_flow` block is the SECOND bash
// reader of `PACE_GATE_LAST_TICK_KEY` (the first being pace-gate.sh's writer);
// `test/watchdog-launch-flow.test.mts` drift-guards that literal against this
// constant, sibling to `test/launch-flow-key-contract.test.mts` (which guards
// pace-gate.sh). The block asks whether a defective / quota / pause signal —
// or a slow eligibility probe — has been SUSTAINED past a threshold, using the
// per-signal streak state below. It is DETECTION ONLY; the watchdog bash is the
// SOLE writer (SET NX / DEL via redis-cli), and this module owns only the key
// NAMES plus a typed read for a future in-process consumer — mirroring the
// `wiring-liveness-dark-outcomes.ts` split exactly (TypeScript owns the name,
// bash owns the mutation).
// ---------------------------------------------------------------------------

/**
 * The five launch-flow streak signals the watchdog tracks, each with its own
 * `{since, fired}` key pair (ten keys total). The first four are reason-keyed
 * (`reason` ∈ that signal's member-set); `latency` is keyed on the hash's
 * numeric `latency_ms` field instead and is independent of `reason`.
 */
export type WatchdogLaunchSignal =
  | "fail-safe"
  | "meter-dark"
  | "quota"
  | "pause"
  | "latency";

/** The reason-keyed signals plus `"healthy"` (any reason outside the four
 *  alarm member-sets — endpoint was readable, not defective — which clears
 *  every reason-keyed streak). `latency` is NOT reason-keyed, so it is not a
 *  possible result of {@link classifyLaunchSignal}. */
export type WatchdogLaunchReasonSignal =
  | "fail-safe"
  | "meter-dark"
  | "quota"
  | "pause"
  | "healthy";

/** Enumerable list of all five streak signals (key builders + tests iterate it). */
export const WATCHDOG_LAUNCH_SIGNALS: readonly WatchdogLaunchSignal[] = [
  "fail-safe",
  "meter-dark",
  "quota",
  "pause",
  "latency",
];

/**
 * Reason → reason-keyed signal membership (INV-3). Canonical taxonomy; the
 * watchdog's bash `case` re-implements this same map and is drift-guarded by
 * `test/watchdog-launch-flow.test.mts`. `meter-unavailable` is split OUT of
 * generic fail-safe into its own `meter-dark` signal (#3814); quota's three
 * reasons are unified into ONE class so a stretch flipping between them does
 * not spuriously reset; `paused` earns its own (forgotten-pause) signal.
 */
export const LAUNCH_FLOW_REASON_SIGNAL: Readonly<
  Record<string, Exclude<WatchdogLaunchReasonSignal, "healthy">>
> = {
  "curl-missing": "fail-safe",
  "jq-missing": "fail-safe",
  "eligibility-unreachable": "fail-safe",
  "eligibility-unparseable": "fail-safe",
  "allow-invalid": "fail-safe",
  "meter-unavailable": "meter-dark",
  "session-blocked": "quota",
  "emergency-stop": "quota",
  "weekly-emergency-stop": "quota",
  paused: "pause",
};

/**
 * Classify a tick's `reason` into its reason-keyed signal, or `"healthy"` for
 * any reason outside the four alarm member-sets (launch / already-running /
 * deliberate skips other than quota & pause — all prove the endpoint was
 * readable, so they clear every reason-keyed streak). A null/empty reason is
 * `"healthy"`; the watchdog treats an unreadable last-tick as a read failure
 * (no mutation) BEFORE ever calling this, so this function only sees a present
 * reason string. `latency` is never returned here — it derives from
 * `latency_ms`, not `reason`.
 */
export function classifyLaunchSignal(
  reason: string | null | undefined,
): WatchdogLaunchReasonSignal {
  if (!reason) return "healthy";
  return LAUNCH_FLOW_REASON_SIGNAL[reason] ?? "healthy";
}

/** Key-template prefix shared by {@link launchFlowSinceKey} and
 *  {@link launchFlowFiredKey}. The watchdog bash holds the SAME literal in its
 *  `LF_KEY_PREFIX` shell variable; `test/watchdog-launch-flow.test.mts`
 *  asserts the two never drift apart. */
export const LAUNCH_FLOW_KEY_PREFIX = "hydra:autopilot:launch-flow";

/**
 * Key for ONE signal's FIRST-SEEN epoch-ms — the moment the current streak of
 * that signal began. Mirrors `darkSinceKey`: SET NX from bash locks it on the
 * first qualifying tick; it is a no-op after, so `now - since` grows to reflect
 * the true sustained duration. Value is an epoch-ms string.
 */
export function launchFlowSinceKey(signal: WatchdogLaunchSignal): string {
  return `${LAUNCH_FLOW_KEY_PREFIX}:since:${signal}`;
}

/**
 * Key for ONE signal's FIRED dedup marker — presence means "the WARNING for the
 * CURRENT streak of this signal has already been emitted". Mirrors
 * `filedMarkerKey`: set once per streak the instant `now - since >= threshold`,
 * cleared on recovery so a later streak fires fresh. Value is unimportant
 * (presence is the signal).
 */
export function launchFlowFiredKey(signal: WatchdogLaunchSignal): string {
  return `${LAUNCH_FLOW_KEY_PREFIX}:fired:${signal}`;
}

/**
 * Read the first-seen epoch-ms for `signal`'s current streak, or `null` when no
 * streak is being tracked. A non-numeric stored value coerces to `null`
 * (defensive — bash only ever writes a number). Never throws.
 */
export async function getLaunchFlowSince(
  signal: WatchdogLaunchSignal,
): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(launchFlowSinceKey(signal));
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether the WARNING for `signal`'s CURRENT streak has already fired.
 * `true` means "already fired — do not re-emit this tick". Never throws.
 */
export async function isLaunchFlowFired(
  signal: WatchdogLaunchSignal,
): Promise<boolean> {
  const r = getRedisConnection();
  return (await r.exists(launchFlowFiredKey(signal))) === 1;
}

/**
 * Clear BOTH the first-seen anchor and the fired marker for `signal`. Called by
 * the watchdog the moment a signal's membership test goes false (stateless
 * recovery). Idempotent. Never throws.
 */
export async function clearLaunchFlowStreak(
  signal: WatchdogLaunchSignal,
): Promise<void> {
  const r = getRedisConnection();
  await r.del(launchFlowSinceKey(signal), launchFlowFiredKey(signal));
}
