/**
 * Workless-board backoff hint Redis ops (issue #2956).
 *
 * Owns the "board is workless until <t>" instant at
 * `hydra:autopilot:workless-until`. The Pace Gate's admission check is purely
 * usage-based ("already running?" + the pacing-curve consult); it never asks
 * whether any work is eligible. When every autopilot class is on cooldown and
 * no signals fire, the launched session's first decide.py turn is wait-only
 * with zero occupied slots, trips `_rule_idle_fallback`, and terminates the run
 * immediately with cause=idle. Observed ~14% of runs were these zero-dispatch
 * 2-minute idle exits, each burning a full claude session bootstrap for nothing
 * and adding noise rows to the behavior gallery.
 *
 * Shape 1 (idle-exit backoff) of #2956: when a run terminates cause=idle having
 * dispatched NOTHING, {@link endRun} stamps a short temporal hint here. While
 * that instant is in the future the pace-gate skips launch. Purely temporal —
 * the gate keeps NO work-selection knowledge (that stays in decide.py); the
 * hint self-heals if it is stale.
 *
 * **Launcher-only, NOT a hard stop.** UNLIKE the session block
 * (`session-block.ts`) and the operator pause (`autopilot-pause.ts`), this hint
 * does NOT force `allow=false`. `decide.py` gates ALL dispatch on
 * `not eligibility.allow`, so flipping `allow` would drain a legitimately
 * in-flight or operator-launched session the moment a workless hint were set.
 * Instead the hint is surfaced under `reasons.worklessUntil` and acted on ONLY
 * by the pace-gate at admission time — the boundary ADR-0021/ADR-0012 draw
 * between ADMISSION (the gate) and WHAT WORK to do (decide.py) is preserved.
 *
 * **Self-clearing by TTL.** The key is written with a TTL to the hint instant
 * plus a small clock-skew buffer, so it expires on its own the moment the
 * backoff window passes — a stale hint can never wedge the launcher off, even
 * if no relaunch ever runs a read-time clear. Belt-and-braces: the read also
 * treats a past instant as "not workless".
 *
 * Write path: {@link setWorklessUntil}, called from {@link endRun} on a
 * zero-dispatch idle exit. Read path: the `/api/usage/eligibility` route folds
 * it into `reasons.worklessUntil` via
 * `overlayWorklessEligibility`. Fail-safe on a corrupt / unreadable value:
 * returns `null` (not workless) so a bad write can never hold the launcher down.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Default backoff window: how long to treat the board as workless after a
 * zero-dispatch idle exit. 45 minutes is the low end of the #2956 shape-1
 * recommendation (45–60 min) — conservative, so a signal that fires sooner is
 * only briefly deferred, and the hint self-clears by TTL regardless. Overridable
 * via `HYDRA_WORKLESS_BACKOFF_SEC` for operational tuning without a code change.
 */
export const WORKLESS_BACKOFF_DEFAULT_SEC = 45 * 60;

/**
 * Extra seconds of TTL beyond the hint instant, absorbing host-vs-Redis clock
 * skew so the key does not expire a hair before the window actually passes. The
 * read still treats a past instant as not-workless, so an over-long TTL is inert.
 */
export const WORKLESS_TTL_BUFFER_SEC = 60;

/**
 * Resolve the configured backoff window in seconds. Reads
 * `HYDRA_WORKLESS_BACKOFF_SEC` and falls back to {@link WORKLESS_BACKOFF_DEFAULT_SEC}
 * for a missing / non-positive / unparseable value (fail-safe to the default —
 * never a zero or negative window, which would make the hint a no-op).
 */
export function worklessBackoffSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HYDRA_WORKLESS_BACKOFF_SEC;
  if (raw === undefined) return WORKLESS_BACKOFF_DEFAULT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return WORKLESS_BACKOFF_DEFAULT_SEC;
  return Math.floor(n);
}

/**
 * Read the recorded workless-until instant as epoch-ms, or `null` when no hint
 * is recorded (absent key), the stored value is unparseable, OR the instant is
 * already in the past. A corrupt / past value MUST fail SAFE to not-workless so
 * a bad write or a forgotten key can never wedge the launcher off — the same
 * fail-safe-to-running default the pause flag, emergency brake, and session
 * block use. `nowMs` is injected so the past-vs-future decision stays
 * deterministic/testable.
 */
export async function getWorklessUntil(nowMs: number = Date.now()): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.autopilotWorklessUntil());
  if (!raw) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    console.error(
      `[workless-hint] unparseable workless-until value, treating as not workless: ${JSON.stringify(raw)}`,
    );
    return null;
  }
  // Already past → not workless (the TTL should have expired it; this is the
  // belt-and-braces read-side guard).
  if (ms <= nowMs) return null;
  return ms;
}

/**
 * Record a workless-until instant (epoch-ms). Stored as the raw epoch-ms string
 * with a TTL set to `(worklessUntilMs - now) + buffer`, so the key self-expires
 * once the backoff window passes. A non-finite / non-positive / already-past
 * instant is a no-op (logged) — recording a stale hint is meaningless and we
 * never want to risk holding the launcher down. `nowMs` is injected for tests.
 * Returns the epoch-ms actually stored, or `null` when nothing was stored.
 */
export async function setWorklessUntil(
  worklessUntilMs: number,
  nowMs: number = Date.now(),
): Promise<number | null> {
  if (!Number.isFinite(worklessUntilMs) || worklessUntilMs <= nowMs) {
    console.error(
      `[workless-hint] refusing to record non-future workless hint (worklessUntilMs=${worklessUntilMs}, now=${nowMs})`,
    );
    return null;
  }
  const ttlSec = Math.ceil((worklessUntilMs - nowMs) / 1000) + WORKLESS_TTL_BUFFER_SEC;
  const r = getRedisConnection();
  await r.set(redisKeys.autopilotWorklessUntil(), String(worklessUntilMs), "EX", ttlSec);
  return worklessUntilMs;
}

/** Clear the workless hint — remove it entirely. Idempotent. */
export async function clearWorklessUntil(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.autopilotWorklessUntil());
}
