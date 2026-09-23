/**
 * Model-scoped exhaustion Redis ops (issue #4585).
 *
 * Owns the Fable-exhaustion instant at
 * `hydra:autopilot:model-exhausted-until`. Fable is the only model on this
 * account whose weekly allowance runs out BEFORE the account-wide weekly rate
 * limit — when it does, the Claude CLI exits code=1 with
 * `You're out of usage credits. Switch to another model, ...` while Opus,
 * Sonnet and Haiku keep working. Pre-#4585 there was no graceful path to them:
 * the pace-gate relaunched the (default-model) parent into the same 429 every
 * ~3 minutes for ~14h / 240 relaunches (run 6a9539de), and Fable-routed
 * dispatches died unrun.
 *
 * This flag is MODEL-SCOPED, deliberately distinct from the session block
 * (`session-block.ts`, #1089): it must NEVER stop a launch — it must REDIRECT
 * it. While the instant is future, the pace-gate exec branch passes
 * `--model <fallback>` (default `opus`, env HYDRA_AUTOPILOT_FALLBACK_MODEL)
 * instead of the primary (default `fable`, HYDRA_AUTOPILOT_PRIMARY_MODEL), and
 * the playbook's dispatch step pre-resolves `fable`-routed classes to the
 * fallback. It is folded into /api/usage/eligibility as the ADVISORY reason
 * `reasons.fableExhaustedUntil` — never into `.allow`, never into
 * `sessionBlockedUntil` (INV-3 of the #4585 design concept). #4583's
 * crash-streak backstop remains the net for UNRECOGNISED exhaustion strings.
 *
 * **Lifetime (INV-4).** The credits message carries no reset time, so the TTL
 * is `min(now + 60min, next Weekly Reset Anchor boundary)` — self-clearing,
 * with the Weekly Anchor only an UPPER BOUND (the Fable-specific credit reset
 * is not observable and may not coincide with the account reset, so an
 * Anchor-only clear could strand the autopilot on Opus for days). On expiry the
 * next parent launch / fable-routed dispatch tries Fable again; that re-probe
 * is effectively free (measured 2026-09-22: the credits 429 returns in ~0.4s
 * with 0 input/output tokens), and if Fable is still exhausted the reap /
 * dispatch-429 path simply re-arms this flag. No operator action in either
 * direction.
 *
 * **Self-clearing by TTL**, exactly like the session block: the key carries a
 * TTL to the instant (+ a small clock-skew buffer), and the read additionally
 * treats a past instant as "not exhausted" so a stale value can never wedge the
 * autopilot on the fallback model. Fail-safe on a corrupt / unreadable value:
 * `null` (not exhausted) — the safe default is "launch on the primary".
 *
 * Write path: `POST /api/usage/session-block` arms this flag when the posted
 * line classifies as `out-of-credits` (#4583's parseExhaustionBlock — the
 * shared matcher), and emits the `model-fallback` event on the bus. The reap
 * (`bootstrap.sh --reap`) and the playbook's reactive dispatch fallback are the
 * two POSTers.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

/**
 * How long a single arming treats the primary model as exhausted (INV-4). The
 * credits notice carries no reset time; 60 minutes bounds how long Fable sits
 * unused after its allowance actually returns, while the post-expiry re-probe
 * costs ~nothing (a 0-token 429 in <0.5s). NOT an env knob — the two failure
 * modes of a mistuned value (too short: re-probe churn; too long: silent Opus
 * billing) are both strictly worse than the constant.
 */
export const MODEL_EXHAUSTION_TTL_MS = 60 * 60 * 1000;

/**
 * Extra seconds of TTL beyond the exhaustion instant, absorbing clock skew so
 * the key does not expire a hair before the comparison instant. Same value and
 * rationale as the session block's buffer (`SESSION_BLOCK_TTL_BUFFER_SEC`);
 * over-long TTL is inert because the read treats a past instant as clear.
 */
export const MODEL_EXHAUSTION_TTL_BUFFER_SEC = 5 * 60;

/**
 * The arm instant for a model-exhaustion observation: `min(now + TTL, next
 * Weekly Reset Anchor boundary)` (INV-4). `nextWeeklyResetMs` is the NEXT
 * fixed 7-day boundary (`projectResetWindow(anchorMs, nowMs).nextMs`) or `null`
 * when no Weekly Reset Anchor is configured — then the plain TTL applies. The
 * Anchor only ever SHORTENS the flag (upper bound), never lengthens it. Pure:
 * no IO, no `Date.now()` — exported so the min() math is unit-testable.
 */
export function computeModelExhaustionUntilMs(
  nowMs: number,
  nextWeeklyResetMs: number | null,
): number {
  const ttlMs = nowMs + MODEL_EXHAUSTION_TTL_MS;
  if (nextWeeklyResetMs === null || !Number.isFinite(nextWeeklyResetMs) || nextWeeklyResetMs <= nowMs) {
    return ttlMs;
  }
  return Math.min(ttlMs, nextWeeklyResetMs);
}

/**
 * Read the recorded model-exhaustion instant as epoch-ms, or `null` when the
 * primary model is NOT currently exhausted (absent key), the stored value is
 * unparseable, OR the instant is already in the past. A corrupt / past value
 * MUST fail SAFE to not-exhausted so a bad write can never wedge the autopilot
 * on the fallback model — the mirror of the session block's fail-safe-to-
 * running default. `nowMs` is injected so the past-vs-future decision stays
 * deterministic/testable.
 */
export async function getModelExhaustedUntil(nowMs: number = Date.now()): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.autopilotModelExhaustedUntil());
  if (!raw) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    logger.error(
      { raw },
      "[model-exhaustion] unparseable model-exhaustion value, treating as not exhausted",
    );
    return null;
  }
  // Already past → not exhausted (the TTL should have expired it; this is the
  // belt-and-braces read-side guard that pairs with it).
  if (ms <= nowMs) return null;
  return ms;
}

/**
 * Arm the model-exhaustion flag for the primary model. The instant is
 * computed HERE (INV-4: `min(now + 60min, next Weekly Reset Anchor boundary)`)
 * — callers pass the anchor-derived boundary (or null when unanchored), never
 * the #4583 generic block instant (that 30-min figure belongs to the
 * crash-streak/session-block semantics, not this flag). Stored as the raw
 * epoch-ms string with a TTL to the instant (+ buffer) so the key self-expires.
 * `nowMs` is injected for tests. Returns the epoch-ms actually stored.
 */
export async function setModelExhaustedUntil(
  nowMs: number = Date.now(),
  nextWeeklyResetMs: number | null = null,
): Promise<number> {
  const untilMs = computeModelExhaustionUntilMs(nowMs, nextWeeklyResetMs);
  const ttlSec =
    Math.ceil((untilMs - nowMs) / 1000) + MODEL_EXHAUSTION_TTL_BUFFER_SEC;
  const r = getRedisConnection();
  await r.set(redisKeys.autopilotModelExhaustedUntil(), String(untilMs), "EX", ttlSec);
  return untilMs;
}

/** Clear the model-exhaustion flag — remove it entirely. Idempotent. */
export async function clearModelExhaustedUntil(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.autopilotModelExhaustedUntil());
}
