/**
 * Autopilot-pause Redis ops (issue #988).
 *
 * Owns the operator-only **Autopilot pause** flag at
 * `hydra:autopilot:paused`. When set, `hydra-autopilot` is paused with a
 * DRAIN: the launcher (`scripts/autopilot/pace-gate.sh`) skips spawning a new
 * Autopilot Run, and the brain (`scripts/autopilot/decide.py`) emits ZERO new
 * dispatches for the turn — but in-flight subagents are NEVER aborted; they
 * finish their atomic unit (open PR / post verdict). Pause stops *starting*
 * new work; it does not touch live agents.
 *
 * **Autopilot pause ≠ Emergency brake.** The two flags are independent and
 * compose: pause stops launch+dispatch (this flag), while the emergency-brake
 * (`src/redis/emergency-brake.ts`) only blocks auto-merge while the loop keeps
 * running. Neither flag reads or mutates the other.
 *
 * Operator-only by construction: the SOLE write path is the API route in
 * `src/api/autopilot-control.ts` (`setAutopilotPaused`/`clearAutopilotPaused` below).
 * `decide.py` and `collect-state.sh` only READ the flag (folded into the
 * `/api/usage/eligibility` projection); there is no engage/disengage action
 * type in `VALID_ACTION_TYPES`, so the autopilot has no code path that can SET
 * or CLEAR it. The guarantee is structural, not a runtime check. There is no
 * auto-resume — the flag persists until the operator explicitly POSTs
 * `{paused:false}`.
 *
 * State model — a single JSON blob (mirroring emergency-brake, minus the
 * `engagedBy` attribution):
 *
 *   present  => `{ paused: true, since: <epochMs> }`
 *   absent   => not paused (default-off)
 *
 * No TTL: an operator pause must persist until explicitly cleared. Fail-open
 * on a Redis flush / host reboot is accepted (Redis-only durability — no
 * marker file, no systemd touch), consistent with the emergency-brake.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

export interface AutopilotPauseState {
  /** True only when paused. Absent flag => false. */
  paused: boolean;
  /** Epoch ms the pause was set. Present only when paused. */
  since?: number;
}

const NOT_PAUSED: AutopilotPauseState = { paused: false };

/**
 * Read the current pause state. Returns `{ paused: false }` when the flag is
 * absent (default-off) OR when the stored value is unparseable — a corrupt
 * blob MUST fail SAFE to not-paused so a bad write can never wedge autopilot
 * off indefinitely (the operator can always re-pause explicitly). This is the
 * same fail-safe-to-running default the emergency-brake uses.
 */
export async function getAutopilotPaused(): Promise<AutopilotPauseState> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.autopilotPaused());
  if (!raw) return { ...NOT_PAUSED };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.paused === true) {
      return {
        paused: true,
        since: typeof parsed.since === "number" ? parsed.since : undefined,
      };
    }
    return { ...NOT_PAUSED };
  } catch (err: any) {
    // Fail loud, fail safe: log the corrupt blob, treat as not paused.
    console.error(
      `[autopilot-pause] corrupt pause blob, treating as not paused: ${err?.message ?? err}`,
    );
    return { ...NOT_PAUSED };
  }
}

/**
 * Set the pause flag. Idempotent: re-setting refreshes `since`. No TTL,
 * no auto-resume.
 */
export async function setAutopilotPaused(): Promise<AutopilotPauseState> {
  const r = getRedisConnection();
  const state: AutopilotPauseState = { paused: true, since: Date.now() };
  await r.set(redisKeys.autopilotPaused(), JSON.stringify(state));
  return state;
}

/** Clear the pause flag — remove it entirely (default-off). Idempotent. */
export async function clearAutopilotPaused(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.autopilotPaused());
}
