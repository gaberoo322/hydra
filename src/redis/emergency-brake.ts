/**
 * Emergency-brake Redis ops (issue #744).
 *
 * Owns the operator-only **Emergency brake** flag at
 * `hydra:autopilot:emergency-brake`. When engaged, the autopilot's
 * `decide()` auto-merge sweep emits ZERO `auto-merge` actions (regardless of
 * tier or QA depth verdict) and instead emits a single `route-prs-to-review`
 * action that arms the /hydra-review pickup set. It is the one sanctioned
 * reintroduction of operator-as-gate — for incidents (a bad merge wave,
 * outcome instability, suspected CI compromise) — never a steady-state mode.
 *
 * Operator-only by construction: the SOLE write path is the API route in
 * `src/api/autopilot-control.ts` (`set`/`clear` below). `decide.py` and
 * `collect-state.sh` only READ the flag; there is no engage/disengage action
 * type in `VALID_ACTION_TYPES`, so the autopilot has no code path that can
 * SET or CLEAR it. The guarantee is structural, not a runtime check.
 *
 * State model — a single JSON blob (NOT a plain "1" flag like
 * reviewPickupArmed) so the incident audit trail (since when / by whom) is
 * surfaced on /health:
 *
 *   present  => `{ engaged: true, since: <epochMs>, engagedBy: "<who>" }`
 *   absent   => disengaged (default-off)
 *
 * No TTL: an incident brake must persist until the operator explicitly clears
 * it. (Contrast the 60s-TTL merge-lock, which is a per-merge serialization
 * lock — wrong lifetime and wrong semantics for an operator-held brake.)
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

export interface EmergencyBrakeState {
  /** True only when the brake is engaged. Absent flag => false. */
  engaged: boolean;
  /** Epoch ms the brake was engaged. Present only when engaged. */
  since?: number;
  /** Operator-supplied attribution string. Present only when engaged. */
  engagedBy?: string;
}

const DISENGAGED: EmergencyBrakeState = { engaged: false };

/**
 * Read the current brake state. Returns `{ engaged: false }` when the flag is
 * absent (default-off) OR when the stored value is unparseable — a corrupt
 * blob must fail SAFE to disengaged so a bad write can never wedge auto-merge
 * off indefinitely (the operator can always re-engage explicitly).
 */
export async function getEmergencyBrake(): Promise<EmergencyBrakeState> {
  const r = getRedisConnection();
  const raw = await r.get(redisKeys.emergencyBrake());
  if (!raw) return { ...DISENGAGED };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.engaged === true) {
      return {
        engaged: true,
        since: typeof parsed.since === "number" ? parsed.since : undefined,
        engagedBy: typeof parsed.engagedBy === "string" ? parsed.engagedBy : undefined,
      };
    }
    return { ...DISENGAGED };
  } catch (err: any) {
    // Fail loud, fail safe: log the corrupt blob, treat as disengaged.
    console.error(`[emergency-brake] corrupt brake blob, treating as disengaged: ${err?.message ?? err}`);
    return { ...DISENGAGED };
  }
}

/**
 * Engage the brake. `engagedBy` is an operator-supplied attribution string
 * (e.g. "cli" or an operator handle) recorded for the incident audit trail.
 * Idempotent: re-engaging refreshes `since`/`engagedBy`. No TTL.
 */
export async function setEmergencyBrake(engagedBy: string): Promise<EmergencyBrakeState> {
  const r = getRedisConnection();
  const state: EmergencyBrakeState = { engaged: true, since: Date.now(), engagedBy };
  await r.set(redisKeys.emergencyBrake(), JSON.stringify(state));
  return state;
}

/** Disengage the brake — remove the flag entirely (default-off). Idempotent. */
export async function clearEmergencyBrake(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.emergencyBrake());
}
