/**
 * Session-limit hard-block Redis ops (issue #1089).
 *
 * Owns the session-limit reset instant at
 * `hydra:autopilot:session-blocked-until`. When the Claude Code rolling SESSION
 * window is exhausted the autopilot exits `code=1` with
 * `You've hit your session limit · resets <time>`. The pace-gate timer would
 * then relaunch `hydra-autopilot.service` into the still-exhausted quota — dying
 * instantly, repeatedly, until the quota actually resets. Each death abandons
 * all in-flight dispatches (reaped `abandonReason: "run-crash"`).
 *
 * The OAuth 5h meter (`emergencyStop`, src/cost/usage-tracker.ts) reads below
 * 90% even while the session is hard-blocked, so it cannot gate the relaunch.
 * This flag records the *actual* session-block-until instant (parsed from the
 * exit line by the reap), and the value is folded into
 * `/api/usage/eligibility` as `reasons.sessionBlockedUntil`. While it is a
 * future instant the launcher (`scripts/autopilot/pace-gate.sh`) and the brain
 * skip launch — admission resumes automatically once the reset passes.
 *
 * **Self-clearing by TTL.** UNLIKE the operator pause (`autopilot-pause.ts`,
 * no TTL, held until explicitly cleared), this flag is set with a TTL aligned
 * to the reset instant plus a small clock-skew buffer. Once the reset passes
 * the key expires on its own — a stale block can never wedge autopilot off,
 * even if no relaunch ever runs the read-time clear. Belt-and-braces: the read
 * also treats a past instant as "no block".
 *
 * Write path: the reap-on-exit backstop (`bootstrap.sh --reap`) POSTs the
 * parsed reset to `POST /api/usage/session-block`, which calls
 * {@link setSessionBlockedUntil}. The launcher/brain only READ it (via the
 * eligibility projection). Fail-safe on a corrupt / unreadable value: returns
 * `null` (no block) so a bad write can never hold autopilot down.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Extra seconds of TTL beyond the reset instant, absorbing clock skew between
 * the host clock and Anthropic's reset boundary so the key does not expire a
 * hair before the quota actually frees. 5 minutes is generous and harmless —
 * the read still treats a past instant as no-block, so over-long TTL is inert.
 */
export const SESSION_BLOCK_TTL_BUFFER_SEC = 5 * 60;

/**
 * Read the recorded session-block instant as epoch-ms, or `null` when no block
 * is recorded (absent key), the stored value is unparseable, OR the instant is
 * already in the past. A corrupt / past value MUST fail SAFE to no-block so a
 * bad write or a forgotten key can never wedge autopilot off — the same
 * fail-safe-to-running default the pause flag and emergency-brake use. `nowMs`
 * is injected so the past-vs-future decision stays deterministic/testable.
 */
export async function getSessionBlockedUntil(nowMs: number = Date.now()): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.autopilotSessionBlock());
  if (!raw) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    console.error(
      `[session-block] unparseable session-block value, treating as no block: ${JSON.stringify(raw)}`,
    );
    return null;
  }
  // Already past → no block (the TTL should have expired it; this is the
  // belt-and-braces read-side guard).
  if (ms <= nowMs) return null;
  return ms;
}

/**
 * Record a session-block-until instant (epoch-ms). Stored as the raw epoch-ms
 * string with a TTL set to `(blockedUntilMs - now) + buffer`, so the key
 * self-expires once the reset passes. A non-finite / non-positive / already-
 * past instant is a no-op (logged) — recording a stale block is meaningless and
 * we never want to risk holding autopilot down. `nowMs` is injected for tests.
 * Returns the epoch-ms actually stored, or `null` when nothing was stored.
 */
export async function setSessionBlockedUntil(
  blockedUntilMs: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  if (!Number.isFinite(blockedUntilMs) || blockedUntilMs <= nowMs) {
    console.error(
      `[session-block] refusing to record non-future session block (blockedUntilMs=${blockedUntilMs}, now=${nowMs})`,
    );
    return null;
  }
  const ttlSec = Math.ceil((blockedUntilMs - nowMs) / 1000) + SESSION_BLOCK_TTL_BUFFER_SEC;
  const r = getRedisConnection();
  await r.set(redisKeys.autopilotSessionBlock(), String(blockedUntilMs), "EX", ttlSec);
  return blockedUntilMs;
}

/** Clear the session-block flag — remove it entirely. Idempotent. */
export async function clearSessionBlockedUntil(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.autopilotSessionBlock());
}
